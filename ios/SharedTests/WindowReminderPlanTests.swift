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
}
