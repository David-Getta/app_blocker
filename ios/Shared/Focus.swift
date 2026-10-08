import Foundation

/// Munkamenetek: „most csak EZ mehet” — a `desktop/src/shared/focus.ts` tükre.
///
/// A blokklista arról szól, mi NE menjen. A munkamenet ellenkező irányból
/// közelít: leülök nyelvet tanulni, és a következő ötven percben CSAK a szótár
/// és a jegyzetfüzet kell. Mindent felsorolni, ami zavarhat, reménytelen — a
/// világon minden zavarhat. Felsorolni, ami kell: öt tétel.
///
/// EZ MEGFORDÍTJA A LOGIKÁT, és ezért külön fájl: a blokklista feketelista, a
/// munkamenet FEHÉRLISTA. A kettő együtt él: a munkamenet sosem old fel semmit,
/// amit a blokklista tilt — csak hozzátesz.
///
/// MIÉRT VAN EZ A TELEFONON IS. Eddig a munkamenet csak az asztali appban
/// létezett, és ez a funkció felét elvette: elindítod a gépen a „Nyelvtanulás”
/// csomagot, aztán felveszed a telefont, és ott minden mehet. A telefon volt a
/// kiskapu — pont az az eszköz, ami kéznél van.
///
/// iPhone-on ez a réteg ERŐSEBB, mint a gépen: a hosts fájlba nem írható le,
/// hogy „mindent tilts, kivéve ötöt”, a csomagalagút viszont minden lekérdezést
/// lát. Cserébe nincs app-szintű kivétel: az Apple nem enged a rendszer-alagúton
/// belül appok szerint válogatni. Amit a csomagban felsorolsz, az a NEVEKRE
/// vonatkozik, nem az appokra.
public enum Focus {

    /// Egy csomagban ennyi engedélyezett tétel lehet.
    public static let maxAllowEntries = 40
    /// A SOROZAT KÜSZÖBE: egy nap nem sorozat — kettőtől mondat. A három magban azonos (core-sync).
    public static let streakMinDays = 2

    /// A csomag nevének felső hossza — a felületen is ki kell férnie.
    public static let maxPackName = 40

    /// Egy munkamenet leghosszabb hossza. Ennél tovább nem tervez az ember.
    public static let maxSessionMinutes = 8 * 60

    /// A felületen felkínált hosszak.
    public static let sessionChoicesMin = [15, 25, 50, 90, 120]

    public struct Pack: Codable, Equatable {
        public let id: String
        /// amit a felhasználó ír: „Nyelvtanulás”
        public let name: String
        /// Engedélyezett hosztok. MINDEN MÁS tiltva a munkamenet alatt.
        /// Aldomainek is átmennek: a `google.com` engedése a
        /// `translate.google.com`-ot is engedi.
        public let allowSites: [String]
        /// Engedélyezett appok. iPhone-on ez NEM érvényesíthető (lásd fent);
        /// azért tartjuk, mert a gépen az, és a szinkron sosem dobhat el olyan
        /// mezőt, amit ez az eszköz nem használ.
        public let allowApps: [String]
        /// amit induláskor felkínálunk, percben
        public let defaultMinutes: Int
        /// Ismétlődés: ezeken a napokon, ebben az ablakban a menet MAGÁTÓL
        /// indul, és az ablak végéig tart. Nil = csak kézzel indul. Ugyanaz a
        /// sáv-alak, mint az oldalak menetrendjében. (A `Codable` a hiányzó
        /// kulcsot nil-nek veszi: egy régebbi gép blobja is dekódolható.)
        let recurrence: ScheduleLogic.Band?

        public init(
            id: String, name: String, allowSites: [String],
            allowApps: [String], defaultMinutes: Int
        ) {
            self.init(
                id: id, name: name, allowSites: allowSites,
                allowApps: allowApps, defaultMinutes: defaultMinutes, recurrence: nil
            )
        }

        init(
            id: String, name: String, allowSites: [String],
            allowApps: [String], defaultMinutes: Int, recurrence: ScheduleLogic.Band?
        ) {
            self.id = id
            self.name = name
            self.allowSites = allowSites
            self.allowApps = allowApps
            self.defaultMinutes = defaultMinutes
            self.recurrence = recurrence
        }

        enum CodingKeys: String, CodingKey {
            case id, name, allowSites, allowApps, defaultMinutes, recurrence
        }

        /// TŰRŐ dekódolás, a gép `normalizePack`-je szerint: egy objektum mindig
        /// csomag lesz (a rossz típusú mező az alapértékét kapja), és a
        /// normalizálás dönt róla. Ez nem kényelem: ha egy rossz nevű csomag
        /// itt elhasalna, az azonosítója nem lenne „látott”, a jele a csomag
        /// nélkül sírkőnek látszana — és a csomag MINDENHOL törlődne.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = c.lenient(String.self, .id) ?? ""
            name = c.lenient(String.self, .name) ?? ""
            allowSites = c.lossyStrings(.allowSites)
            allowApps = c.lossyStrings(.allowApps)
            // Csak JSON-szám: a „30” szöveg és az igaz nem hossz (a gépen sem).
            defaultMinutes = Focus.normalizeMinutes(c.lenient(Double.self, .defaultMinutes)) ?? 25
            recurrence = c.lenient(ScheduleLogic.Band.self, .recurrence)
        }
    }

    public struct Run: Codable, Equatable {
        public let packId: String
        public let startedAt: Double
        /// mikor jár le magától
        public let endsAt: Double
        /// Hányszor RÖVIDÍTETTÉK próbatétellel — csak ha legalább egyszer (nil =
        /// soha). A szinkron ezzel dönt két változat között ugyanarról a
        /// menetről: a több kifizetett rövidítés nyer. A focus.ts `cuts` tükre.
        public let cuts: Int?
        /// A menet EREDETI kezdése, ha az óra-ugrás elnyelése eltolta — csak
        /// akkor van. A menet azonossága ez (`runOrigin`) — a focus.ts
        /// `origin` tükre.
        public let origin: Double?

        public init(packId: String, startedAt: Double, endsAt: Double, cuts: Int? = nil, origin: Double? = nil) {
            self.packId = packId
            self.startedAt = startedAt
            self.endsAt = endsAt
            self.cuts = (cuts ?? 0) > 0 ? cuts : nil
            self.origin = origin
        }

        enum CodingKeys: String, CodingKey { case packId, startedAt, endsAt, cuts, origin }

        /// TŰRŐ dekódolás, a gép `normalizeRun`-ja szerint: szöveg-azonosító,
        /// csak JSON-szám idők (a hiányzó kezdés nulla); a `cleanRun` dönt. A
        /// két jel a gép `cleanCuts` / `cleanOrigin` szabályával tisztul.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            packId = c.lenient(String.self, .packId) ?? ""
            let start = c.lenient(Double.self, .startedAt) ?? 0
            startedAt = start
            endsAt = c.lenient(Double.self, .endsAt) ?? 0
            cuts = Focus.cleanCuts(c.lenient(Double.self, .cuts))
            origin = Focus.cleanOrigin(c.lenient(Double.self, .origin), startedAt: start)
        }

        /// A rövidítések száma (0, ha nem volt).
        public var cutCount: Int { cuts ?? 0 }
    }

    /// A rövidítések számának plafonja — a focus.ts `MAX_RUN_CUTS` tükre.
    public static let maxRunCuts = 1000

    /// A rövidítések száma kívülről: pozitív egész, a plafonig — különben nil (a focus.ts `cleanCuts`).
    public static func cleanCuts(_ raw: Double?) -> Int? {
        guard let raw, raw.isFinite, raw == raw.rounded(.towardZero), raw > 0 else { return nil }
        return Int(min(raw, Double(maxRunCuts)))
    }

    /// Az eredeti kezdés kívülről: pozitív egész, a kezdés ELŐTTI — különben
    /// nil (a focus.ts `cleanOrigin`). A 2^53 fölötti szám a gépen sem egész.
    public static func cleanOrigin(_ raw: Double?, startedAt: Double) -> Double? {
        guard let raw, raw.isFinite, raw == raw.rounded(.towardZero), raw > 0,
              raw <= 9_007_199_254_740_991, raw < startedAt else { return nil }
        return raw
    }

    /// A menet azonossága a csomag mellett: az eredeti kezdése, eltolás előtt.
    public static func runOrigin(_ r: Run) -> Double { r.origin ?? r.startedAt }

    /// A naplósor azonossága: a menet eredeti kezdése.
    public static func runOrigin(_ e: LogEntry) -> Double { e.origin ?? e.startedAt }

    /// Ugyanarról a menetről szól-e a kettő — a focus.ts `sameRun` tükre.
    public static func sameRun(_ a: Run, _ b: Run) -> Bool { a.packId == b.packId && runOrigin(a) == runOrigin(b) }

    /// A naplósor erről a menetről szól-e.
    public static func sameRun(_ e: LogEntry, _ r: Run) -> Bool { e.packId == r.packId && runOrigin(e) == runOrigin(r) }

    /// Fut-e most munkamenet.
    public static func isRunning(_ run: Run?, now: Double) -> Bool {
        guard let run else { return false }
        return run.endsAt > now
    }

    /// Mennyi van hátra (0, ha nem fut).
    public static func remainingMs(_ run: Run?, now: Double) -> Double {
        guard isRunning(run, now: now), let run else { return 0 }
        return run.endsAt - now
    }

    /// A menet első két perce: a döntés pillanata. A szűrő a névfeloldásokat
    /// látja — ami már nyitva volt (egy szóló videó), egy darabig még mehet. A
    /// kártya ilyenkor ezt kimondja, utána csendben marad. (Androidon a sáv.)
    public static let freshRunNoteMs: Double = 120_000 // két perc

    /// Friss-e a menet (az indulása óta nem telt el két perc). Visszaugró órán nem.
    public static func isFreshRun(_ run: Run?, now: Double) -> Bool {
        guard let run else { return false }
        return now >= run.startedAt && now - run.startedAt < freshRunNoteMs
    }

    /// Percek -> használható hossz, vagy nil.
    public static func normalizeMinutes(_ value: Double?) -> Int? {
        guard let value, value.isFinite else { return nil }
        // Double-ben vágunk, és csak UTÁNA lesz Int: az `Int(...)` egy
        // Int-be nem férő számon nem kerekít, hanem összeomlik.
        let rounded = value.rounded(.toNearestOrAwayFromZero)
        if rounded < 1 { return nil }
        return Int(min(rounded, Double(maxSessionMinutes)))
    }

    /// Egy engedélyezett oldal megtisztítása — ugyanazon a magon, mint a
    /// blokklista, hogy ami itt engedve van, ugyanazt a hosztot jelentse.
    public static func normalizeAllowSite(_ input: String) -> String? {
        Blocklist.normalizeDomain(input)
    }

    /// Egy engedélyezett app nevének plafonja — KÓDPONTBAN (skalárban), mint a gépen.
    public static let maxAllowAppLength = 64

    /// Az engedélyezett app neve tisztán — a gép `cleanLine` szabálya: a
    /// vezérlők szóközre, a közös szóköz-készlet szerinti futamok egy szóközre,
    /// skalár szerinti vágás, a szélek le. A `prefix` grafémában vágott, a
    /// `.whitespaces` a BOM-ot nem ismerte — a lista a szinkronban minden
    /// körben átíródott volna.
    public static func normalizeAllowApp(_ input: String) -> String? {
        let s = TextLogic.trimSpaces(TextLogic.takeScalars(TextLogic.collapseSpaces(input), maxAllowAppLength))
        return s.isEmpty ? nil : s
    }

    /// A csomag neve tisztán, vagy nil — ugyanaz a `cleanLine` szabály,
    /// `maxPackName` skalárral. Eddig a fogadás a `.whitespacesAndNewlines`
    /// szerint vágta a széleket (a BOM-ot nem ismeri) és grafémában vágott, a
    /// felvétel a `Character.isWhitespace` szerint vont össze. A gép
    /// `normalizePackName` tükre; a közös fixtúra kimondja.
    public static func normalizePackName(_ input: String) -> String? {
        let s = TextLogic.trimSpaces(TextLogic.takeScalars(TextLogic.collapseSpaces(input), maxPackName))
        return s.isEmpty ? nil : s
    }

    /// A naplósor neve: a tiszta csomagnév, vagy „Ismeretlen csomag”. A gép `logPackName` tükre.
    public static func logPackName(_ input: String) -> String {
        normalizePackName(input) ?? "Ismeretlen csomag"
    }

    /// Átmehet-e ez a hoszt a munkamenet alatt.
    ///
    /// Egyezés vagy ALDOMAIN. A `translate.google.com` átmegy, ha a
    /// `google.com` engedve van; a `notgoogle.com` NEM — a végén hasonlító
    /// tartománynév a leggyakoribb megtévesztés.
    public static func isSiteAllowed(_ pack: Pack, host: String) -> Bool {
        let h = normalizedHost(host)
        if h.isEmpty { return false }
        return pack.allowSites.contains { h == $0 || h.hasSuffix(".\($0)") }
    }

    /// Átmehet-e ez az app. iPhone-on nem érvényesítjük — a gépen igen, és a
    /// szabálynak mindkét helyen ugyanannak kell lennie.
    public static func isAppAllowed(_ pack: Pack, app: String) -> Bool {
        // A szélek a közös készlet szerint, a kisbetű a gépé (a szó végi
        // szigmával), a keresés kódegységre — a Swift `contains` grafémában és
        // kanonikus egyenértékűséggel keresett volna.
        let a = TextLogic.lowercase(TextLogic.trimSpaces(app))
        if a.isEmpty { return false }
        return pack.allowApps.contains {
            let y = TextLogic.lowercase($0)
            // Az üres tétel NEM enged mindent.
            if y.isEmpty { return false }
            return TextLogic.sameScalars(a, y) || TextLogic.utf16Contains(a, y) || TextLogic.utf16Contains(y, a)
        }
    }

    /// A hosszabbítás INGYEN van, a rövidítés próbatétel — a szigorítás
    /// irányába mindenhol szabad az út.
    public static func isSessionLoosening(currentEndsAt: Double, nextEndsAt: Double) -> Bool {
        // A nem véges vég lazítás (a gép szabálya): a `NaN < current` hamis
        // volna, és egy NaN-végű — vagyis nem futó — menet szigorításnak
        // számítana.
        !(nextEndsAt.isFinite && nextEndsAt >= currentEndsAt)
    }

    // -----------------------------------------------------------------------
    // A DNS-döntés a munkamenet alatt
    // -----------------------------------------------------------------------
    //
    // Egy telefon, aminek MINDEN névfeloldása elhasal, nem korlátozott telefon,
    // hanem használhatatlan: nem jön értesítés, a rendszer azt hiszi, nincs
    // internet, és a felhasználó a munkamenetet fogja hibásnak tartani, nem a
    // saját beállítását.
    //
    // Ezért van egy SZŰK, tételesen indokolt kivétellista. Nem kényelmi lista:
    // minden sora olyasmi, aminek a hiánya kárt okoz, és amin böngészni nem
    // lehet. A felület ki is mondja, hogy létezik — egy titkos kivétel rosszabb
    // lenne, mint egy nyílt.

    /// Amit a munkamenet alatt sem tiltunk el, és miért.
    public static let infraAllow = [
        // Értesítések. Enélkül nyolc órán át nem jön üzenet — a munkamenet nem
        // arról szól, hogy elérhetetlen legyél.
        // A `push.apple.com` a NUMEROZOTT courier-hosztok miatt kell
        // (`1-courier.push.apple.com`, `2-courier…`): azokat egyenként
        // felsorolni nem lehet. A végződés-illesztés miatt ez a sor a
        // `courier.push.apple.com`-ot is lefedi, tehát külön nem szerepel —
        // egy fölösleges sor itt nem ártalmatlan, hanem zaj a projekt
        // legérzékenyebb listáján.
        "push.apple.com",
        // Kapcsolat-ellenőrzés. Ha ez elhasal, a rendszer hálózati hibát jelez,
        // és a felhasználó azt látja, hogy „nincs net”, nem azt, hogy fut egy
        // munkamenet.
        "captive.apple.com",
        // Óra. Egy elcsúszott óra a munkamenet VÉGÉT is elcsúsztatná.
        "time.apple.com",
        "pool.ntp.org",
    ]

    /// Rendszer-infrastruktúra-e ez a név (egyezés vagy aldomain).
    public static func isInfrastructure(_ host: String) -> Bool {
        let h = normalizedHost(host)
        if h.isEmpty { return false }
        return infraAllow.contains { h == $0 || h.hasSuffix(".\($0)") }
    }

    /// Mi lett a névvel, és MIÉRT — a felület ezt írja ki.
    public enum Verdict {
        case allow
        case blockedByList
        case blockedByKeyword
        case blockedByFocus
    }

    /// Átmehet-e ez a név most.
    ///
    /// A sorrend nem esztétika, hanem a szabályrendszer:
    ///
    ///   1. A BLOKKLISTA MINDIG NYER. A munkamenet sosem old fel semmit — csak
    ///      hozzátesz. Ha ez fordítva lenne, egy csomagba felvett `youtube.com`
    ///      feloldaná a tiltott YouTube-ot, próbatétel nélkül.
    ///   1b. A KULCSSZÓ a hosztnévben -> tiltva. A tunnel csak a hosztnevet
    ///      látja, abban tilt (`tiktok` -> `www.tiktok.com`); a rendszer-
    ///      infrastruktúra és a saját fiókkiszolgáló sosem — egy `live`
    ///      kulcsszó ne vigye el a push-csatornát vagy a saját fiókot.
    ///   2. Nem fut munkamenet -> a blokklista döntött, mehet.
    ///   3. A csomagon rajta van -> mehet.
    ///   4. Rendszer-infrastruktúra -> mehet (lásd fent).
    ///   5. Minden más -> tiltva, mert a munkamenet fehérlista.
    ///
    /// A `syncHost` a saját fiókkiszolgálód neve, ha van: enélkül a telefon a
    /// munkamenet alatt nem látná, ha egy MÁSIK eszközön leállítod. Egy zár,
    /// amit a saját kulcsod sem ér el, nem zár, hanem hiba.
    public static func verdict(
        _ qname: String,
        run: Run?,
        pack: Pack?,
        now: Double,
        blocked: Set<String>,
        syncHost: String? = nil,
        keywords: [String] = []
    ) -> Verdict {
        let h = normalizedHost(qname)
        if Blocklist.matches(h, blocked: blocked) { return .blockedByList }
        var ownSync = false
        if let syncHost {
            let sh = normalizedHost(syncHost)
            ownSync = !sh.isEmpty && (h == sh || h.hasSuffix(".\(sh)"))
        }
        if !keywords.isEmpty, !isInfrastructure(h), !ownSync, KeywordLogic.keywordInHost(keywords, h) != nil {
            return .blockedByKeyword
        }
        guard isRunning(run, now: now), let pack else { return .allow }
        if isSiteAllowed(pack, host: h) { return .allow }
        if isInfrastructure(h) { return .allow }
        if ownSync { return .allow }
        return .blockedByFocus
    }

    /// MI LENNE EZZEL a névvel, és miért — a felület próbamezője ezt írja ki.
    /// Ugyanaz az ítélet, mint a tunnelé, szóban: a kulcsszó a hosztnévben
    /// meglephet, itt derül ki előre, nem a hálózati hibánál. Üres névre üres.
    public static func explain(
        _ qname: String,
        run: Run?,
        pack: Pack?,
        now: Double,
        blocked: Set<String>,
        syncHost: String? = nil,
        keywords: [String] = []
    ) -> String {
        let h = normalizedHost(qname)
        if h.isEmpty { return "" }
        switch verdict(h, run: run, pack: pack, now: now, blocked: blocked, syncHost: syncHost, keywords: keywords) {
        case .blockedByList: return "Tiltva: a lista."
        case .blockedByKeyword: return "Tiltva: kulcsszó a hosztnévben („\(KeywordLogic.keywordInHost(keywords, h) ?? "")”)."
        case .blockedByFocus: return "Tiltva, amíg a munkamenet tart: nincs a csomagon."
        case .allow:
            return isRunning(run, now: now) && pack != nil && isInfrastructure(h) ? "Átmegy: rendszer-infrastruktúra." : "Átmegy."
        }
    }

    // -----------------------------------------------------------------------
    // A LEZÁRULT menetek naplója — ebből lesz a statisztika.
    //
    // Az iPhone-on ugyanúgy kell, mint a gépen, és ez nem másolásból következik:
    // a menetet MÁR itt is lehet indítani és leállítani, tehát ha csak a gép
    // naplózna, az itt lefutott menetek egyszerűen nem léteznének.

    /// Ennyi sort tartunk — a statisztika a mai napot és a hetet nézi.
    public static let maxFocusLog = 200

    public struct LogEntry: Codable, Equatable {
        public let packId: String
        /// a csomag neve AKKOR — a csomag azóta átnevezhető vagy törölhető
        public let packName: String
        public let startedAt: Double
        /// mikor ért véget ténylegesen
        public let endedAt: Double
        /// mikorra volt tervezve — ebből látszik, hogy korábban ért-e véget
        public let plannedEndsAt: Double
        /// próbatétellel leállítva (igaz), vagy magától lejárt (hamis)
        public let stopped: Bool
        /// A HETI ABLAKBÓL indult, magától (a csomag ablakának egy előfordulása)
        /// — csak ha igaz; a régi sorban nincs (nil), és az nem ablak. A
        /// statisztika és a heti mondat ebből mondja, dolgozik-e az ablak.
        public let window: Bool?
        /// A lezárt változat rövidítéseinek száma — csak ha volt. A sor a menet
        /// SÍRKÖVE is a szinkronban — a focus.ts `cuts` tükre.
        public let cuts: Int?
        /// A menet eredeti kezdése, ha az óra-ugrás eltolta — a sor azonossága.
        public let origin: Double?

        public init(
            packId: String, packName: String, startedAt: Double,
            endedAt: Double, plannedEndsAt: Double, stopped: Bool, window: Bool? = nil,
            cuts: Int? = nil, origin: Double? = nil
        ) {
            self.packId = packId
            self.packName = packName
            self.startedAt = startedAt
            self.endedAt = endedAt
            self.plannedEndsAt = plannedEndsAt
            self.stopped = stopped
            self.window = window
            self.cuts = (cuts ?? 0) > 0 ? cuts : nil
            self.origin = origin
        }

        enum CodingKeys: String, CodingKey {
            case packId, packName, startedAt, endedAt, plannedEndsAt, stopped, window, cuts, origin
        }

        /// A rövidítések száma (0, ha nem volt).
        public var cutCount: Int { cuts ?? 0 }

        /// TŰRŐ dekódolás, a gép `normalizeLogEntry`-je szerint: a hiányzó vagy
        /// rossz típusú mező az alapértékét kapja (csak JSON-szám a szám, csak
        /// a valódi `true` igaz), és a `FocusSync.cleanLogEntry` dönt a sorról.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            packId = c.lenient(String.self, .packId) ?? ""
            packName = c.lenient(String.self, .packName) ?? ""
            let start = c.lenient(Double.self, .startedAt) ?? 0
            startedAt = start
            let ended = c.lenient(Double.self, .endedAt) ?? 0
            endedAt = ended
            plannedEndsAt = c.lenient(Double.self, .plannedEndsAt) ?? ended
            stopped = c.lenient(Bool.self, .stopped) == true
            window = c.lenient(Bool.self, .window) == true ? true : nil
            cuts = Focus.cleanCuts(c.lenient(Double.self, .cuts))
            origin = Focus.cleanOrigin(c.lenient(Double.self, .origin), startedAt: start)
        }
    }

    /// Egy naplósor a futó menetből.
    public static func closeRun(
        _ run: Run, packName: String, endedAt: Double, stopped: Bool, window: Bool = false
    ) -> LogEntry {
        // A változat ismerete is a sorba kerül: a szinkron ebből tudja, melyik
        // változatot zárta le ez a sor.
        LogEntry(
            packId: run.packId, packName: packName, startedAt: run.startedAt,
            endedAt: endedAt, plannedEndsAt: run.endsAt, stopped: stopped,
            window: window ? true : nil, cuts: run.cuts, origin: run.origin
        )
    }

    /// Amit a lezárás ad vissza: az új napló, és a futás (mindig nil).
    public struct Close {
        public let run: Run?
        public let log: [LogEntry]
    }

    /// Egy LEJÁRT menet lezárása a naplóba.
    ///
    /// A magban van, nem a felületen, mert mind a három platformnak ugyanez
    /// kell. A `nil` azt jelenti: nincs teendő — így a hívó nyugodtan
    /// meghívhatja minden körben, fölösleges mentés nélkül.
    public static func closeIfEnded(
        _ run: Run?, packs: [Pack], log: [LogEntry], now: Double
    ) -> Close? {
        guard let run, run.endsAt <= now else { return nil }
        // A csomag NEVÉT is elmentjük, nem csak az azonosítóját: a csomag azóta
        // átnevezhető vagy törölhető: egy statisztika, ami a múlt hétre csak
        // ismeretlen csomagot ír ki, semmit nem ér.
        let name = packs.first { $0.id == run.packId }?.name ?? "Ismeretlen csomag"
        let entry = closeRun(run, packName: name, endedAt: run.endsAt, stopped: false,
                             window: isWindowRun(run, packs: packs))
        let rows: [LogEntry] = log + [entry]
        return Close(run: nil, log: Array(rows.suffix(maxFocusLog)))
    }

    public struct Summary: Equatable {
        /// hány menet zárult le az ablakban
        public let sessions: Int
        /// összesen ennyi ideig tartottak, ezredmásodpercben
        public let totalMs: Double
        /// ennyit állítottál le a tervezettnél korábban
        public let stoppedEarly: Int
        /// a leggyakoribb csomag neve, ha van
        public let topPack: String?
        /// ennyi indult a heti ablakból, magától — dolgozik-e az ablak
        public var windowRuns: Int = 0
    }

    /// Összegzés egy időablakra.
    ///
    /// A „korán leállítva” szándékosan nem szégyenpad: ha ötből négyszer
    /// leálltál, nem a csomaggal van baj, hanem a hosszal — rövidebb menetet
    /// érdemes indítani, és az működni fog.
    public static func summarizeFocus(
        _ log: [LogEntry], since: Double, now: Double
    ) -> Summary {
        let rows = log.filter { $0.endedAt >= since && $0.endedAt <= now }
        var totalMs: Double = 0
        var stoppedEarly = 0
        var windowRuns = 0
        var byPack: [String: Int] = [:]
        var order: [String] = []
        for e in rows {
            totalMs += max(0, e.endedAt - e.startedAt)
            // Nem a `stopped` jelző dönt, hanem a TÉNY: a próbatétel utáni
            // rövidítés is korai vég, akkor is, ha utána még futott egy darabig.
            if e.endedAt < e.plannedEndsAt { stoppedEarly += 1 }
            if e.window == true { windowRuns += 1 }
            if byPack[e.packName] == nil { order.append(e.packName) }
            byPack[e.packName, default: 0] += 1
        }
        var topPack: String?
        var best = 0
        for name in order where (byPack[name] ?? 0) > best {
            best = byPack[name] ?? 0
            topPack = name
        }
        return Summary(
            sessions: rows.count, totalMs: totalMs,
            stoppedEarly: stoppedEarly, topPack: topPack, windowRuns: windowRuns
        )
    }

    /// A HETI ABLAKBÓL indult menetek csomagonként az ablakban (azonosító → darab):
    /// a csomag sora ebből mondja, hányszor indult magától a héten — dolgozik-e
    /// az ablak. Csak az ablakos sorok; a régi sor nem ablak. A TS `windowRunsByPack` tükre.
    public static func windowRunsByPack(_ log: [LogEntry], since: Double, now: Double) -> [String: Int] {
        var out: [String: Int] = [:]
        for e in log where e.window == true && e.endedAt >= since && e.endedAt <= now {
            out[e.packId, default: 0] += 1
        }
        return out
    }

    /// Az ELŐZŐ hét menetei: a mai nap kezdete előtti tizenhárom naptól a hat
    /// nappal ezelőtti nap kezdetéig — azt már nem, az a mostani hét ablaka. A
    /// statisztika és a heti mondat a két hetet egymás mellé teszi: irány, nem ítélet.
    public static func summarizeFocusPrevWeek(_ log: [LogEntry], now: Double) -> Summary {
        let start = LocalCalendar.gregorian.startOfDay(for: Date(timeIntervalSince1970: now / 1000)).timeIntervalSince1970 * 1000
        return summarizeFocus(log, since: start - 13 * 86_400_000, now: start - 6 * 86_400_000 - 1)
    }

    /// A legutóbb használt csomag — a napló legfrissebb olyan sora szerint,
    /// amelynek a csomagja még megvan —, vagy az első, ha még nem volt menet;
    /// nil, ha nincs csomag. A javaslat gombja ezt indítja a szokásos hosszával:
    /// egy koppintás a mondattól a menetig. Az androidos `lastUsedPack` tükre.
    /// LE VAN-E FEDVE az óra: a sáv legalább egy napon az óra egy részét is átfogja.
    /// A csúcs-óra a hét órája, napra nem bontva — ezért elég, ha valamelyik napon
    /// fedi. Nap nélkül nem ablak. (Nem nyilvános: a sáv típusa belső, mint a
    /// `nextOccurrence`-nél — a nyilvános jelölés fordítási hiba lenne.)
    static func bandCoversHour(_ band: ScheduleLogic.Band, hour: Int) -> Bool {
        let h = min(23, max(0, hour))
        return !band.days.isEmpty && band.startMin < (h + 1) * 60 && band.endMin > h * 60
    }

    /// A csomag, amelynek heti ablaka fedi az órát (a csúcs-órát) — az első a listában; nil, ha egyik sem.
    static func packCoveringHour(_ packs: [Pack], hour: Int) -> Pack? {
        packs.first { p in p.recurrence.map { bandCoversHour($0, hour: hour) } ?? false }
    }

    /// ABLAK A CSÚCS-ÓRÁRA: a csúcs egy órája, minden napra — a gépi
    /// `peakWindowBand` tükre. A 23 óra vége a nap vége (1440), nem nulla:
    /// különben a sáv éjfélen átfordulna. (Nem nyilvános: a sáv típusa belső.)
    static func peakWindowBand(_ hour: Int) -> ScheduleLogic.Band {
        let h = min(23, max(0, hour))
        return ScheduleLogic.Band(days: [0, 1, 2, 3, 4, 5, 6], startMin: h * 60, endMin: (h + 1) * 60)
    }

    /// A csúcs-óra ablakának jelöltje az iPhone gombjához: (csomag, sáv) — vagy
    /// nil, ha nincs gomb. Ugyanazok a feltételek, mint a gépi gombé: van csúcs,
    /// semelyik csomag ablaka nem fedi, nem fut menet, és a legutóbb használt
    /// csomagnak nincs még ablaka (a telefon csak FELVESZ, nem cserél).
    static func peakWindowPick(
        _ packs: [Pack], log: [LogEntry], run: Run?, peakHour: Int?, now: Double
    ) -> (pack: Pack, band: ScheduleLogic.Band)? {
        guard let peakHour, packCoveringHour(packs, hour: peakHour) == nil, !isRunning(run, now: now),
              let pick = lastUsedPack(packs, log: log), pick.recurrence == nil else { return nil }
        return (pick, peakWindowBand(peakHour))
    }

    public static func lastUsedPack(_ packs: [Pack], log: [LogEntry]) -> Pack? {
        let byId = Dictionary(packs.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        // A legkésőbb indult sor, aminek a csomagja megvan; egyforma kezdésnél az
        // ELSŐ a naplóban — a gép stabil rendezésének eredménye, rendezés nélkül
        // (a Swift `sorted` stabilitása nincs kimondva).
        var best: (startedAt: Double, pack: Pack)?
        for e in log {
            guard let p = byId[e.packId] else { continue }
            if best == nil || e.startedAt > best!.startedAt { best = (startedAt: e.startedAt, pack: p) }
        }
        return best?.pack ?? packs.first
    }

    /// Fókuszban töltött idő NAPONTA az utolsó `count` napra, a legrégebbitől
    /// — a hét alakja a menetekre. Egy menet a VÉGÉNEK napjára számít
    /// egészben (nyolc óránál hosszabb menet nincs; a lezárás napja az, amire
    /// az ember emlékszik). Ugyanaz a nap-fogalom, mint a mérésnél. A focus.ts
    /// `focusDaySeries` tükre.
    public static func daySeries(_ log: [LogEntry], now: Double, count: Int) -> [(day: String, seconds: Double)] {
        let days = UsageStats.dayKeysBack(Date(timeIntervalSince1970: now / 1000), count)
        var totals: [String: Double] = [:]
        for d in days { totals[d] = 0 }
        for e in log where e.endedAt <= now {
            let key = UsageStats.dayKey(Date(timeIntervalSince1970: e.endedAt / 1000))
            guard totals[key] != nil else { continue }
            totals[key, default: 0] += max(0, e.endedAt - e.startedAt) / 1000
        }
        return days.map { (day: $0, seconds: (totals[$0] ?? 0).rounded()) }
    }

    /// A HÉT NAPJAI szerint: az utolsó 28 nap menetei a hét hét napjára osztva
    /// (0 = vasárnap) — a menet a végének napjára számít, mint a napi rajzon. A
    /// megakadások csúcs-napjának tükre: nem az, mikor csúszik a kéz, hanem az,
    /// mikor ülsz le. A minta hossza és a holtverseny szabálya a csúcs-napéval
    /// közös. A gépi `focusByWeekday` tükre.
    public static func byWeekday(_ log: [LogEntry], now: Double, count: Int = FilterHitLogic.peakWeekdayDays) -> [Int] {
        var by = [Int](repeating: 0, count: 7)
        let days = Set(UsageStats.dayKeysBack(Date(timeIntervalSince1970: now / 1000), count))
        for e in log where e.endedAt <= now {
            let d = Date(timeIntervalSince1970: e.endedAt / 1000)
            guard days.contains(UsageStats.dayKey(d)) else { continue }
            by[LocalCalendar.gregorian.component(.weekday, from: d) - 1] += 1
        }
        return by
    }

    /// „A négy hét menet-napja: kedd (6 menet).” — melyik napon ülsz le a legtöbbször.
    public static func weekdayText(_ peak: (day: Int, count: Int)) -> String {
        let name = peak.day >= 0 && peak.day < FilterHitLogic.weekdayNames.count ? FilterHitLogic.weekdayNames[peak.day] : "?"
        return "A négy hét menet-napja: \(name) (\(peak.count) menet)."
    }

    /// A MENET-ÓRA: az utolsó 28 nap menetei a nap huszonnégy órájára osztva, az
    /// INDULÁS órája szerint — a megakadások csúcs-órájának tükre: nem az, mikor
    /// jár a kéz magától, hanem az, mikor ülsz le. Négy hétből; a menet a
    /// végének napja szerint tartozik a mintába. A gépi `focusByHour` tükre.
    public static func byHour(_ log: [LogEntry], now: Double, count: Int = FilterHitLogic.peakWeekdayDays) -> [Int] {
        var by = [Int](repeating: 0, count: 24)
        let days = Set(UsageStats.dayKeysBack(Date(timeIntervalSince1970: now / 1000), count))
        for e in log where e.endedAt <= now {
            guard days.contains(UsageStats.dayKey(Date(timeIntervalSince1970: e.endedAt / 1000))) else { continue }
            by[LocalCalendar.gregorian.component(.hour, from: Date(timeIntervalSince1970: e.startedAt / 1000))] += 1
        }
        return by
    }

    /// A menet-óra: (óra, szám) — vagy nil. Holtversenynél a korábbi óra.
    public static func peakHour(_ byHour: [Int]) -> (hour: Int, count: Int)? {
        var best: (hour: Int, count: Int)?
        for (hour, count) in byHour.enumerated() where count > 0 {
            if best == nil || count > best!.count { best = (hour: hour, count: count) }
        }
        return best
    }

    /// „A négy hét menet-órája: 9–10 óra (6 menet).” — mikor ülsz le a legtöbbször.
    /// A fedés a szám mellett: „magától indul: …”, ha egy csomag heti ablaka fedi a menet-órát;
    /// „nincs rá ablak”, ha lehetne rá tenni. A fedés erősebb. Ha a menet-óra a csúcs-óra, a csúcs mondata mondja.
    public static func hourText(_ peak: (hour: Int, count: Int), pack: String? = nil, offer: Bool = false) -> String {
        let tail = pack.map { ", magától indul: \($0)" } ?? (offer ? ", nincs rá ablak" : "")
        return "A négy hét menet-órája: \(FilterHitLogic.hourLabel(peak.hour)) (\(peak.count) menet\(tail))."
    }

    /// MENET-SOROZAT: hány napja ülsz le minden nap — a ma (vagy ha ma még nem, a tegnap) végződő,
    /// megszakítás nélküli napok száma menettel (a menet a végének napjára számít). Egy nap nem sorozat.
    /// Tény, nem ítélet. A gépi tükör; a napok kulcsa a mérésé (délben lépve).
    public static func dayStreak(_ log: [LogEntry], now: Double) -> Int {
        let days = Set(log.filter { $0.endedAt <= now }.map { FilterHitLogic.dayKey($0.endedAt) })
        let back = UsageStats.dayKeysBack(Date(timeIntervalSince1970: now / 1000), 400).sorted(by: >)
        var i = (back.first.map { days.contains($0) } ?? false) ? 0 : 1
        var n = 0
        while i < back.count, days.contains(back[i]) { n += 1; i += 1 }
        return n
    }

    /// A LEGHOSSZABB SOROZAT: a napló leghosszabb, megszakítás nélküli napsora menettel — a mostani mércéje.
    public static func longestStreak(_ log: [LogEntry], now: Double) -> Int {
        let days = Set(log.filter { $0.endedAt <= now }.map { FilterHitLogic.dayKey($0.endedAt) }).sorted()
        var best = 0
        var run = 0
        var prev: String? = nil
        let cal = LocalCalendar.gregorian
        for k in days {
            let p = k.split(separator: "-").compactMap { Int($0) }
            guard p.count == 3, let noon = cal.date(from: DateComponents(year: p[0], month: p[1], day: p[2], hour: 12)),
                  let before = cal.date(byAdding: .day, value: -1, to: noon) else { continue }
            let yesterday = UsageStats.dayKey(before)
            run = prev == yesterday ? run + 1 : 1
            if run > best { best = run }
            prev = k
        }
        return best
    }

    /// „5 napja minden nap leültél.” — kettőtől; alatta nil. A leghosszabb sorozattal (ha nagyobb a
    /// mostaninál): „(a leghosszabb sorozatod: 12 nap)”; mostani nélkül csak a rekord.
    public static func streakText(_ n: Int, longest: Int = 0) -> String? {
        if n >= streakMinDays { return longest > n ? "\(n) napja minden nap leültél (a leghosszabb sorozatod: \(longest) nap)." : "\(n) napja minden nap leültél." }
        return longest >= streakMinDays ? "A leghosszabb sorozatod: \(longest) nap." : nil
    }

    /// AMIKOR A CSÚCS-ÓRA A MENET-ÓRA: a kéz ugyanabban az órában jár magától, amelyikben le szoktál ülni
    /// — a tükör két fele egy pontra mutat. Nil, ha nem esik egybe. Tény, nem ítélet.
    public static func sameHourText(_ peak: (hour: Int, count: Int)?, _ focusHour: (hour: Int, count: Int)?) -> String? {
        guard let peak, let focusHour, peak.hour == focusHour.hour else { return nil }
        return "A csúcs-óra és a menet-óra ugyanaz: \(FilterHitLogic.hourLabel(peak.hour)) — a kéz akkor jár, amikor le szoktál ülni."
    }

    /// AMIKOR A CSÚCS-NAP A MENET-NAP: a kéz azon a napon csúszik a legtöbbször, amelyiken le szoktál ülni
    /// — a tükör két fele egy napra mutat. Nil, ha nem esik egybe. Tény, nem ítélet.
    public static func sameDayText(_ peak: (day: Int, count: Int)?, _ focusDay: (day: Int, count: Int)?) -> String? {
        guard let peak, let focusDay, peak.day == focusDay.day else { return nil }
        let name = peak.day >= 0 && peak.day < FilterHitLogic.weekdayNames.count ? FilterHitLogic.weekdayNames[peak.day] : "?"
        return "A csúcs-nap és a menet-nap ugyanaz: \(name) — a kéz azon a napon csúszik, amelyiken le szoktál ülni."
    }

    /// MOST a menet-óra van-e: a négy hét menet-órája és a helyi óra egybeesik — és a minta elég (a csúcs-nap küszöbe).
    public static func isHourNow(_ peak: (hour: Int, count: Int)?, now: Double) -> Bool {
        guard let peak, peak.count >= FilterHitLogic.peakDayMinCount else { return false }
        return FilterHitLogic.hourOf(now) == peak.hour
    }

    /// A tükör a döntés órájában: a kezdőlap kártyája a menet-órában.
    public static func hourNowText(_ peak: (hour: Int, count: Int)) -> String {
        "Most a menet-órád van (\(FilterHitLogic.hourLabel(peak.hour)), \(peak.count) menet) — ilyenkor szoktál elkezdeni."
    }

    /// Az előjelzés mondata a menet-óra előtt — a csúcs-óra előjelzésének tükre; a kulcs és a küszöb a csúcs-óráé (FilterHitLogic.peakWarnKey).
    public static func hourWarnText(_ peak: (hour: Int, count: Int)) -> String {
        "Mindjárt \(peak.hour) óra — ilyenkor szoktál elkezdeni (\(peak.count) menet négy hét alatt). Egy munkamenet most segítene — te döntesz."
    }

    /// A tükör a döntés napján: a kezdőlap kártyája a menet-napon (a „ma van” szabálya a csúcs-napé: FilterHitLogic.isPeakDayNow).
    public static func dayNowText(_ peak: (day: Int, count: Int)) -> String {
        let name = peak.day >= 0 && peak.day < FilterHitLogic.weekdayNames.count ? FilterHitLogic.weekdayNames[peak.day] : "?"
        return "Ma a négy hét menet-napja van (\(name), \(peak.count) menet) — ilyenkor szoktál leülni."
    }

    /// Ahogy a felületen áll: „Nyelvtanulás — 42 perc van hátra”.
    public static func formatRemaining(_ ms: Double) -> String {
        let total = max(0, clampedInt((ms / 60_000).rounded(.up)))
        if total >= 60 {
            let h = total / 60
            let m = total % 60
            return m == 0 ? "\(h) óra" : "\(h) ó \(m) p"
        }
        return total <= 1 ? "kevesebb mint egy perc" : "\(total) perc"
    }

    private static func normalizedHost(_ host: String) -> String {
        var h = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while h.hasSuffix(".") { h.removeLast() }
        return h
    }

    // -----------------------------------------------------------------------
    // Ismétlődő munkamenet: a csomag magától indul egy heti ablakban.
    //
    // A `focus.ts` azonos nevű szakaszának tükre — az indoklás ott van. A
    // lényeg két mondat: AZ ABLAK AZ ÍGÉRET (a menet kezdése mindig az ablak
    // kezdete, így minden eszköz ugyanazt a menetet állítja elő), és A NAPLÓ
    // AZ ŐR (ami ebben az ablakban egyszer már indult, az nem indul újra —
    // a leállítás próbatétele különben egy percig érne).
    // -----------------------------------------------------------------------

    /// Ennél kevesebb hátralévő idővel már nem indul menetrend szerinti menet.
    public static let recurrenceMinRemainingMs: Double = 60_000

    /// Ennyivel a JÖVŐBEN véget ért naplósort még elfogadjuk (két eszköz órája
    /// ennyit eltérhet) — a `focus.ts` `FUTURE_LOG_TOLERANCE_MS`-ének tükre.
    public static let futureLogToleranceMs: Double = 5 * 60_000

    /// Az ablak SAJÁT menete van-e a naplóban — a `focus.ts` `spentIn` tükre.
    /// A jövőben véget ért sor nem számít: az óra előre-, majd
    /// visszaállításának nyoma, nem kifizetett menet.
    static func spentIn(_ log: [LogEntry], packId: String, occ: Occurrence, now: Double) -> Bool {
        // Az azonosság az EREDETI kezdés: a meghosszabbított ablak-menetet az
        // óra-ugrás elnyelése már eltolhatja, a sora mégis ehhez az ablakhoz tartozik.
        log.contains { $0.packId == packId && runOrigin($0) == occ.startsAt && $0.endedAt <= now + futureLogToleranceMs }
    }

    /// Egy ablak-előfordulás: mikor kezdődik és mikor ér véget (epoch ms).
    public struct Occurrence: Equatable {
        public let startsAt: Double
        public let endsAt: Double
    }

    /// A sáv hossza percben (éjfélen átnyúlva is).
    static func bandMinutes(_ b: ScheduleLogic.Band) -> Int {
        b.endMin > b.startMin ? b.endMin - b.startMin : 1440 - b.startMin + b.endMin
    }

    /// Kívülről jött ismétlődés használható alakja, vagy nil: érvényes sáv, és
    /// nem hosszabb egy menet plafonjánál — egy huszonnégy órás „ablak” nem
    /// munkamenet lenne, hanem egy kikapcsolhatatlan fehérlista.
    static func cleanRecurrence(_ b: ScheduleLogic.Band?) -> ScheduleLogic.Band? {
        guard let b, ScheduleLogic.isValidBand(b), bandMinutes(b) <= maxSessionMinutes else { return nil }
        // Rendezve, ismétlés nélkül — ahogy a gép és az Android is tárolja. A
        // [2, 1] és az [1, 2] ugyanaz az ablak; ha eltérésnek számítana, a
        // csomag fölöslegesen menne fel a kiszolgálóra.
        return ScheduleLogic.Band(days: Array(Set(b.days)).sorted(), startMin: b.startMin, endMin: b.endMin)
    }

    private static func localCalendar() -> Calendar {
        LocalCalendar.gregorian
    }

    /// Egy helyi időpont: a `now` napjától `dayOffset` nappal, `min` perccel éjfél után.
    private static func localAt(_ now: Double, dayOffset: Int, min: Int) -> Double? {
        let cal = localCalendar()
        let ymd = cal.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: now / 1000))
        var dc = DateComponents()
        dc.year = ymd.year
        dc.month = ymd.month
        // A naptár a túlcsordulást normalizálja (32-e a következő hónap
        // elseje), és mezőkkel számol: az óraátállás napján a 9:00 az a 9:00.
        dc.day = (ymd.day ?? 1) + dayOffset + min / 1440
        dc.hour = (min % 1440) / 60
        dc.minute = min % 60
        dc.second = 0
        return wallTime(cal, dc).map { $0.timeIntervalSince1970 * 1000 }
    }

    /// A kért falióra-idő pillanata a gép (JS) szabálya szerint: a kétszer
    /// előforduló időből (az őszi átállás órája) az ELSŐ, a kihagyottat
    /// (tavasszal a 2:xx) az átállás előtti eltolással olvasva, vagyis egy
    /// órával később. A Foundation ezt verziónként máshogy dönti el, ezért itt
    /// kimondva — különben egy hajnali heti ablak az iPhone-on más pillanatban
    /// indulna, mint a gépen. Lásd fixtures/dst-cases.json.
    private static func wallTime(_ cal: Calendar, _ dc: DateComponents) -> Date? {
        guard let d = cal.date(from: dc), let h = dc.hour, let m = dc.minute else { return nil }
        let got = cal.dateComponents([.hour, .minute], from: d)
        if got.hour != h || got.minute != m {
            // Kihagyott idő: egy órával korábbi falióra-idő (az még az átállás
            // előtt van), plusz egy óra — ez az átállás előtti eltolás.
            var e = dc
            if h > 0 {
                e.hour = h - 1
            } else {
                e.day = (dc.day ?? 1) - 1
                e.hour = 23
            }
            return cal.date(from: e)?.addingTimeInterval(3600) ?? d
        }
        // Kétszer előforduló idő: ha egy órával (vagy fél órával) korábban is
        // ugyanez a falióra-idő volt, az az első előfordulás.
        let wall: (Date) -> [Int] = { x in
            let c = cal.dateComponents([.year, .month, .day, .hour, .minute], from: x)
            return [c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0]
        }
        let mine = wall(d)
        for shift in [3600.0, 1800.0] {
            let earlier = d.addingTimeInterval(-shift)
            if wall(earlier) == mine { return earlier }
        }
        return d
    }

    /// A sáv MOSTANI előfordulása — vagy nil, ha `now` nincs benne.
    static func occurrenceAt(_ band: ScheduleLogic.Band, now: Double) -> Occurrence? {
        let c = localCalendar().dateComponents(
            [.weekday, .hour, .minute], from: Date(timeIntervalSince1970: now / 1000)
        )
        let day = (c.weekday ?? 1) - 1
        let minute = (c.hour ?? 0) * 60 + (c.minute ?? 0)
        let prevDay = (day + 6) % 7
        func occ(_ startOffset: Int, _ endOffset: Int) -> Occurrence? {
            guard let s = localAt(now, dayOffset: startOffset, min: band.startMin),
                  let e = localAt(now, dayOffset: endOffset, min: band.endMin) else { return nil }
            return Occurrence(startsAt: s, endsAt: e)
        }
        if band.endMin > band.startMin {
            if band.days.contains(day) && minute >= band.startMin && minute < band.endMin {
                return occ(0, 0)
            }
            return nil
        }
        if band.days.contains(day) && minute >= band.startMin { return occ(0, 1) }
        if band.days.contains(prevDay) && minute < band.endMin { return occ(-1, 0) }
        return nil
    }

    /// A sáv KÖVETKEZŐ előfordulása: a mostani, ha épp benne vagyunk, különben
    /// a legközelebbi kezdés a következő héten. A `focus.ts` `nextOccurrence`
    /// tükre — a felület ebből mondja meg, hogy egy kézi menetet félbeszakít-e
    /// egy másik csomag ablaka.
    static func nextOccurrence(_ band: ScheduleLogic.Band, now: Double) -> Occurrence? {
        if let live = occurrenceAt(band, now: now) { return live }
        for d in 0...7 {
            guard let start = localAt(now, dayOffset: d, min: band.startMin), start >= now else { continue }
            let weekday = (localCalendar().dateComponents([.weekday], from: Date(timeIntervalSince1970: start / 1000)).weekday ?? 1) - 1
            if !band.days.contains(weekday) { continue }
            if let occ = occurrenceAt(band, now: start) { return occ }
        }
        return nil
    }

    struct DueRecurrence {
        let pack: Pack
        let startsAt: Double
        let endsAt: Double
    }

    /// Melyik csomag ablaka esedékes MOST — vagy nil: az első a
    /// `dueRecurrences` listájából (a `focus.ts` tükre).
    static func dueRecurrence(
        _ packs: [Pack], run: Run?, log: [LogEntry], now: Double
    ) -> DueRecurrence? {
        dueRecurrences(packs, run: run, log: log, now: now).first
    }

    /// Az összes MOST esedékes ablak, a `dueRecurrence` rendjében: a korábban
    /// kezdődő, azonos kezdésnél a kisebb azonosítójú (kódegység szerint, mint
    /// a gépen) — hogy minden eszköz ugyanazt válassza.
    ///
    /// Nem esedékes, ha a csomag SAJÁT menete fut; ha a naplóban ott az ablak
    /// saját menete (leállítva vagy lerövidítve — a próbatétel ára ki van
    /// fizetve); vagy ha egy percnél kevesebb van hátra. Egy MÁSIK csomag
    /// menete alatt az ablak RÁRÉTEGZŐDIK (`effectivePack`): a menet nem áll
    /// le, de amíg az ablak tart, csak az mehet, amit mindkét csomag enged. A
    /// menete akkor indul, ha a futó menet véget ér (`windowRunFor`).
    static func dueRecurrences(
        _ packs: [Pack], run: Run?, log: [LogEntry], now: Double
    ) -> [DueRecurrence] {
        var out: [DueRecurrence] = []
        for pack in packs {
            guard let band = pack.recurrence, ScheduleLogic.isValidBand(band) else { continue }
            // A csomag SAJÁT futó menete mellett nincs mit indítani, és önmagára
            // nem is rétegződik.
            if let run, isRunning(run, now: now), run.packId == pack.id { continue }
            guard let occ = occurrenceAt(band, now: now) else { continue }
            if occ.endsAt - now < recurrenceMinRemainingMs { continue }
            // Csak az ablak SAJÁT menete (a kezdése az ablak kezdése) számít
            // elköltöttnek: a csomag egyperces kézi menete az ablakon belül nem
            // váltja ki a háromórás ablakot.
            if spentIn(log, packId: pack.id, occ: occ, now: now) { continue }
            out.append(DueRecurrence(pack: pack, startsAt: occ.startsAt, endsAt: occ.endsAt))
        }
        return out.sorted { x, y in
            x.startsAt != y.startsAt ? x.startsAt < y.startsAt : TextLogic.utf16Less(x.pack.id, y.pack.id)
        }
    }

    /// A futó menet alatt MOST hatásos csomag — vagy nil, ha nem fut menet
    /// (vagy a csomagja nincs meg). A `focus.ts` `effectivePack`-jének tükre.
    ///
    /// A menet csomagja, és ha közben egy MÁSIK csomag heti ablaka is tart (és
    /// az ablakot nem állították le), annak a fehérlistája IS: METSZET. Eddig az
    /// ablak a kezdetén leállította a futó kézi menetet — és mivel ablakot
    /// felvenni ingyen van, egy most kezdődő, kétperces ablak egy laza csomagra
    /// próbatétel nélkül véget vetett egy kétórás menetnek. Most egyik sem enged
    /// a másikból; egy 8:59-kor indított, laza „eldobható” menet sem váltja ki
    /// az ablakot. A neve és a hossza a menet csomagjáé.
    static func effectivePack(
        _ packs: [Pack], run: Run?, log: [LogEntry], now: Double
    ) -> Pack? {
        guard let run, isRunning(run, now: now),
              let own = packs.first(where: { $0.id == run.packId }) else { return nil }
        var out = own
        for due in dueRecurrences(packs, run: run, log: log, now: now) { out = intersectPacks(out, due.pack) }
        return out
    }

    /// Két csomag fehérlistájának metszete — az első neve, hossza és ablaka
    /// marad. Az oldal-lista PONTOS metszet az aldomain-szabállyal; az
    /// app-lista a laza app-egyezés miatt csak közelítés. Az ismétlődés a
    /// kódegységes egyezés (a gép `indexOf`-ja), nem a Swift kanonikus `==`-je.
    static func intersectPacks(_ a: Pack, _ b: Pack) -> Pack {
        func add(_ x: String, to list: inout [String]) {
            if !list.contains(where: { TextLogic.sameScalars($0, x) }) { list.append(x) }
        }
        var sites: [String] = []
        for s in a.allowSites where isSiteAllowed(b, host: s) { add(s, to: &sites) }
        for s in b.allowSites where isSiteAllowed(a, host: s) { add(s, to: &sites) }
        var apps: [String] = []
        for x in a.allowApps where isAppAllowed(b, app: x) { add(x, to: &apps) }
        for x in b.allowApps where isAppAllowed(a, app: x) { add(x, to: &apps) }
        return Pack(
            id: a.id, name: a.name, allowSites: sites, allowApps: apps,
            defaultMinutes: a.defaultMinutes, recurrence: a.recurrence
        )
    }

    /// Az esedékes ablak menete: az ablak végéig — és az ablak kezdetétől, vagy
    /// ha az ablakban előbb egy másik menet futott (az ablak arra
    /// rárétegződött), ott kezdődik, ahol az véget ért. Különben a napló
    /// ugyanazt az órát kétszer írná. Az azonossága ilyenkor is az ablak
    /// kezdete (`origin`). A `focus.ts` `windowRunFor`-jának tükre.
    static func windowRunFor(_ due: DueRecurrence, log: [LogEntry], now: Double) -> Run {
        var start = due.startsAt
        for e in log {
            if e.endedAt > start && e.endedAt <= now { start = e.endedAt }
        }
        return start > due.startsAt
            ? Run(packId: due.pack.id, startedAt: start, endsAt: due.endsAt, origin: due.startsAt)
            : Run(packId: due.pack.id, startedAt: due.startsAt, endsAt: due.endsAt)
    }

    /// Ennyivel a heti ablak menete előtt szól az app — ugyanannyival, mint a
    /// zárlat-ablak beérése előtt (`LockdownLogic.windowPreWarnMs`).
    public static let windowSoonMs: Double = 10 * 60_000

    /// A legközelebb induló heti ablak menete, ha `within`-en belül indul —
    /// vagy nil. A `focus.ts` `windowRunStartingSoon`-jának tükre: ami már
    /// tart, arról nem szól; a csomag saját futó menete mellett sem (az ablak
    /// mellé úgysem indul új); az elköltött előfordulásról sem. Egy másik
    /// csomag menete nem hallgattatja el — az ablak arra rárétegződik
    /// (`effectivePack`), és amit a menet eddig engedett, az ablak alatt
    /// zárulhat. Több közül a korábban induló, azonos kezdésnél a kisebb
    /// azonosítójú.
    static func windowRunStartingSoon(
        _ packs: [Pack], run: Run?, log: [LogEntry], now: Double, within: Double = windowSoonMs
    ) -> DueRecurrence? {
        var best: DueRecurrence?
        for pack in packs {
            guard let band = pack.recurrence, ScheduleLogic.isValidBand(band) else { continue }
            if let run, isRunning(run, now: now), run.packId == pack.id { continue }
            guard let occ = nextOccurrence(band, now: now), occ.startsAt > now, occ.startsAt - now <= within else { continue }
            if spentIn(log, packId: pack.id, occ: occ, now: now) { continue }
            if let b = best,
               !(occ.startsAt < b.startsAt || (occ.startsAt == b.startsAt && TextLogic.utf16Less(pack.id, b.pack.id))) {
                continue
            }
            best = DueRecurrence(pack: pack, startsAt: occ.startsAt, endsAt: occ.endsAt)
        }
        return best
    }

    /// Az értesítés címe — ugyanaz mindhárom platformon.
    public static let windowSoonTitle = "Breaker — mindjárt indul a munkamenet"

    /// Az értesítés szövege, például:
    /// „Nyelvtanulás: 10 perc múlva indul a heti ablak szerint, 18:50-ig. …”
    /// A perc felfelé kerekít, legalább egy; a vég órája a hívó helyi alakjában jön.
    static func windowSoonText(_ name: String, leftMs: Double, endClock: String) -> String {
        let minutes = max(1, clampedInt((leftMs / 60_000).rounded(.up)))
        return "\(name): \(minutes) perc múlva indul a heti ablak szerint, \(endClock)-ig. "
            + "Amíg tart, csak a csomagban felsoroltak mehetnek — ami nyitva van, mentsd el."
    }

    /// Az ablak-menetek emlékeztetőinek azonosító-eleje — ezzel szedi le az app a régieket.
    static let windowReminderIdPrefix = "focus-window:"

    /// A heti ablakok menete előtti emlékeztetők TERVE: minden ablakos csomag
    /// minden napjára egy, tíz perccel a kezdés előtt — heti ismétlődő kérés,
    /// mert iPhone-on az app nem fut a háttérben. A rendszer keretéből annyi
    /// jut, amennyi a zárlat-ablakok terve (`used`) és a többi emlékeztető
    /// tartaléka után marad; ha nem fér be mind, egy sem kerül fel — egy
    /// félig ütemezett hét (hétfőn szól, csütörtökön nem) rosszabb a kimondott
    /// hiánynál. Őszinte határ: előre ütemezett, tehát akkor is szól, ha a
    /// csomag menete épp kézzel fut. Itt van, nem az appban, hogy a tervet a
    /// tesztek is lássák: az app-célt a CI nem futtatja.
    static func windowReminderPlan(_ packs: [Pack], used: Int) -> [LockdownLogic.Reminder] {
        let lead = Int(windowSoonMs / 60_000)
        var out: [LockdownLogic.Reminder] = []
        for pack in packs.sorted(by: { TextLogic.utf16Less($0.id, $1.id) }) {
            guard let band = pack.recurrence, ScheduleLogic.isValidBand(band) else { continue }
            for day in Array(Set(band.days)).sorted() {
                let s = LockdownLogic.reminderSlot(day: day, startMin: band.startMin, lead: lead)
                out.append(LockdownLogic.Reminder(
                    id: "\(windowReminderIdPrefix)\(pack.id):\(day)", weekday: s.weekday, hour: s.hour, minute: s.minute,
                    title: windowSoonTitle,
                    body: windowSoonText(pack.name, leftMs: windowSoonMs, endClock: LockdownLogic.clockLabel(band.endMin))))
            }
        }
        let room = LockdownLogic.maxPendingReminders - LockdownLogic.reservedReminders - used
        return out.count <= room ? out : []
    }

    /// Az ismétlődés kulcsa a lenyomatokhoz: napok rendezve, kezdés, vég — vagy „-”.
    static func recurrenceKey(_ b: ScheduleLogic.Band?) -> String {
        guard let b else { return "-" }
        let days: [String] = b.days.sorted().map { String($0) }
        return "\(days.joined(separator: ","))/\(b.startMin)-\(b.endMin)"
    }

    /// Ablak-menet-e ez a futás: a csomag ismétlődésének egy előfordulása,
    /// pontosan annak kezdésével (az EREDETI kezdés, `runOrigin` — a
    /// rárétegződés után később induló ablak-menet is az; lásd
    /// `windowRunFor`) és végével. Az óra-ugrás elnyelése az ilyet nem tolja el
    /// — az ablak vége az ablak vége.
    static func isWindowRun(_ run: Run, packs: [Pack]) -> Bool {
        let start = runOrigin(run)
        guard let band = packs.first(where: { $0.id == run.packId })?.recurrence,
              let occ = occurrenceAt(band, now: start) else { return false }
        return occ.startsAt == start && occ.endsAt == run.endsAt
    }
}
