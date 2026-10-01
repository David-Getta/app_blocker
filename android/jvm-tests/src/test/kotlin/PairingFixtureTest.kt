import hu.breaker.app.core.Pairing
import hu.breaker.app.core.TextLogic
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Megfelelőség a géppel a PÁROSÍTÓ KÓDBAN: a `fixtures/pairing-cases.json` a
 * gép kimeneteit tartja (desktop/test/pairing-fixture.test.ts írja és őrzi) —
 * cím → kód, beírt szöveg → cím, egy mező, megjelenítés. A gépen kiírt kódot
 * a telefonon gépelik be: ha egy bit eltér, a kód nem nyílik ki, vagy MÁS
 * címet ad. Itt minden eset a Kotlin párosítóján megy át, és egyeznie kell.
 */
class PairingFixtureTest {

    private fun fixtureFile(): File {
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            val f = File(dir, "fixtures/pairing-cases.json")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        error("fixtures/pairing-cases.json nincs meg a tároló gyökerében")
    }

    private val fixture: JSONObject by lazy { JSONObject(fixtureFile().readText()) }

    private fun show(s: String?): String {
        if (s == null) return "null"
        val sb = StringBuilder("\"")
        for (ch in s) {
            if (ch.code < 0x20 || ch.code >= 0x7f) sb.append(String.format("\\u%04x", ch.code)) else sb.append(ch)
        }
        return sb.append('"').toString()
    }

    private fun check(section: String, f: (String) -> String?) {
        val arr = fixture.getJSONArray(section)
        assertTrue(arr.length() >= 10, "$section: kevés eset — a fixtúra csonka?")
        for (i in 0 until arr.length()) {
            val c = arr.getJSONObject(i)
            val input = c.getString("in")
            val expected = if (c.isNull("out")) null else c.getString("out")
            val got = f(input)
            assertEquals(expected, got, "$section #$i: ${show(input)} — a gép ${show(expected)}, a Kotlin ${show(got)}")
        }
    }

    @Test fun `cim - kod - ugyanaz, mint a gepen`() = check("encode") { Pairing.encode(it) }

    @Test fun `beirt szoveg - cim - ugyanaz, mint a gepen`() = check("decode") { Pairing.decode(it) }

    @Test fun `egy mezo, kod vagy cim - ugyanaz, mint a gepen`() = check("resolve") { Pairing.resolveServerInput(it) }

    @Test fun `a kod olvashato alakja ugyanaz, mint a gepen`() = check("format") { Pairing.format(it) }

    @Test fun `a szelek a kimondott szokoz-keszlet szerint - a BOM is lekerul`() {
        assertEquals("http://192.168.1.10:8787", Pairing.resolveServerInput("\uFEFF192.168.1.10:8787"))
        assertEquals("00GMR", Pairing.encode("\uFEFFhttp://192.168.1.10:8787\n"))
        assertTrue(TextLogic.isSpace('\uFEFF'))
    }
}
