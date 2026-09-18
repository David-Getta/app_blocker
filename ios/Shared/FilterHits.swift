import Foundation

/// MEGAKADÁSOK A SZŰRŐBEN: hányszor állította meg a DNS-szűrő az iPhone-t.
///
/// A tiltás akkor dolgozik, amikor az ember nem figyel oda — pont ezért nem
/// látszik, mennyit dolgozik. A gépen a böngésző-bővítmény számolja a tiltó
/// lapra vitt navigációkat; a telefonon tiltó lap nincs, de a tiltott
/// lekérdezés ugyanaz a pillanat: a kéz odanyúlt, a szűrő megállította.
/// Tükör, nem ítélet. Egy hosztnevet két percen belül EGYSZER számol (egy
/// oldalbetöltés tucatnyi lekérdezés), és csak a LISTA és a KULCSSZÓ tiltását: a munkamenet
/// fehérlistáján kívül rekedt háttér-forgalom nem a kéz mozdulata. A könyv
/// naponként egy szám, harminc napig; a készüléken marad. Az androidos
/// `FilterHitLogic` tükre.
public enum FilterHitLogic {
    /// Ennyi napot tartunk meg — mint a mérés és a böngésző könyve.
    public static let retentionDays = 30
    /// Egy hosztnév ennyin belül egy megakadás.
    public static let dedupeMs: Double = 120_000
    /// Naponta legfeljebb ennyi — fölötte nem mérés, hanem hiba.
    public static let maxPerDay = 10_000
    /// A tunnel memóriája (hoszt → utolsó idő) ennél nem nő nagyobbra.
    private static let maxSeen = 500

    private static func isDayKey(_ s: String) -> Bool {
        s.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil
    }

    /// A nap kulcsa helyi idő szerint — ugyanaz, mint a mérésé.
    public static func dayKey(_ now: Double) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: now / 1000))
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Számít-e ez a tiltott lekérdezés új megakadásnak. A `lastSeen` a hívó
    /// memóriája (hoszt → utolsó számolt idő), itt frissül; nem tárolódik.
    public static func shouldCount(_ lastSeen: inout [String: Double], _ host: String, now: Double) -> Bool {
        var h = host.trimmingCharacters(in: .whitespaces).lowercased()
        while h.hasSuffix(".") { h.removeLast() }
        if h.isEmpty { return false }
        if let last = lastSeen[h], now >= last, now - last < dedupeMs { return false }
        if lastSeen.count >= maxSeen {
            lastSeen = lastSeen.filter { now - $0.value < dedupeMs && $0.value <= now }
            if lastSeen.count >= maxSeen { lastSeen = [:] }
        }
        lastSeen[h] = now
        return true
    }

    /// A könyv egy megakadással több a napon. Rossz nap vagy a napi plafon:
    /// változatlan. Nem takarít — az a hívóé, a MAI nappal (`sweep`): a felvett
    /// nap nem a mai nap, és egy régebbi nappal takarítva a mai sor esne ki.
    public static func record(_ days: [String: Int], day: String) -> [String: Int] {
        guard isDayKey(day) else { return days }
        let n = days[day] ?? 0
        if n >= maxPerDay { return days }
        var next = days
        next[day] = n + 1
        return next
    }

    /// A megtartási időn túli és a jövőbeli napok kiesnek.
    public static func sweep(_ days: [String: Int], today: String) -> [String: Int] {
        let keep = Set(days.keys.filter { isDayKey($0) && $0 <= today }.sorted().suffix(retentionDays))
        return days.filter { keep.contains($0.key) }
    }

    /// A tárból jött könyv tisztán: jó nap, pozitív szám a plafonig, a legfrissebb harminc.
    public static func clean(_ raw: [String: Int]?) -> [String: Int] {
        let good = (raw ?? [:]).filter { isDayKey($0.key) && $0.value > 0 }.mapValues { min($0, maxPerDay) }
        let keep = Set(good.keys.sorted().suffix(retentionDays))
        return good.filter { keep.contains($0.key) }
    }

    /// Megakadások a két nap között, mindkettőt beleértve.
    public static func hitsBetween(_ days: [String: Int], _ fromDay: String, _ toDay: String) -> Int {
        days.filter { $0.key >= fromDay && $0.key <= toDay }.values.reduce(0, +)
    }

    /// Az elmúlt 7 nap (a mai nappal) — a statisztika és a visszatekintés ablaka.
    public static func hits7d(_ days: [String: Int], now: Double) -> Int {
        hitsBetween(days, dayKey(now - 6 * 86_400_000), dayKey(now))
    }

    /// A mai nap.
    public static func hitsToday(_ days: [String: Int], now: Double) -> Int {
        let d = dayKey(now)
        return hitsBetween(days, d, d)
    }

    /// Az azt megelőző 7 nap (a mai naptól visszafelé a 13.–7. nap) — a hét az előző héthez képest.
    public static func hitsPrev7d(_ days: [String: Int], now: Double) -> Int {
        hitsBetween(days, dayKey(now - 13 * 86_400_000), dayKey(now - 7 * 86_400_000))
    }

    /// „A héten 12 megakadás, az előző héten 18.” — a két szám egymás mellett,
    /// ítélet nélkül: a tükör mutatja az irányt, nem minősíti. Előző hét nélkül
    /// (nulla: a könyv talán akkor kezdődött) nincs mondat — egy nulla nem
    /// összehasonlítás. A nulla hét viszont mondat, ha volt mihez mérni.
    public static func trendText(_ week: Int, prev: Int) -> String {
        prev <= 0 ? "" : "A héten \(week) megakadás, az előző héten \(prev)."
    }

    // MARK: - óránként

    /// A nap órája helyi idő szerint, 0–23.
    public static func hourOf(_ now: Double) -> Int {
        Calendar.current.component(.hour, from: Date(timeIntervalSince1970: now / 1000))
    }

    /// Az órák könyve egy megakadással több: nap → 24 rekesz. MIKOR jár a kéz
    /// magától — a napi könyv mellett, ugyanazzal a takarítással. Rossz óra: változatlan.
    public static func recordHour(_ hours: [String: [Int]], day: String, hour: Int) -> [String: [Int]] {
        guard isDayKey(day), (0..<24).contains(hour) else { return hours }
        var row = hours[day].flatMap { $0.count == 24 ? $0 : nil } ?? Array(repeating: 0, count: 24)
        if row[hour] >= maxPerDay { return hours }
        row[hour] += 1
        var next = hours
        next[day] = row
        return next
    }

    /// Az órák könyve tisztán: jó nap, 24 rekesz, nem negatív, a plafonig, a legfrissebb harminc nap.
    public static func cleanHours(_ raw: [String: [Int]]?) -> [String: [Int]] {
        let good = (raw ?? [:])
            .filter { isDayKey($0.key) && $0.value.count == 24 && $0.value.contains { $0 > 0 } }
            .mapValues { $0.map { min(max($0, 0), maxPerDay) } }
        let keep = Set(good.keys.sorted().suffix(retentionDays))
        return good.filter { keep.contains($0.key) }
    }

    /// AZ ÓRÁK SÁVJA: a nap huszonnégy rekesze az elmúlt 7 napon összeadva — a
    /// statisztika ebből rajzolja a sávot, a csúcs-óra ebből áll. Csupa nulla, ha nem volt.
    public static func byHour(_ hours: [String: [Int]], now: Double) -> [Int] {
        let days = Set(daySeries([:], now: now, count: 7).map { $0.day })
        var by = Array(repeating: 0, count: 24)
        for (day, row) in hours where days.contains(day) && row.count == 24 {
            for i in 0..<24 { by[i] += max(0, row[i]) }
        }
        return by
    }

    /// A csúcs-óra az elmúlt 7 napon: (óra, szám) — vagy nil. Holtversenynél a korábbi óra.
    public static func peakHour(_ hours: [String: [Int]], now: Double) -> (hour: Int, count: Int)? {
        let by = byHour(hours, now: now)
        var best = -1
        for i in 0..<24 where by[i] > 0 && (best < 0 || by[i] > by[best]) { best = i }
        return best < 0 ? nil : (hour: best, count: by[best])
    }

    /// „21–22 óra” — a csúcs-óra felirata.
    public static func hourLabel(_ hour: Int) -> String { "\(hour)–\((hour + 1) % 24) óra" }

    // MARK: - oldalanként

    /// Naponta legfeljebb ennyi oldal a könyvben — a lista úgysem hosszabb.
    public static let maxSitesPerDay = 50

    /// Melyik LISTÁS oldalhoz tartozik a tiltott név: a lista tétele (tartomány,
    /// hosztnevek), amelynek a neve a név vagy annak szülője — különben a név
    /// maga. A `m.youtube.com` és a `www.youtube.com` egy oldal.
    public static func siteOf(_ name: String, sites: [(domain: String, hostnames: [String])]) -> String {
        var h = name.trimmingCharacters(in: .whitespaces).lowercased()
        while h.hasSuffix(".") { h.removeLast() }
        for s in sites {
            for n in [s.domain] + s.hostnames where h == n || h.hasSuffix("." + n) { return s.domain }
        }
        return h
    }

    /// Az oldalak könyve egy megakadással több: nap → (oldal → szám). Rossz nap, üres oldal vagy a plafon: változatlan.
    public static func recordSite(_ hosts: [String: [String: Int]], day: String, site: String) -> [String: [String: Int]] {
        guard isDayKey(day), !site.isEmpty else { return hosts }
        var row = hosts[day] ?? [:]
        let n = row[site] ?? 0
        if n >= maxPerDay { return hosts }
        if row[site] == nil && row.count >= maxSitesPerDay { return hosts }
        row[site] = n + 1
        var next = hosts
        next[day] = row
        return next
    }

    /// Az oldalak könyve tisztán: jó nap, nem üres oldal, pozitív szám a plafonig, a legfrissebb harminc nap.
    public static func cleanSites(_ raw: [String: [String: Int]]?) -> [String: [String: Int]] {
        var good: [String: [String: Int]] = [:]
        for (day, row) in raw ?? [:] where isDayKey(day) {
            var r: [String: Int] = [:]
            for (s, n) in row.sorted(by: { $0.key < $1.key }) where !s.isEmpty && n > 0 && r.count < maxSitesPerDay {
                r[s] = min(n, maxPerDay)
            }
            if !r.isEmpty { good[day] = r }
        }
        let keep = Set(good.keys.sorted().suffix(retentionDays))
        return good.filter { keep.contains($0.key) }
    }

    /// A hét csúcs-oldala: (oldal, szám) — vagy nil. Holtversenynél az ábécé szerint korábbi.
    public static func topSite(_ hosts: [String: [String: Int]], now: Double) -> (site: String, count: Int)? {
        let days = Set(daySeries([:], now: now, count: 7).map { $0.day })
        var sum: [String: Int] = [:]
        for (day, row) in hosts where days.contains(day) {
            for (s, n) in row { sum[s, default: 0] += max(0, n) }
        }
        return sum.filter { $0.value > 0 }
            .sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
            .first.map { (site: $0.key, count: $0.value) }
    }

    // MARK: - okonként

    /// MELYIK szabály dolgozik: a megakadás oka a szűrő ítélete — a lista vagy
    /// a kulcsszó. A munkamenet fehérlistáján kívül rekedt forgalom nem
    /// megakadás, ezért oknak sem számít: nil. A könyv alakja az oldalakéval
    /// azonos (nap → ok → szám), ugyanaz a felvétel és takarítás — a gépi
    /// okonkénti sor tükre.
    public static let reasonList = "list"
    public static let reasonKeyword = "keyword"
    /// Az okok rögzített sorrendje és felirata — a sor holtversenynél sem ugrál.
    public static let reasonOrder = [reasonList, reasonKeyword]
    public static let reasonLabels = [reasonList: "lista", reasonKeyword: "kulcsszó"]

    /// A megakadás oka a szűrő ítéletéből — vagy nil, ha ez nem megakadás.
    public static func reasonOf(_ verdict: Focus.Verdict) -> String? {
        switch verdict {
        case .blockedByList: return reasonList
        case .blockedByKeyword: return reasonKeyword
        default: return nil
        }
    }

    /// Az elmúlt 7 nap megakadásai okonként: (ok, szám), a legnagyobb elöl;
    /// holtversenynél a rögzített sorrend. Csak a nem nulla.
    public static func byReason(_ reasons: [String: [String: Int]], now: Double) -> [(reason: String, count: Int)] {
        let days = Set(daySeries([:], now: now, count: 7).map { $0.day })
        var sum: [String: Int] = [:]
        for (day, row) in reasons where days.contains(day) {
            for (r, n) in row { sum[r, default: 0] += max(0, n) }
        }
        func rank(_ r: String) -> Int { reasonOrder.firstIndex(of: r) ?? reasonOrder.count }
        return sum.filter { $0.value > 0 }
            .sorted {
                if $0.value != $1.value { return $0.value > $1.value }
                if rank($0.key) != rank($1.key) { return rank($0.key) < rank($1.key) }
                return $0.key < $1.key
            }
            .map { (reason: $0.key, count: $0.value) }
    }

    /// „30 lista · 12 kulcsszó” — üresen üres. A gépi sor tükre.
    public static func reasonLine(_ rows: [(reason: String, count: Int)]) -> String {
        rows.map { "\($0.count) \(reasonLabels[$0.reason] ?? $0.reason)" }.joined(separator: " · ")
    }

    // MARK: - kulcsszavanként

    /// MELYIK kulcsszó dolgozik: a kulcsszó okánál a fogó szó is a könyvbe megy
    /// (nap → szó → szám, az oldalakéval azonos alak). A hét sora a legnagyobb
    /// elöl, holtversenynél az ábécé — ami sosem fog, az itt nem szerepel.
    public static func keywordsWeek(_ book: [String: [String: Int]], now: Double) -> [(keyword: String, count: Int)] {
        let days = Set(daySeries([:], now: now, count: 7).map { $0.day })
        var sum: [String: Int] = [:]
        for (day, row) in book where days.contains(day) {
            for (k, n) in row { sum[k, default: 0] += max(0, n) }
        }
        return sum.filter { $0.value > 0 }
            .sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
            .map { (keyword: $0.key, count: $0.value) }
    }

    /// „shorts 7 · reels 3” — üresen üres. A gépi sor tükre.
    public static func keywordLine(_ rows: [(keyword: String, count: Int)]) -> String {
        rows.map { "\($0.keyword) \($0.count)" }.joined(separator: " · ")
    }

    /// A lista szavai, amelyek a héten NEM fogtak — a tükör másik fele. Csak
    /// akkor mond bármit, ha a héten volt kulcsszó-megakadás: friss könyv
    /// mellett minden szó „nem fogott” lenne, és az nem tény, hanem hiány.
    public static func idleKeywords(_ keywords: [String], rows: [(keyword: String, count: Int)]) -> [String] {
        if rows.isEmpty { return [] }
        let hit = Set(rows.map { $0.keyword.lowercased() })
        return keywords.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { !$0.isEmpty && !hit.contains($0) }
    }

    // MARK: - a sokadik

    /// A SOKADIK megakadás lépcsői: ezeknél a mai számoknál a lap egy lépést
    /// javasol — egy munkamenet vagy egy rövid zárlat most segítene. Nem ítélet,
    /// nem tilt semmit; a döntés az emberé. A gépével azonos lista.
    public static let nudgeSteps: [Int] = [5, 10, 20]

    /// A legmagasabb lépcső, amit a mai szám elért — 0, ha egyet sem.
    public static func nudgeStep(_ today: Int, steps: [Int] = nudgeSteps) -> Int {
        steps.filter { today >= $0 }.max() ?? 0
    }

    /// A javaslat mondata egy lépcsőnél.
    public static func nudgeText(_ step: Int) -> String {
        "Ma már \(step) megakadás a szűrőben. Egy munkamenet vagy egy rövid zárlat most segítene — te döntesz."
    }

    // MARK: - előjelzés

    /// ELŐJELZÉS a csúcs-óra előtt: ennyivel a hét csúcs-órájának kezdete előtt
    /// szól a rendszer — naponta egyszer, és csak ha a csúcs legalább ennyi.
    /// Tükör időzítéssel: ilyenkor jár a kéz magától. Nem tilt, nem ítél.
    public static let peakWarnLeadMs: Double = 10 * 60_000
    public static let peakWarnMinCount = 3

    /// A mai előjelzés kulcsa („nap:óra”), ha most esedékes — különben nil. A
    /// nulla órás csúcs ablaka az előző estén van: a kulcs a csúcs napjáé.
    public static func peakWarnKey(_ peak: (hour: Int, count: Int)?, now: Double) -> String? {
        guard let peak, peak.count >= peakWarnMinCount else { return nil }
        let cal = Calendar.current
        let base = Date(timeIntervalSince1970: now / 1000)
        for offset in 0...1 {
            guard let day = cal.date(byAdding: .day, value: offset, to: base) else { continue }
            var c = cal.dateComponents([.year, .month, .day], from: day)
            c.hour = peak.hour
            guard let startDate = cal.date(from: c) else { continue }
            let start = startDate.timeIntervalSince1970 * 1000
            if now >= start - peakWarnLeadMs && now < start { return "\(dayKey(start)):\(peak.hour)" }
        }
        return nil
    }

    /// Az előjelzés mondata.
    public static func peakWarnText(_ peak: (hour: Int, count: Int)) -> String {
        "Mindjárt \(peak.hour) óra — a héten ilyenkor akadt meg a kéz a legtöbbször (\(peak.count)×). Egy munkamenet most segítene — te döntesz."
    }

    /// MOST a csúcs-óra van-e: a hét csúcsa és a helyi óra egybeesik.
    public static func isPeakNow(_ peak: (hour: Int, count: Int)?, now: Double) -> Bool {
        guard let peak else { return false }
        return hourOf(now) == peak.hour
    }

    /// A tükör a kísértés pillanatában: a kezdőlap kártyája a csúcs-órában.
    public static func peakNowText(_ peak: (hour: Int, count: Int)) -> String {
        "Most a hét csúcs-órája van (\(hourLabel(peak.hour)), \(peak.count) megakadás a héten) — ilyenkor jár a kéz magától."
    }

    /// Az utolsó `count` nap sora, a legrégebbi elöl — a hét alakja a
    /// megakadásokra; a `seconds` mező itt darab, a rajz kedvéért ugyanaz az alak.
    /// A HARMINC NAP rajza csak akkor mond többet a hétnél, ha a hét ELŐTTI napokon
    /// is volt megakadás — különben ugyanazt a hét oszlopot mutatná, szélesebben.
    /// A sor a legrégebbitől jön; az utolsó hét nap a hété.
    public static func monthHasOlderHits(_ series: [(day: String, seconds: Double)], weekDays: Int = 7) -> Bool {
        series.dropLast(weekDays).contains { $0.seconds > 0 }
    }

    public static func daySeries(_ days: [String: Int], now: Double, count: Int) -> [(day: String, seconds: Double)] {
        let base = Date(timeIntervalSince1970: now / 1000)
        return (0..<count).reversed().map { back in
            let d = Calendar.current.date(byAdding: .day, value: -back, to: base) ?? base
            let key = dayKey(d.timeIntervalSince1970 * 1000)
            return (day: key, seconds: Double(hitsBetween(days, key, key)))
        }
    }
}
