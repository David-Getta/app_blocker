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

    /**
     * A MOST érvényes zárlat: a futó, vagy amit egy élő ablak épp megkövetel —
     * akkor is, ha a kör még nem írta be. Az ablak kezdése és az első kör
     * közti másodpercek nem lehetnek rés. A desktop `currentLockdown` tükre.
     */
    fun currentLockdown(state: AppState, now: Long): LockdownLogic.Lockdown? =
        LockdownLogic.windowLockdown(state.lockdown, state.lockdownWindows.map { it.band }, now)
            ?: LockdownLogic.live(state.lockdown, now)

    /**
     * A ZÁRLAT ŐRE. Amíg zárlat van, a lazítás nem drágább — nincs.
     *
     * Nem hibaüzenet-ízesítés: ez a különbség a nehéz és a lehetetlen között.
     * A próbatétel drágít, tehát utat is kínál; a zárlat alatt nincs mit
     * teljesíteni. A desktop `assertUnlocked` tükre.
     */
    private fun requireUnlocked(state: AppState, now: Long) {
        val lock = currentLockdown(state, now) ?: return
        val left = LockdownLogic.formatRemaining(lock.until - now)
        throw RefereeException(
            "Zárlat van érvényben, $left van hátra. Amíg tart, semmilyen lazítás nem " +
                "indítható — próbatétellel sem.",
            "LOCKDOWN",
        )
    }

    /**
     * MINDEN lazító próbatétel terve ezen az egy kapun megy ki.
     *
     * Azért egyetlen helyen, mert a visszatérő hibánk nem a rossz logika,
     * hanem a KIHAGYOTT hívás: hat belépési pontra hat külön ellenőrzésből egy
     * előbb-utóbb lemaradna, és a hiányt semmi nem mutatná meg — egy nem hívott
     * ellenőrzés érvényes kód.
     */
    private fun planLoosening(
        state: AppState, kind: Kind, comboSiteId: String?, now: Long,
    ): ChallengeEngine.Plan {
        requireUnlocked(state, now)
        val tier = effectiveTier(state, kind, now)
        val forced = if (comboSiteId == null) null else forcedCombo(state, comboSiteId, now)
        val plan = ChallengeEngine.generatePlan(kind, tier, state.lastCombo, forced)
        // PÁRBAN ZÁROLÁS: ha van megbízott, az utolsó szó az övé — MINDEN
        // lazításnál, mert mind ezen az egy kapun jön ki. A várakozás UTÁN áll.
        val partner = state.partner ?: return plan
        return plan.copy(steps = plan.steps + Step.Partner(BreakerStore.newId("st"), partner.name))
    }

    data class PartnerSetup(val name: String, val phrase: String)
    data class PartnerChangeResult(val applied: Boolean, val session: SessionRec?)

    /**
     * Megbízott felvétele — INGYEN, mert szigorítás. A jelmondatot itt
     * sorsoljuk, és EGYSZER adjuk vissza: a felület megmutatja, a felhasználó
     * átadja; a tár csak a lenyomatot tartja meg.
     */
    fun setPartner(rawName: String, now: Long): PartnerSetup {
        var out: PartnerSetup? = null
        BreakerStore.mutate { state ->
            if (state.partner != null) {
                throw RefereeException("Már van megbízott. Előbb vedd le — az próbatétel, az ő jelmondatával.", "PARTNER_SET")
            }
            val name = PartnerLogic.normalizePartnerName(rawName)
                ?: throw RefereeException("Adj a megbízottnak egy nevet.", "BAD_NAME")
            val phrase = ChallengeEngine.makePartnerPhrase()
            out = PartnerSetup(name, phrase)
            state.copy(partner = PartnerLogic.makeLock(name, phrase, now))
        }
        return out!!
    }

    /** A megbízott levétele — próbatétel, a terv végén az ő jelmondatával: a levételhez is ő kell. */
    fun startPartnerRemoval(now: Long): PartnerChangeResult {
        var result: PartnerChangeResult? = null
        BreakerStore.mutate { state ->
            if (state.partner == null) {
                result = PartnerChangeResult(applied = true, session = null)
                return@mutate state
            }
            if (state.session != null) {
                throw RefereeException("Előbb fejezd be a folyamatban lévő kísérletet.", "BUSY")
            }
            val plan = planLoosening(state, Kind.PAUSE, null, now)
            val session = SessionRec(
                id = BreakerStore.newId("ses"), kind = Kind.PAUSE, siteId = "partner", minutes = null,
                steps = armCurrent(plan.steps, 0, now), stepIndex = 0, createdAt = now,
                pendingPartnerRemoval = true,
            )
            result = PartnerChangeResult(applied = false, session = session)
            state.copy(session = session, lastCombo = plan.comboKey)
        }
        return result!!
    }

    /**
     * Zárlat indítása vagy hosszabbítása. Ez a MÁSIK irány: ingyen van.
     *
     * A zárlat a folyamatban lévő lazításokat is visszaveszi, különben az
     * indítás pillanata maga lenne a kibúvó: a futó próbatétel elszáll, a
     * feloldott oldalak visszazárnak, a folyamatban lévő törlések
     * visszavonódnak. A futó munkamenethez nem nyúl: az fehérlista, vagyis
     * maga is szigorítás.
     */
    fun startLockdown(ms: Long, now: Long): LockdownLogic.Lockdown? {
        var out: LockdownLogic.Lockdown? = null
        BreakerStore.mutate { state ->
            val next = LockdownLogic.start(state.lockdown, ms, now)
                ?: throw RefereeException("Érvénytelen zárlat-hossz.", "BAD_LOCKDOWN")
            out = next
            dropSession(state, now).copy(
                sites = state.sites.map { it.copy(pauseUntil = null, pendingDeleteAt = null) },
                lockdown = next,
            )
        }
        return out
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
            val plan = planLoosening(dropped, kind, siteId, now)
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
        // A megbízott lépése nem sorsolt próba: a kombináció-kulcsba nem számít.
        val combo = ChallengeEngine.comboKeyOf(
            s.steps.filter { it !is Step.Delay && it !is Step.Partner }.map { ChallengeEngine.typeNameOf(it) },
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
            // A FÉLBEMARADT kísérlet is könyvelés: a visszatekintés ebből mondja,
            // hányszor indult el a lazítás, és maradt félbe. Harminc napig,
            // mint a feloldások.
            droppedAttempts = state.droppedAttempts.filter { it > now - 30 * 24 * 3600_000L } + now,
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
        // Az ablakból indult-e: a naplósor viszi, a statisztika és a heti mondat mondja.
        val entry = Focus.closeRun(run, pack?.name ?: "Ismeretlen csomag", endedAt, stopped, Focus.isWindowRun(run, state.focusPacks))
        return (state.focusLog + entry).takeLast(Focus.MAX_FOCUS_LOG)
    }

    private fun finish(state: AppState, s: SessionRec, now: Long): AppState {
        // A MEGBÍZOTT LEVÉTELE: nem oldalhoz tartozik. Idáig csak próbatétellel
        // lehet eljutni — a végén az ő jelmondatával, tehát ő is bólintott.
        if (s.pendingPartnerRemoval) {
            return state.copy(
                partner = null,
                unlockLog = state.unlockLog.filter { it > now - 30 * 24 * 3600_000L } + now,
                session = null,
                abandons = state.abandons.filter { it.siteId != s.siteId },
            )
        }
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
        // A KULCSSZAVAK sem oldalhoz tartoznak: a listát itt cseréljük, mert
        // idáig csak próbatétellel lehet eljutni — a levétel ára ez a menet volt.
        if (s.pendingKeywords != null) {
            return state.copy(
                keywords = s.pendingKeywords,
                unlockLog = state.unlockLog.filter { it > now - 30 * 24 * 3600_000L } + now,
                session = null,
                abandons = state.abandons.filter { it.siteId != s.siteId },
            )
        }
        // A ZÁRLAT-ABLAKOK sem oldalhoz tartoznak. Idáig csak próbatétellel
        // lehet eljutni — a levétel vagy a szűkítés ára ez a menet volt. A futó
        // zárlathoz nem nyúl: a zárlat sosem rövidül; de ide csak ablakon
        // kívülről lehet eljutni, mert bent a kapu nem enged próbatételt.
        if (s.pendingLockdownWindows != null) {
            return state.copy(
                lockdownWindows = s.pendingLockdownWindows,
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
            else if (s.pendingBurst != null) site.copy(
                burstSeconds = if (s.pendingBurst < 0) null else s.pendingBurst,
                cooldownSeconds = if (s.pendingBurst < 0) null else s.pendingCooldown,
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
            val plan = planLoosening(state, Kind.PAUSE, siteId, now)
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

    data class WindowsChangeResult(val applied: Boolean, val session: SessionRec?)

    /**
     * A zárlat-ablakok beállítása: a TELJES lista jön, és a tárolt lista ezt
     * követi. Felvenni és bővíteni ingyen; levenni vagy szűkíteni próbatétel —
     * és csak ablakon kívül, mert bent a kapu zárlatot lát. Az egész hét nem
     * zárható le. Az azonosító nélküli ablak új: itt kap azonosítót. A
     * desktop `setLockdownWindows` tükre.
     */
    fun setLockdownWindows(windows: List<LockdownLogic.LockdownWindow>, now: Long): WindowsChangeResult {
        var result: WindowsChangeResult? = null
        BreakerStore.mutate { state ->
            val items = windows.map { if (it.id.isEmpty()) it.copy(id = BreakerStore.newId("lw")) else it }
            if (items.any { LockdownLogic.cleanWindow(it) == null }) {
                throw RefereeException(
                    "Érvénytelen ablak: legalább egy nap kell, és egy kezdés meg egy vég.", "BAD_WINDOW",
                )
            }
            if (items.size > LockdownLogic.MAX_LOCKDOWN_WINDOWS) {
                throw RefereeException(
                    "Legfeljebb ${LockdownLogic.MAX_LOCKDOWN_WINDOWS} ablak fér el.", "TOO_MANY_WINDOWS",
                )
            }
            val next = LockdownLogic.cleanWindows(items)
            if (!LockdownLogic.weekHasFreeTime(next.map { it.band }, now)) {
                throw RefereeException(
                    "Az egész hét nem zárható le: legalább egy szabad óra kell a héten az ablakok " +
                        "mellett — különben az ablakot sosem lehetne levenni.",
                    "NO_FREE_TIME",
                )
            }
            val current = state.lockdownWindows
            if (LockdownLogic.sameWindows(current.map { it.band }, next.map { it.band })) {
                result = WindowsChangeResult(applied = true, session = null)
                return@mutate state
            }
            if (!LockdownLogic.isWindowsLoosening(current.map { it.band }, next.map { it.band }, now)) {
                // A meglévő ablak azonosítója marad; a sorrend az új listáé.
                val kept = next.map { n ->
                    current.firstOrNull { LockdownLogic.windowKey(it.band) == LockdownLogic.windowKey(n.band) } ?: n
                }
                result = WindowsChangeResult(applied = true, session = null)
                return@mutate state.copy(lockdownWindows = kept)
            }
            if (state.session != null) {
                throw RefereeException("Előbb fejezd be a folyamatban lévő kísérletet.", "BUSY")
            }
            val plan = planLoosening(state, Kind.PAUSE, null, now)
            val session = SessionRec(
                id = BreakerStore.newId("ses"), kind = Kind.PAUSE, siteId = "lockdown:windows", minutes = null,
                steps = armCurrent(plan.steps, 0, now), stepIndex = 0, createdAt = now,
                pendingLockdownWindows = next,
            )
            result = WindowsChangeResult(applied = false, session = session)
            state.copy(session = session, lastCombo = plan.comboKey)
        }
        return result!!
    }

    data class KeywordsChangeResult(val applied: Boolean, val session: SessionRec?)

    /**
     * A kulcsszavak beállítása: a TELJES lista jön, és a tárolt lista ezt
     * követi. Felvenni ingyen (szigorítás: több cím zárva); levenni
     * próbatétel — különben a kulcsszó egy kikapcsolóval érne fel. A telefon
     * nem érvényesít (a DNS a címet nem látja), de szerkeszt és hordoz: a
     * fiókon át a gépi böngésző tilt vele. A desktop `setKeywords` tükre.
     */
    fun setKeywords(input: List<String>, now: Long): KeywordsChangeResult {
        var result: KeywordsChangeResult? = null
        BreakerStore.mutate { state ->
            if (input.size > KeywordLogic.MAX_KEYWORDS) {
                throw RefereeException("Legfeljebb ${KeywordLogic.MAX_KEYWORDS} kulcsszó fér el.", "TOO_MANY_KEYWORDS")
            }
            val next = KeywordLogic.cleanKeywords(input)
            if (next.size != input.size) {
                throw RefereeException(
                    "Érvénytelen kulcsszó: ${KeywordLogic.MIN_KEYWORD_LENGTH}–${KeywordLogic.MAX_KEYWORD_LENGTH} " +
                        "karakter, szóköz nélkül — és minden szó csak egyszer.",
                    "BAD_KEYWORD",
                )
            }
            val current = state.keywords
            if (KeywordLogic.sameKeywords(current, next)) {
                result = KeywordsChangeResult(applied = true, session = null)
                return@mutate state
            }
            if (!KeywordLogic.isKeywordsLoosening(current, next)) {
                // Futó levétel közben a felvétel is ingyen — és a levétel VÉGÉN
                // sem veszhet el: a függő lista is megkapja, ami közben jött.
                val session = state.session?.let { s ->
                    val pending = s.pendingKeywords
                    if (pending == null) s
                    else s.copy(pendingKeywords = KeywordLogic.cleanKeywords(pending + next.filter { it !in current }))
                }
                result = KeywordsChangeResult(applied = true, session = null)
                return@mutate state.copy(keywords = next, session = session)
            }
            if (state.session != null) {
                throw RefereeException("Előbb fejezd be a folyamatban lévő kísérletet.", "BUSY")
            }
            val plan = planLoosening(state, Kind.PAUSE, null, now)
            val session = SessionRec(
                id = BreakerStore.newId("ses"), kind = Kind.PAUSE, siteId = "keywords", minutes = null,
                steps = armCurrent(plan.steps, 0, now), stepIndex = 0, createdAt = now,
                pendingKeywords = next,
            )
            result = KeywordsChangeResult(applied = false, session = session)
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
            val plan = planLoosening(state, Kind.PAUSE, siteId, now)
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

    /**
     * Adag-szabály állítása: ennyi használat után ennyi szünet. Felvenni,
     * kisebb adagra vagy hosszabb szünetre állítani szigorítás — azonnal él.
     * Nagyobb adag, rövidebb szünet vagy a levétel próbatételbe kerül. A futó
     * hűtést a csere nem engedi el: az magától jár le.
     */
    fun startBurstChange(
        siteId: String, burstSeconds: Long?, cooldownSeconds: Long?, now: Long,
    ): LimitChangeResult {
        var result: LimitChangeResult? = null
        BreakerStore.mutate { state ->
            val site = state.sites.find { it.id == siteId }
                ?: throw RefereeException("Ismeretlen oldal.", "NO_SITE")
            if (state.session != null) {
                throw RefereeException("Előbb fejezd be a folyamatban lévő kísérletet.", "BUSY")
            }
            val next = BurstLogic.normalize(burstSeconds, cooldownSeconds)
            if (next == null && (burstSeconds != null || cooldownSeconds != null)) {
                throw RefereeException("Az adaghoz mindkét szám kell: használat is, szünet is.", "BAD_BURST")
            }
            val current = BurstLogic.normalize(site.burstSeconds, site.cooldownSeconds)
            if (!BurstLogic.isLoosening(current, next)) {
                result = LimitChangeResult(applied = true, session = null)
                return@mutate state.copy(sites = state.sites.map {
                    if (it.id == siteId) it.copy(
                        burstSeconds = next?.burstSeconds, cooldownSeconds = next?.cooldownSeconds,
                    ) else it
                })
            }
            val plan = planLoosening(state, Kind.PAUSE, siteId, now)
            val session = SessionRec(
                id = BreakerStore.newId("ses"), kind = Kind.PAUSE, siteId = siteId, minutes = null,
                steps = armCurrent(plan.steps, 0, now), stepIndex = 0, createdAt = now,
                pendingBurst = next?.burstSeconds ?: -1L,
                pendingCooldown = next?.cooldownSeconds ?: -1L,
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
            val plan = planLoosening(state, Kind.PAUSE, siteId, now)
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
            // Az ADAG-SZABÁLY ugyanígy: a számlálója a mért időből gyűlik,
            // kikapcsolt mérés mellett sosem telne be — a kikapcsolás lett volna
            // az az egy koppintás, ami próbatétel nélkül hatástalanítja.
            val needsUsage = state.sites.any {
                LimitLogic.normalizeLimit(it.dailyLimitSeconds) != null ||
                    BurstLogic.normalize(it.burstSeconds, it.cooldownSeconds) != null
            }
            if (!enabled && needsUsage) {
                throw RefereeException(
                    "Amíg van napi időkeret vagy adag-szabály beállítva, a mérés nem kapcsolható ki — " +
                        "abból fogy a keret és az adag.",
                    "LIMIT_NEEDS_USAGE",
                )
            }
            val next = UsageLogic.snapshot(state.usage)
            next.enabled = enabled
            state.copy(usage = next)
        }
    }

    /**
     * A mérési előzmény törlése. A MAI NAP MARAD, amíg van beállított napi
     * keret: abból fogy a keret, tehát a mai adat törlése azonnal újratöltené
     * — próbatétel nélkül, korlátlanul. A régebbi napok törlése így is megy.
     * (A desktop helper `usage_clear` ágának tükre.)
     */
    fun clearUsage(now: Long) {
        BreakerStore.mutate { state ->
            val hasLimit = state.sites.any { LimitLogic.normalizeLimit(it.dailyLimitSeconds) != null }
            state.copy(usage = UsageLogic.clearUsage(state.usage, hasLimit, now))
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
            if (step is Step.Partner) {
                // A jelmondat a lenyomattal összevetve. Rossz jelmondat nem
                // sorsol újat, csak számol; a plafonnál a kísérlet elszáll —
                // elölről, minden lépéssel. Ha a megbízott közben (a
                // szinkronból) lekerült, a lépés tárgytalan: átmegy.
                val lock = state.partner
                if (lock != null && !PartnerLogic.verify(lock, answer)) {
                    val tries = s.partnerTries + 1
                    if (tries >= PartnerLogic.MAX_PARTNER_TRIES) {
                        result = SubmitResult(
                            false, false,
                            "${PartnerLogic.MAX_PARTNER_TRIES}-ször nem ez volt a jelmondat — a kísérlet érvénytelen, elölről kell kezdeni.",
                        )
                        return@mutate dropSession(state, now)
                    }
                    result = SubmitResult(false, false, "Nem ez a jelmondat. Kérd meg a megbízottadat, hogy ő írja be.")
                    return@mutate state.copy(session = s.copy(partnerTries = tries))
                }
                val nextIndex = s.stepIndex + 1
                if (nextIndex >= s.steps.size) {
                    result = SubmitResult(accepted = true, sessionDone = true)
                    return@mutate finish(state, s, now)
                }
                val steps = armCurrent(s.steps, nextIndex, now)
                result = SubmitResult(accepted = true, sessionDone = false)
                return@mutate state.copy(session = s.copy(steps = steps, stepIndex = nextIndex))
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

    /**
     * Milyen ritkán írjuk ki az alapvonalat. Minden körben menteni pazarlás
     * lenne (a kör minden DNS-kérésnél fut), viszont EL KELL, hogy férjen az
     * ugrás-küszöb alá: így a késleltetett kiírás önmagában sosem látszik
     * óra-ugrásnak.
     */
    private const val TICK_SAVE_INTERVAL_MS: Long = 60_000L

    /** Mikor írtuk ki utoljára — csak a ritkításhoz, az alapvonal a lemezen van. */
    @Volatile private var lastTickSavedAt: Long = 0L

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
     *
     * AZ ALAPVONAL A LEMEZRŐL JÖN (BreakerStore.loadLastTick), nem a
     * memóriából. Amíg memóriában élt, az app KILÖVÉSE után az első kör csak
     * új alapvonalat vett fel: a folyamat leállítása + óra-előreállítás ingyen
     * megrövidítette a várakozást. A gépen ez a szám mindig a mentett
     * állapotban volt; most itt is túléli az újraindítást.
     */
    private fun absorbClockJump(now: Long) {
        val last = BreakerStore.loadLastTick()
        val fresh = last == 0L
        val jump = if (fresh) 0L else now - last
        val jumped = jump > CLOCK_JUMP_THRESHOLD_MS
        // Kiírjuk: az első körben (legyen alapvonal), ugráskor (az új alapvonal
        // ne vesszen el), visszafelé állított óránál, egyébként ritkítva.
        if (fresh || jumped || now < lastTickSavedAt || now - lastTickSavedAt >= TICK_SAVE_INTERVAL_MS) {
            lastTickSavedAt = now
            BreakerStore.saveLastTick(now)
        }
        if (!jumped) return
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
            //
            // Az ABLAK-menet kivétel: annak a vége az ablak vége, nem tolódik a
            // készülék alvásával (Focus.isWindowRun) — különben a telefon és a
            // gép két különböző menetet látna ugyanarról a délelőttről.
            val run = state.focusRun?.let {
                if (Focus.isWindowRun(it, state.focusPacks)) it
                else it.copy(startedAt = it.startedAt + shift, endsAt = it.endsAt + shift)
            }
            // A ZÁRLAT VÉGE IS TOLÓDIK. Enélkül az óra előreállítása ingyen
            // befejezné — pont azt az egyetlen dolgot, aminek szándékosan
            // nincs visszaútja. Ugyanaz a mondat: amennyi hátra volt, annyi
            // van hátra.
            //
            // Az ABLAK-ZÁRLAT kivétel, ugyanazzal az indokkal, mint az
            // ablak-menet: annak a vége az ablak vége. A telefon alvása nem
            // hosszabbítja a hétköznapot (LockdownLogic.isWindowLockdown).
            val lock = state.lockdown?.let {
                if (LockdownLogic.isWindowLockdown(it, state.lockdownWindows.map { w -> w.band })) it
                else LockdownLogic.Lockdown(it.startedAt + shift, it.until + shift)
            }
            state.copy(session = session, sites = sites, focusRun = run, lockdown = lock)
        }
    }

    /** Az ismétlődés-vizsgálat utolsó tizenöt másodperces szelete (lásd a tick-et). */
    @Volatile private var lastDueSlot = -1L

    fun tick(now: Long) {
        absorbClockJump(now)
        // Cheap pre-check: this runs on the DNS hot path, only mutate when needed.
        val st = BreakerStore.state.value
        val sessionDead = st.session?.let { s ->
            val step = s.steps[s.stepIndex]
            (step is Step.Delay && step.claimableAt != null && now > step.claimableAt + step.claimWindowMs) ||
                now - s.createdAt > ChallengeEngine.SESSION_MAX_AGE_MS
        } ?: false
        // AZ ABLAK ZÁRLATOT ÍR. Ha él egy zárlat-ablak, és a futó zárlat vége az
        // ablak végénél korábbi (vagy nincs zárlat), az ablak végéig szóló
        // zárlat kerül az állapotba — pontosan az, amit kézzel is lehet. A DNS-
        // útvonalon fut, ezért tizenöt másodpercenként nézzük (mint az ablak-
        // menetet); a kapu az ablakot a kör előtt is látja (currentLockdown).
        val slot = now / 15_000
        val slotDue = slot != lastDueSlot
        if (slotDue) lastDueSlot = slot
        val windowLock = if (slotDue) {
            LockdownLogic.windowLockdown(st.lockdown, st.lockdownWindows.map { it.band }, now)
        } else {
            null
        }
        // A ZÁRLAT MÁSIK ESZKÖZRŐL is megérkezhet, a kör közepén: a szinkron
        // lehozza, és onnantól itt sem maradhat feloldott oldal, kifizetett
        // törlés vagy futó kísérlet. Enélkül a gépen indított zárlat a
        // telefonon nem jelentene semmit — és pont az lenne a kibúvó.
        val locked = LockdownLogic.isLocked(windowLock ?: st.lockdown, now)
        val pauseEnded = st.sites.any { it.pauseUntil != null && (locked || it.pauseUntil <= now) }
        val deleteDue = st.sites.any {
            it.pendingDeleteAt != null && (locked || it.pendingDeleteAt <= now)
        }
        val lockedSession = locked && st.session != null
        // A MAGÁTÓL lejárt menet is lezárul — enélkül csak a próbatétellel
        // leállított menetek kerülnének a statisztikába, vagyis pont azok
        // hiányoznának, amiket a felhasználó VÉGIGVITT. Az a statisztika
        // rosszabb a semminél: azt mondaná, hogy sosem sikerül.
        val focusEnded = st.focusRun != null && st.focusRun.endsAt <= now
        // MENETREND SZERINTI INDÍTÁS. Az ablakban, ha nem fut semmi, és a napló
        // szerint ebben az ablakban még nem indult, a csomag menete magától
        // indul. Ez a DNS-útvonalon fut, ezért tizenöt másodpercenként nézzük,
        // nem minden kérdésnél — az ablak percekben él, nem másodpercekben.
        val focusDue = slotDue && Focus.dueRecurrence(st.focusPacks, st.focusRun, st.focusLog, now) != null
        if (!sessionDead && !lockedSession && !pauseEnded && !deleteDue && !focusEnded && !focusDue &&
            windowLock == null
        ) {
            return
        }

        BreakerStore.mutate { state ->
            var next = state
            // Az ablak zárlata a FRISS állapotból, a takarítás előtt — a
            // többi lépés (a kísérlet elszáll, a feloldás visszazár) ugyanazt a
            // mezőt nézi, mint kézi zárlatnál.
            LockdownLogic.windowLockdown(next.lockdown, next.lockdownWindows.map { it.band }, now)?.let {
                next = next.copy(lockdown = it)
            }
            // A várakozási ablak kihagyása is befejezés — ugyanaz a könyvelés,
            // hogy ne lehessen vele nemszeretem párból kimenekülni.
            if (sessionDead || lockedSession) next = dropSession(next, now)
            val sites = next.sites
                .map {
                    if (it.pauseUntil != null && (locked || it.pauseUntil <= now)) {
                        it.copy(pauseUntil = null)
                    } else {
                        it
                    }
                }
                // Zárlat alatt a kifizetett törlés is visszavonódik: az oldal
                // marad, a kivárt idő elvész. A szigorúbb irány, és a zárlat ára.
                .map { if (locked && it.pendingDeleteAt != null) it.copy(pendingDeleteAt = null) else it }
                .filter { it.pendingDeleteAt == null || it.pendingDeleteAt > now }
            val closed = Focus.closeIfEnded(next.focusRun, next.focusPacks, next.focusLog, now)
            next = next.copy(sites = sites)
            if (closed != null) next = next.copy(focusRun = closed.run, focusLog = closed.log)
            // Az ablak kezdésével és végével — a gép ugyanezt a menetet
            // állítja elő, a szinkron a kettőt egynek látja.
            val due = Focus.dueRecurrence(next.focusPacks, next.focusRun, next.focusLog, now)
            if (due != null) {
                // Egy MÁSIK csomag kézi menete az ablak kezdetén véget ér — az
                // ablak az ígéret. A naplóba a saját idejével, nem leállítottként:
                // nem a felhasználó állította le, az ablak jött.
                val running = next.focusRun
                var log = next.focusLog
                if (running != null && Focus.isRunning(running, now)) {
                    val name = next.focusPacks.firstOrNull { it.id == running.packId }?.name ?: "Ismeretlen csomag"
                    log = (log + Focus.closeRun(running, name, now, false, Focus.isWindowRun(running, next.focusPacks))).takeLast(Focus.MAX_FOCUS_LOG)
                }
                next = next.copy(
                    focusRun = Focus.FocusRun(due.pack.id, due.startsAt, due.endsAt),
                    focusLog = log,
                )
            }
            next
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
     * CSOMAG FELVÉTELE a telefonon: név, engedett oldalak, szokásos hossz.
     *
     * Csak felvétel — az nem lazít semmit: a csomag addig nem tesz semmit,
     * amíg menetet nem indítasz vele, az pedig szigorítás. Szerkeszteni,
     * törölni, az ablakot cserélni a gépen lehet (a lazítás kérdései ott
     * dőlnek el). A csomag jelét a következő léptetés írja (SyncRevisions),
     * hogy a fésülésben ez a változat nyerjen. A Swift `addFocusPack` tükre.
     */
    fun addFocusPack(name: String, allowSites: List<String>, defaultMinutes: Int): Focus.FocusPack {
        val cleanName = name.trim().split(' ', '\t', '\n').filter { it.isNotEmpty() }.joinToString(" ").take(Focus.MAX_PACK_NAME)
        if (cleanName.isEmpty()) throw RefereeException("Adj nevet a csomagnak.", "BAD_NAME")
        val sites = LinkedHashSet<String>()
        for (s in allowSites) {
            val n = Focus.normalizeAllowSite(s) ?: continue
            if (sites.size < Focus.MAX_ALLOW_ENTRIES) sites.add(n)
        }
        val mins = Focus.normalizeMinutes(defaultMinutes.toDouble())
            ?: throw RefereeException("Érvénytelen hossz.", "BAD_MINUTES")
        val pack = Focus.FocusPack(
            id = "pack_" + java.util.UUID.randomUUID().toString().replace("-", "").take(12),
            name = cleanName, allowSites = sites.toList(), allowApps = emptyList(), defaultMinutes = mins,
        )
        BreakerStore.mutate { state ->
            if (state.focusPacks.size >= FocusSync.MAX_PACKS) {
                throw RefereeException("Legfeljebb ${FocusSync.MAX_PACKS} csomag fér el.", "TOO_MANY_PACKS")
            }
            state.copy(focusPacks = state.focusPacks + pack)
        }
        return pack
    }

    /**
     * ABLAK A CSÚCS-ÓRÁRA a telefonról: heti ablak egy ablak NÉLKÜLI csomagra.
     *
     * Felvenni ingyen (szigorítás: több idő, amikor a fehérlista él). A telefon
     * CSAK felvesz: cserélni, szűkíteni, levenni a gépen lehet, próbatétellel —
     * a lazítás kérdése ott dől el (`isRecurrenceLoosening`). A futó csomag itt
     * is befagy, mint a gépen. A csomag jelét a következő léptetés írja
     * (SyncRevisions.bumpFocus), hogy a fésülésben ez a változat nyerjen. A
     * gépi `setFocusRecurrence` felvevő ága; a Swift `addFocusWindow` tükre.
     */
    fun addFocusWindow(packId: String, band: ScheduleLogic.Band, now: Long) {
        BreakerStore.mutate { state ->
            val pack = state.focusPacks.find { it.id == packId }
                ?: throw RefereeException("Ismeretlen csomag.", "NO_PACK")
            if (Focus.isRunning(state.focusRun, now) && state.focusRun?.packId == packId) {
                throw RefereeException("Ez a csomag épp fut — amíg tart, az ablaka sem szerkeszthető.", "FOCUS_RUNNING")
            }
            if (pack.recurrence != null) {
                throw RefereeException("Ennek a csomagnak már van heti ablaka — a gépen szerkeszthető.", "HAS_WINDOW")
            }
            val next = Focus.cleanRecurrence(band)
                ?: throw RefereeException("Érvénytelen ablak: legalább egy nap kell, és legfeljebb nyolc óra.", "BAD_RECURRENCE")
            state.copy(focusPacks = state.focusPacks.map { if (it.id == packId) it.copy(recurrence = next) else it })
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
            val plan = planLoosening(dropped, Kind.PAUSE, null, now)
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
