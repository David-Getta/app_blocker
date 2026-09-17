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
}
