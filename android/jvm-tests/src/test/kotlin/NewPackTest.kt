import android.content.Context
import hu.breaker.app.core.AppState
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.Focus
import hu.breaker.app.core.FocusSync
import hu.breaker.app.core.Referee
import hu.breaker.app.core.SyncRevisions
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** CSOMAG FELVÉTELE a telefonon — csak felvétel: a bíró tisztít, a plafon áll, a jel a léptetésben. */
class NewPackTest {

    @BeforeTest
    fun reset() {
        BreakerStore.init(Context())
        BreakerStore.mutate {
            it.copy(sites = emptyList(), session = null, focusRun = null, focusLog = emptyList(), focusPacks = emptyList())
        }
        BreakerStore.saveLastTick(0)
    }

    @Test
    fun `a biro felvesz - a nev tisztan, az oldalak a lista magjan at, a hossz a plafonig`() {
        val p = Referee.addFocusPack("  Nyelv   tanulás  ", listOf("Quizlet.com", "translate.google.com", "quizlet.com", "", "nem érvényes ..."), 900)
        assertTrue(p.id.startsWith("pack_"))
        assertEquals("Nyelv tanulás", p.name)
        assertEquals(listOf("quizlet.com", "translate.google.com"), p.allowSites, "tisztán, kétszer nem, a rossz kimarad")
        assertEquals(Focus.MAX_SESSION_MINUTES, p.defaultMinutes, "a plafonig")
        assertEquals(listOf(p), BreakerStore.state.value.focusPacks)
        assertEquals("BAD_NAME", assertFailsWith<Referee.RefereeException> { Referee.addFocusPack("   ", emptyList(), 25) }.code)
        assertEquals("BAD_MINUTES", assertFailsWith<Referee.RefereeException> { Referee.addFocusPack("Írás", emptyList(), 0) }.code)
        assertEquals(1, BreakerStore.state.value.focusPacks.size, "a visszautasított hívás nem ír")
    }

    @Test
    fun `a plafon - harmincnal tobb csomag nem fer`() {
        repeat(FocusSync.MAX_PACKS) { Referee.addFocusPack("Csomag $it", emptyList(), 25) }
        assertEquals("TOO_MANY_PACKS", assertFailsWith<Referee.RefereeException> { Referee.addFocusPack("Sok", emptyList(), 25) }.code)
        assertEquals(FocusSync.MAX_PACKS, BreakerStore.state.value.focusPacks.size)
    }

    @Test
    fun `a jel - a telefonon felvett csomag a kovetkezo leptetesben jelet kap`() {
        val old = Focus.FocusPack("p0", "Régi", emptyList(), emptyList(), 25)
        val base = SyncRevisions.adoptFocus(SyncRevisions.bumpFocus(AppState(focusPacks = listOf(old)), "telefon", 1_000L))
        val added = base.copy(focusPacks = base.focusPacks + Focus.FocusPack("pack_uj", "Új", emptyList(), emptyList(), 25))
        val bumped = SyncRevisions.bumpFocus(added, "telefon", 2_000L)
        assertEquals(bumped.focusRev.toInt(), bumped.focusPackMarks?.get("pack_uj"), "az új csomag jele az új rev")
        assertEquals(null, bumped.focusPackMarks?.get("p0"), "a régi csomag jel nélkül marad")
    }
}
