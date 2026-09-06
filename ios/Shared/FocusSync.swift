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
        let run = mergeRun(local, incoming)
        let (packs, packMarks) = mergePacks(newer, older, runPackId: run?.packId)
        return SyncFocus(
            packs: packs,
            run: run,
            // EGYESÍTÉS, nem választás: lásd a `log` mező magyarázatát.
            log: mergeLog(local.log, incoming.log),
            rev: max(local.rev, incoming.rev),
            // Az idő a GYŐZTESÉ, nem a nagyobb: az eredmény kulcsa így az újabb
            // blobé, és három eszköz bármilyen sorrendben ugyanoda jut.
            updatedAt: newer.updatedAt,
            updatedBy: newer.updatedBy,
            packMarks: packMarks
        )
    }

    /// Egyenlő jelű két változat közül melyik: az ablakos, aztán a szűkebb
    /// lista, végül a tartalom kulcsa szerint — a két változatból, nem a
    /// hordozó blobból. A focus-merge.ts `preferPack` tükre.
    private static func preferPack(_ x: Focus.Pack, _ y: Focus.Pack) -> Focus.Pack {
        let rx = x.recurrence != nil ? 1 : 0
        let ry = y.recurrence != nil ? 1 : 0
        if rx != ry { return rx > ry ? x : y }
        let nx = x.allowSites.count + x.allowApps.count
        let ny = y.allowSites.count + y.allowApps.count
        if nx != ny { return nx < ny ? x : y }
        // UTF-16 szerint, mint a gép és az Android — a Swift `<` máshogy dőlne
        // nem-BMP karakternél.
        return utf16Less(packOrderKey(y), packOrderKey(x)) ? y : x
    }

    /// A változat kulcsa a sorrendhez — bájtra ugyanez a három nyelvben.
    private static func packOrderKey(_ p: Focus.Pack) -> String {
        // Lépésenként, kimondott típussal: a `+`-lánc egy `map` lezárásában a
        // fordítónak túl sok volt (unable to type-check in reasonable time).
        var rec = ""
        if let b = p.recurrence {
            let days: [String] = b.days.sorted().map { String($0) }
            rec = "\(days.joined(separator: ","))/\(b.startMin)/\(b.endMin)"
        }
        let fields: [String] = [
            p.name, String(p.defaultMinutes),
            p.allowSites.sorted().joined(separator: ","),
            p.allowApps.sorted().joined(separator: ","),
            rec,
        ]
        return fields.joined(separator: "\u{1}")
    }

    /// Melyik oldal FRISSEBB. Sorrend: `rev`, majd idő, majd eszközazonosító.
    ///
    /// Az azonosító nem esztétika: ez teszi a döntést determinisztikussá.
    /// Enélkül két eszköz ugyanabban a másodpercben írva örökké oda-vissza
    /// cserélgetné a listát.
    private static func firstIsNewer(_ a: SyncFocus, _ b: SyncFocus) -> Bool {
        if a.rev != b.rev { return a.rev > b.rev }
        if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt }
        if a.updatedBy != b.updatedBy { return utf16Less(b.updatedBy, a.updatedBy) }
        // AZONOS KULCS, más tartalom: egy fésülés után minden eszköz a győztes
        // kulcsát veszi át, a tartalma viszont a saját fésülése. Ha az első
        // argumentum nyerne, két eszköz örökké egymást írná felül. A TARTALOM
        // dönt, ugyanazzal a kulccsal mindhárom nyelvben.
        return !utf16Less(contentKey(b), contentKey(a))
    }

    /// UTF-16 kódegységek szerinti rendezés — a JavaScript és a Kotlin így
    /// hasonlít; a Swift `<` Unicode-skalár és kanonikus egyezés szerint, ami
    /// nem-BMP vagy bontott ékezetes névnél máshogy dőlne, és a gép meg az
    /// iPhone örökké egymást választaná.
    static func utf16Less(_ a: String, _ b: String) -> Bool {
        a.utf16.lexicographicallyPrecedes(b.utf16)
    }

    /// Egész szám úgy, ahogy a gép írja („150”, nem „150.0”).
    private static func intString(_ d: Double) -> String {
        d.isFinite ? String(format: "%.0f", d) : "0"
    }

    /// A blob tartalmának kulcsa a döntetlenhez — bájtra ugyanez a három nyelvben.
    private static func contentKey(_ f: SyncFocus) -> String {
        let packParts: [String] = f.packs.sorted { utf16Less($0.id, $1.id) }
            .map { p -> String in "\(p.id)\u{1}\(packOrderKey(p))" }
        let packs: String = packParts.joined(separator: "\u{2}")
        let run: String = f.run.map { "\($0.packId)/\(intString($0.startedAt))/\(intString($0.endsAt))" } ?? "-"
        let markParts: [String] = (f.packMarks ?? [:]).sorted { utf16Less($0.key, $1.key) }
            .map { "\($0.key)=\($0.value)" }
        let marks: String = markParts.joined(separator: ",")
        return "\(packs)\u{3}\(run)\u{3}\(marks)"
    }

    /// A csomagok CSOMAGONKÉNT fésülődnek, a jelük szerint: a nagyobb jelnél
    /// álló állapot (ez a változat, vagy nincs) marad; egyenlő jelnél (a jel
    /// nélküli csomag is ilyen) az újabb blob állapota, ahogy eddig. A sorrend
    /// az újabb blobé, a csak a régebbin élő csomagok a végére. Az iPhone
    /// jelet nem ír, csak hordozza és fésüli. A merge.ts `mergePacks` tükre.
    private static func mergePacks(
        _ newer: SyncFocus, _ older: SyncFocus, runPackId: String?
    ) -> ([Focus.Pack], [String: Int]?) {
        let en = effectiveMarks(newer)
        let eo = effectiveMarks(older)
        let rn = newer.packMarks ?? [:]
        let ro = older.packMarks ?? [:]
        // A MENET CSOMAGJA ELÖL: a 30-as plafon vágásából sem eshet ki.
        var ids: [String] = []
        let candidates = (runPackId.map { [$0] } ?? []) + newer.packs.map { $0.id } + older.packs.map { $0.id }
            + Array(en.keys).sorted() + Array(eo.keys).sorted()
        for id in candidates where !ids.contains(id) { ids.append(id) }
        var chosen: [(pack: Focus.Pack, marked: Bool)] = []
        var marks: [String: Int] = [:]
        for id in ids {
            let mn = en[id] ?? 0
            let mo = eo[id] ?? 0
            let pn = newer.packs.first { $0.id == id }
            let po = older.packs.first { $0.id == id }
            // Egyenlő POZITÍV jelnél a jelenlét nyer; két változat közül a
            // VALÓDI jel dönt (a szerkesztés erősebb a menet indításánál),
            // egyenlő valódi jelnél a `preferPack`; jel nélkül az újabb blob.
            let pick: Focus.Pack?
            if mo > mn { pick = po }
            else if mn > mo { pick = pn }
            else if mn > 0 {
                if let a = pn, let b = po {
                    let vn = rn[id] ?? 0
                    let vo = ro[id] ?? 0
                    pick = vn != vo ? (vn > vo ? a : b) : preferPack(a, b)
                } else { pick = pn ?? po }
            } else { pick = pn }
            if let p = pick { chosen.append((pack: p, marked: id == runPackId || max(mn, mo) > 0)) }
            if max(mn, mo) > 0 { marks[id] = max(mn, mo) }
        }
        let packs = capPacks(chosen)
        // Ugyanaz a plafon, mint a bemeneten — különben a három hely három
        // listát tartana, és sosem érnének össze.
        return (packs, capPackMarks(marks, packs.map { $0.id }))
    }

    /// A csomagok plafonja (30): a JELES csomag (és a menet csomagja) marad, a
    /// jel nélküli esik ki előbb; a sorrend a fésülésé. A focus-merge.ts
    /// `capPacks` tükre.
    private static func capPacks(_ chosen: [(pack: Focus.Pack, marked: Bool)]) -> [Focus.Pack] {
        if chosen.count <= maxPacks { return chosen.map { $0.pack } }
        var keep = Set<String>()
        for c in chosen where c.marked && keep.count < maxPacks { keep.insert(c.pack.id) }
        for c in chosen where !c.marked && keep.count < maxPacks { keep.insert(c.pack.id) }
        return chosen.filter { keep.contains($0.pack.id) }.map { $0.pack }
    }

    /// A blob HATÁSOS jelei: a jelei, és a futó menet csomagján legalább a
    /// blob `rev`-je. A menet és a csomagja együtt jár: a törlés jele nem
    /// viheti el a csomagot, amíg a másik eszközön menet fut rajta — csomag
    /// nélküli menetet a fogadó eldobna, a menetet tartó eszköz meg minden
    /// körben újra feltöltené. A sírkő csak akkor nyer, ha a jele nagyobb a
    /// menetes blob rev-jénél, de akkor a másik blob rev-je is nagyobb, és a
    /// menet is elveszett volna. A focus-merge.ts `effectiveMarks` tükre.
    private static func effectiveMarks(_ f: SyncFocus) -> [String: Int] {
        var marks = f.packMarks ?? [:]
        let rev = revInt(f.rev)
        guard let run = f.run, rev > 0, f.packs.contains(where: { $0.id == run.packId }) else { return marks }
        marks[run.packId] = max(marks[run.packId] ?? 0, rev)
        return marks
    }

    /// A blob rev-je egész számként — kívülről jött érték, tehát NEM
    /// `Int(double)`: egy NaN vagy egy óriás szám azzal elvinné az appot.
    private static func revInt(_ rev: Double) -> Int {
        guard rev.isFinite, rev > 0, rev < 2_000_000_000 else { return 0 }
        return Int(rev)
    }

    /// Ennél több csomag-jelet nem hordunk egy blobban. Szándékosan magas: egy
    /// eldobott sírkő feltámaszthatja a csomagot a másik eszközön, tehát a
    /// vágás nem lehet mindennapos — 256 jel több mint kétszáz valaha törölt
    /// csomag, a lista maga 30-as.
    static let maxPackMarks = 256

    /// A jelek plafonja — EGY szabály a fésülésre és a bemenetre: a jelen
    /// lévő csomagok jele mindig marad, a törölt csomagokéból a legnagyobb
    /// jelűek férnek be, holtversenyben az azonosító szerint. Üresen nil.
    /// A focus-merge.ts `capPackMarks` tükre.
    static func capPackMarks(_ marks: [String: Int], _ presentIds: [String]) -> [String: Int]? {
        if marks.isEmpty { return nil }
        if marks.count <= maxPackMarks { return marks }
        let present = Set(presentIds)
        var out: [String: Int] = [:]
        for (id, v) in marks where present.contains(id) { out[id] = v }
        let gone = marks.filter { !present.contains($0.key) }
            .sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
        for (id, v) in gone {
            if out.count >= maxPackMarks { break }
            out[id] = v
        }
        return out
    }

    /// A FUTÓ munkamenet összefésülése — a kockázatos fele.
    ///
    /// Egy régi, „nem fut” állapot visszajátszása nem kapcsol ki semmit; egy
    /// hosszabbítás viszont próbatétel nélkül is átmegy. Azonos rev-nél a
    /// szigorúbb nyer, TELJES rendezéssel: a később végződő, azonos lejáratnál
    /// a korábban indult, ha az is egyezik, a kisebb csomagazonosítójú — így
    /// nem az nyer, amelyik előbb ért a kiszolgálóra, és három eszköz
    /// bármilyen sorrendben ugyanoda jut.
    private static func mergeRun(_ a: SyncFocus, _ b: SyncFocus) -> Focus.Run? {
        if a.rev != b.rev { return (a.rev > b.rev ? a : b).run }
        guard let ar = a.run else { return b.run }
        guard let br = b.run else { return ar }
        return stricterRun(ar, br)
    }

    /// A szigorúbb menet, teljes rendezéssel — döntetlen nincs.
    private static func stricterRun(_ x: Focus.Run, _ y: Focus.Run) -> Focus.Run {
        if x.endsAt != y.endsAt { return x.endsAt > y.endsAt ? x : y }
        if x.startedAt != y.startedAt { return x.startedAt < y.startedAt ? x : y }
        return x.packId <= y.packId ? x : y
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
        let ordered: [Focus.LogEntry] = rows.sorted { a, b in
            if a.endedAt != b.endedAt { return a.endedAt < b.endedAt }
            if a.packId != b.packId { return a.packId < b.packId }
            return a.startedAt < b.startedAt
        }
        return Array(ordered.suffix(Focus.maxFocusLog))
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

    /// A csomag-jelek kiegyenesítése: csak azonosító → pozitív egész, legfeljebb
    /// a blob `rev`-je (a jel annak a blobnak a rev-je, amelyik írta), a
    /// plafonnal (a jelen lévő csomagok jele marad). Üresen nil.
    static func cleanMarks(_ raw: [String: Int]?, presentIds: [String], maxRev: Int) -> [String: Int]? {
        guard let raw else { return nil }
        var out: [String: Int] = [:]
        for (k, v) in raw where !k.isEmpty && v > 0 && v <= maxRev { out[k] = v }
        return capPackMarks(out, presentIds)
    }

    /// Egy kívülről jött blob használható alakja.
    ///
    /// Ami nem értelmezhető, az kiesik — de a blob EGÉSZE nem hasalhat el
    /// egyetlen rossz csomagtól, mert akkor egy elrontott sor a FUTÓ menetet is
    /// eltüntetné, és a felhasználó azt látná, hogy magától kikapcsolt.
    public static func normalize(_ raw: SyncFocus, fallbackDevice: String) -> SyncFocus {
        var packs: [Focus.Pack] = []
        var seenIds: [String] = []
        for p in raw.packs {
            if !p.id.isEmpty { seenIds.append(p.id) }
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
        // A KIESETT csomag jele is kiesik: ami a listán volt, de itt nem
        // értelmezhető (vagy a plafon fölött van), az nem törölt csomag — a
        // jele meg a hiánya együtt sírkőnek látszana, és a csomag mindenhol
        // törlődne. A valódi törlés jele (nincs ilyen csomag a listán) marad.
        let presentIds = packs.map { $0.id }
        let cleaned = cleanMarks(raw.packMarks, presentIds: presentIds, maxRev: revInt(raw.rev))
        let kept = cleaned?.filter { !seenIds.contains($0.key) || presentIds.contains($0.key) }
        return SyncFocus(
            packs: packs,
            run: cleanRun(raw.run, packs: packs),
            // A naplót NEM kötjük a csomagokhoz: egy menet naplósora akkor is
            // igaz marad, ha a csomagot azóta törölték. Épp ezért van benne a
            // NÉV is, nem csak az azonosító.
            log: capLog(raw.log),
            // Nemnegatív egész, mint a gépen és Androidon: egy tört rev-ből
            // tört jel lenne, amit a visszaolvasás eldob.
            rev: Double(revInt(raw.rev)),
            updatedAt: raw.updatedAt,
            updatedBy: raw.updatedBy.isEmpty ? fallbackDevice : raw.updatedBy,
            packMarks: (kept?.isEmpty ?? true) ? nil : kept
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
