import Foundation
import XCTest
@testable import BreakerShared

// Megfelelőség a géppel a PÁROSÍTÓ KÓDBAN: a `fixtures/pairing-cases.json` a
// gép kimeneteit tartja (desktop/test/pairing-fixture.test.ts írja és őrzi) —
// cím → kód, beírt szöveg → cím, egy mező, megjelenítés. A gépen kiírt kódot
// az iPhone-on gépelik be: ha egy bit eltér, a kód nem nyílik ki, vagy MÁS
// címet ad. A Swift párosítónak ez az első tesztje: eddig csak fordult.

private struct PairingCase: Decodable {
    let input: String
    let out: String?
    enum CodingKeys: String, CodingKey { case input = "in", out }
}

private struct Fixture: Decodable {
    let version: Int
    let encode: [PairingCase]
    let decode: [PairingCase]
    let resolve: [PairingCase]
    let format: [PairingCase]
}

final class PairingFixtureTests: XCTestCase {

    private func load() throws -> Fixture {
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("pairing-cases.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func show(_ s: String?) -> String {
        guard let s else { return "nil" }
        let body = s.unicodeScalars.map { u -> String in
            (u.value < 0x20 || u.value >= 0x7f) ? String(format: "\\u{%04x}", u.value) : String(Character(u))
        }.joined()
        return "\"" + body + "\""
    }

    private func check(_ cases: [PairingCase], _ name: String, _ f: (String) -> String?) {
        XCTAssertGreaterThanOrEqual(cases.count, 10, "\(name): kevés eset — a fixtúra csonka?")
        for (i, c) in cases.enumerated() {
            let got = f(c.input)
            XCTAssertEqual(got, c.out, "\(name) #\(i): \(show(c.input)) — a gép \(show(c.out)), a Swift \(show(got))")
        }
    }

    func testAddressToCodeIsTheSameAsTheDesktop() throws {
        let f = try load()
        check(f.encode, "encode") { Pairing.encode($0) }
    }

    func testTypedTextToAddressIsTheSameAsTheDesktop() throws {
        let f = try load()
        check(f.decode, "decode") { Pairing.decode($0) }
    }

    func testOneFieldCodeOrAddressIsTheSameAsTheDesktop() throws {
        let f = try load()
        check(f.resolve, "resolve") { Pairing.resolveServerInput($0) }
    }

    func testTheReadableFormIsTheSameAsTheDesktop() throws {
        let f = try load()
        check(f.format, "format") { Pairing.format($0) as String? }
    }
}
