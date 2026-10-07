import Foundation

/// Weekly blocking schedules — mirror of desktop/src/shared/schedule.ts.
/// See docs/feature-schedules.md.
///
/// Invariant: tightening (more blocked time) is free; loosening (less blocked
/// time) must go through the same unlock challenges as a pause.
enum ScheduleLogic {

    enum Mode: String, Codable {
        case always = "always", block = "scheduled_block", allow = "scheduled_allow"

        /// Unknown mode -> always blocked, never a thrown error. A raw value this
        /// build does not know (state written by a newer version, then a
        /// downgrade) would fail the whole AppState decode, and the fallback for
        /// that is an empty state: every block gone. Always-blocked is the safe
        /// side of the same failure.
        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Mode(rawValue: raw) ?? .always
        }
    }

    /// days: 0=Sunday..6=Saturday. startMin/endMin: local minutes from midnight.
    struct Band: Codable, Equatable {
        let days: [Int]
        let startMin: Int
        let endMin: Int
    }

    struct Schedule: Codable, Equatable {
        let mode: Mode
        let bands: [Band]

        init(mode: Mode, bands: [Band]) {
            self.mode = mode
            self.bands = bands
        }

        enum CodingKeys: String, CodingKey { case mode, bands }

        /// TŰRŐ dekódolás, a gép `scheduleIn`-je szerint: a nem szöveg mód
        /// „always”, a sávok közül a rosszul formált (nem objektum, a nap nem
        /// egész számok tömbje, a perc nem egész) kiesik, a többi marad, és a
        /// hiányzó sávlista üres. Eddig egyetlen ilyen sáv az egész oldalt vitte
        /// (a szinkronon az egész listát). A tartalmi szűrés a `normalize`-é.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            mode = c.lenient(Mode.self, .mode) ?? .always
            bands = c.lossyArray(Band.self, .bands)
        }
    }

    static let always = Schedule(mode: .always, bands: [])

    static func isValidBand(_ b: Band) -> Bool {
        if b.days.isEmpty || b.days.contains(where: { $0 < 0 || $0 > 6 }) { return false }
        if b.startMin < 0 || b.startMin > 1439 { return false }
        if b.endMin < 1 || b.endMin > 1440 { return false }
        return true
    }

    static func normalize(_ s: Schedule?) -> Schedule {
        guard let s = s, s.mode != .always else { return always }
        let bands = s.bands.filter(isValidBand)
        return bands.isEmpty ? always : Schedule(mode: s.mode, bands: bands)
    }

    private static func localCalendar() -> Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone.current
        return cal
    }

    private static func localParts(_ now: Double) -> (day: Int, minute: Int) {
        partsOf(localCalendar(), now)
    }

    /// A helyi nap és perc egy (újrahasznosítható) naptárral — a keresés egyet használ végig.
    private static func partsOf(_ cal: Calendar, _ now: Double) -> (day: Int, minute: Int) {
        let date = Date(timeIntervalSince1970: now / 1000)
        let c = cal.dateComponents([.weekday, .hour, .minute], from: date)
        // Calendar weekday is 1=Sunday..7=Saturday; normalize to 0..6.
        return ((c.weekday ?? 1) - 1, (c.hour ?? 0) * 60 + (c.minute ?? 0))
    }

    static func inAnyBand(_ bands: [Band], _ now: Double) -> Bool {
        inAnyBandAt(bands, localParts(now))
    }

    private static func inAnyBandAt(_ bands: [Band], _ p: (day: Int, minute: Int)) -> Bool {
        let (day, minute) = p
        let prev = (day + 6) % 7
        for b in bands {
            if b.endMin > b.startMin {
                if b.days.contains(day) && minute >= b.startMin && minute < b.endMin { return true }
            } else {
                if b.days.contains(day) && minute >= b.startMin { return true }
                if b.days.contains(prev) && minute < b.endMin { return true }
            }
        }
        return false
    }

    /// A döntés egy már tisztított menetrendre, a helyi nap és perc szerint.
    private static func blockedAt(_ s: Schedule, _ p: (day: Int, minute: Int)) -> Bool {
        switch s.mode {
        case .always: return true
        case .block: return inAnyBandAt(s.bands, p)
        case .allow: return !inAnyBandAt(s.bands, p)
        }
    }

    static func isBlockedBySchedule(_ schedule: Schedule, _ now: Double) -> Bool {
        blockedAt(normalize(schedule), localParts(now))
    }

    /// Az első perchatár `now` után, ahol a menetrend döntése `blocked` — vagy
    /// 0, ha nyolc napon belül sincs ilyen. Ha már most annyi: `now`. A gép
    /// `nextDecisionAt`-jének tükre: percre lépked, és MAGÁT a döntést kérdezi
    /// (`blockedAt`), így óraátállásnál sem mondhat mást, mint amit a tiltás
    /// tenni fog. Egy naptárral lépked végig — a telefon másodpercenként rajzol.
    private static func nextDecisionAt(_ schedule: Schedule, _ now: Double, _ blocked: Bool) -> Double {
        let s = normalize(schedule)
        let cal = localCalendar()
        if blockedAt(s, partsOf(cal, now)) == blocked { return now }
        var t = (now / 60_000).rounded(.down) * 60_000
        for _ in 0..<(8 * 24 * 60) {
            t += 60_000
            if blockedAt(s, partsOf(cal, t)) == blocked { return t }
        }
        return 0
    }

    /// A menetrend következő nyitása (epoch ms): most nyitva → `now`; a mindig tiltó sosem nyit → 0.
    static func nextOpenAt(_ schedule: Schedule, _ now: Double) -> Double {
        if normalize(schedule).mode == .always { return 0 }
        return nextDecisionAt(schedule, now, false)
    }

    /// A menetrend következő zárása (epoch ms): most zár → `now`; egy héten belül sem zár → 0.
    static func nextCloseAt(_ schedule: Schedule, _ now: Double) -> Double {
        nextDecisionAt(schedule, now, true)
    }

    /// Combines pause (always wins), pending delete, and the schedule.
    static func isBlockedNow(pauseUntil: Double?, pendingDeleteAt: Double?, schedule: Schedule?, now: Double) -> Bool {
        if let p = pauseUntil, p > now { return false }
        if pendingDeleteAt != nil { return true }
        return isBlockedBySchedule(schedule ?? always, now)
    }

    /// Would switching old -> new reduce blocked time in the next 7 days?
    ///
    /// Sampled every minute: bands are whole minutes, so a minute step cannot
    /// step over any window this model can express. A coarser step let a short
    /// recurring free window install with no friction, defeating the gate.
    static func isLoosening(_ oldS: Schedule, _ newS: Schedule, _ now: Double) -> Bool {
        let a = normalize(oldS)
        let b = normalize(newS)
        let step = 60_000.0
        let samples = 7 * 24 * 60
        for i in 0..<samples {
            let t = now + Double(i) * step
            if isBlockedBySchedule(a, t) && !isBlockedBySchedule(b, t) { return true }
        }
        return false
    }
}
