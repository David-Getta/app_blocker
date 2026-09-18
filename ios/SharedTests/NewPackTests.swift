import Foundation
import XCTest
@testable import BreakerShared

// CSOMAG FELVÉTELE az iPhone-on — csak felvétel: a bíró tisztít, a plafon áll,
// a jel a léptetésben. Az androidos NewPackTest esetei.
final class NewPackTests: XCTestCase {

    private func pumpMainQueue() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }

    @discardableResult
    private func settled<T>(_ f: () throws -> T) rethrows -> T {
        defer { pumpMainQueue() }
        return try f()
    }

    private func resetStore() {
        BreakerStore.shared.mutate { state in state = AppState() }
        pumpMainQueue()
        BreakerStore.shared.saveLastTick(0)
    }

    func testTheRefereeAddsACleanPackAndRefusesABadNameOrLength() throws {
        resetStore()
        let p = try settled {
            try Referee.addFocusPack(name: "  Nyelv   tanulás  ", allowSites: ["Quizlet.com", "translate.google.com", "quizlet.com", "", "nem érvényes ..."], defaultMinutes: 900)
        }
        XCTAssertTrue(p.id.hasPrefix("pack_"))
        XCTAssertEqual(p.name, "Nyelv tanulás")
        XCTAssertEqual(p.allowSites, ["quizlet.com", "translate.google.com"], "tisztán, kétszer nem, a rossz kimarad")
        XCTAssertEqual(p.defaultMinutes, Focus.maxSessionMinutes, "a plafonig")
        XCTAssertEqual(BreakerStore.shared.state.focusPacks?.map { $0.id }, [p.id])
        XCTAssertThrowsError(try settled { try Referee.addFocusPack(name: "   ", allowSites: [], defaultMinutes: 25) }) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "BAD_NAME")
        }
        XCTAssertThrowsError(try settled { try Referee.addFocusPack(name: "Írás", allowSites: [], defaultMinutes: 0) }) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "BAD_MINUTES")
        }
        XCTAssertEqual(BreakerStore.shared.state.focusPacks?.count, 1, "a visszautasított hívás nem ír")
    }

    func testTheCapThirtyPacksAndNoMore() throws {
        resetStore()
        for i in 0..<FocusSync.maxPacks { try settled { try Referee.addFocusPack(name: "Csomag \(i)", allowSites: [], defaultMinutes: 25) } }
        XCTAssertThrowsError(try settled { try Referee.addFocusPack(name: "Sok", allowSites: [], defaultMinutes: 25) }) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "TOO_MANY_PACKS")
        }
        XCTAssertEqual(BreakerStore.shared.state.focusPacks?.count, FocusSync.maxPacks)
    }

    func testTheMarkANewPhonePackGetsItsMarkAtTheNextBump() {
        var st = AppState()
        st.focusPacks = [Focus.Pack(id: "p0", name: "Régi", allowSites: [], allowApps: [], defaultMinutes: 25)]
        let base = SyncRevisions.adoptFocus(SyncRevisions.bumpFocus(st, deviceId: "iphone", now: 1_000))
        var added = base
        added.focusPacks = (base.focusPacks ?? []) + [Focus.Pack(id: "pack_uj", name: "Új", allowSites: [], allowApps: [], defaultMinutes: 25)]
        let bumped = SyncRevisions.bumpFocus(added, deviceId: "iphone", now: 2_000)
        XCTAssertEqual(bumped.focusPackMarks?["pack_uj"], Int(bumped.focusRev ?? 0), "az új csomag jele az új rev")
        XCTAssertNil(bumped.focusPackMarks?["p0"], "a régi csomag jel nélkül marad")
    }
}
