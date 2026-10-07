import XCTest
@testable import BreakerShared

/// A szünet végének előre ütemezett értesítése: minden szünetre, ami hosszabb
/// a figyelmeztetésnél, egy kérés a vége előtt két perccel — a frissen indított
/// rövidre semmi (a gép `stepPauseNotices`-ének első hallgatási szabálya).
final class PauseNotifyTests: XCTestCase {
    private let t: Double = 1_800_000_000_000

    func testALongPauseGetsOneReminderTwoMinutesBeforeItsEnd() {
        let plan = PauseNotify.plan([.init(id: "s1", label: "youtube.com", pauseUntil: t + 10 * 60_000, closes: true)], now: t)
        XCTAssertEqual(plan, [.init(
            id: "pause-end-s1", fireAt: t + 8 * 60_000,
            body: "youtube.com 2 perc múlva újra zárva — a szünet véget ér.")])
    }

    func testAShortFreshPauseAndAMissingOneGetNothing() {
        let plan = PauseNotify.plan([
            .init(id: "s1", label: "youtube.com", pauseUntil: t + 60_000, closes: true),
            .init(id: "s2", label: "reddit.com", pauseUntil: nil, closes: true),
            .init(id: "s3", label: "x.com", pauseUntil: t - 1, closes: true),
            .init(id: "s4", label: "y.com", pauseUntil: t + PauseNotify.pauseEndWarnMs, closes: true),
            .init(id: "s5", label: "z.com", pauseUntil: .infinity, closes: true),
            .init(id: "s6", label: "w.com", pauseUntil: .nan, closes: true),
        ], now: t)
        XCTAssertEqual(plan, [])
    }

    func testAPauseThatDoesNotCloseTheSiteGetsNothing() {
        // Hétköznap 9–17 tiltás, 16:30-kor egy órára feloldva: 17:30-kor a
        // menetrend már nyitva hagyja — a „mindjárt újra zárva” hamis volna.
        let plan = PauseNotify.plan([.init(id: "s1", label: "youtube.com", pauseUntil: t + 10 * 60_000, closes: false)], now: t)
        XCTAssertEqual(plan, [])
    }
}
