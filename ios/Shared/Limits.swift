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

    /// Amit a kiszolgálóról kaptunk -> használható összegzés, vagy nil.
    ///
    /// A `deviceId` KÍVÜLRŐL jön (a kiszolgáló mondja meg, kié a sor), nem a
    /// blob belsejéből: különben egy eszköz a másik nevében beszélhetne, és a
    /// saját sorunk kihagyása nem érne semmit.
    static func normalizeTodayDigest(
        day: String?, seconds: [String: Double]?, deviceId: String
    ) -> TodayDigest? {
        guard let day = day, day.count == 10 else { return nil }
        let parts = day.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              parts.allSatisfy({ $0.allSatisfy { $0.isNumber } }) else { return nil }

        var out: [String: Double] = [:]
        for (k, v) in (seconds ?? [:]).sorted(by: { $0.key < $1.key }) {
            if out.count >= maxDigestTargets { break }
            guard !k.isEmpty, v.isFinite, v > 0 else { continue }
            // Egy nap egy célra legfeljebb egy nap lehet. Ennél nagyobb szám nem
            // mérésből származik, és az egész keretet azonnal elégetné.
            out[k] = min(v.rounded(), 24 * 3600)
        }
        return TodayDigest(deviceId: deviceId, day: day, seconds: out)
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
}
