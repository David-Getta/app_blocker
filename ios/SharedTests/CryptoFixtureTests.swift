import Foundation
import XCTest
@testable import BreakerShared

// Megfelelőség a géppel a SZINKRON TITKOSÍTÁSÁBAN: a `fixtures/crypto-cases.json`
// a gép kulcsait, burkolatait és blobjait tartja (desktop/test/crypto-fixture.test.ts
// írja és őrzi). Itt ugyanaz a jelszó és fiók az iPhone magjába megy: a
// belépőkulcsnak bájtra egyeznie kell, a burkolatnak ki kell nyílnia, a blobnak
// ugyanazt a szöveget kell adnia — és aminek a gépen nem szabad kinyílnia,
// annak itt sem.
//
// A Swift titkosításának és scryptjének ez az ELSŐ tesztje: eddig csak
// fordult. Ha itt egy bájt eltér, a gépen nyitott fiók az iPhone-on
// „rossz jelszó” — és semmi nem mondja meg, miért.
final class CryptoFixtureTests: XCTestCase {

    private func load() throws -> [String: Any] {
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("crypto-cases.json")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] ?? [:]
    }

    private func hex(_ b: [UInt8]) -> String { b.map { String(format: "%02x", $0) }.joined() }
    private func b64(_ b: [UInt8]) -> String { Data(b).base64EncodedString() }
    private func int(_ v: Any?) -> Int { (v as? NSNumber)?.intValue ?? 0 }
    private func str(_ v: Any?) -> String { v as? String ?? "" }

    func testScryptGivesTheSameKeyAsTheDesktop() throws {
        let cases = try load()["scrypt"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 2, "a fixture-ben van scrypt-vektor")
        for c in cases {
            let out = Scrypt.scrypt(
                password: Array(str(c["password"]).utf8), salt: Array(str(c["salt"]).utf8),
                n: int(c["n"]), r: int(c["r"]), p: int(c["p"]), dkLen: int(c["dkLen"])
            )
            XCTAssertEqual(hex(out), str(c["hex"]), "scrypt \(str(c["password"]))/\(str(c["salt"]))")
        }
    }

    func testTheRecoveryCodeNormalizesTheSameAsTheDesktop() throws {
        let cases = try load()["recoveryCodes"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 20, "a fixture-ben van elég kód-alak")
        for c in cases {
            let raw = str(c["raw"])
            XCTAssertEqual(SyncCrypto.normalizeRecoveryCode(raw), str(c["norm"]), "kód \(raw.debugDescription)")
        }
    }

    func testThePasswordLengthCountsTheSameAsTheDesktop() throws {
        let cases = try load()["passwords"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 10, "a fixture-ben van elég jelszó")
        for c in cases {
            let pw = str(c["password"])
            let n = SyncCrypto.passwordLength(pw)
            XCTAssertEqual(n, int(c["length"]), "hossz \(pw.debugDescription)")
            XCTAssertEqual(n >= SyncCrypto.minPasswordLength, c["ok"] as? Bool ?? false, "elég-e \(pw.debugDescription)")
        }
    }

    func testAKeyWrappedOnTheDesktopOpensHereAndItsBlobsRead() throws {
        let accounts = try load()["accounts"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(accounts.count, 4, "a fixture-ben van elég fiók")
        for a in accounts {
            let seed = int(a["seed"])
            let accountId = str(a["accountId"])
            let password = str(a["password"])
            let dataKey = str(a["dataKey"])
            let wrappedByPassword = str(a["wrappedByPassword"])
            // Egy scrypt fiókonként: a belépőkulcs és a kulcsburkoló ugyanabból a gyökérből jön.
            let root = try SyncCrypto.rootKey(password: password, accountId: accountId)
            XCTAssertEqual(b64(SyncCrypto.subKey(root, "auth")), str(a["authKey"]), "belépőkulcs, fiók \(seed)")
            XCTAssertEqual(
                b64(try SyncCrypto.unwrapDataKey(SyncCrypto.subKey(root, "kek"), wrappedByPassword)), dataKey,
                "jelszóval burkolt kulcs, fiók \(seed)"
            )
            for alt in a["passwordAlt"] as? [String] ?? [] {
                XCTAssertEqual(try SyncCrypto.authKey(password: alt, accountId: accountId), str(a["authKey"]),
                               "a jelszó másik alakja, fiók \(seed)")
            }
            if let wrong = a["wrongPassword"] as? String {
                XCTAssertThrowsError(
                    try SyncCrypto.unlockWithPassword(accountId: accountId, password: wrong, wrapped: wrappedByPassword),
                    "rossz jelszó, fiók \(seed)"
                )
            }
            let code = str(a["recoveryCode"])
            let wrappedByRecovery = str(a["wrappedByRecovery"])
            XCTAssertEqual(try SyncCrypto.recoveryAuthKey(code), str(a["recoveryAuthKey"]), "helyreállító belépőkulcs, fiók \(seed)")
            XCTAssertEqual(b64(try SyncCrypto.unlockWithRecovery(code: code, wrapped: wrappedByRecovery)), dataKey, "kód, fiók \(seed)")
            XCTAssertEqual(
                b64(try SyncCrypto.unlockWithRecovery(code: str(a["messyRecovery"]), wrapped: wrappedByRecovery)), dataKey,
                "kézzel írt kód, fiók \(seed)"
            )
            guard let keyData = Data(base64Encoded: dataKey) else { XCTFail("adatkulcs, fiók \(seed)"); continue }
            let key = Array(keyData)
            for (j, b) in (a["blobs"] as? [[String: Any]] ?? []).enumerated() {
                XCTAssertEqual(try SyncCrypto.decrypt(key, str(b["blob"])), str(b["text"]), "blob \(j), fiók \(seed)")
            }
            for bad in a["rejects"] as? [String] ?? [] {
                XCTAssertThrowsError(try SyncCrypto.decrypt(key, bad), "nyitni nem szabad: \(bad)")
            }
            // Amit itt zárunk, az itt nyílik — és a gép alakjában áll: négy rész, friss IV.
            let own = try SyncCrypto.encrypt(key, password)
            XCTAssertEqual(own.split(separator: ".").count, 4)
            XCTAssertNotEqual(own, try SyncCrypto.encrypt(key, password), "friss IV minden híváshoz")
            XCTAssertEqual(try SyncCrypto.decrypt(key, own), password)
        }
    }
}
