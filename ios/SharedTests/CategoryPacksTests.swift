import XCTest
@testable import BreakerShared

// Kategória-csomagok: ugyanaz a lista, mint a gépen. A fixtures/category-packs.json
// a gép tesztjének írása; itt ehhez mérjük a Swift listát, sorrendestül.
final class CategoryPacksTests: XCTestCase {

    private struct Pack: Decodable {
        let key: String
        let label: String
        let domains: [String]
    }

    /// ios/SharedTests/CategoryPacksTests.swift → a tároló gyökere.
    private func loadFixture() throws -> [Pack] {
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("category-packs.json")
        return try JSONDecoder().decode([Pack].self, from: Data(contentsOf: url))
    }

    func testTheListMatchesTheDesktop() throws {
        let fixture = try loadFixture()
        XCTAssertEqual(fixture.count, Blocklist.categoryPacks.count, "csomagok száma")
        for (f, p) in zip(fixture, Blocklist.categoryPacks) {
            XCTAssertEqual(f.key, p.key)
            XCTAssertEqual(f.label, p.label)
            XCTAssertEqual(f.domains, p.domains, "\(p.key): domainek")
        }
    }

    func testEveryDomainIsAlreadyCleanAndListedOnce() {
        var seen = Set<String>()
        for p in Blocklist.categoryPacks {
            XCTAssertTrue(p.domains.count >= 3, "\(p.key): üres csomag")
            for d in p.domains {
                XCTAssertEqual(Blocklist.normalizeDomain(d), d, "\(p.key): \(d) nem a tiszta alak")
                XCTAssertTrue(seen.insert(d).inserted, "\(d) két csomagban is")
            }
        }
    }
}
