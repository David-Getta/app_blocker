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

    func testLimitSoonLinePicksTheMostUrgentSiteWithinTheThreshold() {
        XCTAssertEqual(LimitLogic.limitSoonSeconds, 600)
        XCTAssertEqual(LimitLogic.limitRemaining(600, 200), 400)
        XCTAssertEqual(LimitLogic.limitRemaining(600, 700), 0, "nem megy nulla alá")
        XCTAssertNil(LimitLogic.limitRemaining(nil, 200), "keret nélkül nincs maradék")
        let two: [(label: String, dailyLimitSeconds: Double?, usedSeconds: Double)] = [
            ("youtube.com", 600, 300), // 5 perc
            ("x.com", 600, 480),       // 2 perc — sürgősebb
            ("reddit.com", 3600, 60),  // 59 perc — messze
        ]
        XCTAssertEqual(LimitLogic.limitSoonLine(two), "Ma még 2 perc a kereted: x.com.")
        XCTAssertEqual(LimitLogic.limitSoonLine([("a", 600, 539)]), "Ma még 2 perc a kereted: a.", "felfelé kerekít")
        XCTAssertEqual(LimitLogic.limitSoonLine([("a", 600, 600)]), "", "betelt: nem heads-up")
        XCTAssertEqual(LimitLogic.limitSoonLine([("a", 3600, 0)]), "", "messze: nincs sor")
        XCTAssertEqual(LimitLogic.limitSoonLine([("a", nil, 500)]), "", "keret nélkül nincs")
        // Kis keret: a hátsó felében szólal meg, nem a legelső perctől.
        XCTAssertEqual(LimitLogic.limitSoonLine([("a", 300, 0)]), "", "öt perces keret, 0 elhasználva: még nem szól")
        XCTAssertEqual(LimitLogic.limitSoonLine([("a", 300, 200)]), "Ma még 2 perc a kereted: a.", "öt perces keret: a hátsó felében szól")
        XCTAssertEqual(LimitLogic.limitSoonLine([]), "")
    }

    /// A szünet végén ugyanaz a döntés, a szünetet nem számítva — a gépi
    /// `closesAfterPause` tükre. iPhone-on a keretet a többi eszköz mérése fogyasztja.
    func testClosesAfterPauseIsTheSameDecisionAtThePausesEnd() {
        let cal = LocalCalendar.gregorian
        // 2026. május 20., szerda 15:00 helyi idő.
        let wed = (cal.date(from: DateComponents(year: 2026, month: 5, day: 20, hour: 15))?.timeIntervalSince1970 ?? 0) * 1000
        let tomorrow = (cal.date(from: DateComponents(year: 2026, month: 5, day: 21, hour: 0, minute: 30))?.timeIntervalSince1970 ?? 0) * 1000
        let work = ScheduleLogic.Schedule(mode: .block, bands: [ScheduleLogic.Band(days: [1, 2, 3, 4, 5], startMin: 540, endMin: 1020)])
        let open = ScheduleLogic.Schedule(mode: .allow, bands: [ScheduleLogic.Band(days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440)])
        func site(_ pause: Double?, _ schedule: ScheduleLogic.Schedule?, limit: Double? = nil) -> Site {
            Site(id: "s", domain: "youtube.com", hostnames: ["youtube.com"], addedAt: 0,
                 pauseUntil: pause, pendingDeleteAt: nil, schedule: schedule, dailyLimitSeconds: limit)
        }
        let none = UsageStats.State()
        XCTAssertTrue(LimitLogic.closesAfterPause(site(wed + 90 * 60_000, work), none, nil), "16:30-kor még munkaidő")
        XCTAssertFalse(LimitLogic.closesAfterPause(site(wed + 150 * 60_000, work), none, nil), "17:30-kor a tiltás már véget ért")
        XCTAssertTrue(LimitLogic.closesAfterPause(site(wed + 60_000, nil), none, nil), "menetrend nélkül mindig zárul")
        XCTAssertFalse(LimitLogic.closesAfterPause(site(nil, nil), none, nil), "szünet nélkül nincs miről szólni")
        XCTAssertFalse(LimitLogic.closesAfterPause(site(.nan, nil), none, nil))
        // A keret: a gép ma elfogyasztotta — a szünet végén zárul; éjfél után új nap, új keret.
        let today = UsageStats.dayKey(Date(timeIntervalSince1970: wed / 1000))
        let shared = LimitLogic.SharedToday(selfDeviceId: "me", devices: [
            LimitLogic.TodayDigest(deviceId: "pc", day: today, seconds: [UsageStats.siteKey("youtube.com"): 600]),
        ])
        XCTAssertTrue(LimitLogic.closesAfterPause(site(wed + 60_000, open, limit: 600), none, shared))
        XCTAssertFalse(LimitLogic.closesAfterPause(site(wed + 60_000, open, limit: 1200), none, shared), "van még keret")
        XCTAssertFalse(LimitLogic.closesAfterPause(site(tomorrow, open, limit: 600), none, shared), "új nap, új keret")
    }
}
