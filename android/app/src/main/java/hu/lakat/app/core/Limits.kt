package hu.lakat.app.core

/**
 * Napi aktív-idő keret oldalanként — a desktop/src/shared/limits.ts tükre.
 *
 * A blokkolás eddig bináris volt (tiltva / nem tiltva) plusz a heti menetrend.
 * A mérő viszont már tudja, mennyi aktív idő ment ma egy oldalra, így a kettő
 * összeköthető: „nem tiltom ki teljesen, de napi 20 percnél többet ne”. Ha a
 * mai keret elfogyott, az oldal a nap hátralévő részére magától visszazár,
 * éjfélkor pedig újraindul.
 *
 * Lásd docs/feature-daily-limit.md.
 */
object LimitLogic {

    /** Ma ennyi aktív másodperc ment erre az oldalra (0, ha semmi). */
    fun usedTodaySeconds(usage: UsageLogic.UsageState, domain: String, now: Long): Double {
        val today = UsageLogic.dayKey(now)
        val bucket = usage.days.firstOrNull { it.day == today } ?: return 0.0
        val seconds = bucket.seconds[UsageLogic.siteKey(domain)] ?: return 0.0
        return if (seconds.isFinite() && seconds > 0) seconds else 0.0
    }

    /** Elfogyott-e a mai keret? Keret nélkül sosem. */
    fun isLimitExhausted(
        domain: String, dailyLimitSeconds: Long?, usage: UsageLogic.UsageState, now: Long,
    ): Boolean {
        val limit = normalizeLimit(dailyLimitSeconds) ?: return false
        return usedTodaySeconds(usage, domain, now) >= limit
    }

    /**
     * A teljes blokkolási döntés: szünet, folyamatban lévő törlés, heti
     * menetrend ÉS a napi keret.
     *
     * A sorrend számít. Az aktív szünet mindent visz — azt próbatételekkel
     * fizette ki a felhasználó, és értelmetlen lenne, ha egy keret csendben
     * felülírná. Minden más tilt.
     */
    fun isBlockedNowWithLimit(site: Site, usage: UsageLogic.UsageState, now: Long): Boolean {
        if (site.pauseUntil != null && site.pauseUntil > now) return false
        if (ScheduleLogic.isBlockedNow(site.pauseUntil, site.pendingDeleteAt, site.schedule, now)) return true
        return isLimitExhausted(site.domain, site.dailyLimitSeconds, usage, now)
    }

    /**
     * Lazítás-e a keret változtatása (vagyis próbatételbe kerül-e)?
     *
     * Emelni vagy megszüntetni több időt vesz az oldalon, tehát ugyanolyan
     * súrlódás jár érte, mint egy feloldásért. Csökkenteni vagy bevezetni
     * szigorítás, az azonnal érvényes — a segítő irány mindig ingyenes.
     */
    fun isLimitLoosening(current: Long?, next: Long?): Boolean {
        val cur = normalizeLimit(current)
        val nxt = normalizeLimit(next)
        if (cur == null) return false   // eddig nem volt keret: bármilyen keret szigorúbb
        if (nxt == null) return true    // a keret megszüntetése az egész napot felszabadítja
        return nxt > cur
    }

    /** Használható keret, vagy null („nincs keret”). Az értelmetlen érték nincs keret. */
    fun normalizeLimit(value: Long?): Long? {
        if (value == null || value <= 0) return null
        return minOf(value, 24L * 3600L)   // egy napnál nagyobb keret = nincs keret
    }
}
