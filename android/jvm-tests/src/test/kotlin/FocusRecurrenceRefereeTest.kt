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
        // FRISS TELEPÍTÉS: a karbantartó kör alapvonala is nullázódik — a szám
        // a tárban él (hogy az app kilövése ne felejtse el), tehát a tesztek
        // között is átjárna.
        BreakerStore.saveLastTick(0)
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
    fun `egy masik csomag menetet az ablak nem allitja le, hanem raretegzodik, a sajate sem szakad meg`() {
        // 2027. március 3. szerda, 4. csütörtök és 5. péntek — a többi teszt
        // ideje UTÁN.
        BreakerStore.mutate {
            it.copy(
                focusPacks = it.focusPacks + Focus.FocusPack(
                    id = "p2", name = "Más", allowSites = listOf("github.com", "youtube.com"),
                    allowApps = emptyList(), defaultMinutes = 50,
                ) + Focus.FocusPack(
                    id = "p3", name = "Laza", allowSites = listOf("youtube.com"),
                    allowApps = emptyList(), defaultMinutes = 50,
                ),
            )
        }
        // Az óra-ugrás elnyelése miatt előbb egy üres kör: a napnyi ugrást ne a
        // kézi menet nyelje el. Utána rendes ütemben.
        Referee.tick(at(2027, 3, 3, 8, 58))
        // Eddig az ablak a kezdetén lezárta a másik menetet — és mivel ablakot
        // felvenni ingyen van, egy most kezdődő ablak így próbatétel nélkül
        // véget vetett egy hosszú menetnek. Most rárétegződik.
        Referee.startFocus("p2", 60, at(2027, 3, 3, 8, 59))
        Referee.tick(at(2027, 3, 3, 9, 0))
        Referee.tick(at(2027, 3, 3, 9, 1))
        assertEquals("p2", BreakerStore.state.value.focusRun?.packId, "a futó menet marad")
        assertEquals(emptyList(), BreakerStore.state.value.focusLog, "semmi nem zárult le")
        val eff = BreakerStore.runningFocusPack(at(2027, 3, 3, 9, 1))
        assertEquals("p2", eff?.id, "a neve és a hossza a futó menetéé")
        assertEquals(listOf("github.com"), eff?.allowSites, "amíg az ablak tart, csak a közös")
        // A menet végén az ablak menete indul — onnan, ahol a másik véget ért,
        // az ablak végéig; az azonossága az ablak kezdete.
        for (m in 2..60) Referee.tick(at(2027, 3, 3, 9) + m * 60_000L)
        val window = BreakerStore.state.value.focusRun
        assertEquals("p1", window?.packId)
        assertEquals(at(2027, 3, 3, 9, 59), window?.startedAt, "ott, ahol a másik véget ért")
        assertEquals(at(2027, 3, 3, 12), window?.endsAt)
        assertEquals(at(2027, 3, 3, 9), window?.origin, "az azonossága az ablak kezdete")
        assertEquals(true, Focus.isWindowRun(window!!, BreakerStore.state.value.focusPacks))
        val last = BreakerStore.state.value.focusLog.last()
        assertEquals("p2", last.packId)
        assertEquals(at(2027, 3, 3, 9, 59), last.endedAt, "a másik menet a saját idejéig tartott")
        assertEquals(false, last.stopped)

        // Egy 8:59-kor indított, nyolcórás laza menet sem váltja ki az ablakot:
        // alatta a metszet él, utána a saját listája.
        BreakerStore.mutate { it.copy(focusRun = null) }
        Referee.tick(at(2027, 3, 4, 8, 58))
        Referee.startFocus("p3", 480, at(2027, 3, 4, 8, 59))
        Referee.tick(at(2027, 3, 4, 9, 0))
        Referee.tick(at(2027, 3, 4, 9, 1))
        assertEquals("p3", BreakerStore.state.value.focusRun?.packId)
        assertEquals(emptyList(), BreakerStore.runningFocusPack(at(2027, 3, 4, 9, 1))?.allowSites,
            "a laza csomag listájából az ablak alatt semmi nem marad")
        assertEquals(listOf("youtube.com"), BreakerStore.runningFocusPack(at(2027, 3, 4, 12, 1))?.allowSites,
            "az ablak után a saját listája")

        // A saját csomag kézi menete nem szakad meg, és nem is költi el az ablakot.
        BreakerStore.mutate { it.copy(focusRun = null) }
        Referee.tick(at(2027, 3, 5, 8, 59))
        Referee.startFocus("p1", 5, at(2027, 3, 5, 9) + 5_000)
        Referee.tick(at(2027, 3, 5, 9) + 20_000)
        assertEquals(at(2027, 3, 5, 9) + 5_000, BreakerStore.state.value.focusRun?.startedAt, "a kézi menet marad")
        for (m in 1..6) Referee.tick(at(2027, 3, 5, 9, m))
        val own = BreakerStore.state.value.focusRun
        assertEquals(at(2027, 3, 5, 9) + 305_000, own?.startedAt,
            "a kézi menet után az ablak menete indul — ott, ahol a kézi véget ért")
        assertEquals(at(2027, 3, 5, 9), own?.origin)
        assertEquals(at(2027, 3, 5, 12), own?.endsAt)
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
