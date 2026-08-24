import Foundation

/// A mérés OLVASÓ oldala iPhone-on és macOS-en.
///
/// Fontos, hogy mit NEM tartalmaz: felvételt. iOS-en az app nem mérheti, hogy
/// más appokban vagy weboldalakon mennyi aktív idő telik — az egyetlen ilyen
/// API (`DeviceActivity` / `FamilyControls`) külön, Apple által egyenként
/// engedélyezett entitlementhez kötött. Ezért itt nincs `recordSample`.
///
/// Amit viszont MEGTEHET: elolvasni, amit a gép és az androidos telefon mért.
/// A fiókon keresztül azok a mérések ide is megérkeznek — titkosítva —, és
/// pont ez az a statisztika, amit az iPhone valaha mutatni tud. Enélkül az
/// eszközlista csak neveket sorolna fel, ami semmit nem ér.
///
/// A `desktop/src/shared/usage.ts` és az `android/.../Usage.kt` olvasó
/// részének a tükre. Ha ez elcsúszik tőlük, ugyanaz a fiók MÁS számot mutatna
/// a telefonon, mint a gépen — és semmi nem jelezné, hogy melyik a hibás.
enum UsageStats {

    struct Day {
        let day: String
        let seconds: [String: Double]
    }

    struct State {
        var days: [Day] = []
        var labels: [String: String] = [:]
        var enabled: Bool = true
    }

    struct Target {
        let key: String
        let label: String
        let seconds: Double
    }

    struct Summary {
        let todaySeconds: Double
        let last7Seconds: Double
        /// A hét legtöbb időt vivő célpontjai, weboldalak és appok együtt.
        let top: [Target]
    }

    // ------------------------------------------------------------- célkulcsok

    /// `site:pelda.hu` — ugyanaz az alak, amit a másik két mag ír.
    ///
    /// A mérést iPhone-on nem mi végezzük, de a kulcsot MEG KELL tudni
    /// építeni: a közös napi keret pont ezzel keresi ki, mennyi ment el egy
    /// oldalra a többi eszközön (lásd `LimitLogic`).
    static func siteKey(_ domain: String) -> String { "site:\(domain)" }
    static func appKey(_ id: String) -> String { "app:\(id)" }

    // ------------------------------------------------------------- napkulcsok

    /// Helyi naptári nap, `YYYY-MM-DD`. Ugyanaz az alak, amit a másik két mag ír.
    static func dayKey(_ now: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Az utolsó `count` helyi napkulcs, a mai nappal a végén, régebbitől.
    ///
    /// Délben lép, hogy a nyári időszámítás váltása ne ejtsen ki és ne
    /// duplázzon meg egy napot.
    static func dayKeysBack(_ now: Date, _ count: Int) -> [String] {
        let cal = Calendar.current
        let noon = cal.date(bySettingHour: 12, minute: 0, second: 0, of: now) ?? now
        var out: [String] = []
        for i in stride(from: count - 1, through: 0, by: -1) {
            if let d = cal.date(byAdding: .day, value: -i, to: noon) { out.append(dayKey(d)) }
        }
        return out
    }

    // ------------------------------------------------------------ összegzés

    static func totals(_ state: State, days: [String]) -> [String: Double] {
        let wanted = Set(days)
        var out: [String: Double] = [:]
        for d in state.days where wanted.contains(d.day) {
            for (k, s) in d.seconds { out[k] = (out[k] ?? 0) + s }
        }
        return out
    }

    static func label(_ state: State, _ key: String) -> String {
        if let l = state.labels[key], !l.isEmpty { return l }
        // A kulcs alakja `site:pelda.hu` / `app:valami`; címke híján az azonosító.
        guard let idx = key.firstIndex(of: ":") else { return key }
        return String(key[key.index(after: idx)...])
    }

    static func summarize(_ state: State, now: Date, topLimit: Int = 3) -> Summary {
        let todayTotals = totals(state, days: [dayKey(now)])
        let weekTotals = totals(state, days: dayKeysBack(now, 7))
        let top = weekTotals
            .map { Target(key: $0.key, label: label(state, $0.key), seconds: $0.value) }
            // A másodperc után a kulcs is dönt, hogy két egyforma érték sorrendje
            // ne a szótár bejárásán múljon — az futásonként más lehet.
            .sorted { $0.seconds == $1.seconds ? $0.key < $1.key : $0.seconds > $1.seconds }
            .prefix(topLimit)
        return Summary(
            todaySeconds: todayTotals.values.reduce(0, +),
            last7Seconds: weekTotals.values.reduce(0, +),
            top: Array(top)
        )
    }

    // --------------------------------------------------- több eszköz együtt

    /// Több eszköz mérését EGYETLEN állapottá fésüli.
    ///
    /// A kérdés, ami tényleg számít, nem az eszközönkénti bontás: nem az, hogy
    /// mennyi ment el YouTube-ra a gépen, és külön mennyi az androidos
    /// telefonon, hanem hogy MENNYI ÖSSZESEN.
    ///
    /// A címke onnan jön, ahol a LEGTÖBB időt mérték az adott célponton — így
    /// nem a hálózati válaszok sorrendjén múlik, hogy mit lát az ember.
    static func combine(_ states: [State]) -> State {
        var byDay: [String: [String: Double]] = [:]
        var bestLabel: [String: (Double, String)] = [:]

        for st in states {
            var mine: [String: Double] = [:]
            for d in st.days {
                var bucket = byDay[d.day] ?? [:]
                for (k, s) in d.seconds where s.isFinite && s > 0 {
                    bucket[k] = (bucket[k] ?? 0) + s
                    mine[k] = (mine[k] ?? 0) + s
                }
                byDay[d.day] = bucket
            }
            for (k, s) in mine {
                guard let l = st.labels[k], !l.isEmpty else { continue }
                if let cur = bestLabel[k], s <= cur.0 { continue }
                bestLabel[k] = (s, l)
            }
        }

        return State(
            days: byDay.keys.sorted().map { Day(day: $0, seconds: byDay[$0] ?? [:]) },
            labels: bestLabel.mapValues { $0.1 },
            // Ha BÁRMELYIK eszköz mér, az összesített szám valódi.
            enabled: states.contains { $0.enabled }
        )
    }

    // --------------------------------------------------------- beolvasás

    /// A kiszolgálóról jött, már visszafejtett mérés-JSON beolvasása.
    ///
    /// Minden mező gyanús: egy MÁSIK eszköz írta, egy kiszolgálón át jött. Ami
    /// nem értelmes, az kimarad — egyetlen hibás rekord nem viheti el a többi
    /// eszköz statisztikáját.
    static func parse(_ text: String) -> State? {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        var days: [Day] = []
        for raw in obj["days"] as? [[String: Any]] ?? [] {
            guard let day = raw["day"] as? String,
                  let secs = raw["seconds"] as? [String: Any] else { continue }
            var out: [String: Double] = [:]
            for (k, v) in secs {
                let num = (v as? Double) ?? (v as? NSNumber)?.doubleValue
                guard let n = num, n.isFinite, n > 0 else { continue }
                out[k] = n
            }
            days.append(Day(day: day, seconds: out))
        }
        var labels: [String: String] = [:]
        for (k, v) in obj["labels"] as? [String: Any] ?? [:] {
            if let s = v as? String { labels[k] = s }
        }
        return State(days: days, labels: labels, enabled: obj["enabled"] as? Bool ?? true)
    }

    // -------------------------------------------------------------- kiírás

    /// Magyar, olvasható időtartam: „2 ó 15 p”, „45 p”, „30 mp”.
    static func formatDuration(_ seconds: Double) -> String {
        let s = Int(max(0, seconds.rounded()))
        if s < 60 { return "\(s) mp" }
        let min = Int((Double(s) / 60).rounded())
        if min < 60 { return "\(min) p" }
        let h = min / 60
        let rem = min % 60
        return rem == 0 ? "\(h) ó" : "\(h) ó \(rem) p"
    }
}
