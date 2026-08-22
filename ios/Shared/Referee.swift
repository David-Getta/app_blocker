import Foundation

/// Session referee — mirrors desktop/src/helper/referee.ts. All transitions go
/// through LakatStore.mutate so they persist atomically across processes.
enum Referee {

    struct RefereeError: Error { let message: String; let code: String }

    struct SubmitResult { let accepted: Bool; let sessionDone: Bool; let message: String? }

    static func effectiveTier(_ state: AppState, kind: ChallengeEngine.Kind, now: Double) -> Int {
        let base = ChallengeEngine.computeTier(state.unlockLog, now: now)
        return kind == .delete ? min(3, base + 1) : base
    }

    /** Stamps timing state when a step becomes current (DELAY target, MEMORY show window). */
    private static func armCurrent(_ steps: inout [ChallengeEngine.Step], _ index: Int, _ now: Double) {
        guard index < steps.count else { return }
        if case let .delay(id, minutes, claimableAt, window) = steps[index], claimableAt == nil {
            steps[index] = .delay(id: id, minutes: minutes,
                                  claimableAt: now + Double(minutes) * 60_000, claimWindowMs: window)
        }
        if case let .memory(id, code, showMs, waitMs, armedAt) = steps[index], armedAt == nil {
            steps[index] = .memory(id: id, code: code, showMs: showMs, waitMs: waitMs, armedAt: now)
        }
    }

    @discardableResult
    static func startSession(kind: ChallengeEngine.Kind, siteId: String,
                             minutes: Int?, now: Double) throws -> SessionRec {
        var created: SessionRec?
        var thrown: RefereeError?
        LakatStore.shared.mutate { state in
            guard let site = state.sites.first(where: { $0.id == siteId }) else {
                thrown = RefereeError(message: "Ismeretlen oldal.", code: "NO_SITE"); return
            }
            if kind == .pause {
                guard let m = minutes, ChallengeEngine.pauseChoicesMin.contains(m) else {
                    thrown = RefereeError(message: "Érvénytelen szünet-hossz.", code: "BAD_MINUTES"); return
                }
                if (site.pauseUntil ?? 0) > now {
                    thrown = RefereeError(message: "Ez az oldal most éppen fel van oldva.", code: "ALREADY_PAUSED"); return
                }
            }
            if kind == .delete && site.pendingDeleteAt != nil {
                thrown = RefereeError(message: "Ennek az oldalnak már folyamatban van a törlése.", code: "ALREADY_DELETING"); return
            }
            let tier = effectiveTier(state, kind: kind, now: now)
            let plan = ChallengeEngine.generatePlan(kind: kind, tier: tier, lastCombo: state.lastCombo)
            var steps = plan.steps
            armCurrent(&steps, 0, now)
            let session = SessionRec(id: LakatStore.shared.newId("ses"), kind: kind, siteId: siteId,
                                     minutes: minutes, steps: steps, stepIndex: 0, createdAt: now)
            state.session = session
            state.lastCombo = plan.comboKey
            created = session
        }
        if let e = thrown { throw e }
        return created!
    }

    private static func finish(_ state: inout AppState, _ s: SessionRec, _ now: Double) {
        state.sites = state.sites.map { site in
            guard site.id == s.siteId else { return site }
            var copy = site
            if s.kind == .pause { copy.pauseUntil = now + Double(s.minutes ?? 15) * 60_000 }
            else { copy.pendingDeleteAt = now + Double(ChallengeEngine.deletePendingMs) }
            return copy
        }
        state.unlockLog = state.unlockLog.filter { $0 > now - 30 * 24 * 3_600_000 } + [now]
        state.session = nil
    }

    static func submitAnswer(sessionId: String, answer: String, now: Double) throws -> SubmitResult {
        var result: SubmitResult?
        var thrown: RefereeError?
        LakatStore.shared.mutate { state in
            guard var s = state.session, s.id == sessionId else {
                thrown = RefereeError(message: "Nincs ilyen aktív feloldási kísérlet.", code: "NO_SESSION"); return
            }
            if now - s.createdAt > Double(ChallengeEngine.sessionMaxAgeMs) {
                state.session = nil
                thrown = RefereeError(message: "A feloldási kísérlet lejárt, kezdd elölről.", code: "SESSION_EXPIRED"); return
            }
            let step = s.steps[s.stepIndex]
            if case .delay = step {
                thrown = RefereeError(message: "Ez a lépés várakozás — a Feloldás átvétele gombbal zárható.", code: "DELAY_STEP"); return
            }
            let tier = effectiveTier(state, kind: s.kind, now: s.createdAt)
            let outcome = ChallengeEngine.applyAnswer(step, answer: answer, tier: tier, kind: s.kind, now: now)
            s.steps[s.stepIndex] = outcome.step
            if outcome.ok && outcome.done {
                s.stepIndex += 1
                if s.stepIndex >= s.steps.count {
                    state.session = s
                    finish(&state, s, now)
                    result = SubmitResult(accepted: true, sessionDone: true, message: nil)
                    return
                }
                armCurrent(&s.steps, s.stepIndex, now)
                state.session = s
                result = SubmitResult(accepted: true, sessionDone: false, message: nil)
                return
            }
            state.session = s
            result = SubmitResult(accepted: outcome.ok, sessionDone: false, message: outcome.message)
        }
        if let e = thrown { throw e }
        return result!
    }

    static func claimDelay(sessionId: String, now: Double) throws -> SubmitResult {
        // Expiry clears the session in its own committed mutation first.
        if let pre = LakatStore.shared.state.session, pre.id == sessionId,
           case let .delay(_, _, claimableAt?, window) = pre.steps[pre.stepIndex],
           now > claimableAt + Double(window) {
            LakatStore.shared.mutate { $0.session = nil }
            throw RefereeError(
                message: "Lecsúsztál az átvételi ablakról — a feloldási kísérlet érvénytelen, elölről kell kezdeni.",
                code: "CLAIM_EXPIRED")
        }
        var result: SubmitResult?
        var thrown: RefereeError?
        LakatStore.shared.mutate { state in
            guard var s = state.session, s.id == sessionId else {
                thrown = RefereeError(message: "Nincs ilyen aktív feloldási kísérlet.", code: "NO_SESSION"); return
            }
            guard case let .delay(_, _, claimableAt?, _) = s.steps[s.stepIndex] else {
                thrown = RefereeError(message: "Most nem várakozási lépés van.", code: "NOT_DELAY"); return
            }
            if now < claimableAt {
                let remainMin = Int(ceil((claimableAt - now) / 60_000))
                result = SubmitResult(accepted: false, sessionDone: false, message: "Még \(remainMin) percet várni kell.")
                return
            }
            s.stepIndex += 1
            if s.stepIndex >= s.steps.count {
                state.session = s
                finish(&state, s, now)
                result = SubmitResult(accepted: true, sessionDone: true, message: nil)
                return
            }
            armCurrent(&s.steps, s.stepIndex, now)
            state.session = s
            result = SubmitResult(accepted: true, sessionDone: false, message: nil)
        }
        if let e = thrown { throw e }
        return result!
    }

    static func abandon(sessionId: String) {
        LakatStore.shared.mutate { state in
            if state.session?.id == sessionId { state.session = nil }
        }
    }

    /// housekeeping: re-lock ended pauses, run due deletions, drop dead sessions
    static func tick(now: Double) {
        let st = LakatStore.shared.state
        var sessionDead = false
        if let s = st.session {
            if case let .delay(_, _, claimableAt?, window) = s.steps[s.stepIndex],
               now > claimableAt + Double(window) { sessionDead = true }
            if now - s.createdAt > Double(ChallengeEngine.sessionMaxAgeMs) { sessionDead = true }
        }
        let pauseEnded = st.sites.contains { ($0.pauseUntil ?? .infinity) <= now && $0.pauseUntil != nil }
        let deleteDue = st.sites.contains { ($0.pendingDeleteAt ?? .infinity) <= now && $0.pendingDeleteAt != nil }
        guard sessionDead || pauseEnded || deleteDue else { return }

        LakatStore.shared.mutate { state in
            if sessionDead { state.session = nil }
            state.sites = state.sites.compactMap { site in
                var copy = site
                if let p = copy.pauseUntil, p <= now { copy.pauseUntil = nil }
                if let d = copy.pendingDeleteAt, d <= now { return nil }
                return copy
            }
        }
    }
}
