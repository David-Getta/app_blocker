import CoreFoundation
import Foundation
import XCTest
@testable import BreakerShared

// Megfelelőség a géppel az ÓRAÁTÁLLÍTÁS éjszakáján: a `fixtures/dst-cases.json`
// a gép döntéseit tartja (desktop/test/dst-fixture.test.ts írja és őrzi),
// Europe/Budapest időzónában — a hajnali sávok előfordulását és a menetrend
// döntését a 2026-os tavaszi és őszi átállás körül. A kétszer előforduló
// falióra-idő az első, a kihagyott az átállás előtti eltolással (a JS
// szabálya); a Foundation magától ezt verziónként máshogy dönti el. A teszt
// kimondva kihagy, ha az időzónát nem tudja átállítani.
final class DstFixtureTests: XCTestCase {

    private func load() throws -> [String: Any] {
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("dst-cases.json")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] ?? [:]
    }

    private func num(_ v: Any?) -> Double { (v as? NSNumber)?.doubleValue ?? 0 }
    private func int(_ v: Any?) -> Int { (v as? NSNumber)?.intValue ?? 0 }

    private func pair(_ v: Any?) -> String? {
        guard let a = v as? [Any], a.count == 2 else { return nil }
        return "\(Int64(num(a[0])))-\(Int64(num(a[1])))"
    }

    override func tearDown() {
        // A többi teszt UTC-ben jár; ne hagyjuk itt a budapesti időt.
        setenv("TZ", "UTC", 1)
        CFTimeZoneResetSystem()
        super.tearDown()
    }

    func testTheOccurrencesAndTheScheduleDecisionsAcrossTheDstNightsAreTheSameAsTheDesktop() throws {
        setenv("TZ", "Europe/Budapest", 1)
        CFTimeZoneResetSystem()
        guard TimeZone.current.identifier == "Europe/Budapest" else {
            throw XCTSkip("az időzóna nem állítható Europe/Budapestre; ez a gép: \(TimeZone.current.identifier)")
        }
        let f = try load()
        XCTAssertEqual(f["tz"] as? String, "Europe/Budapest")
        let cases = f["cases"] as? [[String: Any]] ?? []
        XCTAssertGreaterThan(cases.count, 200, "a fixture-ben van elég eset")
        var misses: [String] = []
        for (i, c) in cases.enumerated() {
            let b = c["band"] as? [String: Any] ?? [:]
            let band = ScheduleLogic.Band(days: (b["days"] as? [Any] ?? []).map { int($0) }, startMin: int(b["startMin"]), endMin: int(b["endMin"]))
            let t = num(c["t"])
            let occ = Focus.occurrenceAt(band, now: t).map { "\(Int64($0.startsAt))-\(Int64($0.endsAt))" }
            let next = Focus.nextOccurrence(band, now: t).map { "\(Int64($0.startsAt))-\(Int64($0.endsAt))" }
            let s = ScheduleLogic.Schedule(mode: .block, bands: [band])
            let got = "\(occ ?? "-") \(next ?? "-") \(ScheduleLogic.isBlockedBySchedule(s, t)) \(Int64(ScheduleLogic.nextCloseAt(s, t))) \(Int64(ScheduleLogic.nextOpenAt(s, t)))"
            let want = "\(pair(c["occ"]) ?? "-") \(pair(c["next"]) ?? "-") \(c["blocked"] as? Bool ?? false) \(Int64(num(c["close"]))) \(Int64(num(c["open"])))"
            if got != want { misses.append("eset \(i) (sáv \(band.days) \(band.startMin)–\(band.endMin), t=\(Int64(t))): gép \(want), iPhone \(got)") }
        }
        XCTAssertTrue(misses.isEmpty, "\(misses.count) eltérés:\n" + misses.prefix(12).joined(separator: "\n"))
    }
}
