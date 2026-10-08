import Foundation

/// KULCSSZÓ-SZABÁLYOK: bármely oldalon, ha a cím tartalmazza — a
/// `desktop/src/shared/keywords.ts` tükre, ahogy Androidon a `Keywords.kt`.
///
/// Érvényesíteni csak a gépi böngésző-bővítmény tudja (csak ő látja a teljes
/// címet); az iPhone hordozza és fésüli, hogy a lista minden gépen ugyanaz
/// legyen. Felvenni ingyen, levenni próbatétel; a fésülés KULCSSZAVANKÉNT megy,
/// a hosztnevek mintájára: a nagyobb jel dönt, egyenlő (vagy hiányzó) jelnél
/// az unió. Ha itt változtatsz, a TS és a Kotlin ikren is.
public enum KeywordLogic {

    /// Legfeljebb ennyi kulcsszó.
    public static let maxKeywords = 40
    /// Egy kulcsszó hossza felülről.
    public static let maxKeywordLength = 40
    /// …és alulról: egy-két betű mindenre illeszkedne.
    public static let minKeywordLength = 3
    /// Javaslatok egy koppintásra — a gépi lista tükre; ami fent van, nem kínáljuk újra.
    public static let suggestions = ["shorts", "reels", "live", "stream"]

    /// Egy kulcsszó kanonikus alakja — vagy nil, ha nem az. A szóköz a kimondott
    /// készlet (TextLogic): a BOM a szélen lekerül, belül szóköz — a Swift
    /// `isWhitespace` ezt nem tudta, a gép igen.
    public static func normalizeKeyword(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let nfkc = raw.precomposedStringWithCompatibilityMapping
        // A kisbetű is a gép szabálya szerint: a görög szó végi szigma ς, nem σ.
        let cleaned = TextLogic.lowercase(TextLogic.trimSpaces(TextLogic.controlsToSpaces(nfkc)))
        if cleaned.isEmpty || cleaned.unicodeScalars.contains(where: TextLogic.isSpace) { return nil }
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

    /// Ennél több kulcsszó-jelet nem hordunk — a `keywords.ts` `MAX_KEYWORD_MARKS`-e.
    public static let maxKeywordMarks = 128

    /// Kanonikus kulcsszó-e — KÓDPONTRA, mint a gépen: a Swift `==` a bontott
    /// ékezetet az összetettel egynek venné.
    private static func isCanonical(_ k: String) -> Bool {
        guard let n = normalizeKeyword(k) else { return false }
        return TextLogic.sameScalars(n, k)
    }

    /// A jelek plafonja — a gép `capKeywordMarks`-e: a jelen lévő kulcsszavak
    /// jele mindig marad, a levettekből a legnagyobb jelűek férnek be
    /// (holtversenyben kódegység szerint). Üresen nil.
    public static func capKeywordMarks(_ marks: [String: Int], _ present: [String]) -> [String: Int]? {
        if marks.isEmpty { return nil }
        let here = Set(present)
        var out = marks.filter { here.contains($0.key) }
        let limit = max(out.count, maxKeywordMarks)
        let gone = marks.filter { !here.contains($0.key) }.sorted { x, y in
            x.value != y.value ? x.value > y.value : TextLogic.utf16Less(x.key, y.key)
        }
        for (k, v) in gone {
            if out.count >= limit { break }
            out[k] = v
        }
        return out
    }

    /// A kívülről (dróton, lemezről) jött kulcsszó-jelek tisztán: csak
    /// kanonikus kulcsszó, csak pozitív egész, legfeljebb a blob rev-je — a plafonnal.
    public static func cleanKeywordMarks(_ raw: [String: Int]?, _ keywords: [String], maxRev: Int) -> [String: Int]? {
        guard let raw else { return nil }
        var marks: [String: Int] = [:]
        for (k, v) in raw where v > 0 && v <= maxRev && isCanonical(k) { marks[k] = v }
        return capKeywordMarks(marks, keywords)
    }

    /// A kulcsszavak egy eszközön: a lista és a kulcsszavankénti jelek.
    public struct KeywordSet: Equatable {
        public var keywords: [String]
        public var keywordMarks: [String: Int]?

        public init(keywords: [String], keywordMarks: [String: Int]? = nil) {
            self.keywords = keywords
            self.keywordMarks = keywordMarks
        }
    }

    /// Két eszköz kulcsszavai KULCSSZAVANKÉNT fésülve — a gép `mergeKeywordSets`-e.
    /// A jel a kulcsszóhoz tartozik (a blob rev-je, amelyik utoljára felvette
    /// vagy levette), és a nagyobb jel dönt; egyenlő vagy hiányzó jelnél az
    /// unió. Eddig a lista egészében a nagyobb jelet követte — és egy elavult
    /// eszközön egy ingyenes felvétel a régi listával mindenhol letörölte a
    /// máshol felvett kulcsszavakat. A sorrend a jelé (a jeltelen legelöl),
    /// aztán kódegység szerint; a plafon is ebben a sorrendben vág.
    public static func mergeKeywordSets(_ a: KeywordSet, _ b: KeywordSet) -> KeywordSet {
        let listA = cleanKeywords(a.keywords)
        let listB = cleanKeywords(b.keywords)
        var names = listA
        for k in listB where !names.contains(k) { names.append(k) }
        for m in [a.keywordMarks, b.keywordMarks] {
            for k in (m ?? [:]).keys where !names.contains(k) && isCanonical(k) { names.append(k) }
        }
        var present: [(key: String, mark: Int)] = []
        var marks: [String: Int] = [:]
        for k in names {
            let ma = max(0, a.keywordMarks?[k] ?? 0)
            let mb = max(0, b.keywordMarks?[k] ?? 0)
            let inA = listA.contains(k)
            let inB = listB.contains(k)
            let here = ma > mb ? inA : (mb > ma ? inB : (inA || inB))
            let m = max(ma, mb)
            if here { present.append((key: k, mark: m)) }
            if m > 0 { marks[k] = m }
        }
        let keywords = present.sorted { x, y in
            x.mark != y.mark ? x.mark < y.mark : TextLogic.utf16Less(x.key, y.key)
        }.prefix(maxKeywords).map { $0.key }
        return KeywordSet(keywords: keywords, keywordMarks: capKeywordMarks(marks, keywords))
    }

    /// A kulcsszó-jelek a léptetésben — a gép `markKeywordChanges`-e: ami az
    /// előző léptetés óta bekerült vagy kikerült, az ezt a blob-rev-et kapja; a
    /// többi jel marad.
    public static func markKeywordChanges(
        _ marks: [String: Int]?, prev: [String], next: [String], rev: Int
    ) -> [String: Int]? {
        var out = (marks ?? [:]).filter { $0.value > 0 }
        let before = Set(prev)
        let after = Set(next)
        for k in next where !before.contains(k) { out[k] = rev }
        for k in prev where !after.contains(k) { out[k] = rev }
        return capKeywordMarks(out, next)
    }

    /// A kulcsszó-jelek tartalmi kulcsa — kódegység szerint rendezve, mint a gépen.
    public static func keywordMarksKey(_ marks: [String: Int]?) -> String {
        (marks ?? [:]).sorted { TextLogic.utf16Less($0.key, $1.key) }
            .map { "\($0.key)=\($0.value)" }.joined(separator: "|")
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

    /// Melyik kulcsszó illik a HOSZTNÉVRE — az iPhone szűrője csak azt látja. Az
    /// első a lista sorrendjében, vagy nil. Ugyanaz a szabály, mint a címnél: ha
    /// benne van, benne van (a `live` a `live.com`-ot is elviszi — a gépen is).
    public static func keywordInHost(_ keywords: [String], _ host: String) -> String? {
        var h = host.trimmingCharacters(in: .whitespacesAndNewlines)
        while h.hasSuffix(".") { h.removeLast() }
        let hay = h.precomposedStringWithCompatibilityMapping.lowercased()
        if hay.isEmpty { return nil }
        for k in keywords {
            guard let key = normalizeKeyword(k) else { continue }
            if hay.contains(key) { return key }
        }
        return nil
    }
}
