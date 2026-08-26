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
        /// A LEZÁRULT menetek naplója — ebből lesz a statisztika.
        ///
        /// Szándékosan MÁS a szabálya, mint a fenti kettőnek. A csomagok és a
        /// futás ENGEDÉLYEK: azt mondják meg, mi történhet, tehát rájuk
        /// vonatkozik a súrlódás iránya, és a `rev` őrzi őket. A napló a MÚLT
        /// feljegyzése: nem enged meg semmit, és egy elveszett sora nem kibúvó,
        /// csak pontatlan statisztika.
        ///
        /// Ezért a napló EGYESÍTÉS, nem döntés. Aki egységesíteni akarja a
        /// hármat, ezt olvassa el előbb: a `rev` léptetése egy naplósorért azt
        /// jelentené, hogy egy statisztika-bejegyzés le tud állítani egy futó
        /// menetet a másik eszközön.
        public var log: [Focus.LogEntry]
        public var rev: Double
        public var updatedAt: Double
        public var updatedBy: String

        public init(
            packs: [Focus.Pack] = [], run: Focus.Run? = nil, log: [Focus.LogEntry] = [],
            rev: Double = 0, updatedAt: Double = 0, updatedBy: String = ""
        ) {
            self.packs = packs
            self.run = run
            self.log = log
            self.rev = rev
            self.updatedAt = updatedAt
            self.updatedBy = updatedBy
        }

        /// SAJÁT dekódolás, mert a `log` mező RÉGEBBI blobokból hiányzik.
        ///
        /// A Swift automatikus `Codable`-ja a hiányzó kulcsra hibát DOB — a
        /// mező alapértéke ilyenkor nem lép életbe. Egy még nem frissült gép
        /// blobja tehát az egész munkamenet-szinkront megölné: a telefon üres
        /// állapotra esne vissza, és a felhasználó azt látná, hogy a csomagjai
        /// eltűntek. Ugyanez vár minden ezután hozzáadott mezőre.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            packs = try c.decodeIfPresent([Focus.Pack].self, forKey: .packs) ?? []
            run = try c.decodeIfPresent(Focus.Run.self, forKey: .run)
            log = try c.decodeIfPresent([Focus.LogEntry].self, forKey: .log) ?? []
            rev = try c.decodeIfPresent(Double.self, forKey: .rev) ?? 0
            updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt) ?? 0
            updatedBy = try c.decodeIfPresent(String.self, forKey: .updatedBy) ?? ""
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
            // EGYESÍTÉS, nem választás: lásd a `log` mező magyarázatát.
            log: mergeLog(local.log, incoming.log),
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

    /// Két napló egyesítése.
    ///
    /// A sor AZONOSSÁGA a `packId` + `startedAt` pár. Egyszerre egy menet fut az
    /// egész fiókban, tehát ez a pár egyértelmű — és pont ezért fésülődik össze
    /// helyesen az a gyakori eset, amikor UGYANAZT a menetet két eszköz is
    /// lezárja: a telefon próbatétellel, a gép meg később, a szinkronból véve
    /// észre. Enélkül minden ilyen menet kettőnek számítana.
    ///
    /// Ütközésnél a KORÁBBI vég nyer, mert az van közelebb a valósághoz.
    /// Azonos végnél a próbatételes leállítás — azt az egyik oldal láthatta,
    /// a másik nem.
    public static func mergeLog(
        _ a: [Focus.LogEntry], _ b: [Focus.LogEntry]
    ) -> [Focus.LogEntry] {
        var byKey: [String: Focus.LogEntry] = [:]
        for e in a + b {
            let key = "\(e.packId)|\(e.startedAt)"
            byKey[key] = byKey[key].map { better($0, e) } ?? e
        }
        return capLog(Array(byKey.values))
    }

    private static func better(_ x: Focus.LogEntry, _ y: Focus.LogEntry) -> Focus.LogEntry {
        if x.endedAt != y.endedAt { return x.endedAt < y.endedAt ? x : y }
        if x.stopped != y.stopped { return x.stopped ? x : y }
        return x
    }

    /// Idősorrend, és a LEGÚJABBAK maradnak.
    ///
    /// A statisztika a mai napot és a hetet nézi; ha valamit el kell dobni, az a
    /// legrégebbi sor. Fordítva a mai menetek esnének ki, és pont az a képernyő
    /// lenne üres, amit a felhasználó néz.
    public static func capLog(_ rows: [Focus.LogEntry]) -> [Focus.LogEntry] {
        rows.sorted {
            $0.endedAt != $1.endedAt ? $0.endedAt < $1.endedAt : $0.packId < $1.packId
        }.suffix(Focus.maxFocusLog).map { $0 }
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
        // A NAPLÓ IS BENNE VAN — enélkül egy itt lezárult menet sosem érne fel
        // a kiszolgálóra: a kör azt látná, hogy „nincs mit feltölteni”.
        let log = f.log.map {
            "\($0.packId);\($0.startedAt);\($0.endedAt);\($0.plannedEndsAt);\($0.stopped)"
        }.joined(separator: "|")
        return "\(packs)//\(run)//\(log)//\(f.rev)"
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
            // A naplót NEM kötjük a csomagokhoz: egy menet naplósora akkor is
            // igaz marad, ha a csomagot azóta törölték. Épp ezért van benne a
            // NÉV is, nem csak az azonosító.
            log: capLog(raw.log),
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
