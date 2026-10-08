import Foundation
import XCTest
@testable import BreakerShared

// Zárlat-ablak a Swift tükrön — a desktop/test/lockdown-windows.test.ts és az
// androidos LockdownWindowTest magja. Az iPhone az ablakot hordozza, fésüli
// és érvényesíti; itt a MAG számtana fut: a kör ugyanazt a zárlatot állítja
// elő, mint a gép, a vég dönti el, hogy az ablaké, és a fésülés tartalmanként,
// a JEL szerint.
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

    private func k(_ w: LockdownLogic.LockdownWindow) -> String { LockdownLogic.windowKey(w.band) }
    private func wset(_ ws: [LockdownLogic.LockdownWindow], _ marks: [String: Int]? = nil) -> LockdownLogic.WindowSet {
        LockdownLogic.WindowSet(windows: ws, marks: marks)
    }
    /// Egy ablak másik azonosítóval vagy véggel — a Kotlin `copy` párja.
    private func with(_ w: LockdownLogic.LockdownWindow, id: String? = nil, endMin: Int? = nil) -> LockdownLogic.LockdownWindow {
        LockdownLogic.LockdownWindow(id: id ?? w.id, days: w.days, startMin: w.startMin, endMin: endMin ?? w.endMin)
    }

    func testMergeIsDecidedPerContentByTheMark() {
        XCTAssertEqual(LockdownLogic.mergeWindowSets(wset([work], [k(work): 3]), wset([], [k(work): 5])),
                       wset([], [k(work): 5]), "a jeles levétel átjön")
        XCTAssertEqual(LockdownLogic.mergeWindowSets(wset([work], [k(work): 6]), wset([], [k(work): 5])).windows, [work])
        XCTAssertEqual(LockdownLogic.mergeWindowSets(wset([work]), wset([night])).windows.map { k($0) }, [k(night), k(work)],
                       "jel nélkül unió — a kisebb ablak elöl")
        XCTAssertEqual(LockdownLogic.mergeWindowSets(wset([work]), wset([])).windows, [work], "a jeltelen nem töröl")
        // A TRÜKK: egy elavult eszköz ingyenes felvétele a régi listával nem töröl.
        let account = wset([work], [k(work): 3])
        let stale = wset([night], [k(night): 40])
        for m in [LockdownLogic.mergeWindowSets(account, stale), LockdownLogic.mergeWindowSets(stale, account)] {
            XCTAssertEqual(m.windows.map { k($0) }, [k(work), k(night)], "a WORK megmarad, a NIGHT mellé kerül")
        }
        XCTAssertEqual(LockdownLogic.mergeWindowSets(wset([work]), wset([with(work, id: "a0")])).windows, [with(work, id: "a0")],
                       "azonos tartalom: a kisebb azonosító marad")
        let grown = with(work, endMin: 18 * 60)
        XCTAssertEqual(LockdownLogic.mergeWindowSets(wset([work], [k(work): 2]), wset([grown], [k(grown): 2])).windows.map { $0.id },
                       ["w1", k(grown)], "két tartalom ugyanazzal az azonosítóval: a második átkeresztelve")
        // A szabad óra: két eszköz uniója nem zárhatja le az egész hetet — a frissebb esik ki.
        let mostly = LockdownLogic.LockdownWindow(id: "a1", days: Array(0...6), startMin: 0, endMin: 23 * 60)
        let rest = LockdownLogic.LockdownWindow(id: "b1", days: Array(0...6), startMin: 23 * 60, endMin: 1440)
        XCTAssertEqual(LockdownLogic.freeMinutesPerWeek([mostly.band, rest.band]), 0)
        let trimmed = LockdownLogic.mergeWindowSets(wset([rest], [k(rest): 5]), wset([mostly], [k(mostly): 2]))
        XCTAssertEqual(trimmed.windows, [mostly])
        XCTAssertEqual(trimmed.marks?[k(rest)], 5, "a kiesett ablak jele marad")
        // A kanonikus kulcs és a tisztítás.
        XCTAssertTrue(LockdownLogic.isWindowKey("1,2,3,4,5/540/1020"))
        XCTAssertFalse(LockdownLogic.isWindowKey("2,1/540/1020"))
        XCTAssertFalse(LockdownLogic.isWindowKey("1/0540/1020"))
        XCTAssertFalse(LockdownLogic.isWindowKey("1,1/0/60"))
        XCTAssertFalse(LockdownLogic.isWindowKey("1/\u{0661}0/60"), "csak ASCII számjegy")
        XCTAssertEqual(LockdownLogic.cleanWindowMarks([k(work): 2, k(night): 9, "2,1/0/60": 1, "x": 1], [work], maxRev: 3),
                       [k(work): 2])
        XCTAssertEqual(LockdownLogic.markWindowChanges([k(night): 1], prevKeys: [k(work), k(night)], next: [grown, night], rev: 4),
                       [k(night): 1, k(grown): 4, k(work): 4], "a módosítás: a régi tartalom levétele, az új felvétele")
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
        // A tartalmankénti jelek is oda-vissza.
        var markedIn = f
        markedIn.lockdownWindowMarks = [k(work): 3, k(night): 2]
        let markedData = try JSONEncoder().encode(markedIn)
        let marked = FocusSync.normalize(try JSONDecoder().decode(FocusSync.SyncFocus.self, from: markedData), fallbackDevice: "y")
        XCTAssertEqual(marked.lockdownWindowMarks, [k(work): 3, k(night): 2], "a jelek oda-vissza")
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
        let mine = FocusSync.SyncFocus(rev: 3, updatedAt: 10, updatedBy: "a", lockdownWindows: [work], lockdownWindowsRev: 3,
                                       lockdownWindowMarks: [k(work): 3])
        let removed = FocusSync.SyncFocus(rev: 5, updatedAt: 20, updatedBy: "b", lockdownWindowsRev: 5,
                                          lockdownWindowMarks: [k(work): 5])
        XCTAssertNil(FocusSync.merge(mine, removed).lockdownWindows, "a levétel átjön")
        XCTAssertNil(FocusSync.merge(removed, mine).lockdownWindows)
        XCTAssertEqual(FocusSync.merge(mine, removed).lockdownWindowsRev, 5)
        // Régi kliens: magasabb rev, se ablak, se jel — nem törölhet.
        let old = FocusSync.SyncFocus(rev: 9, updatedAt: 30, updatedBy: "c")
        XCTAssertEqual(FocusSync.merge(mine, old).lockdownWindows, [work])
        XCTAssertEqual(FocusSync.merge(old, mine).lockdownWindows, [work])
        // A régi kliens jel nélküli levétele sem.
        let oldRemoval = FocusSync.SyncFocus(rev: 6, updatedAt: 60, updatedBy: "c", lockdownWindowsRev: 6)
        XCTAssertEqual(FocusSync.merge(mine, oldRemoval).lockdownWindows, [work])
        // Azonos jel: unió — a kisebb ablak elöl.
        let other = FocusSync.SyncFocus(rev: 5, updatedAt: 1, updatedBy: "d", lockdownWindows: [night], lockdownWindowsRev: 3,
                                        lockdownWindowMarks: [k(night): 3])
        XCTAssertEqual(FocusSync.merge(mine, other).lockdownWindows, [night, work])
        var remarked = mine
        remarked.lockdownWindowMarks = [k(work): 2]
        XCTAssertFalse(FocusSync.same(mine, remarked), "a jel cseréje különbség")
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
        XCTAssertEqual(st.lockdownWindowMarks, [k(work): 1], "a felvett tartalom a saját jelét kapja")
        XCTAssertEqual(SyncRevisions.bumpFocus(st, deviceId: "iphone", now: mon(1)).focusRev, 1, "változatlanul nem léptet")
        st.focusPacks = [Focus.Pack(id: "p1", name: "Írás", allowSites: [], allowApps: [], defaultMinutes: 25, recurrence: nil)]
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: mon(1))
        XCTAssertEqual(st.focusRev, 2)
        XCTAssertEqual(st.lockdownWindowsRev, 1, "a csomag szerkesztése nem az ablakok jele")
        st.lockdownWindows = [work, night]
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: mon(1))
        XCTAssertEqual(st.lockdownWindowsRev, 3)
        XCTAssertEqual(st.lockdownWindowMarks, [k(work): 1, k(night): 3], "a régi ablak jele nem változik")
        st.lockdownWindows = [night]
        let adopted = SyncRevisions.adoptFocus(st)
        XCTAssertEqual(SyncRevisions.bumpFocus(adopted, deviceId: "iphone", now: mon(1)).focusRev, 3, "az átvétel nem szerkesztés")
    }
}
