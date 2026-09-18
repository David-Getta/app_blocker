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

    func testMergeByMarkAndMatchingOnTheUrl() {
        XCTAssertEqual(KeywordLogic.mergeKeywords(3, ["shorts"], 5, ["reels"]), ["reels"])
        XCTAssertEqual(KeywordLogic.mergeKeywords(3, ["shorts"], 3, ["reels"]), ["shorts", "reels"], "azonos jel: unió")
        XCTAssertEqual(KeywordLogic.mergeKeywords(0, [], 0, ["shorts"]), ["shorts"], "a jeltelen nem töröl")
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
        XCTAssertEqual(SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now + 1), st, "változatlanul nem léptet")
        st.focusPacks = [Focus.Pack(id: "p1", name: "Írás", allowSites: [], allowApps: [], defaultMinutes: 25, recurrence: nil)]
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now + 2)
        XCTAssertEqual(st.focusRev, 2)
        XCTAssertEqual(st.keywordsRev, 1, "a csomag szerkesztése nem a kulcsszavak jele")
        st.keywords = ["reels"]
        st.keywordsRev = 9
        let adopted = SyncRevisions.adoptFocus(st)
        XCTAssertEqual(SyncRevisions.bumpFocus(adopted, deviceId: "iphone", now: now + 3).focusRev, 2, "az átvétel nem szerkesztés")
        var edited = adopted
        edited.focusPacks = []
        edited = SyncRevisions.bumpFocus(edited, deviceId: "iphone", now: now + 4)
        XCTAssertEqual(edited.keywordsRev, 9, "az átvett lista jele marad")
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

        let removed = FocusSync.SyncFocus(rev: 5, updatedAt: 0, updatedBy: "other", keywordsRev: 5)
        let merged = FocusSync.merge(mine, removed)
        XCTAssertNil(merged.keywords, "a nagyobb jelű levétel átmegy")
        XCTAssertEqual(merged.keywordsRev, 5)
        let same = FocusSync.merge(mine, FocusSync.SyncFocus(rev: 3, updatedAt: 0, updatedBy: "o", keywords: ["reels"], keywordsRev: 3))
        XCTAssertEqual(same.keywords, ["shorts", "reels"], "azonos jel: unió")
        let old = FocusSync.SyncFocus(rev: 9, updatedAt: 999, updatedBy: "old")
        XCTAssertEqual(FocusSync.merge(mine, old).keywords, ["shorts"], "a jeltelen nem viszi el")
        var swapped = mine
        swapped.keywords = ["shorts", "reels"]
        XCTAssertFalse(FocusSync.same(mine, swapped), "a lista cseréje különbség")
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
                try settled { try Referee.claimDelay(sessionId: id, now: (claimableAt ?? now) + 1) }
            default:
                try settled { try Referee.submitAnswer(sessionId: id, answer: solve(step), now: now) }
            }
        }
    }
}
