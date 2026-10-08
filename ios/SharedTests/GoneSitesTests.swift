import Foundation
import XCTest
@testable import BreakerShared

// A végigment törlés SÍRKÖVE (SyncMerge.isGone) — a gép gone-sites.test.ts-ének
// és az androidos GoneSitesTest-nek a párja. Eddig a végigment törlés örökre a
// fiókban maradt, minden kör visszahozta, és egy régi, a kérést sem látott
// eszköz feltámaszthatta.
final class GoneSitesTests: XCTestCase {

    private let now: Double = 6_000

    private func site(
        _ id: String = "s1", pending: Double? = nil, del: Int? = nil, gone: Int? = nil,
        rev: Int = 3, addedAt: Double = 1_000, alias: String? = nil, by: String = "gep-a"
    ) -> SyncMerge.SyncSite {
        SyncMerge.SyncSite(
            id: id, domain: "x.com", hostnames: ["x.com"], addedAt: addedAt, pendingDeleteAt: pending,
            alias: alias, rev: rev, updatedAt: 100 + Double(rev), updatedBy: by,
            deleteLoosens: del, goneLoosens: gone
        )
    }

    private func stone(_ id: String = "s1", pending: Double = 5_000) -> SyncMerge.SyncSite {
        site(id, pending: pending, del: 1, gone: 1)
    }

    func testDeadMeansTheLastRequestWentThroughAndNobodyCancelled() {
        XCTAssertTrue(SyncMerge.isGone(stone()))
        XCTAssertFalse(SyncMerge.isGone(site(pending: nil, del: 1, gone: 1)), "visszavonva")
        XCTAssertFalse(SyncMerge.isGone(site(pending: 5_000, del: 2, gone: 1)), "új kérés jött")
        XCTAssertFalse(SyncMerge.isGone(site(pending: 5_000)), "jel nélkül nincs sírkő")
        XCTAssertEqual(SyncMerge.tombstoneOf(site(pending: 5_000, del: 1))?.goneLoosens, 1)
        XCTAssertNil(SyncMerge.tombstoneOf(site(pending: 5_000)), "a régi, számláló nélküli kérés nem kap sírkövet")
    }

    func testAStaleRecordMergesIntoTheTombstoneAndACancellationRevives() {
        let stale = site(rev: 9, alias: "iksz", by: "telefon")
        XCTAssertTrue(SyncMerge.isGone(SyncMerge.mergeSite(stone(), stale)))
        XCTAssertTrue(SyncMerge.isGone(SyncMerge.mergeSite(stale, stone())))
        let cancelled = site(del: 1, rev: 4, by: "telefon")
        let revived = SyncMerge.mergeSite(stone(), cancelled)
        XCTAssertFalse(SyncMerge.isGone(revived))
        XCTAssertNil(revived.pendingDeleteAt)
        XCTAssertEqual(revived.goneLoosens, 1, "a jel marad")
    }

    func testTheDeadStayOutOfTheDomainFold() {
        let readded = site("s2", rev: 1, addedAt: 7_000)
        let merged = SyncMerge.mergeLists([stone()], [readded])
        XCTAssertEqual(merged.map { $0.id }, ["s2", "s1"])
        XCTAssertEqual(merged.map { SyncMerge.isGone($0) }, [false, true])
        XCTAssertNil(merged[0].pendingDeleteAt)
    }

    func testSettleAndSplitLikeTheDesktop() {
        let incoming = [
            site("z", pending: 5_000, del: 1), site("l", pending: 5_000), site("f", pending: 9_000, del: 1),
            site("m", pending: 5_000, del: 1),
        ]
        let out = SyncMerge.settleIncoming(incoming, ["m"], now)
        XCTAssertEqual(out.map { $0.goneLoosens }, [1, nil, nil, nil])
        let merged = [
            site("alive"), stone("local-dead"), stone("not-due", pending: 9_000), stone("dead"),
            site("counted-due", pending: 5_000, del: 1), site("legacy-due", pending: 5_000),
        ]
        let split = SyncMerge.splitMerged(merged, ["alive", "local-dead"], now)
        XCTAssertEqual(split.sites.map { $0.id }, ["alive", "local-dead", "not-due", "counted-due"])
        XCTAssertEqual(split.gone.map { $0.id }, ["dead"])
    }

    private func rec(_ id: String, del: Int?, pending: Double? = 5_000) -> Site {
        var s = Site(id: id, domain: "\(id).com", hostnames: ["\(id).com"], addedAt: 1)
        s.pendingDeleteAt = pending
        s.rev = 4
        s.revFp = "fp"
        s.deleteLoosens = del
        return s
    }

    func testTheRefereeBuriesOnlyPaidDeletionsOneStonePerId() {
        var old = rec("a", del: 1, pending: 1_000)
        old.goneLoosens = 1
        let buried = Referee.buryDeleted([old], [rec("a", del: 2), rec("b", del: nil)])
        XCTAssertEqual(buried.map { $0.id }, ["a"], "a régi, számláló nélküli kérés után nincs sírkő")
        XCTAssertEqual(buried.first?.goneLoosens, 2, "ugyanannak az azonosítónak egy sírköve van: az újabb")
        XCTAssertEqual(buried.first?.pendingDeleteAt, 5_000)
        XCTAssertNil(buried.first?.revFp, "a lenyomat nem kerül a sírkőre")
        XCTAssertEqual(Referee.buryDeleted([], [rec("c", del: nil)]).count, 0)
    }

    func testTheWireAndTheStoreCleanTheMark() {
        func raw(_ extra: String) -> String {
            "{\"id\":\"s1\",\"domain\":\"x.com\",\"hostnames\":[\"x.com\"],\"addedAt\":1,\"pendingDeleteAt\":5000,"
                + "\"rev\":5,\"updatedAt\":1,\"updatedBy\":\"a\"\(extra)}"
        }
        let parts = [
            raw(",\"deleteLoosens\":2,\"goneLoosens\":2"), raw(",\"deleteLoosens\":2,\"goneLoosens\":3"),
            raw(",\"goneLoosens\":1"), raw(",\"deleteLoosens\":2,\"goneLoosens\":1.5"),
        ]
        let parsed = SyncMerge.sitesFromJson("[" + parts.joined(separator: ",") + "]") ?? []
        XCTAssertEqual(parsed.map { $0.goneLoosens }, [2, nil, nil, nil])
        // A tárolt rekord ugyanígy: a jel legfeljebb a (tisztított) törlés-számláló.
        var big = rec("g", del: 1)
        big.goneLoosens = 2
        XCTAssertNil(big.cleaningMarks().goneLoosens)
        var ok = rec("h", del: 1)
        ok.goneLoosens = 1
        XCTAssertEqual(ok.cleaningMarks().goneLoosens, 1)
        XCTAssertTrue(ok.cleaningMarks().isGoneRecord)
    }
}
