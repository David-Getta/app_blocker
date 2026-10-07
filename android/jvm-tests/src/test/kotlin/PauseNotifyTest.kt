import hu.breaker.app.core.PauseNotify
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A szünet végének előrejelzése — a gép `desktop/test/pause-notify.test.ts`-ének
 * tükre: a hosszú szünet élesít és egyszer szól, a frissen indított rövidre
 * hallgat, az új vég új figyelés, a visszakapcsoltra és a lejártra csend — és
 * arról sem szól, ami a szünet végén nem zárul.
 */
class PauseNotifyTest {
    private val t = 1_800_000_000_000L
    private fun site(until: Long?, id: String = "s1", label: String = "youtube.com", closes: Boolean = true) =
        PauseNotify.View(id, label, until, closes)

    @Test
    fun `a hosszu szunet elesit, es a figyelmeztetes idejen egyszer szol`() {
        var r = PauseNotify.step(emptyMap(), listOf(site(t + 10 * 60_000)), t)
        assertTrue(r.notices.isEmpty())
        assertEquals(t + 10 * 60_000, r.watches["s1"])
        r = PauseNotify.step(r.watches, listOf(site(t + 10 * 60_000)), t + 7 * 60_000)
        assertTrue(r.notices.isEmpty())
        r = PauseNotify.step(r.watches, listOf(site(t + 10 * 60_000)), t + 8 * 60_000 + 1)
        assertEquals(listOf(PauseNotify.Notice("youtube.com", t + 10 * 60_000)), r.notices)
        assertEquals(null, r.watches["s1"])
        r = PauseNotify.step(r.watches, listOf(site(t + 10 * 60_000)), t + 9 * 60_000)
        assertTrue(r.notices.isEmpty())
    }

    @Test
    fun `a frissen inditott rovid szunetre hallgat`() {
        val r = PauseNotify.step(emptyMap(), listOf(site(t + 60_000)), t)
        assertTrue(r.notices.isEmpty())
        assertTrue(r.watches.isEmpty())
    }

    @Test
    fun `uj veg uj figyeles, a visszakapcsolt es a lejart szunetre csend`() {
        var r = PauseNotify.step(emptyMap(), listOf(site(t + 10 * 60_000)), t)
        r = PauseNotify.step(r.watches, listOf(site(t + 30 * 60_000)), t + 8 * 60_000 + 1)
        assertTrue(r.notices.isEmpty())
        assertEquals(t + 30 * 60_000, r.watches["s1"])
        r = PauseNotify.step(r.watches, listOf(site(null)), t + 9 * 60_000)
        assertTrue(r.notices.isEmpty())
        assertTrue(r.watches.isEmpty())
        r = PauseNotify.step(mapOf("s1" to t), listOf(site(t)), t + 1)
        assertTrue(r.notices.isEmpty())
    }

    @Test
    fun `a frissebb nevvel szol, es oldalankent kulon figyel`() {
        var r = PauseNotify.step(emptyMap(), listOf(site(t + 10 * 60_000), site(t + 20 * 60_000, "s2", "reddit.com")), t)
        r = PauseNotify.step(
            r.watches,
            listOf(site(t + 10 * 60_000, "s1", "Munka"), site(t + 20 * 60_000, "s2", "reddit.com")),
            t + 8 * 60_000 + 5,
        )
        assertEquals(listOf(PauseNotify.Notice("Munka", t + 10 * 60_000)), r.notices)
        assertEquals(t + 20 * 60_000, r.watches["s2"])
    }

    @Test
    fun `ami a szunet vegen nem zarul, arrol nem szol`() {
        var r = PauseNotify.step(emptyMap(), listOf(site(t + 10 * 60_000, closes = false)), t)
        assertTrue(r.watches.isEmpty(), "nem is élesít")
        r = PauseNotify.step(r.watches, listOf(site(t + 10 * 60_000, closes = false)), t + 8 * 60_000 + 1)
        assertTrue(r.notices.isEmpty())
        // Ha közben zárulóvá válik — és még van idő —, élesít, és szól.
        r = PauseNotify.step(r.watches, listOf(site(t + 20 * 60_000)), t + 10 * 60_000)
        assertEquals(t + 20 * 60_000, r.watches["s1"])
        r = PauseNotify.step(r.watches, listOf(site(t + 20 * 60_000)), t + 18 * 60_000 + 1)
        assertEquals(1, r.notices.size)
    }
}
