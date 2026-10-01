import hu.breaker.app.core.AliasLogic
import hu.breaker.app.core.Blocklist
import hu.breaker.app.core.Focus
import hu.breaker.app.core.KeywordLogic
import hu.breaker.app.core.PartnerLogic
import hu.breaker.app.core.TextLogic
import hu.breaker.app.core.UrlRules
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Megfelelőség a géppel a SZÖVEG-TISZTÍTÁSBAN: a `fixtures/text-cases.json` a
 * gép tiszta alakjait tartja (desktop/test/text-fixture.test.ts írja és őrzi);
 * itt ugyanazok a bemenetek a Kotlin tisztításán mennek át, és bájtra
 * egyezniük kell. A Swift tükör (TextFixtureTests) ugyanezt.
 *
 * Amit fog: mást tart-e szóköznek a telefon (BOM, nem törő szóköz), máshol
 * vág-e (UTF-16 egység kontra kódpont), másképp kezeli-e az NFKC-t és a
 * kisbetűsítést. Ha a tükör elcsúszik, itt bukik — a mag számával.
 */
class TextFixtureTest {

    private fun fixtureFile(): File {
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            val f = File(dir, "fixtures/text-cases.json")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        error("fixtures/text-cases.json nincs meg a tároló gyökerében")
    }

    private val fixture: JSONObject by lazy { JSONObject(fixtureFile().readText()) }

    /** Olvasható alak a hibaüzenetben: a vezérlők és a 0x7f fölötti egységek \\uXXXX-ként. */
    private fun show(s: String?): String {
        if (s == null) return "null"
        val sb = StringBuilder("\"")
        for (ch in s) {
            if (ch.code < 0x20 || ch.code >= 0x7f) sb.append(String.format("\\u%04x", ch.code)) else sb.append(ch)
        }
        return sb.append('"').toString()
    }

    private fun outOf(c: JSONObject): String? = if (c.isNull("out")) null else c.getString("out")

    private fun strings(a: JSONArray): List<String> = (0 until a.length()).map { a.getString(it) }

    private fun check(section: String, f: (String) -> String?) {
        val arr = fixture.getJSONArray(section)
        assertTrue(arr.length() > 50, "$section: kevés eset — a fixtúra csonka?")
        var valid = 0
        for (i in 0 until arr.length()) {
            val c = arr.getJSONObject(i)
            val input = c.getString("in")
            val expected = outOf(c)
            val got = f(input)
            assertEquals(expected, got, "$section #$i: ${show(input)} — a gép ${show(expected)}, a Kotlin ${show(got)}")
            if (got != null) valid++
        }
        assertTrue(valid > 0, "$section: minden eset érvénytelen — a fixtúra elfajult")
    }

    @Test fun `a fedonev tisztitasa ugyanaz, mint a gepen`() = check("alias") { AliasLogic.normalize(it) }

    @Test fun `az indok tisztitasa ugyanaz, mint a gepen`() = check("reason") { AliasLogic.normalizeReason(it) }

    @Test fun `a kulcsszo kanonikus alakja ugyanaz, mint a gepen`() = check("keyword") { KeywordLogic.normalizeKeyword(it) }

    @Test fun `a megbizott neve ugyanaz, mint a gepen`() = check("partnerName") { PartnerLogic.normalizePartnerName(it) }

    @Test fun `a jelmondat kanonikus alakja ugyanaz, mint a gepen`() = check("phrase") { PartnerLogic.normalizePhrase(it) }

    @Test fun `a domain tisztitasa ugyanaz, mint a gepen`() = check("domain") { Blocklist.normalizeDomain(it) }

    @Test fun `a kulcsszo-lista tisztitasa ugyanaz, mint a gepen`() {
        val arr = fixture.getJSONArray("keywords")
        assertTrue(arr.length() > 20, "keywords: kevés eset")
        for (i in 0 until arr.length()) {
            val c = arr.getJSONObject(i)
            val input = strings(c.getJSONArray("in"))
            val expected = strings(c.getJSONArray("out"))
            assertEquals(expected, KeywordLogic.cleanKeywords(input), "keywords #$i: ${input.map { show(it) }}")
        }
    }

    @Test fun `a szokoz-keszlet a gep listaja - huszonot kodpont`() {
        assertEquals(25, TextLogic.SPACES.size)
        assertTrue(TextLogic.isSpace('\uFEFF'), "a BOM is szóköz — a Kotlin isWhitespace ezt nem tudja")
        assertTrue(TextLogic.isSpace('\u00A0'), "a nem törő szóköz is — a Java regex \\s-e nem tudja")
        assertFalse(TextLogic.isSpace('\u200B'), "a nulla szélességű szóköz NEM szóköz — egyik magban sem")
    }

    private fun ruleKey(r: UrlRules.UrlRule?): String? = r?.let { "${it.host}|${it.path}" }

    @Test fun `a reszleges szabaly kanonikus alakja ugyanaz, mint a gepen`() =
        check("rule") { ruleKey(UrlRules.normalizeRule(it)) }

    @Test fun `a reszleges szabaly illesztese ugyanaz, mint a gepen`() {
        val arr = fixture.getJSONArray("ruleMatch")
        assertTrue(arr.length() > 50, "ruleMatch: kevés eset — a fixtúra csonka?")
        for (i in 0 until arr.length()) {
            val c = arr.getJSONObject(i)
            val ruleText = c.getString("rule")
            val rule = UrlRules.normalizeRule(ruleText)
            assertTrue(rule != null, "ruleMatch #$i: az illesztendő szabály nem szabály: ${show(ruleText)}")
            assertEquals(
                c.getBoolean("out"), UrlRules.matchesRule(rule!!, c.getString("url")),
                "ruleMatch #$i: ${show(ruleText)} ~ ${show(c.getString("url"))}",
            )
        }
    }
    @Test fun `az engedelyezett app neve ugyanaz, mint a gepen`() = check("allowApp") { Focus.normalizeAllowApp(it) }

    @Test fun `a csomag neve ugyanaz, mint a gepen`() = check("packName") { Focus.normalizePackName(it) }

    @Test fun `a naplosor neve ugyanaz, mint a gepen - uresre Ismeretlen csomag`() = check("logPackName") { Focus.logPackName(it) }

    @Test fun `az app-egyezes ugyanaz, mint a gepen - az ures tetel nem enged mindent`() {
        val arr = fixture.getJSONArray("appMatch")
        assertTrue(arr.length() > 50, "appMatch: kevés eset — a fixtúra csonka?")
        for (i in 0 until arr.length()) {
            val c = arr.getJSONObject(i)
            val apps = strings(c.getJSONArray("apps"))
            val app = c.getString("app")
            val pack = Focus.FocusPack("p", "p", emptyList(), apps, 30)
            assertEquals(
                c.getBoolean("out"), Focus.isAppAllowed(pack, app),
                "appMatch #$i: ${apps.joinToString(", ") { show(it) }} ~ ${show(app)}",
            )
        }
    }
}
