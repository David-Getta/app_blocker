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
        // A Chromium listájának DoT-nevei és szolgáltatói is (doh_provider_entry.cc).
        for n in ["dot.xfinity.com", "dot.cox.net", "doh.quickline.ch", "dot.quickline.ch",
                  "doh-01.spectrum.com", "doh-02.spectrum.com"] {
            XCTAssertTrue(DohHosts.matches(n), n)
        }
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
        XCTAssertTrue(DohHosts.shouldNote(prevHost: nil, prevAt: nil, host: "dns.google", now: t, dismissed: []))
        XCTAssertFalse(DohHosts.shouldNote(prevHost: "dns.google", prevAt: t, host: "dns.google", now: t + 9 * min, dismissed: []))
        XCTAssertTrue(DohHosts.shouldNote(prevHost: "dns.google", prevAt: t, host: "dns.google", now: t + 10 * min, dismissed: []))
        // Másik név azonnal: a kártya a legutóbbit mondja.
        XCTAssertTrue(DohHosts.shouldNote(prevHost: "dns.google", prevAt: t, host: "dns.quad9.net", now: t + 1, dismissed: []))
        // Ha az óra visszaugrott, a régi idő nem némítja el.
        XCTAssertTrue(DohHosts.shouldNote(prevHost: "dns.google", prevAt: t, host: "dns.google", now: t - 1, dismissed: []))
    }

    func testADismissedNameDoesNotPushOutAnUnseenTrace() {
        // A Chrome a dns.google-t kérdezi, erre már „értem”; aztán a Firefox a
        // Cloudflare-t. A Chrome következő kérdése nem tüntetheti el a Cloudflare-t.
        let dismissed = ["dns.google"]
        XCTAssertTrue(DohHosts.shouldNote(prevHost: "dns.google", prevAt: t, host: "mozilla.cloudflare-dns.com", now: t + min, dismissed: dismissed))
        XCTAssertFalse(DohHosts.shouldNote(prevHost: "mozilla.cloudflare-dns.com", prevAt: t + min, host: "dns.google", now: t + 30 * min, dismissed: dismissed))
        XCTAssertFalse(DohHosts.shouldNote(prevHost: nil, prevAt: nil, host: "dns.google", now: t, dismissed: dismissed))
        XCTAssertNotNil(DohHosts.cardText(host: "mozilla.cloudflare-dns.com", at: t + min, dismissed: dismissed, now: t + 30 * min, android: true))
    }

    func testDismissKeepsEveryNameUpToTheCap() {
        XCTAssertEqual(DohHosts.dismiss([], "dns.google"), ["dns.google"])
        XCTAssertEqual(DohHosts.dismiss(["dns.google"], "dns.google"), ["dns.google"])
        XCTAssertEqual(DohHosts.dismiss(["dns.google"], nil), ["dns.google"])
        // A második „értem” nem oldja fel az elsőt.
        XCTAssertEqual(DohHosts.dismiss(["dns.google"], "dns.quad9.net"), ["dns.google", "dns.quad9.net"])
        let full = (1...DohHosts.maxDismissed).map { "h\($0).dns.nextdns.io" }
        let more = DohHosts.dismiss(full, "dns.sb")
        XCTAssertEqual(more.count, DohHosts.maxDismissed)
        XCTAssertEqual(more.first, "h2.dns.nextdns.io", "a legrégebbi esik ki")
        XCTAssertEqual(more.last, "dns.sb")
    }

    func testTheCardSpeaksOnlyOfAFreshUndismissedTrace() {
        XCTAssertNil(DohHosts.cardText(host: nil, at: nil, dismissed: [], now: t, android: true))
        XCTAssertNil(DohHosts.cardText(host: "dns.google", at: t, dismissed: ["dns.google"], now: t, android: true))
        XCTAssertNil(DohHosts.cardText(host: "dns.google", at: t, dismissed: [], now: t + 24 * hour + 1, android: true))
        XCTAssertNil(DohHosts.cardText(host: "dns.google", at: t + 2 * min, dismissed: [], now: t, android: true))
        // Egy MÁSIK név visszahozza a kártyát.
        let back = DohHosts.cardText(host: "dns.quad9.net", at: t, dismissed: ["dns.google"], now: t + 5 * min, android: true)
        XCTAssertTrue(back?.contains("dns.quad9.net, 5 perce") == true, back ?? "nil")
    }

    func testTheCardNamesTheChromeSettingOnAndroidOnly() throws {
        let a = try XCTUnwrap(DohHosts.cardText(host: "dns.google", at: t, dismissed: [], now: t, android: true))
        let i = try XCTUnwrap(DohHosts.cardText(host: "dns.google", at: t, dismissed: [], now: t, android: false))
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
        XCTAssertEqual(none.dohDismissedList, [])
        var s = none
        s.dohSeenHost = "dns.google"; s.dohSeenAt = t; s.dohDismissedHosts = ["dns.quad9.net", "dns.sb"]
        let back = try JSONDecoder().decode(AppState.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(back.dohSeenHost, "dns.google")
        XCTAssertEqual(back.dohSeenAt, t)
        XCTAssertEqual(back.dohDismissedList, ["dns.quad9.net", "dns.sb"])
    }

    /// A v0.4.256 előtti állapot egyetlen nevet tartott: az „értem” a frissítés után is áll.
    func testTheOldSingleDismissedNameStillCounts() {
        var s = AppState()
        s.dohDismissedHost = "dns.quad9.net"
        XCTAssertEqual(s.dohDismissedList, ["dns.quad9.net"])
        s.dohDismissedHosts = ["dns.sb"]
        XCTAssertEqual(s.dohDismissedList, ["dns.quad9.net", "dns.sb"])
        s.dohDismissedHosts = ["dns.quad9.net"]
        XCTAssertEqual(s.dohDismissedList, ["dns.quad9.net"], "nem kétszer")
    }

    /// A szinkron eredménye nem írja vissza, amit közben a tunnel vagy egy gomb írt.
    func testTheSyncResultKeepsWhatThisDeviceWroteMeanwhile() {
        let snapshot = AppState()
        var result = snapshot
        result.lastCombo = "a szinkroné"
        var fresh = snapshot
        fresh.protectionOn = !snapshot.protectionOn
        fresh.dohSeenHost = "dns.google"; fresh.dohSeenAt = 5_000
        fresh.dohDismissedHosts = ["dns.quad9.net"]; fresh.dohDismissedHost = "dns.sb"
        fresh.filterHits = ["2026-10-15": 3]
        fresh.filterHitHours = ["2026-10-15": Array(repeating: 0, count: 24)]
        fresh.filterHitHosts = ["2026-10-15": ["a.example": 3]]
        fresh.filterHitReasons = ["2026-10-15": ["list": 3]]
        fresh.filterHitKeywords = ["2026-10-15": ["x": 1]]
        fresh.quietSuggestions = true
        fresh.digestWeekKey = "2026-10-12"
        fresh.digestLog = [DigestLogic.Entry(week: "2026-10-12", text: "Elmúlt 7 nap: 1 ó 0 p mért idő.")]
        let applied = SyncClient.keepLocal(result, fresh)
        XCTAssertEqual(applied.lastCombo, "a szinkroné", "a szinkron mezői az eredményből jönnek")
        XCTAssertEqual(applied.protectionOn, fresh.protectionOn)
        XCTAssertEqual(applied.dohSeenHost, "dns.google")
        XCTAssertEqual(applied.dohSeenAt, 5_000)
        XCTAssertEqual(applied.dohDismissedList, ["dns.sb", "dns.quad9.net"])
        XCTAssertEqual(applied.filterHits, fresh.filterHits)
        XCTAssertEqual(applied.filterHitHours, fresh.filterHitHours)
        XCTAssertEqual(applied.filterHitHosts, fresh.filterHitHosts)
        XCTAssertEqual(applied.filterHitReasons, fresh.filterHitReasons)
        XCTAssertEqual(applied.filterHitKeywords, fresh.filterHitKeywords)
        XCTAssertEqual(applied.quietSuggestions, true)
        XCTAssertEqual(applied.digestWeekKey, "2026-10-12")
        XCTAssertEqual(applied.digestLog, fresh.digestLog)
    }
}
