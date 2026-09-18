// A napi keret tükre: a keret betelt napjai — ugyanaz a válasz, mint a gépen és Androidon.
import Foundation
import XCTest
@testable import BreakerShared

final class LimitsTests: XCTestCase {
    func testTheDaysTheBudgetFilledAndTheLine() {
        let now = Date().timeIntervalSince1970 * 1000
        let today = UsageStats.dayKey(Date(timeIntervalSince1970: now / 1000))
        let yesterday = UsageStats.dayKey(Date(timeIntervalSince1970: (now - 86_400_000) / 1000))
        let old = UsageStats.dayKey(Date(timeIntervalSince1970: (now - 8 * 86_400_000) / 1000))
        var u = UsageStats.State()
        u.days = [
            UsageStats.Day(day: today, seconds: [UsageStats.siteKey("youtube.com"): 700]),
            UsageStats.Day(day: yesterday, seconds: [UsageStats.siteKey("youtube.com"): 500, UsageStats.siteKey("reddit.com"): 400]),
            UsageStats.Day(day: old, seconds: [UsageStats.siteKey("youtube.com"): 900]), // nyolc napja: nem a hété
        ]
        let r = LimitLogic.limitFullDays(u, limits: [("youtube.com", 600), ("reddit.com", 300), ("x.com", nil)], now: now)
        XCTAssertEqual(r.days, 2, "ma a youtube, tegnap a reddit — két nap")
        XCTAssertEqual(r.bySite, [LimitLogic.SiteDays(domain: "reddit.com", days: 1), LimitLogic.SiteDays(domain: "youtube.com", days: 1)])
        XCTAssertEqual(LimitLogic.limitFullLine(r) { $0 }, "A napi keret a héten 2 napon betelt: reddit.com 1× · youtube.com 1×.")
        XCTAssertEqual(LimitLogic.limitFullLine(LimitLogic.limitFullDays(u, limits: [("x.com", nil)], now: now)) { $0 }, "", "keret nélkül nincs sor")
        XCTAssertEqual(LimitLogic.limitFullDays(u, limits: [], now: now).days, 0)
    }
}
