import XCTest
@testable import BreakerShared

/// A Firefox kanárija: csak a pontos név — egy aldomain vagy hasonló név nem.
/// A tükör: android/jvm-tests/.../DohCanaryTest.kt.
final class DohCanaryTests: XCTestCase {
    func testTheCanaryMatchesInAnyCaseAndWithTheRootDot() {
        XCTAssertTrue(DohCanary.matches("use-application-dns.net"))
        XCTAssertTrue(DohCanary.matches("Use-Application-DNS.net"))
        XCTAssertTrue(DohCanary.matches("use-application-dns.net."))
    }

    func testNothingElseMatches() {
        for n in ["www.use-application-dns.net", "use-application-dns.net.evil.com",
                  "application-dns.net", "dns.google", "", "net"] {
            XCTAssertFalse(DohCanary.matches(n), n)
        }
    }
}
