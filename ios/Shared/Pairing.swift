import Foundation

/// Párosító kód — a `desktop/src/shared/sync/pairing.ts` tükre.
///
/// MIÉRT LÉTEZIK. A szinkronhoz eddig be kellett gépelni egy címet, például
/// `http://192.168.1.10:8787`. Papíron egy sor, a gyakorlatban viszont az a
/// pont, ahol a funkció meghal: aki idáig eljut, ott feladja. Egy
/// önkontroll-app legfontosabb tulajdonsága, hogy tényleg használják — egy
/// technikailag tökéletes szinkron, amit senki nem kapcsol be, nulla értékű.
///
///     http://192.168.1.10:8787   ->   00GMR      (öt karakter)
///
/// A rövidség nem trükk: a valóságban a címek nem véletlenszerűek. Otthoni
/// hálózaton szinte mindig 192.168.x.y vagy 10.x.y.z, a port pedig a miénk.
///
/// Minden bitnek egyeznie kell a TypeScript és a Kotlin változattal: ha eltér,
/// a gépen kiírt kód itt nem nyílik ki — vagy ami rosszabb, MÁS címet ad.
enum Pairing {

    /// Crockford base32: nincs benne I, L, O és U. Az I/1 és az O/0 kézzel
    /// másolva összekeverhető; a beolvasásnál egy helyre esnek.
    private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// A kiszolgáló alapértelmezett portja. Ha ez van, nem kerül a kódba.
    static let defaultPort = 8787

    private static let maxCodeChars = 12

    private static func push(_ bits: inout [Int], _ value: Int, _ width: Int) {
        var i = width - 1
        while i >= 0 {
            bits.append((value >> i) & 1)
            i -= 1
        }
    }

    private static func read(_ bits: [Int], _ at: Int, _ width: Int) -> Int {
        var out = 0
        for i in 0..<width {
            out = out * 2 + (at + i < bits.count ? bits[at + i] : 0)
        }
        return out
    }

    /// Ötbites ellenőrző összeg (FNV-1a).
    ///
    /// Enélkül egy elgépelt karakterből MÁSIK, létező cím lenne, és a
    /// felhasználó csak annyit látna, hogy a kiszolgáló nem érhető el.
    private static func checksum(_ bits: [Int]) -> Int {
        var h: UInt32 = 0x811c9dc5
        for b in bits {
            h ^= UInt32(b)
            h = h &* 0x01000193
        }
        return Int(h & 31)
    }

    private static func parseIPv4(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var out: [Int] = []
        for p in parts {
            guard !p.isEmpty, p.count <= 3, p.allSatisfy({ $0.isNumber }),
                  let n = Int(p), n <= 255 else { return nil }
            out.append(n)
        }
        return out
    }

    /// Cím -> párosító kód, vagy nil (tartománynév és HTTPS nem kódolható).
    static func encode(_ url: String) -> String? {
        let trimmed = url.trimmingCharacters(in: .whitespaces)
        guard let re = try? NSRegularExpression(
            pattern: "^http://([0-9.]+)(?::([0-9]+))?/?$", options: [.caseInsensitive]
        ) else { return nil }
        let ns = trimmed as NSString
        guard let m = re.firstMatch(in: trimmed, range: NSRange(location: 0, length: ns.length)) else {
            return nil
        }
        guard let ip = parseIPv4(ns.substring(with: m.range(at: 1))) else { return nil }
        var port = defaultPort
        if m.range(at: 2).location != NSNotFound {
            guard let p = Int(ns.substring(with: m.range(at: 2))) else { return nil }
            port = p
        }
        guard port >= 1, port <= 65535 else { return nil }

        var bits: [Int] = []
        let tag: Int
        if ip[0] == 192 && ip[1] == 168 { tag = 0 }
        else if ip[0] == 10 { tag = 1 }
        else if ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31 { tag = 2 }
        else { tag = 3 }

        push(&bits, tag, 2)
        push(&bits, port == defaultPort ? 0 : 1, 1)
        if port != defaultPort { push(&bits, port, 16) }

        switch tag {
        case 0: push(&bits, ip[2], 8); push(&bits, ip[3], 8)
        case 1: push(&bits, ip[1], 8); push(&bits, ip[2], 8); push(&bits, ip[3], 8)
        case 2: push(&bits, ip[1] - 16, 4); push(&bits, ip[2], 8); push(&bits, ip[3], 8)
        default: for n in ip { push(&bits, n, 8) }
        }

        push(&bits, checksum(bits), 5)
        while bits.count % 5 != 0 { bits.append(0) }

        var out = ""
        var i = 0
        while i < bits.count {
            out.append(alphabet[read(bits, i, 5)])
            i += 5
        }
        return out
    }

    /// Beírt szöveg -> kiszolgáló-cím, vagy nil.
    static func decode(_ input: String) -> String? {
        var clean = ""
        for ch in input.uppercased() where ch.isNumber || (ch.isLetter && ch.isASCII) {
            switch ch {
            case "O": clean.append("0")
            case "I", "L": clean.append("1")
            default: clean.append(ch)
            }
        }
        guard !clean.isEmpty, clean.count <= maxCodeChars else { return nil }

        var bits: [Int] = []
        for ch in clean {
            guard let v = alphabet.firstIndex(of: ch) else { return nil }
            var i = 4
            while i >= 0 {
                bits.append((v >> i) & 1)
                i -= 1
            }
        }
        guard bits.count >= 8 else { return nil }

        let tag = read(bits, 0, 2)
        let explicitPort = bits[2] == 1
        var at = 3
        var port = defaultPort
        if explicitPort {
            guard bits.count >= at + 16 else { return nil }
            port = read(bits, at, 16)
            at += 16
            guard port >= 1 else { return nil }
        }

        let payloadWidth: Int
        switch tag {
        case 0: payloadWidth = 16
        case 1: payloadWidth = 24
        case 2: payloadWidth = 20
        default: payloadWidth = 32
        }
        guard bits.count >= at + payloadWidth + 5 else { return nil }

        var ip: [Int] = []
        switch tag {
        case 0: ip = [192, 168, read(bits, at, 8), read(bits, at + 8, 8)]
        case 1: ip = [10, read(bits, at, 8), read(bits, at + 8, 8), read(bits, at + 16, 8)]
        case 2: ip = [172, 16 + read(bits, at, 4), read(bits, at + 4, 8), read(bits, at + 12, 8)]
        default: ip = (0..<4).map { read(bits, at + $0 * 8, 8) }
        }
        at += payloadWidth

        guard read(bits, at, 5) == checksum(Array(bits[0..<at])) else { return nil }
        at += 5

        // A maradék CSAK nulla lehet, és legfeljebb négy bit — különben a kód
        // hosszabb, mint amennyi információt hordoz, tehát nem tőlünk származik.
        guard bits.count - at <= 4 else { return nil }
        for i in at..<bits.count where bits[i] != 0 { return nil }

        return "http://\(ip.map(String.init).joined(separator: ".")):\(port)"
    }

    /// Amit a felhasználó a mezőbe írt -> használható cím.
    ///
    /// Egy mező, kétféle bemenet. Külön mező azt jelentené, hogy előbb el kell
    /// dönteni, melyikbe kell írni — pont az a fajta apró döntés, amitől
    /// abbahagyják.
    static func resolveServerInput(_ input: String) -> String? {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return nil }
        let lower = raw.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") { return raw }
        if let fromCode = decode(raw) { return fromCode }
        let hostLike = raw.allSatisfy { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == ":" }
        if hostLike { return "http://\(raw)" }
        return nil
    }

    /// Ahogy a felületen áll: négyes csoportokban, olvashatóan.
    static func format(_ code: String) -> String {
        var out = ""
        for (i, ch) in code.enumerated() {
            if i > 0 && i % 4 == 0 { out.append("-") }
            out.append(ch)
        }
        return out
    }
}
