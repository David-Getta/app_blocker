import Foundation
import XCTest
@testable import BreakerShared

// A karbantartó kör ALAPVONALA — az egyetlen dolog, amin az óra-védelem áll.
//
// A várakozás itt maga a próba, és amit az óra átállítása legyőz, az nem
// próba. A védelem azon múlik, hogy a kör tudja, mikor futott utoljára: ha ezt
// a számot a folyamat leállítása elfelejti, akkor az app kilövése +
// óra-előreállítás ingyen megrövidíti a várakozást. Ezért a lemezen van, nem a
// memóriában — a gépen mindig is így volt. A pár a Kotlin RefereeTest
// „killing the app does not reset the clock baseline” esete.
final class RefereeClockTests: XCTestCase {

    private let now: Double = 1_700_000_000_000

    func testTheFirstTickWritesTheBaseline() {
        BreakerStore.shared.saveLastTick(0)
        Referee.tick(now: now)
        XCTAssertEqual(BreakerStore.shared.loadLastTick(), now,
                       "az első kör kiírja az alapvonalat, nem csak megjegyzi")
    }

    func testAJumpAfterARestartIsAbsorbedAndTheNewBaselineIsWritten() {
        // Ennyi maradt az appból, miután a rendszer eltette: egy lemezre írt
        // alapvonal. Az új folyamat ezt találja, nem nullát.
        BreakerStore.shared.saveLastTick(now)
        let jumped = now + 6 * 3_600_000
        Referee.tick(now: jumped)
        XCTAssertEqual(BreakerStore.shared.loadLastTick(), jumped,
                       "az ugrás után az új alapvonal azonnal kiíródik")
    }

    /// A mentés a lemezre azonnal megy, a közzétett `state` viszont a fő sorra
    /// van dobva. A tesztben nincs, ami megforgassa a fő sort, ezért megtesszük
    /// mi — különben a régi értéket olvasnánk vissza.
    private func pumpMainQueue() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }

    func testTheDeletionDeadlineMovesWithTheClockAfterARestart() {
        let site = Site(
            id: "site_ora", domain: "youtube.com", hostnames: ["youtube.com"],
            addedAt: now - 86_400_000, pendingDeleteAt: now + 24 * 3_600_000
        )
        BreakerStore.shared.mutate { state in
            state.sites = [site]
            state.session = nil
        }
        pumpMainQueue()
        BreakerStore.shared.saveLastTick(now)

        // Két nappal előrébb állított óra, friss folyamat: a törlés NEM válik
        // esedékessé, a határidő az ugrással tolódik.
        let jumped = now + 48 * 3_600_000
        Referee.tick(now: jumped)
        pumpMainQueue()
        let after = BreakerStore.shared.state.sites.first { $0.id == "site_ora" }
        XCTAssertNotNil(after, "az oldal még megvan, a törlés nem futott le")
        XCTAssertGreaterThan(after?.pendingDeleteAt ?? 0, jumped,
                             "a türelmi idő az ugrással tolódott")
    }
}
