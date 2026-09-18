import Foundation

/// KULCSSZÓ-SZABÁLYOK: bármely oldalon, ha a cím tartalmazza — a
/// `desktop/src/shared/keywords.ts` tükre, ahogy Androidon a `Keywords.kt`.
///
/// Érvényesíteni csak a gépi böngésző-bővítmény tudja (csak ő látja a teljes
/// címet); az iPhone hordozza és fésüli, hogy a lista minden gépen ugyanaz
/// legyen. Felvenni ingyen, levenni próbatétel; a fésülés a zárlat-ablakoké:
/// a jel dönt, azonos jelnél a bővebb lista. Ha itt változtatsz, a TS és a
/// Kotlin ikren is.
public enum KeywordLogic {

    /// Legfeljebb ennyi kulcsszó.
    public static let maxKeywords = 40
    /// Egy kulcsszó hossza felülről.
    public static let maxKeywordLength = 40
    /// …és alulról: egy-két betű mindenre illeszkedne.
    public static let minKeywordLength = 3
    /// Javaslatok egy koppintásra — a gépi lista tükre; ami fent van, nem kínáljuk újra.
    public static let suggestions = ["shorts", "reels", "live", "stream"]

    /// C0, DEL és C1 — ugyanaz a tartomány, mint a fedőnévnél.
    private static func isControl(_ ch: Character) -> Bool {
        guard let scalar = ch.unicodeScalars.first, ch.unicodeScalars.count == 1 else { return false }
        return scalar.value < 0x20 || (scalar.value >= 0x7f && scalar.value <= 0x9f)
    }

    /// Egy kulcsszó kanonikus alakja — vagy nil, ha nem az.
    public static func normalizeKeyword(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let nfkc = raw.precomposedStringWithCompatibilityMapping
        let noControls = String(nfkc.map { isControl($0) ? " " : $0 })
        let cleaned = noControls.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if cleaned.isEmpty || cleaned.contains(where: { $0.isWhitespace }) { return nil }
        let len = cleaned.unicodeScalars.count
        if len < minKeywordLength || len > maxKeywordLength { return nil }
        return cleaned
    }

    /// Egy lista tisztán: csak az érvényes, egyszer, a plafonig.
    public static func cleanKeywords(_ raw: [String]) -> [String] {
        var out: [String] = []
        for item in raw {
            guard let k = normalizeKeyword(item) else { continue }
            if out.contains(k) { continue }
            if out.count >= maxKeywords { break }
            out.append(k)
        }
        return out
    }

    /// A lista tartalmi kulcsa — rendezve: a sorrend nem jelentés.
    public static func keywordsKey(_ list: [String]) -> String {
        list.sorted().joined(separator: "|")
    }

    /// Ugyanaz a két lista tartalom szerint.
    public static func sameKeywords(_ a: [String], _ b: [String]) -> Bool {
        keywordsKey(cleanKeywords(a)) == keywordsKey(cleanKeywords(b))
    }

    /// Lazítás-e a csere: ha a mostaniból bármi hiányzik az újból.
    public static func isKeywordsLoosening(_ current: [String], _ next: [String]) -> Bool {
        let have = Set(cleanKeywords(next))
        return cleanKeywords(current).contains { !have.contains($0) }
    }

    /// Két lista fésülve a jelük szerint: nagyobb jel nyer, azonos jelnél az unió.
    public static func mergeKeywords(
        _ localMark: Int, _ local: [String], _ incomingMark: Int, _ incoming: [String]
    ) -> [String] {
        if localMark > incomingMark { return cleanKeywords(local) }
        if incomingMark > localMark { return cleanKeywords(incoming) }
        return cleanKeywords(local + incoming)
    }

    /// A cím szövege, amiben keresünk: séma nélkül, százalék-kódolás feloldva, kisbetűvel.
    public static func keywordHaystack(_ url: String) -> String {
        var s = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = s.range(of: "^[a-zA-Z][a-zA-Z0-9+.-]*://", options: .regularExpression) {
            s.removeSubrange(range)
        }
        let decoded = s.removingPercentEncoding ?? s
        return decoded.precomposedStringWithCompatibilityMapping.lowercased()
    }

    /// Melyik kulcsszó illik a címre — az első a lista sorrendjében —, vagy nil.
    public static func keywordHit(_ keywords: [String], _ url: String) -> String? {
        let hay = keywordHaystack(url)
        if hay.isEmpty { return nil }
        for k in keywords {
            guard let key = normalizeKeyword(k) else { continue }
            if hay.contains(key) { return key }
        }
        return nil
    }
}
