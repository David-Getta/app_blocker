import android.content.Context
import hu.breaker.app.core.AppState
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.Focus
import hu.breaker.app.core.Referee
import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.SyncRevisions
import org.json.JSONObject
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * ABLAK A CSÚCS-ÓRÁRA a telefonról — a gépi gomb tükre, és vele az első
 * csomag-szerkesztés a telefonon: a sáv, a jelölt, a bíró (csak felvesz), a
 * csomag jele a léptetésben, és a mentés.
 */
class PeakWindowTest {

    private val now = 1_800_000_000_000L
    private val pack = Focus.FocusPack("p1", "Nyelvtanulás", listOf("quizlet.com"), listOf("Word"), 50)
    private val band21 = Focus.peakWindowBand(21)

    @BeforeTest
    fun reset() {
        BreakerStore.init(Context())
        BreakerStore.mutate {
            it.copy(sites = emptyList(), session = null, focusRun = null, focusLog = emptyList(), focusPacks = listOf(pack))
        }
        BreakerStore.saveLastTick(0)
    }

    @Test
    fun `a sav a csucs egy oraja minden napra - a 23 vege a nap vege`() {
        assertEquals(ScheduleLogic.Band(setOf(0, 1, 2, 3, 4, 5, 6), 21 * 60, 22 * 60), band21)
        assertEquals(1440, Focus.peakWindowBand(23).endMin, "a nap vége, nem nulla — különben átfordulna")
        assertEquals(0, Focus.peakWindowBand(0).startMin)
        assertEquals(23 * 60, Focus.peakWindowBand(99).startMin, "a tartományba szorítva")
        assertNotNull(Focus.cleanRecurrence(band21), "a bíró elfogadja")
    }

    @Test
    fun `a jelolt - van csucs, nincs fedes, nem fut menet, es a csomagnak nincs meg ablaka`() {
        assertEquals(pack to band21, Focus.peakWindowPick(listOf(pack), emptyList(), null, 21, now))
        assertNull(Focus.peakWindowPick(listOf(pack), emptyList(), null, null, now), "csúcs nélkül nincs gomb")
        assertNull(Focus.peakWindowPick(emptyList(), emptyList(), null, 21, now), "csomag nélkül nincs gomb")
        val covered = pack.copy(recurrence = ScheduleLogic.Band(setOf(1), 21 * 60 + 30, 23 * 60))
        assertNull(Focus.peakWindowPick(listOf(covered), emptyList(), null, 21, now), "fedett csúcs-órára a sor mondja, gomb nincs")
        val windowed = pack.copy(recurrence = ScheduleLogic.Band(setOf(1, 2), 9 * 60, 10 * 60))
        assertNull(Focus.peakWindowPick(listOf(windowed), emptyList(), null, 21, now), "ablakos csomagot a telefon nem cserél")
        val run = Focus.FocusRun("p1", now - 60_000, now + 60_000)
        assertNull(Focus.peakWindowPick(listOf(pack), emptyList(), run, 21, now), "futó menet mellett nincs gomb")
        assertEquals(pack to band21, Focus.peakWindowPick(listOf(pack), emptyList(), run, 21, now + 120_000), "lejárt menet után van")
    }

    @Test
    fun `a biro felvesz ingyen - ablakos, futo es ismeretlen csomagra nem, rossz savot nem`() {
        Referee.addFocusWindow("p1", band21, now)
        val st = BreakerStore.state.value
        assertEquals(band21, st.focusPacks.single().recurrence)
        assertNull(st.session, "felvenni nem próbatétel")
        assertEquals("HAS_WINDOW", assertFailsWith<Referee.RefereeException> { Referee.addFocusWindow("p1", Focus.peakWindowBand(9), now) }.code, "a telefon csak felvesz")
        assertEquals("NO_PACK", assertFailsWith<Referee.RefereeException> { Referee.addFocusWindow("nincs", band21, now) }.code)
        BreakerStore.mutate { it.copy(focusPacks = listOf(pack)) }
        assertEquals("BAD_RECURRENCE", assertFailsWith<Referee.RefereeException> { Referee.addFocusWindow("p1", ScheduleLogic.Band(emptySet(), 540, 720), now) }.code)
        assertEquals("BAD_RECURRENCE", assertFailsWith<Referee.RefereeException> { Referee.addFocusWindow("p1", ScheduleLogic.Band(setOf(1), 0, 1440), now) }.code, "huszonnégy órás ablak nem menet")
        Referee.startFocus("p1", 25, now)
        assertEquals("FOCUS_RUNNING", assertFailsWith<Referee.RefereeException> { Referee.addFocusWindow("p1", band21, now + 1) }.code, "a futó csomag befagy")
        assertNull(BreakerStore.state.value.focusPacks.single().recurrence, "a visszautasított hívás nem ír")
    }

    @Test
    fun `a csomag jele - a telefon szerkesztese is jelet ir, az elso leptetes es az atvetel nem`() {
        var st = SyncRevisions.bumpFocus(AppState(focusPacks = listOf(pack)), "telefon", now)
        assertEquals(1L, st.focusRev)
        assertNull(st.focusPackMarks, "az első léptetés jel nélkül megy")
        assertEquals(setOf("p1"), st.focusRevPacks?.keys)
        st = SyncRevisions.bumpFocus(st.copy(focusPacks = listOf(pack.copy(recurrence = band21))), "telefon", now + 1)
        assertEquals(2L, st.focusRev)
        assertEquals(mapOf("p1" to 2), st.focusPackMarks, "a szerkesztett csomag jele az új rev")
        st = SyncRevisions.bumpFocus(st.copy(focusRun = Focus.FocusRun("p1", now + 2, now + 2 + 25 * 60_000L)), "telefon", now + 2)
        assertEquals(3L, st.focusRev)
        assertEquals(mapOf("p1" to 2), st.focusPackMarks, "a menet indítása nem csomag-jel")
        val other = Focus.FocusPack("p2", "Írás", emptyList(), emptyList(), 25)
        val adopted = SyncRevisions.adoptFocus(
            st.copy(focusPacks = listOf(pack.copy(recurrence = band21), other), focusPackMarks = mapOf("p1" to 7, "p2" to 7)),
        )
        assertEquals(adopted, SyncRevisions.bumpFocus(adopted, "telefon", now + 3), "az átvétel nem szerkesztés")
        val removed = SyncRevisions.bumpFocus(adopted.copy(focusPacks = listOf(pack.copy(recurrence = band21)), focusRun = null), "telefon", now + 4)
        assertEquals(mapOf("p1" to 7, "p2" to 4), removed.focusPackMarks, "a kikerült csomag jele az új rev — sírkő")
    }

    @Test
    fun `a mentes - a lenyomat tuleli, a regi fajlban nincs`() {
        val toJson = BreakerStore::class.java.getDeclaredMethod("toJson", AppState::class.java).apply { isAccessible = true }
        val fromJson = BreakerStore::class.java.getDeclaredMethod("fromJson", JSONObject::class.java).apply { isAccessible = true }
        val st = AppState(focusPacks = listOf(pack), focusRevPacks = mapOf("p1" to "abcd1234"), focusPackMarks = mapOf("p1" to 3))
        val back = fromJson.invoke(BreakerStore, JSONObject(toJson.invoke(BreakerStore, st).toString())) as AppState
        assertEquals(mapOf("p1" to "abcd1234"), back.focusRevPacks)
        assertEquals(mapOf("p1" to 3), back.focusPackMarks)
        val old = fromJson.invoke(BreakerStore, JSONObject("{\"sites\":[]}")) as AppState
        assertNull(old.focusRevPacks)
    }
}
