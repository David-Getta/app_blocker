import XCTest
@testable import BreakerShared

// Az iPhone előre ütemezett emlékeztetőinek TERVE — az app-célt a CI nem
// futtatja, a tervet a mag adja, tehát itt látszik, mit kapna a rendszer.
final class WindowReminderPlanTests: XCTestCase {

    private func window(_ id: String, _ days: [Int], _ start: Int, _ end: Int) -> LockdownLogic.LockdownWindow {
        LockdownLogic.LockdownWindow(id: id, days: days, startMin: start, endMin: end)
    }

    func testEveryWindowDayGetsAStartAndAHeadsUp() {
        let plan = LockdownLogic.reminderPlan([window("w1", [1, 2, 3, 4, 5], 9 * 60, 17 * 60)])
        XCTAssertEqual(plan.count, 10, "öt nap, kezdés és előjelzés")
        XCTAssertTrue(plan.allSatisfy { $0.id.hasPrefix(LockdownLogic.reminderIdPrefix) })
        XCTAssertEqual(Set(plan.map { $0.id }).count, plan.count, "az azonosítók egyediek")
        let starts = plan.filter { !$0.id.hasSuffix(":soon") }
        XCTAssertEqual(starts.map { $0.weekday }, [2, 3, 4, 5, 6], "hétfő a rendszer 2-ese")
        XCTAssertTrue(starts.allSatisfy { $0.hour == 9 && $0.minute == 0 })
        XCTAssertTrue(starts.allSatisfy { $0.body.contains("8 óra") && $0.body.contains("17:00") }, "meddig tart, és mikor ér véget")
        let soon = plan.filter { $0.id.hasSuffix(":soon") }
        XCTAssertTrue(soon.allSatisfy { $0.hour == 8 && $0.minute == 50 }, "tíz perccel előbb")
        XCTAssertTrue(soon.allSatisfy { $0.body.contains("10 perc múlva") && $0.body.contains("17:00-ig") })
    }

    func testTheHeadsUpIsDroppedWhenItWouldNotFitTheSystemLimit() {
        // Hét ablak, mind a hét napra: 49 kezdés — az előjelzéssel 98 lenne, a
        // rendszer 64-et enged. A kezdés az elsőbb, az előjelzés marad el.
        let full = (0..<7).map { window("w\($0)", [0, 1, 2, 3, 4, 5, 6], 60 * $0, 60 * $0 + 30) }
        let plan = LockdownLogic.reminderPlan(full)
        XCTAssertEqual(plan.count, 49)
        XCTAssertTrue(plan.allSatisfy { !$0.id.hasSuffix(":soon") })
        XCTAssertLessThanOrEqual(plan.count, LockdownLogic.maxPendingReminders)
        // Négy ablak mind a hét napra: 28 kezdés + 28 előjelzés = 56, belefér.
        let four = (0..<4).map { window("w\($0)", [0, 1, 2, 3, 4, 5, 6], 60 * $0, 60 * $0 + 30) }
        XCTAssertEqual(LockdownLogic.reminderPlan(four).count, 56)
    }

    func testAnEarlyStartWarnsOnThePreviousDayAndAnAllDayWindowSaysADay() {
        let plan = LockdownLogic.reminderPlan([window("w", [0], 5, 1440)])
        let soon = plan.first { $0.id.hasSuffix(":soon") }
        XCTAssertEqual(soon?.weekday, 7, "vasárnap 0:05 előtt tíz perccel: szombat")
        XCTAssertEqual(soon?.hour, 23); XCTAssertEqual(soon?.minute, 55)
        let start = plan.first { !$0.id.hasSuffix(":soon") }
        XCTAssertTrue(start?.body.contains("23 ó 55 p") ?? false, "0:05-től éjfélig")
        XCTAssertTrue(start?.body.contains("00:00") ?? false, "az éjfél mint vég 00:00")
        XCTAssertEqual(LockdownLogic.reminderPlan([]), [])
    }

    // ------------------------------------------------ a heti ablakos menet előtt

    private func pack(_ id: String, _ days: [Int], _ start: Int, _ end: Int, name: String = "Nyelvtanulás") -> Focus.Pack {
        Focus.Pack(id: id, name: name, allowSites: [], allowApps: [], defaultMinutes: 50,
                   recurrence: ScheduleLogic.Band(days: days, startMin: start, endMin: end))
    }

    func testEveryFocusWindowDayGetsAHeadsUpTenMinutesBefore() {
        let plan = Focus.windowReminderPlan([pack("p1", [3, 1], 18 * 60, 18 * 60 + 50)], used: 0)
        XCTAssertEqual(plan.count, 2, "két nap, napi egy előjelzés")
        XCTAssertTrue(plan.allSatisfy { $0.id.hasPrefix(Focus.windowReminderIdPrefix) })
        XCTAssertEqual(Set(plan.map { $0.id }).count, plan.count, "az azonosítók egyediek")
        XCTAssertEqual(plan.map { $0.weekday }, [2, 4], "hétfő és szerda, napok szerint rendezve")
        XCTAssertTrue(plan.allSatisfy { $0.hour == 17 && $0.minute == 50 }, "tíz perccel előbb")
        XCTAssertTrue(plan.allSatisfy { $0.title == Focus.windowSoonTitle })
        XCTAssertEqual(plan.first?.body, Focus.windowSoonText("Nyelvtanulás", leftMs: Focus.windowSoonMs, endClock: "18:50"))
        XCTAssertTrue(plan.first?.body.contains("10 perc múlva") ?? false)
    }

    func testAFocusWindowAtMidnightWarnsOnThePreviousDay() {
        let plan = Focus.windowReminderPlan([pack("p", [0], 5, 60)], used: 0)
        XCTAssertEqual(plan.first?.weekday, 7, "vasárnap 0:05 előtt tíz perccel: szombat")
        XCTAssertEqual(plan.first?.hour, 23); XCTAssertEqual(plan.first?.minute, 55)
    }

    func testPacksWithoutAValidWindowGetNothing() {
        let none = Focus.Pack(id: "x", name: "X", allowSites: [], allowApps: [], defaultMinutes: 30, recurrence: nil)
        XCTAssertEqual(Focus.windowReminderPlan([none, pack("bad", [], 600, 660)], used: 0), [])
    }

    func testTheFocusPlanGetsOnlyWhatTheLockdownPlanLeavesAndIsAllOrNothing() {
        // Két csomag, mind a hét napra: 14 előjelzés. A keret 64, a tartalék 4.
        let packs = [pack("p_a", [0, 1, 2, 3, 4, 5, 6], 600, 650), pack("p_b", [0, 1, 2, 3, 4, 5, 6], 900, 950)]
        XCTAssertEqual(Focus.windowReminderPlan(packs, used: 64 - 4 - 14).count, 14, "pont belefér")
        XCTAssertEqual(Focus.windowReminderPlan(packs, used: 64 - 4 - 13), [], "eggyel kevesebb hely: egy sem — nem félig")
        // A zárlat-ablakok tervével együtt sosem lépi át a rendszer plafonját.
        let windows = (0..<4).map { window("w\($0)", [0, 1, 2, 3, 4, 5, 6], 60 * $0, 60 * $0 + 30) }
        let lock = LockdownLogic.reminderPlan(windows)
        let total = lock.count + Focus.windowReminderPlan(packs, used: lock.count).count
        XCTAssertLessThanOrEqual(total, LockdownLogic.maxPendingReminders - LockdownLogic.reservedReminders)
    }
}
