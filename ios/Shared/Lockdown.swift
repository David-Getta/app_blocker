import Foundation

/// Zárlat — a desktop/src/shared/lockdown.ts tükre.
///
/// Az az időszak, amikor a lazítás nem drága, hanem NEM LÉTEZIK: a bíró el sem
/// indít próbatételt rá. Eddig minden lazításnak volt ára, tehát útja is; ez az
/// egyetlen művelet az egész appban, aminek nincs visszaútja.
///
/// Indítani ingyen van, hosszabbítani ingyen van. Rövidíteni, visszavonni,
/// kivételt tenni sehogy sem lehet — se gombbal, se próbatétellel.
///
/// Nem lakatolja le a telefont, és nem is állítjuk, hogy megtenné: az app
/// letörölhető. Az appon BELÜL zár le mindent, vagyis az impulzus ellen véd.
///
/// Ha itt változtatsz, a TS és a Kotlin ikren is.
public enum LockdownLogic {

    /// Egy zárlat legfeljebb ennyi lehet. Ami ennél hosszabb, az már nem döntés.
    static let maxLockdownDays = 30
    static let maxLockdownMs: Double = 30 * 24 * 3_600_000

    /// A felület gyorsgombjai, percben. A leghosszabb szándékosan egy hét.
    static let lockdownChoicesMin = [60, 180, 8 * 60, 24 * 60, 3 * 24 * 60, 7 * 24 * 60]

    /// A futó zárlat. A `startedAt` nem dísz: ebből látszik, mennyi telt el és
    /// mennyi van hátra — egy puszta határidő mellett a hosszú zárlat első
    /// napja ugyanúgy néz ki, mint az utolsó.
    /// `public`, mert a `FocusSync.SyncFocus` (ami maga is public) hordozza:
    /// egy public tulajdonság típusa nem lehet belső, a fordító elutasítja.
    public struct Lockdown: Codable, Equatable {
        public let startedAt: Double
        public let until: Double

        public init(startedAt: Double, until: Double) {
            self.startedAt = startedAt
            self.until = until
        }

        enum CodingKeys: String, CodingKey {
            case startedAt
            case until
        }
    }

    /// Tart-e most zárlat.
    static func isLocked(_ l: Lockdown?, _ now: Double) -> Bool {
        guard let l = l, l.until.isFinite else { return false }
        return l.until > now
    }

    /// Csak az ÉLŐ zárlat — a lejárt nincs. A szinkron határán kell: ha a
    /// helyi oldal nem viszi fel a lejártat, a lejövőt viszont átvenné, a kettő
    /// minden körben különbözne, és a telefon örökké változást látna.
    static func live(_ l: Lockdown?, _ now: Double) -> Lockdown? {
        isLocked(l, now) ? l : nil
    }

    /// Mennyi van még hátra, ms-ben. Nulla, ha nincs zárlat.
    static func remainingMs(_ l: Lockdown?, _ now: Double) -> Double {
        isLocked(l, now) ? l!.until - now : 0
    }

    /// Zárlat indítása vagy hosszabbítása `ms` időre MOSTTÓL.
    ///
    /// Az eredmény SOSEM rövidebb a mostaninál: ez az egyetlen út a mezőhöz, és
    /// így a rövidítés nem elfelejtett ellenőrzés kérdése, hanem
    /// megfogalmazhatatlan.
    static func start(_ cur: Lockdown?, _ ms: Double, _ now: Double) -> Lockdown? {
        guard ms.isFinite, ms > 0, now.isFinite else { return cur }
        let want = now + min(ms.rounded(), maxLockdownMs)
        if isLocked(cur, now) {
            return want > cur!.until ? Lockdown(startedAt: cur!.startedAt, until: want) : cur!
        }
        return Lockdown(startedAt: now, until: want)
    }

    /// Két eszköz zárlata EGGYÉ fésülve: a KÉSŐBBI vég nyer.
    ///
    /// Nem versenyhelyzet-feloldás, hanem maga a szabály: a zárlat szigorítás,
    /// tehát a szinkron sosem viheti vissza. Azonos végnél a korábbi kezdés az
    /// igaz — az mutatja a teljes hosszt.
    static func merge(_ a: Lockdown?, _ b: Lockdown?) -> Lockdown? {
        guard let a = a else { return b }
        guard let b = b else { return a }
        if b.until > a.until { return b }
        if a.until > b.until { return a }
        return a.startedAt <= b.startedAt ? a : b
    }

    /// A dróton érkezett zárlat beolvasása. Minden mező gyanús: másik eszköz
    /// írta. Ami nem értelmes, az nincs.
    static func parse(_ raw: Any?) -> Lockdown? {
        guard let o = raw as? [String: Any] else { return nil }
        let untilNum = (o["until"] as? Double) ?? (o["until"] as? NSNumber)?.doubleValue
        guard let end = untilNum, end.isFinite, end > 0 else { return nil }
        let startNum = (o["startedAt"] as? Double) ?? (o["startedAt"] as? NSNumber)?.doubleValue
        let start: Double
        if let s = startNum, s.isFinite, s > 0 {
            start = s
        } else {
            start = end
        }
        return Lockdown(startedAt: min(start, end), until: end)
    }

    /// Magyar, olvasható hátralévő idő: 6 nap 3 óra, 2 ó 15 p, 4 perc.
    ///
    /// A zárlat hossza napokban is mérhető, ezért nem a percre pontos alak kell
    /// — aki hét napot zárt le, annak a másodpercek csak nézegetnivalót adnának.
    static func formatRemaining(_ ms: Double) -> String {
        let total = Int(max(0, (ms / 1000).rounded(.up)))
        let days = total / 86_400
        let hours = (total % 86_400) / 3600
        let mins = (total % 3600) / 60
        if days > 0 {
            return hours > 0 ? "\(days) nap \(hours) óra" : "\(days) nap"
        }
        if hours > 0 {
            return mins > 0 ? "\(hours) ó \(mins) p" : "\(hours) óra"
        }
        return "\(max(1, mins)) perc"
    }

    // MARK: - zárlat-ablak
    //
    // Heti ablak, amiben a zárlat MAGÁTÓL él: például hétköznap 9-től 17-ig.
    // Nem új érvényesítés, hanem egy időzítő a meglévő elé: a kör az ablak
    // végéig szóló zárlatot ír, és onnantól minden ugyanaz. Az iPhone az
    // ablakot hordozza, fésüli és érvényesíti; szerkeszteni a gépen lehet.
    // A lockdown.ts ablak-részének tükre; lásd docs/feature-lockdown-windows.md.

    /// Ennél több ablak nem fér ki — és nem is kell: hét nap van.
    static let maxLockdownWindows = 7
    /// Legalább ennyi szabad perc kell a héten az ablakok mellett. Enélkül az
    /// ablakot sosem lehetne levenni — az nem döntés lenne, hanem csapda.
    static let minFreeMinutesPerWeek = 60
    /// Ennyivel a heti ablak beérése előtt szólunk egyszer — ami nyitva van, mentsd el.
    static let windowPreWarnMs: Double = 10 * 60_000
    /// Az ablak azonosítója legfeljebb ennyi karakter — kívülről jött szöveg.
    private static let maxWindowId = 40

    /// Egy zárlat-ablak: a sáv mezői (napok, kezdés, vég) és az azonosító, ami a
    /// felületé. `public`, mert a `FocusSync.SyncFocus` hordozza.
    public struct LockdownWindow: Codable, Equatable {
        public let id: String
        public let days: [Int]
        public let startMin: Int
        public let endMin: Int

        public init(id: String, days: [Int], startMin: Int, endMin: Int) {
            self.id = id
            self.days = days
            self.startMin = startMin
            self.endMin = endMin
        }

        var band: ScheduleLogic.Band { ScheduleLogic.Band(days: days, startMin: startMin, endMin: endMin) }

        enum CodingKeys: String, CodingKey {
            case id
            case days
            case startMin
            case endMin
        }
    }

    /// Az ablak tartalmi kulcsa: napok (rendezve), kezdés, vég.
    static func windowKey(_ b: ScheduleLogic.Band) -> String {
        let days: [String] = b.days.sorted().map { String($0) }
        return "\(days.joined(separator: ","))/\(b.startMin)/\(b.endMin)"
    }

    /// Egy kívülről jött ablak használható alakja, vagy nil.
    static func cleanWindow(_ w: LockdownWindow?) -> LockdownWindow? {
        guard let w, !w.id.isEmpty, w.id.count <= maxWindowId else { return nil }
        let days = Array(Set(w.days.filter { (0...6).contains($0) })).sorted()
        let band = ScheduleLogic.Band(days: days, startMin: w.startMin, endMin: w.endMin)
        guard ScheduleLogic.isValidBand(band) else { return nil }
        return LockdownWindow(id: w.id, days: days, startMin: w.startMin, endMin: w.endMin)
    }

    /// Egy lista használható alakja: csak érvényes ablakok, azonosító és
    /// tartalom szerint is egyszer, legfeljebb a plafonig. A duplát az első nyeri.
    static func cleanWindows(_ raw: [LockdownWindow]) -> [LockdownWindow] {
        var out: [LockdownWindow] = []
        var ids = Set<String>()
        var keys = Set<String>()
        for item in raw {
            guard let w = cleanWindow(item) else { continue }
            let key = windowKey(w.band)
            if ids.contains(w.id) || keys.contains(key) { continue }
            if out.count >= maxLockdownWindows { break }
            ids.insert(w.id)
            keys.insert(key)
            out.append(w)
        }
        return out
    }

    /// Ugyanaz-e a két lista tartalmilag (az azonosító nem számít).
    static func sameWindows(_ a: [ScheduleLogic.Band], _ b: [ScheduleLogic.Band]) -> Bool {
        a.map(windowKey).sorted() == b.map(windowKey).sorted()
    }

    /// Marad-e szabad idő a héten az ablakok mellett — percenkénti mintavétellel.
    static func weekHasFreeTime(_ windows: [ScheduleLogic.Band], _ now: Double) -> Bool {
        if windows.isEmpty { return true }
        var free = 0
        for i in 0..<(7 * 24 * 60) {
            if !ScheduleLogic.inAnyBand(windows, now + Double(i) * 60_000) {
                free += 1
                if free >= minFreeMinutesPerWeek { return true }
            }
        }
        return false
    }

    /// LAZÍTÁS-e a lista cseréje: van-e perc a következő héten, amikor a régi
    /// lista zárlatot tartana, az új nem. Az üres lista külön eset: a menetrend
    /// normalizálója az üres sávlistát „mindig tiltva”-ként érti.
    static func isWindowsLoosening(_ current: [ScheduleLogic.Band], _ next: [ScheduleLogic.Band], _ now: Double) -> Bool {
        if current.isEmpty { return false }
        if next.isEmpty { return true }
        return ScheduleLogic.isLoosening(
            ScheduleLogic.Schedule(mode: .block, bands: current),
            ScheduleLogic.Schedule(mode: .block, bands: next),
            now
        )
    }

    /// Az ÉLŐ ablak MOSTANI előfordulása — több közül a legkésőbb végződő.
    static func dueWindow(_ windows: [ScheduleLogic.Band], _ now: Double) -> Focus.Occurrence? {
        var best: Focus.Occurrence?
        for w in windows {
            guard ScheduleLogic.isValidBand(w), let occ = Focus.occurrenceAt(w, now: now) else { continue }
            if let b = best, !(occ.endsAt > b.endsAt || (occ.endsAt == b.endsAt && occ.startsAt < b.startsAt)) {
                continue
            }
            best = occ
        }
        return best
    }

    /// A zárlat, amit az ablakok MOST megkövetelnek — vagy nil, ha a meglévő
    /// elég. A kezdés az ablak kezdése, ha nem futott zárlat (így két eszköz
    /// ugyanazt állítja elő); futó zárlat mellett a futóé marad, az ablak csak
    /// a végét tolja ki. A lockdown.ts `windowLockdown` tükre.
    static func windowLockdown(_ cur: Lockdown?, _ windows: [ScheduleLogic.Band], _ now: Double) -> Lockdown? {
        guard let occ = dueWindow(windows, now) else { return nil }
        if isLocked(cur, now) && cur!.until >= occ.endsAt { return nil }
        return Lockdown(startedAt: isLocked(cur, now) ? cur!.startedAt : occ.startsAt, until: occ.endsAt)
    }

    /// Ablak-zárlat-e ez: a vége pontosan egy ablak-előfordulás vége. Az ilyet
    /// az óra-ugrás elnyelése nem tolja el — az ablak vége az ablak vége. A
    /// VÉG dönt, nem a kezdés: az ablak előtt indított kézi zárlatot az ablak
    /// csak kitolja. A lockdown.ts `isWindowLockdown` tükre.
    static func isWindowLockdown(_ l: Lockdown, _ windows: [ScheduleLogic.Band]) -> Bool {
        for w in windows {
            guard ScheduleLogic.isValidBand(w) else { continue }
            // Egy ezredmásodperccel a vég előtt még az ablakban vagyunk.
            if let occ = Focus.occurrenceAt(w, now: l.until - 1), occ.endsAt == l.until { return true }
        }
        return false
    }

    /// Két eszköz ablak-listája EGGYÉ fésülve, a JELÜK szerint: nagyobb jel
    /// nyer (a levétel próbatétellel jár, ami lépteti), azonos jelnél a bővebb
    /// lista — a kettő uniója tartalom szerint. A jeltelen blob (régi kliens)
    /// jele nulla: az ilyen sosem törölhet listát. A `mergeWindows` tükre.
    static func mergeWindows(
        _ localMark: Int, _ local: [LockdownWindow], _ incomingMark: Int, _ incoming: [LockdownWindow]
    ) -> [LockdownWindow] {
        if localMark > incomingMark { return cleanWindows(local) }
        if incomingMark > localMark { return cleanWindows(incoming) }
        return cleanWindows(local + incoming)
    }

    /// Egy ablak-nap emlékeztetőjének helye a héten: a rendszer `weekday`-e
    /// (1 = vasárnap) és a perc, `lead` perccel a kezdés előtt — éjfél előttről
    /// az előző napra esik. Az iPhone előre ütemezett emlékeztetői ebből
    /// épülnek; itt van, hogy tesztelhető legyen, mert az app-célt a CI nem futtatja.
    static func reminderSlot(day: Int, startMin: Int, lead: Int) -> (weekday: Int, hour: Int, minute: Int) {
        var minute = startMin - lead
        var weekday = day + 1
        if minute < 0 {
            minute += 1440
            weekday = weekday == 1 ? 7 : weekday - 1
        }
        return (weekday, minute / 60, minute % 60)
    }

    /// A legközelebb beérő ablak-előfordulás, ha `within`-en belül kezdődik —
    /// a jelzéshez. Nem közelgő, ami már él (arról a zárlat beszél), és nincs
    /// miről szólni, ha egy futó zárlat úgyis túlér rajta: az érkezése semmin
    /// nem változtat. Két eszköz ugyanazt találja: ugyanaz a lista, ugyanaz az óra.
    static func windowStartingSoon(
        _ cur: Lockdown?, _ windows: [ScheduleLogic.Band], _ now: Double, within: Double = windowPreWarnMs
    ) -> Focus.Occurrence? {
        var soonest: Focus.Occurrence? = nil
        for w in windows {
            guard ScheduleLogic.isValidBand(w), let occ = Focus.nextOccurrence(w, now: now), occ.startsAt > now else { continue }
            if let best = soonest, best.startsAt <= occ.startsAt { continue }
            soonest = occ
        }
        guard let s = soonest, s.startsAt - now <= within else { return nil }
        if let cur, isLocked(cur, now), cur.until >= s.endsAt { return nil }
        return s
    }
}
