import XCTest
@testable import BreakerShared

/// A dróton jött abszurd idő (egy zárlat vége 1e300-on, egy végtelen, egy NaN)
/// nem állíthatja le az appot: a Swift `Int(_:)` ilyenkor összeomlana, a
/// formázók ezért a telítő `clampedInt`-en át alakítanak.
final class SafeIntTests: XCTestCase {
    func testClampedIntSaturatesInsteadOfCrashing() {
        XCTAssertEqual(clampedInt(.nan), 0)
        XCTAssertEqual(clampedInt(.infinity), Int(1e15))
        XCTAssertEqual(clampedInt(-.infinity), -Int(1e15))
        XCTAssertEqual(clampedInt(1e300), Int(1e15))
        XCTAssertEqual(clampedInt(42.9), 42)
        XCTAssertEqual(clampedInt(-3), -3)
    }

    func testTheFormattersSurviveAbsurdWireValues() {
        for ms in [1e300, -1e300, Double.infinity, -Double.infinity, Double.nan] {
            _ = LockdownLogic.formatRemaining(ms)
            _ = Focus.formatRemaining(ms)
            _ = PauseNotify.text("x", leftMs: ms)
            _ = DigestLogic.hm(ms)
        }
        // A szokásos értékek változatlanok.
        XCTAssertEqual(LockdownLogic.formatRemaining(90 * 60_000), "1 ó 30 p")
        XCTAssertEqual(Focus.formatRemaining(30 * 60_000), "30 perc")
        XCTAssertEqual(PauseNotify.text("x", leftMs: 120_000), "x 2 perc múlva újra zárva — a szünet véget ér.")
    }
}
