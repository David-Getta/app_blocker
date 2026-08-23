import android.content.Context
import hu.breaker.app.core.AppState
import hu.breaker.app.core.Blocklist
import hu.breaker.app.core.ChallengeEngine.Kind
import hu.breaker.app.core.ChallengeEngine.Step
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.LimitLogic
import hu.breaker.app.core.Referee
import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.Site
import hu.breaker.app.core.UsageLogic
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Napi időkeret — a desktop/test/limits.test.ts tükre, plusz az Androidon
 * külön létező megkerülési utak (mérés kikapcsolása, keret-emelés).
 */
class LimitsTest {

    private val now = System.currentTimeMillis()

    @BeforeTest fun reset() {
        BreakerStore.init(Context())
        BreakerStore.mutate { AppState() }
    }

    private fun usageWith(domain: String, seconds: Double, at: Long = now): UsageLogic.UsageState {
        val u = UsageLogic.UsageState()
        u.days.add(UsageLogic.UsageDay(
            UsageLogic.dayKey(at),
            mutableMapOf(UsageLogic.siteKey(domain) to seconds),
        ))
        return u
    }

    private fun site(
        domain: String = "youtube.com",
        limit: Long? = null,
        pauseUntil: Long? = null,
        pendingDeleteAt: Long? = null,
        schedule: ScheduleLogic.Schedule? = null,
    ) = Site(
        id = "site_test", domain = domain, hostnames = Blocklist.expandHostnames(domain, false),
        addedAt = now, pauseUntil = pauseUntil, pendingDeleteAt = pendingDeleteAt,
        schedule = schedule, dailyLimitSeconds = limit,
    )

    // ------------------------------------------------------------ pure logic

    @Test fun `a site with no budget is unaffected by it`() {
        assertFalse(LimitLogic.isLimitExhausted("youtube.com", null, usageWith("youtube.com", 9999.0), now))
        assertEquals(0.0, LimitLogic.usedTodaySeconds(UsageLogic.UsageState(), "youtube.com", now))
    }

    @Test fun `the budget blocks once today's active time reaches it`() {
        assertFalse(LimitLogic.isLimitExhausted("youtube.com", 1200, usageWith("youtube.com", 1199.0), now))
        assertTrue(LimitLogic.isLimitExhausted("youtube.com", 1200, usageWith("youtube.com", 1200.0), now),
            "elérni is elég, nem kell túllépni")
        assertTrue(LimitLogic.isLimitExhausted("youtube.com", 1200, usageWith("youtube.com", 5000.0), now))
    }

    @Test fun `yesterday's time does not count against today`() {
        val yesterday = now - 24 * 3600_000L
        assertFalse(
            LimitLogic.isLimitExhausted("youtube.com", 600, usageWith("youtube.com", 5000.0, yesterday), now),
            "a keret éjfélkor újraindul",
        )
    }

    @Test fun `only this site's own time counts`() {
        assertFalse(LimitLogic.isLimitExhausted("youtube.com", 600, usageWith("reddit.com", 5000.0), now))
    }

    @Test fun `an exhausted budget blocks even when the schedule would allow it`() {
        // scheduled_block egy olyan sávval, ami biztosan nem most van: menetrend
        // szerint szabad, tehát csak a keret dönthet.
        val free = ScheduleLogic.Schedule(
            ScheduleLogic.Mode.SCHEDULED_BLOCK,
            listOf(ScheduleLogic.Band(setOf(0, 1, 2, 3, 4, 5, 6), 0, 1)),
        )
        val s = site(limit = 600, schedule = free)
        val blockedByBand = ScheduleLogic.isBlockedNow(null, null, free, now)
        assertEquals(blockedByBand, LimitLogic.isBlockedNowWithLimit(s, usageWith("youtube.com", 100.0), now),
            "keret alatt csak a menetrend dönt")
        assertTrue(LimitLogic.isBlockedNowWithLimit(s, usageWith("youtube.com", 600.0), now),
            "elfogyott keret akkor is tilt, ha a menetrend engedné")
    }

    @Test fun `an unlock the user earned still wins over the budget`() {
        // A szünetet próbatételekkel fizette ki; ha egy elfogyott keret csendben
        // felülírná, az a fizetséget tenné értéktelenné.
        val s = site(limit = 600, pauseUntil = now + 60_000)
        assertFalse(LimitLogic.isBlockedNowWithLimit(s, usageWith("youtube.com", 99999.0), now))
    }

    @Test fun `a pending deletion still blocks regardless of the budget`() {
        val s = site(limit = 600, pendingDeleteAt = now + 3600_000)
        assertTrue(LimitLogic.isBlockedNowWithLimit(s, usageWith("youtube.com", 0.0), now))
    }

    @Test fun `tightening the budget is free, loosening is not`() {
        assertFalse(LimitLogic.isLimitLoosening(null, 600), "keret bevezetése szigorítás")
        assertFalse(LimitLogic.isLimitLoosening(1200, 600), "kevesebb idő szigorítás")
        assertFalse(LimitLogic.isLimitLoosening(600, 600), "változatlan nem lazítás")
        assertTrue(LimitLogic.isLimitLoosening(600, 1200), "több időt meg kell szolgálni")
        assertTrue(LimitLogic.isLimitLoosening(600, null), "keret levétele az egész napot felszabadítja")
        assertTrue(LimitLogic.isLimitLoosening(600, 0), "a 0 = nincs keret, tehát levétel")
    }

    @Test fun `nonsense budgets are treated as no budget, and a day is the ceiling`() {
        assertNull(LimitLogic.normalizeLimit(null))
        assertNull(LimitLogic.normalizeLimit(0))
        assertNull(LimitLogic.normalizeLimit(-5))
        assertEquals(1200L, LimitLogic.normalizeLimit(1200))
        assertEquals(24L * 3600L, LimitLogic.normalizeLimit(99L * 3600L))
    }

    // ------------------------------------------------------- referee + store

    private fun addSite(domain: String, limit: Long? = null): String {
        val id = BreakerStore.newId("site")
        BreakerStore.mutate { s ->
            s.copy(sites = s.sites + Site(
                id = id, domain = domain, hostnames = Blocklist.expandHostnames(domain, false),
                addedAt = now, pauseUntil = null, pendingDeleteAt = null, dailyLimitSeconds = limit,
            ))
        }
        return id
    }

    private fun siteById(id: String): Site = BreakerStore.state.value.sites.first { it.id == id }

    /** A folyó kísérlet megoldása végig — a MEMORY lépést visszadátumozza. */
    private fun solveSession() {
        var guard = 0
        while (BreakerStore.state.value.session != null && guard++ < 200) {
            val ses = BreakerStore.state.value.session!!
            val step = ses.steps[ses.stepIndex]
            val answer = when (step) {
                is Step.Transcribe -> step.text
                is Step.MathChain -> step.problems[step.pos].a.toString()
                is Step.Memory -> {
                    BreakerStore.mutate { s ->
                        val cur = s.session!!
                        val steps = cur.steps.toMutableList()
                        steps[cur.stepIndex] = step.copy(armedAt = now - step.showMs - step.waitMs - 1000)
                        s.copy(session = cur.copy(steps = steps))
                    }
                    step.code
                }
                is Step.Reverse -> step.text.reversed()
                is Step.Delay -> {
                    // A várakozást a bíró időzíti; a teszt a nyitott ablakban vesz át.
                    Referee.claimDelay(ses.id, step.claimableAt!! + 1000)
                    continue
                }
            }
            Referee.submitAnswer(ses.id, answer, now)
        }
    }

    @Test fun `introducing or lowering a budget applies at once`() {
        val id = addSite("youtube.com")
        val introduced = Referee.startLimitChange(id, 1200, now)
        assertTrue(introduced.applied, "keret bevezetése azonnal érvényes")
        assertNull(BreakerStore.state.value.session, "nem indít próbatételt")
        assertEquals(1200L, siteById(id).dailyLimitSeconds)

        val lowered = Referee.startLimitChange(id, 600, now)
        assertTrue(lowered.applied)
        assertEquals(600L, siteById(id).dailyLimitSeconds)
    }

    @Test fun `raising a budget takes challenges and only lands when they are done`() {
        val id = addSite("youtube.com", limit = 600)
        val r = Referee.startLimitChange(id, 3600, now)
        assertFalse(r.applied, "emelés nem érvényes azonnal")
        assertNotNull(BreakerStore.state.value.session, "próbatétel indult")
        assertEquals(600L, siteById(id).dailyLimitSeconds, "a keret a kísérlet alatt még a régi")

        solveSession()
        assertNull(BreakerStore.state.value.session)
        assertEquals(3600L, siteById(id).dailyLimitSeconds, "a kísérlet végén lép életbe")
    }

    @Test fun `abandoning the challenge leaves the budget where it was`() {
        val id = addSite("youtube.com", limit = 600)
        Referee.startLimitChange(id, 3600, now)
        Referee.abandon(BreakerStore.state.value.session!!.id)
        assertNull(BreakerStore.state.value.session)
        assertEquals(600L, siteById(id).dailyLimitSeconds, "feladott kísérlet semmit nem változtat")
    }

    @Test fun `removing a budget takes challenges too`() {
        val id = addSite("youtube.com", limit = 600)
        val r = Referee.startLimitChange(id, null, now)
        assertFalse(r.applied)
        solveSession()
        assertNull(siteById(id).dailyLimitSeconds, "a -1 jelzés levételt jelent, nem 0 másodperces keretet")
    }

    @Test fun `a raise cannot be smuggled in while another attempt is running`() {
        val id = addSite("youtube.com", limit = 600)
        Referee.startSession(Kind.PAUSE, id, 15, now)
        val e = assertFailsWith<Referee.RefereeException> { Referee.startLimitChange(id, 3600, now) }
        assertEquals("BUSY", e.code)
    }

    @Test fun `measurement cannot be switched off while a budget exists`() {
        val id = addSite("youtube.com", limit = 600)
        val e = assertFailsWith<Referee.RefereeException> { Referee.setUsageEnabled(false) }
        assertEquals("LIMIT_NEEDS_USAGE", e.code)
        assertTrue(BreakerStore.state.value.usage.enabled, "a mérés bekapcsolva maradt")

        // Keret nélkül viszont a saját adatáról a felhasználó dönt.
        Referee.startLimitChange(id, null, now)
        solveSession()
        Referee.setUsageEnabled(false)
        assertFalse(BreakerStore.state.value.usage.enabled)
    }

    @Test fun `an exhausted budget actually pulls the hostnames into the blocklist`() {
        val id = addSite("youtube.com", limit = 600)
        BreakerStore.mutate { s ->
            val u = UsageLogic.snapshot(s.usage)
            UsageLogic.recordSample(u, UsageLogic.siteKey("youtube.com"), 900.0, now)
            s.copy(usage = u)
        }
        val blocked = BreakerStore.blockedHostnamesNow(now)
        assertTrue(blocked.containsAll(siteById(id).hostnames),
            "a keret elfogyott, tehát a DNS-szűrőnek is tiltania kell")
    }
}
