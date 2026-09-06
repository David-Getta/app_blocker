import Foundation
import XCTest
@testable import BreakerShared

// A munkamenet magja a Swift tükrön — a desktop/test/focus-day-series.test.ts
// és az androidos FocusTest esetei.
final class FocusTests: XCTestCase {

    private func entry(_ startedAt: Double, _ endedAt: Double) -> Focus.LogEntry {
        Focus.LogEntry(packId: "p1", packName: "Nyelvtanulás", startedAt: startedAt, endedAt: endedAt, plannedEndsAt: endedAt, stopped: false)
    }

    private func localTime(_ hour: Int, _ minute: Int) -> Double {
        let d = Calendar.current.date(from: DateComponents(year: 2026, month: 9, day: 5, hour: hour, minute: minute))!
        return d.timeIntervalSince1970 * 1000
    }

    func testDaySeriesCountsASessionOnTheDayItEnded() {
        let day = 86_400_000.0
        let hour = 3_600_000.0
        let now = localTime(20, 0)
        let log = [
            entry(now - 3 * hour, now - 2 * hour),                   // ma, 1 óra
            entry(now - day - hour, now - day),                       // tegnap, 1 óra
            entry(now - day - 30 * 60_000, now - day + 10 * 60_000), // tegnap, 40 perc
            entry(now - 10 * day, now - 10 * day + hour),             // tíz napja: kiesik
            entry(now + hour, now + 2 * hour),                        // a jövő: kiesik
        ]
        let s = Focus.daySeries(log, now: now, count: 7)
        XCTAssertEqual(s.count, 7)
        XCTAssertEqual(s[6].day, UsageStats.dayKey(Date(timeIntervalSince1970: now / 1000)), "az utolsó oszlop a mai nap")
        XCTAssertEqual(s[6].seconds, 3600)
        XCTAssertEqual(s[5].seconds, 6000, "tegnap: egy óra és negyven perc")
        XCTAssertEqual(s.prefix(5).map { $0.seconds }, [0, 0, 0, 0, 0])
    }

    func testASessionAcrossMidnightCountsWhollyOnItsEndDay() {
        let now = localTime(20, 0)
        let midnight = localTime(0, 0)
        let s = Focus.daySeries([entry(midnight - 30 * 60_000, midnight + 30 * 60_000)], now: now, count: 7)
        XCTAssertEqual(s[6].seconds, 3600, "a mai napon egy óra")
        XCTAssertEqual(s[5].seconds, 0, "tegnap semmi")
        XCTAssertEqual(Focus.daySeries([], now: now, count: 3).map { $0.seconds }, [0, 0, 0])
    }
}
