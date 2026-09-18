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
    }

    public struct Run: Codable, Equatable {
        public let packId: String
        public let startedAt: Double
        /// mikor jár le magától
        public let endsAt: Double

        public init(packId: String, startedAt: Double, endsAt: Double) {
            self.packId = packId
            self.startedAt = startedAt
            self.endsAt = endsAt
        }
    }

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

    /// Percek -> használható hossz, vagy nil.
    public static func normalizeMinutes(_ value: Double?) -> Int? {
        guard let value, value.isFinite else { return nil }
        let rounded = Int(value.rounded())
        if rounded < 1 { return nil }
        return min(rounded, maxSessionMinutes)
    }

    /// Egy engedélyezett oldal megtisztítása — ugyanazon a magon, mint a
    /// blokklista, hogy ami itt engedve van, ugyanazt a hosztot jelentse.
    public static func normalizeAllowSite(_ input: String) -> String? {
        Blocklist.normalizeDomain(input)
    }

    public static func normalizeAllowApp(_ input: String) -> String? {
        let collapsed = input
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        if collapsed.isEmpty { return nil }
        return String(collapsed.prefix(64))
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
        let a = app.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if a.isEmpty { return false }
        return pack.allowApps.contains {
            let y = $0.lowercased()
            return a == y || a.contains(y) || y.contains(a)
        }
    }

    /// A hosszabbítás INGYEN van, a rövidítés próbatétel — a szigorítás
    /// irányába mindenhol szabad az út.
    public static func isSessionLoosening(currentEndsAt: Double, nextEndsAt: Double) -> Bool {
        nextEndsAt < currentEndsAt
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

        public init(
            packId: String, packName: String, startedAt: Double,
            endedAt: Double, plannedEndsAt: Double, stopped: Bool, window: Bool? = nil
        ) {
            self.packId = packId
            self.packName = packName
            self.startedAt = startedAt
            self.endedAt = endedAt
            self.plannedEndsAt = plannedEndsAt
            self.stopped = stopped
            self.window = window
        }
    }

    /// Egy naplósor a futó menetből.
    public static func closeRun(
        _ run: Run, packName: String, endedAt: Double, stopped: Bool, window: Bool = false
    ) -> LogEntry {
        LogEntry(
            packId: run.packId, packName: packName, startedAt: run.startedAt,
            endedAt: endedAt, plannedEndsAt: run.endsAt, stopped: stopped,
            window: window ? true : nil
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
        let start = Calendar.current.startOfDay(for: Date(timeIntervalSince1970: now / 1000)).timeIntervalSince1970 * 1000
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
        for e in log.sorted(by: { $0.startedAt > $1.startedAt }) {
            if let p = byId[e.packId] { return p }
        }
        return packs.first
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
            by[Calendar.current.component(.weekday, from: d) - 1] += 1
        }
        return by
    }

    /// „A négy hét menet-napja: kedd (6 menet).” — melyik napon ülsz le a legtöbbször.
    public static func weekdayText(_ peak: (day: Int, count: Int)) -> String {
        let name = peak.day >= 0 && peak.day < FilterHitLogic.weekdayNames.count ? FilterHitLogic.weekdayNames[peak.day] : "?"
        return "A négy hét menet-napja: \(name) (\(peak.count) menet)."
    }

    /// Ahogy a felületen áll: „Nyelvtanulás — 42 perc van hátra”.
    public static func formatRemaining(_ ms: Double) -> String {
        let total = max(0, Int((ms / 60_000).rounded(.up)))
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
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone.current
        return cal
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
        return cal.date(from: dc).map { $0.timeIntervalSince1970 * 1000 }
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

    /// Melyik csomag ablaka esedékes MOST — vagy nil. Nem indul, ha a csomag
    /// saját menete fut; ha a naplóban ott az ablak saját menete; vagy ha egy
    /// percnél kevesebb van hátra. Egy másik csomag menete nem tartja vissza —
    /// azt a kör zárja le. Több közül a korábban kezdődő, azonos kezdésnél a
    /// kisebb azonosítójú.
    static func dueRecurrence(
        _ packs: [Pack], run: Run?, log: [LogEntry], now: Double
    ) -> DueRecurrence? {
        var best: DueRecurrence?
        for pack in packs {
            guard let band = pack.recurrence, ScheduleLogic.isValidBand(band) else { continue }
            // A csomag SAJÁT futó menete mellett nincs mit indítani. Egy MÁSIK
            // csomag kézi menete nem tartja vissza az ablakot: a hívó (a kör)
            // zárja le az ablak kezdetén — különben egy 8:59-kor indított,
            // nyolcórás eldobható menet az egész ablakot kiváltaná.
            if let run, isRunning(run, now: now), run.packId == pack.id { continue }
            guard let occ = occurrenceAt(band, now: now) else { continue }
            if occ.endsAt - now < recurrenceMinRemainingMs { continue }
            // Csak az ablak SAJÁT menete (a kezdése az ablak kezdése) számít
            // elköltöttnek: a csomag egyperces kézi menete az ablakon belül nem
            // váltja ki a háromórás ablakot.
            let spent = log.contains { $0.packId == pack.id && $0.startedAt == occ.startsAt }
            if spent { continue }
            if let b = best,
               !(occ.startsAt < b.startsAt || (occ.startsAt == b.startsAt && pack.id < b.pack.id)) {
                continue
            }
            best = DueRecurrence(pack: pack, startsAt: occ.startsAt, endsAt: occ.endsAt)
        }
        return best
    }

    /// Az ismétlődés kulcsa a lenyomatokhoz: napok rendezve, kezdés, vég — vagy „-”.
    static func recurrenceKey(_ b: ScheduleLogic.Band?) -> String {
        guard let b else { return "-" }
        let days: [String] = b.days.sorted().map { String($0) }
        return "\(days.joined(separator: ","))/\(b.startMin)-\(b.endMin)"
    }

    /// Ablak-menet-e ez a futás: a csomag ismétlődésének egy előfordulása,
    /// pontosan annak kezdésével és végével. Az óra-ugrás elnyelése az ilyet
    /// nem tolja el — az ablak vége az ablak vége.
    static func isWindowRun(_ run: Run, packs: [Pack]) -> Bool {
        guard let band = packs.first(where: { $0.id == run.packId })?.recurrence,
              let occ = occurrenceAt(band, now: run.startedAt) else { return false }
        return occ.startsAt == run.startedAt && occ.endsAt == run.endsAt
    }
}
