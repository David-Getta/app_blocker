import hu.breaker.app.core.AppState
import hu.breaker.app.core.Focus
import hu.breaker.app.core.FocusSync
import hu.breaker.app.core.SyncRevisions
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A munkamenet szinkronja Androidon.
 *
 * A tesztek SZÁNDÉKOSAN úgy állítják be a döntetlen-eltörést, hogy az utolsó
 * írót előnyben részesítő szabály a ROSSZ oldalt választaná. Enélkül egy elrontott
 * összefésülés mellett is átmennének, és pont azt nem vennék észre, ami ellen
 * készültek.
 */
class FocusSyncTest {

    private fun pack(id: String = "p1") = Focus.FocusPack(
        id = id, name = "Nyelvtanulás",
        allowSites = listOf("quizlet.com"), allowApps = listOf("Word"), defaultMinutes = 50,
    )

    @Test
    fun `a futo menetet egy nem futo allapot nem kapcsolja ki`() {
        val running = FocusSync.SyncFocus(
            packs = listOf(pack()),
            run = Focus.FocusRun("p1", 0, 10_000),
            rev = 4, updatedAt = 100, updatedBy = "eszkoz-a",
        )
        // Az újabb ÉS a később rendezett azonosító az üres oldalé.
        val stale = FocusSync.SyncFocus(
            packs = listOf(pack()), run = null, rev = 4, updatedAt = 500, updatedBy = "eszkoz-z",
        )
        assertEquals(running.run, FocusSync.merge(running, stale).run)
        assertEquals(running.run, FocusSync.merge(stale, running).run)
    }

    @Test
    fun `a leallitas nagyobb rev-vel atmegy`() {
        val running = FocusSync.SyncFocus(
            packs = listOf(pack()), run = Focus.FocusRun("p1", 0, 10_000),
            rev = 4, updatedAt = 100, updatedBy = "eszkoz-a",
        )
        val stopped = FocusSync.SyncFocus(
            packs = listOf(pack()), run = null, rev = 5, updatedAt = 110, updatedBy = "eszkoz-b",
        )
        assertNull(FocusSync.merge(running, stopped).run)
        assertNull(FocusSync.merge(stopped, running).run)
    }

    @Test
    fun `a hosszabbitas azonos rev mellett is nyer`() {
        val shorter = FocusSync.SyncFocus(
            packs = listOf(pack()), run = Focus.FocusRun("p1", 0, 5_000),
            rev = 2, updatedAt = 500, updatedBy = "eszkoz-z",
        )
        val longer = FocusSync.SyncFocus(
            packs = listOf(pack()), run = Focus.FocusRun("p1", 0, 9_000),
            rev = 2, updatedAt = 100, updatedBy = "eszkoz-a",
        )
        assertEquals(9_000, FocusSync.merge(shorter, longer).run?.endsAt)
        assertEquals(9_000, FocusSync.merge(longer, shorter).run?.endsAt)
    }

    @Test
    fun `az osszefesules sorrendfuggetlen es idempotens`() {
        val a = FocusSync.SyncFocus(packs = listOf(pack("p1")), rev = 3, updatedAt = 100, updatedBy = "a")
        val b = FocusSync.SyncFocus(packs = listOf(pack("p2")), rev = 3, updatedAt = 100, updatedBy = "b")
        assertTrue(FocusSync.same(FocusSync.merge(a, b), FocusSync.merge(b, a)))
        val once = FocusSync.merge(a, b)
        assertTrue(FocusSync.same(FocusSync.merge(once, b), once))
    }

    @Test
    fun `a futas kiesik, ha a csomagja nincs meg`() {
        // Nem tippelünk: egy futás ismeretlen csomaggal azt jelentené, hogy
        // tiltunk mindent, és nem tudjuk megmondani, mi az, ami mehet.
        assertNull(FocusSync.cleanRun(Focus.FocusRun("nincs", 0, 9_000), listOf(pack("p1"))))
        assertEquals("p1", FocusSync.cleanRun(Focus.FocusRun("p1", 0, 9_000), listOf(pack("p1")))?.packId)
    }

    @Test
    fun `az ures allapot nem lepteti a szamlalot`() {
        // EZ A LÉNYEG. Ha léptetne, a telefon az első szinkronnál a semmiből
        // 1-es számlálót kapna, az ideje frissebb lenne a gépénél, és az ÜRES
        // listája nyerne — csendben letörölve a gépen felvett összes csomagot.
        val fresh = AppState()
        val after = SyncRevisions.bumpFocus(fresh, "telefon", 1_000)
        assertEquals(0, after.focusRev, "egy üres eszköz 0-n marad")
        assertNotEquals(null, after.focusRevFp, "de a lenyomatot már ismeri")

        // Egy VALÓDI változás viszont léptet.
        val withPack = after.copy(focusPacks = listOf(pack()))
        val bumped = SyncRevisions.bumpFocus(withPack, "telefon", 2_000)
        assertEquals(1, bumped.focusRev)
        assertEquals(2_000, bumped.focusUpdatedAt)

        // Változatlan állapot nem léptet újra — enélkül a két eszköz örökké
        // írogatná egymást.
        assertEquals(bumped, SyncRevisions.bumpFocus(bumped, "telefon", 3_000))
    }

    @Test
    fun `az indulo menet is lepteti a szamlalot`() {
        // Ha a futás kimaradna a lenyomatból, az indítás sosem léptetne, és a
        // másik eszköz soha nem tudná meg, hogy fut valami.
        val withPack = SyncRevisions.bumpFocus(
            AppState().copy(focusPacks = listOf(pack())), "gep", 1_000,
        )
        val started = withPack.copy(focusRun = Focus.FocusRun("p1", 1_000, 9_000))
        val bumped = SyncRevisions.bumpFocus(started, "gep", 2_000)
        assertEquals(withPack.focusRev + 1, bumped.focusRev)
    }
}
