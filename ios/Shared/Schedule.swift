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

    private static func localParts(_ now: Double) -> (day: Int, minute: Int) {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone.current
        let date = Date(timeIntervalSince1970: now / 1000)
        let c = cal.dateComponents([.weekday, .hour, .minute], from: date)
        // Calendar weekday is 1=Sunday..7=Saturday; normalize to 0..6.
        return ((c.weekday ?? 1) - 1, (c.hour ?? 0) * 60 + (c.minute ?? 0))
    }

    static func inAnyBand(_ bands: [Band], _ now: Double) -> Bool {
        let (day, minute) = localParts(now)
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

    static func isBlockedBySchedule(_ schedule: Schedule, _ now: Double) -> Bool {
        let s = normalize(schedule)
        switch s.mode {
        case .always: return true
        case .block: return inAnyBand(s.bands, now)
        case .allow: return !inAnyBand(s.bands, now)
        }
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
