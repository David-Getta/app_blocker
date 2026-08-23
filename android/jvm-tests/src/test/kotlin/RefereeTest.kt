import android.content.Context
import hu.breaker.app.core.AppState
import hu.breaker.app.core.Blocklist
import hu.breaker.app.core.ChallengeEngine
import hu.breaker.app.core.ChallengeEngine.Kind
import hu.breaker.app.core.ChallengeEngine.Step
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.Referee
import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.Site
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The unlock referee: the whole point of the app is that this cannot be talked
 * out of its challenges, so it is worth testing end to end.
 * Mirrors desktop/test/referee.test.ts.
 */
class RefereeTest {

    private val now = System.currentTimeMillis()

    @BeforeTest fun reset() {
        BreakerStore.init(Context())
        BreakerStore.mutate { AppState() }
    }

    private fun addSite(domain: String): String {
        val id = BreakerStore.newId("site")
        BreakerStore.mutate { s ->
            s.copy(sites = s.sites + Site(
                id = id, domain = domain,
                hostnames = Blocklist.expandHostnames(domain, false),
                addedAt = now, pauseUntil = null, pendingDeleteAt = null,
            ))
        }
        return id
    }

    private fun currentStep(): Step {
        val s = BreakerStore.state.value.session!!
        return s.steps[s.stepIndex]
    }

    /** Answers the current step correctly; MEMORY is back-dated past its wait. */
    private fun solve(step: Step): String = when (step) {
        is Step.Transcribe -> step.text
        is Step.MathChain -> step.problems[step.pos].a.toString()
        is Step.Memory -> {
            BreakerStore.mutate { s ->
                val ses = s.session!!
                val steps = ses.steps.toMutableList()
                steps[ses.stepIndex] = step.copy(armedAt = now - step.showMs - step.waitMs - 1000)
                s.copy(session = ses.copy(steps = steps))
            }
            step.code
        }
        is Step.Reverse -> step.text.reversed()
        is Step.Delay -> error("delay steps are claimed, not answered")
    }

    private fun solveUntil(stop: (Step) -> Boolean) {
        var guard = 0
        while (BreakerStore.state.value.session != null && !stop(currentStep()) && guard++ < 200) {
            Referee.submitAnswer(BreakerStore.state.value.session!!.id, solve(currentStep()), now)
        }
    }

    @Test fun `a completed pause session pauses the site and tick re-locks it`() {
        val id = addSite("youtube.com")
        val ses = Referee.startSession(Kind.PAUSE, id, 15, now)
        assertEquals(2, ses.steps.size, "tier 0 has two active steps and no forced wait")

        solveUntil { false }
        assertNull(BreakerStore.state.value.session, "session finished")
        var site = BreakerStore.state.value.sites[0]
        assertNotNull(site.pauseUntil)
        assertTrue(site.pauseUntil!! > now)
        assertEquals(1, BreakerStore.state.value.unlockLog.size)
        assertTrue(BreakerStore.blockedHostnamesNow(now).isEmpty(), "paused -> nothing blocked")

        Referee.tick(site.pauseUntil!! + 1)
        site = BreakerStore.state.value.sites[0]
        assertNull(site.pauseUntil, "tick re-locks after the pause expires")
    }

    @Test fun `a wrong answer neither advances nor unlocks`() {
        val id = addSite("reddit.com")
        Referee.startSession(Kind.PAUSE, id, 30, now)
        val r = Referee.submitAnswer(BreakerStore.state.value.session!!.id, "biztosan nem jó", now)
        assertFalse(r.accepted)
        assertEquals(0, BreakerStore.state.value.session!!.stepIndex)
        assertNull(BreakerStore.state.value.sites[0].pauseUntil)
    }

    @Test fun `a memory code is refused until the memorise and wait window elapses`() {
        val id = addSite("x.com")
        var found = false
        for (attempt in 0 until 40) {
            BreakerStore.mutate { it.copy(session = null, lastCombo = null) }
            Referee.startSession(Kind.PAUSE, id, 15, now)
            val step = currentStep()
            if (step is Step.Memory) {
                found = true
                assertNotNull(step.armedAt, "armed when it became current")
                val res = Referee.submitAnswer(BreakerStore.state.value.session!!.id, step.code, now + 500)
                assertFalse(res.accepted, "even the correct code is premature")
                assertEquals(step.code, (currentStep() as Step.Memory).code,
                    "a premature answer must not burn the code")
                break
            }
        }
        assertTrue(found, "a MEMORY step should appear within 40 generated plans")
    }

    @Test fun `deleting ends with a forced wait and a 24h grace period`() {
        val id = addSite("tiktok.com")
        Referee.startSession(Kind.DELETE, id, null, now)
        assertTrue(BreakerStore.state.value.session!!.steps.last() is Step.Delay)

        solveUntil { it is Step.Delay }
        val delay = currentStep() as Step.Delay
        assertNotNull(delay.claimableAt)
        assertTrue(delay.claimableAt!! > now)

        assertFalse(Referee.claimDelay(BreakerStore.state.value.session!!.id, now).accepted, "too early")

        val inWindow = delay.claimableAt!! + 1000
        assertTrue(Referee.claimDelay(BreakerStore.state.value.session!!.id, inWindow).sessionDone)
        val site = BreakerStore.state.value.sites[0]
        assertNotNull(site.pendingDeleteAt)
        assertTrue(site.pendingDeleteAt!! > inWindow + 23 * 3600_000L, "~24h grace")
        assertTrue(BreakerStore.blockedHostnamesNow(inWindow).isNotEmpty(), "still blocked during grace")

        Referee.tick(site.pendingDeleteAt!! + 1)
        assertTrue(BreakerStore.state.value.sites.isEmpty(), "removed only after the grace period")
    }

    @Test fun `missing the claim window voids the whole attempt`() {
        val id = addSite("netflix.com")
        Referee.startSession(Kind.DELETE, id, null, now)
        solveUntil { it is Step.Delay }
        val delay = currentStep() as Step.Delay
        val tooLate = delay.claimableAt!! + delay.claimWindowMs + 1

        var code: String? = null
        try {
            Referee.claimDelay(BreakerStore.state.value.session!!.id, tooLate)
        } catch (e: Referee.RefereeException) {
            code = e.code
        }
        assertEquals("CLAIM_EXPIRED", code)
        assertNull(BreakerStore.state.value.session, "the attempt is void")
        assertNull(BreakerStore.state.value.sites[0].pendingDeleteAt, "and nothing was deleted")
    }

    @Test fun `tightening a schedule is free but loosening needs challenges`() {
        val id = addSite("instagram.com")
        val work = ScheduleLogic.Schedule(
            ScheduleLogic.Mode.SCHEDULED_BLOCK,
            listOf(ScheduleLogic.Band(setOf(1, 2, 3, 4, 5), 9 * 60, 17 * 60)),
        )
        // always-blocked -> only weekdays 9-17 frees up evenings: that is loosening
        val loosen = Referee.startScheduleChange(id, work, now)
        assertFalse(loosen.applied)
        assertNotNull(BreakerStore.state.value.session)
        assertNull(BreakerStore.state.value.sites[0].schedule, "not applied before the challenges")

        solveUntil { false }
        assertEquals(work, BreakerStore.state.value.sites[0].schedule, "applied once earned")
        assertNull(BreakerStore.state.value.sites[0].pauseUntil, "a schedule change is not a pause")

        val tighten = Referee.startScheduleChange(id, ScheduleLogic.ALWAYS, now)
        assertTrue(tighten.applied, "going back to always-blocked is free")
        assertNull(BreakerStore.state.value.session)
    }

    @Test fun `difficulty rises with recent unlocks`() {
        val day = 24 * 3600_000L
        assertEquals(0, ChallengeEngine.computeTier(emptyList(), now))
        assertEquals(1, ChallengeEngine.computeTier(listOf(now - day, now - 2 * day), now))
        assertEquals(3, ChallengeEngine.computeTier((1..7).map { now - it * 3600_000L }, now))
        // old unlocks decay out of the window
        assertEquals(0, ChallengeEngine.computeTier(listOf(now - 10 * day, now - 20 * day), now))
    }
    @Test fun `cancelling an attempt is not a way to re-roll an easier one`() {
        // Mirrors the desktop test: friction that can be re-rolled is not
        // friction. Giving up must hand back the same PAIR of challenges (with
        // fresh content) until the cooldown runs out.
        val id = addSite("youtube.com")
        Referee.startSession(Kind.PAUSE, id, 15, now)
        val first = BreakerStore.state.value.session!!
        val firstTypes = first.steps.map { ChallengeEngine.typeNameOf(it) }.sorted()
        val firstIds = first.steps.map { it.id }

        Referee.abandon(first.id)
        assertNull(BreakerStore.state.value.session)

        Referee.startSession(Kind.PAUSE, id, 15, now + 60_000)
        val second = BreakerStore.state.value.session!!
        assertEquals(firstTypes, second.steps.map { ChallengeEngine.typeNameOf(it) }.sorted(),
            "the same challenge types come back")
        assertFalse(second.steps.map { it.id } == firstIds, "but the content is regenerated")
        assertEquals(0, second.stepIndex, "progress is not carried over")
    }

    @Test fun `the forced combo expires with its cooldown`() {
        val id = addSite("youtube.com")
        Referee.startSession(Kind.PAUSE, id, 15, now)
        Referee.abandon(BreakerStore.state.value.session!!.id)
        val abandoned = BreakerStore.state.value.abandons.first().comboKey

        Referee.startSession(Kind.PAUSE, id, 15, now + ChallengeEngine.REROLL_COOLDOWN_MS + 60_000)
        val types = BreakerStore.state.value.session!!.steps
            .filter { it !is Step.Delay }
            .map { ChallengeEngine.typeNameOf(it) }
        assertFalse(ChallengeEngine.comboKeyOf(types) == abandoned,
            "past the cooldown the draw is free again (and variety forces a different pair)")
    }

    @Test fun `solving clears the abandon debt`() {
        val id = addSite("youtube.com")
        Referee.startSession(Kind.PAUSE, id, 15, now)
        Referee.abandon(BreakerStore.state.value.session!!.id)
        assertTrue(BreakerStore.state.value.abandons.isNotEmpty())

        Referee.startSession(Kind.PAUSE, id, 15, now + 60_000)
        var guard = 0
        while (BreakerStore.state.value.session != null && guard++ < 200) {
            val step = currentStep()
            Referee.submitAnswer(BreakerStore.state.value.session!!.id, solve(step), now + 60_000)
        }
        assertTrue(BreakerStore.state.value.abandons.isEmpty(), "solving pays the debt")
    }
    @Test fun `a cancelled attempt on another site does not clear the first site's debt`() {
        val a = addSite("youtube.com")
        val b = addSite("reddit.com")
        Referee.startSession(Kind.PAUSE, a, 15, now)
        val owed = BreakerStore.state.value.session!!.steps
            .map { ChallengeEngine.typeNameOf(it) }.sorted()
        Referee.abandon(BreakerStore.state.value.session!!.id)

        Referee.startSession(Kind.PAUSE, b, 15, now + 1000)
        Referee.abandon(BreakerStore.state.value.session!!.id)

        Referee.startSession(Kind.PAUSE, a, 15, now + 2000)
        assertEquals(owed, BreakerStore.state.value.session!!.steps
            .map { ChallengeEngine.typeNameOf(it) }.sorted(),
            "the first site still owes its own pair")
    }
    @Test fun `moving the system clock forward does not skip a waiting step`() {
        // Mirrors the desktop test: waiting IS the challenge, so a clock change
        // must not be able to finish it.
        val id = addSite("youtube.com")
        BreakerStore.mutate { s -> s.copy(unlockLog = (1..8).map { now - it * 3600_000L }) } // tier 3
        Referee.startSession(Kind.DELETE, id, null, now)
        solveUntil { it is Step.Delay }
        val before = BreakerStore.state.value.session!!.steps
            .filterIsInstance<Step.Delay>().first().claimableAt!!

        Referee.tick(now)                                  // baseline
        val jumped = now + 365L * 24 * 3600_000            // "next year", in one step
        Referee.tick(jumped)

        val after = BreakerStore.state.value.session!!.steps
            .filterIsInstance<Step.Delay>().first().claimableAt!!
        assertTrue(after > jumped, "the waiting target moved with the clock")
        assertTrue(after > before)
        val claim = Referee.claimDelay(BreakerStore.state.value.session!!.id, jumped)
        assertFalse(claim.accepted, "claiming is still refused")
    }

    @Test fun `a pending deletion cannot be rushed by the clock`() {
        val id = addSite("youtube.com")
        BreakerStore.mutate { s ->
            s.copy(sites = s.sites.map { if (it.id == id) it.copy(pendingDeleteAt = now + 24 * 3600_000L) else it })
        }
        Referee.tick(now)
        Referee.tick(now + 48 * 3600_000L)
        assertEquals(1, BreakerStore.state.value.sites.size, "the site is still there")
        assertTrue(BreakerStore.state.value.sites[0].pendingDeleteAt!! > now + 48 * 3600_000L)
    }
}
