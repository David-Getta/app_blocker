import Foundation

/// PÁRBAN ZÁROLÁS: a lazítás végén egy MEGBÍZOTT jelmondata is kell — a
/// `desktop/src/shared/partner.ts` (és a segéd `partner-crypto.ts`) tükre,
/// ahogy Androidon a `Partner.kt`.
///
/// A próbatétel a saját impulzusod ellen véd; van, akinek az kell, hogy a
/// lazítás MÁS EMBER döntése is legyen. A megbízott egy jelmondatot kap, és
/// minden lazító próbatétel utolsó lépése az, hogy ő beírja. Felvenni ingyen
/// (szigorítás), levenni próbatétel — a végén az ő jelmondatával. A jelmondat
/// egy eszközön születik, és csak a lenyomata (scrypt, a fiók kulcsáé) marad
/// meg; a lenyomat nyelvfüggetlen, tehát a gépen felvett megbízott az
/// iPhone-on is stimmel — a `fixtures/partner-hash.json` ezt őrzi.
///
/// Őszinte határ: nem gépzár — az impulzus ellen véd, nem a szándék ellen.
///
/// `public`, mert a `FocusSync.SyncFocus` (ami maga is public) hordozza a
/// rekordot: egy public tulajdonság típusa nem lehet belső.
public enum PartnerLogic {

    /// A jelmondat szavainak száma — a próbatételek szólistájából.
    public static let partnerPhraseWords = 4
    /// A megbízott nevének hossza felülről kötve.
    public static let maxPartnerName = 40
    /// Ennyi rossz jelmondat után a kísérlet érvénytelen: elölről, minden lépéssel.
    public static let maxPartnerTries = 5

    private static let hashLen = 32
    private static let saltLen = 16

    /// Az scrypt költsége — a fiók kulcsáé (SyncCrypto), ez a valódi.
    static let fullCost = (n: SyncCrypto.scryptN, r: SyncCrypto.scryptR, p: SyncCrypto.scryptP)
    /// Amivel a lenyomat MOST számol. Nem dísz, és nem beállítás: a tesztek
    /// állítják át. A debug-fordítású scrypt a teljes költséggel hashenként
    /// fél percig is eltart, a bíró tesztjei pedig tucatnyit számolnak — a
    /// lenyomat egyezését a géppel EGY teljes költségű számolás őrzi (a
    /// fixture), a többi teszt a szabályt nézi, nem a költséget.
    static var scryptCost = fullCost

    public struct PartnerLock: Codable, Equatable {
        /// a megbízott neve, ahogy a felület mondja
        public let name: String
        /// a lenyomat sója, base64
        public let salt: String
        /// a jelmondat scrypt-lenyomata, base64 — a jelmondat maga sehol nincs
        public let hash: String
        /// mikor vették fel (ms)
        public let setAt: Double

        public init(name: String, salt: String, hash: String, setAt: Double) {
            self.name = name
            self.salt = salt
            self.hash = hash
            self.setAt = setAt
        }

        enum CodingKeys: String, CodingKey {
            case name
            case salt
            case hash
            case setAt
        }

        /// TŰRŐ dekódolás: egy hiányzó vagy rossz típusú mező üres értéket ad, és
        /// a `normalizeLock` dönti el, használható-e — nem a dekódoló dobja el a
        /// blobot. A `setAt` hiánya nulla, mint a gépen.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
            salt = (try? c.decodeIfPresent(String.self, forKey: .salt)) ?? ""
            hash = (try? c.decodeIfPresent(String.self, forKey: .hash)) ?? ""
            setAt = (try? c.decodeIfPresent(Double.self, forKey: .setAt)) ?? 0
        }
    }

    /// C0, DEL és C1 — ugyanaz a tartomány, mint a fedőnévnél.
    private static func isControl(_ ch: Character) -> Bool {
        guard let scalar = ch.unicodeScalars.first, ch.unicodeScalars.count == 1 else { return false }
        return scalar.value < 0x20 || (scalar.value >= 0x7f && scalar.value <= 0x9f)
    }

    /// NFKC, a vezérlők szóközre, a szóközök egyre, a szélek le.
    private static func clean(_ raw: String) -> String {
        let nfkc = raw.precomposedStringWithCompatibilityMapping
        let noControls = String(nfkc.map { isControl($0) ? " " : $0 })
        return noControls.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// A jelmondat KANONIKUS alakja — ezt hasoljuk, és ezt hasonlítjuk.
    /// Kis-nagybetű, dupla szóköz nem számít; NFKC, hogy ugyanaz a leütött
    /// szöveg ugyanaz a bájtsor legyen minden platformon.
    public static func normalizePhrase(_ raw: String) -> String {
        clean(raw).lowercased()
    }

    /// A megbízott neve tisztán — vagy nil, ha nem maradt belőle semmi.
    public static func normalizePartnerName(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let cleaned = clean(raw)
        if cleaned.isEmpty { return nil }
        return String(cleaned.prefix(maxPartnerName))
    }

    /// base64-nek látszik-e, a hossz a megadott sávban (mint a TS minta).
    private static func looksBase64(_ s: String, _ range: ClosedRange<Int>) -> Bool {
        let n = s.unicodeScalars.count
        guard range.contains(n) else { return false }
        return s.unicodeScalars.allSatisfy { u in
            (u.value >= 0x30 && u.value <= 0x39) || (u.value >= 0x41 && u.value <= 0x5a)
                || (u.value >= 0x61 && u.value <= 0x7a) || u == "+" || u == "/" || u == "="
        }
    }

    /// A tárból vagy a szinkronból jött rekord, ha jó alakú — különben semmi.
    public static func normalizeLock(name: String?, salt: String?, hash: String?, setAt: Double?) -> PartnerLock? {
        guard let n = normalizePartnerName(name) else { return nil }
        guard let salt, looksBase64(salt, 16...64) else { return nil }
        guard let hash, looksBase64(hash, 32...96) else { return nil }
        let at = setAt.flatMap { $0.isFinite ? $0 : nil } ?? 0
        return PartnerLock(name: n, salt: salt, hash: hash, setAt: at)
    }

    /// Egész szám, ahogy a gép és az Android írja — a Double „…0.0”-ja nem egyezne.
    private static func setAtText(_ v: Double) -> String {
        guard v.isFinite, abs(v) < 9_000_000_000_000_000 else { return "0" }
        return String(Int64(v))
    }

    /// A rekord tartalmi kulcsa a lenyomatokhoz és az összevetéshez.
    public static func partnerKey(_ p: PartnerLock?) -> String {
        guard let p else { return "" }
        return [p.salt, p.hash, p.name, setAtText(p.setAt)].joined(separator: "|")
    }

    /// Fésülés — a zárlat-ablakok mintája: nagyobb jel nyer; azonos jelnél a
    /// BEÁLLÍTOTT (a szigorúbb irány); ha mindkét oldalon van, a korábban
    /// felvett — az a régebbi ígéret.
    public static func merge(
        _ localRev: Int, _ local: PartnerLock?, _ incomingRev: Int, _ incoming: PartnerLock?
    ) -> PartnerLock? {
        if incomingRev > localRev { return incoming }
        if localRev > incomingRev { return local }
        if let l = local, let i = incoming { return l.setAt <= i.setAt ? l : i }
        return local ?? incoming
    }

    /// A jelmondat lenyomata egy adott sóval — base64; ugyanaz az scrypt, mint
    /// a fiók kulcsáé. Rossz alakú sóra nil.
    public static func hashPhrase(_ phrase: String, salt saltB64: String) -> String? {
        guard let salt = Data(base64Encoded: saltB64) else { return nil }
        let out = Scrypt.scrypt(
            password: Array(normalizePhrase(phrase).utf8), salt: [UInt8](salt),
            n: scryptCost.n, r: scryptCost.r, p: scryptCost.p, dkLen: hashLen
        )
        return Data(out).base64EncodedString()
    }

    /// Új megbízott: friss só, a jelmondat lenyomata — a jelmondat maga nem marad meg.
    public static func makeLock(name: String, phrase: String, now: Double) -> PartnerLock {
        // A rendszer véletlenje kriptográfiai minőségű (SystemRandomNumberGenerator).
        var bytes = [UInt8](repeating: 0, count: saltLen)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        let salt = Data(bytes).base64EncodedString()
        return PartnerLock(name: name, salt: salt, hash: hashPhrase(phrase, salt: salt) ?? "", setAt: now)
    }

    /// Ez-e a jelmondat — állandó idejű összevetéssel.
    public static func verify(_ lock: PartnerLock, _ phrase: String) -> Bool {
        if normalizePhrase(phrase).isEmpty { return false }
        guard let gotB64 = hashPhrase(phrase, salt: lock.salt),
              let got = Data(base64Encoded: gotB64),
              let want = Data(base64Encoded: lock.hash),
              got.count == want.count
        else { return false }
        var diff: UInt8 = 0
        for (a, b) in zip(got, want) { diff |= a ^ b }
        return diff == 0
    }
}
