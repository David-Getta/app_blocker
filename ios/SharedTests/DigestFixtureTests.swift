import Foundation
import XCTest
@testable import BreakerShared

// Megfelelőség a géppel a HETI VISSZATEKINTÉS mondatában: a
// `fixtures/digest-cases.json` a gép mondatait tartja egy-egy hét számaira
// (desktop/test/digest-fixture.test.ts írja és őrzi). Itt ugyanazok a számok
// az iPhone mondat-írójába mennek, és a mondatnak egyeznie kell — EGY kimondott
// szót leszámítva: a megakadás szava a platformé (a gépen a böngésző, a
// telefonon a szűrő akaszt meg), ezt a gépére írjuk át.
final class DigestFixtureTests: XCTestCase {

    private func load() throws -> [[String: Any]] {
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("digest-cases.json")
        let top = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        return top?["cases"] as? [[String: Any]] ?? []
    }

    private func num(_ v: Any?) -> Double { (v as? NSNumber)?.doubleValue ?? 0 }
    private func int(_ v: Any?) -> Int { (v as? NSNumber)?.intValue ?? 0 }

    private func tops(_ v: Any?) -> [Digest.Top] {
        (v as? [[String: Any]] ?? []).map { Digest.Top(label: $0["label"] as? String ?? "", seconds: num($0["seconds"])) }
    }

    private func summary(_ v: Any?) -> Focus.Summary? {
        guard let o = v as? [String: Any] else { return nil }
        var s = Focus.Summary(sessions: int(o["sessions"]), totalMs: num(o["totalMs"]), stoppedEarly: int(o["stoppedEarly"]),
                              topPack: o["topPack"] as? String)
        s.windowRuns = int(o["windowRuns"])
        return s
    }

    private func hourCount(_ v: Any?) -> (hour: Int, count: Int)? {
        guard let o = v as? [String: Any] else { return nil }
        return (int(o["hour"]), int(o["count"]))
    }

    private func dayCount(_ v: Any?) -> (day: Int, count: Int)? {
        guard let o = v as? [String: Any] else { return nil }
        return (int(o["day"]), int(o["count"]))
    }

    /// A gép DigestInput-ja az iPhone Input-jává: a hiányzó mező a régi hívó alapértéke.
    private func input(_ o: [String: Any]) -> Digest.Input {
        var input = Digest.Input(
            last7Seconds: num(o["last7Seconds"]),
            topWeekSites: tops(o["topWeekSites"]),
            topWeekApps: tops(o["topWeekApps"]),
            weekOverWeek: (o["weekOverWeek"] as? [[String: Any]] ?? []).map {
                Digest.Delta(label: $0["label"] as? String ?? "", deltaPct: ($0["deltaPct"] as? NSNumber)?.doubleValue)
            },
            focusWeek: summary(o["focusWeek"]) ?? Focus.Summary(sessions: 0, totalMs: 0, stoppedEarly: 0, topPack: nil),
            unlocks7d: int(o["unlocks7d"]),
            daysTracked: int(o["daysTracked"]),
            unblockedTop: tops(o["unblockedTop"]),
            dropped7d: int(o["dropped7d"]),
            filterHits7d: int(o["browserHits7d"]),
            filterHitsPeak: hourCount(o["browserHitsPeak"]),
            filterHitsPeakPack: o["browserHitsPeakPack"] as? String,
            filterHitsTop: (o["browserHitsTop"] as? [String: Any]).map { (label: $0["label"] as? String ?? "", count: int($0["count"])) },
            filterHitsPrev7d: int(o["browserHitsPrev7d"]),
            focusPrevWeek: summary(o["focusPrevWeek"]),
            unlocksPrev7d: int(o["unlocksPrev7d"]),
            limitFullDays: int(o["limitFullDays"]),
            burstTripsWeek: int(o["burstTripsWeek"])
        )
        input.peakWindowOffer = o["peakWindowOffer"] as? Bool ?? false
        input.filterHitsWeekday = dayCount(o["browserHitsWeekday"])
        input.focusWeekday = dayCount(o["focusWeekday"])
        input.usageWeekday = dayCount(o["usageWeekday"])
        input.focusHour = hourCount(o["focusHour"])
        input.focusStreak = int(o["focusStreak"])
        input.focusLongestStreak = int(o["focusLongestStreak"])
        input.focusHourPack = o["focusHourPack"] as? String
        input.focusHourWindowOffer = o["focusHourWindowOffer"] as? Bool ?? false
        return input
    }

    func testTheWeeklyDigestSentenceIsTheSameAsTheDesktopExceptThePlatformWord() throws {
        let cases = try load()
        XCTAssertGreaterThanOrEqual(cases.count, 60, "a fixture-ben van elég eset")
        var sentences = 0
        for c in cases {
            let seed = c["seed"] as? Int ?? -1
            let expected = c["text"] as? String
            // A platform szava: a gépen a böngésző-bővítmény, az iPhone-on a DNS-szűrő akaszt meg.
            let got = Digest.text(input(c["input"] as? [String: Any] ?? [:]), labelOf: { "[\($0)]" })?
                .replacingOccurrences(of: " a szűrőben", with: " a böngészőben")
            XCTAssertEqual(got, expected, "visszatekintés, mag \(seed)")
            if got != nil { sentences += 1 }
        }
        XCTAssertGreaterThan(sentences, 30, "kevés mondat — a fixtúra elfajult")
    }
}
