import Foundation
import XCTest
@testable import BreakerShared

// Kulcsszó-szabályok a Swift-tükrön — a desktop/test/keywords.test.ts és az
// androidos KeywordsTest esetei: a mag (alak, lista, fésülés, illesztés), a
// jel és a drót — és a bíró: az iPhone nem érvényesít (a szűrő a címet nem
// látja), de szerkeszt és hordoz: felvenni ingyen, levenni próbatétel.
final class KeywordsTests: XCTestCase {

    private let now: Double = 1_700_000_000_000

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
        BreakerStore.shared.mutate { state in state = AppState() }
        pumpMainQueue()
        BreakerStore.shared.saveLastTick(0)
    }

    func testTheKeywordHasACanonicalForm() {
        XCTAssertEqual(KeywordLogic.normalizeKeyword("  Shorts "), "shorts")
        XCTAssertEqual(KeywordLogic.normalizeKeyword("REELS"), "reels")
        XCTAssertNil(KeywordLogic.normalizeKeyword("ab"), "két betű mindenre illene")
        XCTAssertNil(KeywordLogic.normalizeKeyword("két szó"))
        XCTAssertNil(KeywordLogic.normalizeKeyword(String(repeating: "x", count: KeywordLogic.maxKeywordLength + 1)))
        XCTAssertEqual(KeywordLogic.normalizeKeyword(String(repeating: "x", count: KeywordLogic.maxKeywordLength))?.count,
                       KeywordLogic.maxKeywordLength)
        XCTAssertNil(KeywordLogic.normalizeKeyword(nil))
        XCTAssertNil(KeywordLogic.normalizeKeyword(""))
        let combining = String(Character(UnicodeScalar(0x0301)!))
        XCTAssertEqual(KeywordLogic.normalizeKeyword("a" + combining + "lom"), "álom")
    }

    func testTheListIsCleanAndTheKeyIsSorted() {
        XCTAssertEqual(KeywordLogic.cleanKeywords(["Shorts", "shorts", "ab", "reels", " REELS "]), ["shorts", "reels"])
        let many = (0..<(KeywordLogic.maxKeywords + 5)).map { "szo\(String(format: "%03d", $0))" }
        XCTAssertEqual(KeywordLogic.cleanKeywords(many).count, KeywordLogic.maxKeywords)
        XCTAssertEqual(KeywordLogic.keywordsKey(["reels", "shorts"]), KeywordLogic.keywordsKey(["shorts", "reels"]))
        XCTAssertTrue(KeywordLogic.sameKeywords(["Shorts", "reels"], ["reels", "shorts"]))
        XCTAssertFalse(KeywordLogic.isKeywordsLoosening(["shorts"], ["shorts", "reels"]), "bővítés: szigorítás")
        XCTAssertTrue(KeywordLogic.isKeywordsLoosening(["shorts", "reels"], ["shorts"]), "levétel: lazítás")
    }

    private func set(_ keywords: [String], _ marks: [String: Int]? = nil) -> KeywordLogic.KeywordSet {
        KeywordLogic.KeywordSet(keywords: keywords, keywordMarks: marks)
    }

    func testMergePerKeywordTheHigherMarkDecidesEqualOrMissingIsTheUnion() {
        XCTAssertEqual(KeywordLogic.mergeKeywordSets(set(["shorts"]), set([], ["shorts": 5])), set([], ["shorts": 5]),
                       "a jeles levétel átmegy")
        XCTAssertEqual(KeywordLogic.mergeKeywordSets(set(["shorts"], ["shorts": 6]), set([], ["shorts": 5])).keywords, ["shorts"])
        XCTAssertEqual(KeywordLogic.mergeKeywordSets(set(["shorts"]), set(["reels"])).keywords, ["reels", "shorts"], "jel nélkül unió")
        XCTAssertEqual(KeywordLogic.mergeKeywordSets(set([]), set(["shorts"])).keywords, ["shorts"], "a jeltelen hiány nem töröl")
        XCTAssertEqual(KeywordLogic.mergeKeywordSets(set(["shorts"], ["shorts": 4]), set([], ["shorts": 4])).keywords, ["shorts"],
                       "egyenlő jel: unió")
        // A TRÜKK: egy elavult eszközön egy ingyenes felvétel — a régi listája nem töröl.
        let account = set(["shorts", "reels"], ["shorts": 3, "reels": 7])
        let stale = set(["shorts", "live"], ["shorts": 3, "live": 40])
        for m in [KeywordLogic.mergeKeywordSets(account, stale), KeywordLogic.mergeKeywordSets(stale, account)] {
            XCTAssertEqual(m.keywords, ["shorts", "reels", "live"], "a reels megmarad, a live mellé kerül — a sorrend a jelé")
            XCTAssertEqual(m.keywordMarks, ["shorts": 3, "reels": 7, "live": 40])
        }
        // A plafon a régit védi.
        let legacy = ["alma", "korte", "szilva"]
        let junk = (0..<KeywordLogic.maxKeywords).map { "szemet\(String(format: "%02d", $0))" }
        let crowded = KeywordLogic.mergeKeywordSets(set(legacy), set(junk, Dictionary(uniqueKeysWithValues: junk.map { ($0, 50) })))
        XCTAssertEqual(crowded.keywords.count, KeywordLogic.maxKeywords)
        for k in legacy { XCTAssertTrue(crowded.keywords.contains(k), "a régi \(k) nem szorul ki") }
        let lots = Dictionary(uniqueKeysWithValues: (0..<200).map { ("gone\(String(format: "%03d", $0))", $0 + 1) })
        let capped = KeywordLogic.capKeywordMarks(lots, ["gone000"])
        XCTAssertEqual(capped?.count, KeywordLogic.maxKeywordMarks)
        XCTAssertEqual(capped?["gone000"], 1, "a jelen lévő jele mindig marad")
        XCTAssertEqual(capped?["gone199"], 200)
        XCTAssertNil(capped?["gone001"], "a legrégebbi levétel esik ki")
        XCTAssertEqual(
            KeywordLogic.cleanKeywordMarks(["shorts": 2, "reels": 0, "stream": 9, "Shorts": 1, "ab": 1, "két szó": 1], ["shorts"], maxRev: 3),
            ["shorts": 2]
        )
        // Bontott ékezet: a gépen nem kanonikus, itt sem — a Swift `==` egynek venné.
        let combining = String(Character(UnicodeScalar(0x0301)!))
        XCTAssertNil(KeywordLogic.cleanKeywordMarks(["a" + combining + "lom": 2], [], maxRev: 3))
        XCTAssertEqual(KeywordLogic.markKeywordChanges(["shorts": 2], prev: ["shorts", "reels"], next: ["shorts", "live"], rev: 5),
                       ["shorts": 2, "reels": 5, "live": 5])
    }

    func testMatchingOnTheUrl() {
        let words = ["shorts", "tiktok", "játék"]
        XCTAssertEqual(KeywordLogic.keywordHit(words, "https://www.youtube.com/shorts/abc"), "shorts")
        XCTAssertEqual(KeywordLogic.keywordHit(words, "https://www.youtube.com/watch?v=x&list=SHORTS"), "shorts")
        XCTAssertEqual(KeywordLogic.keywordHit(words, "https://www.tiktok.com/@valaki"), "tiktok", "a hosztnév is a cím része")
        XCTAssertEqual(KeywordLogic.keywordHit(words, "https://example.com/j%C3%A1t%C3%A9k"), "játék", "a százalék-kódolás feloldva")
        XCTAssertNil(KeywordLogic.keywordHit(words, "https://example.com/hirek"))
        XCTAssertNil(KeywordLogic.keywordHit(words, "https://example.com/%E0%A4%A"), "rossz kódolás: nem hasal el")
        XCTAssertNil(KeywordLogic.keywordHit(["ab"], "https://ab.com"))
    }

    func testTheMarkFollowsTheListAndAdoptionDoesNotBump() {
        var st = AppState()
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now)
        XCTAssertEqual(st.focusRev ?? 0, 0, "üres: nincs léptetés")
        st.keywords = ["shorts"]
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now)
        XCTAssertEqual(st.focusRev, 1)
        XCTAssertEqual(st.keywordsRev, 1)
        XCTAssertEqual(st.keywordMarks, ["shorts": 1], "a felvett kulcsszó a saját jelét kapja")
        XCTAssertEqual(SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now + 1), st, "változatlanul nem léptet")
        st.focusPacks = [Focus.Pack(id: "p1", name: "Írás", allowSites: [], allowApps: [], defaultMinutes: 25, recurrence: nil)]
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now + 2)
        XCTAssertEqual(st.focusRev, 2)
        XCTAssertEqual(st.keywordsRev, 1, "a csomag szerkesztése nem a kulcsszavak jele")
        XCTAssertEqual(st.keywordMarks, ["shorts": 1], "a csomag szerkesztése a kulcsszó jelét sem bántja")
        st.keywords = ["reels"]
        st.keywordsRev = 9
        let adopted = SyncRevisions.adoptFocus(st)
        XCTAssertEqual(SyncRevisions.bumpFocus(adopted, deviceId: "iphone", now: now + 3).focusRev, 2, "az átvétel nem szerkesztés")
        var edited = adopted
        edited.focusPacks = []
        edited = SyncRevisions.bumpFocus(edited, deviceId: "iphone", now: now + 4)
        XCTAssertEqual(edited.keywordsRev, 9, "az átvett lista jele marad")
        XCTAssertEqual(edited.keywordMarks, ["shorts": 1], "az átvett kulcsszó nem saját felvétel")
    }

    func testTheWireCarriesTheListAndTheMarkAndMergesOnTheBlob() throws {
        let junk = """
        {"packs":[],"rev":4,"keywordsRev":99,"keywords":["Shorts","ab","shorts","reels"]}
        """
        let decoded = try JSONDecoder().decode(FocusSync.SyncFocus.self, from: Data(junk.utf8))
        let n = FocusSync.normalize(decoded, fallbackDevice: "dev")
        XCTAssertEqual(n.keywords, ["shorts", "reels"])
        XCTAssertNil(n.keywordsRev, "a jel legfeljebb a blob rev-je")
        let mine = FocusSync.SyncFocus(rev: 3, updatedAt: 1, updatedBy: "dev", keywords: ["shorts"], keywordsRev: 3)
        let text = String(decoding: try JSONEncoder().encode(mine), as: UTF8.self)
        XCTAssertTrue(text.contains("\"keywords\""))
        XCTAssertTrue(text.contains("\"keywordsRev\":3"))
        let bare = String(decoding: try JSONEncoder().encode(FocusSync.SyncFocus(rev: 1, updatedAt: 1, updatedBy: "dev")), as: UTF8.self)
        XCTAssertFalse(bare.contains("keywords"), "üresen nincs mező")

        let withMarks = """
        {"packs":[],"rev":3,"keywords":["shorts"],"keywordMarks":{"shorts":2,"reels":3,"live":9,"Shorts":1,"stream":1.5,"tiktok":"2"}}
        """
        let wm = FocusSync.normalize(try JSONDecoder().decode(FocusSync.SyncFocus.self, from: Data(withMarks.utf8)), fallbackDevice: "dev")
        XCTAssertEqual(wm.keywordMarks, ["shorts": 2, "reels": 3], "a levétel jele is utazik; a túl nagy és a nem kanonikus kiesik")
        let marked = FocusSync.SyncFocus(rev: 3, updatedAt: 1, updatedBy: "dev", keywords: ["shorts"], keywordsRev: 3, keywordMarks: ["shorts": 3])
        XCTAssertTrue(String(decoding: try JSONEncoder().encode(marked), as: UTF8.self).contains("\"keywordMarks\":{\"shorts\":3}"))

        let removed = FocusSync.SyncFocus(rev: 5, updatedAt: 0, updatedBy: "other", keywordsRev: 5, keywordMarks: ["shorts": 5])
        let merged = FocusSync.merge(marked, removed)
        XCTAssertNil(merged.keywords, "a nagyobb jelű levétel átmegy")
        XCTAssertEqual(merged.keywordsRev, 5)
        // A TRÜKK: egy elavult eszköz felhúzott lista-jellel, a shorts saját jele nélkül.
        let stale = FocusSync.SyncFocus(rev: 40, updatedAt: 999, updatedBy: "friss", keywords: ["reels"], keywordsRev: 40,
                                        keywordMarks: ["reels": 40])
        for m in [FocusSync.merge(marked, stale), FocusSync.merge(stale, marked)] {
            XCTAssertEqual(m.keywords, ["shorts", "reels"], "a shorts megmarad — a reels mellé kerül")
            XCTAssertEqual(m.keywordsRev, 40)
        }
        let old = FocusSync.SyncFocus(rev: 9, updatedAt: 999, updatedBy: "old", keywordsRev: 9)
        XCTAssertEqual(FocusSync.merge(marked, old).keywords, ["shorts"], "a régi kliens jel nélküli levétele nem viszi el")
        var swapped = marked
        swapped.keywords = ["shorts", "reels"]
        XCTAssertFalse(FocusSync.same(marked, swapped), "a lista cseréje különbség")
        var remarked = marked
        remarked.keywordMarks = ["shorts": 2]
        XCTAssertFalse(FocusSync.same(marked, remarked), "a jel cseréje is különbség")
    }

    func testTheSuggestionsAreValidKeywordsThemselves() {
        for sug in KeywordLogic.suggestions { XCTAssertEqual(KeywordLogic.normalizeKeyword(sug), sug, sug) }
        XCTAssertEqual(Set(KeywordLogic.suggestions).count, KeywordLogic.suggestions.count)
        XCTAssertEqual(KeywordLogic.cleanKeywords(KeywordLogic.suggestions), KeywordLogic.suggestions)
    }

    // ---------------------------------------------------------------- a bíró

    func testTheRefereeAddsForFreeAndRemovesWithAChallenge() throws {
        resetStore()
        XCTAssertTrue(try settled { try Referee.setKeywords(["Shorts"], now: now) }.applied, "felvétel ingyen")
        XCTAssertEqual(BreakerStore.shared.state.keywords, ["shorts"])
        XCTAssertTrue(try settled { try Referee.setKeywords(["shorts", "reels"], now: now) }.applied, "bővítés ingyen")
        XCTAssertTrue(try settled { try Referee.setKeywords(["reels", "shorts"], now: now) }.applied,
                      "ugyanaz más sorrendben: nincs mit tenni")
        XCTAssertNil(BreakerStore.shared.state.session, "egyik sem indított próbatételt")

        let r = try settled { try Referee.setKeywords(["shorts"], now: now) }
        XCTAssertFalse(r.applied, "levétel: próbatétel")
        XCTAssertEqual(r.session?.siteId, "keywords")
        XCTAssertEqual(r.session?.pendingKeywords, ["shorts"])
        XCTAssertEqual(BreakerStore.shared.state.keywords, ["shorts", "reels"], "amíg a próbatétel tart, a lista marad")
        XCTAssertThrowsError(try settled { try Referee.setKeywords([], now: now) }) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "BUSY")
        }
        // Futó levétel közben a felvétel ingyen — és a függő lista is tud róla,
        // különben a teljesítéskor a régi lista ülne vissza, és a live eltűnne.
        XCTAssertTrue(try settled { try Referee.setKeywords(["shorts", "reels", "live"], now: now) }.applied,
                      "közben a live ingyen")
        XCTAssertEqual(BreakerStore.shared.state.session?.pendingKeywords, ["shorts", "live"])
        try solveWholeSession(r.session!.id)
        XCTAssertNil(BreakerStore.shared.state.session, "a kísérlet végigment")
        XCTAssertEqual(BreakerStore.shared.state.keywords, ["shorts", "live"], "a reels lement, a live megmaradt")
        XCTAssertEqual(BreakerStore.shared.state.unlockLog.count, 1, "a lazítás a naplóban")
        // A mentés a függő listát is hordozza: egy újraindítás nem tenné feloldássá.
        let again = try settled { try Referee.setKeywords(["live"], now: now + 1000) }
        XCTAssertFalse(again.applied)
        let data = try JSONEncoder().encode(BreakerStore.shared.state)
        XCTAssertEqual(try JSONDecoder().decode(AppState.self, from: data).session?.pendingKeywords, ["live"])
        Referee.abandon(sessionId: again.session!.id)
        pumpMainQueue()
    }

    func testTheRefereeRejectsBadAndTooManyKeywords() throws {
        resetStore()
        for bad in [["ab"], ["két szó"], ["shorts", "SHORTS"]] {
            XCTAssertThrowsError(try settled { try Referee.setKeywords(bad, now: now) }, "\(bad)") { e in
                XCTAssertEqual((e as? Referee.RefereeError)?.code, "BAD_KEYWORD")
            }
        }
        let many = (0..<(KeywordLogic.maxKeywords + 1)).map { "szo\(String(format: "%03d", $0))" }
        XCTAssertThrowsError(try settled { try Referee.setKeywords(many, now: now) }) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "TOO_MANY_KEYWORDS")
        }
        XCTAssertNil(BreakerStore.shared.state.keywords, "hibánál semmi nem változik")
        XCTAssertNil(BreakerStore.shared.state.session)
    }

    func testUnderLockdownRemovalDoesNotStartButAdditionIsFree() throws {
        // A zárlat kapuja a kulcsszóra is: levenni el sem indul, felvenni ingyen.
        resetStore()
        _ = try settled { try Referee.startLockdown(ms: 24 * 3_600_000, now: now) }
        XCTAssertTrue(try settled { try Referee.setKeywords(["shorts"], now: now + 1000) }.applied, "felvétel zárlat alatt is ingyen")
        XCTAssertThrowsError(try settled { try Referee.setKeywords([], now: now + 2000) }) { e in
            XCTAssertEqual((e as? Referee.RefereeError)?.code, "LOCKDOWN")
        }
        XCTAssertNil(BreakerStore.shared.state.session, "zárlat alatt próbatétel keletkezett")
        XCTAssertEqual(BreakerStore.shared.state.keywords, ["shorts"])
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
        case .partner: XCTFail("a megbízott lépése a jelmondat — ezek a tesztek megbízott nélkül futnak"); return ""
        }
    }

    /// Végigviszi a futó kísérletet — a várakozó lépést a célpontja után veszi át.
    private func solveWholeSession(_ id: String) throws {
        var guardCount = 0
        while let step = currentStep(), guardCount < 40 {
            guardCount += 1
            switch step {
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
    }
}
