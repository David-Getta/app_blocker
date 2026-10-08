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
        /// jel nélkül az újabb blob. Az iPhone jelet csak a saját csomag-
        /// szerkesztésénél ír (SyncRevisions.bumpFocus). Lásd `mergePacks`.
        public var packMarks: [String: Int]?
        /// A ZÁRLAT, ha van. A `rev`-hez SEMMI köze: a fésülése tiszta
        /// magasvízjel, a későbbi vég nyer. A zárlat csak szigorítani tud,
        /// tehát nem kell megvédeni attól, hogy régebbi rekord írja felül.
        /// Lásd Shared/Lockdown.swift.
        public var lockdown: LockdownLogic.Lockdown?
        /// A ZÁRLAT-ABLAKOK: beállítás, mint a csomagok — de a levétele
        /// próbatétel, tehát nem az újabb blob dönt róla, hanem a JELE.
        /// Üresen nincs mező a dróton. Lásd `LockdownLogic.mergeWindows`.
        public var lockdownWindows: [LockdownLogic.LockdownWindow]?
        /// Az ablak-lista jele: a blob rev-je, amelyik utoljára változtatta. Nil = régi kliens.
        public var lockdownWindowsRev: Int?
        /// A FŐ MEGBÍZOTT (párban zárolás): a neve és a jelmondat lenyomata — a
        /// jelmondat nincs a dróton. A fésülés NEM a jel szerint megy, hanem
        /// azonosság szerint (`PartnerLogic.mergePartners`): élő megbízottat
        /// csak a nyoma visz el. Nil = nincs.
        public var partner: PartnerLogic.PartnerLock?
        /// A megbízott jele: a blob rev-je, amelyik utoljára változtatta — a
        /// régi kliensek miatt hordjuk tovább, ők még a jel szerint fésülnek.
        public var partnerRev: Int?
        /// A fő mellett élő TÁRS-megbízottak — a lazítás végén mindegyik
        /// jelmondata kell. Üresen nincs mező a dróton.
        public var partnerCo: [PartnerLogic.PartnerLock]?
        /// A levett megbízottak nyoma: csak a jelmondatos levételből születik,
        /// és élő megbízottat csak ez visz el. Üresen nincs mező a dróton.
        public var partnersGone: [PartnerLogic.PartnerGone]?
        /// KULCSSZÓ-SZABÁLYOK: a lista és a jele — a fésülése az ablakoké: a
        /// jel dönt, azonos jelnél a bővebb lista. Üresen nincs mező a dróton.
        public var keywords: [String]?
        public var keywordsRev: Int?
        /// A LISTA REJTÉSE: fiók-szintű beállítás, a JELÉVEL. A bekapcsolás egy
        /// koppintás (szigorítás), a kikapcsolás a készülék azonosítása (munka) —
        /// és a kifizetett kikapcsolás átmegy: a jel dönt, azonos jelnél a rejtett.
        /// Csak igazként utazik; a régi kliens (mező nélkül) semleges.
        public var hideSiteList: Bool?
        public var hideSiteListRev: Int?

        public init(
            packs: [Focus.Pack] = [], run: Focus.Run? = nil, log: [Focus.LogEntry] = [],
            rev: Double = 0, updatedAt: Double = 0, updatedBy: String = "",
            packMarks: [String: Int]? = nil, lockdown: LockdownLogic.Lockdown? = nil,
            lockdownWindows: [LockdownLogic.LockdownWindow]? = nil, lockdownWindowsRev: Int? = nil,
            partner: PartnerLogic.PartnerLock? = nil, partnerRev: Int? = nil,
            partnerCo: [PartnerLogic.PartnerLock]? = nil, partnersGone: [PartnerLogic.PartnerGone]? = nil,
            keywords: [String]? = nil, keywordsRev: Int? = nil,
            hideSiteList: Bool? = nil, hideSiteListRev: Int? = nil
        ) {
            self.packs = packs
            self.run = run
            self.log = log
            self.rev = rev
            self.updatedAt = updatedAt
            self.updatedBy = updatedBy
            self.packMarks = packMarks
            self.lockdown = lockdown
            self.lockdownWindows = lockdownWindows
            self.lockdownWindowsRev = lockdownWindowsRev
            self.partner = partner
            self.partnerRev = partnerRev
            self.partnerCo = partnerCo
            self.partnersGone = partnersGone
            self.keywords = keywords
            self.keywordsRev = keywordsRev
            self.hideSiteList = hideSiteList
            self.hideSiteListRev = hideSiteListRev
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
            // ELEMENKÉNT tűrve, mint a gépen és Androidon: egy rossz csomag vagy
            // naplósor kiesik, a többi marad (lásd Wire.swift). Eddig egyetlen
            // rossz elem az egész blobot vitte.
            packs = c.lossyArray(Focus.Pack.self, .packs)
            run = c.lenient(Focus.Run.self, .run)
            log = c.lossyArray(Focus.LogEntry.self, .log)
            rev = c.lenient(Double.self, .rev) ?? 0
            updatedAt = c.lenient(Double.self, .updatedAt) ?? 0
            updatedBy = c.lenient(String.self, .updatedBy) ?? ""
            // A jelek TŰRŐEN, értékenként: egy nem-egész érték csak magát vigye
            // (eddig az összes jelet — a gép csak a rosszat dobta).
            packMarks = c.lossyIntMap(.packMarks)
            // Tűrően, mint a jelek: egy sérült zárlat-mező ne vigye el a blobot.
            lockdown = (try? c.decodeIfPresent(
                LockdownLogic.Lockdown.self, forKey: .lockdown)) ?? nil
            // Az ablakok és a jelük is tűrően: egy sérült mező ne vigye el a blobot.
            // Elemenként: egy rossz ablak csak magát viszi (eddig az összeset).
            lockdownWindows = c.lenient([Lossy<LockdownLogic.LockdownWindow>].self, .lockdownWindows)?
                .compactMap { $0.value }
            lockdownWindowsRev = (try? c.decodeIfPresent(Int.self, forKey: .lockdownWindowsRev)) ?? nil
            // A megbízott és a jele is tűrően: egy sérült mező ne vigye el a blobot.
            partner = (try? c.decodeIfPresent(PartnerLogic.PartnerLock.self, forKey: .partner)) ?? nil
            partnerRev = (try? c.decodeIfPresent(Int.self, forKey: .partnerRev)) ?? nil
            // A társak és a nyomok elemenként: egy rossz elem csak magát viszi.
            partnerCo = c.lenient([Lossy<PartnerLogic.PartnerLock>].self, .partnerCo)?.compactMap { $0.value }
            partnersGone = c.lenient([Lossy<PartnerLogic.PartnerGone>].self, .partnersGone)?.compactMap { $0.value }
            // A kulcsszavak és a jelük is tűrően.
            // Elemenként: egy nem szöveg elem csak magát viszi (eddig az összeset).
            keywords = c.lenient([Lossy<String>].self, .keywords)?.compactMap { $0.value }
            keywordsRev = (try? c.decodeIfPresent(Int.self, forKey: .keywordsRev)) ?? nil
            // A rejtés és a jele is tűrően — csak igazként számít.
            hideSiteList = ((try? c.decodeIfPresent(Bool.self, forKey: .hideSiteList)) ?? nil) == true ? true : nil
            hideSiteListRev = (try? c.decodeIfPresent(Int.self, forKey: .hideSiteListRev)) ?? nil
        }
    }

    /// Két állapot összefésülése.
    ///
    /// A csomagok és a futás KÜLÖN dőlnek el, mert más a szabályuk: a
    /// csomagoknál az utolsó író nyer (ez beállítás — egy régi lista
    /// visszatérése bosszantó, de nem kibúvó), a futásnál a szigorúbb, és
    /// lazítani csak a nyomával lehet: a rövidítés számlálójával, a leállítás
    /// naplósorával. A `now` a jövőbeli naplósorokhoz kell: ami a jövőben ért
    /// véget, az nem zár le menetet; nélküle minden sor múltbeli. A
    /// focus-merge.ts `mergeFocus` tükre.
    public static func merge(_ local: SyncFocus, _ incoming: SyncFocus, now: Double? = nil) -> SyncFocus {
        let localIsNewer = firstIsNewer(local, incoming)
        let newer = localIsNewer ? local : incoming
        let older = localIsNewer ? incoming : local
        // EGYESÍTÉS, nem választás: lásd a `log` mező magyarázatát. ELŐBB a
        // napló: a menet sorsát ez dönti el (a leállítás nyoma a naplósor).
        let log = mergeLog(local.log, incoming.log)
        let (run, carriers) = mergeRun(local, incoming, log: log, now: now)
        let (packs, packMarks) = mergePacks(newer, older, runPackId: run?.packId, carriers: carriers)
        // A megbízottak AZONOSSÁG szerint: élő megbízottat csak a nyoma visz el,
        // két különböző élő közül egyik sem esik ki (`PartnerLogic.mergePartners`).
        let partners = PartnerLogic.mergePartners(partnerSet(local), partnerSet(incoming))
        return SyncFocus(
            packs: packs,
            run: run,
            log: log,
            rev: max(local.rev, incoming.rev),
            // Az idő a GYŐZTESÉ, nem a nagyobb: az eredmény kulcsa így az újabb
            // blobé, és három eszköz bármilyen sorrendben ugyanoda jut.
            updatedAt: newer.updatedAt,
            updatedBy: newer.updatedBy,
            packMarks: packMarks,
            // MAGASVÍZJEL, nem döntés: a későbbi vég nyer, rev-re való tekintet
            // nélkül. Egy hálózat nélkül maradt eszköz így nem tud feloldani
            // semmit azzal, hogy a régi állapotát tolja fel.
            lockdown: LockdownLogic.merge(local.lockdown, incoming.lockdown),
            // A JEL DÖNT, nem az újabb blob: a levétel próbatétellel jár, ami
            // lépteti a jelet; egy csomag-szerkesztés a másik eszközön nem.
            lockdownWindows: mergedWindows(local, incoming),
            lockdownWindowsRev: mergedWindowsMark(local, incoming),
            // A megbízott NEM a jel szerint: azonosság szerint (fent). A jel a
            // régi klienseknek utazik tovább, a nagyobbik.
            partner: partners.partner,
            partnerRev: mergedPartnerMark(local, incoming),
            partnerCo: partners.partnerCo.isEmpty ? nil : partners.partnerCo,
            partnersGone: partners.partnersGone.isEmpty ? nil : partners.partnersGone,
            // A kulcsszavak ugyanígy: a jel dönt, azonos jelnél a bővebb lista.
            keywords: mergedKeywords(local, incoming),
            keywordsRev: mergedKeywordsMark(local, incoming),
            // A rejtés ugyanígy: a jel dönt, azonos jelnél a rejtett — a szigorúbb irány.
            hideSiteList: mergedHide(local, incoming),
            hideSiteListRev: mergedHideMark(local, incoming)
        )
    }

    private static func mergedKeywords(_ local: SyncFocus, _ incoming: SyncFocus) -> [String]? {
        let out = KeywordLogic.mergeKeywords(
            local.keywordsRev ?? 0, local.keywords ?? [], incoming.keywordsRev ?? 0, incoming.keywords ?? []
        )
        return out.isEmpty ? nil : out
    }

    private static func mergedKeywordsMark(_ local: SyncFocus, _ incoming: SyncFocus) -> Int? {
        let mark = max(local.keywordsRev ?? 0, incoming.keywordsRev ?? 0)
        return mark > 0 ? mark : nil
    }

    /// A blob megbízottjai a fésülés alakjában.
    public static func partnerSet(_ f: SyncFocus) -> PartnerLogic.PartnerSet {
        PartnerLogic.PartnerSet(partner: f.partner, partnerCo: f.partnerCo ?? [], partnersGone: f.partnersGone ?? [])
    }

    private static func mergedPartnerMark(_ local: SyncFocus, _ incoming: SyncFocus) -> Int? {
        let mark = max(local.partnerRev ?? 0, incoming.partnerRev ?? 0)
        return mark > 0 ? mark : nil
    }

    /// A REJTÉS fésülése — a `shared/sync/focus-merge.ts` `mergeHide` tükre: a
    /// nagyobb jel nyer (a kikapcsolás munkába került, tehát átmegy); azonos
    /// jelnél a rejtett — ha bárhol rejtve van, mindenhol az. Igaz vagy nil.
    static func mergeHide(_ localRev: Int, _ local: Bool, _ incomingRev: Int, _ incoming: Bool) -> Bool {
        if incomingRev > localRev { return incoming }
        if localRev > incomingRev { return local }
        return local || incoming
    }

    private static func mergedHide(_ local: SyncFocus, _ incoming: SyncFocus) -> Bool? {
        let out = mergeHide(local.hideSiteListRev ?? 0, local.hideSiteList ?? false,
                            incoming.hideSiteListRev ?? 0, incoming.hideSiteList ?? false)
        return out ? true : nil
    }

    private static func mergedHideMark(_ local: SyncFocus, _ incoming: SyncFocus) -> Int? {
        let mark = max(local.hideSiteListRev ?? 0, incoming.hideSiteListRev ?? 0)
        return mark > 0 ? mark : nil
    }

    private static func mergedWindows(_ local: SyncFocus, _ incoming: SyncFocus) -> [LockdownLogic.LockdownWindow]? {
        let out = LockdownLogic.mergeWindows(
            local.lockdownWindowsRev ?? 0, local.lockdownWindows ?? [],
            incoming.lockdownWindowsRev ?? 0, incoming.lockdownWindows ?? []
        )
        return out.isEmpty ? nil : out
    }

    private static func mergedWindowsMark(_ local: SyncFocus, _ incoming: SyncFocus) -> Int? {
        let mark = max(local.lockdownWindowsRev ?? 0, incoming.lockdownWindowsRev ?? 0)
        return mark > 0 ? mark : nil
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
        // A rövidítés és az eredeti kezdés csak ha van: a nélkülük lévő menet
        // kulcsa ugyanaz, mint a frissítés előtt — a focus-merge.ts tükre.
        let run: String = f.run.map { r -> String in
            "\(r.packId)/\(intString(r.startedAt))/\(intString(r.endsAt))"
                + (r.cutCount > 0 ? "/c\(r.cutCount)" : "") + (r.origin.map { "/o\(intString($0))" } ?? "")
        } ?? "-"
        let markParts: [String] = (f.packMarks ?? [:]).sorted { utf16Less($0.key, $1.key) }
            .map { "\($0.key)=\($0.value)" }
        let marks: String = markParts.joined(separator: ",")
        return "\(packs)\u{3}\(run)\u{3}\(marks)"
    }

    /// A csomagok CSOMAGONKÉNT fésülődnek, a jelük szerint: a nagyobb jelnél
    /// álló állapot (ez a változat, vagy nincs) marad; egyenlő jelnél (a jel
    /// nélküli csomag is ilyen) az újabb blob állapota, ahogy eddig. A sorrend
    /// az újabb blobé, a csak a régebbin élő csomagok a végére. Az iPhone jelet
    /// csak a saját csomag-szerkesztésénél ír (SyncRevisions.bumpFocus),
    /// egyébként hordozza és fésüli. A merge.ts `mergePacks` tükre.
    private static func mergePacks(
        _ newer: SyncFocus, _ older: SyncFocus, runPackId: String?, carriers: [SyncFocus]
    ) -> ([Focus.Pack], [String: Int]?) {
        let en = newer.packMarks ?? [:]
        let eo = older.packMarks ?? [:]
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
            // `preferPack`; jel nélkül az újabb blob.
            var pick: Focus.Pack?
            if mo > mn { pick = po }
            else if mn > mo { pick = pn }
            else if mn > 0 {
                if let a = pn, let b = po { pick = preferPack(a, b) } else { pick = pn ?? po }
            } else { pick = pn }
            if id == runPackId { pick = runPack(id, pick, carriers: carriers, pn: pn, po: po) }
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

    /// A FUTÓ MENET CSOMAGJA: mindig marad, és a fehérlistája nem bővülhet — a
    /// focus-merge.ts `runPack` tükre. A mezői a jelek szerinti győztesé; ha a
    /// jelek szerint törölni kellene, a menetet hordozó blob változata áll (a
    /// törlés így megsemmisül, nem halasztódik — kimondott ár); a
    /// fehérlistája csak az, ami a menetet hordozó változat(ok)ban IS benne
    /// van (metszet). A menetről már nem a `rev` dönt, tehát a csomagját sem
    /// védheti — egy felhúzott jelű törlés vagy bővítés különben ingyen vinné el
    /// vagy nyitná meg a futó menetet.
    private static func runPack(
        _ id: String, _ pick: Focus.Pack?, carriers: [SyncFocus], pn: Focus.Pack?, po: Focus.Pack?
    ) -> Focus.Pack? {
        let held = carriers.compactMap { f in f.packs.first { $0.id == id } }
        guard let base = pick ?? held.first ?? pn ?? po else { return nil }
        if held.isEmpty { return base }
        return Focus.Pack(
            id: base.id, name: base.name,
            allowSites: base.allowSites.filter { x in held.allSatisfy { $0.allowSites.contains(x) } },
            allowApps: base.allowApps.filter { x in held.allSatisfy { $0.allowApps.contains(x) } },
            defaultMinutes: base.defaultMinutes, recurrence: base.recurrence
        )
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

    /// A FUTÓ munkamenet összefésülése — a kockázatos fele. A focus-merge.ts
    /// `mergeRun` tükre.
    ///
    /// NEM a blob `rev`-je dönt: azt egy átnevezés is lépteti, ingyen, és egy
    /// régi, „nem fut” állapot nagy rev-vel feltöltve próbatétel nélkül
    /// leállította a menetet. A szabály a menet AZONOSSÁGÁN áll (csomag +
    /// eredeti kezdés), és azon, amit a változat tud: menetet csak a rá
    /// hivatkozó NAPLÓSOR zár le; két változat ugyanarról a menetről: a több
    /// rövidítés, azonos számnál a hosszabb, azonos hossznál a később
    /// végződő; két különböző élő menet: a szigorúbb.
    ///
    /// A második érték a menetet HORDOZÓ blob(ok): akinél pontosan ez a
    /// változat áll — a futó csomag fehérlistája ezekhez képest nem bővülhet.
    private static func mergeRun(
        _ a: SyncFocus, _ b: SyncFocus, log: [Focus.LogEntry], now: Double?
    ) -> (Focus.Run?, [SyncFocus]) {
        let ra: Focus.Run? = a.run.flatMap { endedInLog(log, $0, now: now) ? nil : $0 }
        let rb: Focus.Run? = b.run.flatMap { endedInLog(log, $0, now: now) ? nil : $0 }
        guard let x = ra else { return (rb, rb == nil ? [] : [b]) }
        guard let y = rb else { return (x, [a]) }
        let win = Focus.sameRun(x, y) ? newerVariant(x, y) : stricterRun(x, y)
        return (win, [a, b].filter { f in f.run.map { sameVariant($0, win) } ?? false })
    }

    /// Lezárta-e a menetnek EZT a változatát egy naplósor — a sírköve: ugyanerről
    /// a menetről szól, nem a jövőben ért véget, és több rövidítést ismert, vagy
    /// ugyanannyit, és a terve legalább ilyen hosszú volt.
    private static func endedInLog(_ log: [Focus.LogEntry], _ run: Focus.Run, now: Double?) -> Bool {
        let limit = now.map { $0 + Focus.futureLogToleranceMs } ?? Double.infinity
        let length = run.endsAt - run.startedAt
        return log.contains { e in
            Focus.sameRun(e, run) && e.endedAt <= limit
                && (run.cutCount < e.cutCount || length <= e.plannedEndsAt - e.startedAt)
        }
    }

    /// Két változat ugyanarról a menetről: a több rövidítés, a hosszabb, végül a később végződő.
    private static func newerVariant(_ x: Focus.Run, _ y: Focus.Run) -> Focus.Run {
        if x.cutCount != y.cutCount { return x.cutCount > y.cutCount ? x : y }
        let lx = x.endsAt - x.startedAt
        let ly = y.endsAt - y.startedAt
        if lx != ly { return lx > ly ? x : y }
        return stricterRun(x, y)
    }

    /// Pontosan ugyanaz-e a két változat: azonosság, vég, rövidítések.
    private static func sameVariant(_ x: Focus.Run, _ y: Focus.Run) -> Bool {
        Focus.sameRun(x, y) && x.startedAt == y.startedAt && x.endsAt == y.endsAt && x.cutCount == y.cutCount
    }

    /// A szigorúbb menet, teljes rendezéssel — döntetlen nincs. Az azonosító
    /// kódegységenként, mint a gépen és a Kotlinban.
    private static func stricterRun(_ x: Focus.Run, _ y: Focus.Run) -> Focus.Run {
        if x.endsAt != y.endsAt { return x.endsAt > y.endsAt ? x : y }
        if x.startedAt != y.startedAt { return x.startedAt < y.startedAt ? x : y }
        if x.packId != y.packId { return utf16Less(x.packId, y.packId) ? x : y }
        let ox = Focus.runOrigin(x)
        let oy = Focus.runOrigin(y)
        if ox != oy { return ox < oy ? x : y }
        return x.cutCount >= y.cutCount ? x : y
    }

    /// Két napló egyesítése.
    ///
    /// A sor AZONOSSÁGA a csomag és a menet EREDETI kezdése (`runOrigin`: az
    /// óra-ugrás eltolhatja a kezdést, a menet attól ugyanaz). Egyszerre egy
    /// menet fut az egész fiókban, tehát ez a pár egyértelmű — és pont ezért fésülődik össze
    /// helyesen az a gyakori eset, amikor UGYANAZT a menetet két eszköz is
    /// lezárja: a telefon próbatétellel, a gép meg később, a szinkronból véve
    /// észre. Enélkül minden ilyen menet kettőnek számítana.
    ///
    /// Ütközésnél a TÖBBET TUDÓ sor marad (`better`), azonos tudásnál a KORÁBBI
    /// vég, mert az van közelebb a valósághoz. Azonos végnél a próbatételes
    /// leállítás — azt az egyik oldal láthatta, a másik nem.
    public static func mergeLog(
        _ a: [Focus.LogEntry], _ b: [Focus.LogEntry]
    ) -> [Focus.LogEntry] {
        var byKey: [String: Focus.LogEntry] = [:]
        for e in a + b {
            let key = "\(e.packId)|\(Focus.runOrigin(e))"
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
    /// ELŐBB A TUDÁS, aztán a vég — a focus-merge.ts `better` tükre: a több
    /// rövidítést ismerő, aztán a hosszabb tervet ismerő; azonos tudásnál a
    /// korábbi vég, aztán a próbatételes leállítás; a maradék csak a teljes
    /// rendezésért (a korábbi kezdés, az ablak jele, a csomag neve
    /// kódegységenként). A terv HOSSZA számít, nem a vége: az óra-ugrás a
    /// kezdést és a véget együtt tolja.
    private static func better(_ x: Focus.LogEntry, _ y: Focus.LogEntry) -> Focus.LogEntry {
        if x.cutCount != y.cutCount { return x.cutCount > y.cutCount ? x : y }
        let px = x.plannedEndsAt - x.startedAt
        let py = y.plannedEndsAt - y.startedAt
        if px != py { return px > py ? x : y }
        if x.endedAt != y.endedAt { return x.endedAt < y.endedAt ? x : y }
        if x.stopped != y.stopped { return x.stopped ? x : y }
        if x.startedAt != y.startedAt { return x.startedAt < y.startedAt ? x : y }
        let wx = x.window == true
        let wy = y.window == true
        if wx != wy { return wx ? x : y }
        if x.packName != y.packName { return utf16Less(x.packName, y.packName) ? x : y }
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
        // A NEGYEDIK az azonosság maradéka: az eltolt menet sora a kezdésében
        // egyezhet egy másikéval, az eredetiében nem.
        let ordered: [Focus.LogEntry] = rows.sorted { a, b in
            if a.endedAt != b.endedAt { return a.endedAt < b.endedAt }
            if a.packId != b.packId { return utf16Less(a.packId, b.packId) }
            if a.startedAt != b.startedAt { return a.startedAt < b.startedAt }
            return Focus.runOrigin(a) < Focus.runOrigin(b)
        }
        return Array(ordered.suffix(Focus.maxFocusLog))
    }

    /// A dróton jött munkamenet-dokumentum, normalizálva — nil, ha a szöveg nem
    /// JSON-objektum. Elemenként tűr (lásd `SyncFocus.init(from:)`); a közös
    /// fixtúra (fixtures/wire-cases.json) ezen az úton olvas, mint a szinkron.
    public static func fromJson(_ text: String, fallbackDevice: String, now: Double? = nil) -> SyncFocus? {
        guard let decoded = try? JSONDecoder().decode(SyncFocus.self, from: Data(text.utf8)) else { return nil }
        return normalize(decoded, fallbackDevice: fallbackDevice, now: now)
    }

    /// Egy kívülről jött naplósor: azonosító és pozitív vég nélkül kiesik, a
    /// név a közös szabállyal tisztul (`Focus.logPackName`). A gép
    /// `normalizeLogEntry`-jének és az Android olvasójának tükre — eddig az
    /// iPhone a nevet se nem vágta, se az üreset nem pótolta.
    static func cleanLogEntry(_ e: Focus.LogEntry) -> Focus.LogEntry? {
        guard !e.packId.isEmpty, e.endedAt > 0 else { return nil }
        return Focus.LogEntry(
            packId: e.packId, packName: Focus.logPackName(e.packName), startedAt: e.startedAt,
            endedAt: e.endedAt, plannedEndsAt: e.plannedEndsAt, stopped: e.stopped,
            window: e.window == true ? true : nil,
            cuts: e.cuts, origin: Focus.cleanOrigin(e.origin, startedAt: e.startedAt)
        )
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
        let run = f.run.map { "\($0.packId);\($0.startedAt);\($0.endsAt);\($0.cutCount);\(Focus.runOrigin($0))" } ?? "-"
        // A NAPLÓ IS BENNE VAN — enélkül egy itt lezárult menet sosem érne fel
        // a kiszolgálóra: a kör azt látná, hogy „nincs mit feltölteni”. A sor
        // tudása (rövidítés, eredeti kezdés) is: a sor sírkő is.
        let log = f.log.map {
            "\($0.packId);\($0.startedAt);\($0.endedAt);\($0.plannedEndsAt);\($0.stopped);\($0.cutCount);\(Focus.runOrigin($0))"
        }.joined(separator: "|")
        // A jelek is: ha csak ők különböznek, akkor is fel kell menniük.
        let marks = (f.packMarks ?? [:]).sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }.joined(separator: ",")
        // A ZÁRLAT IS: enélkül egy itt indított zárlat sosem érne fel a
        // kiszolgálóra, mert a kör azt látná, hogy nincs mit feltölteni.
        let lock = f.lockdown.map { "\($0.startedAt);\($0.until)" } ?? "-"
        // Az ablakok a jelükkel, tartalom szerint rendezve: az azonosító és a
        // sorrend nem jelentés.
        let windows = (f.lockdownWindows ?? []).map { LockdownLogic.windowKey($0.band) }.sorted()
            .joined(separator: "|")
        // A megbízott a jelével: a cseréje is különbség, fel kell mennie. A
        // társak és a nyomok is — egy levétel nyoma nélkül sosem érne át.
        let partner = PartnerLogic.partnerKey(f.partner)
            + "~" + (f.partnerCo ?? []).map { PartnerLogic.partnerKey($0) }.joined(separator: ";")
            + "~" + (f.partnersGone ?? []).map { "\($0.id)@\($0.at)" }.joined(separator: ";")
        // A kulcsszavak a jelükkel — tartalom szerint, rendezve.
        let keywords = KeywordLogic.keywordsKey(f.keywords ?? [])
        // A rejtés a jelével: a cseréje is különbség — azonos rev mellett is fel
        // kell mennie, és az átvett rejtést azonos rev mellett is be kell írni.
        let hide = (f.hideSiteList ?? false) ? 1 : 0
        return "\(packs)//\(run)//\(log)//\(marks)//\(lock)//\(windows)//\(f.lockdownWindowsRev ?? 0)"
            + "//\(partner)//\(f.partnerRev ?? 0)//\(keywords)//\(f.keywordsRev ?? 0)"
            + "//\(hide)//\(f.hideSiteListRev ?? 0)//\(f.rev)"
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
    /// - Parameter now: ha meg van adva, a LEJÁRT zárlat nem kerül be — a
    ///   szinkron határán ez a helyes (lásd `LockdownLogic.live`).
    public static func normalize(
        _ raw: SyncFocus, fallbackDevice: String, now: Double? = nil
    ) -> SyncFocus {
        var packs: [Focus.Pack] = []
        var seenIds: [String] = []
        for p in raw.packs {
            if !p.id.isEmpty { seenIds.append(p.id) }
            guard !p.id.isEmpty, let name = Focus.normalizePackName(p.name) else { continue }
            if packs.contains(where: { $0.id == p.id }) || packs.count >= maxPacks { continue }
            packs.append(Focus.Pack(
                id: p.id,
                name: name,
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
        // A megbízottak a fésülés szabálya szerint tisztítva (`PartnerLogic.cleanSet`).
        let partners = PartnerLogic.cleanSet(
            partner: raw.partner, partnerCo: raw.partnerCo ?? [], partnersGone: raw.partnersGone ?? []
        )
        return SyncFocus(
            packs: packs,
            run: cleanRun(raw.run, packs: packs),
            // A naplót NEM kötjük a csomagokhoz: egy menet naplósora akkor is
            // igaz marad, ha a csomagot azóta törölték. Épp ezért van benne a
            // NÉV is, nem csak az azonosító.
            log: capLog(raw.log.compactMap(cleanLogEntry)),
            // Nemnegatív egész, mint a gépen és Androidon: egy tört rev-ből
            // tört jel lenne, amit a visszaolvasás eldob.
            rev: Double(revInt(raw.rev)),
            updatedAt: raw.updatedAt,
            updatedBy: raw.updatedBy.isEmpty ? fallbackDevice : raw.updatedBy,
            packMarks: (kept?.isEmpty ?? true) ? nil : kept,
            // Kívülről jött adat: az értelmetlen vég nem zárlat — és `now`
            // mellett a lejárt sem.
            lockdown: raw.lockdown
                .flatMap { LockdownLogic.parse(["until": $0.until, "startedAt": $0.startedAt]) }
                .flatMap { now == nil ? $0 : LockdownLogic.live($0, now!) },
            // Az ablakok kívülről jött adat, mint minden más; a jel pozitív
            // egész, legfeljebb a blob rev-je — mint a csomag-jelek.
            lockdownWindows: cleanedWindows(raw.lockdownWindows),
            lockdownWindowsRev: raw.lockdownWindowsRev.flatMap { $0 > 0 && $0 <= revInt(raw.rev) ? $0 : nil },
            // A megbízott kívülről jött adat: csak a jó alakú rekord marad, a
            // jele pozitív egész, legfeljebb a blob rev-je — mint az ablakoké;
            // a társak és a nyomok a fésülés szabálya szerint.
            partner: partners.partner,
            partnerRev: raw.partnerRev.flatMap { $0 > 0 && $0 <= revInt(raw.rev) ? $0 : nil },
            partnerCo: partners.partnerCo.isEmpty ? nil : partners.partnerCo,
            partnersGone: partners.partnersGone.isEmpty ? nil : partners.partnersGone,
            // A kulcsszavak is kívülről jött adat: csak az érvényes, egyszer, a plafonig.
            keywords: cleanedKeywords(raw.keywords),
            keywordsRev: raw.keywordsRev.flatMap { $0 > 0 && $0 <= revInt(raw.rev) ? $0 : nil },
            // A rejtés csak igazként számít; a jele pozitív egész, legfeljebb a
            // blob rev-je — mint a többié. Ez a sor HIÁNYZOTT az első körben, és
            // a fixtúra-visszajátszás fogta ki: a normalizálás újraépíti a
            // rekordot, tehát amit itt nem viszünk át, az a dróton elveszett.
            hideSiteList: (raw.hideSiteList ?? false) ? true : nil,
            hideSiteListRev: raw.hideSiteListRev.flatMap { $0 > 0 && $0 <= revInt(raw.rev) ? $0 : nil }
        )
    }

    private static func cleanedKeywords(_ raw: [String]?) -> [String]? {
        let out = KeywordLogic.cleanKeywords(raw ?? [])
        return out.isEmpty ? nil : out
    }

    private static func cleanedWindows(_ raw: [LockdownLogic.LockdownWindow]?) -> [LockdownLogic.LockdownWindow]? {
        let out = LockdownLogic.cleanWindows(raw ?? [])
        return out.isEmpty ? nil : out
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
