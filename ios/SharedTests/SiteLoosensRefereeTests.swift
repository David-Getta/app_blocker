import Foundation
import XCTest
@testable import BreakerShared

// A kifizetett lazítás számlálója a Swift-tükrön — a desktop/test/referee.test.ts
// és az androidos RefereeTest esetei. A számlálót CSAK a teljesített próbatétel
// lépteti: a szigorítás ingyen van, a szünet eszköz-helyi. A szinkron mezőnként
// ebből dönt (SyncMerge.mergeSite) — ha a bíró nem bélyegezne, a kifizetett
// lazítást a többi eszköz szigorúbb alakja visszavenné.
final class SiteLoosensRefereeTests: XCTestCase {

    private let now: Double = 1_700_000_000_000

    /// A mentés azonnal megy, a közzétett `state` a fő sorra van dobva.
    private func pumpMainQueue() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }

    /// Minden mutáció után a fő sor is — különben a következő hívás a RÉGI
    /// állapotot látná (lásd PartnerTests).
    @discardableResult
    private func settled<T>(_ f: () throws -> T) rethrows -> T {
        defer { pumpMainQueue() }
        return try f()
    }

    override func setUp() {
        super.setUp()
        BreakerStore.shared.mutate { state in state = AppState() }
        pumpMainQueue()
        BreakerStore.shared.saveLastTick(0)
    }

    private func addSite(_ domain: String) -> String {
        let id = BreakerStore.shared.newId("site")
        settled {
            BreakerStore.shared.mutate { state in
                state.sites.append(Site(id: id, domain: domain, hostnames: [domain], addedAt: now))
            }
        }
        return id
    }

    private func site(_ id: String) -> Site? {
        pumpMainQueue()
        return BreakerStore.shared.state.sites.first { $0.id == id }
    }

    private func solve(_ step: ChallengeEngine.Step) -> String {
        switch step {
        case .transcribe(_, let text): return text
        case .mathChain(_, let problems, let pos): return String(problems[pos].a)
        case .memory(let id, let code, let showMs, let waitMs, _):
            // A memorizálás és a várakozás „leteltnek” állítva — a tesztben
            // nem az idő a kérdés, hanem a lépések sora.
            settled {
                BreakerStore.shared.mutate { state in
                    guard var ses = state.session else { return }
                    ses.steps[ses.stepIndex] = .memory(id: id, code: code, showMs: showMs, waitMs: waitMs,
                                                       armedAt: now - Double(showMs + waitMs) - 1000)
                    state.session = ses
                }
            }
            return code
        case .reverse(_, let text): return ChallengeEngine.reverse(text)
        case .delay: XCTFail("a várakozást átvenni kell"); return ""
        case .partner: XCTFail("ezek a tesztek megbízott nélkül futnak"); return ""
        }
    }

    /// Végigviszi a kísérletet — a várakozást is átveszi.
    private func solveAll() throws {
        var guardCount = 0
        while guardCount < 60 {
            guardCount += 1
            pumpMainQueue()
            guard let ses = BreakerStore.shared.state.session else { return }
            let step = ses.steps[ses.stepIndex]
            switch step {
            case .delay(_, _, let claimableAt, _):
                // Közben a kör rendesen ketyegett: az átvétel előtti
                // óraugrás-elnyelés ezt nem tartja ugrásnak.
                let at = (claimableAt ?? now) + 1
                BreakerStore.shared.saveLastTick(at - 1000)
                try settled { try Referee.claimDelay(sessionId: ses.id, now: at) }
            default:
                try settled { try Referee.submitAnswer(sessionId: ses.id, answer: solve(step), now: now) }
            }
        }
        XCTFail("a kísérlet nem ért véget")
    }

    private let work = ScheduleLogic.Schedule(
        mode: .block, bands: [ScheduleLogic.Band(days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60)]
    )

    func testAPaidScheduleLooseningStampsItsCounterAndATighteningDoesNot() throws {
        let id = addSite("instagram.com")
        // Mindig tiltva → csak hétköznap 9–17: az esték kinyílnak, ez lazítás.
        let loosen = try settled { try Referee.startScheduleChange(siteId: id, schedule: work, now: now) }
        XCTAssertFalse(loosen.applied)
        XCTAssertNil(site(id)?.scheduleLoosens, "a próbatétel előtt nincs számláló")
        try solveAll()
        XCTAssertEqual(site(id)?.schedule, work, "a teljesítés alkalmazza")
        XCTAssertEqual(site(id)?.scheduleLoosens, 1, "a kifizetett lazítás számlálója nőtt")

        let tighten = try settled { try Referee.startScheduleChange(siteId: id, schedule: ScheduleLogic.always, now: now) }
        XCTAssertTrue(tighten.applied, "vissza a mindig tiltottra: ingyen")
        XCTAssertEqual(site(id)?.scheduleLoosens, 1, "a szigorítás ingyen van: a számláló nem nő")
    }

    func testAPaidDeletionRequestStampsItsCounterAPauseNothing() throws {
        let deleting = addSite("tiktok.com")
        try settled { _ = try Referee.startSession(kind: .delete, siteId: deleting, minutes: nil, now: now) }
        try solveAll()
        XCTAssertNotNil(site(deleting)?.pendingDeleteAt, "a törlés várakozik")
        XCTAssertEqual(site(deleting)?.deleteLoosens, 1, "a kifizetett törlés-kérés számlálója nőtt")

        let pausing = addSite("reddit.com")
        try settled { _ = try Referee.startSession(kind: .pause, siteId: pausing, minutes: 15, now: now) }
        try solveAll()
        let paused = site(pausing)
        XCTAssertNotNil(paused?.pauseUntil, "a szünet él")
        // A szünet eszköz-helyi, nem utazik — a számlálók nem nőnek tőle.
        XCTAssertNil(paused?.deleteLoosens)
        XCTAssertNil(paused?.scheduleLoosens)
        XCTAssertNil(paused?.limitLoosens)
        XCTAssertNil(paused?.burstLoosens)
    }

    func testTheCountersSurviveTheWireAndAStrayOneIsDropped() throws {
        var s = SyncMerge.SyncSite(id: "s1", domain: "a.com", hostnames: ["a.com"], addedAt: 1,
                                   rev: 3, updatedAt: 1, updatedBy: "gep")
        s.scheduleLoosens = 2
        s.limitLoosens = 3
        let back = try JSONDecoder().decode(SyncMerge.SyncSite.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(back.scheduleLoosens, 2)
        XCTAssertEqual(back.limitLoosens, 3)
        XCTAssertNil(back.deleteLoosens, "ami nincs, az nem lesz nulla a dróton")
        // Ami nagyobb a rekord rev-jénél, az nem kerülhetett oda léptetéssel.
        let stray = Data(#"{"id":"s2","domain":"b.com","hostnames":["b.com"],"rev":2,"burstLoosens":3,"deleteLoosens":1.5}"#.utf8)
        let cleaned = try JSONDecoder().decode(SyncMerge.SyncSite.self, from: stray)
        XCTAssertNil(cleaned.burstLoosens)
        XCTAssertNil(cleaned.deleteLoosens)
    }
}
