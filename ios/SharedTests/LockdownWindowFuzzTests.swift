import XCTest
@testable import BreakerShared

// Véletlen-teszt a zárlat-ablak magjára — a gépé (lockdown-windows-fuzz.test.ts) párja.
//
// Az ablak ígérete három mondat: a zárlat tőle SOSEM rövidül; amit egyszer
// kiírt, azt másodszor már nem írja (a kör minden percben fut); és két eszköz
// ugyanabból a listából ugyanazt a zárlatot állítja elő, akkor is, ha más
// pillanatban néznek rá. A többi teszt egy-egy esetet néz; ez több ezer
// véletlen listát, időpontot és futó zárlatot dob a magra, és MINDEN lépés
// után ellenőrzi a három mondatot. A fésülés és a lazítás szabályát is.
//
// A generátor magja rögzített, tehát egy elhasalás visszajátszható: a hiba a
// magot is kiírja.

/// Determinisztikus véletlen: `s = s * 1664525 + 1013904223 (mod 2^32)`.
private struct WindowRng {
    private var s: UInt32
    init(_ seed: UInt32) { s = seed }
    mutating func next() -> Double {
        s = s &* 1664525 &+ 1013904223
        return Double(s) / 4294967296.0
    }
}

private let hour: Double = 3_600_000
private let day: Double = 24 * hour
/// Egy hétfő éjfél helyi időben; a véletlen pillanatok három hétig innen.
private let base: Double = (Calendar.current.date(from: DateComponents(year: 2026, month: 9, day: 7, hour: 0, minute: 0)) ?? Date())
    .timeIntervalSince1970 * 1000

/// Egy érvényes ablak: véletlen napok, kezdés, vég — néha egész napos, néha éjfélen átnyúló.
private func randomWindow(_ r: inout WindowRng, _ id: String) -> LockdownLogic.LockdownWindow {
    var days: [Int] = []
    for d in 0...6 where r.next() < 0.4 { days.append(d) }
    if days.isEmpty { days = [Int(r.next() * 7)] }
    if r.next() < 0.1 { return .init(id: id, days: days, startMin: 0, endMin: 1440) }
    // Kerek órák gyakran, hogy a sávok tényleg találkozzanak és egymásba érjenek.
    let startMin = r.next() < 0.6 ? 60 * Int(r.next() * 24) : Int(r.next() * 1440)
    let endMin = r.next() < 0.6 ? 60 * (1 + Int(r.next() * 24)) : 1 + Int(r.next() * 1440)
    return .init(id: id, days: days, startMin: startMin, endMin: endMin)
}

private func randomWindows(_ r: inout WindowRng, _ device: String, min: Int = 0) -> [LockdownLogic.LockdownWindow] {
    let n = r.next() < 0.1 ? min : max(min, Int(r.next() * Double(LockdownLogic.maxLockdownWindows + 1)))
    var raw: [LockdownLogic.LockdownWindow] = []
    for i in 0..<n { raw.append(randomWindow(&r, "w\(i)@\(device)")) }
    return LockdownLogic.cleanWindows(raw)
}

/// Nincs / lejárt / futó zárlat — a futó akár napokig, hogy az ablakot át is fedje.
private func randomLockdown(_ r: inout WindowRng, _ now: Double) -> LockdownLogic.Lockdown? {
    let roll = r.next()
    if roll < 0.4 { return nil }
    if roll < 0.6 { return .init(startedAt: now - 5 * hour, until: now - 1 - floor(r.next() * 2 * hour)) }
    return .init(startedAt: now - floor(r.next() * 3 * day), until: now + 1 + floor(r.next() * 3 * day))
}

/// A lista tartalmi kulcsai a lista sorrendjében — a fésült sorrend is tükrözött.
private func keys(_ list: [LockdownLogic.LockdownWindow]) -> [String] {
    list.map { LockdownLogic.windowKey($0.band) }
}

/// Véletlen ablak-jelek a két lista tartalmaira — a gép `randomMarks`-e: a nulla nem jel.
private func randomMarks(
    _ r: inout WindowRng, _ mine: [LockdownLogic.LockdownWindow], _ other: [LockdownLogic.LockdownWindow]
) -> [String: Int] {
    var out: [String: Int] = [:]
    for w in mine + other where r.next() < 0.5 { out[LockdownLogic.windowKey(w.band)] = Int(r.next() * 4) }
    return out.filter { $0.value != 0 }
}

final class LockdownWindowFuzzTests: XCTestCase {

    func testAblakZarlatSosemRoviditEgyszerIrKetEszkozonUgyanaz() {
        for seed in 1...4000 {
            var r = WindowRng(UInt32(seed))
            let ctx = "mag \(seed)"
            let windows = randomWindows(&r, "a")
            let bands = windows.map { $0.band }
            let now = base + floor(r.next() * 21 * day)
            let cur = randomLockdown(&r, now)
            let occ = LockdownLogic.dueWindow(bands, now)
            let fw = LockdownLogic.windowLockdown(cur, bands, now)

            if let occ {
                XCTAssertTrue(occ.startsAt <= now && now < occ.endsAt, "\(ctx): az esedékes előfordulás él")
                // A legkésőbb végződő élő előfordulás — ablakonként nézve egyik sem ér tovább.
                for w in windows {
                    let one = LockdownLogic.dueWindow([w.band], now)
                    XCTAssertTrue(one == nil || one!.endsAt <= occ.endsAt, "\(ctx): van tovább érő ablak")
                }
            }

            guard let fw else {
                // Semmi írnivaló: nincs élő ablak, vagy a futó zárlat már az ablak végéig ér.
                if let occ {
                    XCTAssertTrue(cur != nil && cur!.until > now && cur!.until >= occ.endsAt, "\(ctx): élő ablak zárlat nélkül")
                }
                continue
            }
            guard let occ else { XCTFail("\(ctx): ablak-zárlat élő ablak nélkül"); continue }
            XCTAssertEqual(fw.until, occ.endsAt, "\(ctx): a vég az ablak vége")
            XCTAssertTrue(fw.until > now, "\(ctx): a kiírt zárlat él")
            // Sosem rövidít: a kiírt vég minden korábbi végnél későbbi.
            XCTAssertTrue(cur == nil || fw.until > cur!.until, "\(ctx): rövidített")
            if let cur, cur.until > now {
                XCTAssertEqual(fw.startedAt, cur.startedAt, "\(ctx): a futó zárlat kezdése marad")
            } else {
                XCTAssertEqual(fw.startedAt, occ.startsAt, "\(ctx): a kezdés az ablak kezdése")
            }
            XCTAssertTrue(fw.startedAt <= now, "\(ctx): jövőbeli kezdés")
            XCTAssertTrue(LockdownLogic.isWindowLockdown(fw, bands), "\(ctx): a kiírt zárlat nem ablaké")
            // Egyszer ír: a kiírt zárlattal a kör már nem ír újat.
            XCTAssertNil(LockdownLogic.windowLockdown(fw, bands, now), "\(ctx): másodszor is írt")

            // Két eszköz: a másik később nézi meg, zárlat nélkül — ugyanazt kapja, vagy
            // egy közben beért, tovább érő ablakét (ami ezt is ugyanígy kitolná).
            let later = now + floor(r.next() * (fw.until - now))
            guard let other = LockdownLogic.windowLockdown(nil, bands, later) else {
                XCTFail("\(ctx): a másik eszköz nem lát zárlatot"); continue
            }
            XCTAssertTrue(other.until >= fw.until, "\(ctx): a másik eszköz rövidebbet lát")
            if other.until == fw.until { XCTAssertEqual(other.startedAt, occ.startsAt, "\(ctx): más kezdés") }
            let mine = LockdownLogic.windowLockdown(fw, bands, later)
            XCTAssertTrue(mine == nil || (mine!.startedAt == fw.startedAt && mine!.until > fw.until), "\(ctx): a saját kör rövidített")

            // Előre az időben: a lánc (kézi zárlat, ablak, következő ablak) csak nő.
            var l = fw
            var t = now
            for _ in 0..<6 {
                t += floor(r.next() * 8 * hour)
                guard let n = LockdownLogic.windowLockdown(l, bands, t) else { continue }
                XCTAssertTrue(n.until > l.until, "\(ctx): a lánc rövidült")
                if l.until > t { XCTAssertEqual(n.startedAt, l.startedAt, "\(ctx): a lánc kezdése elmozdult") }
                XCTAssertTrue(LockdownLogic.isWindowLockdown(n, bands), "\(ctx): a lánc tagja nem ablaké")
                l = n
            }
        }
    }

    func testFesulesTartalmankentANagyobbJelDontEgyenlonelUnioPlafonSzabadOraEgyediAzonosito() {
        for seed in 1...3000 {
            var r = WindowRng(UInt32(seed))
            let ctx = "mag \(seed)"
            // Néha közös azonosító-séma: két eszköz ugyanazzal az azonosítóval más tartalmat is hozhat.
            let shared = r.next() < 0.3
            let a = randomWindows(&r, shared ? "x" : "a")
            let b = randomWindows(&r, shared ? "x" : "b")
            let sa = LockdownLogic.WindowSet(windows: a, marks: randomMarks(&r, a, b))
            let sb = LockdownLogic.WindowSet(windows: b, marks: randomMarks(&r, b, a))
            let merged = LockdownLogic.mergeWindowSets(sa, sb)
            let m = merged.windows

            XCTAssertTrue(m.count <= LockdownLogic.maxLockdownWindows, "\(ctx): túl sok ablak")
            XCTAssertEqual(Set(m.map { LockdownLogic.windowKey($0.band) }).count, m.count, "\(ctx): dupla tartalom")
            XCTAssertEqual(Set(m.map { Array($0.id.utf16) }).count, m.count, "\(ctx): dupla azonosító")
            XCTAssertTrue(m.isEmpty || LockdownLogic.freeMinutesPerWeek(m.map { $0.band }) >= LockdownLogic.minFreeMinutesPerWeek,
                          "\(ctx): nincs szabad óra a héten")
            XCTAssertEqual(LockdownLogic.mergeWindowSets(merged, merged).windows, m, "\(ctx): a fésülés nem idempotens")
            let flipped = LockdownLogic.mergeWindowSets(sb, sa)
            XCTAssertEqual(keys(flipped.windows), keys(m), "\(ctx): a fésülés nem szimmetrikus")
            XCTAssertEqual(flipped.marks, merged.marks, "\(ctx): a jelek nem szimmetrikusak")

            let union = Set(keys(a) + keys(b))
            let mKeys = keys(m)
            for w in m { XCTAssertTrue(union.contains(LockdownLogic.windowKey(w.band)), "\(ctx): ablak a semmiből") }
            for k in union {
                let ma = sa.marks?[k] ?? 0
                let mb = sb.marks?[k] ?? 0
                let inA = keys(a).contains(k)
                let inB = keys(b).contains(k)
                let want = ma > mb ? inA : (mb > ma ? inB : (inA || inB))
                let got = mKeys.contains(k)
                if !want { XCTAssertFalse(got, "\(ctx): a jeles levétel ellenére megmaradt: \(k)") }
                // Ami jár, az csak a plafon vagy a szabad óra miatt maradhat ki.
                if want && !got, let w = (a + b).first(where: { LockdownLogic.windowKey($0.band) == k }) {
                    XCTAssertTrue(m.count >= LockdownLogic.maxLockdownWindows ||
                                  LockdownLogic.freeMinutesPerWeek((m + [w]).map { $0.band }) < LockdownLogic.minFreeMinutesPerWeek,
                                  "\(ctx): ablak ok nélkül veszett el: \(k)")
                }
                let mark = max(ma, mb)
                if mark > 0 { XCTAssertEqual(merged.marks?[k], mark, "\(ctx): a jel nem a nagyobbik: \(k)") }
            }
        }
    }

    func testLazitasBovitesSosemLazitasAzUtolsoAblakLeveteleMindigAz() {
        for seed in 1...12 {
            var r = WindowRng(UInt32(seed))
            let ctx = "mag \(seed)"
            let a = randomWindows(&r, "a", min: 1).map { $0.band }
            let now = base + floor(r.next() * 21 * day)
            XCTAssertFalse(LockdownLogic.isWindowsLoosening(a, a, now), "\(ctx): ugyanaz a lista lazítás")
            XCTAssertTrue(LockdownLogic.isWindowsLoosening(a, [], now), "\(ctx): minden ablak levétele nem lazítás")
            XCTAssertFalse(LockdownLogic.isWindowsLoosening([], a, now), "\(ctx): az első ablak felvétele lazítás")
            let extra = randomWindow(&r, "extra").band
            XCTAssertFalse(LockdownLogic.isWindowsLoosening(a, a + [extra], now), "\(ctx): a bővítés lazítás")
            // Egy ablak levétele akkor lazítás, ha van olyan perc a héten, amit csak ő zárt.
            let rest = Array(a.dropFirst())
            var uncovered = false
            var i = 0
            while i < 7 * 24 * 60 && !uncovered {
                let t = now + Double(i) * 60_000
                if ScheduleLogic.inAnyBand(a, t) && !ScheduleLogic.inAnyBand(rest, t) { uncovered = true }
                i += 1
            }
            XCTAssertEqual(LockdownLogic.isWindowsLoosening(a, rest, now), uncovered, "\(ctx): a levétel lazítás-ítélete")
        }
    }
}
