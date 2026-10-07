import hu.breaker.app.core.Focus
import hu.breaker.app.core.ScheduleLogic
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Megfelelőség a géppel a MUNKAMENET MAGJÁBAN: a `fixtures/focus-cases.json` a
 * gép döntéseit tartja (desktop/test/focus-fixture.test.ts írja és őrzi) — az
 * ismétlődő menet előfordulásait és az esedékes ablakot, az ablak-menetet, a
 * lezárást, a legutóbb használt csomagot, a hátralévő idő szövegét, a percek
 * tisztítását, a közelgő ablak-menetet és az értesítése szövegét. Ha az
 * Android más ablakot tartana esedékesnek, a menet itt elindulna, a gépen nem
 * — vagy más csomaggal.
 * A napok és az órák helyi időben számolnak: a teszt UTC-ben jár, mint a fixtúra.
 */
class FocusFixtureTest {

    init {
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"))
    }

    private fun fixtureFile(): File {
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            val f = File(dir, "fixtures/focus-cases.json")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        error("fixtures/focus-cases.json nincs meg a tároló gyökerében")
    }

    private val fixture: JSONObject by lazy { JSONObject(fixtureFile().readText()) }

    private fun band(o: JSONObject): ScheduleLogic.Band? {
        if (o.isNull("band")) return null
        val b = o.getJSONObject("band")
        val days = b.getJSONArray("days")
        return ScheduleLogic.Band((0 until days.length()).map { days.getInt(it) }.toSet(), b.getInt("startMin"), b.getInt("endMin"))
    }

    private fun packs(a: JSONArray): List<Focus.FocusPack> = (0 until a.length()).map { i ->
        val p = a.getJSONObject(i)
        Focus.FocusPack(p.getString("id"), p.getString("name"), emptyList(), emptyList(), 30, band(p))
    }

    private fun run(o: JSONObject, key: String): Focus.FocusRun? =
        if (o.isNull(key)) null else o.getJSONObject(key).let { Focus.FocusRun(it.getString("packId"), it.getLong("startedAt"), it.getLong("endsAt")) }

    private fun log(a: JSONArray): List<Focus.FocusLogEntry> = (0 until a.length()).map { i ->
        val e = a.getJSONObject(i)
        Focus.FocusLogEntry(
            packId = e.getString("packId"), packName = e.getString("packName"), startedAt = e.getLong("startedAt"),
            endedAt = e.getLong("endedAt"), plannedEndsAt = e.getLong("plannedEndsAt"), stopped = e.getBoolean("stopped"),
            window = e.optBoolean("window", false),
        )
    }

    private fun optLong(a: JSONArray, i: Int): Long? = if (a.isNull(i)) null else a.getLong(i)

    @Test fun `az ismetlodo menet elofordulasa es az esedekes ablak ugyanaz, mint a gepen, UTC-ben`() {
        val cases = fixture.getJSONArray("recurrence")
        assertTrue(cases.length() >= 100, "a fixture-ben van elég eset")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val seed = c.getInt("seed")
            val now = c.getLong("now")
            val ps = packs(c.getJSONArray("packs"))
            val r = run(c, "run")
            val occ = c.getJSONArray("occ")
            for (j in 0 until occ.length()) {
                val o = occ.getJSONArray(j)
                val pack = ps.first { it.id == o.getString(0) }
                val got = Focus.occurrenceAt(pack.recurrence!!, now)
                assertEquals(optLong(o, 1), got?.startsAt, "előfordulás kezdete, ${pack.id}, mag $seed")
                assertEquals(optLong(o, 2), got?.endsAt, "előfordulás vége, ${pack.id}, mag $seed")
            }
            val due = Focus.dueRecurrence(ps, r, log(c.getJSONArray("log")), now)
            val expected = if (c.isNull("due")) null else c.getJSONArray("due").let { "${it.getString(0)}@${it.getLong(1)}-${it.getLong(2)}" }
            assertEquals(expected, due?.let { "${it.pack.id}@${it.startsAt}-${it.endsAt}" }, "esedékes ablak, mag $seed")
            if (!c.isNull("windowRun")) {
                assertEquals(c.getBoolean("windowRun"), Focus.isWindowRun(r!!, ps), "ablak-menet, mag $seed")
            }
        }
    }

    @Test fun `az ablak-menet a hatarokon ugyanaz, mint a gepen`() {
        val cases = fixture.getJSONArray("windowRun")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals(c.getBoolean("out"), Focus.isWindowRun(run(c, "run")!!, packs(c.getJSONArray("packs"))), "ablak-menet $i")
        }
    }

    @Test fun `a lezaras ugyanazt a naplosort irja, mint a gep - a 200-as vagassal`() {
        val cases = fixture.getJSONArray("close")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val n = c.getInt("logLength")
            val week = 1_790_553_600_000L // 2026-09-28 UTC, a fixtúra hete
            val old = (0 until n).map { k ->
                val at = week - (n - k).toLong() * 86_400_000L
                Focus.FocusLogEntry("p_old", "csomag p_old", at, at + 1_800_000L, at + 1_800_000L, false)
            }
            val res = Focus.closeIfEnded(run(c, "run"), packs(c.getJSONArray("packs")), old, c.getLong("now"))
            if (c.isNull("out")) {
                assertEquals(null, res, "lezárás $i: nincs teendő")
                continue
            }
            val out = c.getJSONObject("out")
            assertTrue(res != null, "lezárás $i: nem zárt le")
            assertEquals(null, res.run)
            val e = res.log.last()
            val x = out.getJSONObject("entry")
            assertEquals(x.getString("packId"), e.packId, "lezárás $i")
            assertEquals(x.getString("packName"), e.packName, "lezárás $i")
            assertEquals(x.getLong("startedAt"), e.startedAt, "lezárás $i")
            assertEquals(x.getLong("endedAt"), e.endedAt, "lezárás $i")
            assertEquals(x.getLong("plannedEndsAt"), e.plannedEndsAt, "lezárás $i")
            assertEquals(x.getBoolean("stopped"), e.stopped, "lezárás $i")
            assertEquals(x.getBoolean("window"), e.window, "lezárás $i: ablak-menet")
            assertEquals(out.getInt("logLength"), res.log.size, "lezárás $i: a napló hossza")
            assertEquals(out.getLong("first"), res.log.first().startedAt, "lezárás $i: a napló eleje")
        }
    }

    @Test fun `a legutobb hasznalt csomag ugyanaz, mint a gepen - holtversenyben az elso`() {
        val cases = fixture.getJSONArray("lastUsed")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val ids = c.getJSONArray("packs")
            val ps = (0 until ids.length()).map { Focus.FocusPack(ids.getString(it), ids.getString(it), emptyList(), emptyList(), 30) }
            val la = c.getJSONArray("log")
            val lg = (0 until la.length()).map { k ->
                val p = la.getJSONArray(k)
                Focus.FocusLogEntry(p.getString(0), p.getString(0), p.getLong(1), p.getLong(1) + 1_800_000L, p.getLong(1) + 1_800_000L, false)
            }
            val expected = if (c.isNull("out")) null else c.getString("out")
            assertEquals(expected, Focus.lastUsedPack(ps, lg)?.id, "legutóbbi csomag $i")
        }
    }

    @Test fun `a kozelgo ablak-menet ugyanaz, mint a gepen - tiz perccel elotte, a hatarokon`() {
        val cases = fixture.getJSONArray("soon")
        assertTrue(cases.length() >= 100, "a fixture-ben van elég eset")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val seed = c.getInt("seed")
            val got = Focus.windowRunStartingSoon(packs(c.getJSONArray("packs")), run(c, "run"), log(c.getJSONArray("log")), c.getLong("now"))
            val expected = if (c.isNull("out")) null else c.getJSONArray("out").let { "${it.getString(0)}@${it.getLong(1)}-${it.getLong(2)}" }
            assertEquals(expected, got?.let { "${it.pack.id}@${it.startsAt}-${it.endsAt}" }, "közelgő ablak-menet, mag $seed")
        }
    }

    @Test fun `a kozelgo ablak-menet ertesitesenek szovege ugyanaz, mint a gepen`() {
        val cases = fixture.getJSONArray("soonText")
        assertTrue(cases.length() > 0)
        for (i in 0 until cases.length()) {
            val p = cases.getJSONArray(i)
            assertEquals(p.getString(3), Focus.windowSoonText(p.getString(0), p.getLong(1), p.getString(2)), "szöveg $i")
        }
    }

    @Test fun `a hatralevo ido szovege es a percek tisztitasa ugyanaz, mint a gepen`() {
        val rem = fixture.getJSONArray("remaining")
        for (i in 0 until rem.length()) {
            val p = rem.getJSONArray(i)
            assertEquals(p.getString(1), Focus.formatRemaining(p.getLong(0)), "hátralévő ${p.getLong(0)} ms")
        }
        val mins = fixture.getJSONArray("minutes")
        for (i in 0 until mins.length()) {
            val p = mins.getJSONArray(i)
            val expected = if (p.isNull(1)) null else p.getInt(1)
            assertEquals(expected, Focus.normalizeMinutes(p.getDouble(0)), "percek ${p.get(0)}")
        }
    }
}
