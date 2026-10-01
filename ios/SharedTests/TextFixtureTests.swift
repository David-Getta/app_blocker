import Foundation
import XCTest
@testable import BreakerShared

// Megfelelőség a géppel a SZÖVEG-TISZTÍTÁSBAN: a `fixtures/text-cases.json` a
// gép tiszta alakjait tartja (desktop/test/text-fixture.test.ts írja és őrzi);
// itt ugyanazok a bemenetek a Swift tisztításán mennek át, és skalárra
// egyezniük kell. A Kotlin tükör (TextFixtureTest) ugyanezt.
//
// Amit fog: mást tart-e szóköznek az iPhone (BOM), máshol vág-e (graféma
// kontra skalár — egy zászló egy graféma, két skalár), kimarad-e a cseréből
// egy vezérlő, amire ékezet tapad (egy `Character`, két skalár), és másképp
// kezeli-e az NFKC-t és a kisbetűsítést.

private struct TextCase: Decodable {
    let input: String
    let out: String?
    enum CodingKeys: String, CodingKey { case input = "in", out }
}

private struct ListCase: Decodable {
    let input: [String]
    let out: [String]
    enum CodingKeys: String, CodingKey { case input = "in", out }
}

private struct MatchCase: Decodable {
    let rule: String
    let url: String
    let out: Bool
}

private struct AppMatchCase: Decodable {
    let apps: [String]
    let app: String
    let out: Bool
}

private struct Fixture: Decodable {
    let version: Int
    let alias: [TextCase]
    let reason: [TextCase]
    let keyword: [TextCase]
    let keywords: [ListCase]
    let partnerName: [TextCase]
    let phrase: [TextCase]
    let domain: [TextCase]
    let rule: [TextCase]
    let ruleMatch: [MatchCase]
    let allowApp: [TextCase]
    let appMatch: [AppMatchCase]
}

final class TextFixtureTests: XCTestCase {

    private func load() throws -> Fixture {
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("text-cases.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    /// Skalárra pontos egyezés: a Swift `==` kanonikus ekvivalenciát néz, a
    /// dróton viszont a bájtsor számít — egy NFD-s és egy NFC-s alak ott más.
    private func same(_ a: String?, _ b: String?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case let (x?, y?): return Array(x.unicodeScalars) == Array(y.unicodeScalars)
        default: return false
        }
    }

    /// Olvasható alak a hibaüzenetben: a vezérlők és a 0x7f fölötti skalárok \u{XXXX}-ként.
    private func show(_ s: String?) -> String {
        guard let s else { return "nil" }
        let body = s.unicodeScalars.map { u -> String in
            (u.value < 0x20 || u.value >= 0x7f) ? String(format: "\\u{%04x}", u.value) : String(Character(u))
        }.joined()
        return "\"" + body + "\""
    }

    private func check(_ cases: [TextCase], _ name: String, _ f: (String) -> String?) {
        XCTAssertGreaterThan(cases.count, 50, "\(name): kevés eset — a fixtúra csonka?")
        var valid = 0
        for (i, c) in cases.enumerated() {
            let got = f(c.input)
            XCTAssertTrue(same(c.out, got), "\(name) #\(i): \(show(c.input)) — a gép \(show(c.out)), a Swift \(show(got))")
            if got != nil { valid += 1 }
        }
        XCTAssertGreaterThan(valid, 0, "\(name): minden eset érvénytelen — a fixtúra elfajult")
    }

    func testTheAliasCleaningIsTheSameAsTheDesktop() throws {
        let f = try load()
        check(f.alias, "alias") { AliasLogic.normalize($0) }
    }

    func testTheReasonCleaningIsTheSameAsTheDesktop() throws {
        let f = try load()
        check(f.reason, "reason") { AliasLogic.normalizeReason($0) }
    }

    func testTheKeywordFormIsTheSameAsTheDesktop() throws {
        let f = try load()
        check(f.keyword, "keyword") { KeywordLogic.normalizeKeyword($0) }
    }

    func testThePartnerNameIsTheSameAsTheDesktop() throws {
        let f = try load()
        check(f.partnerName, "partnerName") { PartnerLogic.normalizePartnerName($0) }
    }

    func testThePhraseFormIsTheSameAsTheDesktop() throws {
        let f = try load()
        check(f.phrase, "phrase") { PartnerLogic.normalizePhrase($0) as String? }
    }

    func testTheDomainCleaningIsTheSameAsTheDesktop() throws {
        let f = try load()
        check(f.domain, "domain") { Blocklist.normalizeDomain($0) }
    }

    func testTheKeywordListCleaningIsTheSameAsTheDesktop() throws {
        let f = try load()
        XCTAssertGreaterThan(f.keywords.count, 20, "keywords: kevés eset")
        for (i, c) in f.keywords.enumerated() {
            let got = KeywordLogic.cleanKeywords(c.input)
            XCTAssertEqual(got.map { Array($0.unicodeScalars) }, c.out.map { Array($0.unicodeScalars) },
                           "keywords #\(i): \(c.input.map { show($0) })")
        }
    }

    func testThePartialRuleFormIsTheSameAsTheDesktop() throws {
        let f = try load()
        check(f.rule, "rule") { UrlRules.normalizeRule($0).map { "\($0.host)|\($0.path)" } }
    }

    func testThePartialRuleMatchingIsTheSameAsTheDesktop() throws {
        let f = try load()
        XCTAssertGreaterThan(f.ruleMatch.count, 50, "ruleMatch: kevés eset — a fixtúra csonka?")
        for (i, c) in f.ruleMatch.enumerated() {
            guard let rule = UrlRules.normalizeRule(c.rule) else {
                XCTFail("ruleMatch #\(i): az illesztendő szabály nem szabály: \(show(c.rule))")
                continue
            }
            XCTAssertEqual(UrlRules.matchesRule(rule, c.url), c.out, "ruleMatch #\(i): \(show(c.rule)) ~ \(show(c.url))")
        }
    }
    func testTheAllowedAppNameIsTheSameAsTheDesktop() throws {
        let f = try load()
        check(f.allowApp, "allowApp") { Focus.normalizeAllowApp($0) }
    }

    func testTheAppMatchIsTheSameAsTheDesktopAndAnEmptyEntryAllowsNothing() throws {
        let f = try load()
        XCTAssertGreaterThan(f.appMatch.count, 50, "appMatch: kevés eset — a fixtúra csonka?")
        for (i, c) in f.appMatch.enumerated() {
            let pack = Focus.Pack(id: "p", name: "p", allowSites: [], allowApps: c.apps, defaultMinutes: 30)
            XCTAssertEqual(Focus.isAppAllowed(pack, app: c.app), c.out,
                           "appMatch #\(i): \(c.apps.map { show($0) }.joined(separator: ", ")) ~ \(show(c.app))")
        }
    }
}
