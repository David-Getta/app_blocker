import android.content.Context
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.Focus
import hu.breaker.app.core.Referee
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A munkamenet indítása és leállítása a telefonon.
 *
 * A súrlódás iránya itt is ugyanaz, mint mindenhol: INDÍTANI és HOSSZABBÍTANI
 * ingyen van, RÖVIDÍTENI és LEÁLLÍTANI próbatétel. Ha ez elcsúszna, a
 * munkamenet egy „mégsem” gomb lenne — és pont az a lényeg, hogy ne az legyen.
 */
class FocusRefereeTest {

    private val now = 1_800_000_000_000L

    @BeforeTest
    fun reset() {
        BreakerStore.init(Context())
        BreakerStore.mutate {
            it.copy(
                sites = emptyList(), session = null, unlockLog = emptyList(),
                abandons = emptyList(), focusRun = null,
                focusPacks = listOf(
                    Focus.FocusPack(
                        id = "p1", name = "Nyelvtanulás",
                        allowSites = listOf("quizlet.com"), allowApps = listOf("Word"),
                        defaultMinutes = 50,
                    ),
                ),
            )
        }
    }

    @Test
    fun `az inditas ingyen van, es tudja, mikor er veget`() {
        Referee.startFocus("p1", 43, now)
        val run = BreakerStore.state.value.focusRun
        assertNotNull(run)
        assertEquals("p1", run.packId)
        assertEquals(now + 43 * 60_000L, run.endsAt)
        assertNull(BreakerStore.state.value.session, "indításhoz nem jár próbatétel")
    }

    @Test
    fun `egy masodik menet nem indithato az elso megkerulesere`() {
        // Enélkül a leállítás próbatételét meg lehetne kerülni: indítok egy
        // „minden engedve” csomagot, és kész.
        Referee.startFocus("p1", 50, now)
        assertFailsWith<Referee.RefereeException> { Referee.startFocus("p1", 50, now + 1_000) }
    }

    @Test
    fun `a hosszabbitas azonnal megy, a rovidites probatetel`() {
        Referee.startFocus("p1", 50, now)
        val end = BreakerStore.state.value.focusRun!!.endsAt

        val longer = Referee.changeFocus(end + 10 * 60_000L, now)
        assertTrue(longer.applied, "hosszabbítani ingyen van")
        assertNull(longer.session)
        assertEquals(end + 10 * 60_000L, BreakerStore.state.value.focusRun!!.endsAt)

        val shorter = Referee.changeFocus(end, now)
        assertTrue(!shorter.applied, "rövidíteni nem")
        assertNotNull(shorter.session)
    }

    @Test
    fun `a leallitas probatetelt inditt, es a menet addig ervenyes marad`() {
        Referee.startFocus("p1", 50, now)
        val r = Referee.changeFocus(null, now)
        assertTrue(!r.applied)
        assertNotNull(r.session)
        assertEquals(-1L, r.session.pendingFocusEnd, "a -1 jelenti: állítsd le most")
        assertNotNull(
            BreakerStore.state.value.focusRun,
            "amíg a próbatétel megy, a munkamenet ÉRVÉNYES — különben a puszta " +
                "kérés feloldás lenne",
        )
    }

    @Test
    fun `nem futo menetet nem lehet megvaltoztatni`() {
        assertFailsWith<Referee.RefereeException> { Referee.changeFocus(null, now) }
    }

    @Test
    fun `ismeretlen csomagbol nem indul menet`() {
        assertFailsWith<Referee.RefereeException> { Referee.startFocus("nincs-ilyen", 50, now) }
    }
}
