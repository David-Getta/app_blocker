import hu.breaker.app.core.Focus
import hu.breaker.app.core.ScheduleLogic
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Megfelelőség a géppel az ÓRAÁTÁLLÍTÁS éjszakáján: a `fixtures/dst-cases.json`
 * a gép döntéseit tartja (desktop/test/dst-fixture.test.ts írja és őrzi),
 * Europe/Budapest időzónában — a hajnali sávok előfordulását és a menetrend
 * döntését a 2026-os tavaszi és őszi átállás körül. Ha az Android a kétszer
 * előforduló 2:30-at a második előfordulásra tenné, mint a Java naptára
 * magától, egy hajnali heti ablak itt egy órával később indulna, mint a gépen.
 */
class DstFixtureTest {
    private fun fixtureFile(): File {
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            val f = File(dir, "fixtures/dst-cases.json")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        error("fixtures/dst-cases.json nincs meg a tároló gyökerében")
    }

    private fun band(o: JSONObject): ScheduleLogic.Band {
        val days = o.getJSONArray("days")
        return ScheduleLogic.Band((0 until days.length()).map { days.getInt(it) }.toSet(), o.getInt("startMin"), o.getInt("endMin"))
    }

    private fun pair(c: JSONObject, key: String): String? =
        if (c.isNull(key)) null else c.getJSONArray(key).let { "${it.getLong(0)}-${it.getLong(1)}" }

    @Test fun `az oraatallitas ejszakajan az elofordulas es a menetrend dontese ugyanaz, mint a gepen`() {
        val saved = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("Europe/Budapest"))
        try {
            val f = JSONObject(fixtureFile().readText())
            assertEquals("Europe/Budapest", f.getString("tz"))
            val cases: JSONArray = f.getJSONArray("cases")
            assertTrue(cases.length() > 200, "a fixture-ben van elég eset")
            val misses = mutableListOf<String>()
            for (i in 0 until cases.length()) {
                val c = cases.getJSONObject(i)
                val b = band(c.getJSONObject("band"))
                val t = c.getLong("t")
                val occ = Focus.occurrenceAt(b, t)?.let { "${it.startsAt}-${it.endsAt}" }
                val next = Focus.nextOccurrence(b, t)?.let { "${it.startsAt}-${it.endsAt}" }
                val s = ScheduleLogic.Schedule(ScheduleLogic.Mode.SCHEDULED_BLOCK, listOf(b))
                val got = listOf(occ, next, ScheduleLogic.isBlockedBySchedule(s, t), ScheduleLogic.nextCloseAt(s, t), ScheduleLogic.nextOpenAt(s, t))
                val want = listOf(pair(c, "occ"), pair(c, "next"), c.getBoolean("blocked"), c.getLong("close"), c.getLong("open"))
                if (got != want) misses.add("eset $i (sáv ${b.days} ${b.startMin}–${b.endMin}, t=$t): gép $want, Android $got")
            }
            assertTrue(misses.isEmpty(), "${misses.size} eltérés:\n" + misses.take(12).joinToString("\n"))
        } finally {
            TimeZone.setDefault(saved)
        }
    }
}
