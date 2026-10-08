import XCTest
@testable import BreakerShared

/// A titkosított DNS nyoma: melyik név számít, mikor jegyezzük fel újra, és mit
/// mond a kártya. A tükör: android/jvm-tests/.../DohHostsTest.kt.
final class DohHostsTests: XCTestCase {
    private let min: Double = 60_000
    private var hour: Double { 60 * min }
    private let t: Double = 1_000_000_000_000

    func testKnownNamesMatchInAnyCaseAndWithTheRootDot() {
        XCTAssertEqual(DohHosts.hostOf("dns.google"), "dns.google")
        XCTAssertEqual(DohHosts.hostOf("DNS.Google."), "dns.google")
        XCTAssertEqual(DohHosts.hostOf("cloudflare-dns.com"), "cloudflare-dns.com")
        XCTAssertEqual(DohHosts.hostOf("mozilla.cloudflare-dns.com"), "mozilla.cloudflare-dns.com")
        XCTAssertTrue(DohHosts.matches("dns.quad9.net"))
        XCTAssertTrue(DohHosts.matches("doh.opendns.com"))
    }

    func testPerProfileNamesMatchBySuffix() {
        XCTAssertEqual(DohHosts.hostOf("abc123.dns.nextdns.io"), "abc123.dns.nextdns.io")
        XCTAssertTrue(DohHosts.matches("x9.dns.controld.com"))
    }

    func testOrdinaryAndLookalikeNamesDoNotMatch() {
        for n in ["google.com", "www.google.com", "dns.google.evil.com", "evildns.google",
                  "nextdns.io", "dns.nextdns.io.evil.com", "xdns.nextdns.io.com", "cloudflare.com",
                  "use-application-dns.net", "", "."] {
            XCTAssertFalse(DohHosts.matches(n), n)
        }
    }

    func testTheSameNameIsNotedAgainOnlyAfterTenMinutes() {
        XCTAssertTrue(DohHosts.shouldNote(prevHost: nil, prevAt: nil, host: "dns.google", now: t))
        XCTAssertFalse(DohHosts.shouldNote(prevHost: "dns.google", prevAt: t, host: "dns.google", now: t + 9 * min))
        XCTAssertTrue(DohHosts.shouldNote(prevHost: "dns.google", prevAt: t, host: "dns.google", now: t + 10 * min))
        // Másik név azonnal: a kártya a legutóbbit mondja.
        XCTAssertTrue(DohHosts.shouldNote(prevHost: "dns.google", prevAt: t, host: "dns.quad9.net", now: t + 1))
        // Ha az óra visszaugrott, a régi idő nem némítja el.
        XCTAssertTrue(DohHosts.shouldNote(prevHost: "dns.google", prevAt: t, host: "dns.google", now: t - 1))
    }

    func testTheCardSpeaksOnlyOfAFreshUndismissedTrace() {
        XCTAssertNil(DohHosts.cardText(host: nil, at: nil, dismissedHost: nil, now: t, android: true))
        XCTAssertNil(DohHosts.cardText(host: "dns.google", at: t, dismissedHost: "dns.google", now: t, android: true))
        XCTAssertNil(DohHosts.cardText(host: "dns.google", at: t, dismissedHost: nil, now: t + 24 * hour + 1, android: true))
        XCTAssertNil(DohHosts.cardText(host: "dns.google", at: t + 2 * min, dismissedHost: nil, now: t, android: true))
        // Egy MÁSIK név visszahozza a kártyát.
        let back = DohHosts.cardText(host: "dns.quad9.net", at: t, dismissedHost: "dns.google", now: t + 5 * min, android: true)
        XCTAssertTrue(back?.contains("dns.quad9.net, 5 perce") == true, back ?? "nil")
    }

    func testTheCardNamesTheChromeSettingOnAndroidOnly() throws {
        let a = try XCTUnwrap(DohHosts.cardText(host: "dns.google", at: t, dismissedHost: nil, now: t, android: true))
        let i = try XCTUnwrap(DohHosts.cardText(host: "dns.google", at: t, dismissedHost: nil, now: t, android: false))
        XCTAssertTrue(a.hasPrefix("Valami a telefonon titkosított DNS-kiszolgálót keresett (dns.google, épp most)."), a)
        XCTAssertTrue(a.contains("Biztonságos DNS használata"), a)
        XCTAssertTrue(i.hasPrefix("Valami az eszközön"), i)
        XCTAssertTrue(i.contains("DNS-profil") && !i.contains("Chrome"), i)
        XCTAssertTrue(a.hasSuffix("A Breaker csak a nevet látja, azt nem, ki kérdezte."), a)
        XCTAssertTrue(i.hasSuffix("A Breaker csak a nevet látja, azt nem, ki kérdezte."), i)
    }

    func testAgoTextUsesMinutesThenHours() {
        XCTAssertEqual(DohHosts.agoText(0), "épp most")
        XCTAssertEqual(DohHosts.agoText(-5 * min), "épp most")
        XCTAssertEqual(DohHosts.agoText(119_999), "épp most")
        XCTAssertEqual(DohHosts.agoText(2 * min), "2 perce")
        XCTAssertEqual(DohHosts.agoText(59 * min), "59 perce")
        XCTAssertEqual(DohHosts.agoText(60 * min), "1 órája")
        XCTAssertEqual(DohHosts.agoText(23 * hour + 59 * min), "23 órája")
    }

    /// A nyom nélküli állapot (egy korábbi verzióé is) nil-t ad, nem hibát; a nyom túléli a mentést.
    func testTheTraceIsOptionalAndSurvivesARoundTrip() throws {
        let none = try JSONDecoder().decode(AppState.self, from: JSONEncoder().encode(AppState()))
        XCTAssertNil(none.dohSeenHost)
        XCTAssertNil(none.dohSeenAt)
        XCTAssertNil(none.dohDismissedHost)
        var s = none
        s.dohSeenHost = "dns.google"; s.dohSeenAt = t; s.dohDismissedHost = "dns.quad9.net"
        let back = try JSONDecoder().decode(AppState.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(back.dohSeenHost, "dns.google")
        XCTAssertEqual(back.dohSeenAt, t)
        XCTAssertEqual(back.dohDismissedHost, "dns.quad9.net")
    }
}
