import Foundation
import XCTest
@testable import BreakerShared

// A szinkronon jött rekordok szűrése — a Swift tükrön.
//
// A gépen a hosztnevek a root-tulajdonú hosts fájlba mennek: egy soremeléses
// „név” idegen `IP név` sort írna bele. Az iPhone nem ír hosts fájlt, de
// tovább hordozná a szemetet — ezért itt is ugyanaz a szűrő.
final class IncomingSitesTests: XCTestCase {

    private func site(_ id: String, _ domain: String, _ hostnames: [String]) -> SyncMerge.SyncSite {
        SyncMerge.SyncSite(
            id: id, domain: domain, hostnames: hostnames, addedAt: 1, pendingDeleteAt: nil,
            rev: 1, updatedAt: 0, updatedBy: "x"
        )
    }

    func testOnlyCanonicalHostnamesSurvive() {
        let cleaned = SyncMerge.cleanIncoming([
            site("a", "youtube.com", ["youtube.com", "a\n1.2.3.4 login.mybank.com", "YouTube.com", "youtu.be", "youtu.be"]),
            site("b", "nem jo\nsor", ["x.com"]),
            site("", "reddit.com", ["reddit.com"]),
        ])
        XCTAssertEqual(cleaned.map { $0.id }, ["a"], "a rossz domainű és az azonosító nélküli rekord kimarad")
        XCTAssertEqual(cleaned.first?.hostnames, ["youtube.com", "youtu.be"])
    }

    func testCanonicalHostnameCheck() {
        XCTAssertTrue(Blocklist.isCanonicalHostname("music.youtube.com"))
        XCTAssertFalse(Blocklist.isCanonicalHostname("Music.youtube.com"))
        XCTAssertFalse(Blocklist.isCanonicalHostname("a b.com"))
        XCTAssertFalse(Blocklist.isCanonicalHostname("a\nb.com"))
        XCTAssertFalse(Blocklist.isCanonicalHostname(""))
    }
}
