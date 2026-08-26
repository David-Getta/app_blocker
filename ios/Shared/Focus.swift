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

        public init(
            id: String, name: String, allowSites: [String],
            allowApps: [String], defaultMinutes: Int
        ) {
            self.id = id
            self.name = name
            self.allowSites = allowSites
            self.allowApps = allowApps
            self.defaultMinutes = defaultMinutes
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
        case blockedByFocus
    }

    /// Átmehet-e ez a név most.
    ///
    /// A sorrend nem esztétika, hanem a szabályrendszer:
    ///
    ///   1. A BLOKKLISTA MINDIG NYER. A munkamenet sosem old fel semmit — csak
    ///      hozzátesz. Ha ez fordítva lenne, egy csomagba felvett `youtube.com`
    ///      feloldaná a tiltott YouTube-ot, próbatétel nélkül.
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
        syncHost: String? = nil
    ) -> Verdict {
        let h = normalizedHost(qname)
        if Blocklist.matches(h, blocked: blocked) { return .blockedByList }
        guard isRunning(run, now: now), let pack else { return .allow }
        if isSiteAllowed(pack, host: h) { return .allow }
        if isInfrastructure(h) { return .allow }
        if let syncHost {
            let sh = normalizedHost(syncHost)
            if !sh.isEmpty, h == sh || h.hasSuffix(".\(sh)") { return .allow }
        }
        return .blockedByFocus
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

        public init(
            packId: String, packName: String, startedAt: Double,
            endedAt: Double, plannedEndsAt: Double, stopped: Bool
        ) {
            self.packId = packId
            self.packName = packName
            self.startedAt = startedAt
            self.endedAt = endedAt
            self.plannedEndsAt = plannedEndsAt
            self.stopped = stopped
        }
    }

    /// Egy naplósor a futó menetből.
    public static func closeRun(
        _ run: Run, packName: String, endedAt: Double, stopped: Bool
    ) -> LogEntry {
        LogEntry(
            packId: run.packId, packName: packName, startedAt: run.startedAt,
            endedAt: endedAt, plannedEndsAt: run.endsAt, stopped: stopped
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
        let entry = closeRun(run, packName: name, endedAt: run.endsAt, stopped: false)
        return Close(run: nil, log: (log + [entry]).suffix(maxFocusLog).map { $0 })
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
        var byPack: [String: Int] = [:]
        var order: [String] = []
        for e in rows {
            totalMs += max(0, e.endedAt - e.startedAt)
            // Nem a `stopped` jelző dönt, hanem a TÉNY: a próbatétel utáni
            // rövidítés is korai vég, akkor is, ha utána még futott egy darabig.
            if e.endedAt < e.plannedEndsAt { stoppedEarly += 1 }
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
            stoppedEarly: stoppedEarly, topPack: topPack
        )
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
}
