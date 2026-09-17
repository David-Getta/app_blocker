import Foundation
import XCTest
@testable import BreakerShared

// Zárlat-ablak a Swift tükrön — a desktop/test/lockdown-windows.test.ts és az
// androidos LockdownWindowTest magja. Az iPhone az ablakot hordozza, fésüli
// és érvényesíti; itt a MAG számtana fut: a kör ugyanazt a zárlatot állítja
// elő, mint a gép, a vég dönti el, hogy az ablaké, és a fésülés a JEL szerint.
final class LockdownWindowTests: XCTestCase {

    private func at(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int = 0) -> Double {
        let date = Calendar.current.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
        return date.timeIntervalSince1970 * 1000
    }

    // 2026. szeptember 7. hétfő.
    private func mon(_ h: Int, _ min: Int = 0) -> Double { at(2026, 9, 7, h, min) }
    private func tue(_ h: Int, _ min: Int = 0) -> Double { at(2026, 9, 8, h, min) }
    private func sat(_ h: Int, _ min: Int = 0) -> Double { at(2026, 9, 12, h, min) }
    private func sun(_ h: Int, _ min: Int = 0) -> Double { at(2026, 9, 6, h, min) }

    private let work = LockdownLogic.LockdownWindow(id: "w1", days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60)
    /// hétfő este → kedd hajnal
    private let night = LockdownLogic.LockdownWindow(id: "w2", days: [1], startMin: 22 * 60, endMin: 6 * 60)
    private func allDay(_ id: String, _ days: [Int]) -> LockdownLogic.LockdownWindow {
        LockdownLogic.LockdownWindow(id: id, days: days, startMin: 0, endMin: 1440)
    }
    private func bands(_ w: LockdownLogic.LockdownWindow...) -> [ScheduleLogic.Band] { w.map { $0.band } }
    private func lock(_ s: Double, _ u: Double) -> LockdownLogic.Lockdown { LockdownLogic.Lockdown(startedAt: s, until: u) }

    // MARK: - a mag

    func testCleanWindowsKeepsOnlyValidOnesOnce() {
        XCTAssertNil(LockdownLogic.cleanWindow(LockdownLogic.LockdownWindow(id: "", days: [1], startMin: 0, endMin: 60)))
        XCTAssertNil(LockdownLogic.cleanWindow(LockdownLogic.LockdownWindow(id: String(repeating: "x", count: 41), days: [1], startMin: 0, endMin: 60)))
        XCTAssertNil(LockdownLogic.cleanWindow(LockdownLogic.LockdownWindow(id: "w", days: [], startMin: 0, endMin: 60)))
        XCTAssertNil(LockdownLogic.cleanWindow(LockdownLogic.LockdownWindow(id: "w", days: [1], startMin: 1440, endMin: 60)))
        XCTAssertEqual(LockdownLogic.cleanWindow(LockdownLogic.LockdownWindow(id: "w", days: [5, 1, 3, 9, 1], startMin: 0, endMin: 60))?.days,
                       [1, 3, 5], "a rossz nap kiesik, a többi rendezve, egyszer")
        XCTAssertEqual(LockdownLogic.cleanWindows([work, LockdownLogic.LockdownWindow(id: "w1", days: [1], startMin: 0, endMin: 60)]),
                       [work], "azonos azonosító: az első")
        XCTAssertEqual(LockdownLogic.cleanWindows([work, LockdownLogic.LockdownWindow(id: "masik", days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60)]),
                       [work], "azonos tartalom: az első")
        let many = (0..<(LockdownLogic.maxLockdownWindows + 2)).map {
            LockdownLogic.LockdownWindow(id: "w\($0)", days: [$0 % 7], startMin: $0, endMin: $0 + 1)
        }
        XCTAssertEqual(LockdownLogic.cleanWindows(many).count, LockdownLogic.maxLockdownWindows)
        XCTAssertTrue(LockdownLogic.sameWindows(bands(work), [LockdownLogic.LockdownWindow(id: "x", days: [1, 2, 3, 4, 5], startMin: 540, endMin: 1020).band]))
        XCTAssertFalse(LockdownLogic.sameWindows(bands(work), bands(night)))
    }

    func testTheWholeWeekCannotBeLocked() {
        XCTAssertTrue(LockdownLogic.weekHasFreeTime([], mon(10)))
        XCTAssertTrue(LockdownLogic.weekHasFreeTime(bands(work, night), mon(10)))
        XCTAssertFalse(LockdownLogic.weekHasFreeTime(bands(allDay("a", [0, 1, 2, 3, 4, 5, 6])), mon(10)))
        XCTAssertTrue(LockdownLogic.weekHasFreeTime(bands(allDay("a", [1, 2, 3, 4, 5, 6])), mon(10)), "a vasárnap szabad")
        let perDay = (LockdownLogic.minFreeMinutesPerWeek + 6) / 7
        XCTAssertTrue(LockdownLogic.weekHasFreeTime([ScheduleLogic.Band(days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 - perDay)], mon(10)))
        XCTAssertFalse(LockdownLogic.weekHasFreeTime([ScheduleLogic.Band(days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 - perDay + 1)], mon(10)))
    }

    func testLooseningIsRemovalOrNarrowing() {
        let narrow = ScheduleLogic.Band(days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 12 * 60)
        let wide = ScheduleLogic.Band(days: [1, 2, 3, 4, 5], startMin: 8 * 60, endMin: 17 * 60)
        XCTAssertFalse(LockdownLogic.isWindowsLoosening([], bands(work), sun(12)), "felvétel")
        XCTAssertTrue(LockdownLogic.isWindowsLoosening(bands(work), [], sun(12)), "levétel")
        XCTAssertFalse(LockdownLogic.isWindowsLoosening(bands(work), bands(work, night), sun(12)), "második ablak")
        XCTAssertFalse(LockdownLogic.isWindowsLoosening(bands(work), [wide], sun(12)), "bővítés")
        XCTAssertTrue(LockdownLogic.isWindowsLoosening(bands(work), [narrow], sun(12)), "szűkítés")
        XCTAssertTrue(LockdownLogic.isWindowsLoosening(bands(work, night), bands(work), sun(12)), "az egyik levétele")
    }

    func testDueWindowIsTheLatestEndingLiveOne() {
        XCTAssertEqual(LockdownLogic.dueWindow(bands(work), mon(10)), Focus.Occurrence(startsAt: mon(9), endsAt: mon(17)))
        XCTAssertNil(LockdownLogic.dueWindow(bands(work), mon(8, 59)))
        XCTAssertNil(LockdownLogic.dueWindow(bands(work), mon(17)), "a vég perce már nincs")
        XCTAssertNil(LockdownLogic.dueWindow(bands(work), sat(10)))
        XCTAssertEqual(LockdownLogic.dueWindow(bands(work, night), mon(23)), Focus.Occurrence(startsAt: mon(22), endsAt: tue(6)))
        XCTAssertEqual(LockdownLogic.dueWindow(bands(work, night), tue(1)), Focus.Occurrence(startsAt: mon(22), endsAt: tue(6)), "kedd hajnal")
        let late = LockdownLogic.LockdownWindow(id: "w3", days: [1], startMin: 16 * 60, endMin: 18 * 60)
        XCTAssertEqual(LockdownLogic.dueWindow(bands(work, late), mon(16, 30)), Focus.Occurrence(startsAt: mon(16), endsAt: mon(18)))
    }

    func testWindowLockdownEndsWithTheWindow() {
        XCTAssertEqual(LockdownLogic.windowLockdown(nil, bands(work), mon(10)), lock(mon(9), mon(17)))
        XCTAssertNil(LockdownLogic.windowLockdown(nil, bands(work), mon(8)))
        XCTAssertEqual(LockdownLogic.windowLockdown(lock(mon(8), mon(10, 30)), bands(work), mon(10)), lock(mon(8), mon(17)),
                       "a futó kézi zárlat vége kitolódik, a kezdése marad")
        XCTAssertNil(LockdownLogic.windowLockdown(lock(mon(8), mon(18)), bands(work), mon(10)), "a hosszabb marad — sosem rövidül")
        XCTAssertEqual(LockdownLogic.windowLockdown(lock(sun(1), sun(2)), bands(work), mon(10)), lock(mon(9), mon(17)),
                       "a lejárt nem futó: a kezdés az ablaké")
    }

    func testTheEndDecidesWhetherItIsTheWindowsLockdown() {
        XCTAssertTrue(LockdownLogic.isWindowLockdown(lock(mon(9), mon(17)), bands(work)))
        XCTAssertTrue(LockdownLogic.isWindowLockdown(lock(mon(8), mon(17)), bands(work)), "kitolt kézi is")
        XCTAssertFalse(LockdownLogic.isWindowLockdown(lock(mon(9), mon(17, 30)), bands(work)), "meghosszabbítva nem")
        XCTAssertFalse(LockdownLogic.isWindowLockdown(lock(mon(9), mon(17)), []))
        XCTAssertTrue(LockdownLogic.isWindowLockdown(lock(mon(22), tue(6)), bands(night)), "éjfélen át")
        XCTAssertTrue(LockdownLogic.isWindowLockdown(lock(mon(0), tue(0)), bands(allDay("a", [1]))), "24:00-ig")
    }

    func testMergeIsDecidedByTheMark() {
        XCTAssertEqual(LockdownLogic.mergeWindows(5, [work], 3, []), [work])
        XCTAssertEqual(LockdownLogic.mergeWindows(3, [work], 5, []), [], "a jeles levétel átjön")
        XCTAssertEqual(LockdownLogic.mergeWindows(5, [work], 5, [night]), [work, night], "azonos jel: unió")
        XCTAssertEqual(LockdownLogic.mergeWindows(3, [work], 0, []), [work], "a jeltelen nem töröl")
        let foreign = LockdownLogic.LockdownWindow(id: "idegen", days: [1, 2, 3, 4, 5], startMin: 540, endMin: 1020)
        XCTAssertEqual(LockdownLogic.mergeWindows(5, [work], 5, [foreign]), [work], "azonos tartalom: a helyi azonosító marad")
    }

    // MARK: - a szinkron

    func testTheBlobCarriesTheWindowsWithTheirMark() throws {
        let f = FocusSync.SyncFocus(rev: 3, updatedAt: 1, updatedBy: "gep", lockdownWindows: [work, night], lockdownWindowsRev: 3)
        let data = try JSONEncoder().encode(f)
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(text.contains("\"lockdownWindows\""))
        XCTAssertTrue(text.contains("\"lockdownWindowsRev\":3"))
        let back = FocusSync.normalize(try JSONDecoder().decode(FocusSync.SyncFocus.self, from: data), fallbackDevice: "y")
        XCTAssertEqual(back.lockdownWindows, [work, night])
        XCTAssertEqual(back.lockdownWindowsRev, 3)
        // Üresen nincs mező; a jel legfeljebb a blob rev-je; a szemét kiesik.
        let empty = String(decoding: try JSONEncoder().encode(FocusSync.SyncFocus(updatedBy: "x")), as: UTF8.self)
        XCTAssertFalse(empty.contains("lockdownWindows"))
        let junk = FocusSync.SyncFocus(rev: 3, updatedAt: 1, updatedBy: "x",
                                       lockdownWindows: [work, LockdownLogic.LockdownWindow(id: "", days: [1], startMin: 0, endMin: 60)],
                                       lockdownWindowsRev: 9)
        let n = FocusSync.normalize(junk, fallbackDevice: "y")
        XCTAssertEqual(n.lockdownWindows, [work])
        XCTAssertNil(n.lockdownWindowsRev, "a túl nagy jel nincs")
        // Egy régi blob (nincs ilyen kulcs) is dekódolható marad.
        let old = try JSONDecoder().decode(FocusSync.SyncFocus.self, from: Data("{\"packs\":[],\"rev\":1}".utf8))
        XCTAssertNil(old.lockdownWindows)
    }

    func testMergeFollowsTheMarkNotTheNewerBlob() {
        let mine = FocusSync.SyncFocus(rev: 3, updatedAt: 10, updatedBy: "a", lockdownWindows: [work], lockdownWindowsRev: 3)
        let removed = FocusSync.SyncFocus(rev: 5, updatedAt: 20, updatedBy: "b", lockdownWindowsRev: 5)
        XCTAssertNil(FocusSync.merge(mine, removed).lockdownWindows, "a levétel átjön")
        XCTAssertNil(FocusSync.merge(removed, mine).lockdownWindows)
        XCTAssertEqual(FocusSync.merge(mine, removed).lockdownWindowsRev, 5)
        // Régi kliens: magasabb rev, se ablak, se jel — nem törölhet.
        let old = FocusSync.SyncFocus(rev: 9, updatedAt: 30, updatedBy: "c")
        XCTAssertEqual(FocusSync.merge(mine, old).lockdownWindows, [work])
        XCTAssertEqual(FocusSync.merge(old, mine).lockdownWindows, [work])
        // Azonos jel: unió.
        let other = FocusSync.SyncFocus(rev: 5, updatedAt: 1, updatedBy: "d", lockdownWindows: [night], lockdownWindowsRev: 3)
        XCTAssertEqual(FocusSync.merge(mine, other).lockdownWindows, [work, night])
        XCTAssertFalse(FocusSync.same(mine, other), "más ablak: van mit feltölteni")
        var renamed = mine
        renamed.lockdownWindows = [LockdownLogic.LockdownWindow(id: "x", days: [1, 2, 3, 4, 5], startMin: 540, endMin: 1020)]
        XCTAssertTrue(FocusSync.same(mine, renamed), "az azonosító nem számít")
    }

    func testTheWindowsGetAMarkWhenTheyChange() {
        var st = AppState()
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: mon(1))
        XCTAssertEqual(st.focusRev ?? 0, 0, "az üresség nem szerkesztés")
        st.lockdownWindows = [work]
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: mon(1))
        XCTAssertEqual(st.focusRev, 1)
        XCTAssertEqual(st.lockdownWindowsRev, 1, "az első jel is jel")
        XCTAssertEqual(SyncRevisions.bumpFocus(st, deviceId: "iphone", now: mon(1)).focusRev, 1, "változatlanul nem léptet")
        st.focusPacks = [Focus.Pack(id: "p1", name: "Írás", allowSites: [], allowApps: [], defaultMinutes: 25, recurrence: nil)]
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: mon(1))
        XCTAssertEqual(st.focusRev, 2)
        XCTAssertEqual(st.lockdownWindowsRev, 1, "a csomag szerkesztése nem az ablakok jele")
        st.lockdownWindows = [work, night]
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: mon(1))
        XCTAssertEqual(st.lockdownWindowsRev, 3)
        st.lockdownWindows = [night]
        let adopted = SyncRevisions.adoptFocus(st)
        XCTAssertEqual(SyncRevisions.bumpFocus(adopted, deviceId: "iphone", now: mon(1)).focusRev, 3, "az átvétel nem szerkesztés")
    }
}
