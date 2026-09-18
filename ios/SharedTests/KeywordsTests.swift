import Foundation
import XCTest
@testable import BreakerShared

// Kulcsszó-szabályok a Swift-tükrön — a desktop/test/keywords.test.ts és az
// androidos KeywordsTest esetei: a mag (alak, lista, fésülés, illesztés), a
// jel és a drót. Az iPhone nem érvényesít és nem szerkeszt — hordoz és fésül.
final class KeywordsTests: XCTestCase {

    private let now: Double = 1_700_000_000_000

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
}
