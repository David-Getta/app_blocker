import hu.breaker.app.core.LimitLogic
import hu.breaker.app.core.UsageLogic
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Megfelelőség a géppel a NAPI KERETBEN: a `fixtures/limit-cases.json` a gép
 * döntéseit tartja (desktop/test/limit-fixture.test.ts írja és őrzi) — a dróton
 * jövő napi összegzést a blob szövegéből, a keret betelt napjait és a sorát, a
 * „ma még N perc” sort, a lazítást, a hátralévőt, és hogy kimerült-e a keret a
 * többi eszköz percével. Itt ugyanazok a bemenetek az Android magjába mennek.
 *
 * A keret eszközök között közös: ha a telefon másképp olvasná a gép blobját
 * (az `optDouble` a szövegként írt számot is számnak vette), a keret itt
 * hamarabb telne be, mint ott — és semmi nem mondaná meg, miért.
 * A napok helyi időben számolnak: a teszt UTC-ben jár, mint a fixtúra.
 */
class LimitFixtureTest {

    init {
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"))
    }

    private fun fixtureFile(): File {
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            val f = File(dir, "fixtures/limit-cases.json")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        error("fixtures/limit-cases.json nincs meg a tároló gyökerében")
    }

    private fun fixture(): JSONObject = JSONObject(fixtureFile().readText())
    private fun optLong(o: JSONObject, key: String): Long? = if (o.isNull(key)) null else o.getLong(key)
    private fun optLong(a: JSONArray, i: Int): Long? = if (a.isNull(i)) null else a.getLong(i)

    private fun secondsMap(o: JSONObject): MutableMap<String, Double> {
        val out = LinkedHashMap<String, Double>()
        for (k in o.keys()) out[k] = o.getDouble(k)
        return out
    }

    private fun usageOf(days: JSONArray): UsageLogic.UsageState = UsageLogic.UsageState(
        days = (0 until days.length()).map { i ->
            val d = days.getJSONObject(i)
            UsageLogic.UsageDay(d.getString("day"), secondsMap(d.getJSONObject("seconds")))
        }.toMutableList(),
    )

    @Test fun `a droton jovo napi osszegzes ugyanugy olvasodik, mint a gepen`() {
        val cases = fixture().getJSONArray("digests")
        assertTrue(cases.length() >= 80, "a fixture-ben van elég blob")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val text = c.getString("text")
            val got = LimitLogic.parseTodayDigest(text, "dev_masik")
            val label = "blob $i: ${text.take(120)}"
            if (c.isNull("out")) {
                assertEquals(null, got, label)
                continue
            }
            val out = c.getJSONObject("out")
            assertTrue(got != null, "nem olvasta: $label")
            assertEquals("dev_masik", got.deviceId)
            assertEquals(out.getString("day"), got.day, label)
            val pairs = out.getJSONArray("seconds")
            val expected = (0 until pairs.length()).map { j ->
                val p = pairs.getJSONArray(j)
                "${p.getString(0)}=${p.getLong(1)}"
            }
            val actual = got.seconds.entries.sortedBy { it.key }.map { "${it.key}=${it.value.toLong()}" }
            assertEquals(expected, actual, label)
        }
    }

    @Test fun `a keret betelt napjai es a sora ugyanaz, mint a gepen - holtversenyben kodegyseg`() {
        val cases = fixture().getJSONArray("fullDays")
        assertTrue(cases.length() >= 40, "a fixture-ben van elég hét")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val la = c.getJSONArray("limits")
            val limits = (0 until la.length()).map { j ->
                val p = la.getJSONArray(j)
                p.getString(0) to optLong(p, 1)
            }
            val r = LimitLogic.limitFullDays(usageOf(c.getJSONArray("days")), limits, c.getLong("now"))
            assertEquals(c.getInt("full"), r.days, "napok, hét $i")
            val bs = c.getJSONArray("bySite")
            val expected = (0 until bs.length()).map { j -> bs.getJSONArray(j).let { "${it.getString(0)}=${it.getInt(1)}" } }
            assertEquals(expected, r.bySite.map { "${it.first}=${it.second}" }, "oldalak, hét $i")
            assertEquals(c.getString("line"), LimitLogic.limitFullLine(r) { "[$it]" }, "sor, hét $i")
        }
    }

    @Test fun `a ma meg N perc sor ugyanaz, mint a gepen`() {
        val cases = fixture().getJSONArray("soon")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val ca = c.getJSONArray("candidates")
            val candidates = (0 until ca.length()).map { j ->
                val p = ca.getJSONArray(j)
                Triple(p.getString(0), optLong(p, 1), p.getDouble(2))
            }
            assertEquals(c.getString("line"), LimitLogic.limitSoonLine(candidates), "sor $i: $ca")
        }
    }

    @Test fun `a lazitas es a hatralevo ugyanaz, mint a gepen`() {
        val f = fixture()
        val lo = f.getJSONArray("loosening")
        for (i in 0 until lo.length()) {
            val c = lo.getJSONObject(i)
            val cur = optLong(c, "cur")
            val next = optLong(c, "next")
            assertEquals(c.getBoolean("loosening"), LimitLogic.isLimitLoosening(cur, next), "lazítás $cur -> $next")
        }
        val re = f.getJSONArray("remaining")
        for (i in 0 until re.length()) {
            val c = re.getJSONObject(i)
            val limit = optLong(c, "limit")
            val used = c.getDouble("used")
            val expected = if (c.isNull("remaining")) null else c.getDouble("remaining")
            assertEquals(expected, LimitLogic.limitRemaining(limit, used), "hátralévő $limit / $used")
        }
    }

    @Test fun `kimerult-e a keret a tobbi eszkoz percevel - ugyanugy, mint a gepen`() {
        val cases = fixture().getJSONArray("exhausted")
        assertTrue(cases.length() >= 100, "a fixture-ben van elég döntés")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val now = c.getLong("now")
            val today = UsageLogic.dayKey(now)
            val local = c.getDouble("local")
            val usage = UsageLogic.UsageState(
                days = mutableListOf(
                    UsageLogic.UsageDay(today, if (local > 0) mutableMapOf(UsageLogic.siteKey("youtube.com") to local) else mutableMapOf()),
                ),
            )
            val sa = c.getJSONArray("shared")
            val devices = (0 until sa.length()).map { j ->
                val d = sa.getJSONObject(j)
                LimitLogic.TodayDigest(d.getString("deviceId"), d.getString("day"), secondsMap(d.getJSONObject("seconds")))
            }
            val shared = LimitLogic.SharedToday("dev_self", devices)
            val got = LimitLogic.isLimitExhausted("youtube.com", optLong(c, "limit"), usage, now, shared)
            assertEquals(c.getBoolean("exhausted"), got, "döntés $i: keret ${optLong(c, "limit")}, helyi $local")
        }
    }
}
