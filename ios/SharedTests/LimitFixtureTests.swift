import CoreFoundation
import Foundation
import XCTest
@testable import BreakerShared

// Megfelelőség a géppel a NAPI KERETBEN: a `fixtures/limit-cases.json` a gép
// döntéseit tartja (desktop/test/limit-fixture.test.ts írja és őrzi) — a dróton
// jövő napi összegzést a blob szövegéből, a keret betelt napjait és a sorát, a
// „ma még N perc” sort, a lazítást, a hátralévőt, és hogy kimerült-e a keret a
// többi eszköz percével. Itt ugyanazok a bemenetek az iPhone magjába mennek.
//
// Az iPhone nem mér, de a keret itt is ÉRVÉNYESÜL a többi eszköz percéből —
// ha a gép blobját másképp olvasná (az `as? Double` az igaz/hamisat is számnak
// vette), a keret itt hamarabb telne be. A napok helyi időben számolnak: a
// teszt UTC-ben jár, és kimondva kihagy, ha ezt nem tudja beállítani.
final class LimitFixtureTests: XCTestCase {

    private func load() throws -> [String: Any] {
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("limit-cases.json")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] ?? [:]
    }

    private func requireUTC() throws {
        setenv("TZ", "UTC", 1)
        CFTimeZoneResetSystem()
        guard TimeZone.current.secondsFromGMT() == 0 else {
            throw XCTSkip("a keret-fixtúra csak UTC-ben játszható vissza; ez a gép: \(TimeZone.current.identifier)")
        }
    }

    private func num(_ v: Any?) -> Double { (v as? NSNumber)?.doubleValue ?? 0 }
    private func optNum(_ v: Any?) -> Double? { v is NSNull || v == nil ? nil : num(v) }
    private func int(_ v: Any?) -> Int { (v as? NSNumber)?.intValue ?? 0 }

    private func seconds(_ v: Any?) -> [String: Double] {
        var out: [String: Double] = [:]
        for (k, x) in v as? [String: Any] ?? [:] { out[k] = num(x) }
        return out
    }

    private func usage(_ v: Any?) -> UsageStats.State {
        UsageStats.State(days: (v as? [[String: Any]] ?? []).map {
            UsageStats.Day(day: $0["day"] as? String ?? "", seconds: seconds($0["seconds"]))
        })
    }

    func testTheTodayDigestFromTheWireReadsTheSameAsTheDesktop() throws {
        let cases = try load()["digests"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 80, "a fixture-ben van elég blob")
        for (i, c) in cases.enumerated() {
            let text = c["text"] as? String ?? ""
            let got = LimitLogic.parseTodayDigest(text, deviceId: "dev_masik")
            let label = "blob \(i): \(text.prefix(120))"
            guard let out = c["out"] as? [String: Any] else {
                XCTAssertNil(got, label)
                continue
            }
            guard let d = got else { XCTFail("nem olvasta: \(label)"); continue }
            XCTAssertEqual(d.deviceId, "dev_masik")
            XCTAssertEqual(d.day, out["day"] as? String, label)
            let expected = (out["seconds"] as? [[Any]] ?? []).map { "\($0[0] as? String ?? "")=\(int($0[1]))" }
            let actual = d.seconds.sorted { LimitLogic.utf16Less($0.key, $1.key) }.map { "\($0.key)=\(Int($0.value))" }
            XCTAssertEqual(actual, expected, label)
        }
    }

    func testTheFullDaysAndTheirLineAreTheSameAsTheDesktopInUTC() throws {
        try requireUTC()
        let cases = try load()["fullDays"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 40, "a fixture-ben van elég hét")
        for (i, c) in cases.enumerated() {
            let limits = (c["limits"] as? [[Any]] ?? []).map { (domain: $0[0] as? String ?? "", limit: optNum($0[1])) }
            let r = LimitLogic.limitFullDays(usage(c["days"]), limits: limits, now: num(c["now"]))
            XCTAssertEqual(r.days, int(c["full"]), "napok, hét \(i)")
            let expected = (c["bySite"] as? [[Any]] ?? []).map { "\($0[0] as? String ?? "")=\(int($0[1]))" }
            XCTAssertEqual(r.bySite.map { "\($0.domain)=\($0.days)" }, expected, "oldalak, hét \(i)")
            XCTAssertEqual(LimitLogic.limitFullLine(r, labelOf: { "[\($0)]" }), c["line"] as? String, "sor, hét \(i)")
        }
    }

    func testTheLimitSoonLineIsTheSameAsTheDesktop() throws {
        let cases = try load()["soon"] as? [[String: Any]] ?? []
        for (i, c) in cases.enumerated() {
            let candidates = (c["candidates"] as? [[Any]] ?? []).map {
                (label: $0[0] as? String ?? "", dailyLimitSeconds: optNum($0[1]), usedSeconds: num($0[2]))
            }
            XCTAssertEqual(LimitLogic.limitSoonLine(candidates), c["line"] as? String, "sor \(i)")
        }
    }

    func testLooseningAndRemainingAreTheSameAsTheDesktop() throws {
        let f = try load()
        for c in f["loosening"] as? [[String: Any]] ?? [] {
            let cur = optNum(c["cur"]), next = optNum(c["next"])
            XCTAssertEqual(LimitLogic.isLimitLoosening(cur, next), c["loosening"] as? Bool, "lazítás \(String(describing: cur)) -> \(String(describing: next))")
        }
        for c in f["remaining"] as? [[String: Any]] ?? [] {
            let limit = optNum(c["limit"]), used = num(c["used"])
            XCTAssertEqual(LimitLogic.limitRemaining(limit, used), optNum(c["remaining"]), "hátralévő \(String(describing: limit)) / \(used)")
        }
    }

    func testTheBudgetIsExhaustedTheSameAsTheDesktopWithTheOtherDevicesInUTC() throws {
        try requireUTC()
        let cases = try load()["exhausted"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 100, "a fixture-ben van elég döntés")
        for (i, c) in cases.enumerated() {
            let now = num(c["now"])
            let today = UsageStats.dayKey(Date(timeIntervalSince1970: now / 1000))
            let local = num(c["local"])
            let state = UsageStats.State(days: [
                UsageStats.Day(day: today, seconds: local > 0 ? [UsageStats.siteKey("youtube.com"): local] : [:]),
            ])
            let devices = (c["shared"] as? [[String: Any]] ?? []).map {
                LimitLogic.TodayDigest(deviceId: $0["deviceId"] as? String ?? "", day: $0["day"] as? String ?? "", seconds: seconds($0["seconds"]))
            }
            let shared = LimitLogic.SharedToday(selfDeviceId: "dev_self", devices: devices)
            let got = LimitLogic.isLimitExhausted(domain: "youtube.com", dailyLimitSeconds: optNum(c["limit"]),
                                                  usage: state, shared: shared, now: now)
            XCTAssertEqual(got, c["exhausted"] as? Bool, "döntés \(i): keret \(String(describing: optNum(c["limit"]))), helyi \(local)")
        }
    }
}
