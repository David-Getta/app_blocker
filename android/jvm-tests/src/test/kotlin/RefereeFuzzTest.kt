import android.content.Context
import hu.breaker.app.core.AppState
import hu.breaker.app.core.ChallengeEngine
import hu.breaker.app.core.ChallengeEngine.Kind
import hu.breaker.app.core.ChallengeEngine.Step
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.Referee
import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.Site
import java.util.Random
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Randomised interaction test — the Kotlin mirror of
 * desktop/test/referee-fuzz.test.ts.
 *
 * The one promise this app makes is that a site cannot become reachable
 * without completing the challenges. The other tests walk one flow at a time;
 * this one throws thousands of random interleavings at the referee and checks
 * the invariants after EVERY step. Seeded, so a failure replays exactly.
 */
class RefereeFuzzTest {

    @BeforeTest fun reset() {
        BreakerStore.init(Context())
        BreakerStore.mutate { AppState() }
    }

    private fun correctAnswer(step: Step, now: Long): String = when (step) {
        is Step.Transcribe -> step.text
        is Step.MathChain -> step.problems[step.pos].a.toString()
        is Step.Memory -> {
            // pretend the show + wait window has elapsed
            BreakerStore.mutate { st ->
                val s = st.session!!
                val steps = s.steps.toMutableList()
                steps[s.stepIndex] = step.copy(armedAt = now - step.showMs - step.waitMs - 1000)
                st.copy(session = s.copy(steps = steps))
            }
            step.code
        }
        is Step.Reverse -> ChallengeEngine.reverse(step.text)
        is Step.Delay -> ""
    }

    private fun pausedIds(now: Long) = BreakerStore.state.value.sites
        .filter { it.pauseUntil != null && it.pauseUntil > now }.map { it.id }.toSet()

    private fun deletingIds() = BreakerStore.state.value.sites
        .filter { it.pendingDeleteAt != null }.map { it.id }.toSet()

    private fun schedules() = BreakerStore.state.value.sites
        .associate { it.id to (it.schedule?.toString() ?: "null") }

    private fun runSequence(seed: Long, steps: Int) {
        val r = Random(seed)
        BreakerStore.mutate { AppState() }
        val ids = (0 until 3).map { i ->
            val id = BreakerStore.newId("site")
            BreakerStore.mutate { s ->
                s.copy(sites = s.sites + Site(id, "site$i.example", listOf("site$i.example"), 0, null, null))
            }
            id
        }
        var now = 1_767_600_000_000L // fixed instant, so the run is reproducible
        val why = { m: String -> "$m (seed $seed)" }

        repeat(steps) {
            val beforePaused = pausedIds(now)
            val beforeDeleting = deletingIds()
            val beforeSchedules = schedules()
            var completed = false

            val pick = r.nextDouble()
            val siteId = ids[r.nextInt(ids.size)]
            try {
                val session = BreakerStore.state.value.session
                when {
                    pick < 0.18 -> Referee.startSession(
                        if (r.nextDouble() < 0.8) Kind.PAUSE else Kind.DELETE,
                        siteId, listOf(15, 30, 60)[r.nextInt(3)], now,
                    )
                    pick < 0.62 && session != null -> {
                        val cur = session.steps[session.stepIndex]
                        completed = if (cur is Step.Delay) {
                            Referee.claimDelay(session.id, now).sessionDone
                        } else {
                            val answer = if (r.nextDouble() < 0.75) correctAnswer(cur, now) else "nem jó válasz"
                            Referee.submitAnswer(session.id, answer, now).sessionDone
                        }
                    }
                    pick < 0.70 && session != null -> Referee.abandon(session.id)
                    pick < 0.80 -> {
                        val next = if (r.nextDouble() < 0.5) {
                            ScheduleLogic.Schedule(ScheduleLogic.Mode.ALWAYS, emptyList())
                        } else {
                            ScheduleLogic.Schedule(
                                ScheduleLogic.Mode.SCHEDULED_BLOCK,
                                listOf(ScheduleLogic.Band(setOf(1, 2, 3, 4, 5), 540, 1020)),
                            )
                        }
                        completed = Referee.startScheduleChange(siteId, next, now).applied
                    }
                    else -> Referee.tick(now)
                }
            } catch (e: Referee.RefereeException) {
                // the only exception type the referee may raise
            }

            for (id in pausedIds(now) - beforePaused) {
                assertTrue(completed, why("site $id became unblocked without completing the challenges"))
            }
            for (id in deletingIds() - beforeDeleting) {
                assertTrue(completed, why("site $id entered deletion without completing the challenges"))
            }
            for ((id, sched) in schedules()) {
                if (beforeSchedules[id] != sched) {
                    assertTrue(completed, why("site $id's schedule changed without completing the challenges"))
                }
            }
            assertTrue(BreakerStore.state.value.abandons.size <= 64, why("the abandon list grew without bound"))

            val s = BreakerStore.state.value.session
            if (s != null) {
                val cur = s.steps[s.stepIndex]
                if (cur is Step.Delay && cur.claimableAt != null && now < cur.claimableAt) {
                    assertFalse(Referee.claimDelay(s.id, now).accepted,
                        why("a waiting step was claimable before its time"))
                }
            }

            // time moves on: mostly seconds, sometimes a jump (clock change or
            // a long sleep)
            now += if (r.nextDouble() < 0.1) (r.nextDouble() * 40 * 24 * 3600_000).toLong()
                   else (r.nextDouble() * 30_000).toLong()
        }
    }

    @Test fun `no random sequence of actions can unlock a site without solving`() {
        for (seed in 1L..20L) runSequence(seed, 200)
    }
}
