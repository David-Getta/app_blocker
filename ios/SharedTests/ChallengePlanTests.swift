import Foundation
import XCTest
@testable import BreakerShared

// A kísérlet ALAKJA a Swift tükrön — a desktop/test/challenges.test.ts és az
// androidos ChallengePlanTest párja.
//
// Két szabály, mindkettő szándékos kellemetlenség: minden fokon több aktív
// próba jár, a végén MINDIG várakozás — és a hátralévő lépések számát a
// felület sosem tudja meg.
final class ChallengePlanTests: XCTestCase {

    func testEveryTierGetsItsActiveStepsAndAlwaysAWait() {
        for tier in 0...3 {
            let want = ChallengeEngine.activeStepCount(tier)
            for _ in 0..<10 {
                let plan = ChallengeEngine.generatePlan(kind: .pause, tier: tier, lastCombo: nil)
                XCTAssertEqual(plan.steps.count, want + 1, "fok \(tier)")
                XCTAssertEqual(plan.steps.last?.typeName, "DELAY", "a végén várakozás áll")
                XCTAssertFalse(plan.steps.dropLast().contains { $0.typeName == "DELAY" })
                if want <= 4 {
                    XCTAssertEqual(Set(plan.steps.dropLast().map { $0.typeName }).count, want)
                }
            }
        }
    }

    func testAShortForcedComboDoesNotBuyLessWork() {
        let plan = ChallengeEngine.generatePlan(
            kind: .pause, tier: 3, lastCombo: nil, forceCombo: "MEMORY+TRANSCRIBE"
        )
        XCTAssertEqual(plan.steps.count, ChallengeEngine.activeStepCount(3) + 1)
        let types = plan.steps.dropLast().map { $0.typeName }
        XCTAssertTrue(types.contains("MEMORY") && types.contains("TRANSCRIBE"),
                      "a kifizetett páros visszajön")
    }

    func testFourStepsMeanOneForcedComboAndNoSpin() {
        // Négy aktív lépésnél minden terv mind a négy típust tartalmazza, tehát
        // nincs másik kombináció. Az „ne ismétlődjön” szabály ilyenkor csak
        // próbálkozás — korlát nélkül a sorsolás örökké pörögne.
        let first = ChallengeEngine.generatePlan(kind: .pause, tier: 1, lastCombo: nil)
        let again = ChallengeEngine.generatePlan(kind: .pause, tier: 1, lastCombo: first.comboKey)
        XCTAssertEqual(first.comboKey, again.comboKey, "ugyanaz a halmaz — mást nem lehet húzni")
    }

    func testTheRemainingCountNeverLeaks() {
        XCTAssertEqual(ChallengeEngine.remainingHint(stepIndex: 0, stepCount: 7), .many)
        XCTAssertEqual(ChallengeEngine.remainingHint(stepIndex: 4, stepCount: 7), .many)
        // Kettő van hátra — de hogy kettő, az nem derül ki.
        XCTAssertEqual(ChallengeEngine.remainingHint(stepIndex: 5, stepCount: 7), .few)
        // Az utolsó lépés sem kap lendületet.
        XCTAssertEqual(ChallengeEngine.remainingHint(stepIndex: 6, stepCount: 7), .few)
        // A legkisebb terv is négy lépés, tehát az indulás mindig „many”.
        XCTAssertEqual(
            ChallengeEngine.remainingHint(stepIndex: 0, stepCount: ChallengeEngine.activeStepCount(0) + 1),
            .many
        )
    }
}
