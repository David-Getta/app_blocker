import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.SyncClient
import hu.breaker.app.core.SyncMerge
import org.json.JSONArray
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A dróton menő alak.
 *
 * A mezőnevek és a menetrend-módok SZÖVEGESEN egyeznek a TypeScript oldallal.
 * Egy elgépelés itt nem fordítási hiba lenne, hanem csendes félreértés a másik
 * eszközön: a gép például „mindig tiltva”-ként olvasná azt, amit a telefon
 * munkaidős menetrendnek szánt — vagy fordítva.
 */
class SyncWireFormatTest {

    private val work = ScheduleLogic.Schedule(
        ScheduleLogic.Mode.SCHEDULED_BLOCK,
        listOf(ScheduleLogic.Band(setOf(1, 2, 3, 4, 5), 9 * 60, 17 * 60)),
    )

    @Test
    fun `the uploaded shape matches what the other cores expect`() {
        val json = SyncClient.sitesToJson(listOf(SyncMerge.SyncSite(
            id = "s1", domain = "youtube.com", hostnames = listOf("youtube.com", "youtu.be"),
            addedAt = 1_000, pendingDeleteAt = 2_000, schedule = work,
            dailyLimitSeconds = 600, alias = "A videós",
            rev = 3, updatedAt = 4_000, updatedBy = "telefon",
        )))
        val o = JSONArray(json).getJSONObject(0)

        assertEquals("youtube.com", o.getString("domain"))
        assertEquals(2, o.getJSONArray("hostnames").length())
        assertEquals(2_000L, o.getLong("pendingDeleteAt"))
        assertEquals(600L, o.getLong("dailyLimitSeconds"))
        assertEquals("A videós", o.getString("alias"))
        assertEquals(3, o.getInt("rev"))
        assertEquals("telefon", o.getString("updatedBy"))

        // A menetrend módja a TS-ben használt SZÖVEG, nem a Kotlin enum neve.
        assertEquals("scheduled_block", o.getJSONObject("schedule").getString("mode"))

        // A szünet fel se megy: mindig null. Egy próbatétel egy eszközön nem
        // oldhat fel mindenhol.
        assertTrue(o.isNull("pauseUntil"), "a szünet nem mehet fel")
    }

    @Test
    fun `what we write, we can read back`() {
        val original = SyncMerge.SyncSite(
            id = "s1", domain = "youtube.com", hostnames = listOf("youtube.com"),
            addedAt = 1_000, pendingDeleteAt = null, schedule = work,
            dailyLimitSeconds = null, alias = null,
            rev = 2, updatedAt = 3_000, updatedBy = "telefon",
        )
        val back = SyncClient.sitesFromJson(SyncClient.sitesToJson(listOf(original)))
        assertEquals(listOf(original), back)
    }

    @Test
    fun `an unknown schedule mode is read as always blocked`() {
        // A bizonytalanság a TILTÁS felé dől: egy újabb verzió által írt,
        // ismeretlen mód nem oldhat fel semmit.
        val json = """[{"id":"s1","domain":"x.com","hostnames":["x.com"],"addedAt":1,
            "pendingDeleteAt":null,"schedule":{"mode":"jovobeli_mod","bands":[]},"rev":1}]"""
        val back = SyncClient.sitesFromJson(json)
        assertEquals(ScheduleLogic.Mode.ALWAYS, back[0].schedule?.mode)
    }

    @Test
    fun `a broken record is skipped, the rest still loads`() {
        val json = """[{"nincs":"id"},{"id":"s2","domain":"y.com","hostnames":["y.com"],
            "addedAt":2,"pendingDeleteAt":null,"rev":1}]"""
        val back = SyncClient.sitesFromJson(json)
        assertEquals(listOf("s2"), back.map { it.id })
    }
}
