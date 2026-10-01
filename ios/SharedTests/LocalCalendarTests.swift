import CoreFoundation
import Foundation
import XCTest
@testable import BreakerShared

// A mag naptára GREGORIÁN, akármit állított be a felhasználó.
//
// A `Calendar.current` a beállított naptárat követi: buddhista naptárnál az év
// 2569, japánnál 8. A napkulcs viszont a szinkron közös nyelve — a gép és az
// Android gregorián évet ír —, és a közös napi keret a többi eszköz sorát csak
// a mai napkulcs egyezésekor számolja. Buddhista naptárú iPhone-on a keret így
// sosem érvényesült volna. A mag ezért `LocalCalendar.gregorian`-t használ, és
// a `scripts/check-core-sync.js` tiltja a `Calendar.current`-et a magban.
final class LocalCalendarTests: XCTestCase {

    func testTheCoreCalendarIsGregorianWhateverTheUserPicked() throws {
        setenv("TZ", "UTC", 1)
        CFTimeZoneResetSystem()
        guard TimeZone.current.secondsFromGMT() == 0 else {
            throw XCTSkip("a naptár-teszt csak UTC-ben fut; ez a gép: \(TimeZone.current.identifier)")
        }
        let ms: Double = 1_790_856_000_000 // 2026-10-01 12:00 UTC, csütörtök
        let date = Date(timeIntervalSince1970: ms / 1000)
        var buddhist = Calendar(identifier: .buddhist)
        buddhist.timeZone = TimeZone(identifier: "UTC")!
        var japanese = Calendar(identifier: .japanese)
        japanese.timeZone = TimeZone(identifier: "UTC")!
        // Amit a felhasználó naptára adna — és amit a mag NEM használhat.
        XCTAssertEqual(buddhist.component(.year, from: date), 2569)
        XCTAssertEqual(japanese.component(.year, from: date), 8)
        // Amit a mag ad: a gép és az Android napkulcsa.
        XCTAssertEqual(LocalCalendar.gregorian.component(.year, from: date), 2026)
        XCTAssertEqual(UsageStats.dayKey(date), "2026-10-01")
        XCTAssertEqual(FilterHitLogic.dayKey(ms), "2026-10-01")
        XCTAssertEqual(DigestLogic.weekKey(ms), "2026-09-28")
        XCTAssertEqual(DigestLogic.weekLabel(DigestLogic.weekKey(ms)), "2026. 09. 28.")
    }
}
