import Foundation
import XCTest
@testable import BreakerShared

// Párban zárolás a Swift-tükrön — a desktop/test/partner.test.ts és az
// androidos PartnerTest esetei. A lenyomat a `fixtures/partner-hash.json`-nal
// mérve: a gépen felvett megbízottnak az iPhone-on is stimmelnie kell.
final class PartnerTests: XCTestCase {

    private let now: Double = 1_700_000_000_000
    private let phrase = "alma bogrács cinege délután"

    private struct Fixture: Decodable { let phrase: String; let salt: String; let hash: String; let wrong: String }

    /// ios/SharedTests/PartnerTests.swift → a tároló gyökere.
    private func loadFixture() throws -> Fixture {
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("partner-hash.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

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

    // ------------------------------------------------------------------ a mag

    func testThePhraseHasACanonicalForm() {
        XCTAssertEqual(PartnerLogic.normalizePhrase("  Alma  BOGRÁCS\tcinege\n délután "), phrase)
        // Bontott ékezet (a + kombináló vessző) ugyanaz, mint az összetett á.
        let combining = String(Character(UnicodeScalar(0x0301)!))
        XCTAssertEqual(PartnerLogic.normalizePhrase("álma"), PartnerLogic.normalizePhrase("a" + combining + "lma"))
        XCTAssertEqual(PartnerLogic.normalizePhrase("   "), "")
        XCTAssertEqual(PartnerLogic.normalizePartnerName("  Anna   Kovács "), "Anna Kovács")
        XCTAssertNil(PartnerLogic.normalizePartnerName(""))
        XCTAssertNil(PartnerLogic.normalizePartnerName(nil))
        XCTAssertEqual(PartnerLogic.normalizePartnerName(String(repeating: "x", count: 100))?.count,
                       PartnerLogic.maxPartnerName)
    }

    func testTheHashMatchesTheDesktopFixture() throws {
        let fx = try loadFixture()
        XCTAssertEqual(PartnerLogic.hashPhrase(fx.phrase, salt: fx.salt), fx.hash,
                       "ugyanaz a jelmondat, ugyanaz a lenyomat — mint a gépen")
        XCTAssertEqual(PartnerLogic.hashPhrase(" Alma bogrács CINEGE délután", salt: fx.salt), fx.hash,
                       "a kanonikus alak számít")
        XCTAssertNotEqual(PartnerLogic.hashPhrase(fx.wrong, salt: fx.salt), fx.hash)
        XCTAssertNil(PartnerLogic.hashPhrase(fx.phrase, salt: "nem base64!"), "rossz só: nincs lenyomat")
        let lock = PartnerLogic.PartnerLock(name: "Anna", salt: fx.salt, hash: fx.hash, setAt: 1)
        XCTAssertTrue(PartnerLogic.verify(lock, "ALMA  bogrács cinege délután "))
        XCTAssertFalse(PartnerLogic.verify(lock, fx.wrong))
        XCTAssertFalse(PartnerLogic.verify(lock, ""))
        let made = PartnerLogic.makeLock(name: "Anna", phrase: phrase, now: now)
        XCTAssertTrue(PartnerLogic.verify(made, phrase))
        XCTAssertNotEqual(made.salt, fx.salt, "friss só minden felvételnél")
        XCTAssertNil(PartnerLogic.normalizeLock(name: "Anna", salt: "rövid", hash: fx.hash, setAt: 1))
        XCTAssertNil(PartnerLogic.normalizeLock(name: "", salt: fx.salt, hash: fx.hash, setAt: 1))
        XCTAssertEqual(PartnerLogic.normalizeLock(name: "Anna", salt: fx.salt, hash: fx.hash, setAt: 1), lock)
        XCTAssertEqual(PartnerLogic.normalizeLock(name: "Anna", salt: fx.salt, hash: fx.hash, setAt: nil)?.setAt, 0)
    }

    func testMergeTheMarkDecidesThenTheSetOneThenTheEarlier() {
        let a = PartnerLogic.PartnerLock(name: "Anna", salt: String(repeating: "A", count: 24),
                                         hash: String(repeating: "B", count: 44), setAt: 100)
        let b = PartnerLogic.PartnerLock(name: "Béla", salt: String(repeating: "C", count: 24),
                                         hash: String(repeating: "D", count: 44), setAt: 200)
        XCTAssertNil(PartnerLogic.merge(3, a, 5, nil), "a nagyobb jelű levétel átmegy")
        XCTAssertNil(PartnerLogic.merge(5, nil, 3, a), "a helyi, nagyobb jelű levétel marad")
        XCTAssertEqual(PartnerLogic.merge(3, a, 3, nil), a, "azonos jelnél a beállított nyer")
        XCTAssertEqual(PartnerLogic.merge(3, nil, 3, b), b)
        XCTAssertEqual(PartnerLogic.merge(3, b, 3, a), a, "mindkettő beállítva: a korábban felvett")
        XCTAssertEqual(PartnerLogic.merge(2, a, 3, b), b, "nagyobb jel: a másik megbízott")

        let local = FocusSync.SyncFocus(rev: 3, updatedAt: 0, updatedBy: "dev", partner: a, partnerRev: 3)
        let removed = FocusSync.SyncFocus(rev: 5, updatedAt: 0, updatedBy: "other", partnerRev: 5)
        let merged = FocusSync.merge(local, removed)
        XCTAssertNil(merged.partner)
        XCTAssertEqual(merged.partnerRev, 5)
        // A régi kliens blobja (jel nélkül) sosem viszi el a megbízottat.
        let old = FocusSync.SyncFocus(rev: 9, updatedAt: 999, updatedBy: "old")
        XCTAssertEqual(FocusSync.merge(local, old).partner, a)
        var swapped = local
        swapped.partner = b
        XCTAssertFalse(FocusSync.same(local, swapped), "a megbízott cseréje különbség: fel kell tölteni")
    }

    func testTheWireCarriesThePartnerAndDropsTheBadlyShaped() throws {
        let a = PartnerLogic.PartnerLock(name: "Anna", salt: String(repeating: "A", count: 24),
                                         hash: String(repeating: "B", count: 44), setAt: 100)
        let mine = FocusSync.SyncFocus(rev: 4, updatedAt: 1, updatedBy: "dev", partner: a, partnerRev: 4)
        let data = try JSONEncoder().encode(mine)
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let wire = try XCTUnwrap(obj["partner"] as? [String: Any])
        XCTAssertEqual(Set(wire.keys), ["name", "salt", "hash", "setAt"], "a jelmondat nincs a dróton")
        XCTAssertEqual(obj["partnerRev"] as? Int, 4)
        let back = try JSONDecoder().decode(FocusSync.SyncFocus.self, from: data)
        XCTAssertEqual(back.partner, a)
        XCTAssertEqual(back.partnerRev, 4)
        let bare = try JSONEncoder().encode(FocusSync.SyncFocus(rev: 1, updatedAt: 1, updatedBy: "dev"))
        let bareObj = try XCTUnwrap(try JSONSerialization.jsonObject(with: bare) as? [String: Any])
        XCTAssertNil(bareObj["partner"], "megbízott nélkül nincs mező")

        // Kívülről: a rossz alakú rekord kiesik, a túl nagy jel is; a blob marad.
        let junk = """
        {"packs":[],"rev":4,"partnerRev":99,"partner":{"name":"X","salt":"rövid","hash":"rövid"}}
        """
        let decoded = try JSONDecoder().decode(FocusSync.SyncFocus.self, from: Data(junk.utf8))
        let n = FocusSync.normalize(decoded, fallbackDevice: "dev")
        XCTAssertNil(n.partner)
        XCTAssertNil(n.partnerRev, "a jel legfeljebb a blob rev-je")
        XCTAssertEqual(n.rev, 4)
        let good = """
        {"packs":[],"rev":4,"partnerRev":4,"partner":{"name":"Anna","salt":"\(a.salt)","hash":"\(a.hash)","setAt":100}}
        """
        let ok = FocusSync.normalize(
            try JSONDecoder().decode(FocusSync.SyncFocus.self, from: Data(good.utf8)), fallbackDevice: "dev")
        XCTAssertEqual(ok.partner, a)
        XCTAssertEqual(ok.partnerRev, 4)
    }

    // ------------------------------------------------------------------ a bíró

    private func addSite(_ domain: String) -> String {
        let id = BreakerStore.shared.newId("site")
        BreakerStore.shared.mutate { state in
            state.sites.append(Site(id: id, domain: domain, hostnames: [domain], addedAt: now))
        }
        pumpMainQueue()
        return id
    }

    private func currentStep() -> ChallengeEngine.Step? {
        pumpMainQueue()
        guard let s = BreakerStore.shared.state.session else { return nil }
        return s.steps[s.stepIndex]
    }

    private func solve(_ step: ChallengeEngine.Step) -> String {
        switch step {
        case .transcribe(_, let text): return text
        case .mathChain(_, let problems, let pos): return String(problems[pos].a)
        case .memory(let id, let code, let showMs, let waitMs, _):
            BreakerStore.shared.mutate { state in
                guard var ses = state.session else { return }
                ses.steps[ses.stepIndex] = .memory(id: id, code: code, showMs: showMs, waitMs: waitMs,
                                                   armedAt: now - Double(showMs + waitMs) - 1000)
                state.session = ses
            }
            return code
        case .reverse(_, let text): return ChallengeEngine.reverse(text)
        case .delay: XCTFail("a várakozást átvenni kell"); return ""
        case .partner: XCTFail("a megbízott lépése a jelmondat"); return ""
        }
    }

    /// Végigviszi a kísérletet a megbízott lépéséig — a várakozást is átveszi.
    private func solveUntilPartner(_ id: String) throws {
        var guardCount = 0
        while let step = currentStep(), guardCount < 200 {
            guardCount += 1
            switch step {
            case .partner: return
            case .delay(_, _, let claimableAt, _):
                _ = try Referee.claimDelay(sessionId: id, now: (claimableAt ?? now) + 1)
            default:
                _ = try Referee.submitAnswer(sessionId: id, answer: solve(step), now: now)
            }
        }
        XCTFail("a kísérlet elfogyott a megbízott lépése előtt")
    }

    func testWithAPartnerTheLastStepIsTheirPhraseAfterTheWait() throws {
        let siteId = addSite("youtube.com")
        let setup = try Referee.setPartner(name: "  Anna ", now: now)
        XCTAssertEqual(setup.name, "Anna")
        XCTAssertEqual(setup.phrase.split(separator: " ").count, PartnerLogic.partnerPhraseWords, "négy szó")
        XCTAssertEqual(setup.phrase, setup.phrase.lowercased())
        pumpMainQueue()
        XCTAssertEqual(BreakerStore.shared.state.partner?.name, "Anna")
        XCTAssertThrowsError(try Referee.setPartner(name: "Béla", now: now)) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "PARTNER_SET")
        }

        let ses = try Referee.startSession(kind: .pause, siteId: siteId, minutes: 15, now: now)
        guard case .partner(_, let name) = ses.steps.last! else { return XCTFail("az utolsó lépés a megbízotté") }
        XCTAssertEqual(name, "Anna")
        guard case .delay = ses.steps[ses.steps.count - 2] else { return XCTFail("a várakozás után áll") }

        try solveUntilPartner(ses.id)
        // Rossz jelmondat: nem sorsol újat, csak számol; a plafonnál a kísérlet elszáll.
        for _ in 0..<(PartnerLogic.maxPartnerTries - 1) {
            let r = try Referee.submitAnswer(sessionId: ses.id, answer: "alma bogrács cinege este", now: now)
            XCTAssertFalse(r.accepted)
            XCTAssertTrue(r.message?.contains("Nem ez a jelmondat") ?? false)
            pumpMainQueue()
            XCTAssertNotNil(BreakerStore.shared.state.session, "a kísérlet még él")
        }
        XCTAssertThrowsError(try Referee.submitAnswer(sessionId: ses.id, answer: "megint rossz", now: now)) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "PARTNER_TRIES")
            XCTAssertTrue((e as? Referee.RefereeError)?.message.contains("elölről") ?? false)
        }
        pumpMainQueue()
        XCTAssertNil(BreakerStore.shared.state.session, "a plafonnál elszállt")
        XCTAssertNil(BreakerStore.shared.state.sites[0].pauseUntil, "feloldás nem történt")

        // Újra: minden lépés elölről, és a jó jelmondat a végén feloldja.
        let again = try Referee.startSession(kind: .pause, siteId: siteId, minutes: 15, now: now + 1000)
        try solveUntilPartner(again.id)
        let r = try Referee.submitAnswer(sessionId: again.id, answer: " \(setup.phrase.uppercased()) ", now: now + 1000)
        XCTAssertTrue(r.accepted)
        XCTAssertTrue(r.sessionDone)
        pumpMainQueue()
        XCTAssertNotNil(BreakerStore.shared.state.sites[0].pauseUntil, "a szünet elindult")
    }

    func testAnAbandonedAttemptsComboDoesNotContainThePartnerStep() throws {
        let siteId = addSite("youtube.com")
        try Referee.setPartner(name: "Anna", now: now)
        let ses = try Referee.startSession(kind: .pause, siteId: siteId, minutes: 15, now: now)
        Referee.abandon(sessionId: ses.id)
        pumpMainQueue()
        let debt = try XCTUnwrap(BreakerStore.shared.state.abandons?.first)
        XCTAssertFalse(debt.comboKey.contains("PARTNER"), debt.comboKey)
        XCTAssertNotNil(ChallengeEngine.parseCombo(debt.comboKey), "a kulcs visszaolvasható")
    }

    func testRemovingThePartnerIsAChallengeEndingWithTheirPhrase() throws {
        _ = addSite("youtube.com")
        XCTAssertTrue(try Referee.startPartnerRemoval(now: now).applied, "megbízott nélkül nincs mit levenni")
        let setup = try Referee.setPartner(name: "Anna", now: now)
        let r = try Referee.startPartnerRemoval(now: now)
        XCTAssertFalse(r.applied)
        let ses = try XCTUnwrap(r.session)
        XCTAssertEqual(ses.pendingPartnerRemoval, true)
        XCTAssertEqual(ses.siteId, "partner")
        guard case .partner = ses.steps.last! else { return XCTFail("az utolsó lépés a megbízotté") }
        XCTAssertThrowsError(try Referee.startPartnerRemoval(now: now)) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "BUSY")
        }
        try solveUntilPartner(ses.id)
        let done = try Referee.submitAnswer(sessionId: ses.id, answer: setup.phrase, now: now)
        XCTAssertTrue(done.sessionDone)
        pumpMainQueue()
        XCTAssertNil(BreakerStore.shared.state.partner, "a megbízott lekerült")
        XCTAssertEqual(BreakerStore.shared.state.unlockLog.count, 1, "a lazítás a naplóban")
    }

    func testIfThePartnerWentAwayMeanwhileTheStepIsMoot() throws {
        let siteId = addSite("youtube.com")
        try Referee.setPartner(name: "Anna", now: now)
        let ses = try Referee.startSession(kind: .pause, siteId: siteId, minutes: 15, now: now)
        try solveUntilPartner(ses.id)
        BreakerStore.shared.mutate { state in state.partner = nil }
        XCTAssertTrue(try Referee.submitAnswer(sessionId: ses.id, answer: "bármi", now: now).sessionDone)
    }

    func testThePendingRemovalAndTheStepSurviveASave() throws {
        try Referee.setPartner(name: "Anna", now: now)
        try Referee.startPartnerRemoval(now: now)
        pumpMainQueue()
        let data = try JSONEncoder().encode(BreakerStore.shared.state)
        let back = try JSONDecoder().decode(AppState.self, from: data)
        XCTAssertEqual(back.session?.pendingPartnerRemoval, true)
        let last = try XCTUnwrap(back.session?.steps.last)
        guard case .partner(_, let name) = last else { return XCTFail("a lépés túléli a mentést") }
        XCTAssertEqual(name, "Anna")
        XCTAssertEqual(back.partner?.name, "Anna")
    }

    func testSettingAndRemovingBumpsTheBlobAndTheMarkIsTheBlobsNumber() {
        var st = AppState()
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now)
        XCTAssertEqual(st.focusRev ?? 0, 0, "üres állapot: nincs léptetés")
        st.partner = PartnerLogic.makeLock(name: "Anna", phrase: phrase, now: now)
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now)
        XCTAssertEqual(st.focusRev, 1)
        XCTAssertEqual(st.partnerRev, 1)
        XCTAssertEqual(SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now + 1), st, "változatlan: nem léptet")
        st.focusPacks = [Focus.Pack(id: "p1", name: "Írás", allowSites: [], allowApps: [], defaultMinutes: 25, recurrence: nil)]
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now + 2)
        XCTAssertEqual(st.focusRev, 2)
        XCTAssertEqual(st.partnerRev, 1, "a csomag szerkesztése nem a megbízott jele")
        st.partner = nil
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now + 3)
        XCTAssertEqual(st.focusRev, 3, "a levétel is döntés")
        XCTAssertEqual(st.partnerRev, 3)
        // Egy másik eszközről átvett megbízott: a lenyomat és a kulcs
        // újraszámolva — nincs léptetés, és egy későbbi saját szerkesztés sem
        // bélyegzi át a jelét (azzal a másik eszköz levételét írná felül).
        st.partner = PartnerLogic.makeLock(name: "Béla", phrase: phrase, now: now)
        st.partnerRev = 7
        let adopted = SyncRevisions.adoptFocus(st)
        XCTAssertEqual(SyncRevisions.bumpFocus(adopted, deviceId: "iphone", now: now + 4).focusRev, 3, "az átvétel nem szerkesztés")
        var edited = adopted
        edited.focusPacks = []
        edited = SyncRevisions.bumpFocus(edited, deviceId: "iphone", now: now + 5)
        XCTAssertEqual(edited.focusRev, 4)
        XCTAssertEqual(edited.partnerRev, 7, "az átvett megbízott jele marad")
    }
}
