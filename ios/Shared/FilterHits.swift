import Foundation

/// MEGAKADÁSOK A SZŰRŐBEN: hányszor állította meg a DNS-szűrő az iPhone-t.
///
/// A tiltás akkor dolgozik, amikor az ember nem figyel oda — pont ezért nem
/// látszik, mennyit dolgozik. A gépen a böngésző-bővítmény számolja a tiltó
/// lapra vitt navigációkat; a telefonon tiltó lap nincs, de a tiltott
/// lekérdezés ugyanaz a pillanat: a kéz odanyúlt, a szűrő megállította.
/// Tükör, nem ítélet. Egy hosztnevet két percen belül EGYSZER számol (egy
/// oldalbetöltés tucatnyi lekérdezés); a könyv naponként egy szám, harminc
/// napig; a készüléken marad. Az androidos `FilterHitLogic` tükre.
public enum FilterHitLogic {
    /// Ennyi napot tartunk meg — mint a mérés és a böngésző könyve.
    public static let retentionDays = 30
    /// Egy hosztnév ennyin belül egy megakadás.
    public static let dedupeMs: Double = 120_000
    /// Naponta legfeljebb ennyi — fölötte nem mérés, hanem hiba.
    public static let maxPerDay = 10_000
    /// A tunnel memóriája (hoszt → utolsó idő) ennél nem nő nagyobbra.
    private static let maxSeen = 500

    private static func isDayKey(_ s: String) -> Bool {
        s.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil
    }

    /// A nap kulcsa helyi idő szerint — ugyanaz, mint a mérésé.
    public static func dayKey(_ now: Double) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: now / 1000))
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Számít-e ez a tiltott lekérdezés új megakadásnak. A `lastSeen` a hívó
    /// memóriája (hoszt → utolsó számolt idő), itt frissül; nem tárolódik.
    public static func shouldCount(_ lastSeen: inout [String: Double], _ host: String, now: Double) -> Bool {
        var h = host.trimmingCharacters(in: .whitespaces).lowercased()
        while h.hasSuffix(".") { h.removeLast() }
        if h.isEmpty { return false }
        if let last = lastSeen[h], now >= last, now - last < dedupeMs { return false }
        if lastSeen.count >= maxSeen {
            lastSeen = lastSeen.filter { now - $0.value < dedupeMs && $0.value <= now }
            if lastSeen.count >= maxSeen { lastSeen = [:] }
        }
        lastSeen[h] = now
        return true
    }

    /// A könyv egy megakadással több a napon. Rossz nap vagy a napi plafon:
    /// változatlan. Nem takarít — az a hívóé, a MAI nappal (`sweep`): a felvett
    /// nap nem a mai nap, és egy régebbi nappal takarítva a mai sor esne ki.
    public static func record(_ days: [String: Int], day: String) -> [String: Int] {
        guard isDayKey(day) else { return days }
        let n = days[day] ?? 0
        if n >= maxPerDay { return days }
        var next = days
        next[day] = n + 1
        return next
    }

    /// A megtartási időn túli és a jövőbeli napok kiesnek.
    public static func sweep(_ days: [String: Int], today: String) -> [String: Int] {
        let keep = Set(days.keys.filter { isDayKey($0) && $0 <= today }.sorted().suffix(retentionDays))
        return days.filter { keep.contains($0.key) }
    }

    /// A tárból jött könyv tisztán: jó nap, pozitív szám a plafonig, a legfrissebb harminc.
    public static func clean(_ raw: [String: Int]?) -> [String: Int] {
        let good = (raw ?? [:]).filter { isDayKey($0.key) && $0.value > 0 }.mapValues { min($0, maxPerDay) }
        let keep = Set(good.keys.sorted().suffix(retentionDays))
        return good.filter { keep.contains($0.key) }
    }

    /// Megakadások a két nap között, mindkettőt beleértve.
    public static func hitsBetween(_ days: [String: Int], _ fromDay: String, _ toDay: String) -> Int {
        days.filter { $0.key >= fromDay && $0.key <= toDay }.values.reduce(0, +)
    }

    /// Az elmúlt 7 nap (a mai nappal) — a statisztika és a visszatekintés ablaka.
    public static func hits7d(_ days: [String: Int], now: Double) -> Int {
        hitsBetween(days, dayKey(now - 6 * 86_400_000), dayKey(now))
    }

    /// A mai nap.
    public static func hitsToday(_ days: [String: Int], now: Double) -> Int {
        let d = dayKey(now)
        return hitsBetween(days, d, d)
    }

    /// Az utolsó `count` nap sora, a legrégebbi elöl — a hét alakja a
    /// megakadásokra; a `seconds` mező itt darab, a rajz kedvéért ugyanaz az alak.
    public static func daySeries(_ days: [String: Int], now: Double, count: Int) -> [(day: String, seconds: Double)] {
        let base = Date(timeIntervalSince1970: now / 1000)
        return (0..<count).reversed().map { back in
            let d = Calendar.current.date(byAdding: .day, value: -back, to: base) ?? base
            let key = dayKey(d.timeIntervalSince1970 * 1000)
            return (day: key, seconds: Double(hitsBetween(days, key, key)))
        }
    }
}
