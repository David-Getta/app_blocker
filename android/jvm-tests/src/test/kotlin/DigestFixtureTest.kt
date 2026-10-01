import hu.breaker.app.core.DigestLogic
import hu.breaker.app.core.Focus
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Megfelelőség a géppel a HETI VISSZATEKINTÉS mondatában: a
 * `fixtures/digest-cases.json` a gép mondatait tartja egy-egy hét számaira
 * (desktop/test/digest-fixture.test.ts írja és őrzi). Itt ugyanazok a számok
 * az Android mondat-írójába mennek, és a mondatnak bájtra egyeznie kell —
 * EGY kimondott szót leszámítva: a megakadás szava a platformé (a gépen a
 * böngésző, a telefonon a szűrő akaszt meg), ezt a gépére írjuk át.
 */
class DigestFixtureTest {

    private fun fixtureFile(): File {
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            val f = File(dir, "fixtures/digest-cases.json")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        error("fixtures/digest-cases.json nincs meg a tároló gyökerében")
    }

    private fun str(o: JSONObject, key: String): String? = if (o.isNull(key)) null else o.getString(key)

    private fun tops(a: JSONArray?): List<DigestLogic.Top> =
        if (a == null) emptyList() else (0 until a.length()).map { i ->
            val o = a.getJSONObject(i)
            DigestLogic.Top(o.getString("label"), o.getDouble("seconds"))
        }

    private fun summary(o: JSONObject?): Focus.FocusSummary? = o?.let {
        Focus.FocusSummary(
            sessions = it.getInt("sessions"), totalMs = it.getLong("totalMs"), stoppedEarly = it.getInt("stoppedEarly"),
            topPack = str(it, "topPack"), windowRuns = it.getInt("windowRuns"),
        )
    }

    private fun pair(o: JSONObject, key: String, a: String, b: String): Pair<Int, Int>? =
        if (o.isNull(key)) null else o.getJSONObject(key).let { Pair(it.getInt(a), it.getInt(b)) }

    /** A gép DigestInput-ja az Android Input-jává: a hiányzó mező a régi hívó alapértéke. */
    private fun input(o: JSONObject): DigestLogic.Input {
        val wow = o.getJSONArray("weekOverWeek")
        return DigestLogic.Input(
            last7Seconds = o.getDouble("last7Seconds"),
            topWeekSites = tops(o.optJSONArray("topWeekSites")),
            topWeekApps = tops(o.optJSONArray("topWeekApps")),
            weekOverWeek = (0 until wow.length()).map { i ->
                val d = wow.getJSONObject(i)
                DigestLogic.Delta(d.getString("label"), if (d.isNull("deltaPct")) null else d.getDouble("deltaPct"))
            },
            focusWeek = summary(o.getJSONObject("focusWeek"))!!,
            focusPrevWeek = summary(o.optJSONObject("focusPrevWeek")),
            unlocks7d = o.getInt("unlocks7d"),
            unlocksPrev7d = o.optInt("unlocksPrev7d", 0),
            daysTracked = o.getInt("daysTracked"),
            dropped7d = o.optInt("dropped7d", 0),
            limitFullDays = o.optInt("limitFullDays", 0),
            burstTripsWeek = o.optInt("burstTripsWeek", 0),
            filterHits7d = o.optInt("browserHits7d", 0),
            filterHitsPrev7d = o.optInt("browserHitsPrev7d", 0),
            filterHitsPeak = pair(o, "browserHitsPeak", "hour", "count"),
            filterHitsPeakPack = str(o, "browserHitsPeakPack"),
            peakWindowOffer = o.optBoolean("peakWindowOffer", false),
            filterHitsWeekday = pair(o, "browserHitsWeekday", "day", "count"),
            focusWeekday = pair(o, "focusWeekday", "day", "count"),
            usageWeekday = pair(o, "usageWeekday", "day", "count"),
            focusHour = pair(o, "focusHour", "hour", "count"),
            focusStreak = o.optInt("focusStreak", 0),
            focusLongestStreak = o.optInt("focusLongestStreak", 0),
            focusHourPack = str(o, "focusHourPack"),
            focusHourWindowOffer = o.optBoolean("focusHourWindowOffer", false),
            filterHitsTop = if (o.isNull("browserHitsTop")) null else o.getJSONObject("browserHitsTop").let {
                Pair(it.getString("label"), it.getInt("count"))
            },
            unblockedTop = tops(o.optJSONArray("unblockedTop")),
        )
    }

    @Test fun `a heti visszatekintes mondata ugyanaz, mint a gepen - a megakadas szavat leszamitva`() {
        val cases = JSONObject(fixtureFile().readText()).getJSONArray("cases")
        assertTrue(cases.length() >= 60, "a fixture-ben van elég eset")
        var sentences = 0
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val seed = c.getInt("seed")
            val expected = str(c, "text")
            // A platform szava: a gépen a böngésző-bővítmény, a telefonon a DNS-szűrő akaszt meg.
            val got = DigestLogic.text(input(c.getJSONObject("input"))) { "[$it]" }?.replace(" a szűrőben", " a böngészőben")
            assertEquals(expected, got, "visszatekintés, mag $seed")
            if (got != null) sentences++
        }
        assertTrue(sentences > 30, "kevés mondat — a fixtúra elfajult")
    }
}
