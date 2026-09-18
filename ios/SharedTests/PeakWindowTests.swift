import Foundation
import XCTest
@testable import BreakerShared

// ABLAK A CSÚCS-ÓRÁRA az iPhone-ról — a gépi gomb tükre, és vele az első
// csomag-szerkesztés a telefonon: a sáv, a jelölt, a bíró (csak felvesz), a
// csomag jele a léptetésben, és a mentés. Az androidos PeakWindowTest esetei.
final class PeakWindowTests: XCTestCase {

    private let now: Double = 1_800_000_000_000
    private let pack = Focus.Pack(id: "p1", name: "Nyelvtanulás", allowSites: ["quizlet.com"], allowApps: ["Word"], defaultMinutes: 50)
    private let band21 = Focus.peakWindowBand(21)

    /// A mentés azonnal megy, a közzétett `state` a fő sorra van dobva.
    private func pumpMainQueue() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }

    /// Minden mutáció után forgatni kell — dobásnál is (`defer`).
    @discardableResult
    private func settled<T>(_ f: () throws -> T) rethrows -> T {
        defer { pumpMainQueue() }
        return try f()
    }

    private func resetStore() {
        let p = pack
        BreakerStore.shared.mutate { state in
            state = AppState()
            state.focusPacks = [p]
        }
        pumpMainQueue()
        BreakerStore.shared.saveLastTick(0)
    }

    private func windowed(_ band: ScheduleLogic.Band) -> Focus.Pack {
        Focus.Pack(id: "p1", name: "Nyelvtanulás", allowSites: ["quizlet.com"], allowApps: ["Word"], defaultMinutes: 50, recurrence: band)
    }

    func testTheBandIsThePeakHourEveryDayAndTheEndOf23IsTheEndOfTheDay() {
        XCTAssertEqual(band21, ScheduleLogic.Band(days: [0, 1, 2, 3, 4, 5, 6], startMin: 21 * 60, endMin: 22 * 60))
        XCTAssertEqual(Focus.peakWindowBand(23).endMin, 1440, "a nap vége, nem nulla — különben átfordulna")
        XCTAssertEqual(Focus.peakWindowBand(0).startMin, 0)
        XCTAssertEqual(Focus.peakWindowBand(99).startMin, 23 * 60, "a tartományba szorítva")
        XCTAssertNotNil(Focus.cleanRecurrence(band21), "a bíró elfogadja")
    }

    func testThePickNeedsAPeakNoCoverNoRunAndAPackWithoutAWindow() {
        let pick = Focus.peakWindowPick([pack], log: [], run: nil, peakHour: 21, now: now)
        XCTAssertEqual(pick?.pack.id, "p1")
        XCTAssertEqual(pick?.band, band21)
        XCTAssertNil(Focus.peakWindowPick([pack], log: [], run: nil, peakHour: nil, now: now), "csúcs nélkül nincs gomb")
        XCTAssertNil(Focus.peakWindowPick([], log: [], run: nil, peakHour: 21, now: now), "csomag nélkül nincs gomb")
        let covered = windowed(ScheduleLogic.Band(days: [1], startMin: 21 * 60 + 30, endMin: 23 * 60))
        XCTAssertNil(Focus.peakWindowPick([covered], log: [], run: nil, peakHour: 21, now: now), "fedett csúcs-órára a sor mondja, gomb nincs")
        let other = windowed(ScheduleLogic.Band(days: [1, 2], startMin: 9 * 60, endMin: 10 * 60))
        XCTAssertNil(Focus.peakWindowPick([other], log: [], run: nil, peakHour: 21, now: now), "ablakos csomagot a telefon nem cserél")
        let run = Focus.Run(packId: "p1", startedAt: now - 60_000, endsAt: now + 60_000)
        XCTAssertNil(Focus.peakWindowPick([pack], log: [], run: run, peakHour: 21, now: now), "futó menet mellett nincs gomb")
        XCTAssertNotNil(Focus.peakWindowPick([pack], log: [], run: run, peakHour: 21, now: now + 120_000), "lejárt menet után van")
    }

    func testTheRefereeAddsForFreeAndRefusesWindowedRunningUnknownAndBadBands() throws {
        resetStore()
        try settled { try Referee.addFocusWindow(packId: "p1", band: band21, now: now) }
        XCTAssertEqual(BreakerStore.shared.state.focusPacks?.first?.recurrence, band21)
        XCTAssertNil(BreakerStore.shared.state.session, "felvenni nem próbatétel")
        XCTAssertThrowsError(try settled { try Referee.addFocusWindow(packId: "p1", band: Focus.peakWindowBand(9), now: now) }) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "HAS_WINDOW", "a telefon csak felvesz")
        }
        XCTAssertThrowsError(try settled { try Referee.addFocusWindow(packId: "nincs", band: band21, now: now) }) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "NO_PACK")
        }
        resetStore()
        XCTAssertThrowsError(try settled {
            try Referee.addFocusWindow(packId: "p1", band: ScheduleLogic.Band(days: [], startMin: 540, endMin: 720), now: now)
        }) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "BAD_RECURRENCE")
        }
        XCTAssertThrowsError(try settled {
            try Referee.addFocusWindow(packId: "p1", band: ScheduleLogic.Band(days: [1], startMin: 0, endMin: 1440), now: now)
        }) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "BAD_RECURRENCE", "huszonnégy órás ablak nem menet")
        }
        try settled { try Referee.startFocus(packId: "p1", minutes: 25, now: now) }
        XCTAssertThrowsError(try settled { try Referee.addFocusWindow(packId: "p1", band: band21, now: now + 1) }) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "FOCUS_RUNNING", "a futó csomag befagy")
        }
        XCTAssertNil(BreakerStore.shared.state.focusPacks?.first?.recurrence, "a visszautasított hívás nem ír")
    }

    func testThePackMarkIsWrittenByThePhoneEditButNotByTheFirstBumpOrAdoption() {
        var st = AppState()
        st.focusPacks = [pack]
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now)
        XCTAssertEqual(st.focusRev, 1)
        XCTAssertNil(st.focusPackMarks, "az első léptetés jel nélkül megy")
        XCTAssertEqual(st.focusRevPacks?.keys.sorted(), ["p1"])
        st.focusPacks = [windowed(band21)]
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now + 1)
        XCTAssertEqual(st.focusRev, 2)
        XCTAssertEqual(st.focusPackMarks, ["p1": 2], "a szerkesztett csomag jele az új rev")
        st.focusRun = Focus.Run(packId: "p1", startedAt: now + 2, endsAt: now + 2 + 25 * 60_000)
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now + 2)
        XCTAssertEqual(st.focusRev, 3)
        XCTAssertEqual(st.focusPackMarks, ["p1": 2], "a menet indítása nem csomag-jel")
        st.focusPacks = [windowed(band21), Focus.Pack(id: "p2", name: "Írás", allowSites: [], allowApps: [], defaultMinutes: 25)]
        st.focusPackMarks = ["p1": 7, "p2": 7]
        let adopted = SyncRevisions.adoptFocus(st)
        XCTAssertEqual(SyncRevisions.bumpFocus(adopted, deviceId: "iphone", now: now + 3), adopted, "az átvétel nem szerkesztés")
        var removed = adopted
        removed.focusPacks = [windowed(band21)]
        removed.focusRun = nil
        removed = SyncRevisions.bumpFocus(removed, deviceId: "iphone", now: now + 4)
        XCTAssertEqual(removed.focusPackMarks, ["p1": 7, "p2": 4], "a kikerült csomag jele az új rev — sírkő")
    }

    func testTheSavedStateKeepsTheFingerprints() throws {
        var st = AppState()
        st.focusPacks = [pack]
        st.focusRevPacks = ["p1": "abcd1234"]
        st.focusPackMarks = ["p1": 3]
        let back = try JSONDecoder().decode(AppState.self, from: try JSONEncoder().encode(st))
        XCTAssertEqual(back.focusRevPacks, ["p1": "abcd1234"])
        XCTAssertEqual(back.focusPackMarks, ["p1": 3])
        let bare = try JSONDecoder().decode(AppState.self, from: try JSONEncoder().encode(AppState()))
        XCTAssertNil(bare.focusRevPacks)
    }
}
