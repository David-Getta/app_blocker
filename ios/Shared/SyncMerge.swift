import Foundation

/// Két eszköz blokklistájának összefésülése — a
/// `desktop/src/shared/sync/merge.ts` tükre.
///
/// Ez a szinkron kockázatos fele. Ha az összefésülés bármikor a lazább oldal
/// felé dől, elég két eszköz és egy jól időzített művelet ahhoz, hogy
/// próbatétel nélkül oldódjon fel valami. Ezért itt is ugyanaz a szabály, ami
/// az app többi részét tartja:
///
///     szigorítás ingyen van, lazítás munkába kerül.
///
/// MEZŐNKÉNT dől el, nem rekordonként: a négy tiltó mező (törlés, menetrend,
/// napi keret, adag-szabály) a saját kifizetett lazítás-számlálóját hordja —
/// a bíró írja, a próbatétel teljesítésekor. A több kifizetett lazítás nyer;
/// egyenlő számnál a mező SZIGORÚBB alakja jön ki (a menetrendek uniója, a
/// kisebb keret, a kisebb adag és a hosszabb szünet, törlés csak ha mindkettő
/// vár). A rekord `rev`-je nem hitelesít lazítást: az ingyenes szigorítás is
/// lépteti, és egy elavult eszköz így felhúzott rekordja eddig egészében nyert.
enum SyncMerge {

    /// Egy oldal a szinkronban.
    ///
    /// A SZÜNET szándékosan nincs benne: eszközfüggő és rövid életű, fel se megy
    /// a kiszolgálóra. Egy próbatétel egy eszközön nem oldhat fel mindenhol.
    struct SyncSite: Codable, Equatable {
        var id: String
        var domain: String
        var hostnames: [String]
        var addedAt: Double
        var pendingDeleteAt: Double?
        var schedule: ScheduleLogic.Schedule?
        var dailyLimitSeconds: Double?
        /// Adag-szabály: a kettő csak együtt értelmes. Az iPhone nem mér
        /// előteret, ezért itt nem érvényesül — de a mezőket át kell vinnie,
        /// különben minden kör letörölné a gépeken beállított szabályt.
        var burstSeconds: Double?
        var cooldownSeconds: Double?
        var alias: String?
        /// indok: miért tiltottad — a nyertes rekorddal jön, mint a fedőnév
        var reason: String?
        /// Részleges szabályok (`youtube.com/@valaki`).
        ///
        /// A `nil` és az ÜRES TÖMB két különböző dolog, és ezen múlik, hogy egy
        /// régi kliens le tudja-e törölni a szabályokat. A `nil` jelentése:
        /// nem tudok erről a mezőről. A `[]` jelentése: volt, és el lett
        /// távolítva. Lásd `mergeRules`. A `JSONEncoder` a nilt alapból
        /// kihagyja — pont ez kell.
        var rules: [UrlRules.UrlRule]?
        var rev: Int
        var updatedAt: Double
        var updatedBy: String
        /// A hosztnevek JELEI: név → a rekord rev-je, amelyik a nevet utoljára
        /// felvette vagy levette (melyik történt, azt a `hostnames` mondja). A
        /// nagyobb jel dönt az összefésülésnél; jel nélkül a bővebb nyer. Az
        /// iPhone nem szerkeszt hosztnevet: hordozza és fésüli a jeleket. Lásd
        /// `withHostnames` (merge.ts tükre). Utolsó tag, hogy a tagonkénti
        /// inicializáló régi hívásai változatlanok maradjanak.
        var hostnameMarks: [String: Int]? = nil

        /// A kulcsok KÉZZEL. Amíg csak a kódolás volt saját, a fordító
        /// előállította őket a dekódoláshoz; a saját dekódolás óta egyiket sem
        /// állítja elő — és a hiányukat a CI elnyelte, a Swift mag napokig nem
        /// fordult. Új mező → új kulcs IDE IS, különben nem utazik.
        /// A szabálylista JELE: a rekord rev-je, amelyik a listát utoljára
        /// változtatta. A fésülésben a nagyobb jel dönt; azonos jelnél a régi
        /// szabály; a mező nélküli rekord (régi kliens) a másik oldal listáját
        /// ÉS jelét viszi. Az iPhone nem ír ilyet, hordozza. Lásd `mergeRules`.
        var rulesRev: Int? = nil
        /// A KIFIZETETT LAZÍTÁSOK száma mezőnként — a bíró írja, a próbatétel
        /// teljesítésekor. A fésülésben a több nyer, egyenlőnél a szigorúbb
        /// alak. Nil = nulla (régi kliens). A merge.ts tükre.
        var deleteLoosens: Int? = nil
        var scheduleLoosens: Int? = nil
        var limitLoosens: Int? = nil
        var burstLoosens: Int? = nil
        /// A szabályok JELEI: szabály-kulcs (hoszt + út) → a rekord rev-je,
        /// amelyik a szabályt utoljára felvette vagy levette (a levett szabály
        /// jele sírkő). Szabályonként a nagyobb jel dönt; egyenlőnél a
        /// jelenlét. Az iPhone nem szerkeszt szabályt: hordozza és fésüli a
        /// jeleket. A merge.ts tükre.
        var ruleMarks: [String: Int]? = nil
        /// A VÉGIGMENT törlés jele: annak a törlés-kérésnek a számlálója
        /// (`deleteLoosens`), amelyik valahol végigment. A fésülésben a nagyobb
        /// marad. A rekord halott (`isGone`), ha ez a kérés még mindig az utolsó,
        /// és senki nem vonta vissza. A merge.ts tükre.
        var goneLoosens: Int? = nil

        enum CodingKeys: String, CodingKey {
            case id, domain, hostnames, addedAt, pendingDeleteAt, schedule
            case dailyLimitSeconds, burstSeconds, cooldownSeconds, alias, reason, rules
            case rev, updatedAt, updatedBy, hostnameMarks, rulesRev
            case deleteLoosens, scheduleLoosens, limitLoosens, burstLoosens
            case ruleMarks, goneLoosens
        }

        init(
            id: String, domain: String, hostnames: [String], addedAt: Double,
            pendingDeleteAt: Double? = nil, schedule: ScheduleLogic.Schedule? = nil,
            dailyLimitSeconds: Double? = nil, burstSeconds: Double? = nil,
            cooldownSeconds: Double? = nil, alias: String? = nil, reason: String? = nil,
            rules: [UrlRules.UrlRule]? = nil, rev: Int, updatedAt: Double, updatedBy: String,
            hostnameMarks: [String: Int]? = nil, rulesRev: Int? = nil,
            deleteLoosens: Int? = nil, scheduleLoosens: Int? = nil,
            limitLoosens: Int? = nil, burstLoosens: Int? = nil,
            ruleMarks: [String: Int]? = nil, goneLoosens: Int? = nil
        ) {
            self.id = id
            self.domain = domain
            self.hostnames = hostnames
            self.addedAt = addedAt
            self.pendingDeleteAt = pendingDeleteAt
            self.schedule = schedule
            self.dailyLimitSeconds = dailyLimitSeconds
            self.burstSeconds = burstSeconds
            self.cooldownSeconds = cooldownSeconds
            self.alias = alias
            self.reason = reason
            self.rules = rules
            self.rev = rev
            self.updatedAt = updatedAt
            self.updatedBy = updatedBy
            self.hostnameMarks = hostnameMarks
            self.rulesRev = rulesRev
            self.deleteLoosens = deleteLoosens
            self.scheduleLoosens = scheduleLoosens
            self.limitLoosens = limitLoosens
            self.burstLoosens = burstLoosens
            self.ruleMarks = ruleMarks
            self.goneLoosens = goneLoosens
        }

        /// SAJÁT dekódolás, hogy a jelek TŰRŐEN jöjjenek: egy nem-egész érték
        /// egyetlen rekordban ne vigye el az egész listát — az iPhone ilyenkor a
        /// saját listáját tolná fel a többiek helyett. A többi mező a régi
        /// szigorral (a `rev` hiányát a gép is 1-nek veszi).
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            // A rekord csak az azonosító és a domain hibájára esik ki (a lista
            // olvasója elemenként tűr, lásd `sitesFromJson`); minden más mező
            // rossz típusa az alapértékét kapja — mint a gépen és Androidon.
            id = try c.decode(String.self, forKey: .id)
            domain = try c.decode(String.self, forKey: .domain)
            let hostsValue = c.lossyStrings(.hostnames)
            hostnames = hostsValue
            addedAt = c.lenient(Double.self, .addedAt) ?? 0
            pendingDeleteAt = c.lenient(Double.self, .pendingDeleteAt)
            // Ami nem objektum, az nincs (mint a hiányzó: mindig tiltva) — eddig
            // az egész oldalt vitte.
            schedule = c.lenient(ScheduleLogic.Schedule.self, .schedule)
            dailyLimitSeconds = c.lenient(Double.self, .dailyLimitSeconds)
            burstSeconds = c.lenient(Double.self, .burstSeconds)
            cooldownSeconds = c.lenient(Double.self, .cooldownSeconds)
            alias = c.lenient(String.self, .alias)
            reason = c.lenient(String.self, .reason)
            // A részleges szabályok: ami nem lista, az „nem tudok róla” (nil, nem
            // üres lista); a listából csak a KANONIKUS alak megy át, átírás
            // nélkül — a gép `cleanRules`-a szerint. Eddig egyetlen rossz
            // szabály az egész oldalt vitte.
            rules = c.lenient([Lossy<UrlRules.UrlRule>].self, .rules)?
                .compactMap { $0.value }.filter(SyncMerge.isWireRule)
            let revValue = c.lenient(Int.self, .rev) ?? 1
            rev = revValue
            updatedAt = c.lenient(Double.self, .updatedAt) ?? 0
            updatedBy = c.lenient(String.self, .updatedBy) ?? ""
            // Ugyanaz a szűrés, mint a gépen és Androidon (`cleanMarks`): csak
            // pozitív egész, a rekord rev-jénél nem nagyobb jel, a plafonnal —
            // egy kulccsal írt szemét ne járjon másképp itt, mint a másik kettőn.
            // Értékenként: egy rossz jel csak magát viszi, nem az összeset.
            var cleanedMarks: [String: Int]? = nil
            if let m = c.lossyIntMap(.hostnameMarks) {
                let valid = m.filter { !$0.key.isEmpty && $0.value > 0 && $0.value <= revValue }
                cleanedMarks = SyncMerge.capHostnameMarks(valid, hostsValue.filter { Blocklist.isCanonicalHostname($0) })
            }
            hostnameMarks = cleanedMarks
            // A szabálylista jele: pozitív egész, legfeljebb a rekord rev-je — és
            // csak lista mellett; mező nélkül nincs jel.
            let rawRulesRev = (try? c.decodeIfPresent(Int.self, forKey: .rulesRev)) ?? nil
            if rules != nil, let m = rawRulesRev, m > 0, m <= revValue {
                rulesRev = m
            } else {
                rulesRev = nil
            }
            // A kifizetett lazítások: pozitív egész, legfeljebb a rekord rev-je
            // (csak léptetés írhatja); ami más, az nincs — mint a gépen és Androidon.
            func loosens(_ key: CodingKeys) -> Int? {
                guard let v = (try? c.decodeIfPresent(Int.self, forKey: key)) ?? nil, v > 0, v <= revValue else { return nil }
                return v
            }
            deleteLoosens = loosens(.deleteLoosens)
            scheduleLoosens = loosens(.scheduleLoosens)
            limitLoosens = loosens(.limitLoosens)
            burstLoosens = loosens(.burstLoosens)
            // A szabályok jelei: csak KANONIKUS szabály-kulcs → pozitív egész,
            // legfeljebb a rekord rev-je; csak szabálylista mellett. A gép
            // `cleanRuleMarks`-a. Értékenként: egy rossz jel csak magát viszi.
            if let list = rules, let m = c.lossyIntMap(.ruleMarks) {
                let valid = m.filter { entry in
                    guard entry.value > 0, entry.value <= revValue,
                          let norm = UrlRules.normalizeRule(entry.key) else { return false }
                    return SyncMerge.ruleKey(norm) == entry.key
                }
                ruleMarks = SyncMerge.capHostnameMarks(valid, list.map { SyncMerge.ruleKey($0) })
            } else {
                ruleMarks = nil
            }
            // A végigment törlés jele legfeljebb a törlés számlálója: nagyobbat
            // a fésülés sosem ír — mint a gépen és Androidon.
            if let g = (try? c.decodeIfPresent(Int.self, forKey: .goneLoosens)) ?? nil, g > 0, g <= (deleteLoosens ?? 0) {
                goneLoosens = g
            } else {
                goneLoosens = nil
            }
        }

        /// A `pendingDeleteAt` KIÍRÁSA kötelező, nem elhagyható.
        ///
        /// A `JSONEncoder` alapból kihagyja a nil mezőket. A TypeScript oldalon
        /// viszont a típus `number | null`, és az összefésülés `!== null`-t néz:
        /// egy hiányzó kulcsból `undefined` lesz, ami NEM egyenlő null-lal —
        /// vagyis minden oldal úgy nézne ki, mintha törlésre várna. Ezért itt
        /// kézzel írjuk ki, nullal együtt.
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id)
            try c.encode(domain, forKey: .domain)
            try c.encode(hostnames, forKey: .hostnames)
            try c.encode(addedAt, forKey: .addedAt)
            try c.encode(pendingDeleteAt, forKey: .pendingDeleteAt)
            try c.encodeIfPresent(schedule, forKey: .schedule)
            try c.encodeIfPresent(dailyLimitSeconds, forKey: .dailyLimitSeconds)
            try c.encodeIfPresent(burstSeconds, forKey: .burstSeconds)
            try c.encodeIfPresent(cooldownSeconds, forKey: .cooldownSeconds)
            try c.encodeIfPresent(alias, forKey: .alias)
            try c.encodeIfPresent(reason, forKey: .reason)
            try c.encodeIfPresent(rules, forKey: .rules)
            try c.encode(rev, forKey: .rev)
            try c.encode(updatedAt, forKey: .updatedAt)
            try c.encode(updatedBy, forKey: .updatedBy)
            try c.encodeIfPresent(hostnameMarks, forKey: .hostnameMarks)
            // A szabálylista jele csak lista mellett: mező nélkül nincs jel.
            if rules != nil { try c.encodeIfPresent(rulesRev, forKey: .rulesRev) }
            try c.encodeIfPresent(deleteLoosens, forKey: .deleteLoosens)
            try c.encodeIfPresent(scheduleLoosens, forKey: .scheduleLoosens)
            try c.encodeIfPresent(limitLoosens, forKey: .limitLoosens)
            try c.encodeIfPresent(burstLoosens, forKey: .burstLoosens)
            // A szabályok jelei is csak lista mellett.
            if rules != nil { try c.encodeIfPresent(ruleMarks, forKey: .ruleMarks) }
            // A végigment törlés jele — a sírkövön.
            try c.encodeIfPresent(goneLoosens, forKey: .goneLoosens)
        }
    }

    // MARK: - szigorúság
    //
    // A menetrend SZERKEZET szerint fésülődik, nem időbélyeg szerint: két eszköz
    // lehet más időzónában, és akkor ugyanaz a két menetrend máshogy fésülődne
    // a két gépen — a szinkron sosem konvergálna. A sávok amúgy is helyi-óra
    // percekben vannak megadva.

    /// Az `inAnyBand` szerkezeti párja — ugyanaz az éjfél-átfordulás.
    private static func anyBandAtGrid(_ bands: [ScheduleLogic.Band], _ day: Int, _ minute: Int) -> Bool {
        let prevDay = (day + 6) % 7
        for b in bands {
            if b.endMin > b.startMin {
                if b.days.contains(day) && minute >= b.startMin && minute < b.endMin { return true }
            } else {
                if b.days.contains(day) && minute >= b.startMin { return true }
                if b.days.contains(prevDay) && minute < b.endMin { return true }
            }
        }
        return false
    }

    /// A heti rács: 7×1440 perc, igaz ahol a menetrend tilt — a merge.ts `scheduleGrid`-je.
    private static func scheduleGrid(_ s: ScheduleLogic.Schedule?) -> [Bool] {
        let sch = ScheduleLogic.normalize(s)
        if sch.mode == .always { return [Bool](repeating: true, count: 7 * 1440) }
        var g = [Bool](repeating: false, count: 7 * 1440)
        let block = sch.mode == .block
        for day in 0..<7 {
            for minute in 0..<1440 where anyBandAtGrid(sch.bands, day, minute) == block {
                g[day * 1440 + minute] = true
            }
        }
        return g
    }

    /// Egy rács menetrendként — a merge.ts `scheduleFromGrid`-je: a tiltott
    /// percek napon belüli szakaszai, az azonos szakaszú napok egy sávban,
    /// kezdés, aztán vég szerint. Ha minden perc tiltva: mindig.
    private static func scheduleFromGrid(_ g: [Bool]) -> ScheduleLogic.Schedule {
        if g.allSatisfy({ $0 }) { return ScheduleLogic.Schedule(mode: .always, bands: []) }
        var runs: [String: (start: Int, end: Int, days: [Int])] = [:]
        for day in 0..<7 {
            var minute = 0
            while minute < 1440 {
                if !g[day * 1440 + minute] { minute += 1; continue }
                let start = minute
                while minute < 1440 && g[day * 1440 + minute] { minute += 1 }
                let key = "\(start)/\(minute)"
                var run = runs[key] ?? (start: start, end: minute, days: [])
                run.days.append(day)
                runs[key] = run
            }
        }
        let bands = runs.values
            .sorted { $0.start != $1.start ? $0.start < $1.start : $0.end < $1.end }
            .map { ScheduleLogic.Band(days: $0.days, startMin: $0.start, endMin: $0.end) }
        return ScheduleLogic.Schedule(mode: .block, bands: bands)
    }

    /// A menetrend nyers kulcsa — bájtra a merge.ts `scheduleRawKey`-je; a hiányzó az üres szöveg.
    private static func scheduleRawKey(_ s: ScheduleLogic.Schedule?) -> String {
        guard let s = s else { return "" }
        let bands = s.bands.map { b in
            Array(Set(b.days)).sorted().map(String.init).joined(separator: ",") + "/\(b.startMin)/\(b.endMin)"
        }
        return s.mode.rawValue + "|" + bands.joined(separator: ";")
    }

    private static func isGridForm(_ s: ScheduleLogic.Schedule?, _ g: [Bool]) -> Bool {
        s != nil && scheduleRawKey(s) == scheduleRawKey(scheduleFromGrid(g))
    }

    /// Két menetrend SZIGORÚBB alakja — a merge.ts `joinSchedule`-je: minden perc
    /// tiltva, amit bármelyik tilt. Ha az egyik lefedi a másikat, az marad;
    /// egyenlőnél a felhasználó saját alakja a rácsból épített ellen, két saját
    /// közül a kisebb nyers kulcsú (kódegység szerint); különben a rácsból épül.
    static func joinSchedule(_ a: ScheduleLogic.Schedule?, _ b: ScheduleLogic.Schedule?) -> ScheduleLogic.Schedule? {
        let ka = scheduleRawKey(a)
        let kb = scheduleRawKey(b)
        if ka == kb { return a }
        let ga = scheduleGrid(a)
        let gb = scheduleGrid(b)
        var aCovers = true
        var bCovers = true
        for i in 0..<ga.count {
            if gb[i] && !ga[i] { aCovers = false }
            if ga[i] && !gb[i] { bCovers = false }
        }
        if aCovers && bCovers {
            let fa = isGridForm(a, ga)
            let fb = isGridForm(b, gb)
            if fa != fb { return fa ? b : a }
            return !TextLogic.utf16Less(kb, ka) ? a : b
        }
        if aCovers { return a }
        if bCovers { return b }
        return scheduleFromGrid((0..<ga.count).map { ga[$0] || gb[$0] })
    }

    /// A szigorúbb napi keret — a merge.ts `joinLimit`-je: a kisebb; a keret nélküli a leglazább.
    static func joinLimit(_ a: Double?, _ b: Double?) -> Double? {
        guard let na = LimitLogic.normalizeLimit(a) else { return LimitLogic.normalizeLimit(b) == nil ? nil : b }
        guard let nb = LimitLogic.normalizeLimit(b) else { return a }
        if na != nb { return na < nb ? a : b }
        return min(a!, b!)
    }

    /// Az adag-szabály egy rekordon — a kettő csak együtt értelmes.
    typealias BurstPair = (burst: Double?, cooldown: Double?)

    /// Az adag-szabály plafonjai — a shared/burst.ts és a core/Burst.kt párja.
    static let maxBurstMinutes = 24 * 60
    static let maxCooldownMinutes = 24 * 60

    /// Az adag-szabály normál alakja — a shared/burst.ts `normalizeBurst`-je:
    /// csak a kettő együtt, pozitívan; kerekítve, a plafonnal.
    private static func normalizeBurst(_ p: BurstPair) -> (burst: Double, cooldown: Double)? {
        guard let b = p.burst, let c = p.cooldown, b.isFinite, c.isFinite, b > 0, c > 0 else { return nil }
        return (min(b.rounded(), Double(maxBurstMinutes * 60)), min(c.rounded(), Double(maxCooldownMinutes * 60)))
    }

    /// A szigorúbb adag-szabály — a merge.ts `joinBurst`-je: a kisebb adag ÉS a
    /// hosszabb szünet; ha az egyik mindkettőben legalább olyan szigorú, az marad.
    static func joinBurst(_ a: BurstPair, _ b: BurstPair) -> BurstPair {
        guard let na = normalizeBurst(a) else { return normalizeBurst(b) == nil ? (burst: nil, cooldown: nil) : b }
        guard let nb = normalizeBurst(b) else { return a }
        let aStricter = na.burst <= nb.burst && na.cooldown >= nb.cooldown
        let bStricter = nb.burst <= na.burst && nb.cooldown >= na.cooldown
        if aStricter && bStricter {
            // Ugyanaz a szabály — a nyers alakok közül a kisebb, hogy a döntés ne függjön a sorrendtől.
            let ka = a.burst ?? 0
            let kb = b.burst ?? 0
            if ka != kb { return ka < kb ? a : b }
            return (a.cooldown ?? 0) <= (b.cooldown ?? 0) ? a : b
        }
        if aStricter { return a }
        if bStricter { return b }
        return (burst: min(na.burst, nb.burst), cooldown: max(na.cooldown, nb.cooldown))
    }

    /// A törlésre várás szigorúbb alakja: csak ha mindkettő vár — akkor a későbbi határidő.
    private static func joinDelete(_ a: Double?, _ b: Double?) -> Double? {
        guard let x = a, let y = b else { return nil }
        return max(x, y)
    }

    private static func loosensOf(_ v: Int?) -> Int {
        guard let v = v, v > 0 else { return 0 }
        return v
    }

    /// Egy mező a fésülésben: a több kifizetett lazítás nyer; egyenlőnél a szigorúbb alak.
    private static func byLoosens<T>(_ ca: Int, _ cb: Int, _ va: T, _ vb: T, _ join: (T, T) -> T) -> T {
        ca != cb ? (ca > cb ? va : vb) : join(va, vb)
    }

    /// A FRISSEBB rekord — rev, idő, eszköz (kódegység szerint). Már csak a fedőnév és az indok múlik rajta.
    private static func newerSite(_ a: SyncSite, _ b: SyncSite) -> SyncSite {
        if a.rev != b.rev { return a.rev > b.rev ? a : b }
        if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt ? a : b }
        return !TextLogic.utf16Less(b.updatedBy, a.updatedBy) ? a : b
    }

    // MARK: - összefésülés

    /// Két azonos azonosítójú rekord összefésülése — MEZŐNKÉNT (lásd a fájl
    /// elejét). Szimmetrikus: minden eszköz ugyanazt kapja.
    static func mergeSite(_ a: SyncSite, _ b: SyncSite) -> SyncSite {
        let dA = loosensOf(a.deleteLoosens), dB = loosensOf(b.deleteLoosens)
        let sA = loosensOf(a.scheduleLoosens), sB = loosensOf(b.scheduleLoosens)
        let lA = loosensOf(a.limitLoosens), lB = loosensOf(b.limitLoosens)
        let bA = loosensOf(a.burstLoosens), bB = loosensOf(b.burstLoosens)
        var out = newerSite(a, b)
        // A törlésre várás nem tűnhet el csendben: a kérése próbatétel (a
        // számláló nő), a visszavonása ingyen — egyenlő számnál a nem váró nyer.
        out.pendingDeleteAt = byLoosens(dA, dB, a.pendingDeleteAt, b.pendingDeleteAt, joinDelete)
        out.schedule = byLoosens(sA, sB, a.schedule, b.schedule, joinSchedule)
        out.dailyLimitSeconds = byLoosens(lA, lB, a.dailyLimitSeconds, b.dailyLimitSeconds, joinLimit)
        let burst = byLoosens(bA, bB, (burst: a.burstSeconds, cooldown: a.cooldownSeconds),
                              (burst: b.burstSeconds, cooldown: b.cooldownSeconds), joinBurst)
        out.burstSeconds = burst.burst
        out.cooldownSeconds = burst.cooldown
        out.rev = max(a.rev, b.rev)
        let positive: (Int) -> Int? = { $0 > 0 ? $0 : nil }
        out.deleteLoosens = positive(max(dA, dB))
        out.scheduleLoosens = positive(max(sA, sB))
        out.limitLoosens = positive(max(lA, lB))
        out.burstLoosens = positive(max(bA, bB))
        out.goneLoosens = positive(max(loosensOf(a.goneLoosens), loosensOf(b.goneLoosens)))
        // A hosztnevek nevenként, a jelük szerint; a szabályok a listájuk jele szerint.
        return withHostnames(withRules(out, a, b), a, b)
    }

    /// A hosztnevek NEVENKÉNT fésülődnek, a jelük szerint: a nagyobb jelnél
    /// álló állapot (benne van vagy nincs) marad; egyenlő jelnél (a jel nélküli
    /// név is ilyen) a rekord dönt, ahogy eddig — eltérő revnél az újabb, egyenlő
    /// revnél a bővebb: versenyhelyzet sosem old fel. Rendezve, hogy két eszköz
    /// ugyanazt kapja. A TypeScript- és Kotlin-tükör ugyanezt teszi (merge.ts
    /// withHostnames).
    private static func withHostnames(_ merged: SyncSite, _ a: SyncSite, _ b: SyncSite) -> SyncSite {
        let am = a.hostnameMarks ?? [:]
        let bm = b.hostnameMarks ?? [:]
        var names = Set(a.hostnames)
        names.formUnion(b.hostnames)
        names.formUnion(am.keys)
        names.formUnion(bm.keys)
        var hostnames: [String] = []
        var marks: [String: Int] = [:]
        for h in names.sorted() {
            let ma = am[h] ?? 0
            let mb = bm[h] ?? 0
            let inA = a.hostnames.contains(h)
            let inB = b.hostnames.contains(h)
            // Egyenlő POZITÍV jelnél a jelenlét nyer (szigorúbb, és sorrendtől
            // független); jel nélkül a rekord dönt, ahogy eddig.
            let present: Bool
            if ma > mb { present = inA }
            else if mb > ma { present = inB }
            else if ma > 0 { present = inA || inB }
            else if a.rev != b.rev { present = a.rev > b.rev ? inA : inB }
            else { present = inA || inB }
            if present { hostnames.append(h) }
            if max(ma, mb) > 0 { marks[h] = max(ma, mb) }
        }
        var out = merged
        out.hostnames = hostnames
        out.hostnameMarks = capHostnameMarks(marks, hostnames)
        return out
    }

    /// Ennél több hosztnév-jelet nem hordunk egy oldalon.
    static let maxHostnameMarks = 64

    /// A jelek plafonja — EGY szabály a fésülésre: a jelen lévő nevek jele
    /// mindig marad, a levett nevekből a legnagyobb jelűek férnek be. Üresen
    /// nil. A merge.ts `capHostnameMarks` tükre.
    static func capHostnameMarks(_ marks: [String: Int], _ hostnames: [String]) -> [String: Int]? {
        if marks.isEmpty { return nil }
        if marks.count <= maxHostnameMarks { return marks }
        let present = Set(hostnames)
        var out: [String: Int] = [:]
        for (h, v) in marks where present.contains(h) { out[h] = v }
        let gone = marks.filter { !present.contains($0.key) }
            .sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
        for (h, v) in gone {
            if out.count >= maxHostnameMarks { break }
            out[h] = v
        }
        return out
    }

    private static func withRules(_ winner: SyncSite, _ a: SyncSite, _ b: SyncSite) -> SyncSite {
        var out = winner
        let merged = mergeRules(a, b)
        out.rules = merged.rules
        out.rulesRev = (merged.rules != nil && merged.mark > 0) ? merged.mark : nil
        if merged.rules != nil, let m = merged.marks, !m.isEmpty { out.ruleMarks = m } else { out.ruleMarks = nil }
        return out
    }

    /// Egy szabály kulcsa a jelekhez: a kanonikus hoszt + út — a merge.ts `ruleKey`-je.
    static func ruleKey(_ r: UrlRules.UrlRule) -> String { r.host + r.path }

    private static func markOf(_ v: Int?) -> Int {
        guard let v = v, v > 0 else { return 0 }
        return v
    }

    private struct MergedRules {
        let rules: [UrlRules.UrlRule]?
        let marks: [String: Int]?
        let mark: Int
    }

    /// A részleges szabályok összefésülése — a rekord többi mezőjétől KÜLÖN,
    /// SZABÁLYONKÉNT (a merge.ts `mergeRules`-a):
    ///
    ///  1. **A szabály jele dönt.** A nagyobb jelnél álló állapot (benne van
    ///     vagy nincs) marad — a kifizetett levétel átmegy, és egy régebbi
    ///     eszköz ingyenes szerkesztése sem hozza vissza.
    ///  2. **Egyenlő jelnél a jelenlét** — a jel nélküli szabály is ilyen.
    ///  3. **A lista-jel (`rulesRev`) már nem dönt**, csak továbbmegy (a
    ///     nagyobb): egy ingyenes felvétel eddig nagyobb jellel egészében vitte
    ///     a listáját, és a másik eszközön felvett szabály eltűnt.
    ///  4. **A `nil` NEM ugyanaz, mint a `[]`.** A mező nélküli rekord (régi
    ///     kliens) a másik oldal listáját, jeleit és lista-jelét viszi.
    ///
    /// A plafon: legfeljebb 50 szabály marad (a nagyobb jelűek, egyenlőnél
    /// kulcs szerint, kódegységben); a kiesett szabály jele is kiesik.
    private static func mergeRules(_ a: SyncSite, _ b: SyncSite) -> MergedRules {
        let ar = cleanRules(a.rules)
        let br = cleanRules(b.rules)
        guard let al = ar else {
            guard let bl = br else { return MergedRules(rules: nil, marks: nil, mark: 0) }
            return MergedRules(rules: bl, marks: b.ruleMarks, mark: markOf(b.rulesRev))
        }
        guard let bl = br else { return MergedRules(rules: al, marks: a.ruleMarks, mark: markOf(a.rulesRev)) }
        let am = a.ruleMarks ?? [:]
        let bm = b.ruleMarks ?? [:]
        var byKey: [String: UrlRules.UrlRule] = [:]
        for r in al + bl { byKey[ruleKey(r)] = r }
        let inA = Set(al.map { ruleKey($0) })
        let inB = Set(bl.map { ruleKey($0) })
        var keys = Set(byKey.keys)
        keys.formUnion(am.keys)
        keys.formUnion(bm.keys)
        var marks: [String: Int] = [:]
        var present: [String] = []
        for k in keys {
            let ma = markOf(am[k])
            let mb = markOf(bm[k])
            let here: Bool
            if ma > mb { here = inA.contains(k) } else if mb > ma { here = inB.contains(k) } else {
                here = inA.contains(k) || inB.contains(k)
            }
            if max(ma, mb) > 0 { marks[k] = max(ma, mb) }
            if here { present.append(k) }
        }
        present.sort { x, y in
            let mx = markOf(marks[x])
            let my = markOf(marks[y])
            return mx != my ? mx > my : TextLogic.utf16Less(x, y)
        }
        for k in present.dropFirst(UrlRules.maxRulesPerSite) { marks.removeValue(forKey: k) }
        let kept = Array(present.prefix(UrlRules.maxRulesPerSite))
        // Stabil sorrend, hogy két eszköz bájtra ugyanazt a listát kapja.
        let rules = kept.compactMap { byKey[$0] }.sorted { TextLogic.utf16Less(ruleKey($0), ruleKey($1)) }
        return MergedRules(rules: rules, marks: capHostnameMarks(marks, kept), mark: max(markOf(a.rulesRev), markOf(b.rulesRev)))
    }

    /// Szemétszűrés: a szinkronon át érkező szabály ugyanolyan megbízhatatlan,
    /// mint bármi más, ami kívülről jön.
    private static func cleanRules(_ rules: [UrlRules.UrlRule]?) -> [UrlRules.UrlRule]? {
        guard let rules = rules else { return nil }
        var out: [UrlRules.UrlRule] = []
        for r in rules {
            // Ugyanazon a magon megy át, mint a kézzel beírt szabály.
            guard let norm = UrlRules.normalizeRule(r.host + r.path) else { continue }
            if out.contains(where: { UrlRules.sameRule($0, norm) }) { continue }
            if out.count >= UrlRules.maxRulesPerSite { break }
            out.append(norm)
        }
        return out
    }

    /// HALOTT-e a rekord: a törlése végigment valahol (`goneLoosens`), és azóta
    /// senki nem vonta vissza (a kérés ugyanaz, és még vár) — új kérés sem
    /// jött. A visszavonás és az újabb kérés élő rekordot ad. A halott rekord
    /// nem tilt semmit, de UTAZIK: egy régi eszköz rekordja vele fésülődve maga
    /// is halott lesz. A merge.ts tükre.
    static func isGone(_ s: SyncSite) -> Bool {
        let g = loosensOf(s.goneLoosens)
        return g > 0 && loosensOf(s.deleteLoosens) == g && s.pendingDeleteAt != nil
    }

    /// Ennél több halott rekordot nem hordunk: a legutóbb töröltek maradnak.
    static let maxGoneSites = 64

    /// A végigment törlés SÍRKÖVE: a rekord, a kérés számlálójával megjelölve.
    /// Csak kifizetett — számlálós — törlésnek van; a rekord minden mezője
    /// marad (ha egy visszavonás feltámasztja, a menetrendje ne vesszen el).
    static func tombstoneOf(_ s: SyncSite) -> SyncSite? {
        let del = loosensOf(s.deleteLoosens)
        guard del > 0, s.pendingDeleteAt != nil else { return nil }
        var out = s
        out.goneLoosens = del
        return out
    }

    /// Esedékes-e a törlés EZEN az eszközön: vár, és a határideje itt lejárt.
    private static func isDue(_ s: SyncSite, _ now: Double) -> Bool {
        guard let at = s.pendingDeleteAt else { return false }
        return at <= now
    }

    /// A beérkezett lista előkészítése ezen az eszközön, a fésülés ELŐTT: ami
    /// nincs a helyi tiltólistán, és a törlése itt már esedékes, az itt
    /// végrehajtott törlés — kifizetett kérésnél sírkő lesz belőle. Sírkőként
    /// kimarad a domain szerinti összevonásból. A merge.ts tükre.
    static func settleIncoming(_ incoming: [SyncSite], _ localIds: Set<String>, _ now: Double) -> [SyncSite] {
        incoming.map { s in
            if localIds.contains(s.id) || !isDue(s, now) || isGone(s) { return s }
            return tombstoneOf(s) ?? s
        }
    }

    /// A fésült lista szétosztása ezen az eszközön. A helyi rekord a listán
    /// marad (a sorsát a bíró dönti el), és az is, ami itt még nem esedékes (a
    /// saját határidejéig tilt); az esedékes halott a sírkövek közé kerül; az
    /// esedékes, számlálós, nem halott a listára (a bíró végrehajtja); a
    /// számláló nélküli, régi végigment törlés egyik közé sem. A merge.ts tükre.
    static func splitMerged(_ merged: [SyncSite], _ localIds: Set<String>, _ now: Double) -> (sites: [SyncSite], gone: [SyncSite]) {
        var sites: [SyncSite] = []
        var gone: [SyncSite] = []
        for m in merged {
            if localIds.contains(m.id) || !isDue(m, now) {
                sites.append(m)
            } else if isGone(m) {
                gone.append(m)
            } else if loosensOf(m.deleteLoosens) > 0 {
                sites.append(m)
            }
        }
        return (sites: sites, gone: gone)
    }

    /// A sírkövek sorrendje és plafonja: a legkésőbbi határidejűek maradnak,
    /// holtversenyben azonosító szerint (kódegység — mint a gépen). A helyi
    /// sírkövekre is ez áll.
    static func capGone<T>(_ gone: [T], id: (T) -> String, pending: (T) -> Double?) -> [T] {
        let sorted = gone.sorted { x, y in
            let px = pending(x) ?? 0
            let py = pending(y) ?? 0
            if px != py { return px > py }
            return TextLogic.utf16Less(id(x), id(y))
        }
        return Array(sorted.prefix(maxGoneSites))
    }

    /// Két lista összefésülése.
    ///
    /// Ami csak az egyik oldalon van, bekerül — ez SZIGORÍTÁS. Egy hiányzó
    /// rekord SOSEM jelent törlést: különben elég lenne egy üres fiókkal
    /// belépni, és a lista eltűnne.
    ///
    /// A végigment törlés HALOTT rekordként marad (`isGone`): azonosító szerint
    /// ugyanúgy fésülődik, mint az élők, csak utána dől el, melyik él. A domain
    /// szerinti összevonás csak az élőkre áll; a halottak a végén, plafonnal
    /// (`maxGoneSites`). A merge.ts tükre.
    static func mergeLists(_ local: [SyncSite], _ incoming: [SyncSite]) -> [SyncSite] {
        var byId: [String: SyncSite] = [:]
        for s in local { byId[s.id] = s }
        for s in incoming {
            byId[s.id] = byId[s.id].map { mergeSite($0, s) } ?? s
        }
        let gone = capGone(byId.values.filter { isGone($0) }, id: { $0.id }, pending: { $0.pendingDeleteAt })
        // Ugyanaz a domain kétszer, két eszközről külön felvéve: egy rekordba
        // fésüljük. Enélkül két sorban ugyanaz állna, és az egyiket feloldva a
        // felhasználó azt hinné, feloldotta.
        var byDomain: [String: SyncSite] = [:]
        for s in byId.values.filter({ !isGone($0) }).sorted(by: sortKey) {
            guard let mine = byDomain[s.domain] else { byDomain[s.domain] = s; continue }
            let keep = mine.addedAt <= s.addedAt ? mine : s
            let dropOriginal = keep.id == mine.id ? s : mine
            var drop = dropOriginal
            drop.id = keep.id
            var merged = mergeSite(keep, drop)
            merged.id = keep.id
            merged.addedAt = min(keep.addedAt, dropOriginal.addedAt)
            // A hosztneveket EGYESÍTJÜK: az egyesítés a szigorúbb. Csak a JEL
            // NÉLKÜLI nevekre: a jelesről a mergeSite már döntött.
            let marks = merged.hostnameMarks ?? [:]
            let extra = (keep.hostnames + dropOriginal.hostnames).filter { marks[$0] == nil }
            merged.hostnames = Array(Set(merged.hostnames + extra)).sorted()
            byDomain[s.domain] = merged
        }
        return byDomain.values.sorted(by: sortKey) + gone.sorted(by: sortKey)
    }

    /// Stabil sorrend: minden eszközön ugyanaz a lista, ugyanabban a sorrendben.
    private static func sortKey(_ a: SyncSite, _ b: SyncSite) -> Bool {
        if a.addedAt != b.addedAt { return a.addedAt < b.addedAt }
        return a.id < b.id
    }

    /// A kívülről jött rekordok szűrése: a domain és a hosztnevek ugyanazon a
    /// szűrőn, mint a helyben felvett oldal. Ami nem hosztnév-alakú, az nem a
    /// másik mag írása, hanem szemét — a gépen ezek a nevek a root-tulajdonú
    /// hosts fájlba mennek. A rossz domainű rekord egészében kimarad.
    /// A dróton jött oldal-lista: REKORDONKÉNT tűrve — egy rossz rekord kiesik,
    /// a többi marad, mint a gépen és Androidon. Eddig egyetlen rossz rekord
    /// az egész listát vitte, a kör üresnek látta a kiszolgálót, és a saját
    /// listáját tolta fel a többiek helyett. Nil, ha a szöveg nem JSON (a gép
    /// és az Android ilyenkor megáll — itt is); ha JSON, de nem lista, üres.
    static func sitesFromJson(_ text: String) -> [SyncSite]? {
        guard let top = try? JSONDecoder().decode(Lossy<[Lossy<SyncSite>]>.self, from: Data(text.utf8)) else {
            return nil
        }
        return cleanIncoming((top.value ?? []).compactMap { $0.value })
    }

    /// Kanonikus-e egy dróton jött szabály: hoszt-alakú hoszt, `/`-rel kezdődő,
    /// legfeljebb 512 egységnyi, szóköz nélküli út — a gép `cleanRules`-a.
    static func isWireRule(_ r: UrlRules.UrlRule) -> Bool {
        Blocklist.isCanonicalHostname(r.host) && r.path.hasPrefix("/") && r.path.utf16.count <= 512
            && !r.path.unicodeScalars.contains(where: TextLogic.isSpace)
    }

    static func cleanIncoming(_ sites: [SyncSite]) -> [SyncSite] {
        sites.compactMap { s in
            guard !s.id.isEmpty, Blocklist.isCanonicalHostname(s.domain) else { return nil }
            var copy = s
            var seen = Set<String>()
            copy.hostnames = s.hostnames.filter { h in
                guard Blocklist.isCanonicalHostname(h), !seen.contains(h) else { return false }
                seen.insert(h)
                return true
            }
            return copy
        }
    }

}
