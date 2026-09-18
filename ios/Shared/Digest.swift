import Foundation

/// Heti visszatekintés: egy mondat az elmúlt hét napról — a
/// `desktop/src/shared/digest.ts` és az androidos `Digest.kt` tükre.
///
/// iPhone-on ÉRTESÍTÉS nincs: a tunnel-bővítmény nem adhat, az app nem fut a
/// háttérben, előre ütemezni pedig csak olyan mondatot lehetne, ami a hét
/// végére elavul. Ami viszont van: az élő mondat a statisztikán („így szólna most”),
/// és a heti napló — a hét sora akkor íródik, amikor az app azon a héten
/// először nyitva van hétfő reggel hét után. Mérés itt nincs, tehát a
/// mondat a menetekről és a feloldásokról szól — ami a telefonon igazi.
///
/// Tiszta: a hívó adja az időt, a tárolt kulcsot és a címkézést (rejtett
/// lista, fedőnév) — a napló sem szivárogtathat ki olyan címet, amit a lista
/// elrejt.
public enum DigestLogic {

    /// Hétfőn ettől az órától esedékes (helyi idő). A gépen és Androidon ugyanez.
    public static let digestHour = 7

    /// A hét kulcsa: a hétfő helyi dátuma, ÉÉÉÉ-HH-NN.
    public static func weekKey(_ now: Double) -> String {
        let cal = Calendar.current
        let date = Date(timeIntervalSince1970: now / 1000)
        // Calendar: vasárnap = 1 … szombat = 7; a JS getDay vasárnap = 0 …
        // szombat = 6. Ugyanaz a visszalépés: hétfőn nulla, vasárnap hat.
        let jsDay = (cal.component(.weekday, from: date) + 6) % 7
        let monday = cal.date(byAdding: .day, value: -((jsDay + 6) % 7), to: date)!
        let c = cal.dateComponents([.year, .month, .day], from: monday)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    /// Esedékes-e a visszatekintés: ezen a héten még nem volt, és hétfő reggel
    /// `digestHour` már elmúlt. Ha igen, a hét kulcsát adja — ezt kell eltenni.
    public static func due(_ lastKey: String?, now: Double) -> String? {
        let key = weekKey(now)
        if lastKey == key { return nil }
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        let dueAt = Calendar.current.date(from: DateComponents(
            year: parts[0], month: parts[1], day: parts[2], hour: digestHour, minute: 0, second: 0
        ))!.timeIntervalSince1970 * 1000
        return now >= dueAt ? key : nil
    }

    /// Egy célpont a hét listájából: a felület címkéje és a másodpercek.
    public struct Top: Equatable {
        public let label: String
        public let seconds: Double
        public init(label: String, seconds: Double) { self.label = label; self.seconds = seconds }
    }

    /// Ez a hét az előzőhöz képest, egy célra; nil, ha nem volt előző hét.
    public struct Delta: Equatable {
        public let label: String
        public let deltaPct: Double?
        public init(label: String, deltaPct: Double?) { self.label = label; self.deltaPct = deltaPct }
    }

    public struct Input {
        /// az elmúlt 7 nap mért ideje, másodpercben
        public var last7Seconds: Double
        /// a hét legtöbb idejét vivő oldalak, a legnagyobb elöl
        public var topWeekSites: [Top]
        /// a hét legtöbb idejét vivő appok, a legnagyobb elöl
        public var topWeekApps: [Top]
        /// ez a hét az előzőhöz képest, célonként
        public var weekOverWeek: [Delta]
        /// a munkamenetek összegzése az elmúlt 7 napra
        public var focusWeek: Focus.Summary
        /// feloldások az elmúlt 7 napban
        public var unlocks7d: Int
        /// van-e egyáltalán mért nap
        public var daysTracked: Int
        /// a hét legnagyobb, NEM tiltott idővivői, a legnagyobb elöl
        public var unblockedTop: [Top]
        /// Félbemaradt kísérletek az elmúlt 7 napban — feladva, lejárva,
        /// lecsúszva, elszállva, újraindítva: hányszor indult el a lazítás, és
        /// nem vitte végig. A tükör másik fele a feloldások mellett.
        public var dropped7d: Int

        public init(
            last7Seconds: Double = 0, topWeekSites: [Top] = [], topWeekApps: [Top] = [],
            weekOverWeek: [Delta] = [], focusWeek: Focus.Summary, unlocks7d: Int,
            daysTracked: Int = 0, unblockedTop: [Top] = [], dropped7d: Int = 0
        ) {
            self.last7Seconds = last7Seconds
            self.topWeekSites = topWeekSites
            self.topWeekApps = topWeekApps
            self.weekOverWeek = weekOverWeek
            self.focusWeek = focusWeek
            self.unlocks7d = unlocks7d
            self.daysTracked = daysTracked
            self.unblockedTop = unblockedTop
            self.dropped7d = dropped7d
        }
    }

    /// „2 ó 40 p” / „58 p” — mint a statisztika csempéin.
    public static func hm(_ seconds: Double) -> String {
        // floor(x + 0.5): pontosan a JS Math.round — a felfelé kerekítés a
        // felezőnél, hogy a három mag ugyanazt a percet mondja.
        let total = max(0, Int((seconds / 60 + 0.5).rounded(.down)))
        let h = total / 60
        let m = total % 60
        return h > 0 ? "\(h) ó \(m) p" : "\(m) p"
    }

    /// A visszatekintés szövege — vagy nil, ha nincs miről beszélni (se mérés,
    /// se menet, se feloldás): egy üres sor zaj lenne, nem tükör.
    ///
    /// A `labelOf` a felület címkézése: rejtett listánál sorszám, fedőnévnél a
    /// fedőnév — a mondat ugyanazt a szabályt követi, mint a statisztika.
    public static func text(_ input: Input, labelOf: (String) -> String) -> String? {
        var parts: [String] = []
        let measured = input.daysTracked > 0 && input.last7Seconds > 0
        if measured {
            var line = "\(hm(input.last7Seconds)) mért idő"
            // A trend csak öt százalék fölött mondat: alatta zaj, nem irány.
            func trendOf(_ label: String) -> String {
                guard let pct = input.weekOverWeek.first(where: { $0.label == label })?.deltaPct,
                      abs(pct) > 5 else { return "" }
                let rounded = Int((pct + 0.5).rounded(.down))
                return " (\(pct > 0 ? "▲ +" : "▼ ")\(rounded)% az előző héthez képest)"
            }
            if let top = input.topWeekSites.first, top.seconds > 0 {
                line += "; a legtöbb: \(labelOf(top.label)) \(hm(top.seconds))\(trendOf(top.label))"
            }
            if let app = input.topWeekApps.first, app.seconds > 0 {
                line += "; appban a legtöbb: \(labelOf(app.label)) \(hm(app.seconds))\(trendOf(app.label))"
            }
            parts.append("\(line).")
        }
        let f = input.focusWeek
        if f.sessions > 0 {
            let early = f.stoppedEarly > 0 ? ", \(f.stoppedEarly) korán leállítva" : ", mind végigvive"
            parts.append("\(f.sessions) menet (\(hm(f.totalMs / 1000))\(early)).")
        }
        // A félbemaradt kísérlet a feloldások mellé kerül — vagy helyettük: egy
        // elindított és félbehagyott lazítás is történés, ha feloldás nem is lett.
        let droppedPart = input.dropped7d > 0 ? ", \(input.dropped7d) félbemaradt kísérlet" : ""
        if input.unlocks7d > 0 { parts.append("\(input.unlocks7d) feloldás\(droppedPart).") }
        else if input.dropped7d > 0 { parts.append("Feloldás nélkül\(droppedPart).") }
        else if measured || f.sessions > 0 { parts.append("Feloldás nélkül.") }
        if measured, let open = input.unblockedTop.first, open.seconds > 0 {
            parts.append("Nincs tiltva, de sokat vitt: \(labelOf(open.label)) \(hm(open.seconds)).")
        }
        if parts.isEmpty { return nil }
        return "Elmúlt 7 nap: " + parts.joined(separator: " ")
    }

    // MARK: - napló

    /// Egy hét a naplóban: a hét kulcsa (a hétfő dátuma) és a mondat.
    public struct Entry: Codable, Equatable {
        public let week: String
        public let text: String
        public init(week: String, text: String) { self.week = week; self.text = text }
    }

    /// Ennyi hetet őrzünk — fél év. Több már nem tükör, hanem archívum.
    public static let maxDigestLog = 26

    /// A napló sora mondat, nem esszé; a mag mondata ennél jóval rövidebb.
    private static let maxDigestText = 500

    private static func isWeekKey(_ s: String) -> Bool {
        s.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil
    }

    /// Egy hét mondata a naplóba: a hétnek egy sora van (az újabb felülír), a
    /// lista a legfrissebbel kezdődik, a plafonnál a legrégebbi esik. Üres
    /// mondat (nil) nem sor — de a hét régi sorát sem hagyja ott.
    public static func record(_ log: [Entry], week: String, text: String?) -> [Entry] {
        var kept = log.filter { $0.week != week }
        if let text, !text.isEmpty { kept.append(Entry(week: week, text: text)) }
        return clean(kept)
    }

    /// A tárból jött napló megtisztítva: csak a jó alakú sorok, hetenként egy
    /// (az utolsó marad), a legfrissebb elöl, a plafonig.
    public static func clean(_ entries: [Entry]) -> [Entry] {
        var byWeek: [String: String] = [:]
        for e in entries {
            guard isWeekKey(e.week) else { continue }
            let t = e.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { continue }
            byWeek[e.week] = String(t.prefix(maxDigestText))
        }
        return byWeek.map { Entry(week: $0.key, text: $0.value) }
            .sorted { $0.week > $1.week }
            .prefix(maxDigestLog)
            .map { $0 }
    }

    /// A visszatekintés bemenete a mostani állapotból — iPhone-on mérés nincs,
    /// a menetek és a feloldások vannak; a statisztika élő mondata és a hét
    /// sora ugyanezt kéri, hogy a kettő ne csúszhasson szét.
    static func inputFor(_ st: AppState, now: Double) -> Input {
        let weekAgo = now - 7 * 24 * 3_600_000
        // A napló ablaka a gépével közös: a mai nap kezdete mínusz hat nap.
        let dayStart = Calendar.current.startOfDay(for: Date(timeIntervalSince1970: now / 1000))
            .timeIntervalSince1970 * 1000
        return Input(
            focusWeek: Focus.summarizeFocus(st.focusLog ?? [], since: dayStart - 6 * 24 * 3_600_000, now: now),
            unlocks7d: st.unlockLog.filter { $0 >= weekAgo }.count,
            dropped7d: (st.droppedAttempts ?? []).filter { $0 >= weekAgo }.count
        )
    }

    /// A napló sorának feje: a hét kulcsa olvashatóan — „2026. 09. 07.”
    public static func weekLabel(_ week: String) -> String {
        week.replacingOccurrences(of: "-", with: ". ") + "."
    }

    /// A napló sora a MOSTANI címkézéssel. Ami akkor a valódi címmel szólt, az
    /// a fedőnév felvétele vagy a lista elrejtése után is a lista címkéjével
    /// jelenik meg — a napló sem szivárogtathat ki olyan címet, amit a lista
    /// elrejt. A cím társneveit és az aloldalait is a listázott oldal címkéje
    /// fedi; ami nincs a listán, az marad, ahogy volt.
    public static func relabel(
        _ text: String, sites: [(domain: String, hostnames: [String])], labelOf: (String) -> String
    ) -> String {
        var out = text
        for site in sites {
            let label = labelOf(site.domain)
            if label == site.domain { continue }
            for name in [site.domain] + site.hostnames where !name.isEmpty {
                let pattern = "(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\\.)*"
                    + NSRegularExpression.escapedPattern(for: name) + "(?![A-Za-z0-9-])"
                guard let re = try? NSRegularExpression(pattern: pattern) else { continue }
                let range = NSRange(out.startIndex..., in: out)
                out = re.stringByReplacingMatches(
                    in: out, range: range, withTemplate: NSRegularExpression.escapedTemplate(for: label)
                )
            }
        }
        return out
    }
}
