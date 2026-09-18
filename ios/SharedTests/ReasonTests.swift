import XCTest
@testable import BreakerShared

// Az indok (miért tiltottad): a tisztítás, és hogy a szinkronon a nyertes
// rekorddal jön — mint a fedőnév.
final class ReasonTests: XCTestCase {

    func testNormalizeReasonCleansCollapsesAndCuts() {
        XCTAssertEqual(AliasLogic.maxReasonLength, 140)
        XCTAssertEqual(AliasLogic.normalizeReason("  Mert  este\u{0}  nem\n alszom  "), "Mert este nem alszom")
        XCTAssertNil(AliasLogic.normalizeReason(""))
        XCTAssertNil(AliasLogic.normalizeReason("   "))
        XCTAssertNil(AliasLogic.normalizeReason(nil))
        XCTAssertEqual(AliasLogic.normalizeReason(String(repeating: "x", count: 300))?.count, 140)
        XCTAssertEqual(AliasLogic.normalizeReason(String(repeating: "a", count: 139) + "  b"), String(repeating: "a", count: 139))
    }

    private func site(rev: Int, updatedAt: Double, by: String, reason: String? = nil) -> SyncMerge.SyncSite {
        SyncMerge.SyncSite(id: "s1", domain: "youtube.com", hostnames: ["youtube.com"], addedAt: 1,
                           pendingDeleteAt: nil, schedule: nil, dailyLimitSeconds: nil, reason: reason,
                           rules: nil, rev: rev, updatedAt: updatedAt, updatedBy: by)
    }

    func testTheReasonTravelsWithTheWinningRecordAndRoundTripsTheWire() throws {
        let plain = site(rev: 1, updatedAt: 100, by: "gep-a")
        let with = site(rev: 2, updatedAt: 200, by: "telefon", reason: "Mert este nem alszom")
        XCTAssertEqual(SyncMerge.mergeSite(plain, with).reason, "Mert este nem alszom")
        XCTAssertEqual(SyncMerge.mergeSite(with, plain).reason, "Mert este nem alszom")
        let removed = site(rev: 3, updatedAt: 300, by: "gep-a")
        XCTAssertNil(SyncMerge.mergeSite(with, removed).reason, "a levétel átmegy")

        let data = try JSONEncoder().encode([with])
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(text.contains("\"reason\":\"Mert este nem alszom\""), text)
        let back = try JSONDecoder().decode([SyncMerge.SyncSite].self, from: data)
        XCTAssertEqual(back.first?.reason, "Mert este nem alszom")
        let old = try JSONDecoder().decode([SyncMerge.SyncSite].self, from: JSONEncoder().encode([plain]))
        XCTAssertNil(old.first?.reason, "régi rekordon nincs indok")
    }
}
