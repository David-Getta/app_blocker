import android.content.Context
import hu.lakat.app.core.AppState
import hu.lakat.app.core.Blocklist
import hu.lakat.app.core.ChallengeEngine
import hu.lakat.app.core.ChallengeEngine.Kind
import hu.lakat.app.core.ChallengeEngine.Step
import hu.lakat.app.core.LakatStore
import hu.lakat.app.core.Referee
import hu.lakat.app.core.ScheduleLogic
import hu.lakat.app.core.Site
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
        LakatStore.init(Context())
        LakatStore.mutate { AppState() }
    }

    private fun addSite(domain: String): String {
        val id = LakatStore.newId("site")
        LakatStore.mutate { s ->
            s.copy(sites = s.sites + Site(
                id = id, domain = domain,
                hostnames = Blocklist.expandHostnames(domain, false),
                addedAt = now, pauseUntil = null, pendingDeleteAt = null,
            ))
        }
        return id
    }

    private fun currentStep(): Step {
        val s = LakatStore.state.value.session!!
        return s.steps[s.stepIndex]
    }

    /** Answers the current step correctly; MEMORY is back-dated past its wait. */
    private fun solve(step: Step): String = when (step) {
        is Step.Transcribe -> step.text
        is Step.MathChain -> step.problems[step.pos].a.toString()
        is Step.Memory -> {
            LakatStore.mutate { s ->
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
        while (LakatStore.state.value.session != null && !stop(currentStep()) && guard++ < 200) {
            Referee.submitAnswer(LakatStore.state.value.session!!.id, solve(currentStep()), now)
        }
    }

    @Test fun `a completed pause session pauses the site and tick re-locks it`() {
        val id = addSite("youtube.com")
        val ses = Referee.startSession(Kind.PAUSE, id, 15, now)
        assertEquals(2, ses.steps.size, "tier 0 has two active steps and no forced wait")

        solveUntil { false }
        assertNull(LakatStore.state.value.session, "session finished")
        var site = LakatStore.state.value.sites[0]
        assertNotNull(site.pauseUntil)
        assertTrue(site.pauseUntil!! > now)
        assertEquals(1, LakatStore.state.value.unlockLog.size)
        assertTrue(LakatStore.blockedHostnamesNow(now).isEmpty(), "paused -> nothing blocked")

        Referee.tick(site.pauseUntil!! + 1)
        site = LakatStore.state.value.sites[0]
        assertNull(site.pauseUntil, "tick re-locks after the pause expires")
    }

    @Test fun `a wrong answer neither advances nor unlocks`() {
        val id = addSite("reddit.com")
        Referee.startSession(Kind.PAUSE, id, 30, now)
        val r = Referee.submitAnswer(LakatStore.state.value.session!!.id, "biztosan nem jó", now)
        assertFalse(r.accepted)
        assertEquals(0, LakatStore.state.value.session!!.stepIndex)
        assertNull(LakatStore.state.value.sites[0].pauseUntil)
    }

    @Test fun `a memory code is refused until the memorise and wait window elapses`() {
        val id = addSite("x.com")
        var found = false
        for (attempt in 0 until 40) {
            LakatStore.mutate { it.copy(session = null, lastCombo = null) }
            Referee.startSession(Kind.PAUSE, id, 15, now)
            val step = currentStep()
            if (step is Step.Memory) {
                found = true
                assertNotNull(step.armedAt, "armed when it became current")
                val res = Referee.submitAnswer(LakatStore.state.value.session!!.id, step.code, now + 500)
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
        assertTrue(LakatStore.state.value.session!!.steps.last() is Step.Delay)

        solveUntil { it is Step.Delay }
        val delay = currentStep() as Step.Delay
        assertNotNull(delay.claimableAt)
        assertTrue(delay.claimableAt!! > now)

        assertFalse(Referee.claimDelay(LakatStore.state.value.session!!.id, now).accepted, "too early")

        val inWindow = delay.claimableAt!! + 1000
        assertTrue(Referee.claimDelay(LakatStore.state.value.session!!.id, inWindow).sessionDone)
        val site = LakatStore.state.value.sites[0]
        assertNotNull(site.pendingDeleteAt)
        assertTrue(site.pendingDeleteAt!! > inWindow + 23 * 3600_000L, "~24h grace")
        assertTrue(LakatStore.blockedHostnamesNow(inWindow).isNotEmpty(), "still blocked during grace")

        Referee.tick(site.pendingDeleteAt!! + 1)
        assertTrue(LakatStore.state.value.sites.isEmpty(), "removed only after the grace period")
    }

    @Test fun `missing the claim window voids the whole attempt`() {
        val id = addSite("netflix.com")
        Referee.startSession(Kind.DELETE, id, null, now)
        solveUntil { it is Step.Delay }
        val delay = currentStep() as Step.Delay
        val tooLate = delay.claimableAt!! + delay.claimWindowMs + 1

        var code: String? = null
        try {
            Referee.claimDelay(LakatStore.state.value.session!!.id, tooLate)
        } catch (e: Referee.RefereeException) {
            code = e.code
        }
        assertEquals("CLAIM_EXPIRED", code)
        assertNull(LakatStore.state.value.session, "the attempt is void")
        assertNull(LakatStore.state.value.sites[0].pendingDeleteAt, "and nothing was deleted")
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
        assertNotNull(LakatStore.state.value.session)
        assertNull(LakatStore.state.value.sites[0].schedule, "not applied before the challenges")

        solveUntil { false }
        assertEquals(work, LakatStore.state.value.sites[0].schedule, "applied once earned")
        assertNull(LakatStore.state.value.sites[0].pauseUntil, "a schedule change is not a pause")

        val tighten = Referee.startScheduleChange(id, ScheduleLogic.ALWAYS, now)
        assertTrue(tighten.applied, "going back to always-blocked is free")
        assertNull(LakatStore.state.value.session)
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
        val first = LakatStore.state.value.session!!
        val firstTypes = first.steps.map { ChallengeEngine.typeNameOf(it) }.sorted()
        val firstIds = first.steps.map { it.id }

        Referee.abandon(first.id)
        assertNull(LakatStore.state.value.session)

        Referee.startSession(Kind.PAUSE, id, 15, now + 60_000)
        val second = LakatStore.state.value.session!!
        assertEquals(firstTypes, second.steps.map { ChallengeEngine.typeNameOf(it) }.sorted(),
            "the same challenge types come back")
        assertFalse(second.steps.map { it.id } == firstIds, "but the content is regenerated")
        assertEquals(0, second.stepIndex, "progress is not carried over")
    }

    @Test fun `the forced combo expires with its cooldown`() {
        val id = addSite("youtube.com")
        Referee.startSession(Kind.PAUSE, id, 15, now)
        Referee.abandon(LakatStore.state.value.session!!.id)
        val abandoned = LakatStore.state.value.lastAbandon!!.comboKey

        Referee.startSession(Kind.PAUSE, id, 15, now + ChallengeEngine.REROLL_COOLDOWN_MS + 60_000)
        val types = LakatStore.state.value.session!!.steps
            .filter { it !is Step.Delay }
            .map { ChallengeEngine.typeNameOf(it) }
        assertFalse(ChallengeEngine.comboKeyOf(types) == abandoned,
            "past the cooldown the draw is free again (and variety forces a different pair)")
    }

    @Test fun `solving clears the abandon debt`() {
        val id = addSite("youtube.com")
        Referee.startSession(Kind.PAUSE, id, 15, now)
        Referee.abandon(LakatStore.state.value.session!!.id)
        assertNotNull(LakatStore.state.value.lastAbandon)

        Referee.startSession(Kind.PAUSE, id, 15, now + 60_000)
        var guard = 0
        while (LakatStore.state.value.session != null && guard++ < 200) {
            val step = currentStep()
            Referee.submitAnswer(LakatStore.state.value.session!!.id, solve(step), now + 60_000)
        }
        assertNull(LakatStore.state.value.lastAbandon, "solving pays the debt")
    }
}
