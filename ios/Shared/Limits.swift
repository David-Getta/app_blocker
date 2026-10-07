import Foundation

/// Napi aktív-idő keret oldalanként — a `desktop/src/shared/limits.ts` tükre.
///
/// AMI ITT MÁS, MINT A TÖBBI PLATFORMON. iPhone-on az app nem tudja mérni,
/// mennyi aktív idő telik el egy oldalon (lásd `UsageStats`: az egyetlen ilyen
/// API külön, Apple által egyenként engedélyezett entitlementhez kötött).
/// Ezért itt nincs `makeTodayDigest`: nincs mit feltölteni.
///
/// A keret viszont ettől még ÉRVÉNYESÜL. A gép és az androidos telefon
/// feltölti, mennyit mért ma; az iPhone lehozza, és összeadja. Ha a napi húsz
/// perc YouTube a gépen elfogyott, a telefonon is zárva van.
///
/// Eddig a `dailyLimitSeconds` iPhone-on puszta hordozó volt: átment a
/// szinkronon, és soha semmi nem nézte meg. Vagyis aki a gépen keretet
/// állított be, az a telefonján korlátlanul használhatta ugyanazt az oldalt —
/// és semmi nem jelezte, hogy a beállítása itt nem jelent semmit.
enum LimitLogic {

    /// Amit egy eszköz ma mért. Csak a mai nap, csak a számok — pár száz bájt.
    struct TodayDigest: Codable, Equatable {
        let deviceId: String
        /// az ADOTT eszköz helyi naptári napja, YYYY-MM-DD
        let day: String
        /// cél kulcsa ("site:…" / "app:…") -> másodperc
        let seconds: [String: Double]
    }

    /// A többi eszköz mai összegzése, és hogy közülük melyik vagyunk mi.
    struct SharedToday: Codable, Equatable {
        /// a saját eszközazonosítónk — az ő sorát KI KELL hagyni
        let selfDeviceId: String
        let devices: [TodayDigest]
    }

    /// Ennél több célt egy összegzésből nem fogadunk el.
    static let maxDigestTargets = 200

    /// Használható keret, vagy nil („nincs keret”). Az értelmetlen érték nincs keret.
    /// A keret betelt napjai oldalanként: (domain, napok).
    struct SiteDays: Equatable {
        let domain: String
        let days: Int
    }

    /// A keret betelt napjai: hány napon, és oldalanként — a legtöbb elöl, holtversenyben ábécé.
    struct FullDays: Equatable {
        let days: Int
        let bySite: [SiteDays]
    }

    /// A KERET BETELT NAPJAI az elmúlt 7 napon — ezen a készüléken mérve: hány
    /// napon érte el a mért idő valamelyik oldal napi keretét, és melyik oldalé
    /// hányszor. Tükör, nem ítélet: azt mutatja, dolgozik-e a keret. A `limits`:
    /// (domain, napi keret másodpercben). iPhone-on nincs mérés: ott csupa nulla.
    static func limitFullDays(_ usage: UsageStats.State, limits: [(domain: String, limit: Double?)], now: Double) -> FullDays {
        let keys = UsageStats.dayKeysBack(Date(timeIntervalSince1970: now / 1000), 7)
        var full = Set<String>()
        var bySite: [SiteDays] = []
        for (domain, raw) in limits {
            guard let limit = normalizeLimit(raw) else { continue }
            var n = 0
            for day in keys {
                let seconds = usage.days.first { $0.day == day }?.seconds[UsageStats.siteKey(domain)] ?? 0
                if seconds.isFinite && seconds >= limit { n += 1; full.insert(day) }
            }
            if n > 0 { bySite.append(SiteDays(domain: domain, days: n)) }
        }
        // Holtversenyben a domain kódegység (UTF-16) szerint — a gép és az Android
        // rendje. A Swift `<` a kanonikus alakot hasonlítaná, nem a bájtokat.
        bySite.sort { $0.days != $1.days ? $0.days > $1.days : utf16Less($0.domain, $1.domain) }
        return FullDays(days: full.count, bySite: bySite)
    }

    /// A sor: „A napi keret a héten 2 napon betelt: reddit.com 1× · youtube.com 1×.” — vagy üres, ha egyszer sem.
    static func limitFullLine(_ r: FullDays, labelOf: (String) -> String) -> String {
        if r.days <= 0 { return "" }
        let per = r.bySite.map { "\(labelOf($0.domain)) \($0.days)×" }.joined(separator: " · ")
        return "A napi keret a héten \(r.days) napon betelt" + (per.isEmpty ? "" : ": \(per)") + "."
    }

    static func normalizeLimit(_ value: Double?) -> Double? {
        guard let v = value, v.isFinite, v > 0 else { return nil }
        // Egy napnál nagyobb „keret” ugyanaz, mintha nem lenne.
        return min(v.rounded(), 24 * 3600)
    }

    /// Ma ennyi aktív másodperc ment erre az oldalra EZEN a készüléken.
    ///
    /// iPhone-on ez a gyakorlatban mindig nulla: nincs mérés. Azért van meg
    /// mégis, hogy a mag alakja a másik két platformmal azonos maradjon — és
    /// hogy macOS-en, ahol a mérés létezik, ugyanez a kód működjön.
    static func usedTodaySeconds(_ usage: UsageStats.State, _ domain: String, _ now: Double) -> Double {
        let today = UsageStats.dayKey(Date(timeIntervalSince1970: now / 1000))
        guard let bucket = usage.days.first(where: { $0.day == today }) else { return 0 }
        let seconds = bucket.seconds[UsageStats.siteKey(domain)] ?? 0
        return seconds.isFinite && seconds > 0 ? seconds : 0
    }

    /// Kódegység (UTF-16) szerinti sorrend — a gép (`<` a JS-ben) és az Android
    /// (`String.compareTo`) rendje.
    static func utf16Less(_ a: String, _ b: String) -> Bool {
        TextLogic.utf16Less(a, b)
    }

    /// Egy célra egy nap legfeljebb egy nap lehet.
    private static let digestMaxSeconds: Double = 24 * 3600

    /// `YYYY-MM-DD`, CSAK ASCII számjegyekkel. A `Character.isNumber` minden
    /// írás számjegyét elfogadta volna (arab-indiai, teljes szélességű), a gép
    /// és az Android nem.
    static func isDayKey(_ day: String) -> Bool {
        let u = Array(day.utf8)
        guard u.count == 10, u[4] == 0x2D, u[7] == 0x2D else { return false }
        for (i, b) in u.enumerated() where i != 4 && i != 7 {
            if b < 0x30 || b > 0x39 { return false }
        }
        return true
    }

    /// Amit a kiszolgálóról kaptunk -> használható összegzés, vagy nil.
    ///
    /// A `deviceId` KÍVÜLRŐL jön (a kiszolgáló mondja meg, kié a sor), nem a
    /// blob belsejéből: különben egy eszköz a másik nevében beszélhetne, és a
    /// saját sorunk kihagyása nem érne semmit.
    ///
    /// A szabály a gépé (limits.ts), kimondva: ASCII nap; a másodperc
    /// kerekítve, egy napra vágva, és csak ha így is pozitív; a plafon fölött a
    /// LEGNAGYOBBAK maradnak, holtversenyben a kulcs kódegység szerint. A közös
    /// fixtúra (fixtures/limit-cases.json) kimondja.
    static func normalizeTodayDigest(
        day: String?, seconds: [String: Double]?, deviceId: String
    ) -> TodayDigest? {
        guard let day = day, isDayKey(day) else { return nil }
        var valid: [(key: String, seconds: Double)] = []
        for (k, v) in seconds ?? [:] {
            guard !k.isEmpty, v.isFinite else { continue }
            // Egy nap egy célra legfeljebb egy nap lehet. Ennél nagyobb szám nem
            // mérésből származik, és az egész keretet azonnal elégetné.
            let s = min(v.rounded(.toNearestOrAwayFromZero), digestMaxSeconds)
            if s > 0 { valid.append((k, s)) }
        }
        valid.sort { $0.seconds != $1.seconds ? $0.seconds > $1.seconds : utf16Less($0.key, $1.key) }
        var out: [String: Double] = [:]
        for e in valid.prefix(maxDigestTargets) { out[e.key] = e.seconds }
        return TodayDigest(deviceId: deviceId, day: day, seconds: out)
    }

    /// A `seconds` objektum számai — CSAK a JSON-számok. Az `as? Double` az
    /// igaz/hamisat is számnak vette volna (a JSON-olvasó NSNumber-ként adja), a
    /// gép nem.
    static func secondsOf(_ raw: Any?) -> [String: Double] {
        guard let dict = raw as? [String: Any] else { return [:] }
        var out: [String: Double] = [:]
        for (k, v) in dict {
            guard let n = v as? NSNumber, CFGetTypeID(n as CFTypeRef) != CFBooleanGetTypeID() else { continue }
            out[k] = n.doubleValue
        }
        return out
    }

    /// A visszafejtett blob SZÖVEGE -> összegzés, vagy nil (a hibás JSON is nil).
    static func parseTodayDigest(_ text: String, deviceId: String) -> TodayDigest? {
        guard let obj = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return nil }
        return normalizeTodayDigest(day: obj["day"] as? String, seconds: secondsOf(obj["seconds"]), deviceId: deviceId)
    }

    /// A TÖBBI eszköz mai másodpercei egy oldalra.
    ///
    /// Két dolog marad ki, és mindkettő hibából származna:
    ///   - a saját sorunk (a szinkron a mi összegzésünket is visszaadja) —
    ///     enélkül minden percünk kétszer számítana;
    ///   - a nem mai nap — a másik eszköz más időzónában más napot ír, és a
    ///     tegnapi perceit ma nem szabad felszámolni.
    static func sharedTodaySeconds(_ shared: SharedToday?, _ domain: String, _ now: Double) -> Double {
        guard let shared = shared else { return 0 }
        let today = UsageStats.dayKey(Date(timeIntervalSince1970: now / 1000))
        let key = UsageStats.siteKey(domain)
        var total: Double = 0
        for d in shared.devices where d.deviceId != shared.selfDeviceId && d.day == today {
            if let s = d.seconds[key], s.isFinite, s > 0 { total += s }
        }
        return total
    }

    /// Ma elhasznált idő MINDEN eszközön együtt.
    static func usedTodayEverywhere(
        _ usage: UsageStats.State, _ shared: SharedToday?, _ domain: String, _ now: Double
    ) -> Double {
        usedTodaySeconds(usage, domain, now) + sharedTodaySeconds(shared, domain, now)
    }

    /// Elfogyott-e a mai keret? Keret nélkül sosem.
    ///
    /// Ha nincs `shared` (nincs szinkron, vagy még nem jött le), a helyi mérés
    /// dönt. A távoli másodpercek csak hozzáadnak, tehát ettől a keret sosem
    /// lesz bővebb — a szigorítás pedig mindig ingyen van.
    static func isLimitExhausted(
        domain: String, dailyLimitSeconds: Double?, usage: UsageStats.State,
        shared: SharedToday? = nil, now: Double
    ) -> Bool {
        guard let limit = normalizeLimit(dailyLimitSeconds) else { return false }
        return usedTodayEverywhere(usage, shared, domain, now) >= limit
    }

    /// A teljes blokkolási döntés: szünet, folyamatban lévő törlés, heti
    /// menetrend ÉS a napi keret.
    ///
    /// A sorrend számít. Az aktív szünet mindent visz — azt próbatételekkel
    /// fizette ki a felhasználó, és értelmetlen lenne, ha egy keret csendben
    /// felülírná. Minden más tilt.
    static func isBlockedNowWithLimit(
        _ site: Site, _ usage: UsageStats.State, _ shared: SharedToday?, _ now: Double
    ) -> Bool {
        if let p = site.pauseUntil, p > now { return false }
        if ScheduleLogic.isBlockedNow(pauseUntil: site.pauseUntil,
                                      pendingDeleteAt: site.pendingDeleteAt,
                                      schedule: site.schedule, now: now) { return true }
        return isLimitExhausted(domain: site.domain, dailyLimitSeconds: site.dailyLimitSeconds,
                                usage: usage, shared: shared, now: now)
    }

    /// Zár-e az oldal a szünete VÉGÉN — a szünetet nem számítva. A gépi
    /// `closesAfterPause` tükre: a menetrend és a törlésre várás az akkori
    /// időpontban, és a napi keret a mostani mérésből (a következő napon a
    /// keret nulláról indul). Egy nyitott menetrend-sávban véget érő szünet
    /// után az oldal nyitva marad — a „mindjárt újra zárva” hamis volna.
    /// Nincs szünet (vagy nem szám): hamis.
    static func closesAfterPause(_ site: Site, _ usage: UsageStats.State, _ shared: SharedToday?) -> Bool {
        guard let until = site.pauseUntil, until.isFinite else { return false }
        var open = site
        open.pauseUntil = nil
        return isBlockedNowWithLimit(open, usage, shared, until)
    }

    /// Lazítás-e a keret változtatása (vagyis próbatételbe kerül-e)?
    ///
    /// Emelni vagy megszüntetni több időt vesz az oldalon, tehát ugyanolyan
    /// súrlódás jár érte, mint egy feloldásért. Csökkenteni vagy bevezetni
    /// szigorítás, az azonnal érvényes — a segítő irány mindig ingyenes.
    static func isLimitLoosening(_ current: Double?, _ next: Double?) -> Bool {
        let cur = normalizeLimit(current)
        let nxt = normalizeLimit(next)
        if cur == nil { return false }   // eddig nem volt keret: bármilyen keret szigorúbb
        guard let n = nxt else { return true }
        return n > cur!
    }

    /// A KERET KÖZELSÉGE: ennyi másodpercen belül szólunk, mielőtt a mai keret betelik.
    static let limitSoonSeconds: Double = 10 * 60

    /// Hány másodperc van hátra a mai keretből — nil, ha nincs keret. Nem megy nulla alá.
    static func limitRemaining(_ dailyLimitSeconds: Double?, _ usedSeconds: Double) -> Double? {
        guard let limit = normalizeLimit(dailyLimitSeconds) else { return nil }
        return max(0, limit - usedSeconds)
    }

    /// KÖZELEG A NAPI KERET: a legsürgősebb oldal — a legkevesebb hátralévővel, de
    /// még nem betelve, a küszöbön belül. „Ma még 8 perc a kereted: youtube.com.”
    /// Tény, nem tiltás. Üres, ha egyik sincs a küszöbön belül. A címkét a hívó adja.
    static func limitSoonLine(_ candidates: [(label: String, dailyLimitSeconds: Double?, usedSeconds: Double)]) -> String {
        var best: (label: String, rem: Double)?
        for c in candidates {
            guard let limit = normalizeLimit(c.dailyLimitSeconds) else { continue }
            let rem = max(0, limit - c.usedSeconds)
            // A küszöb az utolsó tíz perc, de legfeljebb a keret FELE — egy kis
            // keret ne szólaljon meg a legelső perctől, hanem a hátsó felében.
            let threshold = min(limitSoonSeconds, limit / 2)
            if rem <= 0 || rem > threshold { continue }
            if best == nil || rem < best!.rem { best = (c.label, rem) }
        }
        guard let b = best else { return "" }
        return "Ma még \(Int(ceil(b.rem / 60))) perc a kereted: \(b.label)."
    }
}
