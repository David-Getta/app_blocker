import hu.breaker.app.core.LimitLogic
import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.Site
import hu.breaker.app.core.UsageLogic
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A napi keret eszközök között KÖZÖS — a desktop/test/shared-limit.test.ts párja.
 *
 * Enélkül a „napi 20 perc YouTube” két eszközön negyven percet jelentett, és a
 * keret nem keret volt, hanem javaslat. A tesztek arra a két kimenetelre
 * mennek, amitől a funkció rosszabb lenne, mint a hiánya:
 *
 *   1. a saját időnk kétszer számít (a keret feleakkora lesz, mint beállított),
 *   2. egy másik eszköz régi vagy szemét adata megeszi a mai keretet.
 */
class SharedLimitTest {

    private val now = System.currentTimeMillis()
    private val yesterday = now - 24L * 3600_000L

    private fun usageWith(domain: String, seconds: Double, at: Long = now): UsageLogic.UsageState {
        val u = UsageLogic.UsageState()
        u.days.add(UsageLogic.UsageDay(
            UsageLogic.dayKey(at),
            mutableMapOf(UsageLogic.siteKey(domain) to seconds),
        ))
        return u
    }

    /**
     * Menetrend, ami MOST enged: így a döntést tényleg a keret hozza.
     *
     * Menetrend nélkül az oldal mindig tiltva van, és a teszt akkor is zöld
     * lenne, ha a közös keretből egy szó sem működne.
     */
    private val free = ScheduleLogic.Schedule(
        ScheduleLogic.Mode.SCHEDULED_BLOCK,
        listOf(ScheduleLogic.Band(setOf(0, 1, 2, 3, 4, 5, 6), 0, 1)),
    )
    /** Éjfél után egy perccel a fenti sáv MÉGIS tilt; ilyenkor ez az igazság. */
    private val blockedByBand = ScheduleLogic.isBlockedNow(null, null, free, now)

    private fun site(limit: Long? = null, pauseUntil: Long? = null) = Site(
        id = "s1", domain = "youtube.com", hostnames = listOf("youtube.com"), addedAt = 0,
        pauseUntil = pauseUntil, pendingDeleteAt = null, dailyLimitSeconds = limit,
        schedule = free,
    )

    private fun shared(
        vararg devices: Triple<String, String, Map<String, Double>>,
    ) = LimitLogic.SharedToday(
        selfDeviceId = "ez-a-gep",
        devices = devices.map { LimitLogic.TodayDigest(it.first, it.second, it.third) },
    )

    private fun phone(seconds: Double, day: String = UsageLogic.dayKey(now)) =
        shared(Triple("telefon", day, mapOf(UsageLogic.siteKey("youtube.com") to seconds)))

    @Test
    fun `the budget is one budget, not one per device`() {
        // Ez a funkció lényege. Tizenkét perc itt, tíz perc a gépen: a húsz
        // perces keret elfogyott, pedig egyik eszközön sem érte el egyedül.
        val s = site(limit = 1200)
        val here = usageWith("youtube.com", 720.0)
        assertFalse(LimitLogic.isLimitExhausted("youtube.com", 1200, here, now), "egyedül még nem")
        assertEquals(blockedByBand, LimitLogic.isBlockedNowWithLimit(s, here, now),
            "keret alatt csak a menetrend dönt")
        assertTrue(LimitLogic.isBlockedNowWithLimit(s, here, now, phone(600.0)), "együtt igen")
        assertEquals(1320.0, LimitLogic.usedTodayEverywhere(here, phone(600.0), "youtube.com", now))
    }

    @Test
    fun `our own row never counts twice`() {
        // A kiszolgáló a MI összegzésünket is visszaadja. Ha az bekerülne,
        // minden percünk kétszer számítana: a húsz perces keret tíz perc után
        // fogyna el, és a felhasználó jogosan gondolná, hogy az app hibás.
        val here = usageWith("youtube.com", 600.0)
        val withSelf = shared(
            Triple("ez-a-gep", UsageLogic.dayKey(now), mapOf(UsageLogic.siteKey("youtube.com") to 600.0)),
        )
        assertEquals(0.0, LimitLogic.sharedTodaySeconds(withSelf, "youtube.com", now))
        assertEquals(600.0, LimitLogic.usedTodayEverywhere(here, withSelf, "youtube.com", now))
    }

    @Test
    fun `another device's yesterday is not our today`() {
        // A másik eszköz a SAJÁT naptári napját írja. Ha nem néznénk, egy másik
        // időzónában lévő gép tegnapi órái ma azonnal elégetnék a keretet.
        val stale = phone(99999.0, day = UsageLogic.dayKey(yesterday))
        assertEquals(0.0, LimitLogic.sharedTodaySeconds(stale, "youtube.com", now))
        assertFalse(LimitLogic.isLimitExhausted("youtube.com", 600, UsageLogic.UsageState(), now, stale))
    }

    @Test
    fun `without sync the app behaves exactly as before`() {
        // Ha a szinkron áll, nem lehet sem lazább, sem szigorúbb.
        val s = site(limit = 1200)
        assertTrue(LimitLogic.isBlockedNowWithLimit(s, usageWith("youtube.com", 1300.0), now, null))
        val empty = LimitLogic.SharedToday("ez-a-gep", emptyList())
        for (none in listOf(null, empty)) {
            assertEquals(blockedByBand,
                LimitLogic.isBlockedNowWithLimit(s, usageWith("youtube.com", 10.0), now, none),
                "szinkron nélkül a keret alatt csak a menetrend dönt")
        }
    }

    @Test
    fun `a remote digest can only tighten, never loosen`() {
        // A távoli szám csak HOZZÁAD. Ezért nem baj, hogy nem tudjuk
        // ellenőrizni, honnan jött: a legrosszabb, amit tehet, hogy hamarabb tilt.
        val here = usageWith("youtube.com", 1300.0)
        val zero = shared(Triple("telefon", UsageLogic.dayKey(now), emptyMap()))
        assertTrue(LimitLogic.isBlockedNowWithLimit(site(limit = 1200), here, now, zero))

        // És a kiérdemelt feloldás továbbra is erősebb mindennél.
        val paused = site(limit = 1200, pauseUntil = now + 60_000)
        assertFalse(LimitLogic.isBlockedNowWithLimit(paused, here, now, phone(9999.0)))
    }

    @Test
    fun `only this site's seconds are taken from the other device`() {
        val other = shared(
            Triple("telefon", UsageLogic.dayKey(now), mapOf(UsageLogic.siteKey("reddit.com") to 5000.0)),
        )
        assertEquals(0.0, LimitLogic.sharedTodaySeconds(other, "youtube.com", now))
        assertEquals(5000.0, LimitLogic.sharedTodaySeconds(other, "reddit.com", now))
    }

    @Test
    fun `the digest we upload is today only, and small`() {
        val u = UsageLogic.UsageState()
        u.days.add(UsageLogic.UsageDay(
            UsageLogic.dayKey(yesterday), mutableMapOf(UsageLogic.siteKey("youtube.com") to 5000.0),
        ))
        u.days.add(UsageLogic.UsageDay(
            UsageLogic.dayKey(now), mutableMapOf(UsageLogic.siteKey("youtube.com") to 120.6),
        ))
        val d = LimitLogic.makeTodayDigest(u, "ez-a-gep", now)
        assertEquals(UsageLogic.dayKey(now), d.day)
        assertEquals(mapOf(UsageLogic.siteKey("youtube.com") to 121.0), d.seconds)

        val many = UsageLogic.UsageState()
        val seconds = mutableMapOf<String, Double>()
        for (i in 0 until 500) seconds["site:x$i.hu"] = (i + 1).toDouble()
        many.days.add(UsageLogic.UsageDay(UsageLogic.dayKey(now), seconds))
        val big = LimitLogic.makeTodayDigest(many, "ez-a-gep", now)
        assertEquals(200, big.seconds.size)
        assertEquals(500.0, big.seconds["site:x499.hu"], "a legnagyobb tétel biztosan bent van")
        assertNull(big.seconds["site:x0.hu"])
    }

    @Test
    fun `a nonsense digest cannot eat the budget`() {
        // Ez kívülről jött adat. Ha egy sor „egy hónapnyi” másodpercet
        // állítana, a keret azonnal elfogyna — a felhasználó pedig csak annyit
        // látna, hogy az app indok nélkül tilt.
        val d = LimitLogic.normalizeTodayDigest(
            UsageLogic.dayKey(now),
            mapOf(
                UsageLogic.siteKey("youtube.com") to 30.0 * 24 * 3600,
                UsageLogic.siteKey("reddit.com") to -5.0,
                "" to 10.0,
            ),
            "telefon",
        )
        assertNotNull(d)
        assertEquals("telefon", d.deviceId)
        assertEquals(24.0 * 3600, d.seconds[UsageLogic.siteKey("youtube.com")], "egy nap a felső korlát")
        assertNull(d.seconds[UsageLogic.siteKey("reddit.com")])
        assertNull(d.seconds[""])

        assertNull(LimitLogic.normalizeTodayDigest(null, emptyMap(), "telefon"))
        assertNull(LimitLogic.normalizeTodayDigest("tegnap", emptyMap(), "telefon"))
        assertNull(LimitLogic.normalizeTodayDigest("2026-5-1", emptyMap(), "telefon"))
    }

    @Test
    fun `the device id comes from the server, not from the blob`() {
        // Enélkül egy eszköz a MÁSIK nevében beszélhetne — például a miénkében,
        // és akkor a saját sorunk kiszűrése nem érne semmit.
        val d = LimitLogic.normalizeTodayDigest(UsageLogic.dayKey(now), emptyMap(), "telefon")
        assertEquals("telefon", d?.deviceId)
    }
}
