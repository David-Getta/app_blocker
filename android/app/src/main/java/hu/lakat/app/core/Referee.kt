package hu.lakat.app.core

import hu.lakat.app.core.ChallengeEngine.Kind
import hu.lakat.app.core.ChallengeEngine.Step

/**
 * Session referee on top of LakatStore — mirrors desktop/src/helper/referee.ts.
 * All state transitions go through LakatStore.mutate so they persist atomically.
 */
object Referee {

    class RefereeException(message: String, val code: String) : Exception(message)

    data class SubmitResult(
        val accepted: Boolean,
        val sessionDone: Boolean,
        val message: String? = null,
    )

    fun effectiveTier(state: AppState, kind: Kind, now: Long): Int {
        val base = ChallengeEngine.computeTier(state.unlockLog, now)
        return if (kind == Kind.DELETE) minOf(3, base + 1) else base
    }

    fun startSession(kind: Kind, siteId: String, minutes: Int?, now: Long): SessionRec {
        var created: SessionRec? = null
        LakatStore.mutate { state ->
            val site = state.sites.find { it.id == siteId }
                ?: throw RefereeException("Ismeretlen oldal.", "NO_SITE")
            if (kind == Kind.PAUSE) {
                if (minutes == null || minutes !in ChallengeEngine.PAUSE_CHOICES_MIN) {
                    throw RefereeException("Érvénytelen szünet-hossz.", "BAD_MINUTES")
                }
                if (site.pauseUntil != null && site.pauseUntil > now) {
                    throw RefereeException("Ez az oldal most éppen fel van oldva.", "ALREADY_PAUSED")
                }
            }
            if (kind == Kind.DELETE && site.pendingDeleteAt != null) {
                throw RefereeException("Ennek az oldalnak már folyamatban van a törlése.", "ALREADY_DELETING")
            }
            val tier = effectiveTier(state, kind, now)
            val plan = ChallengeEngine.generatePlan(kind, tier, state.lastCombo)
            val session = SessionRec(
                id = LakatStore.newId("ses"), kind = kind, siteId = siteId, minutes = minutes,
                steps = armCurrent(plan.steps, 0, now), stepIndex = 0, createdAt = now,
            )
            created = session
            state.copy(session = session, lastCombo = plan.comboKey)
        }
        return created!!
    }

    /** Időzítés-bélyegzés, amikor egy lépés aktuálissá válik (DELAY cél, MEMORY mutatási ablak). */
    private fun armCurrent(steps: List<Step>, index: Int, now: Long): List<Step> {
        val step = steps.getOrNull(index) ?: return steps
        val armed: Step? = when {
            step is Step.Delay && step.claimableAt == null ->
                step.copy(claimableAt = now + step.minutes * 60_000L)
            step is Step.Memory && step.armedAt == null -> step.copy(armedAt = now)
            else -> null
        }
        if (armed == null) return steps
        return steps.toMutableList().also { it[index] = armed }
    }

    private fun finish(state: AppState, s: SessionRec, now: Long): AppState {
        val sites = state.sites.map { site ->
            if (site.id != s.siteId) site
            else if (s.kind == Kind.PAUSE) site.copy(pauseUntil = now + (s.minutes ?: 15) * 60_000L)
            else site.copy(pendingDeleteAt = now + ChallengeEngine.DELETE_PENDING_MS)
        }
        val log = state.unlockLog.filter { it > now - 30 * 24 * 3600_000L } + now
        return state.copy(sites = sites, unlockLog = log, session = null)
    }

    private fun requireSession(state: AppState, sessionId: String, now: Long): SessionRec {
        val s = state.session
        if (s == null || s.id != sessionId) {
            throw RefereeException("Nincs ilyen aktív feloldási kísérlet.", "NO_SESSION")
        }
        if (now - s.createdAt > ChallengeEngine.SESSION_MAX_AGE_MS) {
            LakatStore.mutate { it.copy(session = null) }
            throw RefereeException("A feloldási kísérlet lejárt, kezdd elölről.", "SESSION_EXPIRED")
        }
        return s
    }

    fun submitAnswer(sessionId: String, answer: String, now: Long): SubmitResult {
        var result: SubmitResult? = null
        LakatStore.mutate { state ->
            val s = requireSession(state, sessionId, now)
            val step = s.steps[s.stepIndex]
            if (step is Step.Delay) {
                throw RefereeException("Ez a lépés várakozás — a Feloldás átvétele gombbal zárható.", "DELAY_STEP")
            }
            val tier = effectiveTier(state, s.kind, s.createdAt)
            val outcome = ChallengeEngine.applyAnswer(step, answer, tier, s.kind, now)
            var steps = s.steps.toMutableList().also { it[s.stepIndex] = outcome.step } as List<Step>
            if (outcome.ok && outcome.done) {
                val nextIndex = s.stepIndex + 1
                if (nextIndex >= steps.size) {
                    result = SubmitResult(accepted = true, sessionDone = true)
                    return@mutate finish(state, s, now)
                }
                steps = armCurrent(steps, nextIndex, now)
                result = SubmitResult(accepted = true, sessionDone = false)
                return@mutate state.copy(session = s.copy(steps = steps, stepIndex = nextIndex))
            }
            result = SubmitResult(accepted = outcome.ok, sessionDone = false, message = outcome.message)
            state.copy(session = s.copy(steps = steps))
        }
        return result!!
    }

    fun claimDelay(sessionId: String, now: Long): SubmitResult {
        // Expiry clears the session as a separate committed mutation, so the
        // exception below cannot roll it back.
        val pre = LakatStore.state.value.session
        if (pre != null && pre.id == sessionId) {
            val step = pre.steps[pre.stepIndex]
            if (step is Step.Delay && step.claimableAt != null && now > step.claimableAt + step.claimWindowMs) {
                LakatStore.mutate { it.copy(session = null) }
                throw RefereeException(
                    "Lecsúsztál az átvételi ablakról — a feloldási kísérlet érvénytelen, elölről kell kezdeni.",
                    "CLAIM_EXPIRED",
                )
            }
        }
        var result: SubmitResult? = null
        LakatStore.mutate { state ->
            val s = requireSession(state, sessionId, now)
            val step = s.steps[s.stepIndex]
            if (step !is Step.Delay || step.claimableAt == null) {
                throw RefereeException("Most nem várakozási lépés van.", "NOT_DELAY")
            }
            if (now < step.claimableAt) {
                val remainMin = ((step.claimableAt - now) + 59_999) / 60_000
                result = SubmitResult(false, false, "Még $remainMin percet várni kell.")
                return@mutate state
            }
            val nextIndex = s.stepIndex + 1
            if (nextIndex >= s.steps.size) {
                result = SubmitResult(accepted = true, sessionDone = true)
                return@mutate finish(state, s, now)
            }
            val steps = armCurrent(s.steps, nextIndex, now)
            result = SubmitResult(accepted = true, sessionDone = false)
            state.copy(session = s.copy(steps = steps, stepIndex = nextIndex))
        }
        return result!!
    }

    fun abandon(sessionId: String) {
        LakatStore.mutate { state ->
            if (state.session?.id == sessionId) state.copy(session = null) else state
        }
    }

    /** housekeeping: re-lock ended pauses, run due deletions, drop dead sessions */
    fun tick(now: Long) {
        // Cheap pre-check: this runs on the DNS hot path, only mutate when needed.
        val st = LakatStore.state.value
        val sessionDead = st.session?.let { s ->
            val step = s.steps[s.stepIndex]
            (step is Step.Delay && step.claimableAt != null && now > step.claimableAt + step.claimWindowMs) ||
                now - s.createdAt > ChallengeEngine.SESSION_MAX_AGE_MS
        } ?: false
        val pauseEnded = st.sites.any { it.pauseUntil != null && it.pauseUntil <= now }
        val deleteDue = st.sites.any { it.pendingDeleteAt != null && it.pendingDeleteAt <= now }
        if (!sessionDead && !pauseEnded && !deleteDue) return

        LakatStore.mutate { state ->
            var next = state
            if (sessionDead) next = next.copy(session = null)
            val sites = next.sites
                .map { if (it.pauseUntil != null && it.pauseUntil <= now) it.copy(pauseUntil = null) else it }
                .filter { it.pendingDeleteAt == null || it.pendingDeleteAt > now }
            next.copy(sites = sites)
        }
    }
}
