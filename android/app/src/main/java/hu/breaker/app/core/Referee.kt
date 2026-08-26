package hu.breaker.app.core

import hu.breaker.app.core.ChallengeEngine.Kind
import hu.breaker.app.core.ChallengeEngine.Step

/**
 * Session referee on top of BreakerStore — mirrors desktop/src/helper/referee.ts.
 * All state transitions go through BreakerStore.mutate so they persist atomically.
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
        BreakerStore.mutate { state ->
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
            // Új kísérlet elejti a régit — a haladás sosem bankolható, és a
            // feladott kísérlet próbatípusait megjegyezzük, hogy ez ne legyen
            // könnyebb pár utáni vadászat.
            val dropped = dropSession(state, now)
            val tier = effectiveTier(dropped, kind, now)
            val plan = ChallengeEngine.generatePlan(
                kind, tier, dropped.lastCombo, forcedCombo(dropped, siteId, now),
            )
            val session = SessionRec(
                id = BreakerStore.newId("ses"), kind = kind, siteId = siteId, minutes = minutes,
                steps = armCurrent(plan.steps, 0, now), stepIndex = 0, createdAt = now,
            )
            created = session
            dropped.copy(session = session, lastCombo = plan.comboKey)
        }
        return created!!
    }

    /**
     * Elejti a futó kísérletet, és megjegyzi, MI volt: a hűtési időn belüli
     * újraindítás ugyanazokat a próbatípusokat kapja vissza. Kilépni mindig
     * szabad — csak ne legyen olcsóbb út, mint befejezni.
     */
    private fun dropSession(state: AppState, now: Long): AppState {
        val s = state.session ?: return state
        val combo = ChallengeEngine.comboKeyOf(
            s.steps.filter { it !is Step.Delay }.map { ChallengeEngine.typeNameOf(it) },
        )
        // A hűtés az ELSŐ feladástól számít, nem a legutóbbi újraindítástól,
        // különben minden újraindítás kitolná a határidőt, és a pár örökre
        // rátapadna az oldalra.
        val live = liveAbandons(state, now)
        val prev = live.firstOrNull { it.siteId == s.siteId }
        val at = if (prev != null && prev.comboKey == combo) prev.at else now
        return state.copy(
            session = null,
            abandons = live.filter { it.siteId != s.siteId } + AbandonRec(s.siteId, s.kind, combo, at),
        )
    }

    /** Még érvényes (hűtés alatti) tartozások, darabszámban is korlátozva. */
    private fun liveAbandons(state: AppState, now: Long): List<AbandonRec> =
        state.abandons
            .filter { now >= it.at && now - it.at <= ChallengeEngine.REROLL_COOLDOWN_MS }
            .takeLast(MAX_ABANDONS)

    /** Egyszerre hány oldal vihet tartozást — a cancelek nem növelhetik korlátlanul az állapotot. */
    private const val MAX_ABANDONS = 64

    /**
     * A feladott kísérlet által még „kötelező” kombináció, amíg le nem jár.
     *
     * A KIND szándékosan nem számít: a szünet és a törlés ugyanabból a
     * készletből húz, így egy megszakított törlés nem adhat friss párost a
     * szünethez — az csak egy kattintással több ugyanaz az újrapörgetés.
     */
    private fun forcedCombo(state: AppState, siteId: String, now: Long): String? =
        liveAbandons(state, now).firstOrNull { it.siteId == siteId }?.comboKey

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

    /**
     * Egy menet lezárása a naplóba — a statisztika ebből lesz.
     *
     * A csomag NEVÉT is elmentjük, nem csak az azonosítóját: a csomag azóta
     * átnevezhető vagy törölhető, és egy statisztika, ami „ismeretlen csomag”-ot
     * ír ki a múlt hétre, semmit nem ér.
     */
    private fun logFocusEnd(state: AppState, endedAt: Long, stopped: Boolean): List<Focus.FocusLogEntry> {
        val run = state.focusRun ?: return state.focusLog
        val pack = state.focusPacks.firstOrNull { it.id == run.packId }
        val entry = Focus.closeRun(run, pack?.name ?: "Ismeretlen csomag", endedAt, stopped)
        return (state.focusLog + entry).takeLast(Focus.MAX_FOCUS_LOG)
    }

    private fun finish(state: AppState, s: SessionRec, now: Long): AppState {
        // A MUNKAMENET nem egy oldalhoz tartozik, hanem az egész készülékhez:
        // ezért áll itt, az oldal-keresés ELŐTT. A -1 azt jelenti: állítsd le
        // most.
        if (s.pendingFocusEnd != null) {
            val nextRun = if (s.pendingFocusEnd < 0) null
                else state.focusRun?.copy(endsAt = s.pendingFocusEnd)
            // A naplót ITT írjuk, nem a `tick`-ben: csak innen derül ki, hogy a
            // menet PRÓBATÉTELLEL ért véget, nem magától. A kettő nem ugyanaz a
            // mondat, és a statisztikában sem ugyanaz a sor.
            val log = if (s.pendingFocusEnd < 0) logFocusEnd(state, now, true) else state.focusLog
            return state.copy(
                focusRun = nextRun,
                focusLog = log,
                unlockLog = state.unlockLog.filter { it > now - 30 * 24 * 3600_000L } + now,
                session = null,
                abandons = state.abandons.filter { it.siteId != s.siteId },
            )
        }
        val sites = state.sites.map { site ->
            if (site.id != s.siteId) site
            else if (s.pendingSchedule != null) site.copy(schedule = s.pendingSchedule) // gated loosening
            // -1 = „vedd le a keretet”; bármi más a beállítandó keret
            else if (s.pendingLimit != null) site.copy(
                dailyLimitSeconds = if (s.pendingLimit < 0) null else s.pendingLimit,
            )
            else if (s.pendingRuleRemoval != null) site.copy(
                rules = (site.rules ?: emptyList())
                    .filterNot { UrlRules.sameRule(it, s.pendingRuleRemoval) },
            )
            else if (s.kind == Kind.PAUSE) site.copy(pauseUntil = now + (s.minutes ?: 15) * 60_000L)
            else site.copy(pendingDeleteAt = now + ChallengeEngine.DELETE_PENDING_MS)
        }
        val log = state.unlockLog.filter { it > now - 30 * 24 * 3600_000L } + now
        // Megoldva: ennek az oldalnak a tartozása rendezve, a többié marad.
        return state.copy(
            sites = sites, unlockLog = log, session = null,
            abandons = state.abandons.filter { it.siteId != s.siteId },
        )
    }

    data class ScheduleChangeResult(val applied: Boolean, val session: SessionRec?)

    /**
     * Change a site's weekly schedule. Tightening applies immediately; loosening
     * requires the same challenges as a pause (mirrors desktop startScheduleChange).
     */
    fun startScheduleChange(siteId: String, schedule: ScheduleLogic.Schedule, now: Long): ScheduleChangeResult {
        var result: ScheduleChangeResult? = null
        BreakerStore.mutate { state ->
            val site = state.sites.find { it.id == siteId }
                ?: throw RefereeException("Ismeretlen oldal.", "NO_SITE")
            if (state.session != null) {
                throw RefereeException("Előbb fejezd be a folyamatban lévő kísérletet.", "BUSY")
            }
            val next = ScheduleLogic.normalize(schedule)
            val current = ScheduleLogic.normalize(site.schedule ?: ScheduleLogic.ALWAYS)
            if (!ScheduleLogic.isLoosening(current, next, now)) {
                result = ScheduleChangeResult(applied = true, session = null)
                return@mutate state.copy(sites = state.sites.map {
                    if (it.id == siteId) it.copy(schedule = next) else it
                })
            }
            val tier = effectiveTier(state, Kind.PAUSE, now)
            val plan = ChallengeEngine.generatePlan(
                Kind.PAUSE, tier, state.lastCombo, forcedCombo(state, siteId, now),
            )
            val session = SessionRec(
                id = BreakerStore.newId("ses"), kind = Kind.PAUSE, siteId = siteId, minutes = null,
                steps = armCurrent(plan.steps, 0, now), stepIndex = 0, createdAt = now,
                pendingSchedule = next,
            )
            result = ScheduleChangeResult(applied = false, session = session)
            state.copy(session = session, lastCombo = plan.comboKey)
        }
        return result!!
    }

    data class LimitChangeResult(val applied: Boolean, val session: SessionRec?)

    /**
     * Napi keret állítása. Bevezetni vagy csökkenteni szigorítás: azonnal
     * érvényes. Emelni vagy megszüntetni több időt vesz az oldalon, tehát
     * ugyanazokba a próbatételekbe kerül, mint egy feloldás — ugyanaz a
     * szabály, mint a menetrendnél, ugyanabból az okból.
     */
    fun startLimitChange(siteId: String, seconds: Long?, now: Long): LimitChangeResult {
        var result: LimitChangeResult? = null
        BreakerStore.mutate { state ->
            val site = state.sites.find { it.id == siteId }
                ?: throw RefereeException("Ismeretlen oldal.", "NO_SITE")
            if (state.session != null) {
                throw RefereeException("Előbb fejezd be a folyamatban lévő kísérletet.", "BUSY")
            }
            val next = LimitLogic.normalizeLimit(seconds)
            val current = LimitLogic.normalizeLimit(site.dailyLimitSeconds)
            if (!LimitLogic.isLimitLoosening(current, next)) {
                result = LimitChangeResult(applied = true, session = null)
                return@mutate state.copy(sites = state.sites.map {
                    if (it.id == siteId) it.copy(dailyLimitSeconds = next) else it
                })
            }
            val tier = effectiveTier(state, Kind.PAUSE, now)
            val plan = ChallengeEngine.generatePlan(
                Kind.PAUSE, tier, state.lastCombo, forcedCombo(state, siteId, now),
            )
            val session = SessionRec(
                id = BreakerStore.newId("ses"), kind = Kind.PAUSE, siteId = siteId, minutes = null,
                steps = armCurrent(plan.steps, 0, now), stepIndex = 0, createdAt = now,
                pendingLimit = next ?: -1L,
            )
            result = LimitChangeResult(applied = false, session = session)
            state.copy(session = session, lastCombo = plan.comboKey)
        }
        return result!!
    }

    data class RuleChangeResult(val applied: Boolean, val session: SessionRec?)

    /**
     * Részleges szabály felvétele vagy levétele.
     *
     * FELVENNI ingyen van: az szigorítás, és ha súrlódna, senki nem venne fel
     * szabályt — a funkció nem létezne. LEVENNI viszont ugyanabba a
     * próbatételbe kerül, mint egy feloldás: enélkül a részleges tiltás egyetlen
     * gomb lenne, és pont az a lényeg, hogy ne az legyen.
     *
     * Androidon a szabályt semmi nem érvényesíti (nincs böngésző-bővítmény), a
     * SÚRLÓDÁS viszont ugyanaz kell legyen. Ha itt egy kattintás lenne levenni,
     * a telefon lenne a legolcsóbb kiskapu a gépen beállított szabályokhoz.
     */
    fun startRuleChange(
        siteId: String, rule: UrlRules.UrlRule, remove: Boolean, now: Long,
    ): RuleChangeResult {
        var result: RuleChangeResult? = null
        BreakerStore.mutate { state ->
            val site = state.sites.find { it.id == siteId }
                ?: throw RefereeException("Ismeretlen oldal.", "NO_SITE")
            val rules = site.rules ?: emptyList()

            if (!remove) {
                if (rules.any { UrlRules.sameRule(it, rule) }) {
                    result = RuleChangeResult(applied = true, session = null)
                    return@mutate state   // mar ott van; nincs mit tenni
                }
                if (rules.size >= UrlRules.MAX_RULES_PER_SITE) {
                    throw RefereeException(
                        "Egy oldalhoz legfeljebb " + UrlRules.MAX_RULES_PER_SITE +
                            " részleges szabály tartozhat.",
                        "TOO_MANY_RULES",
                    )
                }
                result = RuleChangeResult(applied = true, session = null)
                return@mutate state.copy(sites = state.sites.map {
                    if (it.id == siteId) it.copy(rules = rules + rule) else it
                })
            }

            if (rules.none { UrlRules.sameRule(it, rule) }) {
                throw RefereeException("Nincs ilyen részleges szabály ezen az oldalon.", "NO_RULE")
            }
            if (state.session != null) {
                throw RefereeException("Előbb fejezd be a folyamatban lévő kísérletet.", "BUSY")
            }
            val tier = effectiveTier(state, Kind.PAUSE, now)
            val plan = ChallengeEngine.generatePlan(
                Kind.PAUSE, tier, state.lastCombo, forcedCombo(state, siteId, now),
            )
            val session = SessionRec(
                id = BreakerStore.newId("ses"), kind = Kind.PAUSE, siteId = siteId, minutes = null,
                steps = armCurrent(plan.steps, 0, now), stepIndex = 0, createdAt = now,
                pendingRuleRemoval = rule,
            )
            result = RuleChangeResult(applied = false, session = session)
            state.copy(session = session, lastCombo = plan.comboKey)
        }
        return result!!
    }

    /**
     * Mérés ki/be. Kikapcsolni nem lazítás — a saját adata —, EGY kivétellel:
     * a napi keret a mért időből fogy, tehát mérés nélkül sosem fogyna el.
     * Az csendes megkerülés lenne, ezért amíg van keret, a mérés nem
     * kapcsolható ki. (A desktop helper usage_enable ágának tükre.)
     */
    fun setUsageEnabled(enabled: Boolean) {
        BreakerStore.mutate { state ->
            if (!enabled && state.sites.any { LimitLogic.normalizeLimit(it.dailyLimitSeconds) != null }) {
                throw RefereeException(
                    "Amíg van napi időkeret beállítva, a mérés nem kapcsolható ki — abból fogy a keret.",
                    "LIMIT_NEEDS_USAGE",
                )
            }
            val next = UsageLogic.snapshot(state.usage)
            next.enabled = enabled
            state.copy(usage = next)
        }
    }

    private fun requireSession(state: AppState, sessionId: String, now: Long): SessionRec {
        val s = state.session
        if (s == null || s.id != sessionId) {
            throw RefereeException("Nincs ilyen aktív feloldási kísérlet.", "NO_SESSION")
        }
        if (now - s.createdAt > ChallengeEngine.SESSION_MAX_AGE_MS) {
            BreakerStore.mutate { dropSession(it, now) }
            throw RefereeException("A feloldási kísérlet lejárt, kezdd elölről.", "SESSION_EXPIRED")
        }
        return s
    }

    fun submitAnswer(sessionId: String, answer: String, now: Long): SubmitResult {
        var result: SubmitResult? = null
        BreakerStore.mutate { state ->
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
            // A failed answer can hand back a REGENERATED step (new memory code,
            // new sentence). It must be armed too, or a MEMORY step would have no
            // armedAt: the code is never shown and every answer is refused as
            // premature — the challenge becomes unsolvable.
            steps = armCurrent(steps, s.stepIndex, now)
            result = SubmitResult(accepted = outcome.ok, sessionDone = false, message = outcome.message)
            state.copy(session = s.copy(steps = steps))
        }
        return result!!
    }

    fun claimDelay(sessionId: String, now: Long): SubmitResult {
        // Expiry clears the session as a separate committed mutation, so the
        // exception below cannot roll it back.
        val pre = BreakerStore.state.value.session
        if (pre != null && pre.id == sessionId) {
            val step = pre.steps[pre.stepIndex]
            if (step is Step.Delay && step.claimableAt != null && now > step.claimableAt + step.claimWindowMs) {
                BreakerStore.mutate { dropSession(it, now) }
                throw RefereeException(
                    "Lecsúsztál az átvételi ablakról — a feloldási kísérlet érvénytelen, elölről kell kezdeni.",
                    "CLAIM_EXPIRED",
                )
            }
        }
        var result: SubmitResult? = null
        BreakerStore.mutate { state ->
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
        val now = System.currentTimeMillis()
        BreakerStore.mutate { state ->
            if (state.session?.id == sessionId) dropSession(state, now) else state
        }
    }

    /** housekeeping: re-lock ended pauses, run due deletions, drop dead sessions */
    /**
     * Két karbantartó kör között ennél nagyobb ugrás nem eltelt idő: a kör
     * másodpercenként fut, tehát pár percnél nagyobb különbség vagy az óra
     * átállítása, vagy a készülék alvása.
     */
    const val CLOCK_JUMP_THRESHOLD_MS: Long = 2 * 60_000L

    /** Az utolsó kör ideje. Memóriában, mert minden körben menteni pazarlás lenne. */
    @Volatile private var lastTickAt: Long = 0L

    /**
     * A várakozás itt maga a próba, és amit az óra átállítása legyőz, az nem
     * próba: előre állított rendszerórával a DELAY lépés azonnal átvehető lenne,
     * a törlés türelmi ideje pedig azonnal lejárna. Ezért a *védő* határidőket
     * (várakozás célpontja, folyamatban lévő törlés, a kísérlet kora) annyival
     * toljuk ki, amennyit a fali óra ugrott — vagyis eltelt időt mérnek, nem
     * dátumot. Az alvás kívülről ugyanígy néz ki, és ugyanígy kezeljük: alvás
     * közben nem telik a várakozás (ez a szigorúbb irány).
     *
     * A pauseUntil szándékosan kimarad: ott az előre ugró óra korábban zár
     * vissza, a szigorítást pedig nem kell védeni.
     */
    private fun absorbClockJump(now: Long) {
        val last = lastTickAt
        lastTickAt = now
        if (last == 0L) return
        val jump = now - last
        if (jump <= CLOCK_JUMP_THRESHOLD_MS) return
        val shift = jump - CLOCK_JUMP_THRESHOLD_MS

        BreakerStore.mutate { state ->
            val session = state.session?.let { s ->
                val step = s.steps.getOrNull(s.stepIndex)
                val steps = if (step is Step.Delay && step.claimableAt != null) {
                    s.steps.toMutableList().also { it[s.stepIndex] = step.copy(claimableAt = step.claimableAt + shift) }
                } else {
                    s.steps
                }
                // …és az ugrás miatt a kísérlet se évüljön el
                s.copy(steps = steps, createdAt = s.createdAt + shift)
            }
            val sites = state.sites.map {
                if (it.pendingDeleteAt != null) it.copy(pendingDeleteAt = it.pendingDeleteAt + shift) else it
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
            val run = state.focusRun?.let {
                it.copy(startedAt = it.startedAt + shift, endsAt = it.endsAt + shift)
            }
            state.copy(session = session, sites = sites, focusRun = run)
        }
    }

    fun tick(now: Long) {
        absorbClockJump(now)
        // Cheap pre-check: this runs on the DNS hot path, only mutate when needed.
        val st = BreakerStore.state.value
        val sessionDead = st.session?.let { s ->
            val step = s.steps[s.stepIndex]
            (step is Step.Delay && step.claimableAt != null && now > step.claimableAt + step.claimWindowMs) ||
                now - s.createdAt > ChallengeEngine.SESSION_MAX_AGE_MS
        } ?: false
        val pauseEnded = st.sites.any { it.pauseUntil != null && it.pauseUntil <= now }
        val deleteDue = st.sites.any { it.pendingDeleteAt != null && it.pendingDeleteAt <= now }
        // A MAGÁTÓL lejárt menet is lezárul — enélkül csak a próbatétellel
        // leállított menetek kerülnének a statisztikába, vagyis pont azok
        // hiányoznának, amiket a felhasználó VÉGIGVITT. Az a statisztika
        // rosszabb a semminél: azt mondaná, hogy sosem sikerül.
        val focusEnded = st.focusRun != null && st.focusRun.endsAt <= now
        if (!sessionDead && !pauseEnded && !deleteDue && !focusEnded) return

        BreakerStore.mutate { state ->
            var next = state
            // A várakozási ablak kihagyása is befejezés — ugyanaz a könyvelés,
            // hogy ne lehessen vele nemszeretem párból kimenekülni.
            if (sessionDead) next = dropSession(next, now)
            val sites = next.sites
                .map { if (it.pauseUntil != null && it.pauseUntil <= now) it.copy(pauseUntil = null) else it }
                .filter { it.pendingDeleteAt == null || it.pendingDeleteAt > now }
            val closed = Focus.closeIfEnded(next.focusRun, next.focusPacks, next.focusLog, now)
            next = next.copy(sites = sites)
            if (closed == null) next else next.copy(focusRun = closed.run, focusLog = closed.log)
        }
    }

    // ----------------------------------------------------------- munkamenet

    data class FocusChangeResult(val applied: Boolean, val session: SessionRec?)

    /**
     * Munkamenet indítása. INGYEN van — ez a szigorítás iránya.
     *
     * Egyszerre egy menet fut. Enélkül a leállítás próbatételét meg lehetne
     * kerülni: indítok egy „minden engedve” csomagot, és kész.
     */
    fun startFocus(packId: String, minutes: Int, now: Long) {
        BreakerStore.mutate { state ->
            val pack = state.focusPacks.find { it.id == packId }
                ?: throw RefereeException("Ismeretlen csomag.", "NO_PACK")
            if (Focus.isRunning(state.focusRun, now)) {
                throw RefereeException("Már fut egy munkamenet.", "FOCUS_RUNNING")
            }
            val mins = Focus.normalizeMinutes(minutes.toDouble())
                ?: throw RefereeException("Érvénytelen hossz.", "BAD_MINUTES")
            state.copy(
                focusRun = Focus.FocusRun(pack.id, now, now + mins * 60_000L),
            )
        }
    }

    /**
     * A futó menet vége odébb tolva — vagy a leállítása.
     *
     * HOSSZABBÍTANI ingyen van, RÖVIDÍTENI és LEÁLLÍTANI próbatételbe kerül.
     * Ugyanaz a szabály, mint mindenhol: enélkül a munkamenet egy „mégsem”
     * gomb lenne, és pont az a lényeg, hogy ne az legyen.
     *
     * @param nextEndsAt az új vég, vagy null = állítsd le most
     */
    fun changeFocus(nextEndsAt: Long?, now: Long): FocusChangeResult {
        var applied = false
        var created: SessionRec? = null
        BreakerStore.mutate { state ->
            val run = state.focusRun
            if (!Focus.isRunning(run, now)) {
                throw RefereeException("Nem fut munkamenet.", "NO_FOCUS")
            }
            val current = run!!.endsAt
            val next = nextEndsAt ?: now

            if (!Focus.isSessionLoosening(current, next)) {
                applied = true
                return@mutate state.copy(focusRun = run.copy(endsAt = next))
            }
            if (state.session != null) {
                throw RefereeException("Előbb fejezd be a folyamatban lévő kísérletet.", "BUSY")
            }
            val dropped = dropSession(state, now)
            val tier = effectiveTier(dropped, Kind.PAUSE, now)
            val plan = ChallengeEngine.generatePlan(Kind.PAUSE, tier, dropped.lastCombo, null)
            val session = SessionRec(
                id = BreakerStore.newId("ses"), kind = Kind.PAUSE,
                // A munkamenet nem oldalhoz tartozik; a jelölés mégis kell, mert
                // a feladott kísérletek nyilvántartása oldalanként megy.
                siteId = "focus:" + run.packId,
                minutes = null,
                steps = armCurrent(plan.steps, 0, now), stepIndex = 0, createdAt = now,
                // A -1 a „állítsd le most”; a nulla érvényes időpont lenne.
                pendingFocusEnd = nextEndsAt ?: -1L,
            )
            created = session
            dropped.copy(session = session, lastCombo = plan.comboKey)
        }
        return FocusChangeResult(applied, created)
    }
}
