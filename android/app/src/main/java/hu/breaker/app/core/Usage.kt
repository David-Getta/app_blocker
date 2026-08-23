package hu.breaker.app.core

import java.util.Calendar

/**
 * Active-time usage aggregation — mirror of desktop/src/shared/usage.ts.
 * See docs/feature-usage-stats.md.
 *
 * "Active time" = the user was actually in the target (app in the foreground,
 * screen on, not idle) — not how long it was open.
 */
object UsageLogic {

    enum class TargetKind { APP, SITE }

    data class UsageDay(val day: String, val seconds: MutableMap<String, Double>)

    data class UsageState(
        val days: MutableList<UsageDay> = mutableListOf(),
        val labels: MutableMap<String, String> = mutableMapOf(),
        var enabled: Boolean = true,
    )

    const val RETENTION_DAYS = 90
    const val SAMPLE_INTERVAL_MS = 5_000L
    const val IDLE_THRESHOLD_MS = 60_000L
    /** Defensive cap per record: more than a day for one target in one day is impossible. */
    const val MAX_RECORD_SECONDS = 24.0 * 3600
    /**
     * Distinct targets kept per day. Without a cap, anything that can invent
     * target names — a page fetching random subdomains — grows the stored state
     * without bound. Beyond this the smallest entries fold into a catch-all so
     * the totals stay honest instead of disappearing.
     */
    const val MAX_TARGETS_PER_DAY = 200
    const val OTHER_SITE_KEY = "site:(egyéb)"
    const val OTHER_APP_KEY = "app:(egyéb)"
    /** Length limit for anything stored as a label. */
    const val MAX_LABEL_LENGTH = 96

    /**
     * A detached copy of the whole history. [recordSample] mutates in place (to
     * mirror the TypeScript core), so without this every state write would hand
     * StateFlow a value that compares EQUAL to the one it already holds — the
     * per-day maps would be shared and mutated in lockstep — and the UI would
     * never see new measurements. The day buckets must therefore be copied too,
     * not just the outer list. (Bounded work: at most RETENTION_DAYS small maps.)
     */
    fun snapshot(u: UsageState): UsageState = UsageState(
        u.days.map { UsageDay(it.day, it.seconds.toMutableMap()) }.toMutableList(),
        u.labels.toMutableMap(),
        u.enabled,
    )

    fun siteKey(domain: String) = "site:$domain"
    fun appKey(id: String) = "app:$id"
    fun kindOf(key: String) = if (key.startsWith("site:")) TargetKind.SITE else TargetKind.APP
    fun idOf(key: String) = key.substring(key.indexOf(':') + 1)

    // ------------------------------------------------------------------ days

    fun dayKey(now: Long): String {
        val c = Calendar.getInstance().apply { timeInMillis = now }
        // Locale.ROOT: locales with native digit shapes (e.g. Arabic-Indic) would
        // produce keys whose lexicographic order is no longer chronological, and
        // retention plus every aggregation depends on that ordering.
        return String.format(
            java.util.Locale.ROOT, "%04d-%02d-%02d",
            c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))
    }

    /** Last [count] local day keys ending with today, oldest first (noon-stepped, DST-safe). */
    fun dayKeysBack(now: Long, count: Int): List<String> {
        val base = Calendar.getInstance().apply {
            timeInMillis = now
            set(Calendar.HOUR_OF_DAY, 12); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }
        val out = ArrayList<String>(count)
        for (i in count - 1 downTo 0) {
            val c = base.clone() as Calendar
            c.add(Calendar.DAY_OF_MONTH, -i)
            out.add(dayKey(c.timeInMillis))
        }
        return out
    }

    // ------------------------------------------------------------- recording

    fun recordSample(state: UsageState, key: String, seconds: Double, now: Long, label: String? = null) {
        if (!state.enabled) return
        if (!seconds.isFinite() || seconds <= 0) return
        val amount = minOf(seconds, MAX_RECORD_SECONDS)

        val today = dayKey(now)
        var bucket = state.days.find { it.day == today }
        if (bucket == null) {
            bucket = UsageDay(today, mutableMapOf())
            state.days.add(bucket)
            state.days.sortBy { it.day }
        }
        bucket.seconds[key] = (bucket.seconds[key] ?: 0.0) + amount
        if (label != null) state.labels[key] = label.take(MAX_LABEL_LENGTH)
        coalesceDay(bucket)
        pruneOld(state, now)
    }

    /**
     * Folds the smallest targets of an over-full day into a per-kind catch-all.
     * The day's total is preserved exactly — only the breakdown loses its tail.
     */
    fun coalesceDay(bucket: UsageDay) {
        if (bucket.seconds.size <= MAX_TARGETS_PER_DAY) return
        val catchAll = setOf(OTHER_SITE_KEY, OTHER_APP_KEY)
        val ranked = bucket.seconds.entries
            .filter { it.key !in catchAll }
            .sortedByDescending { it.value }
            .map { it.key }
        val keep = ranked.take(maxOf(0, MAX_TARGETS_PER_DAY - catchAll.size)).toSet()
        for (k in ranked) {
            if (k in keep) continue
            val target = if (kindOf(k) == TargetKind.SITE) OTHER_SITE_KEY else OTHER_APP_KEY
            bucket.seconds[target] = (bucket.seconds[target] ?: 0.0) + (bucket.seconds[k] ?: 0.0)
            bucket.seconds.remove(k)
        }
    }

    /**
     * Keeps the newest [RETENTION_DAYS] buckets and drops unreferenced labels.
     * Retention is bounded by COUNT, never by comparing against the current
     * clock: a wrong system time must not be able to wipe real history in
     * either direction. Counting also bounds storage exactly.
     */
    fun pruneOld(state: UsageState, now: Long = 0L) {
        state.days.sortBy { it.day }
        if (state.days.size > RETENTION_DAYS) {
            val keep = state.days.takeLast(RETENTION_DAYS)
            state.days.clear()
            state.days.addAll(keep)
        }
        val used = state.days.flatMap { it.seconds.keys }.toSet()
        state.labels.keys.retainAll { it in used }
    }

    // ----------------------------------------------------------- aggregation

    fun totalsForDays(state: UsageState, days: List<String>): Map<String, Double> {
        val wanted = days.toSet()
        val out = mutableMapOf<String, Double>()
        for (d in state.days) {
            if (d.day !in wanted) continue
            for ((k, s) in d.seconds) out[k] = (out[k] ?: 0.0) + s
        }
        return out
    }

    data class TargetTotal(val key: String, val label: String, val kind: TargetKind, val seconds: Double)

    fun labelOf(state: UsageState, key: String): String = state.labels[key] ?: idOf(key)

    fun rank(
        state: UsageState, totals: Map<String, Double>,
        kind: TargetKind? = null, limit: Int? = null,
    ): List<TargetTotal> {
        var rows = totals.entries
            .filter { kind == null || kindOf(it.key) == kind }
            .map { TargetTotal(it.key, labelOf(state, it.key), kindOf(it.key), it.value) }
            .sortedByDescending { it.seconds }
        if (limit != null) rows = rows.take(limit)
        return rows
    }

    fun sumOf(totals: Map<String, Double>): Double = totals.values.sum()

    fun series(state: UsageState, key: String, now: Long, count: Int): List<Pair<String, Double>> {
        val byDay = state.days.associate { it.day to it.seconds }
        return dayKeysBack(now, count).map { day -> day to (byDay[day]?.get(key) ?: 0.0) }
    }

    data class WeekDelta(
        val key: String, val label: String, val kind: TargetKind,
        val thisWeek: Double, val lastWeek: Double, val deltaPct: Double?,
    )

    fun weekOverWeek(state: UsageState, now: Long, limit: Int = 5): List<WeekDelta> {
        val last14 = dayKeysBack(now, 14)
        val prevTotals = totalsForDays(state, last14.subList(0, 7))
        val curTotals = totalsForDays(state, last14.subList(7, 14))
        val keys = curTotals.keys + prevTotals.keys
        return keys.map { key ->
            val thisWeek = curTotals[key] ?: 0.0
            val lastWeek = prevTotals[key] ?: 0.0
            WeekDelta(
                key, labelOf(state, key), kindOf(key), thisWeek, lastWeek,
                if (lastWeek > 0) ((thisWeek - lastWeek) / lastWeek) * 100 else null,
            )
        }.sortedByDescending { it.thisWeek }.take(limit)
    }

    data class Summary(
        val enabled: Boolean,
        val todaySeconds: Double,
        val yesterdaySeconds: Double,
        val last7Seconds: Double,
        val last30Seconds: Double,
        val topWeekSites: List<TargetTotal>,
        val topWeekApps: List<TargetTotal>,
        val weekOverWeek: List<WeekDelta>,
        val daysTracked: Int,
    )

    fun summarize(state: UsageState, now: Long, topLimit: Int = 8): Summary {
        val today = dayKey(now)
        val yesterday = dayKeysBack(now, 2).first()
        val todayTotals = totalsForDays(state, listOf(today))
        val weekTotals = totalsForDays(state, dayKeysBack(now, 7))
        return Summary(
            enabled = state.enabled,
            todaySeconds = sumOf(todayTotals),
            yesterdaySeconds = sumOf(totalsForDays(state, listOf(yesterday))),
            last7Seconds = sumOf(weekTotals),
            last30Seconds = sumOf(totalsForDays(state, dayKeysBack(now, 30))),
            topWeekSites = rank(state, weekTotals, TargetKind.SITE, topLimit),
            topWeekApps = rank(state, weekTotals, TargetKind.APP, topLimit),
            weekOverWeek = weekOverWeek(state, now),
            daysTracked = state.days.size,
        )
    }

    // ------------------------------------------------------------- sampling

    data class Foreground(val appId: String, val appName: String, val domain: String? = null)
    data class SampleDecision(val key: String, val label: String, val seconds: Double)

    /**
     * Decides what one tick records. Pure, so idle/sleep/missing-foreground
     * handling is testable without Android APIs.
     */
    fun decideSample(
        lastAt: Long, now: Long, idleMs: Long, fg: Foreground?,
        intervalMs: Long = SAMPLE_INTERVAL_MS, idleThresholdMs: Long = IDLE_THRESHOLD_MS,
    ): SampleDecision? {
        if (idleMs >= idleThresholdMs) return null
        if (fg == null) return null
        val rawElapsed = now - lastAt
        if (rawElapsed <= 0) return null
        val seconds = minOf(rawElapsed, intervalMs * 2).toDouble() / 1000.0
        return if (fg.domain != null) {
            SampleDecision(siteKey(fg.domain), fg.domain, seconds)
        } else {
            SampleDecision(appKey(fg.appId), fg.appName, seconds)
        }
    }

    // ------------------------------------------------------------ formatting

    /** Hungarian human-readable duration: "2 ó 15 p", "45 p", "30 mp". */
    fun formatDuration(seconds: Double): String {
        val s = maxOf(0.0, seconds).toLong()
        if (s < 60) return "$s mp"
        val min = Math.round(s / 60.0)
        if (min < 60) return "$min p"
        val h = min / 60
        val rem = min % 60
        return if (rem == 0L) "$h ó" else "$h ó $rem p"
    }
}
