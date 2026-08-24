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
        var alias: String?
        var rev: Int
        var updatedAt: Double
        var updatedBy: String
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

        return 0
    }

    // MARK: - összefésülés

    /// Két azonos azonosítójú rekord összefésülése. Szimmetrikus.
    static func mergeSite(_ a: SyncSite, _ b: SyncSite) -> SyncSite {
        if a.rev != b.rev {
            let newer = a.rev > b.rev ? a : b
            let older = a.rev > b.rev ? b : a
            return carryPendingDelete(newer, older)
        }
        let strict = compareStrictness(a, b)
        if strict != 0 {
            return strict < 0 ? carryPendingDelete(a, b) : carryPendingDelete(b, a)
        }
        if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt ? a : b }
        return a.updatedBy <= b.updatedBy ? a : b
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
