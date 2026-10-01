package hu.breaker.app.core

/**
 * SZÖVEG-TISZTÍTÁS a három mag közös fogalmaival — a `desktop/src/shared/alias.ts`
 * `WHITESPACE_CODE_POINTS` listájának és kódpontos vágásának tükre; az iPhone-on
 * a `TextLogic` (Text.swift).
 *
 * MIÉRT KELL KIMONDANI. A fedőnév, az indok, a kulcsszó, a megbízott neve és
 * jelmondata, a domain a felhasználó billentyűzetéről jön, és a szinkronon át
 * utazik. A három platform saját szóköz-fogalma eltér: a Java regex `\s`-e
 * csak ASCII (a nem törő szóköz nem az), a Kotlin `isWhitespace` és a Swift
 * `isWhitespace` a BOM-ot (U+FEFF) nem ismeri, a JS `\s` igen. Ha a gép
 * szóköznek vesz valamit, amit a telefon nem, a rekord minden szinkron-körben
 * átíródik — vagy a jelmondat az egyik eszközön nem nyit. Ezért itt a JS
 * készlete áll, kimondva; a `fixtures/text-cases.json` (TextFixtureTest) őrzi,
 * hogy a tisztítás bájtra ugyanaz.
 *
 * A VÁGÁS KÓDPONTBAN számol, nem UTF-16 egységben: a `take` egy emodzsit félbe
 * vágna, és a fél — párja nélküli helyettesítő — a JSON-on át a többi
 * eszközig jutna, ahol az iPhone olvasója az ilyen szöveget eldobja.
 */
object TextLogic {

    /** A JS `\s` készlete — pontosan ez a huszonöt kódpont (mind a BMP-ben). */
    val SPACES: Set<Char> = setOf(
        '\u0009', '\u000A', '\u000B', '\u000C', '\u000D', '\u0020', '\u00A0', '\u1680',
        '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200A',
        '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF',
    )

    /** Szóköz-e a kimondott készlet szerint — nem a platform fogalma szerint. */
    fun isSpace(ch: Char): Boolean = ch in SPACES

    /** Vezérlőkarakterek: C0, DEL és C1 — a TS `CONTROL_CHARS` tartománya. */
    fun isControl(ch: Char): Boolean = ch.code < 0x20 || (ch.code in 0x7f..0x9f)

    /**
     * A vezérlők szóközre, a szóköz-futamok egy szóközre, a szélek le — egy
     * menetben. A TS `replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()`
     * tükre. Egy helyettesítő-pár tagja se vezérlő, se szóköz: együtt marad.
     */
    fun collapseSpaces(value: String): String {
        val sb = StringBuilder(value.length)
        var pendingSpace = false
        for (raw in value) {
            val ch = if (isControl(raw)) ' ' else raw
            if (isSpace(ch)) {
                pendingSpace = true
                continue
            }
            if (pendingSpace && sb.isNotEmpty()) sb.append(' ')
            pendingSpace = false
            sb.append(ch)
        }
        return sb.toString()
    }

    /** A szélek le a kimondott készlet szerint — a JS `trim()` tükre. */
    fun trimSpaces(value: String): String = value.trim { isSpace(it) }

    /** Az első `max` kódpont — egy helyettesítő-pár együtt marad vagy együtt esik. */
    fun takeCodePoints(value: String, max: Int): String {
        if (value.codePointCount(0, value.length) <= max) return value
        return value.substring(0, value.offsetByCodePoints(0, max))
    }
}
