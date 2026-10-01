import Foundation
import XCTest
@testable import BreakerShared

// A szöveg-tisztítás éles esetei név szerint — a desktop/test/alias.test.ts,
// keywords.test.ts, partner.test.ts és blocklist.test.ts megfelelő eseteinek
// tükre. A teljes megfelelőséget a TextFixtureTests nézi; ez a fájl azt mondja
// ki, MIÉRT: melyik buktató melyik.
final class TextLogicTests: XCTestCase {

    private let pizza = "\u{1F355}"

    private func scalars(_ s: String?) -> [UInt32]? { s.map { $0.unicodeScalars.map { $0.value } } }

    func testTheCutCountsScalarsSoAnEmojiIsNeverHalved() {
        // 39 betű + két emodzsi: a gépen UTF-16 egységben vágva a 40. egy fél
        // emodzsi lett volna; itt a `prefix` grafémát számolt — 41 graféma elfért volna.
        let a = AliasLogic.normalize(String(repeating: "a", count: AliasLogic.maxAliasLength - 1) + pizza + pizza)
        XCTAssertEqual(a, String(repeating: "a", count: AliasLogic.maxAliasLength - 1) + pizza)
        XCTAssertEqual(a?.unicodeScalars.count, AliasLogic.maxAliasLength)
        XCTAssertEqual(AliasLogic.normalize(String(repeating: pizza, count: 45)),
                       String(repeating: pizza, count: AliasLogic.maxAliasLength))
        // Egy zászló két skalár: a gép kettőnek számolja, a `prefix` egynek számolta volna.
        let flag = "\u{1F1ED}\u{1F1FA}"
        XCTAssertEqual(AliasLogic.normalize(String(repeating: flag, count: 25))?.unicodeScalars.count,
                       AliasLogic.maxAliasLength)
    }

    func testNoBreakSpaceAndBomAreSpacesTheListIsTheJsSet() {
        XCTAssertEqual(AliasLogic.normalize("A\u{00A0}videós"), "A videós")
        XCTAssertEqual(AliasLogic.normalize("\u{FEFF}A videós\u{FEFF}"), "A videós")
        XCTAssertNil(AliasLogic.normalize("\u{00A0}\u{FEFF}"))
        // Ami láthatatlan, de nem szóköz, marad: egyik mag sem veszi szóköznek.
        XCTAssertEqual(scalars(AliasLogic.normalize("A\u{200B}videós")), scalars("A\u{200B}videós"))
        XCTAssertEqual(TextLogic.spaces.count, 25)
        for v in TextLogic.spaces {
            let s = String(Character(Unicode.Scalar(v)!))
            XCTAssertEqual(AliasLogic.normalize("A\(s)B"), "A B", String(format: "U+%04X", v))
        }
        // A vezérlő a rá tapadó ékezettel együtt is vezérlő: skalár szinten cserélünk.
        XCTAssertEqual(scalars(AliasLogic.normalize("A\u{0001}\u{0301}B")), scalars("A \u{0301}B"))
    }

    func testKeywordEdgesAndTheLengthInScalars() {
        XCTAssertEqual(KeywordLogic.normalizeKeyword("\u{FEFF}Shorts\u{FEFF}"), "shorts")
        XCTAssertEqual(KeywordLogic.normalizeKeyword("\u{00A0}reels\u{00A0}"), "reels")
        XCTAssertNil(KeywordLogic.normalizeKeyword("két\u{00A0}szó"), "a nem törő szóköz is szóköz")
        XCTAssertNil(KeywordLogic.normalizeKeyword("két\u{FEFF}szó"), "a BOM is szóköz")
        XCTAssertEqual(scalars(KeywordLogic.normalizeKeyword("két\u{200B}szó")), scalars("két\u{200B}szó"))
        XCTAssertEqual(KeywordLogic.normalizeKeyword(String(repeating: pizza, count: 3)), String(repeating: pizza, count: 3))
        XCTAssertNil(KeywordLogic.normalizeKeyword(String(repeating: pizza, count: 2)), "két kódpont: kevés")
    }

    func testPhraseAndPartnerNameSpacesTheNameCutInScalarsWithoutATrailingSpace() {
        // A jelmondatot hasoljuk: ha a gép és a telefon mást tart szóköznek, az
        // egyik eszközön nem nyit.
        XCTAssertEqual(PartnerLogic.normalizePhrase("Alma\u{00A0}Bogrács\u{FEFF} Cinege"), "alma bogrács cinege")
        XCTAssertEqual(PartnerLogic.normalizePhrase("\u{FEFF}alma\u{3000}bogrács"), "alma bogrács")
        XCTAssertEqual(PartnerLogic.normalizePartnerName("Anya\u{00A0}"), "Anya")
        XCTAssertEqual(PartnerLogic.normalizePartnerName(String(repeating: pizza, count: 45)),
                       String(repeating: pizza, count: PartnerLogic.maxPartnerName))
        XCTAssertEqual(PartnerLogic.normalizePartnerName(String(repeating: "a", count: 39) + " bbbb"),
                       String(repeating: "a", count: 39))
    }

    func testTheGreekFinalSigmaIsLoweredLikeTheDesktopAndAndroid() {
        // A JS és a Java a szó végi Σ-t ς-nek írja (Final_Sigma); a Swift `lowercased()` σ-nak.
        XCTAssertEqual(scalars(KeywordLogic.normalizeKeyword("ΟΔΟΣ")), scalars("οδος"))
        XCTAssertEqual(scalars(KeywordLogic.normalizeKeyword("ΣΟΦΟΣ")), scalars("σοφος"))
        XCTAssertEqual(scalars(PartnerLogic.normalizePhrase("ΟΔΟΣ ΟΔΟΣ")), scalars("οδος οδος"))
        // Egyedül álló, vagy (case-ignorable jelen át) betű előtt álló szigma nem szóvégi.
        XCTAssertEqual(scalars(PartnerLogic.normalizePhrase("Σ ΑΣΑ")), scalars("σ ασα"))
        XCTAssertEqual(scalars(TextLogic.lowercase("ΑΣ\u{0301}Α")), scalars("ασ\u{0301}α"))
        XCTAssertEqual(scalars(TextLogic.lowercase("ΟΔΟΣ.")), scalars("οδος."))
        // A már kisbetűs σ a szó végén is σ marad: a szabály csak a nagy Σ-ra szól.
        XCTAssertEqual(scalars(TextLogic.lowercase("οδοσ")), scalars("οδοσ"))
        XCTAssertEqual(scalars(TextLogic.lowercase("ΟΔΟΣ οδοσ")), scalars("οδος οδοσ"))
        XCTAssertEqual(scalars(KeywordLogic.normalizeKeyword("οδοσ")), scalars("οδοσ"))
    }

    func testDomainEdgesBomAndNoBreakSpace() {
        XCTAssertEqual(Blocklist.normalizeDomain("\u{FEFF}youtube.com\u{FEFF}"), "youtube.com")
        XCTAssertEqual(Blocklist.normalizeDomain("\u{00A0}youtube.com\u{00A0}"), "youtube.com")
        XCTAssertNil(Blocklist.normalizeDomain("youtube\u{00A0}.com"))
        XCTAssertNil(Blocklist.normalizeDomain("youtube.com\u{200B}"))
    }
}
