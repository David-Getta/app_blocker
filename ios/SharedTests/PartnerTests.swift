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

    /// Olcsó scrypt a szabály-tesztekhez: a debug-fordítású scrypt a teljes
    /// költséggel hashenként fél percig is eltart. A géppel való egyezést
    /// egyetlen teljes költségű számolás őrzi (lásd a fixture-tesztet).
    private static let cheapCost = (n: 16, r: 1, p: 1)

    override func setUp() {
        super.setUp()
        PartnerLogic.scryptCost = Self.cheapCost
        BreakerStore.shared.mutate { state in state = AppState() }
        pumpMainQueue()
        BreakerStore.shared.saveLastTick(0)
    }

    override func tearDown() {
        PartnerLogic.scryptCost = PartnerLogic.fullCost
        super.tearDown()
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
        // Az EGYETLEN teljes költségű számolás: a gépen felvett megbízottnak
        // az iPhone-on is stimmelnie kell — ez a bájtra egyezés.
        PartnerLogic.scryptCost = PartnerLogic.fullCost
        let full = PartnerLogic.hashPhrase(fx.phrase, salt: fx.salt)
        PartnerLogic.scryptCost = Self.cheapCost
        XCTAssertEqual(full, fx.hash, "ugyanaz a jelmondat, ugyanaz a lenyomat — mint a gépen")
        XCTAssertNil(PartnerLogic.hashPhrase(fx.phrase, salt: "nem base64!"), "rossz só: nincs lenyomat")
        // A szabály (kanonikus alak, rossz jelmondat, üres) olcsó költséggel —
        // a lenyomat itt nem a fixture-é, nem is kell annak lennie.
        let lock = PartnerLogic.makeLock(name: "Anna", phrase: fx.phrase, now: now)
        XCTAssertEqual(PartnerLogic.hashPhrase(" Alma bogrács CINEGE délután", salt: lock.salt), lock.hash,
                       "a kanonikus alak számít")
        XCTAssertNotEqual(PartnerLogic.hashPhrase(fx.wrong, salt: lock.salt), lock.hash)
        XCTAssertTrue(PartnerLogic.verify(lock, "ALMA  bogrács cinege délután "))
        XCTAssertFalse(PartnerLogic.verify(lock, fx.wrong))
        XCTAssertFalse(PartnerLogic.verify(lock, ""))
        let made = PartnerLogic.makeLock(name: "Anna", phrase: phrase, now: now)
        XCTAssertTrue(PartnerLogic.verify(made, phrase))
        XCTAssertNotEqual(made.salt, lock.salt, "friss só minden felvételnél")
        XCTAssertNil(PartnerLogic.normalizeLock(name: "Anna", salt: "rövid", hash: fx.hash, setAt: 1))
        XCTAssertNil(PartnerLogic.normalizeLock(name: "", salt: fx.salt, hash: fx.hash, setAt: 1))
        XCTAssertEqual(PartnerLogic.normalizeLock(name: "Anna", salt: fx.salt, hash: fx.hash, setAt: 1),
                       PartnerLogic.PartnerLock(name: "Anna", salt: fx.salt, hash: fx.hash, setAt: 1))
        XCTAssertEqual(PartnerLogic.normalizeLock(name: "Anna", salt: fx.salt, hash: fx.hash, setAt: nil)?.setAt, 0)
    }

    private func set(
        _ p: PartnerLogic.PartnerLock?, _ co: [PartnerLogic.PartnerLock] = [], _ gone: [PartnerLogic.PartnerGone] = []
    ) -> PartnerLogic.PartnerSet {
        PartnerLogic.PartnerSet(partner: p, partnerCo: co, partnersGone: gone)
    }

    func testMergeByIdentityOnlyATombstoneTakesALivePartnerNotTheMark() {
        let a = PartnerLogic.PartnerLock(name: "Anna", salt: String(repeating: "A", count: 24),
                                         hash: String(repeating: "B", count: 44), setAt: 100)
        let b = PartnerLogic.PartnerLock(name: "Béla", salt: String(repeating: "C", count: 24),
                                         hash: String(repeating: "D", count: 44), setAt: 200)
        XCTAssertEqual(PartnerLogic.mergePartners(set(a), set(nil)), set(a))
        XCTAssertEqual(PartnerLogic.mergePartners(set(b), set(a)), set(a, [b]),
                       "két különböző élő: mindkettő marad, a korábban felvett a fő")
        let goneA = [PartnerLogic.PartnerGone(id: PartnerLogic.partnerId(a), at: 7)]
        XCTAssertEqual(PartnerLogic.mergePartners(set(a), set(nil, [], goneA)), set(nil, [], goneA))
        XCTAssertEqual(PartnerLogic.mergePartners(set(nil, [], goneA), set(a, [b])), set(b, [], goneA),
                       "a fő levétele után a társ lép a helyére")
        XCTAssertEqual(
            PartnerLogic.cleanPartnersGone([
                PartnerLogic.PartnerGone(id: PartnerLogic.partnerId(a), at: 3),
                PartnerLogic.PartnerGone(id: PartnerLogic.partnerId(a), at: 9),
                PartnerLogic.PartnerGone(id: "rossz", at: 1),
            ]),
            [PartnerLogic.PartnerGone(id: PartnerLogic.partnerId(a), at: 9)]
        )

        // A TRÜKK: friss eszközön, felhúzott jellel felvett saját megbízott nem váltja le a valódit.
        let own = PartnerLogic.PartnerLock(name: "Én", salt: String(repeating: "E", count: 24),
                                           hash: String(repeating: "F", count: 44), setAt: 50)
        let account = FocusSync.SyncFocus(rev: 3, updatedAt: 0, updatedBy: "gep", partner: a, partnerRev: 3)
        let fresh = FocusSync.SyncFocus(rev: 40, updatedAt: 999, updatedBy: "friss", partner: own, partnerRev: 40)
        for merged in [FocusSync.merge(account, fresh), FocusSync.merge(fresh, account)] {
            let names = ([merged.partner].compactMap { $0 } + (merged.partnerCo ?? [])).map { $0.name }.sorted()
            XCTAssertEqual(names, ["Anna", "Én"], "a valódi megmarad — a saját csak mellé kerül")
            XCTAssertEqual(merged.partnerRev, 40)
        }
        // A „nincs megbízott” felhúzott jellel sem viszi el.
        let none = FocusSync.SyncFocus(rev: 50, updatedAt: 0, updatedBy: "friss", partnerRev: 50)
        XCTAssertEqual(FocusSync.merge(account, none).partner, a)
        XCTAssertEqual(FocusSync.merge(none, account).partner, a)
        // A nyom viszont elviszi.
        let removed = FocusSync.SyncFocus(rev: 4, updatedAt: 0, updatedBy: "dev", partnerRev: 4, partnersGone: goneA)
        XCTAssertNil(FocusSync.merge(account, removed).partner)
        var withCo = account
        withCo.partnerCo = [own]
        XCTAssertFalse(FocusSync.same(account, withCo), "a társ is különbség")
        var withGone = account
        withGone.partnersGone = [PartnerLogic.PartnerGone(id: PartnerLogic.partnerId(own), at: 1)]
        XCTAssertFalse(FocusSync.same(account, withGone), "a nyom is különbség")
        var swapped = account
        swapped.partner = b
        XCTAssertFalse(FocusSync.same(account, swapped), "a megbízott cseréje különbség: fel kell tölteni")
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

    func testTheWireCarriesCoPartnersAndTombstonesAndDropsTheBadlyShaped() throws {
        let a = PartnerLogic.PartnerLock(name: "Anna", salt: String(repeating: "A", count: 24),
                                         hash: String(repeating: "B", count: 44), setAt: 100)
        let b = PartnerLogic.PartnerLock(name: "Béla", salt: String(repeating: "C", count: 24),
                                         hash: String(repeating: "D", count: 44), setAt: 200)
        let c = PartnerLogic.PartnerLock(name: "Cili", salt: String(repeating: "E", count: 24),
                                         hash: String(repeating: "F", count: 44), setAt: 300)
        let mine = FocusSync.SyncFocus(
            rev: 4, updatedAt: 1, updatedBy: "dev", partner: a, partnerRev: 4,
            partnerCo: [b], partnersGone: [PartnerLogic.PartnerGone(id: PartnerLogic.partnerId(c), at: 7)]
        )
        let data = try JSONEncoder().encode(mine)
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let co = try XCTUnwrap(obj["partnerCo"] as? [[String: Any]])
        XCTAssertEqual(co.count, 1)
        XCTAssertEqual(Set(co[0].keys), ["name", "salt", "hash", "setAt"], "a társ jelmondata sincs a dróton")
        let gone = try XCTUnwrap(obj["partnersGone"] as? [[String: Any]])
        XCTAssertEqual(Set(gone[0].keys), ["id", "at"])
        XCTAssertEqual((gone[0]["at"] as? NSNumber)?.doubleValue, 7)
        let back = FocusSync.normalize(try JSONDecoder().decode(FocusSync.SyncFocus.self, from: data), fallbackDevice: "dev")
        XCTAssertEqual(back.partner, a)
        XCTAssertEqual(back.partnerCo, [b])
        XCTAssertEqual(back.partnersGone, [PartnerLogic.PartnerGone(id: PartnerLogic.partnerId(c), at: 7)])
        let bare = try JSONEncoder().encode(FocusSync.SyncFocus(rev: 1, updatedAt: 1, updatedBy: "dev", partner: a))
        let bareObj = try XCTUnwrap(try JSONSerialization.jsonObject(with: bare) as? [String: Any])
        XCTAssertNil(bareObj["partnerCo"], "társ nélkül nincs mező")
        XCTAssertNil(bareObj["partnersGone"], "nyom nélkül nincs mező")

        // Kívülről: a fővel egyező és a rossz alakú társ kiesik, a rossz
        // azonosságú nyom is; a nem egész vagy nem szám időpont nulla.
        let junk = """
        {"packs":[],"rev":4,"partner":{"name":"Anna","salt":"\(a.salt)","hash":"\(a.hash)","setAt":100},
         "partnerCo":[{"name":"Anna","salt":"\(a.salt)","hash":"\(a.hash)","setAt":100},
                      {"name":"X","salt":"rövid","hash":"rövid"},7],
         "partnersGone":[{"id":"rossz","at":1},{"id":"\(PartnerLogic.partnerId(c))","at":1.5},
                         {"id":"\(PartnerLogic.partnerId(b))","at":"9"}]}
        """
        let n = FocusSync.normalize(
            try JSONDecoder().decode(FocusSync.SyncFocus.self, from: Data(junk.utf8)), fallbackDevice: "dev")
        XCTAssertEqual(n.partner, a)
        XCTAssertNil(n.partnerCo, "a fővel egyező és a rossz alakú társ kiesik")
        XCTAssertEqual(n.partnersGone, [
            PartnerLogic.PartnerGone(id: PartnerLogic.partnerId(b), at: 0),
            PartnerLogic.PartnerGone(id: PartnerLogic.partnerId(c), at: 0),
        ])
        // A nyommal levett fő nem él: a társ lép a helyére — a beolvasáskor is.
        let tomb = """
        {"packs":[],"rev":4,"partner":{"name":"Anna","salt":"\(a.salt)","hash":"\(a.hash)","setAt":100},
         "partnerCo":[{"name":"Béla","salt":"\(b.salt)","hash":"\(b.hash)","setAt":200}],
         "partnersGone":[{"id":"\(PartnerLogic.partnerId(a))","at":5}]}
        """
        let t = FocusSync.normalize(
            try JSONDecoder().decode(FocusSync.SyncFocus.self, from: Data(tomb.utf8)), fallbackDevice: "dev")
        XCTAssertEqual(t.partner, b)
        XCTAssertNil(t.partnerCo)
    }

    func testAnOldAttemptsPartnerStepStillDecodes() throws {
        // A frissítés előtti kísérlet lépésében nincs `partnerId` — a mentés
        // ettől még olvasható (különben az egész állapot olvashatatlan lenne),
        // és a lépés a fő megbízotté.
        let old = Data(#"{"partner":{"id":"st1","name":"Anna"}}"#.utf8)
        let step = try JSONDecoder().decode(ChallengeEngine.Step.self, from: old)
        guard case .partner(let id, let name, let pid) = step else { return XCTFail("a lépés a megbízotté") }
        XCTAssertEqual(id, "st1")
        XCTAssertEqual(name, "Anna")
        XCTAssertNil(pid)
    }

    // ------------------------------------------------------------------ a bíró
    //
    // A tár közzétett `state`-je a fő sorra van dobva, és a tesztfolyamatban
    // nincs, ami megforgassa: két egymás utáni bíró-hívás közül a második a
    // RÉGI állapotot látná (a LockdownWindowRefereeTests ugyanígy forgat).
    // Ezért minden mutáció után `settled` — a hívás, aztán a fő sor.

    @discardableResult
    private func settled<T>(_ f: () throws -> T) rethrows -> T {
        // Dobásnál is: az ötödik rossz jelmondat a kísérletet viszi el ÉS dob —
        // a forgatás nélkül az ellenőrzés a még élő kísérletet látná.
        defer { pumpMainQueue() }
        return try f()
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
        case .partner: XCTFail("a megbízott lépése a jelmondat"); return ""
        }
    }

    /// Végigviszi a kísérletet a megbízott lépéséig — a várakozást is átveszi.
    private func solveUntilPartner(_ id: String) throws {
        var guardCount = 0
        while let step = currentStep(), guardCount < 40 {
            guardCount += 1
            switch step {
            case .partner: return
            case .delay(_, _, let claimableAt, _):
                // Közben a kör rendesen ketyegett: az átvétel előtti
                // óraugrás-elnyelés ezt nem tartja ugrásnak.
                let at = (claimableAt ?? now) + 1
                BreakerStore.shared.saveLastTick(at - 1000)
                try settled { try Referee.claimDelay(sessionId: id, now: at) }
            default:
                try settled { try Referee.submitAnswer(sessionId: id, answer: solve(step), now: now) }
            }
        }
        XCTFail("a kísérlet elfogyott a megbízott lépése előtt")
    }

    func testWithAPartnerTheLastStepIsTheirPhraseAfterTheWait() throws {
        let siteId = addSite("youtube.com")
        let setup = try settled { try Referee.setPartner(name: "  Anna ", now: now) }
        XCTAssertEqual(setup.name, "Anna")
        XCTAssertEqual(setup.phrase.split(separator: " ").count, PartnerLogic.partnerPhraseWords, "négy szó")
        XCTAssertEqual(setup.phrase, setup.phrase.lowercased())
        XCTAssertEqual(BreakerStore.shared.state.partner?.name, "Anna")
        XCTAssertThrowsError(try settled { try Referee.setPartner(name: "Béla", now: now) }) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "PARTNER_SET")
        }

        let ses = try settled { try Referee.startSession(kind: .pause, siteId: siteId, minutes: 15, now: now) }
        guard case .partner(_, let name, let pid) = ses.steps.last! else { return XCTFail("az utolsó lépés a megbízotté") }
        XCTAssertEqual(pid, BreakerStore.shared.state.partner.map { PartnerLogic.partnerId($0) }, "a lépés tudja, kié")
        XCTAssertEqual(name, "Anna")
        guard case .delay = ses.steps[ses.steps.count - 2] else { return XCTFail("a várakozás után áll") }

        try solveUntilPartner(ses.id)
        // Rossz jelmondat: nem sorsol újat, csak számol; a plafonnál a kísérlet elszáll.
        for _ in 0..<(PartnerLogic.maxPartnerTries - 1) {
            let r = try settled { try Referee.submitAnswer(sessionId: ses.id, answer: "alma bogrács cinege este", now: now) }
            XCTAssertFalse(r.accepted)
            XCTAssertTrue(r.message?.contains("Nem ez a jelmondat") ?? false)
            XCTAssertNotNil(BreakerStore.shared.state.session, "a kísérlet még él")
        }
        XCTAssertThrowsError(try settled { try Referee.submitAnswer(sessionId: ses.id, answer: "megint rossz", now: now) }) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "PARTNER_TRIES")
            XCTAssertTrue((e as? Referee.RefereeError)?.message.contains("elölről") ?? false)
        }
        XCTAssertNil(BreakerStore.shared.state.session, "a plafonnál elszállt")
        XCTAssertNil(BreakerStore.shared.state.sites[0].pauseUntil, "feloldás nem történt")

        // Újra: minden lépés elölről, és a jó jelmondat a végén feloldja.
        let again = try settled { try Referee.startSession(kind: .pause, siteId: siteId, minutes: 15, now: now + 1000) }
        try solveUntilPartner(again.id)
        let r = try settled {
            try Referee.submitAnswer(sessionId: again.id, answer: " \(setup.phrase.uppercased()) ", now: now + 1000)
        }
        XCTAssertTrue(r.accepted)
        XCTAssertTrue(r.sessionDone)
        XCTAssertNotNil(BreakerStore.shared.state.sites[0].pauseUntil, "a szünet elindult")
    }

    func testAnAbandonedAttemptsComboDoesNotContainThePartnerStep() throws {
        let siteId = addSite("youtube.com")
        try settled { try Referee.setPartner(name: "Anna", now: now) }
        let ses = try settled { try Referee.startSession(kind: .pause, siteId: siteId, minutes: 15, now: now) }
        settled { Referee.abandon(sessionId: ses.id) }
        let debt = try XCTUnwrap(BreakerStore.shared.state.abandons?.first)
        XCTAssertFalse(debt.comboKey.contains("PARTNER"), debt.comboKey)
        XCTAssertNotNil(ChallengeEngine.parseCombo(debt.comboKey), "a kulcs visszaolvasható")
    }

    func testRemovingThePartnerIsAChallengeEndingWithTheirPhrase() throws {
        _ = addSite("youtube.com")
        XCTAssertTrue(try settled { try Referee.startPartnerRemoval(now: now) }.applied,
                      "megbízott nélkül nincs mit levenni")
        let setup = try settled { try Referee.setPartner(name: "Anna", now: now) }
        let annaId = PartnerLogic.partnerId(try XCTUnwrap(BreakerStore.shared.state.partner))
        let r = try settled { try Referee.startPartnerRemoval(now: now) }
        XCTAssertFalse(r.applied)
        let ses = try XCTUnwrap(r.session)
        XCTAssertEqual(ses.pendingPartnerRemoval, true)
        XCTAssertEqual(ses.siteId, "partner")
        guard case .partner = ses.steps.last! else { return XCTFail("az utolsó lépés a megbízotté") }
        XCTAssertThrowsError(try settled { try Referee.startPartnerRemoval(now: now) }) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "BUSY")
        }
        try solveUntilPartner(ses.id)
        let done = try settled { try Referee.submitAnswer(sessionId: ses.id, answer: setup.phrase, now: now) }
        XCTAssertTrue(done.sessionDone)
        XCTAssertNil(BreakerStore.shared.state.partner, "a megbízott lekerült")
        XCTAssertEqual(BreakerStore.shared.state.partnersGone?.map { $0.id }, [annaId],
                       "a levétel nyomot hagy — a többi eszközön ez viszi el")
        XCTAssertEqual(BreakerStore.shared.state.unlockLog.count, 1, "a lazítás a naplóban")
    }

    func testWithACoPartnerEachPhraseIsNeededAndRemovalTombstonesThoseWhoSaidIt() throws {
        let siteId = addSite("youtube.com")
        let anna = try settled { try Referee.setPartner(name: "Anna", now: now) }
        let annaId = PartnerLogic.partnerId(try XCTUnwrap(BreakerStore.shared.state.partner))
        // Egy másik eszközön, egymástól függetlenül felvett megbízott a szinkronból.
        let belaPhrase = "alma bogrács cinege este"
        let bela = PartnerLogic.makeLock(name: "Béla", phrase: belaPhrase, now: now + 1)
        settled { BreakerStore.shared.mutate { state in state.partnerCo = [bela] } }
        XCTAssertThrowsError(try settled { try Referee.setPartner(name: "Cili", now: now) }) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "PARTNER_SET")
        }

        let ses = try settled { try Referee.startSession(kind: .pause, siteId: siteId, minutes: 15, now: now) }
        let names = ses.steps.compactMap { step -> String? in
            if case .partner(_, let name, _) = step { return name }
            return nil
        }
        XCTAssertEqual(names, ["Anna", "Béla"], "mindkettőjüké, sorban")
        try solveUntilPartner(ses.id)
        XCTAssertFalse(try settled { try Referee.submitAnswer(sessionId: ses.id, answer: belaPhrase, now: now) }.accepted,
                       "Anna lépésére Béla jelmondata nem jó")
        XCTAssertTrue(try settled { try Referee.submitAnswer(sessionId: ses.id, answer: anna.phrase, now: now) }.accepted)
        XCTAssertFalse(try settled { try Referee.submitAnswer(sessionId: ses.id, answer: anna.phrase, now: now) }.accepted,
                       "Béla lépésére Anna jelmondata sem")
        XCTAssertTrue(try settled { try Referee.submitAnswer(sessionId: ses.id, answer: belaPhrase, now: now) }.sessionDone)

        let removal = try XCTUnwrap(try settled { try Referee.startPartnerRemoval(now: now + 10) }.session)
        try solveUntilPartner(removal.id)
        XCTAssertTrue(try settled { try Referee.submitAnswer(sessionId: removal.id, answer: anna.phrase, now: now + 10) }.accepted)
        // Közben egy harmadik érkezik a szinkronból: ő nem bólintott — marad.
        let cili = PartnerLogic.makeLock(name: "Cili", phrase: "dió eper füge gomba", now: now + 2)
        settled { BreakerStore.shared.mutate { state in state.partnerCo = (state.partnerCo ?? []) + [cili] } }
        XCTAssertTrue(try settled { try Referee.submitAnswer(sessionId: removal.id, answer: belaPhrase, now: now + 10) }.sessionDone)
        let st = BreakerStore.shared.state
        XCTAssertEqual(st.partner?.name, "Cili", "aki nem bólintott, marad")
        XCTAssertNil(st.partnerCo)
        XCTAssertEqual((st.partnersGone ?? []).map { $0.id }.sorted(), [annaId, PartnerLogic.partnerId(bela)].sorted(),
                       "a két bólintó nyomot kap")
    }

    func testIfThePartnerWentAwayMeanwhileTheStepIsMoot() throws {
        let siteId = addSite("youtube.com")
        try settled { try Referee.setPartner(name: "Anna", now: now) }
        let ses = try settled { try Referee.startSession(kind: .pause, siteId: siteId, minutes: 15, now: now) }
        try solveUntilPartner(ses.id)
        settled { BreakerStore.shared.mutate { state in state.partner = nil } }
        XCTAssertTrue(try settled { try Referee.submitAnswer(sessionId: ses.id, answer: "bármi", now: now) }.sessionDone)
    }

    func testThePendingRemovalAndTheStepSurviveASave() throws {
        try settled { try Referee.setPartner(name: "Anna", now: now) }
        try settled { try Referee.startPartnerRemoval(now: now) }
        let data = try JSONEncoder().encode(BreakerStore.shared.state)
        let back = try JSONDecoder().decode(AppState.self, from: data)
        XCTAssertEqual(back.session?.pendingPartnerRemoval, true)
        let last = try XCTUnwrap(back.session?.steps.last)
        guard case .partner(_, let name, let pid) = last else { return XCTFail("a lépés túléli a mentést") }
        XCTAssertEqual(name, "Anna")
        XCTAssertNotNil(pid, "a lépés azonossága is")
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
