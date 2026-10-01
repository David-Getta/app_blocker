import Foundation
import XCTest
@testable import BreakerShared

// A dróton jött rekordok közös fixtúrája (`fixtures/wire-cases.json`, írja a
// `desktop/test/wire-fixture.test.ts`): egy rossz elem nem viheti a többit, és
// az iPhone olvasója (SyncMerge.sitesFromJson / FocusSync.fromJson — ugyanaz
// az út, amin a szinkron olvas) ugyanazt tartja meg belőle, mint a gépé.
//
// Eddig az iPhone a listát EGYBEN dekódolta: egyetlen rossz csomag vagy oldal
// az egészet vitte, a kör üresnek látta a kiszolgálót — és a kiesett csomag
// jele a csomag nélkül sírkőnek látszott volna.

private struct WireCase: Decodable {
    let input: String
    let out: String
    enum CodingKeys: String, CodingKey { case input = "in", out }
}

private struct Fixture: Decodable {
    let version: Int
    let sites: [WireCase]
    let focus: [WireCase]
}

final class WireFixtureTests: XCTestCase {

    private func load() throws -> Fixture {
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("wire-cases.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func int(_ d: Double) -> String { String(Int64(d)) }
    private func opt(_ v: Double?) -> String { v.map { int($0) } ?? "-" }

    private func siteKey(_ s: SyncMerge.SyncSite) -> String {
        let marks = (s.hostnameMarks ?? [:]).sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }.joined(separator: ",")
        return "\(s.id)|\(s.domain)|\(s.hostnames.joined(separator: ","))|added=\(int(s.addedAt))"
            + "|del=\(opt(s.pendingDeleteAt))|limit=\(opt(s.dailyLimitSeconds))"
            + "|alias=\(s.alias ?? "-")|reason=\(s.reason ?? "-")"
            + "|rev=\(s.rev)|at=\(int(s.updatedAt))|by=\(s.updatedBy)|marks=\(marks)"
            + "|sched=\(scheduleKey(s.schedule))"
    }

    /// A menetrend HATÁSA (a döntés normalizálása után), mint a gép kulcsában.
    private func scheduleKey(_ s: ScheduleLogic.Schedule?) -> String {
        guard let s else { return "-" }
        let n = ScheduleLogic.normalize(s)
        return n.mode.rawValue + ":" + n.bands.map { b in
            Array(Set(b.days)).sorted().map(String.init).joined(separator: ",") + "/\(b.startMin)/\(b.endMin)"
        }.joined(separator: ";")
    }

    private func focusKey(_ f: FocusSync.SyncFocus) -> String {
        let packs = f.packs.map { p -> String in
            let rec = p.recurrence.map { b in
                b.days.map(String.init).joined(separator: ",") + "/\(b.startMin)/\(b.endMin)"
            } ?? "-"
            return "\(p.id)|\(p.name)|\(p.allowSites.joined(separator: ","))|\(p.allowApps.joined(separator: ","))"
                + "|\(p.defaultMinutes)|\(rec)"
        }.joined(separator: ";")
        let marks = (f.packMarks ?? [:]).sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }.joined(separator: ",")
        let log = f.log.map { e in
            "\(e.packId)/\(e.packName)/\(int(e.startedAt))/\(int(e.endedAt))/\(int(e.plannedEndsAt))"
                + "/\(e.stopped ? 1 : 0)/\(e.window == true ? 1 : 0)"
        }.joined(separator: ";")
        return "packs=[\(packs)] marks=[\(marks)] log=[\(log)] rev=\(int(f.rev)) at=\(int(f.updatedAt)) by=\(f.updatedBy)"
    }

    func testTheSiteListIsReadLikeTheDesktopAndOneBadRecordDropsOnlyItself() throws {
        let f = try load()
        XCTAssertGreaterThan(f.sites.count, 40, "sites: kevés eset — a fixtúra csonka?")
        for (i, c) in f.sites.enumerated() {
            guard let sites = SyncMerge.sitesFromJson(c.input) else {
                XCTFail("sites #\(i): nem olvasható — \(c.input)")
                continue
            }
            XCTAssertEqual(sites.map(siteKey).joined(separator: "\n"), c.out, "sites #\(i): \(c.input)")
        }
    }

    func testTheFocusBlobIsReadLikeTheDesktopAndADroppedPackLosesItsMark() throws {
        let f = try load()
        XCTAssertGreaterThan(f.focus.count, 40, "focus: kevés eset — a fixtúra csonka?")
        for (i, c) in f.focus.enumerated() {
            guard let focus = FocusSync.fromJson(c.input, fallbackDevice: "gep") else {
                XCTFail("focus #\(i): nem olvasható — \(c.input)")
                continue
            }
            XCTAssertEqual(focusKey(focus), c.out, "focus #\(i): \(c.input)")
        }
    }

    /// Ami nem JSON, az nem üres lista: üresnek véve a saját listánkat tolnánk
    /// fel a többiek helyett. A gép és az Android itt megáll — az iPhone is.
    func testANonJsonSiteBlobIsNotAnEmptyList() {
        XCTAssertNil(SyncMerge.sitesFromJson("[{\"id\":"))
        XCTAssertEqual(SyncMerge.sitesFromJson("{}")?.count, 0)
    }
}
