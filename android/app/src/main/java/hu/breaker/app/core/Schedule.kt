package hu.breaker.app.core

import java.util.Calendar

/**
 * Weekly blocking schedules — mirror of desktop/src/shared/schedule.ts.
 * See docs/feature-schedules.md.
 *
 * Invariant: tightening (more blocked time) is free; loosening (less blocked
 * time) must go through the same unlock challenges as a pause.
 */
object ScheduleLogic {

    enum class Mode { ALWAYS, SCHEDULED_BLOCK, SCHEDULED_ALLOW }

    /** days: 0=Sunday..6=Saturday (same convention as the TS/Swift mirror).
     *  startMin/endMin: local minutes from midnight. */
    data class Band(val days: Set<Int>, val startMin: Int, val endMin: Int)

    data class Schedule(val mode: Mode, val bands: List<Band>)

    val ALWAYS = Schedule(Mode.ALWAYS, emptyList())

    fun isValidBand(b: Band): Boolean {
        if (b.days.isEmpty() || b.days.any { it < 0 || it > 6 }) return false
        if (b.startMin < 0 || b.startMin > 1439) return false
        if (b.endMin < 1 || b.endMin > 1440) return false
        return true
    }

    fun normalize(s: Schedule?): Schedule {
        if (s == null || s.mode == Mode.ALWAYS) return ALWAYS
        val bands = s.bands.filter { isValidBand(it) }
        return if (bands.isEmpty()) ALWAYS else s.copy(bands = bands)
    }

    private data class Parts(val day: Int, val minute: Int)

    private fun localParts(now: Long): Parts = partsOf(java.util.GregorianCalendar(), now)

    /** A helyi nap és perc egy (újrahasznosítható) naptárral — a keresés egyet használ végig. */
    private fun partsOf(c: java.util.GregorianCalendar, now: Long): Parts {
        c.timeInMillis = now
        // Calendar.DAY_OF_WEEK is 1=Sunday..7=Saturday; normalize to 0..6.
        return Parts(c.get(Calendar.DAY_OF_WEEK) - 1, c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE))
    }

    private fun prevDay(day: Int): Int = (day + 6) % 7

    fun inAnyBand(bands: List<Band>, now: Long): Boolean = inAnyBandAt(bands, localParts(now))

    private fun inAnyBandAt(bands: List<Band>, p: Parts): Boolean {
        val (day, minute) = p
        val prev = prevDay(day)
        for (b in bands) {
            if (b.endMin > b.startMin) {
                if (day in b.days && minute >= b.startMin && minute < b.endMin) return true
            } else {
                if (day in b.days && minute >= b.startMin) return true
                if (prev in b.days && minute < b.endMin) return true
            }
        }
        return false
    }

    /** A döntés egy már tisztított menetrendre, a helyi nap és perc szerint. */
    private fun blockedAt(s: Schedule, p: Parts): Boolean = when (s.mode) {
        Mode.ALWAYS -> true
        Mode.SCHEDULED_BLOCK -> inAnyBandAt(s.bands, p)
        Mode.SCHEDULED_ALLOW -> !inAnyBandAt(s.bands, p)
    }

    fun isBlockedBySchedule(schedule: Schedule, now: Long): Boolean = blockedAt(normalize(schedule), localParts(now))

    /**
     * Az első perchatár `now` után, ahol a menetrend döntése `blocked` — vagy
     * 0, ha nyolc napon belül sincs ilyen. Ha már most annyi: `now`. A gép
     * `nextDecisionAt`-jének tükre: percre lépked, és MAGÁT a döntést kérdezi
     * (`blockedAt`), így óraátállásnál sem mondhat mást, mint amit a tiltás
     * tenni fog. Egy naptárral lépked végig — a telefon másodpercenként rajzol.
     */
    private fun nextDecisionAt(schedule: Schedule, now: Long, blocked: Boolean): Long {
        val s = normalize(schedule)
        val cal = java.util.GregorianCalendar()
        if (blockedAt(s, partsOf(cal, now)) == blocked) return now
        var t = now - Math.floorMod(now, 60_000L)
        repeat(8 * 24 * 60) {
            t += 60_000L
            if (blockedAt(s, partsOf(cal, t)) == blocked) return t
        }
        return 0L
    }

    /** A menetrend következő nyitása (epoch ms): most nyitva → `now`; a mindig tiltó sosem nyit → 0. */
    fun nextOpenAt(schedule: Schedule, now: Long): Long {
        if (normalize(schedule).mode == Mode.ALWAYS) return 0L
        return nextDecisionAt(schedule, now, false)
    }

    /** A menetrend következő zárása (epoch ms): most zár → `now`; egy héten belül sem zár → 0. */
    fun nextCloseAt(schedule: Schedule, now: Long): Long = nextDecisionAt(schedule, now, true)

    /** Combines pause (always wins), pending delete, and the schedule. */
    fun isBlockedNow(pauseUntil: Long?, pendingDeleteAt: Long?, schedule: Schedule?, now: Long): Boolean {
        if (pauseUntil != null && pauseUntil > now) return false
        if (pendingDeleteAt != null) return true
        return isBlockedBySchedule(schedule ?: ALWAYS, now)
    }

    /**
     * Beírt időpont → perc éjfél után, vagy null.
     *
     * A szerkesztők saját sávja szövegmezőből jön, és a telefonon a kettőspont
     * a szimbólumok mögött lapul — a számbillentyűzeten sokszor nincs is. Ezért
     * a „8:30” és a „08:30” mellett a „8.30” és a „8,30” (a számbillentyűzet
     * tizedesjele), az egész óra („8”), és a csupa számjegy („830”, „0830”) is
     * megy. Csak ASCII számjegy; a „24:00” az 1440 (a nap vége), ennél több nem.
     */
    fun parseClock(v: String): Int? {
        val t = v.trim()
        val sep = Regex("^([0-9]{1,2})[:.,]([0-9]{2})$").find(t)
        val (h, m) = when {
            sep != null -> sep.groupValues[1].toInt() to sep.groupValues[2].toInt()
            Regex("^[0-9]{1,2}$").matches(t) -> t.toInt() to 0
            Regex("^[0-9]{3,4}$").matches(t) -> t.dropLast(2).toInt() to t.takeLast(2).toInt()
            else -> return null
        }
        if (h > 24 || m > 59 || (h == 24 && m > 0)) return null
        return h * 60 + m
    }

    /**
     * A szerkesztők saját sávja (menetrend, heti ablak): napok és két beírt
     * időpont — vagy null, ha az időpont nem olvasható. A „00:00” végként az
     * éjfél: a sáv 1440-nel írja le, nem nullával. A „24:00” kezdésként nem nap
     * eleje, hanem érvénytelen — a mag eldobná, és a sáv csendben elveszne.
     */
    fun customBand(days: Set<Int>, start: String, end: String): Band? {
        val s = parseClock(start) ?: return null
        val e = parseClock(end) ?: return null
        if (s >= 1440) return null
        return Band(days, s, if (e == 0) 1440 else e)
    }

    /**
     * Would switching old -> new reduce blocked time in the next 7 days?
     *
     * Sampled every minute: bands are whole minutes, so a minute step cannot
     * step over any window this model can express. A coarser step let a short
     * recurring free window install with no friction, defeating the gate.
     */
    fun isLoosening(oldS: Schedule, newS: Schedule, now: Long): Boolean {
        val a = normalize(oldS)
        val b = normalize(newS)
        val step = 60_000L
        val samples = 7 * 24 * 60
        for (i in 0 until samples) {
            val t = now + i * step
            if (isBlockedBySchedule(a, t) && !isBlockedBySchedule(b, t)) return true
        }
        return false
    }
}
