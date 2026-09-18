package hu.breaker.app.core

import java.text.Normalizer

/**
 * KULCSSZÓ-SZABÁLYOK: bármely oldalon, ha a cím tartalmazza — a
 * `desktop/src/shared/keywords.ts` tükre.
 *
 * Érvényesíteni csak a gépi böngésző-bővítmény tudja (csak ő látja a teljes
 * címet); a telefon hordozza és fésüli, hogy a lista minden gépen ugyanaz
 * legyen. Felvenni ingyen, levenni próbatétel; a fésülés a zárlat-ablakoké:
 * a jel dönt, azonos jelnél a bővebb lista. Ha itt változtatsz, a TS és a
 * Swift ikren is.
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

    /** C0, DEL és C1 — ugyanaz a tartomány, mint a fedőnévnél. */
    private fun isControl(ch: Char): Boolean = ch.code < 0x20 || (ch.code in 0x7f..0x9f)

    /** Egy kulcsszó kanonikus alakja — vagy null, ha nem az. */
    fun normalizeKeyword(raw: String?): String? {
        if (raw == null) return null
        val cleaned = Normalizer.normalize(raw, Normalizer.Form.NFKC)
            .map { if (isControl(it)) ' ' else it }.joinToString("")
            .trim().lowercase()
        if (cleaned.isEmpty() || cleaned.any { it.isWhitespace() }) return null
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

    /** Két lista fésülve a jelük szerint: nagyobb jel nyer, azonos jelnél az unió. */
    fun mergeKeywords(localMark: Int, local: List<String>, incomingMark: Int, incoming: List<String>): List<String> {
        if (localMark > incomingMark) return cleanKeywords(local)
        if (incomingMark > localMark) return cleanKeywords(incoming)
        return cleanKeywords(local + incoming)
    }

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
}
