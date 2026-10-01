import Foundation
import XCTest
@testable import BreakerShared

// Megfelelőség a géppel a PRÓBATÉTEL VÁLASZÁBAN: a `fixtures/challenge-cases.json`
// a gép döntéseit tartja (desktop/test/challenge-fixture.test.ts írja és őrzi) —
// a fok a feloldások naplójából, a hátralévő-jelzés, a kombináció-kulcs, és a
// válasz: ugyanaz a lépés, ugyanaz a beírás, ugyanaz az időpont az iPhone
// motorjába megy, és jó-e, kész-e, marad-e a lépés, hol áll a lánc — mind
// egyezzen. Az új lépés tartalma véletlen, azt nem hasonlítjuk.
//
// Az első írás két iPhone-eltérést igazított: a kód mellől a sorvég nem vágódott
// le, és az átgépelés a kanonikusan egyenértékű (NFD) alakot is elfogadta — a
// gép és az Android nem.
final class ChallengeFixtureTests: XCTestCase {

    private func load() throws -> [String: Any] {
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("challenge-cases.json")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] ?? [:]
    }

    private func num(_ v: Any?) -> Double { (v as? NSNumber)?.doubleValue ?? 0 }
    private func int(_ v: Any?) -> Int { (v as? NSNumber)?.intValue ?? 0 }
    private func str(_ v: Any?) -> String { v as? String ?? "" }
    private func optNum(_ v: Any?) -> Double? { v is NSNull || v == nil ? nil : num(v) }

    func testTheTierFromTheUnlockLogIsTheSameAsTheDesktop() throws {
        let cases = try load()["tiers"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 40, "a fixture-ben van elég napló")
        for c in cases {
            let log = (c["unlockLog"] as? [Any] ?? []).map { num($0) }
            XCTAssertEqual(ChallengeEngine.computeTier(log, now: num(c["now"])), int(c["tier"]), "fok, napló \(log)")
        }
    }

    func testTheRemainingHintIsTheSameAsTheDesktop() throws {
        let cases = try load()["remaining"] as? [[String: Any]] ?? []
        for c in cases {
            let got = ChallengeEngine.remainingHint(stepIndex: int(c["stepIndex"]), stepCount: int(c["stepCount"]))
            XCTAssertEqual(got == .many ? "many" : "few", str(c["hint"]), "jelzés \(int(c["stepIndex"]))/\(int(c["stepCount"]))")
        }
    }

    func testTheComboKeyReadsAndWritesTheSameAsTheDesktop() throws {
        let cases = try load()["combos"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 15, "a fixture-ben van elég kulcs")
        for c in cases {
            let key = c["key"] as? String
            let types = ChallengeEngine.parseCombo(key)
            XCTAssertEqual(types, c["types"] as? [String], "kulcs \((key ?? "").debugDescription)")
            XCTAssertEqual(types.map { ChallengeEngine.comboKeyOf($0) }, c["combo"] as? String, "kulcs vissza \((key ?? "").debugDescription)")
        }
    }

    private func step(_ o: [String: Any]) -> ChallengeEngine.Step? {
        let id = str(o["id"])
        switch str(o["type"]) {
        case "TRANSCRIBE": return .transcribe(id: id, text: str(o["text"]))
        case "REVERSE": return .reverse(id: id, text: str(o["text"]))
        case "MATH_CHAIN":
            let problems = (o["problems"] as? [[String: Any]] ?? []).map { ChallengeEngine.Problem(q: str($0["q"]), a: int($0["a"])) }
            return .mathChain(id: id, problems: problems, pos: int(o["pos"]))
        case "MEMORY":
            return .memory(id: id, code: str(o["code"]), showMs: int(o["showMs"]), waitMs: int(o["waitMs"]), armedAt: optNum(o["armedAt"]))
        case "DELAY":
            return .delay(id: id, minutes: int(o["minutes"]), claimableAt: optNum(o["claimableAt"]), claimWindowMs: int(o["claimWindowMs"]))
        case "PARTNER": return .partner(id: id, name: str(o["name"]))
        default: return nil
        }
    }

    func testTheAnswerCountsTheSameAsTheDesktop() throws {
        let cases = try load()["answers"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 100, "a fixture-ben van elég válasz")
        var ok = 0
        for c in cases {
            let seed = int(c["seed"])
            guard let step = step(c["step"] as? [String: Any] ?? [:]) else { XCTFail("ismeretlen lépés, mag \(seed)"); continue }
            let answer = str(c["answer"])
            let out = ChallengeEngine.applyAnswer(step, answer: answer, tier: 0, kind: .pause, now: num(c["now"]))
            let label = "válasz \(answer.debugDescription), lépés \(step.id), mag \(seed)"
            XCTAssertEqual(out.ok, c["ok"] as? Bool, "jó-e: \(label)")
            XCTAssertEqual(out.done, c["done"] as? Bool, "kész-e: \(label)")
            XCTAssertEqual(out.step.id == step.id, c["kept"] as? Bool, "marad-e a lépés: \(label)")
            var pos: Int? = nil
            if case .mathChain(_, _, let p) = out.step { pos = p }
            XCTAssertEqual(pos, (c["pos"] as? NSNumber)?.intValue, "a lánc helye: \(label)")
            if out.ok { ok += 1 }
        }
        XCTAssertGreaterThan(ok, 40, "kevés jó válasz — a fixtúra elfajult")
    }
}
