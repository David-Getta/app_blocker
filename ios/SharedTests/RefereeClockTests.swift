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

    // A gép és a Kotlin tesztjének tükre: a szünet vége fali idő, tehát az
    // óra visszaállítása egy kifizetett negyedórás szünetből órákat csinált,
    // a lejártat pedig feltámasztotta. Visszafelé minden szünet vége
    // ugyanannyit csúszik vissza.
    func testSettingTheClockBackNeitherStretchesAPauseNorRevivesAnExpiredOne() {
        let live = Site(id: "site_elo", domain: "youtube.com", hostnames: ["youtube.com"],
                        addedAt: now - 86_400_000, pauseUntil: now + 15 * 60_000)
        let gone = Site(id: "site_lejart", domain: "reddit.com", hostnames: ["reddit.com"],
                        addedAt: now - 86_400_000, pauseUntil: now - 60_000)
        BreakerStore.shared.mutate { state in
            state.sites = [live, gone]
            state.session = nil
        }
        pumpMainQueue()
        BreakerStore.shared.saveLastTick(now)

        let back = now - 10 * 3_600_000
        Referee.tick(now: back)
        pumpMainQueue()
        let sites = BreakerStore.shared.state.sites
        XCTAssertEqual((sites.first { $0.id == "site_elo" }?.pauseUntil ?? 0) - back, 15 * 60_000,
                       "ami hátra volt, annyi maradt")
        let expired = sites.first { $0.id == "site_lejart" }?.pauseUntil
        XCTAssertTrue(expired == nil || expired! <= back, "a lejárt szünet lejárt marad")
    }

    // Az eltolt menet ugyanaz a menet: az EREDETI kezdés megmarad, mert a
    // szinkron azon ismeri fel — a gép és a Kotlin referee-jének tükre.
    func testAShiftedRunKeepsItsOriginalStart() {
        let pack = Focus.Pack(id: "p_ora", name: "Óra", allowSites: [], allowApps: [], defaultMinutes: 50)
        BreakerStore.shared.mutate { state in
            state.focusPacks = [pack]
            state.focusRun = Focus.Run(packId: "p_ora", startedAt: now, endsAt: now + 50 * 60_000)
            state.session = nil
        }
        pumpMainQueue()
        BreakerStore.shared.saveLastTick(now)

        let jumped = now + 8 * 3_600_000
        Referee.tick(now: jumped)
        pumpMainQueue()
        let run = BreakerStore.shared.state.focusRun
        XCTAssertEqual(run?.origin, now, "az eredeti kezdés megmarad")
        XCTAssertGreaterThan(run?.startedAt ?? 0, now, "a kezdés tolódott")
        BreakerStore.shared.mutate { state in
            state.focusRun = nil
            state.focusPacks = []
        }
        pumpMainQueue()
    }

    // A gép és a Kotlin tesztjének tükre: egy MÁSIK csomag futó menetét a heti
    // ablak nem állítja le — eddig igen, és mivel ablakot felvenni ingyen van,
    // egy most kezdődő ablak próbatétel nélkül véget vetett egy hosszú
    // menetnek. Most rárétegződik, és a saját menete ott indul, ahol a másik
    // véget ért.
    func testAWindowLayersOverAnotherPacksRunAndItsOwnRunStartsWhereThatEnded() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .current
        func mon(_ hour: Int, _ minute: Int = 0) -> Double {
            cal.date(from: DateComponents(year: 2026, month: 9, day: 7, hour: hour, minute: minute))!.timeIntervalSince1970 * 1000
        }
        let window = Focus.Pack(id: "p_ablak", name: "Mély munka", allowSites: ["github.com"], allowApps: [], defaultMinutes: 50,
                                recurrence: ScheduleLogic.Band(days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 12 * 60))
        let other = Focus.Pack(id: "p_mas", name: "Más", allowSites: ["github.com", "youtube.com"], allowApps: [], defaultMinutes: 50)
        BreakerStore.shared.mutate { state in
            state.focusPacks = [window, other]
            state.focusRun = Focus.Run(packId: "p_mas", startedAt: mon(8, 59), endsAt: mon(9, 59))
            state.focusLog = []
            state.session = nil
        }
        pumpMainQueue()
        BreakerStore.shared.saveLastTick(mon(9))

        Referee.tick(now: mon(9, 1))
        pumpMainQueue()
        XCTAssertEqual(BreakerStore.shared.state.focusRun?.packId, "p_mas", "a futó menet marad")
        XCTAssertEqual(BreakerStore.shared.state.focusLog?.count ?? 0, 0, "semmi nem zárult le")
        XCTAssertEqual(BreakerStore.shared.runningFocusPack(mon(9, 1))?.allowSites, ["github.com"],
                       "amíg az ablak tart, csak a közös — az alagút ezt kapja")
        for m in 2...60 { Referee.tick(now: mon(9) + Double(m) * 60_000) }
        pumpMainQueue()
        let run = BreakerStore.shared.state.focusRun
        XCTAssertEqual(run?.packId, "p_ablak")
        XCTAssertEqual(run?.startedAt, mon(9, 59), "ott, ahol a másik véget ért")
        XCTAssertEqual(run?.origin, mon(9), "az azonossága az ablak kezdete")
        XCTAssertEqual(run?.endsAt, mon(12))
        XCTAssertEqual(BreakerStore.shared.state.focusLog?.last?.packId, "p_mas")
        XCTAssertEqual(BreakerStore.shared.state.focusLog?.last?.stopped, false, "a másik menet a saját idejéig tartott")
        BreakerStore.shared.mutate { state in
            state.focusRun = nil
            state.focusPacks = []
            state.focusLog = []
        }
        pumpMainQueue()
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
