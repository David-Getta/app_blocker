import Foundation
import XCTest
@testable import BreakerShared

// A félbemaradt kísérletek könyvelése a Swift-bírón — a desktop referee.test.ts
// és az androidos RefereeTest párja: az újraindítás és a feladás is
// félbemaradt kísérlet, a teljesítés nem; harminc nap a plafon.
final class DroppedAttemptsTests: XCTestCase {

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

    func testARestartAndAnAbandonAreDroppedAttemptsAndOldOnesFallOut() throws {
        // Valós idő: a feladás a rendszerórával könyvel, a plafon ahhoz mér.
        let now = Date().timeIntervalSince1970 * 1000
        let id = BreakerStore.shared.newId("site")
        BreakerStore.shared.mutate { state in
            state.sites.append(Site(id: id, domain: "youtube.com", hostnames: ["youtube.com"], addedAt: now))
        }
        pumpMainQueue()
        try Referee.startSession(kind: .pause, siteId: id, minutes: 15, now: now)
        pumpMainQueue()
        XCTAssertEqual(BreakerStore.shared.state.droppedAttempts ?? [], [], "az első kísérlet még nem maradt félbe")
        // Az újraindítás a régit viszi el — az is félbemaradt.
        try Referee.startSession(kind: .pause, siteId: id, minutes: 15, now: now + 1000)
        pumpMainQueue()
        XCTAssertEqual(BreakerStore.shared.state.droppedAttempts ?? [], [now + 1000])
        // A negyven napos kiesik, a feladás bekerül.
        BreakerStore.shared.mutate { state in
            state.droppedAttempts = [now - 40 * 86_400_000] + (state.droppedAttempts ?? [])
        }
        pumpMainQueue()
        Referee.abandon(sessionId: try XCTUnwrap(BreakerStore.shared.state.session?.id))
        pumpMainQueue()
        let dropped = BreakerStore.shared.state.droppedAttempts ?? []
        XCTAssertEqual(dropped.count, 2, "a feladás könyvelve, a negyven napos kiesett")
        XCTAssertTrue(dropped.allSatisfy { $0 > now - 30 * 86_400_000 }, "harminc napnál régebbi nincs")
        XCTAssertNil(BreakerStore.shared.state.session)
    }
}
