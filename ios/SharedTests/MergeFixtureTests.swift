import Foundation
import XCTest
@testable import BreakerShared

// Megfelelőség a géppel: a `fixtures/merge-cases.json` a gép által kiszámolt
// bemeneteket és eredmény-kulcsokat tartja (desktop/test/merge-fixture.test.ts
// írja és őrzi). Itt ugyanazok a bemenetek a DRÓTON át jönnek (a Swift
// dekódolóján), a Swift fésülés számol, és a kulcsnak bájtra egyeznie kell.
// Ha a tükör egy szabályban elcsúszik, itt bukik — a mag számával.
//
// A kulcs formátuma a merge-random.ts `siteConformanceKey` /
// `focusConformanceKey` párja; a Kotlin tükör (MergeFixtureTest) ugyanezt.

private struct SiteCase: Decodable {
    let seed: Int
    let a: SyncMerge.SyncSite
    let b: SyncMerge.SyncSite
    let c: SyncMerge.SyncSite
    let ab: String
    let abc: String
}

private struct FocusCase: Decodable {
    let seed: Int
    let a: FocusSync.SyncFocus
    let b: FocusSync.SyncFocus
    let c: FocusSync.SyncFocus
    let ab: String
    let abc: String
}

private struct Fixture: Decodable {
    let sites: [SiteCase]
    let focus: [FocusCase]
}

final class MergeFixtureTests: XCTestCase {

    /// ios/SharedTests/MergeFixtureTests.swift → a tároló gyökere.
    private func loadFixture() throws -> Fixture {
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("merge-cases.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    /// Egész szám, ahogy a gép írja: a Double „150.0”-ja nem egyezne.
    private func int(_ d: Double) -> String { String(Int(d)) }

    private func opt(_ v: Double?) -> String { v.map { int($0) } ?? "-" }

    private func siteKey(_ s: SyncMerge.SyncSite) -> String {
        let marks = (s.hostnameMarks ?? [:]).sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }.joined(separator: ",")
        return "hosts=[\(s.hostnames.sorted().joined(separator: ","))] marks=[\(marks)] rev=\(s.rev)"
            + " pending=\(opt(s.pendingDeleteAt)) limit=\(opt(s.dailyLimitSeconds)) alias=\(s.alias ?? "-")"
            + " at=\(int(s.updatedAt)) by=\(s.updatedBy)"
    }

    private func focusKey(_ f: FocusSync.SyncFocus) -> String {
        let packParts: [String] = f.packs.sorted { $0.id < $1.id }.map { p -> String in
            var rec = "-"
            if let b = p.recurrence {
                let days: [String] = b.days.sorted().map { String($0) }
                rec = "\(days.joined(separator: ","))/\(b.startMin)/\(b.endMin)"
            }
            let fields: [String] = [
                p.id, p.name, p.allowSites.sorted().joined(separator: ","), p.allowApps.sorted().joined(separator: ","),
                String(p.defaultMinutes), rec,
            ]
            return fields.joined(separator: "|")
        }
        let packs: String = packParts.joined(separator: ";")
        let marks = (f.packMarks ?? [:]).sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }.joined(separator: ",")
        let run = f.run.map { "\($0.packId)/\(int($0.startedAt))/\(int($0.endsAt))" } ?? "-"
        return "packs=[\(packs)] run=\(run) marks=[\(marks)] rev=\(int(f.rev)) at=\(int(f.updatedAt)) by=\(f.updatedBy)"
    }

    func testSitesMergeTheSameAsTheDesktop() throws {
        let fixture = try loadFixture()
        XCTAssertGreaterThanOrEqual(fixture.sites.count, 50, "a fixture-ben van elég eset")
        for c in fixture.sites {
            let ab = SyncMerge.mergeSite(c.a, c.b)
            XCTAssertEqual(siteKey(ab), c.ab, "oldal, két eszköz, mag \(c.seed)")
            XCTAssertEqual(siteKey(SyncMerge.mergeSite(ab, c.c)), c.abc, "oldal, három eszköz, mag \(c.seed)")
        }
    }

    func testFocusMergesTheSameAsTheDesktop() throws {
        let fixture = try loadFixture()
        XCTAssertGreaterThanOrEqual(fixture.focus.count, 50, "a fixture-ben van elég eset")
        for c in fixture.focus {
            // Ugyanaz az út, mint az éles körben: dekódolás, aztán normalizálás.
            let a = FocusSync.normalize(c.a, fallbackDevice: "x")
            let b = FocusSync.normalize(c.b, fallbackDevice: "x")
            let cc = FocusSync.normalize(c.c, fallbackDevice: "x")
            let ab = FocusSync.merge(a, b)
            XCTAssertEqual(focusKey(ab), c.ab, "munkamenet, két eszköz, mag \(c.seed)")
            XCTAssertEqual(focusKey(FocusSync.merge(ab, cc)), c.abc, "munkamenet, három eszköz, mag \(c.seed)")
        }
    }
}
