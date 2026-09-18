import Foundation
import XCTest
@testable import BreakerShared

// A zárlat-ablak SZERKESZTÉSE a Swift-bírón — az androidos LockdownWindowTest
// bíró-eseteinek párja. A mag külön tesztelve (LockdownWindowTests); ez a
// BEKÖTÉST nézi, amit csak itt lehet: a felvétel ingyen megy és azonosítót
// kap, a levétel próbatételt indít és addig az ablak marad, bent el sem
// indul, az egész hét nem zárható le.
final class LockdownWindowRefereeTests: XCTestCase {

    private func at(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int = 0) -> Double {
        let date = Calendar.current.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
        return date.timeIntervalSince1970 * 1000
    }

    // 2027. március 7. vasárnap, 8. hétfő, 11. csütörtök — a többi tesztosztály
    // ideje után, hogy egy utánunk futó kör ne lásson óra-ugrást.
    private var sun: Double { at(2027, 3, 7, 12) }
    private var thu: Double { at(2027, 3, 11, 10) }

    private let work = LockdownLogic.LockdownWindow(id: "w1", days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60)
    private let night = LockdownLogic.LockdownWindow(id: "w2", days: [1], startMin: 22 * 60, endMin: 6 * 60)

    /// A mentés azonnal megy, a közzétett `state` a fő sorra van dobva.
    private func pumpMainQueue() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }

    override func setUp() {
        super.setUp()
        BreakerStore.shared.mutate { state in state = AppState() }
        pumpMainQueue()
        BreakerStore.shared.saveLastTick(0)
    }

    func testAddingIsFreeAndGetsAnIdRemovalIsAChallenge() throws {
        let fresh = LockdownLogic.LockdownWindow(id: "", days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60)
        XCTAssertTrue(try Referee.setLockdownWindows([fresh], now: sun).applied, "felvétel")
        pumpMainQueue()
        let stored = BreakerStore.shared.state.lockdownWindows ?? []
        XCTAssertEqual(stored.count, 1)
        XCTAssertTrue(stored[0].id.hasPrefix("lw_"), "az azonosítót a bíró adja")
        XCTAssertTrue(try Referee.setLockdownWindows(stored + [night], now: sun).applied, "második ablak")
        pumpMainQueue()
        XCTAssertEqual((BreakerStore.shared.state.lockdownWindows ?? []).map { $0.id }, [stored[0].id, "w2"])
        XCTAssertNil(BreakerStore.shared.state.session, "egyik sem indított próbatételt")

        let r = try Referee.setLockdownWindows(stored, now: sun)
        XCTAssertFalse(r.applied, "levétel: próbatétel")
        XCTAssertEqual(r.session?.siteId, "lockdown:windows")
        XCTAssertEqual(r.session?.pendingLockdownWindows, stored)
        pumpMainQueue()
        XCTAssertEqual((BreakerStore.shared.state.lockdownWindows ?? []).count, 2,
                       "amíg a próbatétel tart, az ablak marad")
        XCTAssertThrowsError(try Referee.setLockdownWindows([], now: sun)) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "BUSY")
        }
        Referee.abandon(sessionId: r.session!.id)
        pumpMainQueue()
        XCTAssertNil(BreakerStore.shared.state.session)
    }

    func testModifyingKeepsTheIdWideningIsFreeNarrowingIsAChallenge() throws {
        // A módosító lap az ablakot a HELYÉRE írja, ugyanazzal az azonosítóval —
        // a bíró a tartalmat hasonlítja: a bővítés azonnal él, a szűkítés
        // próbatétel, és addig a régi ablak marad.
        XCTAssertTrue(try Referee.setLockdownWindows([work], now: sun).applied)
        pumpMainQueue()
        let wider = LockdownLogic.LockdownWindow(id: work.id, days: [1, 2, 3, 4, 5, 6], startMin: work.startMin, endMin: 18 * 60)
        XCTAssertTrue(try Referee.setLockdownWindows([wider], now: sun).applied, "bővítés ingyen")
        pumpMainQueue()
        XCTAssertEqual(BreakerStore.shared.state.lockdownWindows ?? [], [wider], "az azonosító maradt")

        let narrower = LockdownLogic.LockdownWindow(id: work.id, days: [1, 2, 3], startMin: 10 * 60, endMin: 16 * 60)
        let r = try Referee.setLockdownWindows([narrower], now: sun)
        XCTAssertFalse(r.applied, "szűkítés: próbatétel")
        pumpMainQueue()
        XCTAssertEqual(BreakerStore.shared.state.lockdownWindows ?? [], [wider], "addig a bővebb ablak áll")
        XCTAssertEqual(BreakerStore.shared.state.session?.pendingLockdownWindows ?? nil, [narrower])
    }

    func testAWindowStartingSoonIsAnnouncedUnlessALockdownAlreadyCoversIt() {
        let b = [work.band]
        let occ = LockdownLogic.windowStartingSoon(nil, b, at(2027, 3, 8, 8, 55))
        XCTAssertEqual(occ?.startsAt, at(2027, 3, 8, 9), "tíz percen belül: jelez")
        XCTAssertEqual(occ?.endsAt, at(2027, 3, 8, 17))
        XCTAssertNil(LockdownLogic.windowStartingSoon(nil, b, at(2027, 3, 8, 8, 45)), "negyed óra még sok")
        XCTAssertNil(LockdownLogic.windowStartingSoon(nil, b, at(2027, 3, 8, 9, 5)), "bent már nem közelgő")
        let long = LockdownLogic.Lockdown(startedAt: at(2027, 3, 8, 8), until: at(2027, 3, 8, 18))
        XCTAssertNil(LockdownLogic.windowStartingSoon(long, b, at(2027, 3, 8, 8, 55)), "a futó zárlat túlér rajta")
        let short = LockdownLogic.Lockdown(startedAt: at(2027, 3, 8, 8), until: at(2027, 3, 8, 12))
        XCTAssertEqual(LockdownLogic.windowStartingSoon(short, b, at(2027, 3, 8, 8, 55))?.startsAt, occ?.startsAt, "a rövidebb zárlatot kitolja: jelez")
        XCTAssertNil(LockdownLogic.windowStartingSoon(nil, [], at(2027, 3, 8, 8, 55)))
    }

    func testRemovalInsideTheWindowDoesNotEvenStart() throws {
        try Referee.setLockdownWindows([work], now: sun)
        pumpMainQueue()
        XCTAssertThrowsError(try Referee.setLockdownWindows([], now: thu)) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "LOCKDOWN")
        }
        pumpMainQueue()
        XCTAssertNil(BreakerStore.shared.state.session)
        // Felvenni bent is ingyen — a szigorítás iránya.
        XCTAssertTrue(try Referee.setLockdownWindows([work, night], now: thu).applied)
    }

    func testInvalidAndWholeWeekAreRejected() {
        let bad = LockdownLogic.LockdownWindow(id: "b", days: [], startMin: 0, endMin: 60)
        XCTAssertThrowsError(try Referee.setLockdownWindows([bad], now: sun)) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "BAD_WINDOW")
        }
        let all = LockdownLogic.LockdownWindow(id: "a", days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440)
        XCTAssertThrowsError(try Referee.setLockdownWindows([all], now: sun)) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "NO_FREE_TIME")
        }
        pumpMainQueue()
        XCTAssertNil(BreakerStore.shared.state.lockdownWindows)
    }
}
