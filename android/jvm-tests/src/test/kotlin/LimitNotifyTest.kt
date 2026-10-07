import hu.breaker.app.core.LimitLogic
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A napi keret végének előrejelzése — a gép `desktop/test/limit-notify.test.ts`-ének
 * tükre: a küszöb átlépésekor egyszer szól a „ma még” sor mondatával, az induláskor
 * már fogyó keretre hallgat, új napon tiszta lappal indul.
 */
class LimitNotifyTest {
    private fun site(used: Double, limit: Long? = 1800, id: String = "s1", label: String = "youtube.com", paused: Boolean = false) =
        LimitLogic.LimitView(id, label, limit, used, paused)

    @Test
    fun `a kuszob atlepesekor egyszer szol`() {
        var r = LimitLogic.stepNotices(emptyMap(), listOf(site(600.0)), "2026-10-07")
        assertTrue(r.notices.isEmpty())
        assertEquals(true, r.watches["s1"]?.armed)
        r = LimitLogic.stepNotices(r.watches, listOf(site(1260.0)), "2026-10-07")
        assertEquals(listOf(LimitLogic.LimitNotice("youtube.com", "Ma még 9 perc a kereted: youtube.com.")), r.notices)
        r = LimitLogic.stepNotices(r.watches, listOf(site(1500.0)), "2026-10-07")
        assertTrue(r.notices.isEmpty())
    }

    @Test
    fun `az indulaskor mar fogyo keretre hallgat, a beteltre sem szol`() {
        var r = LimitLogic.stepNotices(emptyMap(), listOf(site(1500.0)), "2026-10-07")
        assertTrue(r.notices.isEmpty())
        assertEquals(false, r.watches["s1"]?.armed)
        r = LimitLogic.stepNotices(r.watches, listOf(site(1800.0)), "2026-10-07")
        assertTrue(r.notices.isEmpty())
    }

    @Test
    fun `uj napon tiszta lap`() {
        var r = LimitLogic.stepNotices(emptyMap(), listOf(site(600.0)), "2026-10-07")
        r = LimitLogic.stepNotices(r.watches, listOf(site(1300.0)), "2026-10-07")
        assertEquals(1, r.notices.size)
        r = LimitLogic.stepNotices(r.watches, listOf(site(0.0)), "2026-10-08")
        assertTrue(r.notices.isEmpty())
        assertEquals(LimitLogic.LimitWatch("2026-10-08", armed = true, told = false), r.watches["s1"])
        r = LimitLogic.stepNotices(r.watches, listOf(site(1300.0)), "2026-10-08")
        assertEquals(1, r.notices.size)
    }

    @Test
    fun `kis keretnel a fele a kuszob, keret nelkul nincs figyeles`() {
        var r = LimitLogic.stepNotices(emptyMap(), listOf(site(100.0, 300)), "2026-10-07")
        assertTrue(r.notices.isEmpty())
        r = LimitLogic.stepNotices(r.watches, listOf(site(160.0, 300)), "2026-10-07")
        assertEquals(listOf(LimitLogic.LimitNotice("youtube.com", "Ma még 3 perc a kereted: youtube.com.")), r.notices)
        val none = LimitLogic.stepNotices(emptyMap(), listOf(site(100.0, null)), "2026-10-07")
        assertTrue(none.watches.isEmpty())
    }

    @Test
    fun `szunet alatt hallgat, de a figyeles megmarad - a szunet utan szol`() {
        var r = LimitLogic.stepNotices(emptyMap(), listOf(site(600.0)), "2026-10-07")
        r = LimitLogic.stepNotices(r.watches, listOf(site(1260.0, paused = true)), "2026-10-07")
        assertTrue(r.notices.isEmpty(), "a kifizetett szünet a keretet is legyőzi: a fogyás most nem zárás")
        assertEquals(LimitLogic.LimitWatch("2026-10-07", armed = true, told = false), r.watches["s1"])
        r = LimitLogic.stepNotices(r.watches, listOf(site(1320.0)), "2026-10-07")
        assertEquals(listOf(LimitLogic.LimitNotice("youtube.com", "Ma még 8 perc a kereted: youtube.com.")), r.notices)
    }
}
