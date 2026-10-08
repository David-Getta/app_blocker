import Foundation
import XCTest
@testable import BreakerShared

// Az ablakos csomag OSZTÁLYA az iPhone-on — a gép focus-pack-loosens.test.ts-ének
// és az androidos PackClassTest-nek a párja: a kifizetett ablak-lazítás száma,
// aztán az ablak dönt, egészében; az osztályon belül a SAJÁT jel.
final class PackClassTests: XCTestCase {

    private let win = ScheduleLogic.Band(days: [1, 2, 3, 4, 5], startMin: 540, endMin: 720)

    private func pack(_ id: String, name: String? = nil, recurrence: ScheduleLogic.Band? = nil) -> Focus.Pack {
        Focus.Pack(
            id: id, name: name ?? "csomag \(id)", allowSites: ["quizlet.com"], allowApps: [],
            defaultMinutes: 50, recurrence: recurrence
        )
    }

    private func focus(
        _ packs: [Focus.Pack], marks: [String: Int]? = nil, loosens: [String: Int]? = nil,
        rev: Double, by: String = "gep", run: Focus.Run? = nil
    ) -> FocusSync.SyncFocus {
        FocusSync.SyncFocus(
            packs: packs, run: run, rev: rev, updatedAt: 1, updatedBy: by, packMarks: marks, packLoosens: loosens
        )
    }

    func testPaidRemovalWinsOverAStaleRename() {
        let paid = focus([pack("p1")], marks: ["p1": 4], loosens: ["p1": 1], rev: 4)
        let stale = focus([pack("p1", name: "átnevezve", recurrence: win)], marks: ["p1": 7], rev: 7, by: "telefon")
        for m in [FocusSync.merge(paid, stale), FocusSync.merge(stale, paid)] {
            XCTAssertNil(m.packs.first?.recurrence, "az ablak levétele marad")
            XCTAssertEqual(m.packs.first?.name, "csomag p1", "a győztes változat egészében")
            XCTAssertEqual(m.packMarks, ["p1": 7])
            XCTAssertEqual(m.packLoosens, ["p1": 1])
            XCTAssertEqual(m.packOwnMarks, ["p1": 4], "a győztes saját jele, mert kisebb a közösnél")
        }
    }

    func testTheOwnMarkDecidesInsideTheWinningClass() {
        let a = focus([], marks: ["p3": 5], rev: 5)
        let b = focus([pack("p3")], marks: ["p3": 1], loosens: ["p3": 1], rev: 2, by: "b")
        let c = focus([], loosens: ["p3": 1], rev: 1, by: "c")
        let m = { (x: FocusSync.SyncFocus, y: FocusSync.SyncFocus) -> FocusSync.SyncFocus in FocusSync.merge(x, y) }
        let orders: [FocusSync.SyncFocus] = [
            m(m(a, b), c), m(m(c, a), b), m(m(b, c), a), m(m(a, c), b), m(m(b, a), c), m(m(c, b), a),
        ]
        for r in orders {
            XCTAssertEqual(r.packs.map { $0.id }, ["p3"], "a „b” saját jele (1) a „c”-é (0) fölött")
            XCTAssertEqual(r.packMarks, ["p3": 5])
            XCTAssertEqual(r.packOwnMarks, ["p3": 1])
        }
    }

    func testTheRunningPackStaysButItsPaidOffWindowDoesNotComeBack() {
        let running = focus(
            [pack("p1", recurrence: win)], marks: ["p1": 2], rev: 3,
            run: Focus.Run(packId: "p1", startedAt: 100, endsAt: 100 + 3 * 3_600_000)
        )
        let removed = focus([], marks: ["p1": 6], loosens: ["p1": 1], rev: 6, by: "telefon")
        for m in [FocusSync.merge(running, removed), FocusSync.merge(removed, running)] {
            XCTAssertEqual(m.run?.packId, "p1", "a menet marad")
            XCTAssertEqual(m.packs.map { $0.id }, ["p1"], "a csomagja is")
            XCTAssertNil(m.packs.first?.recurrence, "az ablaka nem")
        }
    }

    func testTheOwnPackEditClearsTheOwnMark() {
        var st = AppState()
        st.focusPacks = [pack("p1"), pack("p2")]
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: 10)
        st.focusPackMarks = ["p1": 1, "p2": 1]
        st.focusPackOwnMarks = ["p1": 0, "p2": 0]
        st.focusPacks = [pack("p1", name: "új"), pack("p2")]
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: 20)
        XCTAssertEqual(st.focusPackMarks?["p1"], Int(st.focusRev ?? 0))
        XCTAssertEqual(st.focusPackOwnMarks, ["p2": 0], "csak a szerkesztetté törlődik")
    }

    func testTheWireCleansCountersAndOwnMarks() {
        let json = """
        {"packs":[{"id":"p1","name":"Munka","allowSites":[],"allowApps":[],"defaultMinutes":30}],
         "log":[],"rev":4,"updatedAt":1,"updatedBy":"x",
         "packMarks":{"p1":3},"packLoosens":{"p1":2,"gone":1,"big":9},"packOwnMarks":{"p1":3,"gone":0}}
        """
        let f = FocusSync.fromJson(json, fallbackDevice: "x")
        XCTAssertEqual(f?.packLoosens, ["p1": 2, "gone": 1], "legfeljebb a rev; a törölt csomagé marad")
        XCTAssertNil(f?.packOwnMarks, "a közös jelnél nem kisebb, és a jel nélküli, kiesik")
    }
}
