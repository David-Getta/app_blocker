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
            try c.encodeIfPresent(rules, forKey: .rules)
            try c.encode(rev, forKey: .rev)
            try c.encode(updatedAt, forKey: .updatedAt)
            try c.encode(updatedBy, forKey: .updatedBy)
        }
    }

    // MARK: - szigorúság

    /// Hány percet tilt a menetrend egy héten (0…10080).
    ///
    /// SZERKEZET szerint néz, nem időbélyeg szerint: két eszköz lehet más
    /// időzónában, és akkor ugyanaz a két menetrend máshogy hasonlítana össze a
    /// két gépen — a szinkron sosem konvergálna.
    static func blockedMinutesPerWeek(_ s: ScheduleLogic.Schedule?) -> Int {
        let sch = ScheduleLogic.normalize(s)
        if sch.mode == .always { return 7 * 1440 }
        var n = 0
        for day in 0..<7 {
            for minute in 0..<1440 where blocksAtGrid(sch, day, minute) { n += 1 }
        }
        return n
    }

    private static func blocksAtGrid(_ sch: ScheduleLogic.Schedule, _ day: Int, _ minute: Int) -> Bool {
        let inBand = anyBandAtGrid(sch.bands, day, minute)
        return sch.mode == .block ? inBand : !inBand
    }

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

    /// Melyik rekord szigorúbb: -1 = `a`, 1 = `b`, 0 = egyforma.
    ///
    /// A mezők sorrendje számít: az első különbség dönt, és a nyertes rekord
    /// EGYBEN marad — az eredmény mindig olyan állapot, ami tényleg létezett
    /// valamelyik eszközön.
    static func compareStrictness(_ a: SyncSite, _ b: SyncSite) -> Int {
        let aDel = a.pendingDeleteAt != nil
        let bDel = b.pendingDeleteAt != nil
        if aDel != bDel { return aDel ? 1 : -1 }

        let aMin = blockedMinutesPerWeek(a.schedule)
        let bMin = blockedMinutesPerWeek(b.schedule)
        if aMin != bMin { return aMin > bMin ? -1 : 1 }

        let aLim = a.dailyLimitSeconds ?? .greatestFiniteMagnitude
        let bLim = b.dailyLimitSeconds ?? .greatestFiniteMagnitude
        if aLim != bLim { return aLim < bLim ? -1 : 1 }

        // Adag-szabály: kisebb adag szigorúbb; azonos adagnál a hosszabb
        // szünet. A fél-kitöltött (csak egyik mező) nem szabály.
        let aHasB = (a.burstSeconds ?? 0) > 0 && (a.cooldownSeconds ?? 0) > 0
        let bHasB = (b.burstSeconds ?? 0) > 0 && (b.cooldownSeconds ?? 0) > 0
        let aBurst = aHasB ? a.burstSeconds! : .greatestFiniteMagnitude
        let bBurst = bHasB ? b.burstSeconds! : .greatestFiniteMagnitude
        if aBurst != bBurst { return aBurst < bBurst ? -1 : 1 }
        let aCool = aHasB ? a.cooldownSeconds! : 0
        let bCool = bHasB ? b.cooldownSeconds! : 0
        if aCool != bCool { return aCool > bCool ? -1 : 1 }

        return 0
    }

    // MARK: - összefésülés

    /// Két azonos azonosítójú rekord összefésülése. Szimmetrikus.
    static func mergeSite(_ a: SyncSite, _ b: SyncSite) -> SyncSite {
        if a.rev != b.rev {
            let newer = a.rev > b.rev ? a : b
            let older = a.rev > b.rev ? b : a
            return withRules(carryPendingDelete(newer, older), a, b)
        }
        let strict = compareStrictness(a, b)
        if strict != 0 {
            return withHostnames(withRules(strict < 0 ? carryPendingDelete(a, b) : carryPendingDelete(b, a), a, b), a, b)
        }
        let winner: SyncSite
        if a.updatedAt != b.updatedAt { winner = a.updatedAt > b.updatedAt ? a : b }
        else { winner = a.updatedBy <= b.updatedBy ? a : b }
        return withHostnames(withRules(winner, a, b), a, b)
    }

    /// Egyenlő revnél a hosztnevek EGYESÜLNEK: a lista a tiltás része, egy név
    /// levétele lazítás, ami csak rev-emeléssel mehet át — egy versenyhelyzet
    /// sosem oldhat fel semmit. Rendezve, hogy két eszköz ugyanazt kapja. A
    /// TypeScript- és Kotlin-tükör ugyanezt teszi (merge.ts withHostnames).
    private static func withHostnames(_ merged: SyncSite, _ a: SyncSite, _ b: SyncSite) -> SyncSite {
        var out = merged
        out.hostnames = Array(Set(a.hostnames + b.hostnames)).sorted()
        return out
    }

    private static func withRules(_ winner: SyncSite, _ a: SyncSite, _ b: SyncSite) -> SyncSite {
        var out = winner
        out.rules = mergeRules(a, b)
        return out
    }

    /// A részleges szabályok összefésülése — a rekord többi mezőjétől KÜLÖN.
    ///
    /// Miért nem elég a nyertes rekord szabálylistája:
    ///
    ///  1. **Egyenlő revnél EGYESÍTÜNK.** A szabály tisztán hozzáadás: felvenni
    ///     szigorítás. Ha ilyenkor egy egész listát választanánk, két eszközön
    ///     egyszerre felvett két szabályból az egyik némán elveszne.
    ///  2. **Nagyobb rev nyer** — ott van mögötte a próbatétel, tehát az
    ///     eltávolítás is átmegy. Egyesítés itt feltámasztaná a kifizetett
    ///     törlést.
    ///  3. **A `nil` NEM ugyanaz, mint a `[]`.** Egy RÉGI app-verzió nem ismeri
    ///     ezt a mezőt: ami átmegy rajta, abból eltűnik. Ha a hiányt mindenestül
    ///     törlésnek vennénk, elég lenne egy frissítetlen eszköz a fiókban, és a
    ///     gépen felvett összes szabály csendben eltűnne.
    private static func mergeRules(_ a: SyncSite, _ b: SyncSite) -> [UrlRules.UrlRule]? {
        let ar = cleanRules(a.rules)
        let br = cleanRules(b.rules)
        guard let ar = ar else { return br }
        guard let br = br else { return ar }
        if a.rev == b.rev { return unionRules(ar, br) }
        return a.rev > b.rev ? ar : br
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

    private static func unionRules(
        _ a: [UrlRules.UrlRule], _ b: [UrlRules.UrlRule]
    ) -> [UrlRules.UrlRule] {
        var out = a
        for r in b {
            if out.contains(where: { UrlRules.sameRule($0, r) }) { continue }
            if out.count >= UrlRules.maxRulesPerSite { break }
            out.append(r)
        }
        // Stabil sorrend, hogy két eszköz bájtra ugyanazt a listát kapja —
        // különben örökké oda-vissza írnák egymást, mert a tartalom „változott”.
        return out.sorted { $0.host + $0.path < $1.host + $1.path }
    }

    /// A törlésre várás nem tűnhet el csendben — a türelmi idővel együtt megy át.
    private static func carryPendingDelete(_ winner: SyncSite, _ loser: SyncSite) -> SyncSite {
        guard let loserDelete = loser.pendingDeleteAt else { return winner }
        if let winnerDelete = winner.pendingDeleteAt {
            let at = min(winnerDelete, loserDelete)
            if at == winnerDelete { return winner }
            var out = winner
            out.pendingDeleteAt = at
            return out
        }
        if winner.rev > loser.rev { return winner } // egy későbbi körben visszavonták
        var out = winner
        out.pendingDeleteAt = loserDelete
        return out
    }

    /// Két lista összefésülése.
    ///
    /// Ami csak az egyik oldalon van, bekerül — ez SZIGORÍTÁS. Egy hiányzó
    /// rekord SOSEM jelent törlést: különben elég lenne egy üres fiókkal
    /// belépni, és a lista eltűnne.
    static func mergeLists(_ local: [SyncSite], _ incoming: [SyncSite]) -> [SyncSite] {
        var byId: [String: SyncSite] = [:]
        for s in local { byId[s.id] = s }
        for s in incoming {
            byId[s.id] = byId[s.id].map { mergeSite($0, s) } ?? s
        }
        // Ugyanaz a domain kétszer, két eszközről külön felvéve: egy rekordba
        // fésüljük. Enélkül két sorban ugyanaz állna, és az egyiket feloldva a
        // felhasználó azt hinné, feloldotta.
        var byDomain: [String: SyncSite] = [:]
        for s in byId.values.sorted(by: sortKey) {
            guard let mine = byDomain[s.domain] else { byDomain[s.domain] = s; continue }
            let keep = mine.addedAt <= s.addedAt ? mine : s
            let dropOriginal = keep.id == mine.id ? s : mine
            var drop = dropOriginal
            drop.id = keep.id
            var merged = mergeSite(keep, drop)
            merged.id = keep.id
            merged.addedAt = min(keep.addedAt, dropOriginal.addedAt)
            // A hosztneveket EGYESÍTJÜK: az egyesítés a szigorúbb.
            merged.hostnames = Array(Set(keep.hostnames + dropOriginal.hostnames)).sorted()
            byDomain[s.domain] = merged
        }
        return byDomain.values.sorted(by: sortKey)
    }

    /// Stabil sorrend: minden eszközön ugyanaz a lista, ugyanabban a sorrendben.
    private static func sortKey(_ a: SyncSite, _ b: SyncSite) -> Bool {
        if a.addedAt != b.addedAt { return a.addedAt < b.addedAt }
        return a.id < b.id
    }
}
