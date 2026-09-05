import android.content.Context
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.Focus
import hu.breaker.app.core.Referee
import hu.breaker.app.core.ScheduleLogic
import java.util.Calendar
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * A heti ablak a telefonon: a `Referee.tick` indítja, az ablak kezdésével és
 * végével, és a napló őrzi az újraindítás ellen — a
 * `focus-recurrence.test.ts` referee-eseteinek tükre. A mag (Focus.kt) külön
 * tesztelve; ez a BEKÖTÉST nézi, amit csak itt lehet: az előszűrőt, a
 * tizenöt másodperces szeletet és az óra-ugrás kivételét.
 *
 * Az időpontok tesztenként mások, mert a tick tizenöt másodperces szelete és
 * az utolsó kör ideje az objektumban él, a tesztek között is.
 */
class FocusRecurrenceRefereeTest {

    private fun at(y: Int, m: Int, d: Int, h: Int, min: Int = 0): Long =
        Calendar.getInstance().apply { clear(); set(y, m - 1, d, h, min) }.timeInMillis

    // 2026. szeptember 7. hétfő, 9–12.
    private val mon9 = at(2026, 9, 7, 9)
    private val mon12 = at(2026, 9, 7, 12)

    @BeforeTest
    fun reset() {
        BreakerStore.init(Context())
        BreakerStore.mutate {
            it.copy(
                sites = emptyList(), session = null, unlockLog = emptyList(),
                abandons = emptyList(), focusRun = null, focusLog = emptyList(),
                focusPacks = listOf(
                    Focus.FocusPack(
                        id = "p1", name = "Mély munka", allowSites = listOf("github.com"),
                        allowApps = emptyList(), defaultMinutes = 50,
                        recurrence = ScheduleLogic.Band(setOf(1, 2, 3, 4, 5), 9 * 60, 12 * 60),
                    ),
                ),
            )
        }
    }

    @Test
    fun `a tick az ablakban inditja a menetet, az ablak idejevel`() {
        Referee.tick(at(2026, 9, 7, 8, 59))
        assertNull(BreakerStore.state.value.focusRun, "az ablak előtt semmi")
        Referee.tick(at(2026, 9, 7, 9, 30))
        val run = BreakerStore.state.value.focusRun
        assertNotNull(run)
        assertEquals("p1", run.packId)
        assertEquals(mon9, run.startedAt, "a kezdés az ablaké — a gép ugyanezt állítja elő")
        assertEquals(mon12, run.endsAt)
    }

    @Test
    fun `a leallitott ablak-menet nem indul ujra ugyanabban az ablakban`() {
        Referee.tick(at(2026, 9, 7, 9, 31))
        assertNotNull(BreakerStore.state.value.focusRun)
        // A próbatétel utáni leállítás nyoma: a napló sora, ami ebben az
        // ablakban kezdődött. (A próbatétel maga a RefereeTest dolga.)
        BreakerStore.mutate {
            val run = it.focusRun!!
            it.copy(
                focusRun = null,
                focusLog = it.focusLog + Focus.closeRun(run, "Mély munka", at(2026, 9, 7, 9, 40), true),
            )
        }
        Referee.tick(at(2026, 9, 7, 9, 45))
        assertNull(BreakerStore.state.value.focusRun, "a napló az őr")
        Referee.tick(at(2026, 9, 8, 9, 30))
        assertEquals(at(2026, 9, 8, 9), BreakerStore.state.value.focusRun?.startedAt, "másnap újra")
    }

    @Test
    fun `az ora-ugras az ablak-menetet nem tolja el`() {
        Referee.tick(at(2026, 9, 7, 9, 32))
        // Egy órás lyuk a körök között: alvás vagy átállított óra — a telefon
        // nem tudja, és nem is kell tudnia.
        Referee.tick(at(2026, 9, 7, 10, 30))
        val run = BreakerStore.state.value.focusRun
        assertNotNull(run)
        assertEquals(mon9, run.startedAt)
        assertEquals(mon12, run.endsAt, "az ablak vége az ablak vége")
    }
}
