import hu.breaker.app.core.ChallengeEngine
import hu.breaker.app.core.ChallengeEngine.Kind
import hu.breaker.app.core.ChallengeEngine.Step
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Megfelelőség a géppel a PRÓBATÉTEL VÁLASZÁBAN: a `fixtures/challenge-cases.json`
 * a gép döntéseit tartja (desktop/test/challenge-fixture.test.ts írja és őrzi) —
 * a fok a feloldások naplójából, a hátralévő-jelzés, a kombináció-kulcs, és a
 * válasz: ugyanaz a lépés, ugyanaz a beírás, ugyanaz az időpont az Android
 * motorjába megy, és jó-e, kész-e, marad-e a lépés, hol áll a lánc — mind
 * egyezzen. Az új lépés tartalma véletlen, azt nem hasonlítjuk.
 *
 * A hibás válasz ára itt nagy (a lánc elölről, új kód): ha az Android másképp
 * olvasná ugyanazt a beírást, mint a gép, az nem szigorúság volna, hanem véletlen.
 */
class ChallengeFixtureTest {

    private fun fixtureFile(): File {
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            val f = File(dir, "fixtures/challenge-cases.json")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        error("fixtures/challenge-cases.json nincs meg a tároló gyökerében")
    }

    private fun fixture(): JSONObject = JSONObject(fixtureFile().readText())
    private fun longs(a: JSONArray): List<Long> = (0 until a.length()).map { a.getLong(it) }
    private fun strings(a: JSONArray): List<String> = (0 until a.length()).map { a.getString(it) }

    @Test fun `a fok a feloldasok naplojabol ugyanaz, mint a gepen`() {
        val cases = fixture().getJSONArray("tiers")
        assertTrue(cases.length() >= 40, "a fixture-ben van elég napló")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val log = longs(c.getJSONArray("unlockLog"))
            assertEquals(c.getInt("tier"), ChallengeEngine.computeTier(log, c.getLong("now")), "fok, napló $log")
        }
    }

    @Test fun `a hatralevo jelzes ugyanaz, mint a gepen`() {
        val cases = fixture().getJSONArray("remaining")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val got = ChallengeEngine.remainingHint(c.getInt("stepIndex"), c.getInt("stepCount")).name.lowercase()
            assertEquals(c.getString("hint"), got, "jelzés ${c.getInt("stepIndex")}/${c.getInt("stepCount")}")
        }
    }

    @Test fun `a kombinacio-kulcs ugyanugy olvasodik es irodik, mint a gepen`() {
        val cases = fixture().getJSONArray("combos")
        assertTrue(cases.length() >= 15, "a fixture-ben van elég kulcs")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val key = if (c.isNull("key")) null else c.getString("key")
            val types = ChallengeEngine.parseCombo(key)
            val expected = if (c.isNull("types")) null else strings(c.getJSONArray("types"))
            assertEquals(expected, types, "kulcs ${JSONObject.quote(key ?: "")}")
            val combo = if (c.isNull("combo")) null else c.getString("combo")
            assertEquals(combo, types?.let { ChallengeEngine.comboKeyOf(it) }, "kulcs vissza ${JSONObject.quote(key ?: "")}")
        }
    }

    private fun step(o: JSONObject): Step {
        val id = o.getString("id")
        return when (val type = o.getString("type")) {
            "TRANSCRIBE" -> Step.Transcribe(id, o.getString("text"))
            "REVERSE" -> Step.Reverse(id, o.getString("text"))
            "MATH_CHAIN" -> {
                val ps = o.getJSONArray("problems")
                Step.MathChain(
                    id,
                    (0 until ps.length()).map { ChallengeEngine.Problem(ps.getJSONObject(it).getString("q"), ps.getJSONObject(it).getLong("a")) },
                    o.getInt("pos"),
                )
            }
            "MEMORY" -> Step.Memory(
                id, o.getString("code"), o.getLong("showMs"), o.getLong("waitMs"),
                if (o.isNull("armedAt")) null else o.getLong("armedAt"),
            )
            "DELAY" -> Step.Delay(
                id, o.getInt("minutes"), if (o.isNull("claimableAt")) null else o.getLong("claimableAt"), o.getLong("claimWindowMs"),
            )
            "PARTNER" -> Step.Partner(id, o.getString("name"))
            else -> error("ismeretlen lépés: $type")
        }
    }

    @Test fun `a valasz ugyanugy szamit, mint a gepen - jo-e, kesz-e, marad-e a lepes, hol all a lanc`() {
        val cases = fixture().getJSONArray("answers")
        assertTrue(cases.length() >= 100, "a fixture-ben van elég válasz")
        var ok = 0
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val seed = c.getInt("seed")
            val step = step(c.getJSONObject("step"))
            val answer = c.getString("answer")
            val out = ChallengeEngine.applyAnswer(step, answer, 0, Kind.PAUSE, c.getLong("now"))
            val label = "válasz ${JSONObject.quote(answer)}, lépés ${step.id}, mag $seed"
            assertEquals(c.getBoolean("ok"), out.ok, "jó-e: $label")
            assertEquals(c.getBoolean("done"), out.done, "kész-e: $label")
            assertEquals(c.getBoolean("kept"), out.step.id == step.id, "marad-e a lépés: $label")
            val pos = (out.step as? Step.MathChain)?.pos
            assertEquals(if (c.isNull("pos")) null else c.getInt("pos"), pos, "a lánc helye: $label")
            if (out.ok) ok++
        }
        assertTrue(ok > 40, "kevés jó válasz — a fixtúra elfajult")
    }
}
