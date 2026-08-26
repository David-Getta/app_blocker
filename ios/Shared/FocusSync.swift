import Foundation

/// A munkamenet összefésülése két eszköz között —
/// a `desktop/src/shared/sync/focus-merge.ts` tükre.
///
/// Ez a szinkron kockázatos fele. Itt dől el, hogy egy MÁSIK eszköz köre ki
/// tudja-e kapcsolni azt a munkamenetet, amit épp futtatsz — mert ha igen, a
/// leállítás próbatétele megkerülhető: elég két eszköz és egy jól időzített kör.
///
/// A SZABÁLY UGYANAZ, MINT MINDENHOL:
///
///   szigorítás ingyen van, lazítás munkába kerül.
///
/// A munkamenetnél a szigorítás iránya:
///
///   - INDÍTANI és HOSSZABBÍTANI szigorítás  -> azonos `rev` mellett is nyer;
///   - RÖVIDÍTENI és LEÁLLÍTANI lazítás      -> csak NAGYOBB `rev`-vel nyer.
public enum FocusSync {

    /// Legfeljebb ennyi csomag utazhat — a felületen sem fér ki több.
    public static let maxPacks = 30

    public struct SyncFocus: Codable, Equatable {
        public var packs: [Focus.Pack]
        public var run: Focus.Run?
        public var rev: Double
        public var updatedAt: Double
        public var updatedBy: String

        public init(
            packs: [Focus.Pack] = [], run: Focus.Run? = nil,
            rev: Double = 0, updatedAt: Double = 0, updatedBy: String = ""
        ) {
            self.packs = packs
            self.run = run
            self.rev = rev
            self.updatedAt = updatedAt
            self.updatedBy = updatedBy
        }
    }

    /// Két állapot összefésülése.
    ///
    /// A csomagok és a futás KÜLÖN dőlnek el, mert más a szabályuk: a
    /// csomagoknál az utolsó író nyer (ez beállítás — egy régi lista
    /// visszatérése bosszantó, de nem kibúvó), a futásnál a szigorúbb.
    public static func merge(_ local: SyncFocus, _ incoming: SyncFocus) -> SyncFocus {
        let newer = pickNewer(local, incoming)
        return SyncFocus(
            packs: newer.packs,
            run: mergeRun(local, incoming),
            rev: max(local.rev, incoming.rev),
            updatedAt: max(local.updatedAt, incoming.updatedAt),
            updatedBy: newer.updatedBy
        )
    }

    /// Melyik oldal FRISSEBB. Sorrend: `rev`, majd idő, majd eszközazonosító.
    ///
    /// Az azonosító nem esztétika: ez teszi a döntést determinisztikussá.
    /// Enélkül két eszköz ugyanabban a másodpercben írva örökké oda-vissza
    /// cserélgetné a listát.
    private static func pickNewer(_ a: SyncFocus, _ b: SyncFocus) -> SyncFocus {
        if a.rev != b.rev { return a.rev > b.rev ? a : b }
        if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt ? a : b }
        return a.updatedBy >= b.updatedBy ? a : b
    }

    /// A FUTÓ munkamenet összefésülése — a kockázatos fele.
    ///
    /// Egy régi, „nem fut” állapot visszajátszása nem kapcsol ki semmit; egy
    /// hosszabbítás viszont próbatétel nélkül is átmegy.
    private static func mergeRun(_ a: SyncFocus, _ b: SyncFocus) -> Focus.Run? {
        if a.rev != b.rev { return (a.rev > b.rev ? a : b).run }
        guard let ar = a.run else { return b.run }
        guard let br = b.run else { return ar }
        return ar.endsAt >= br.endsAt ? ar : br
    }

    /// A futó menet megtisztítása: ha a csomagja nincs meg, eldobjuk.
    ///
    /// Nem tippelünk. A fehérlista TARTALMA nem az a dolog, amit kitalálni
    /// szabad: egy futás ismeretlen csomaggal azt jelentené, hogy tiltunk
    /// mindent, és nem tudjuk megmondani, mi az, ami mehet.
    public static func cleanRun(_ run: Focus.Run?, packs: [Focus.Pack]) -> Focus.Run? {
        guard let run, run.endsAt > 0 else { return nil }
        return packs.contains { $0.id == run.packId } ? run : nil
    }

    /// Ugyanaz-e a két állapot (nincs mit feltölteni).
    public static func same(_ a: SyncFocus, _ b: SyncFocus) -> Bool {
        stable(a) == stable(b)
    }

    private static func stable(_ f: SyncFocus) -> String {
        let packs = f.packs.sorted { $0.id < $1.id }.map { p in
            [
                p.id, p.name,
                p.allowSites.sorted().joined(separator: ","),
                p.allowApps.sorted().joined(separator: ","),
                String(p.defaultMinutes),
            ].joined(separator: ";")
        }.joined(separator: "|")
        let run = f.run.map { "\($0.packId);\($0.startedAt);\($0.endsAt)" } ?? "-"
        return "\(packs)//\(run)//\(f.rev)"
    }

    /// Egy kívülről jött blob használható alakja.
    ///
    /// Ami nem értelmezhető, az kiesik — de a blob EGÉSZE nem hasalhat el
    /// egyetlen rossz csomagtól, mert akkor egy elrontott sor a FUTÓ menetet is
    /// eltüntetné, és a felhasználó azt látná, hogy magától kikapcsolt.
    public static func normalize(_ raw: SyncFocus, fallbackDevice: String) -> SyncFocus {
        var packs: [Focus.Pack] = []
        for p in raw.packs {
            let name = p.name.trimmingCharacters(in: .whitespacesAndNewlines)
            if p.id.isEmpty || name.isEmpty { continue }
            if packs.contains(where: { $0.id == p.id }) || packs.count >= maxPacks { continue }
            packs.append(Focus.Pack(
                id: p.id,
                name: String(name.prefix(Focus.maxPackName)),
                allowSites: normalized(p.allowSites, Focus.normalizeAllowSite),
                allowApps: normalized(p.allowApps, Focus.normalizeAllowApp),
                defaultMinutes: Focus.normalizeMinutes(Double(p.defaultMinutes)) ?? 25
            ))
        }
        return SyncFocus(
            packs: packs,
            run: cleanRun(raw.run, packs: packs),
            rev: raw.rev,
            updatedAt: raw.updatedAt,
            updatedBy: raw.updatedBy.isEmpty ? fallbackDevice : raw.updatedBy
        )
    }

    private static func normalized(_ items: [String], _ f: (String) -> String?) -> [String] {
        var out: [String] = []
        for item in items {
            guard let n = f(item) else { continue }
            if out.contains(n) || out.count >= Focus.maxAllowEntries { continue }
            out.append(n)
        }
        return out
    }
}
