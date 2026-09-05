import Foundation

/// Session referee — mirrors desktop/src/helper/referee.ts. All transitions go
/// through BreakerStore.mutate so they persist atomically across processes.
enum Referee {

    struct RefereeError: Error { let message: String; let code: String }

    struct SubmitResult { let accepted: Bool; let sessionDone: Bool; let message: String? }

    static func effectiveTier(_ state: AppState, kind: ChallengeEngine.Kind, now: Double) -> Int {
        let base = ChallengeEngine.computeTier(state.unlockLog, now: now)
        return kind == .delete ? min(3, base + 1) : base
    }

    /// Drops the running attempt and remembers WHAT it was, so restarting
    /// within the cooldown gets the same challenge types back. Cancelling is
    /// always allowed — it just must not be a cheaper route than finishing.
    private static func dropSession(_ state: inout AppState, _ now: Double) {
        guard let s = state.session else { return }
        let combo = ChallengeEngine.comboKeyOf(
            s.steps.filter { $0.typeName != "DELAY" }.map { $0.typeName })
        // The cooldown runs from the FIRST time this pair was given up on, not
        // from the latest restart — otherwise every restart would push the
        // deadline out and the pair would stick to the site for ever.
        let live = liveAbandons(state, now)
        let prev = live.first { $0.siteId == s.siteId }
        let at = (prev != nil && prev!.comboKey == combo) ? prev!.at : now
        state.abandons = live.filter { $0.siteId != s.siteId }
            + [AbandonRec(siteId: s.siteId, kind: s.kind, comboKey: combo, at: at)]
        state.session = nil
    }

    /// How many sites may carry a debt at once — cancels cannot grow the state.
    private static let maxAbandons = 64

    /// Debts still inside their cooldown, bounded in number.
    private static func liveAbandons(_ state: AppState, _ now: Double) -> [AbandonRec] {
        let live = (state.abandons ?? []).filter {
            now >= $0.at && now - $0.at <= ChallengeEngine.rerollCooldownMs
        }
        return live.count > maxAbandons ? Array(live.suffix(maxAbandons)) : live
    }

    /// The combo an abandoned attempt still owes, while the cooldown holds.
    ///
    /// The KIND is deliberately not compared: pause and delete draw from the
    /// same pool, so letting a cancelled delete hand back a fresh pair for the
    /// pause flow would just be the re-roll with an extra click.
    private static func forcedCombo(_ state: AppState, _ siteId: String, _ now: Double) -> String? {
        liveAbandons(state, now).first { $0.siteId == siteId }?.comboKey
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
        BreakerStore.shared.mutate { state in
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
            // A new attempt drops any previous one — progress is never banked,
            // and its challenge types are remembered so this is not a way to
            // shop for an easier pair.
            dropSession(&state, now)
            let tier = effectiveTier(state, kind: kind, now: now)
            let plan = ChallengeEngine.generatePlan(kind: kind, tier: tier, lastCombo: state.lastCombo,
                                                    forceCombo: forcedCombo(state, siteId, now))
            var steps = plan.steps
            armCurrent(&steps, 0, now)
            let session = SessionRec(id: BreakerStore.shared.newId("ses"), kind: kind, siteId: siteId,
                                     minutes: minutes, steps: steps, stepIndex: 0, createdAt: now,
                                     pendingSchedule: nil, pendingFocusEnd: nil)
            state.session = session
            state.lastCombo = plan.comboKey
            created = session
        }
        if let e = thrown { throw e }
        return created!
    }

    /// Egy menet lezárása a naplóba — a statisztika ebből lesz.
    ///
    /// A csomag NEVÉT is elmentjük, nem csak az azonosítóját: a csomag azóta
    /// átnevezhető vagy törölhető, és egy statisztika, ami „ismeretlen csomag”-ot
    /// ír ki a múlt hétre, semmit nem ér.
    private static func logFocusEnd(
        _ state: inout AppState, endedAt: Double, stopped: Bool
    ) {
        guard let run = state.focusRun else { return }
        let name = (state.focusPacks ?? []).first { $0.id == run.packId }?.name
            ?? "Ismeretlen csomag"
        let entry = Focus.closeRun(run, packName: name, endedAt: endedAt, stopped: stopped)
        state.focusLog = ((state.focusLog ?? []) + [entry]).suffix(Focus.maxFocusLog).map { $0 }
    }

    private static func finish(_ state: inout AppState, _ s: SessionRec, _ now: Double) {
        // A MUNKAMENET nem egy oldalhoz tartozik, hanem az egész készülékhez:
        // ezért áll itt, az oldal-keresés ELŐTT. A -1 azt jelenti: állítsd le
        // most.
        if let pending = s.pendingFocusEnd {
            if pending < 0 {
                // A naplót ITT írjuk: csak innen derül ki, hogy a menet
                // PRÓBATÉTELLEL ért véget, nem magától. A kettő nem ugyanaz a
                // mondat, és a statisztikában sem ugyanaz a sor.
                logFocusEnd(&state, endedAt: now, stopped: true)
                state.focusRun = nil
            } else if var run = state.focusRun {
                run = Focus.Run(packId: run.packId, startedAt: run.startedAt, endsAt: pending)
                state.focusRun = run
            }
            state.unlockLog = state.unlockLog.filter { $0 > now - 30 * 24 * 3_600_000 } + [now]
            state.session = nil
            state.abandons = (state.abandons ?? []).filter { $0.siteId != s.siteId }
            return
        }
        state.sites = state.sites.map { site in
            guard site.id == s.siteId else { return site }
            var copy = site
            if let sched = s.pendingSchedule { copy.schedule = sched } // gated loosening
            else if s.kind == .pause { copy.pauseUntil = now + Double(s.minutes ?? 15) * 60_000 }
            else { copy.pendingDeleteAt = now + Double(ChallengeEngine.deletePendingMs) }
            return copy
        }
        state.unlockLog = state.unlockLog.filter { $0 > now - 30 * 24 * 3_600_000 } + [now]
        state.session = nil
        // Solved: this site's debt is paid, its next attempt draws freely again.
        // Other sites keep theirs.
        state.abandons = (state.abandons ?? []).filter { $0.siteId != s.siteId }
    }

    struct ScheduleChangeResult { let applied: Bool; let session: SessionRec? }

    /// Change a site's weekly schedule. Tightening applies immediately; loosening
    /// requires the same challenges as a pause (mirrors desktop startScheduleChange).
    @discardableResult
    static func startScheduleChange(siteId: String, schedule: ScheduleLogic.Schedule,
                                    now: Double) throws -> ScheduleChangeResult {
        var result: ScheduleChangeResult?
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            guard let site = state.sites.first(where: { $0.id == siteId }) else {
                thrown = RefereeError(message: "Ismeretlen oldal.", code: "NO_SITE"); return
            }
            if state.session != nil {
                thrown = RefereeError(message: "Előbb fejezd be a folyamatban lévő kísérletet.", code: "BUSY"); return
            }
            let next = ScheduleLogic.normalize(schedule)
            let current = ScheduleLogic.normalize(site.schedule ?? ScheduleLogic.always)
            if !ScheduleLogic.isLoosening(current, next, now) {
                state.sites = state.sites.map { $0.id == siteId ? { var c = $0; c.schedule = next; return c }() : $0 }
                result = ScheduleChangeResult(applied: true, session: nil)
                return
            }
            let tier = effectiveTier(state, kind: .pause, now: now)
            let plan = ChallengeEngine.generatePlan(kind: .pause, tier: tier, lastCombo: state.lastCombo,
                                                    forceCombo: forcedCombo(state, siteId, now))
            var steps = plan.steps
            armCurrent(&steps, 0, now)
            let session = SessionRec(id: BreakerStore.shared.newId("ses"), kind: .pause, siteId: siteId,
                                     minutes: nil, steps: steps, stepIndex: 0, createdAt: now,
                                     pendingSchedule: next, pendingFocusEnd: nil)
            state.session = session
            state.lastCombo = plan.comboKey
            result = ScheduleChangeResult(applied: false, session: session)
        }
        if let e = thrown { throw e }
        return result!
    }

    static func submitAnswer(sessionId: String, answer: String, now: Double) throws -> SubmitResult {
        var result: SubmitResult?
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            guard var s = state.session, s.id == sessionId else {
                thrown = RefereeError(message: "Nincs ilyen aktív feloldási kísérlet.", code: "NO_SESSION"); return
            }
            if now - s.createdAt > Double(ChallengeEngine.sessionMaxAgeMs) {
                dropSession(&state, now)
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
            // A failed answer can hand back a REGENERATED step (new memory code,
            // new sentence). It must be armed too, or a MEMORY step would have no
            // armedAt: the code is never shown and every answer is refused as
            // premature — the challenge becomes unsolvable.
            armCurrent(&s.steps, s.stepIndex, now)
            state.session = s
            result = SubmitResult(accepted: outcome.ok, sessionDone: false, message: outcome.message)
        }
        if let e = thrown { throw e }
        return result!
    }

    static func claimDelay(sessionId: String, now: Double) throws -> SubmitResult {
        // Expiry clears the session in its own committed mutation first.
        if let pre = BreakerStore.shared.state.session, pre.id == sessionId,
           case let .delay(_, _, claimableAt?, window) = pre.steps[pre.stepIndex],
           now > claimableAt + Double(window) {
            BreakerStore.shared.mutate { state in dropSession(&state, now) }
            throw RefereeError(
                message: "Lecsúsztál az átvételi ablakról — a feloldási kísérlet érvénytelen, elölről kell kezdeni.",
                code: "CLAIM_EXPIRED")
        }
        var result: SubmitResult?
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
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
        let now = Date().timeIntervalSince1970 * 1000
        BreakerStore.shared.mutate { state in
            if state.session?.id == sessionId { dropSession(&state, now) }
        }
    }

    /// housekeeping: re-lock ended pauses, run due deletions, drop dead sessions
    /// A gap bigger than this between two housekeeping ticks is not elapsed
    /// time: the loop runs every second, so anything past a couple of minutes
    /// is either the clock being moved or the device having been asleep.
    static let clockJumpThresholdMs: Double = 2 * 60_000

    /// When the previous tick ran. In memory on purpose: writing it out every
    /// second would be pointless churn, and after a restart it only matters
    /// from the next tick on.
    private static var lastTickAt: Double = 0

    /// Waiting IS the challenge here, and a challenge a clock change defeats is
    /// not a challenge: with the system clock moved forward a DELAY step would
    /// be claimable at once and a pending deletion would run early. So the
    /// deadlines that PROTECT (the waiting target, a pending deletion, the age
    /// of the attempt) are pushed by whatever the wall clock jumped — they
    /// measure elapsed time, not a date. Sleep looks identical from here and is
    /// treated the same: the wait does not run while the device is off.
    ///
    /// pauseUntil is deliberately left alone: a jump that ends an unlock early
    /// blocks more, and tightening never needs protecting.
    private static func absorbClockJump(_ now: Double) {
        let last = lastTickAt
        lastTickAt = now
        guard last != 0 else { return }
        let jump = now - last
        guard jump > clockJumpThresholdMs else { return }
        let shift = jump - clockJumpThresholdMs

        BreakerStore.shared.mutate { state in
            if var s = state.session, s.steps.indices.contains(s.stepIndex) {
                if case let .delay(id, minutes, claimableAt?, window) = s.steps[s.stepIndex] {
                    s.steps[s.stepIndex] = .delay(id: id, minutes: minutes,
                                                  claimableAt: claimableAt + shift, claimWindowMs: window)
                }
                s.createdAt += shift // …so the jump cannot age the attempt out either
                state.session = s
            }
            state.sites = state.sites.map { site in
                var copy = site
                if let d = copy.pendingDeleteAt { copy.pendingDeleteAt = d + shift }
                return copy
            }
            // A FUTÓ MUNKAMENET IS ELTOLÓDIK — enélkül az óra előreállítása
            // ingyen leállítaná, a számláló léptetne, és a szinkron ezt szét is
            // vinné a többi eszközre.
            //
            // A SZABÁLY EGY MONDAT: amennyi hátra volt, annyi van hátra. Ugyanez
            // a válasz a felfüggesztett készülékre is: a kettőt nem tudjuk
            // megkülönböztetni, de nem is kell.
            //
            // A kezdés is tolódik, nem csak a vég: enélkül a naplóba egy
            // ötvenperces menet órásként kerülne be, és a statisztika hazudna.
            //
            // Az ABLAK-menet kivétel: annak a vége az ablak vége, nem tolódik a
            // készülék alvásával (Focus.isWindowRun) — különben a telefon és a
            // gép két különböző menetet látna ugyanarról a délelőttről.
            if let run = state.focusRun, !Focus.isWindowRun(run, packs: state.focusPacks ?? []) {
                state.focusRun = Focus.Run(
                    packId: run.packId,
                    startedAt: run.startedAt + shift,
                    endsAt: run.endsAt + shift
                )
            }
        }
    }

    /// Az ismétlődés-vizsgálat utolsó tizenöt másodperces szelete (lásd a tick-et).
    private static var lastDueSlot = -1

    static func tick(now: Double) {
        absorbClockJump(now)
        let st = BreakerStore.shared.state
        var sessionDead = false
        if let s = st.session {
            if case let .delay(_, _, claimableAt?, window) = s.steps[s.stepIndex],
               now > claimableAt + Double(window) { sessionDead = true }
            if now - s.createdAt > Double(ChallengeEngine.sessionMaxAgeMs) { sessionDead = true }
        }
        let pauseEnded = st.sites.contains { ($0.pauseUntil ?? .infinity) <= now && $0.pauseUntil != nil }
        let deleteDue = st.sites.contains { ($0.pendingDeleteAt ?? .infinity) <= now && $0.pendingDeleteAt != nil }
        // A MAGÁTÓL lejárt menet is lezárul — enélkül csak a próbatétellel
        // leállított menetek kerülnének a statisztikába, vagyis pont azok
        // hiányoznának, amiket a felhasználó VÉGIGVITT. Az a statisztika
        // rosszabb a semminél: azt mondaná, hogy sosem sikerül.
        let focusEnded = (st.focusRun?.endsAt ?? .infinity) <= now
        // MENETREND SZERINTI INDÍTÁS. Az ablakban, ha nem fut semmi, és a napló
        // szerint ebben az ablakban még nem indult, a csomag menete magától
        // indul. Tizenöt másodpercenként nézzük, nem minden körben — az ablak
        // percekben él, nem másodpercekben.
        let slot = Int(now / 15_000)
        var focusDue = false
        if slot != lastDueSlot {
            lastDueSlot = slot
            focusDue = Focus.dueRecurrence(
                st.focusPacks ?? [], run: st.focusRun, log: st.focusLog ?? [], now: now
            ) != nil
        }
        guard sessionDead || pauseEnded || deleteDue || focusEnded || focusDue else { return }

        BreakerStore.shared.mutate { state in
            // Sitting out the claim window ends an attempt too: same bookkeeping,
            // so it is not an escape hatch from a pair one dislikes.
            if sessionDead { dropSession(&state, now) }
            state.sites = state.sites.compactMap { site in
                var copy = site
                if let p = copy.pauseUntil, p <= now { copy.pauseUntil = nil }
                if let d = copy.pendingDeleteAt, d <= now { return nil }
                return copy
            }
            if let closed = Focus.closeIfEnded(
                state.focusRun, packs: state.focusPacks ?? [],
                log: state.focusLog ?? [], now: now
            ) {
                state.focusRun = closed.run
                state.focusLog = closed.log
            }
            // Az ablak kezdésével és végével — a gép ugyanezt a menetet állítja
            // elő, a szinkron a kettőt egynek látja.
            if let due = Focus.dueRecurrence(
                state.focusPacks ?? [], run: state.focusRun, log: state.focusLog ?? [], now: now
            ) {
                // Egy MÁSIK csomag kézi menete az ablak kezdetén véget ér — az
                // ablak az ígéret. A naplóba a saját idejével, nem leállítottként.
                if let running = state.focusRun, Focus.isRunning(running, now: now) {
                    let name = (state.focusPacks ?? []).first { $0.id == running.packId }?.name ?? "Ismeretlen csomag"
                    let entry = Focus.closeRun(running, packName: name, endedAt: now, stopped: false)
                    state.focusLog = ((state.focusLog ?? []) + [entry]).suffix(Focus.maxFocusLog).map { $0 }
                }
                state.focusRun = Focus.Run(packId: due.pack.id, startedAt: due.startsAt, endsAt: due.endsAt)
            }
        }
    }

    // MARK: - munkamenet

    struct FocusChangeResult { let applied: Bool; let session: SessionRec? }

    /// Munkamenet indítása. INGYEN van — ez a szigorítás iránya.
    ///
    /// Egyszerre egy menet fut. Enélkül a leállítás próbatételét meg lehetne
    /// kerülni: indítok egy „minden engedve” csomagot, és kész.
    static func startFocus(packId: String, minutes: Int, now: Double) throws {
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            guard let pack = (state.focusPacks ?? []).first(where: { $0.id == packId }) else {
                thrown = RefereeError(message: "Ismeretlen csomag.", code: "NO_PACK"); return
            }
            if Focus.isRunning(state.focusRun, now: now) {
                thrown = RefereeError(message: "Már fut egy munkamenet.", code: "FOCUS_RUNNING"); return
            }
            guard let mins = Focus.normalizeMinutes(Double(minutes)) else {
                thrown = RefereeError(message: "Érvénytelen hossz.", code: "BAD_MINUTES"); return
            }
            state.focusRun = Focus.Run(
                packId: pack.id, startedAt: now, endsAt: now + Double(mins) * 60_000
            )
        }
        if let e = thrown { throw e }
    }

    /// A futó menet vége odébb tolva — vagy a leállítása.
    ///
    /// HOSSZABBÍTANI ingyen van, RÖVIDÍTENI és LEÁLLÍTANI próbatételbe kerül.
    /// Ugyanaz a szabály, mint mindenhol: enélkül a munkamenet egy „mégsem”
    /// gomb lenne, és pont az a lényeg, hogy ne az legyen.
    ///
    /// - Parameter nextEndsAt: az új vég, vagy nil = állítsd le most
    @discardableResult
    static func changeFocus(nextEndsAt: Double?, now: Double) throws -> FocusChangeResult {
        var result: FocusChangeResult?
        var thrown: RefereeError?
        BreakerStore.shared.mutate { state in
            guard let run = state.focusRun, Focus.isRunning(run, now: now) else {
                thrown = RefereeError(message: "Nem fut munkamenet.", code: "NO_FOCUS"); return
            }
            let next = nextEndsAt ?? now
            if !Focus.isSessionLoosening(currentEndsAt: run.endsAt, nextEndsAt: next) {
                state.focusRun = Focus.Run(
                    packId: run.packId, startedAt: run.startedAt, endsAt: next
                )
                result = FocusChangeResult(applied: true, session: nil)
                return
            }
            if state.session != nil {
                thrown = RefereeError(
                    message: "Előbb fejezd be a folyamatban lévő kísérletet.", code: "BUSY"
                )
                return
            }
            dropSession(&state, now)
            let tier = effectiveTier(state, kind: .pause, now: now)
            let plan = ChallengeEngine.generatePlan(kind: .pause, tier: tier,
                                                    lastCombo: state.lastCombo, forceCombo: nil)
            var steps = plan.steps
            armCurrent(&steps, 0, now)
            let session = SessionRec(
                id: BreakerStore.shared.newId("ses"), kind: .pause,
                // A munkamenet nem oldalhoz tartozik; a jelölés mégis kell, mert
                // a feladott kísérletek nyilvántartása oldalanként megy.
                siteId: "focus:" + run.packId,
                minutes: nil, steps: steps, stepIndex: 0, createdAt: now,
                pendingSchedule: nil,
                // A -1 a „állítsd le most”; a nulla érvényes időpont lenne.
                pendingFocusEnd: nextEndsAt ?? -1
            )
            state.session = session
            state.lastCombo = plan.comboKey
            result = FocusChangeResult(applied: false, session: session)
        }
        if let e = thrown { throw e }
        return result!
    }
}
