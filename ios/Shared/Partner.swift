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

    /// NFKC, a vezérlők szóközre, a szóközök egyre, a szélek le. A szóköz a
    /// kimondott készlet (TextLogic), nem a Swift `isWhitespace`-e: a jelmondatba
    /// került BOM a gépen szóköz, itt nem lett volna — a lenyomat nem egyezik.
    private static func clean(_ raw: String) -> String {
        TextLogic.collapseSpaces(raw.precomposedStringWithCompatibilityMapping)
    }

    /// A jelmondat KANONIKUS alakja — ezt hasoljuk, és ezt hasonlítjuk.
    /// Kis-nagybetű, dupla szóköz nem számít; NFKC, hogy ugyanaz a leütött
    /// szöveg ugyanaz a bájtsor legyen minden platformon.
    public static func normalizePhrase(_ raw: String) -> String {
        // A kisbetű is a gép szabálya szerint: a görög szó végi szigma ς, nem σ —
        // különben a lenyomat nem egyezne a gépével.
        TextLogic.lowercase(clean(raw))
    }

    /// A megbízott neve tisztán — vagy nil, ha nem maradt belőle semmi.
    public static func normalizePartnerName(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let cleaned = clean(raw)
        if cleaned.isEmpty { return nil }
        // Skalárban, mint a gép és az Android: a `prefix` grafémát számolt volna.
        // A vágás szóköz elé eshet; a lógó szóköz nélkül.
        return TextLogic.trimSpaces(TextLogic.takeScalars(cleaned, maxPartnerName))
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

    /// Ennél több élő megbízott nem lehet egyszerre — a `partner.ts` `MAX_PARTNERS`-e.
    public static let maxPartners = 8
    /// Ennyi levett megbízott nyomát hordozzuk — a legutóbb levettekét.
    public static let maxPartnersGone = 32
    /// A legnagyobb egész, amit a gép is pontosan lát (2^53 − 1).
    private static let maxSafe: Double = 9_007_199_254_740_991

    /// A megbízott AZONOSSÁGA: a só és a lenyomat — minden felvételnél új.
    public static func partnerId(_ p: PartnerLock) -> String { "\(p.salt)|\(p.hash)" }

    /// Jó alakú-e egy levett megbízott azonossága (só|lenyomat).
    public static func isGoneId(_ id: String) -> Bool {
        let parts = id.split(separator: "|", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return false }
        return looksBase64(String(parts[0]), 16...64) && looksBase64(String(parts[1]), 32...96)
    }

    /// Egy levett megbízott nyoma: az azonossága, és mikor vették le (csak a plafon sorrendjéhez).
    public struct PartnerGone: Codable, Equatable {
        /// a levett megbízott azonossága (`partnerId`: só|lenyomat)
        public let id: String
        /// mikor vették le (ms) — csak a plafon sorrendjéhez, a biztonság nem múlik rajta
        public let at: Double

        public init(id: String, at: Double) {
            self.id = id
            self.at = at
        }

        enum CodingKeys: String, CodingKey {
            case id
            case at
        }

        /// TŰRŐ dekódolás: a rossz azonosságú nyomot a `cleanPartnersGone` ejti
        /// ki; a rossz időpont nulla, mint a gépen.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = c.lenient(String.self, .id) ?? ""
            at = c.lenient(Double.self, .at) ?? 0
        }
    }

    /// A megbízottak egy eszközön: a FŐ (a legkorábban felvett), a TÁRSAK, és a levettek nyoma.
    public struct PartnerSet: Equatable {
        public var partner: PartnerLock?
        public var partnerCo: [PartnerLock]
        public var partnersGone: [PartnerGone]

        public init(partner: PartnerLock? = nil, partnerCo: [PartnerLock] = [], partnersGone: [PartnerGone] = []) {
            self.partner = partner
            self.partnerCo = partnerCo
            self.partnersGone = partnersGone
        }
    }

    /// Az összes élő megbízott: a fő, aztán a társak.
    public static func livePartners(_ s: PartnerSet) -> [PartnerLock] {
        (s.partner.map { [$0] } ?? []) + s.partnerCo
    }

    /// A nyom időpontja: csak nemnegatív, pontos egész (a gép `Number.isSafeInteger`-e) — különben 0.
    static func goneAt(_ v: Double) -> Double {
        v.isFinite && v >= 0 && v <= maxSafe && v == v.rounded(.down) ? v : 0
    }

    /// A levett megbízottak nyoma tisztán: jó alakú azonosság, egyszer (a később
    /// levett időpontjával), a legutóbb levettek elöl, a plafonig — a gép
    /// `cleanPartnersGone`-ja. A rendezés kódegységre, mint a gépen.
    public static func cleanPartnersGone(_ raw: [PartnerGone]) -> [PartnerGone] {
        var at: [String: Double] = [:]
        for g in raw where isGoneId(g.id) {
            at[g.id] = max(at[g.id] ?? 0, goneAt(g.at))
        }
        let sorted = at.map { PartnerGone(id: $0.key, at: $0.value) }.sorted { x, y in
            x.at != y.at ? x.at > y.at : TextLogic.utf16Less(x.id, y.id)
        }
        return Array(sorted.prefix(maxPartnersGone))
    }

    /// A megbízottak fésülése — AZONOSSÁG szerint, nem jel szerint; a gép
    /// `mergePartners`-ének tükre. Élő megbízottat csak a NYOMA visz el (az pedig
    /// csak a levétel próbatételéből születik, aminek a végén az ő jelmondata
    /// állt); két különböző élő megbízott közül egyik sem esik ki: a legkorábban
    /// felvett a fő, a többi TÁRS, és a lazítás végén mindegyik jelmondata kell.
    /// Eddig a nagyobb jel nyert — és egy friss eszközön, felhúzott jellel
    /// felvett saját megbízott minden eszközön leváltotta a valódit.
    public static func mergePartners(_ a: PartnerSet, _ b: PartnerSet) -> PartnerSet {
        let both = a.partnersGone + b.partnersGone
        let allGone = cleanPartnersGone(both)
        // A nyom a plafon ELŐTT öl: ami ebben a fésülésben levett, az nem él.
        let dead = Set(both.filter { isGoneId($0.id) }.map { $0.id })
        var byId: [String: PartnerLock] = [:]
        for p in livePartners(a) + livePartners(b) {
            let id = partnerId(p)
            if dead.contains(id) { continue }
            if let had = byId[id], !TextLogic.utf16Less(partnerKey(p), partnerKey(had)) { continue }
            byId[id] = p
        }
        let live = byId.values.sorted { x, y in
            x.setAt != y.setAt ? x.setAt < y.setAt : TextLogic.utf16Less(partnerId(x), partnerId(y))
        }.prefix(maxPartners)
        return PartnerSet(partner: live.first, partnerCo: Array(live.dropFirst()), partnersGone: allGone)
    }

    /// A kívülről (dróton vagy lemezről) jött megbízottak: a fő, a társak és a
    /// nyomok — a gép `partnersIn`-je: a rossz alakú kiesik, a fővel egyező társ
    /// is, és a fésülés szabálya rendezi (a nyommal levett nem él, a fő a
    /// legkorábban felvett). Egy régi kliens blobjában csak a fő van.
    public static func cleanSet(partner: PartnerLock?, partnerCo: [PartnerLock], partnersGone: [PartnerGone]) -> PartnerSet {
        func lock(_ p: PartnerLock) -> PartnerLock? {
            normalizeLock(name: p.name, salt: p.salt, hash: p.hash, setAt: p.setAt)
        }
        let main = partner.flatMap(lock)
        let co = partnerCo.compactMap(lock).filter { p in main.map { partnerId(p) != partnerId($0) } ?? true }
        return mergePartners(
            PartnerSet(partner: main, partnerCo: co, partnersGone: cleanPartnersGone(partnersGone)), PartnerSet()
        )
    }

    /// A megbízottak a levétel után: akiknek a jelmondata ebben a próbatételben
    /// elhangzott (`ids`), azok nyomot kapnak és kiesnek; aki közben érkezett,
    /// és nem bólintott, marad.
    public static func removePartners(_ s: PartnerSet, ids: [String], at: Double) -> PartnerSet {
        let t = at.isFinite ? max(0, at.rounded(.down)) : 0
        var next = s
        next.partnersGone = s.partnersGone + ids.map { PartnerGone(id: $0, at: t) }
        return mergePartners(next, PartnerSet())
    }

    /// A megbízottak tartalmi kulcsa. Társ és nyom nélkül PONTOSAN a régi
    /// (`partnerKey`): a frissítés után a lenyomat nem változik.
    public static func partnersKey(_ s: PartnerSet) -> String {
        if s.partnerCo.isEmpty && s.partnersGone.isEmpty { return partnerKey(s.partner) }
        return ([partnerKey(s.partner)] + s.partnerCo.map { partnerKey($0) }).joined(separator: ";")
            + "#" + s.partnersGone.map { "\($0.id)@\(setAtText($0.at))" }.joined(separator: ";")
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
