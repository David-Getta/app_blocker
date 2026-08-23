package hu.lakat.app.core

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

    private fun localParts(now: Long): Parts {
        val c = Calendar.getInstance().apply { timeInMillis = now }
        // Calendar.DAY_OF_WEEK is 1=Sunday..7=Saturday; normalize to 0..6.
        return Parts(c.get(Calendar.DAY_OF_WEEK) - 1, c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE))
    }

    private fun prevDay(day: Int): Int = (day + 6) % 7

    fun inAnyBand(bands: List<Band>, now: Long): Boolean {
        val (day, minute) = localParts(now)
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

    fun isBlockedBySchedule(schedule: Schedule, now: Long): Boolean {
        val s = normalize(schedule)
        return when (s.mode) {
            Mode.ALWAYS -> true
            Mode.SCHEDULED_BLOCK -> inAnyBand(s.bands, now)
            Mode.SCHEDULED_ALLOW -> !inAnyBand(s.bands, now)
        }
    }

    /** Combines pause (always wins), pending delete, and the schedule. */
    fun isBlockedNow(pauseUntil: Long?, pendingDeleteAt: Long?, schedule: Schedule?, now: Long): Boolean {
        if (pauseUntil != null && pauseUntil > now) return false
        if (pendingDeleteAt != null) return true
        return isBlockedBySchedule(schedule ?: ALWAYS, now)
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
