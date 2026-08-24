import Foundation
import CryptoKit

/// scrypt (RFC 7914) — tiszta Swiftben.
///
/// Miért nem könyvtárból: a CryptoKitben nincs scrypt, és a CommonCryptóban sem.
/// A jelszóból származó kulcsnak viszont PONTOSAN ugyanannak kell kijönnie
/// iPhone-on, Androidon és gépen: ha eltér, a másik eszközön nem lehet belépni
/// ugyanabba a fiókba. Ezért van itt saját, az RFC vektoraival és a másik két
/// mag kimenetével is összevetett megvalósítás.
///
/// A memóriakötöttség a lényeg: a `V` tömb N * 128 * r bájt (a mi
/// paramétereinkkel 32 MB). Ez teszi drágává a jelszó tömeges kitalálását annak,
/// aki a kiszolgálóra betört — pont ezért nem cseréljük valami olcsóbbra.
enum Scrypt {

    static func scrypt(
        password: [UInt8], salt: [UInt8], n: Int, r: Int, p: Int, dkLen: Int
    ) -> [UInt8] {
        precondition(n > 1 && (n & (n - 1)) == 0, "N kettőhatvány és 1-nél nagyobb kell legyen")
        precondition(r >= 1 && p >= 1, "r és p legalább 1")
        precondition(dkLen > 0, "a kért kulcshossz pozitív")

        let blockLen = 128 * r
        var b = pbkdf2(password: password, salt: salt, iterations: 1, dkLen: p * blockLen)
        var v = [UInt32](repeating: 0, count: n * 32 * r)
        var y = [UInt32](repeating: 0, count: 64 * r)
        var words = [UInt32](repeating: 0, count: 32 * r)

        for i in 0..<p {
            bytesToWords(b, i * blockLen, &words, 32 * r)
            roMix(&words, &v, &y, n, r)
            wordsToBytes(words, &b, i * blockLen, 32 * r)
        }
        return pbkdf2(password: password, salt: b, iterations: 1, dkLen: dkLen)
    }

    // MARK: - ROMix

    private static func roMix(
        _ x: inout [UInt32], _ v: inout [UInt32], _ y: inout [UInt32], _ n: Int, _ r: Int
    ) {
        let len = 32 * r
        for i in 0..<n {
            for k in 0..<len { v[i * len + k] = x[k] }
            blockMix(&x, &y, r)
        }
        for _ in 0..<n {
            // Integerify: az UTOLSÓ 64 bájtos blokk első szava, little-endian.
            let j = Int(x[len - 16]) & (n - 1)
            for k in 0..<len { x[k] ^= v[j * len + k] }
            blockMix(&x, &y, r)
        }
    }

    private static func blockMix(_ b: inout [UInt32], _ y: inout [UInt32], _ r: Int) {
        var x = [UInt32](repeating: 0, count: 16)
        for k in 0..<16 { x[k] = b[(2 * r - 1) * 16 + k] }
        for i in 0..<(2 * r) {
            for k in 0..<16 { x[k] ^= b[i * 16 + k] }
            salsa20_8(&x)
            for k in 0..<16 { y[i * 16 + k] = x[k] }
        }
        // Az eredmény sorrendje: Y0, Y2, …, Y1, Y3, …
        for i in 0..<r {
            for k in 0..<16 {
                b[i * 16 + k] = y[(i * 2) * 16 + k]
                b[(i + r) * 16 + k] = y[(i * 2 + 1) * 16 + k]
            }
        }
    }

    private static func salsa20_8(_ block: inout [UInt32]) {
        var x = block
        var i = 0
        while i < 8 {
            // oszlopkör
            x[4] ^= rotl(x[0] &+ x[12], 7);   x[8] ^= rotl(x[4] &+ x[0], 9)
            x[12] ^= rotl(x[8] &+ x[4], 13);  x[0] ^= rotl(x[12] &+ x[8], 18)
            x[9] ^= rotl(x[5] &+ x[1], 7);    x[13] ^= rotl(x[9] &+ x[5], 9)
            x[1] ^= rotl(x[13] &+ x[9], 13);  x[5] ^= rotl(x[1] &+ x[13], 18)
            x[14] ^= rotl(x[10] &+ x[6], 7);  x[2] ^= rotl(x[14] &+ x[10], 9)
            x[6] ^= rotl(x[2] &+ x[14], 13);  x[10] ^= rotl(x[6] &+ x[2], 18)
            x[3] ^= rotl(x[15] &+ x[11], 7);  x[7] ^= rotl(x[3] &+ x[15], 9)
            x[11] ^= rotl(x[7] &+ x[3], 13);  x[15] ^= rotl(x[11] &+ x[7], 18)
            // sorkör
            x[1] ^= rotl(x[0] &+ x[3], 7);    x[2] ^= rotl(x[1] &+ x[0], 9)
            x[3] ^= rotl(x[2] &+ x[1], 13);   x[0] ^= rotl(x[3] &+ x[2], 18)
            x[6] ^= rotl(x[5] &+ x[4], 7);    x[7] ^= rotl(x[6] &+ x[5], 9)
            x[4] ^= rotl(x[7] &+ x[6], 13);   x[5] ^= rotl(x[4] &+ x[7], 18)
            x[11] ^= rotl(x[10] &+ x[9], 7);  x[8] ^= rotl(x[11] &+ x[10], 9)
            x[9] ^= rotl(x[8] &+ x[11], 13);  x[10] ^= rotl(x[9] &+ x[8], 18)
            x[12] ^= rotl(x[15] &+ x[14], 7); x[13] ^= rotl(x[12] &+ x[15], 9)
            x[14] ^= rotl(x[13] &+ x[12], 13); x[15] ^= rotl(x[14] &+ x[13], 18)
            i += 2
        }
        for k in 0..<16 { block[k] = block[k] &+ x[k] }
    }

    private static func rotl(_ v: UInt32, _ n: UInt32) -> UInt32 {
        (v << n) | (v >> (32 - n))
    }

    // MARK: - PBKDF2
    //
    // Kézzel, mert a CommonCrypto PBKDF2-je a jelszót C-sztringként kéri.
    // Nekünk NYERS bájtok kellenek: a második hívásban a „jelszó” helyén a
    // scrypt köztes állapota áll, ami nem szöveg — és nullát is tartalmazhat.

    private static func pbkdf2(
        password: [UInt8], salt: [UInt8], iterations: Int, dkLen: Int
    ) -> [UInt8] {
        let hLen = 32
        var out = [UInt8]()
        out.reserveCapacity(dkLen)
        var i: UInt32 = 1
        while out.count < dkLen {
            var message = salt
            message.append(contentsOf: [
                UInt8((i >> 24) & 0xff), UInt8((i >> 16) & 0xff),
                UInt8((i >> 8) & 0xff), UInt8(i & 0xff),
            ])
            var u = hmac(key: password, message: message)
            var t = u
            if iterations > 1 {
                for _ in 1..<iterations {
                    u = hmac(key: password, message: u)
                    for k in 0..<hLen { t[k] ^= u[k] }
                }
            }
            out.append(contentsOf: t)
            i += 1
        }
        return Array(out.prefix(dkLen))
    }

    static func hmac(key: [UInt8], message: [UInt8]) -> [UInt8] {
        // A CryptoKit `SymmetricKey`-je üres kulcsot is elfogad, tehát az RFC
        // első vektora (üres jelszó) is lefuttatható vele.
        let mac = HMAC<SHA256>.authenticationCode(
            for: Data(message), using: SymmetricKey(data: Data(key))
        )
        return Array(mac)
    }

    // MARK: - bájt/szó

    private static func bytesToWords(
        _ src: [UInt8], _ srcOff: Int, _ dst: inout [UInt32], _ count: Int
    ) {
        for i in 0..<count {
            let o = srcOff + i * 4
            dst[i] = UInt32(src[o]) | (UInt32(src[o + 1]) << 8)
                | (UInt32(src[o + 2]) << 16) | (UInt32(src[o + 3]) << 24)
        }
    }

    private static func wordsToBytes(
        _ src: [UInt32], _ dst: inout [UInt8], _ dstOff: Int, _ count: Int
    ) {
        for i in 0..<count {
            let v = src[i]
            let o = dstOff + i * 4
            dst[o] = UInt8(v & 0xff)
            dst[o + 1] = UInt8((v >> 8) & 0xff)
            dst[o + 2] = UInt8((v >> 16) & 0xff)
            dst[o + 3] = UInt8((v >> 24) & 0xff)
        }
    }
}
