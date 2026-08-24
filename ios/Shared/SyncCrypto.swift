import Foundation
import CryptoKit

/// Végpontok közti titkosítás a szinkronhoz — a
/// `desktop/src/shared/sync/crypto.ts` tükre.
///
/// A kiszolgáló NEM TUDJA ELOLVASNI, amit tárol:
///
///   jelszó ──scrypt(só = fiókazonosító)──> gyökér
///                                            ├── HKDF("auth") ─> belépőkulcs ─> a kiszolgálóra megy
///                                            └── HKDF("kek") ──> kulcsburkoló ─> ezzel van becsomagolva az ADATKULCS
///
/// Minden bájtnak egyeznie kell a másik két maggal: ha eltér, ezen az eszközön
/// nem lehet belépni abba a fiókba, amit a gépen vagy a telefonon hoztak létre.
enum SyncCrypto {

    static let blobPrefix = "brk1"

    /// scrypt-paraméterek — ugyanazok, mint a TS és a Kotlin oldalon.
    static let scryptN = 1 << 15
    static let scryptR = 8
    static let scryptP = 1

    private static let keyLen = 32

    enum SyncCryptoError: Error {
        case badFormat
        case badKeySize
        case shortRecoveryCode
        case emptyPassword
    }

    /// A jelszóból származó gyökér. A só a fiókazonosító, hogy két fiók ne essen egybe.
    static func rootKey(password: String, accountId: String) throws -> [UInt8] {
        if password.isEmpty { throw SyncCryptoError.emptyPassword }
        // precomposedStringWithCompatibilityMapping = NFKC. Ugyanaz a leütött
        // szöveg ugyanaz a bájtsor legyen minden platformon; ékezetes jelszónál
        // ez nem elmélet.
        let normalized = password.precomposedStringWithCompatibilityMapping
        return Scrypt.scrypt(
            password: Array(normalized.utf8),
            salt: Array("breaker:\(accountId)".utf8),
            n: scryptN, r: scryptR, p: scryptP, dkLen: keyLen
        )
    }

    /// Egy gyökérből több, egymástól független alkulcs (HKDF-SHA256).
    static func subKey(_ root: [UInt8], _ label: String) -> [UInt8] {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: Data(root)),
            salt: Data(),
            info: Data("breaker-\(label)-v1".utf8),
            outputByteCount: keyLen
        )
        return key.withUnsafeBytes { Array($0) }
    }

    static func authKey(password: String, accountId: String) throws -> String {
        Data(subKey(try rootKey(password: password, accountId: accountId), "auth")).base64EncodedString()
    }

    /// Belépőkulcs a helyreállító kódból — külön ág, hogy elfelejtett jelszóval is legyen út.
    static func recoveryAuthKey(_ code: String) throws -> String {
        Data(subKey(try recoveryMaterial(code), "recovery-auth")).base64EncodedString()
    }

    static func recoveryKey(_ code: String) throws -> [UInt8] {
        subKey(try recoveryMaterial(code), "recovery")
    }

    private static func recoveryMaterial(_ code: String) throws -> [UInt8] {
        let norm = normalizeRecoveryCode(code)
        if norm.count < 16 { throw SyncCryptoError.shortRecoveryCode }
        return Array(norm.utf8)
    }

    /// A kód beírásakor a kötőjelek és a kis-nagybetű ne számítson.
    static func normalizeRecoveryCode(_ code: String) -> String {
        String(code.uppercased().compactMap { ch -> Character? in
            switch ch {
            case "O": return "0"
            case "I", "L": return "1"
            case "0"..."9", "A"..."Z": return ch
            default: return nil
            }
        })
    }

    // MARK: - titkosítás

    /// AES-256-GCM. A kimenet: `brk1.<iv>.<tag>.<titkos>` base64url darabokból.
    ///
    /// Minden híváshoz FRISS véletlen IV: GCM-nél egy IV újrahasználata ugyanazzal
    /// a kulccsal nem „gyengébb titkosítás”, hanem a kulcs eldobása. A CryptoKit
    /// magától generál újat, ha nem adunk meg — épp ezt akarjuk.
    static func encrypt(_ key: [UInt8], _ plaintext: String) throws -> String {
        let sealed = try AES.GCM.seal(Data(plaintext.utf8), using: SymmetricKey(data: Data(key)))
        return [
            blobPrefix,
            b64url(Data(sealed.nonce)),
            b64url(sealed.tag),
            b64url(sealed.ciphertext),
        ].joined(separator: ".")
    }

    /// Visszafejtés. Hibás kulcsnál, csonka vagy MEGHAMISÍTOTT bloboknál dob.
    ///
    /// A GCM-címke ellenőrzése nem opcionális: enélkül a kiszolgáló (vagy aki a
    /// helyére áll) bitenként babrálhatna a blokklistán úgy, hogy észre se vesszük.
    static func decrypt(_ key: [UInt8], _ blob: String) throws -> String {
        let parts = blob.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 4, parts[0] == blobPrefix,
              let iv = unb64url(parts[1]), let tag = unb64url(parts[2]),
              let ct = unb64url(parts[3]), iv.count == 12, tag.count == 16
        else { throw SyncCryptoError.badFormat }
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ct, tag: tag)
        let out = try AES.GCM.open(box, using: SymmetricKey(data: Data(key)))
        guard let text = String(data: out, encoding: .utf8) else { throw SyncCryptoError.badFormat }
        return text
    }

    static func wrapDataKey(_ kek: [UInt8], _ dataKey: [UInt8]) throws -> String {
        try encrypt(kek, Data(dataKey).base64EncodedString())
    }

    static func unwrapDataKey(_ kek: [UInt8], _ wrapped: String) throws -> [UInt8] {
        guard let raw = Data(base64Encoded: try decrypt(kek, wrapped)), raw.count == keyLen else {
            throw SyncCryptoError.badKeySize
        }
        return Array(raw)
    }

    static func unlockWithPassword(
        accountId: String, password: String, wrapped: String
    ) throws -> [UInt8] {
        try unwrapDataKey(subKey(try rootKey(password: password, accountId: accountId), "kek"), wrapped)
    }

    static func unlockWithRecovery(code: String, wrapped: String) throws -> [UInt8] {
        try unwrapDataKey(try recoveryKey(code), wrapped)
    }

    /// Helyreállító kód: 160 véletlen bit, nyolc négyes csoportban (Crockford base32).
    static func newRecoveryCode() -> String {
        var bytes = [UInt8](repeating: 0, count: 20)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        var acc = 0
        var bits = 0
        var out = ""
        for b in bytes {
            acc = (acc << 8) | Int(b)
            bits += 8
            while bits >= 5 {
                out.append(alphabet[(acc >> (bits - 5)) & 31])
                bits -= 5
            }
        }
        return stride(from: 0, to: out.count, by: 4).map { i -> String in
            let start = out.index(out.startIndex, offsetBy: i)
            let end = out.index(start, offsetBy: min(4, out.count - i))
            return String(out[start..<end])
        }.joined(separator: "-")
    }

    static func newDataKey() -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: keyLen)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes
    }

    // MARK: - base64url
    //
    // A `Data(base64Encoded:)` csak a szabványos ábécét ismeri; a blobok viszont
    // base64url-t használnak (a TS `base64url` kimenete), tehát oda-vissza kell
    // fordítani. Kitöltés nélkül, ahogy a másik két mag is adja.

    private static func b64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func unb64url(_ text: String) -> Data? {
        var s = text.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s.append("=") }
        return Data(base64Encoded: s)
    }
}
