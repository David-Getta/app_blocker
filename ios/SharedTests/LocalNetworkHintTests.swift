import XCTest
@testable import BreakerShared

/// A helyi hálózat engedélyhez kötött (iOS 14, macOS 15): aki a rendszer
/// kérdésére nemet mondott, annak a gépen futó szinkron-kiszolgáló
/// „nem érhető el”. Helyi címnél a hiba ezért megmondja, hol kapcsolható be —
/// máskor nem.
final class LocalNetworkHintTests: XCTestCase {
    func testPrivateAndLinkLocalAddressesAreLocal() {
        for host in ["192.168.1.10", "10.0.0.5", "172.16.0.1", "172.31.255.254", "169.254.3.4",
                     "breaker-gep.local", "Breaker-Gep.LOCAL", "[fd12:3456::1]", "fe80::1", "fc00::2"] {
            XCTAssertTrue(SyncClient.isLocalNetworkHost(host), host)
        }
    }

    func testPublicLoopbackAndMalformedAreNot() {
        for host in ["8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.1.1", "127.0.0.1", "::1",
                     "localhost", "example.com", "sync.example.hu", "192.168.1", "192.168.1.256",
                     "192.168.1.1.5", "١٩٢.١٦٨.١.١", "2001:db8::1", ""] {
            XCTAssertFalse(SyncClient.isLocalNetworkHost(host), host)
        }
    }

    func testTheHintSaysWhereToTurnItOn() {
        XCTAssertTrue(SyncClient.localNetworkHint.contains("Adatvédelem és biztonság › Helyi hálózat"))
        XCTAssertTrue(SyncClient.localNetworkHint.hasPrefix("Ha a Breakernek nem engedted"))
    }
}
