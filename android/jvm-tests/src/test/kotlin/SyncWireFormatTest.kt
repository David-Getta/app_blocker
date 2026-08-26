import hu.breaker.app.core.Focus
import hu.breaker.app.core.FocusSync
import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.SyncClient
import hu.breaker.app.core.SyncMerge
import org.json.JSONArray
import org.json.JSONObject
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

    // -----------------------------------------------------------------------
    // A MUNKAMENET dróton menő alakja. Eddig ezt semmi nem fedte, pedig a
    // szinkron itt is szöveges mezőnevekre épül: egy `planned` a
    // `plannedEndsAt` helyett nem fordítási hiba lenne, hanem CSENDES
    // félreértés. A gép egyszerűen eldobná a mezőt, és minden telefonon
    // lezárult menet úgy jelenne meg, mintha végigvitted volna — a
    // statisztika arról hazudna, ami a felhasználót a legjobban érdekli.

    @Test
    fun `a munkamenet feltoltott alakja az, amit a tobbi mag var`() {
        val json = SyncClient.focusToJson(FocusSync.SyncFocus(
            packs = listOf(Focus.FocusPack(
                id = "p1", name = "Nyelvtanulás",
                allowSites = listOf("quizlet.com"), allowApps = listOf("Word"),
                defaultMinutes = 50,
            )),
            run = Focus.FocusRun("p1", 1_000, 4_000),
            log = listOf(Focus.FocusLogEntry(
                packId = "p1", packName = "Nyelvtanulás",
                startedAt = 100, endedAt = 700, plannedEndsAt = 900, stopped = true,
            )),
            rev = 3, updatedAt = 5_000, updatedBy = "telefon",
        ))
        val o = JSONObject(json)

        val pack = o.getJSONArray("packs").getJSONObject(0)
        assertEquals("p1", pack.getString("id"))
        assertEquals("Nyelvtanulás", pack.getString("name"))
        assertEquals(1, pack.getJSONArray("allowSites").length())
        assertEquals(1, pack.getJSONArray("allowApps").length())
        assertEquals(50, pack.getInt("defaultMinutes"))

        val run = o.getJSONObject("run")
        assertEquals("p1", run.getString("packId"))
        assertEquals(1_000L, run.getLong("startedAt"))
        assertEquals(4_000L, run.getLong("endsAt"))

        // A NAPLÓ minden mezője. A `packName` azért van benne, mert a csomag
        // azóta átnevezhető vagy törölhető; a `plannedEndsAt` azért, mert
        // ebből derül ki, hogy korábban ért-e véget.
        val row = o.getJSONArray("log").getJSONObject(0)
        assertEquals("p1", row.getString("packId"))
        assertEquals("Nyelvtanulás", row.getString("packName"))
        assertEquals(100L, row.getLong("startedAt"))
        assertEquals(700L, row.getLong("endedAt"))
        assertEquals(900L, row.getLong("plannedEndsAt"))
        assertTrue(row.getBoolean("stopped"))

        assertEquals(3L, o.getLong("rev"))
        assertEquals("telefon", o.getString("updatedBy"))
    }

    @Test
    fun `a munkamenetet vissza is tudjuk olvasni, amit kiirtunk`() {
        val original = FocusSync.SyncFocus(
            packs = listOf(Focus.FocusPack(
                id = "p1", name = "Nyelvtanulás",
                allowSites = listOf("quizlet.com"), allowApps = emptyList(),
                defaultMinutes = 50,
            )),
            run = Focus.FocusRun("p1", 1_000, 4_000),
            log = listOf(
                Focus.FocusLogEntry("p1", "Nyelvtanulás", 100, 700, 900, true),
                Focus.FocusLogEntry("p1", "Nyelvtanulás", 2_000, 2_600, 2_600, false),
            ),
            rev = 3, updatedAt = 5_000, updatedBy = "telefon",
        )
        val back = SyncClient.focusFromJson(SyncClient.focusToJson(original), "masik")
        assertEquals(original.packs, back.packs)
        assertEquals(original.run, back.run)
        assertEquals(original.log, back.log, "a napló egy az egyben visszajön")
        assertEquals(original.rev, back.rev)
        assertEquals(original.updatedBy, back.updatedBy)
    }

    @Test
    fun `a naplo nelkuli regi blob nem hasal el`() {
        // Egy MÉG NEM FRISSÜLT gép blobjában nincs `log` mező. Ha ettől az
        // egész munkamenet-szinkron elhasalna, a telefon üres állapotra esne
        // vissza, és a felhasználó azt látná, hogy a csomagjai eltűntek.
        val regi = """{"packs":[],"run":null,"rev":2,"updatedAt":9,"updatedBy":"gep"}"""
        val back = SyncClient.focusFromJson(regi, "masik")
        assertEquals(emptyList(), back.log)
        assertEquals(2L, back.rev)
        assertEquals("gep", back.updatedBy)
    }
}
