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
 * az utolsó kör ideje az objektumban él, a tesztek között is. És a többi
 * tesztosztály ideje (1 800 000 000 000 ≈ 2027. január 15.) UTÁN vannak:
 * ha előttük lennének, egy utánunk futó osztály első köre négy hónapos
 * óra-ugrást látna, és eltolná a saját függő törlését.
 */
class FocusRecurrenceRefereeTest {

    private fun at(y: Int, m: Int, d: Int, h: Int, min: Int = 0): Long =
        Calendar.getInstance().apply { clear(); set(y, m - 1, d, h, min) }.timeInMillis

    // 2027. március 1. hétfő, 9–12.
    private val mon9 = at(2027, 3, 1,9)
    private val mon12 = at(2027, 3, 1,12)

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
        Referee.tick(at(2027, 3, 1,8, 59))
        assertNull(BreakerStore.state.value.focusRun, "az ablak előtt semmi")
        Referee.tick(at(2027, 3, 1,9, 30))
        val run = BreakerStore.state.value.focusRun
        assertNotNull(run)
        assertEquals("p1", run.packId)
        assertEquals(mon9, run.startedAt, "a kezdés az ablaké — a gép ugyanezt állítja elő")
        assertEquals(mon12, run.endsAt)
    }

    @Test
    fun `a leallitott ablak-menet nem indul ujra ugyanabban az ablakban`() {
        Referee.tick(at(2027, 3, 1,9, 31))
        assertNotNull(BreakerStore.state.value.focusRun)
        // A próbatétel utáni leállítás nyoma: a napló sora, ami ebben az
        // ablakban kezdődött. (A próbatétel maga a RefereeTest dolga.)
        BreakerStore.mutate {
            val run = it.focusRun!!
            it.copy(
                focusRun = null,
                focusLog = it.focusLog + Focus.closeRun(run, "Mély munka", at(2027, 3, 1,9, 40), true),
            )
        }
        Referee.tick(at(2027, 3, 1,9, 45))
        assertNull(BreakerStore.state.value.focusRun, "a napló az őr")
        Referee.tick(at(2027, 3, 2,9, 30))
        assertEquals(at(2027, 3, 2,9), BreakerStore.state.value.focusRun?.startedAt, "másnap újra")
    }

    @Test
    fun `egy masik csomag kezi menete az ablak kezdeten veget er, a sajate nem`() {
        // 2027. március 3. szerda és 4. csütörtök — a többi teszt ideje UTÁN.
        BreakerStore.mutate {
            it.copy(
                focusPacks = it.focusPacks + Focus.FocusPack(
                    id = "p2", name = "Más", allowSites = emptyList(), allowApps = emptyList(), defaultMinutes = 50,
                ),
            )
        }
        // Az óra-ugrás elnyelése miatt előbb egy üres kör: a napnyi ugrást ne a
        // kézi menet nyelje el. Utána rendes ütemben.
        Referee.tick(at(2027, 3, 3, 8, 58))
        // Egy nyolcórás, eldobható menet 8:59-kor — eddig az egész ablakot kiváltotta.
        Referee.startFocus("p2", 480, at(2027, 3, 3, 8, 59))
        Referee.tick(at(2027, 3, 3, 9, 0))
        Referee.tick(at(2027, 3, 3, 9, 1))
        val run = BreakerStore.state.value.focusRun
        assertEquals("p1", run?.packId, "az ablak jött, a másik csomag menete véget ért")
        assertEquals(at(2027, 3, 3, 9), run?.startedAt)
        val last = BreakerStore.state.value.focusLog.last()
        assertEquals("p2", last.packId)
        // A 9:00-s kör zárta le: a naplóba az ablak kezdetével, nem a következő körrel.
        assertEquals(at(2027, 3, 3, 9, 0), last.endedAt, "a naplóba a saját idejével")
        assertEquals(false, last.stopped, "nem leállítva: az ablak jött")

        // A saját csomag kézi menete nem szakad meg, és nem is költi el az ablakot.
        BreakerStore.mutate { it.copy(focusRun = null) }
        Referee.tick(at(2027, 3, 4, 8, 59))
        Referee.startFocus("p1", 5, at(2027, 3, 4, 9) + 5_000)
        Referee.tick(at(2027, 3, 4, 9) + 20_000)
        assertEquals(at(2027, 3, 4, 9) + 5_000, BreakerStore.state.value.focusRun?.startedAt, "a kézi menet marad")
        for (m in 1..6) Referee.tick(at(2027, 3, 4, 9, m))
        val window = BreakerStore.state.value.focusRun
        assertEquals(at(2027, 3, 4, 9), window?.startedAt, "a kézi menet után az ablak menete indul, az ablak kezdésével")
        assertEquals(at(2027, 3, 4, 12), window?.endsAt)
    }

    @Test
    fun `az ora-ugras az ablak-menetet nem tolja el`() {
        Referee.tick(at(2027, 3, 1,9, 32))
        // Egy órás lyuk a körök között: alvás vagy átállított óra — a telefon
        // nem tudja, és nem is kell tudnia.
        Referee.tick(at(2027, 3, 1,10, 30))
        val run = BreakerStore.state.value.focusRun
        assertNotNull(run)
        assertEquals(mon9, run.startedAt)
        assertEquals(mon12, run.endsAt, "az ablak vége az ablak vége")
    }
}
