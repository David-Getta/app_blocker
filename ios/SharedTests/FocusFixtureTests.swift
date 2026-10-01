import CoreFoundation
import Foundation
import XCTest
@testable import BreakerShared

// Megfelelőség a géppel a MUNKAMENET MAGJÁBAN: a `fixtures/focus-cases.json` a
// gép döntéseit tartja (desktop/test/focus-fixture.test.ts írja és őrzi) — az
// ismétlődő menet előfordulásait és az esedékes ablakot, az ablak-menetet, a
// lezárást, a legutóbb használt csomagot, a hátralévő idő szövegét és a percek
// tisztítását. Ha az iPhone más ablakot tartana esedékesnek, a menet itt
// elindulna, a gépen nem — vagy más csomaggal. A napok és az órák helyi
// időben számolnak: a teszt UTC-ben jár, és kimondva kihagy, ha nem tudja.
final class FocusFixtureTests: XCTestCase {

    private func load() throws -> [String: Any] {
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("focus-cases.json")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] ?? [:]
    }

    private func requireUTC() throws {
        setenv("TZ", "UTC", 1)
        CFTimeZoneResetSystem()
        guard TimeZone.current.secondsFromGMT() == 0 else {
            throw XCTSkip("a munkamenet-fixtúra csak UTC-ben játszható vissza; ez a gép: \(TimeZone.current.identifier)")
        }
    }

    private func num(_ v: Any?) -> Double { (v as? NSNumber)?.doubleValue ?? 0 }
    private func optNum(_ v: Any?) -> Double? { v is NSNull || v == nil ? nil : num(v) }
    private func int(_ v: Any?) -> Int { (v as? NSNumber)?.intValue ?? 0 }
    private func str(_ v: Any?) -> String { v as? String ?? "" }

    private func band(_ v: Any?) -> ScheduleLogic.Band? {
        guard let b = v as? [String: Any] else { return nil }
        return ScheduleLogic.Band(days: (b["days"] as? [Any] ?? []).map { int($0) }, startMin: int(b["startMin"]), endMin: int(b["endMin"]))
    }

    private func packs(_ v: Any?) -> [Focus.Pack] {
        (v as? [[String: Any]] ?? []).map {
            Focus.Pack(id: str($0["id"]), name: str($0["name"]), allowSites: [], allowApps: [], defaultMinutes: 30, recurrence: band($0["band"]))
        }
    }

    private func run(_ v: Any?) -> Focus.Run? {
        guard let r = v as? [String: Any] else { return nil }
        return Focus.Run(packId: str(r["packId"]), startedAt: num(r["startedAt"]), endsAt: num(r["endsAt"]))
    }

    private func log(_ v: Any?) -> [Focus.LogEntry] {
        (v as? [[String: Any]] ?? []).map {
            Focus.LogEntry(packId: str($0["packId"]), packName: str($0["packName"]), startedAt: num($0["startedAt"]),
                           endedAt: num($0["endedAt"]), plannedEndsAt: num($0["plannedEndsAt"]),
                           stopped: $0["stopped"] as? Bool ?? false, window: ($0["window"] as? Bool) == true ? true : nil)
        }
    }

    func testTheRecurrenceOccurrenceAndTheDueWindowAreTheSameAsTheDesktopInUTC() throws {
        try requireUTC()
        let cases = try load()["recurrence"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 100, "a fixture-ben van elég eset")
        for c in cases {
            let seed = int(c["seed"])
            let now = num(c["now"])
            let ps = packs(c["packs"])
            let r = run(c["run"])
            for o in c["occ"] as? [[Any]] ?? [] {
                guard let pack = ps.first(where: { $0.id == str(o[0]) }), let b = pack.recurrence else {
                    XCTFail("hiányzó csomag vagy sáv, mag \(seed)"); continue
                }
                let got = Focus.occurrenceAt(b, now: now)
                XCTAssertEqual(got?.startsAt, optNum(o[1]), "előfordulás kezdete, \(pack.id), mag \(seed)")
                XCTAssertEqual(got?.endsAt, optNum(o[2]), "előfordulás vége, \(pack.id), mag \(seed)")
            }
            let due = Focus.dueRecurrence(ps, run: r, log: log(c["log"]), now: now)
            var expected: String?
            if let d = c["due"] as? [Any] { expected = "\(str(d[0]))@\(Int64(num(d[1])))-\(Int64(num(d[2])))" }
            XCTAssertEqual(due.map { "\($0.pack.id)@\(Int64($0.startsAt))-\(Int64($0.endsAt))" }, expected, "esedékes ablak, mag \(seed)")
            if let w = c["windowRun"] as? Bool, let run = r {
                XCTAssertEqual(Focus.isWindowRun(run, packs: ps), w, "ablak-menet, mag \(seed)")
            }
        }
    }

    func testTheWindowRunAtTheEdgesIsTheSameAsTheDesktopInUTC() throws {
        try requireUTC()
        for (i, c) in (try load()["windowRun"] as? [[String: Any]] ?? []).enumerated() {
            guard let r = run(c["run"]) else { XCTFail("menet nélkül, \(i)"); continue }
            XCTAssertEqual(Focus.isWindowRun(r, packs: packs(c["packs"])), c["out"] as? Bool, "ablak-menet \(i)")
        }
    }

    func testClosingWritesTheSameLogRowAsTheDesktopWithTheCap() throws {
        try requireUTC()
        let week: Double = 1_790_553_600_000 // 2026-09-28 UTC, a fixtúra hete
        for (i, c) in (try load()["close"] as? [[String: Any]] ?? []).enumerated() {
            let n = int(c["logLength"])
            let old = (0..<n).map { k -> Focus.LogEntry in
                let at = week - Double(n - k) * 86_400_000
                return Focus.LogEntry(packId: "p_old", packName: "csomag p_old", startedAt: at, endedAt: at + 1_800_000,
                                      plannedEndsAt: at + 1_800_000, stopped: false)
            }
            let res = Focus.closeIfEnded(run(c["run"]), packs: packs(c["packs"]), log: old, now: num(c["now"]))
            guard let out = c["out"] as? [String: Any] else {
                XCTAssertNil(res, "lezárás \(i): nincs teendő")
                continue
            }
            guard let res, let e = res.log.last, let x = out["entry"] as? [String: Any] else {
                XCTFail("lezárás \(i): nem zárt le"); continue
            }
            XCTAssertNil(res.run)
            XCTAssertEqual(e.packId, str(x["packId"]), "lezárás \(i)")
            XCTAssertEqual(e.packName, str(x["packName"]), "lezárás \(i)")
            XCTAssertEqual(e.startedAt, num(x["startedAt"]), "lezárás \(i)")
            XCTAssertEqual(e.endedAt, num(x["endedAt"]), "lezárás \(i)")
            XCTAssertEqual(e.plannedEndsAt, num(x["plannedEndsAt"]), "lezárás \(i)")
            XCTAssertEqual(e.stopped, x["stopped"] as? Bool, "lezárás \(i)")
            XCTAssertEqual(e.window == true, x["window"] as? Bool, "lezárás \(i): ablak-menet")
            XCTAssertEqual(res.log.count, int(out["logLength"]), "lezárás \(i): a napló hossza")
            XCTAssertEqual(res.log.first?.startedAt, num(out["first"]), "lezárás \(i): a napló eleje")
        }
    }

    func testTheLastUsedPackIsTheSameAsTheDesktopFirstOnATie() throws {
        for (i, c) in (try load()["lastUsed"] as? [[String: Any]] ?? []).enumerated() {
            let ps = (c["packs"] as? [String] ?? []).map {
                Focus.Pack(id: $0, name: $0, allowSites: [], allowApps: [], defaultMinutes: 30)
            }
            let lg = (c["log"] as? [[Any]] ?? []).map { p -> Focus.LogEntry in
                let at = num(p[1])
                return Focus.LogEntry(packId: str(p[0]), packName: str(p[0]), startedAt: at, endedAt: at + 1_800_000,
                                      plannedEndsAt: at + 1_800_000, stopped: false)
            }
            XCTAssertEqual(Focus.lastUsedPack(ps, log: lg)?.id, c["out"] as? String, "legutóbbi csomag \(i)")
        }
    }

    func testTheRemainingTextAndTheMinutesAreTheSameAsTheDesktop() throws {
        let f = try load()
        for p in f["remaining"] as? [[Any]] ?? [] {
            XCTAssertEqual(Focus.formatRemaining(num(p[0])), str(p[1]), "hátralévő \(num(p[0])) ms")
        }
        for p in f["minutes"] as? [[Any]] ?? [] {
            let expected: Int? = p[1] is NSNull ? nil : int(p[1])
            XCTAssertEqual(Focus.normalizeMinutes(num(p[0])), expected, "percek \(num(p[0]))")
        }
    }
}
