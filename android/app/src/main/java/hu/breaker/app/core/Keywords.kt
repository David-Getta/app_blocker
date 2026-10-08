package hu.breaker.app.core

import java.text.Normalizer

/**
 * KULCSSZÓ-SZABÁLYOK: bármely oldalon, ha a cím tartalmazza — a
 * `desktop/src/shared/keywords.ts` tükre.
 *
 * Érvényesíteni csak a gépi böngésző-bővítmény tudja (csak ő látja a teljes
 * címet); a telefon hordozza és fésüli, hogy a lista minden gépen ugyanaz
 * legyen. Felvenni ingyen, levenni próbatétel; a fésülés KULCSSZAVANKÉNT megy,
 * a hosztnevek mintájára: a nagyobb jel dönt, egyenlő (vagy hiányzó) jelnél az
 * unió. Ha itt változtatsz, a TS és a Swift ikren is.
 */
object KeywordLogic {

    /** Legfeljebb ennyi kulcsszó. */
    const val MAX_KEYWORDS = 40
    /** Egy kulcsszó hossza felülről. */
    const val MAX_KEYWORD_LENGTH = 40
    /** …és alulról: egy-két betű mindenre illeszkedne. */
    const val MIN_KEYWORD_LENGTH = 3
    /** Javaslatok egy koppintásra — a gépi lista tükre; ami fent van, nem kínáljuk újra. */
    val SUGGESTIONS = listOf("shorts", "reels", "live", "stream")

    /**
     * Egy kulcsszó kanonikus alakja — vagy null, ha nem az. A szóköz a
     * kimondott készlet (TextLogic.SPACES): a BOM a szélen lekerül, belül
     * szóköz — a Kotlin `isWhitespace` ezt nem tudta, a gép igen.
     */
    fun normalizeKeyword(raw: String?): String? {
        if (raw == null) return null
        val cleaned = TextLogic.trimSpaces(
            Normalizer.normalize(raw, Normalizer.Form.NFKC)
                .map { if (TextLogic.isControl(it)) ' ' else it }.joinToString(""),
        ).lowercase()
        if (cleaned.isEmpty() || cleaned.any { TextLogic.isSpace(it) }) return null
        val len = cleaned.codePointCount(0, cleaned.length)
        if (len < MIN_KEYWORD_LENGTH || len > MAX_KEYWORD_LENGTH) return null
        return cleaned
    }

    /** Egy lista tisztán: csak az érvényes, egyszer, a plafonig. */
    fun cleanKeywords(raw: List<String?>): List<String> {
        val out = ArrayList<String>()
        for (item in raw) {
            val k = normalizeKeyword(item) ?: continue
            if (k in out) continue
            if (out.size >= MAX_KEYWORDS) break
            out.add(k)
        }
        return out
    }

    /** A lista tartalmi kulcsa — rendezve: a sorrend nem jelentés. */
    fun keywordsKey(list: List<String>): String = list.sorted().joinToString("|")

    /** Ugyanaz a két lista tartalom szerint. */
    fun sameKeywords(a: List<String>, b: List<String>): Boolean =
        keywordsKey(cleanKeywords(a)) == keywordsKey(cleanKeywords(b))

    /** Lazítás-e a csere: ha a mostaniból bármi hiányzik az újból. */
    fun isKeywordsLoosening(current: List<String>, next: List<String>): Boolean {
        val have = cleanKeywords(next).toSet()
        return cleanKeywords(current).any { it !in have }
    }

    /** Ennél több kulcsszó-jelet nem hordunk — a `keywords.ts` `MAX_KEYWORD_MARKS`-e. */
    const val MAX_KEYWORD_MARKS = 128

    /**
     * A jelek plafonja — a gép `capKeywordMarks`-e: a jelen lévő kulcsszavak
     * jele mindig marad, a levettekből a legnagyobb jelűek férnek be
     * (holtversenyben kódegység szerint). Üresen null.
     */
    fun capKeywordMarks(marks: Map<String, Int>, present: List<String>): Map<String, Int>? {
        if (marks.isEmpty()) return null
        val here = present.toHashSet()
        val kept = marks.entries.filter { it.key in here }
        val gone = marks.entries.filter { it.key !in here }
            .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
        val limit = maxOf(kept.size, MAX_KEYWORD_MARKS)
        val out = LinkedHashMap<String, Int>()
        for (e in kept + gone) {
            if (out.size >= limit) break
            out[e.key] = e.value
        }
        return out
    }

    /**
     * A kívülről (dróton, lemezről) jött kulcsszó-jelek tisztán: csak kanonikus
     * kulcsszó, csak pozitív egész, legfeljebb a blob rev-je — a plafonnal.
     */
    fun cleanKeywordMarks(raw: Map<String, Int>?, keywords: List<String>, maxRev: Int): Map<String, Int>? {
        if (raw == null) return null
        val marks = LinkedHashMap<String, Int>()
        for ((k, v) in raw) {
            if (v <= 0 || v > maxRev || normalizeKeyword(k) != k) continue
            marks[k] = v
        }
        return capKeywordMarks(marks, keywords)
    }

    /** A kulcsszavak egy eszközön: a lista és a kulcsszavankénti jelek. */
    data class KeywordSet(val keywords: List<String>, val keywordMarks: Map<String, Int>? = null)

    /**
     * Két eszköz kulcsszavai KULCSSZAVANKÉNT fésülve — a gép `mergeKeywordSets`-e.
     * A jel a kulcsszóhoz tartozik (a blob rev-je, amelyik utoljára felvette
     * vagy levette), és a nagyobb jel dönt; egyenlő vagy hiányzó jelnél az
     * unió. Eddig a lista egészében a nagyobb jelet követte — és egy elavult
     * eszközön egy ingyenes felvétel a régi listával mindenhol letörölte a
     * máshol felvett kulcsszavakat. A sorrend a jelé (a jeltelen legelöl),
     * aztán kódegység szerint; a plafon is ebben a sorrendben vág.
     */
    fun mergeKeywordSets(a: KeywordSet, b: KeywordSet): KeywordSet {
        val listA = cleanKeywords(a.keywords)
        val listB = cleanKeywords(b.keywords)
        val names = LinkedHashSet<String>(listA + listB)
        for (m in listOf(a.keywordMarks, b.keywordMarks)) {
            m?.keys?.forEach { if (normalizeKeyword(it) == it) names.add(it) }
        }
        val present = ArrayList<Pair<String, Int>>()
        val marks = LinkedHashMap<String, Int>()
        for (k in names) {
            val ma = a.keywordMarks?.get(k)?.takeIf { it > 0 } ?: 0
            val mb = b.keywordMarks?.get(k)?.takeIf { it > 0 } ?: 0
            val inA = k in listA
            val inB = k in listB
            val here = if (ma > mb) inA else if (mb > ma) inB else inA || inB
            val m = maxOf(ma, mb)
            if (here) present.add(k to m)
            if (m > 0) marks[k] = m
        }
        val keywords = present.sortedWith(compareBy<Pair<String, Int>> { it.second }.thenBy { it.first })
            .take(MAX_KEYWORDS).map { it.first }
        return KeywordSet(keywords, capKeywordMarks(marks, keywords))
    }

    /**
     * A kulcsszó-jelek a léptetésben — a gép `markKeywordChanges`-e: ami az
     * előző léptetés óta bekerült vagy kikerült, az ezt a blob-rev-et kapja; a
     * többi jel marad.
     */
    fun markKeywordChanges(marks: Map<String, Int>?, prev: List<String>, next: List<String>, rev: Int): Map<String, Int>? {
        val out = LinkedHashMap<String, Int>()
        marks?.forEach { (k, v) -> if (v > 0) out[k] = v }
        val before = prev.toHashSet()
        val after = next.toHashSet()
        for (k in next) if (k !in before) out[k] = rev
        for (k in prev) if (k !in after) out[k] = rev
        return capKeywordMarks(out, next)
    }

    /** A kulcsszó-jelek tartalmi kulcsa — rendezve, a különbség-vizsgálathoz. */
    fun keywordMarksKey(marks: Map<String, Int>?): String =
        (marks ?: emptyMap()).toSortedMap().entries.joinToString("|") { "${it.key}=${it.value}" }

    /** A cím szövege, amiben keresünk: séma nélkül, százalék-kódolás feloldva, kisbetűvel. */
    fun keywordHaystack(url: String): String {
        val s = url.trim().replace(Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://"), "")
        val decoded = runCatching { java.net.URLDecoder.decode(s.replace("+", "%2B"), "UTF-8") }.getOrDefault(s)
        return Normalizer.normalize(decoded, Normalizer.Form.NFKC).lowercase()
    }

    /** Melyik kulcsszó illik a címre — az első a lista sorrendjében —, vagy null. */
    fun keywordHit(keywords: List<String>, url: String): String? {
        val hay = keywordHaystack(url)
        if (hay.isEmpty()) return null
        for (k in keywords) {
            val key = normalizeKeyword(k) ?: continue
            if (hay.contains(key)) return key
        }
        return null
    }

    /**
     * Melyik kulcsszó illik a HOSZTNÉVRE — a telefon szűrője csak azt látja. Az
     * első a lista sorrendjében, vagy null. Ugyanaz a szabály, mint a címnél: ha
     * benne van, benne van (a `live` a `live.com`-ot is elviszi — a gépen is).
     */
    fun keywordInHost(keywords: List<String>, host: String): String? {
        val hay = Normalizer.normalize(host.trim().trimEnd('.'), Normalizer.Form.NFKC).lowercase()
        if (hay.isEmpty()) return null
        for (k in keywords) {
            val key = normalizeKeyword(k) ?: continue
            if (hay.contains(key)) return key
        }
        return null
    }
}
