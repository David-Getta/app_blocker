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
        /// A csomagok JELEI: azonosító → a blob rev-je, amelyik a csomagot
        /// utoljára felvette, szerkesztette vagy törölte (a törölt csomag jele
        /// marad, a csomag nincs a listán). Csomagonként a nagyobb jel dönt;
        /// jel nélkül az újabb blob. Az iPhone jelet nem ír. Lásd `mergePacks`.
        public var packMarks: [String: Int]?

        public init(
            packs: [Focus.Pack] = [], run: Focus.Run? = nil, log: [Focus.LogEntry] = [],
            rev: Double = 0, updatedAt: Double = 0, updatedBy: String = "",
            packMarks: [String: Int]? = nil
        ) {
            self.packs = packs
            self.run = run
            self.log = log
            self.rev = rev
            self.updatedAt = updatedAt
            self.updatedBy = updatedBy
            self.packMarks = packMarks
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
            // A jelek TŰRŐEN: egy nem-egész érték ne vigye el az egész blobot.
            packMarks = (try? c.decodeIfPresent([String: Int].self, forKey: .packMarks)) ?? nil
        }
    }

    /// Két állapot összefésülése.
    ///
    /// A csomagok és a futás KÜLÖN dőlnek el, mert más a szabályuk: a
    /// csomagoknál az utolsó író nyer (ez beállítás — egy régi lista
    /// visszatérése bosszantó, de nem kibúvó), a futásnál a szigorúbb.
    public static func merge(_ local: SyncFocus, _ incoming: SyncFocus) -> SyncFocus {
        let localIsNewer = firstIsNewer(local, incoming)
        let newer = localIsNewer ? local : incoming
        let older = localIsNewer ? incoming : local
        let (packs, packMarks) = mergePacks(newer, older)
        return SyncFocus(
            packs: packs,
            run: mergeRun(local, incoming),
            // EGYESÍTÉS, nem választás: lásd a `log` mező magyarázatát.
            log: mergeLog(local.log, incoming.log),
            rev: max(local.rev, incoming.rev),
            updatedAt: max(local.updatedAt, incoming.updatedAt),
            updatedBy: newer.updatedBy,
            packMarks: packMarks
        )
    }

    /// Melyik oldal FRISSEBB. Sorrend: `rev`, majd idő, majd eszközazonosító.
    ///
    /// Az azonosító nem esztétika: ez teszi a döntést determinisztikussá.
    /// Enélkül két eszköz ugyanabban a másodpercben írva örökké oda-vissza
    /// cserélgetné a listát.
    private static func firstIsNewer(_ a: SyncFocus, _ b: SyncFocus) -> Bool {
        if a.rev != b.rev { return a.rev > b.rev }
        if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt }
        return a.updatedBy >= b.updatedBy
    }

    /// A csomagok CSOMAGONKÉNT fésülődnek, a jelük szerint: a nagyobb jelnél
    /// álló állapot (ez a változat, vagy nincs) marad; egyenlő jelnél (a jel
    /// nélküli csomag is ilyen) az újabb blob állapota, ahogy eddig. A sorrend
    /// az újabb blobé, a csak a régebbin élő csomagok a végére. Az iPhone
    /// jelet nem ír, csak hordozza és fésüli. A merge.ts `mergePacks` tükre.
    private static func mergePacks(_ newer: SyncFocus, _ older: SyncFocus) -> ([Focus.Pack], [String: Int]?) {
        let nm = newer.packMarks ?? [:]
        let om = older.packMarks ?? [:]
        var ids: [String] = []
        let candidates = newer.packs.map { $0.id } + older.packs.map { $0.id }
            + Array(nm.keys).sorted() + Array(om.keys).sorted()
        for id in candidates where !ids.contains(id) { ids.append(id) }
        var packs: [Focus.Pack] = []
        var marks: [String: Int] = [:]
        for id in ids {
            let mn = nm[id] ?? 0
            let mo = om[id] ?? 0
            let chosen = mo > mn
                ? older.packs.first { $0.id == id }
                : newer.packs.first { $0.id == id }
            if let p = chosen, packs.count < maxPacks { packs.append(p) }
            if max(mn, mo) > 0 { marks[id] = max(mn, mo) }
        }
        return (packs, marks.isEmpty ? nil : marks)
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

    /// Két változat UGYANARRÓL a menetről — melyik marad.
    ///
    /// TELJES rendezés kell: ha a végén marad döntetlen, a válasz a hívás
    /// sorrendjétől függ, az pedig a két eszközön más. Onnantól ugyanazt a
    /// menetet másképp sorosítják, a `same` örökre „különbözőt” mond, és minden
    /// körben feltöltenek — nem hibás adat, hanem NEM KONVERGÁLÓ szinkron.
    ///
    /// A tervezett vég is holtverseny lehet: az egyik eszköz még a hosszabbítás
    /// előtti tervet ismerte. Ilyenkor a KÉSŐBBI terv marad.
    private static func better(_ x: Focus.LogEntry, _ y: Focus.LogEntry) -> Focus.LogEntry {
        if x.endedAt != y.endedAt { return x.endedAt < y.endedAt ? x : y }
        if x.stopped != y.stopped { return x.stopped ? x : y }
        if x.plannedEndsAt != y.plannedEndsAt {
            return x.plannedEndsAt > y.plannedEndsAt ? x : y
        }
        return x
    }

    /// Idősorrend, és a LEGÚJABBAK maradnak.
    ///
    /// A statisztika a mai napot és a hetet nézi; ha valamit el kell dobni, az a
    /// legrégebbi sor. Fordítva a mai menetek esnének ki, és pont az a képernyő
    /// lenne üres, amit a felhasználó néz.
    public static func capLog(_ rows: [Focus.LogEntry]) -> [Focus.LogEntry] {
        // A `startedAt` a HARMADIK kulcs, és nem díszítés: a `packId` +
        // `startedAt` pár egyedi, tehát ettől lesz a rendezés TELJES. A Swift
        // `sorted` ráadásul nem is ígér stabilitást — eldöntetlen hasonlító
        // mellett a sorrend itt még kevésbé kiszámítható, és a szinkron sosem
        // konvergálna.
        rows.sorted { a, b in
            if a.endedAt != b.endedAt { return a.endedAt < b.endedAt }
            if a.packId != b.packId { return a.packId < b.packId }
            return a.startedAt < b.startedAt
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
                Focus.recurrenceKey(p.recurrence),
            ].joined(separator: ";")
        }.joined(separator: "|")
        let run = f.run.map { "\($0.packId);\($0.startedAt);\($0.endsAt)" } ?? "-"
        // A NAPLÓ IS BENNE VAN — enélkül egy itt lezárult menet sosem érne fel
        // a kiszolgálóra: a kör azt látná, hogy „nincs mit feltölteni”.
        let log = f.log.map {
            "\($0.packId);\($0.startedAt);\($0.endedAt);\($0.plannedEndsAt);\($0.stopped)"
        }.joined(separator: "|")
        // A jelek is: ha csak ők különböznek, akkor is fel kell menniük.
        let marks = (f.packMarks ?? [:]).sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }.joined(separator: ",")
        return "\(packs)//\(run)//\(log)//\(marks)//\(f.rev)"
    }

    /// A csomag-jelek kiegyenesítése: csak azonosító → pozitív egész, legfeljebb 64.
    private static func cleanMarks(_ raw: [String: Int]?) -> [String: Int]? {
        guard let raw else { return nil }
        var out: [String: Int] = [:]
        for (k, v) in raw.sorted(by: { $0.key < $1.key }) where !k.isEmpty && v > 0 {
            out[k] = v
            if out.count >= 64 { break }
        }
        return out.isEmpty ? nil : out
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
                defaultMinutes: Focus.normalizeMinutes(Double(p.defaultMinutes)) ?? 25,
                recurrence: Focus.cleanRecurrence(p.recurrence)
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
            updatedBy: raw.updatedBy.isEmpty ? fallbackDevice : raw.updatedBy,
            packMarks: cleanMarks(raw.packMarks)
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
