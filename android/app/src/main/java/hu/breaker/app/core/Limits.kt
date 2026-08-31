package hu.breaker.app.core

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

    /**
     * Elfogyott-e a mai keret? Keret nélkül sosem.
     *
     * A `shared` a többi eszköz mai összegzése. Ha nincs (nincs szinkron, vagy
     * még nem jött le), a helyi mérés dönt — vagyis pontosan úgy viselkedik,
     * mint a közös keret előtt. A távoli másodpercek csak hozzáadnak, tehát
     * ettől a keret sosem lesz bővebb.
     */
    fun isLimitExhausted(
        domain: String, dailyLimitSeconds: Long?, usage: UsageLogic.UsageState, now: Long,
        shared: SharedToday? = null,
    ): Boolean {
        val limit = normalizeLimit(dailyLimitSeconds) ?: return false
        return usedTodayEverywhere(usage, shared, domain, now) >= limit
    }

    /**
     * A teljes blokkolási döntés: szünet, folyamatban lévő törlés, heti
     * menetrend ÉS a napi keret.
     *
     * A sorrend számít. Az aktív szünet mindent visz — azt próbatételekkel
     * fizette ki a felhasználó, és értelmetlen lenne, ha egy keret csendben
     * felülírná. Minden más tilt.
     */
    fun isBlockedNowWithLimit(
        site: Site, usage: UsageLogic.UsageState, now: Long, shared: SharedToday? = null,
        burst: BurstLogic.State? = null,
    ): Boolean {
        if (site.pauseUntil != null && site.pauseUntil > now) return false
        if (ScheduleLogic.isBlockedNow(site.pauseUntil, site.pendingDeleteAt, site.schedule, now)) return true
        // Az adag-hűtés is tilt — a sorrend ugyanaz, mint a TS ikren: a
        // megvásárolt szünet legyőzi, minden más alatta van.
        if (BurstLogic.isCoolingDown(burst, now)) return true
        return isLimitExhausted(site.domain, site.dailyLimitSeconds, usage, now, shared)
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

    // -----------------------------------------------------------------------
    // A napi keret eszközök között közös
    // -----------------------------------------------------------------------
    //
    // A keret eddig eszközönként külön ketyegett: „napi 20 perc YouTube” a
    // telefonon húsz percet jelentett, a gépen még húszat. Aki a keretet
    // komolyan gondolja, annak ez nem keret, hanem javaslat.
    //
    // MIÉRT BIZTONSÁGOS. A távoli számok csak HOZZÁADNAK. Bármit is küld a
    // másik eszköz, attól a keret csak hamarabb fogy el, sosem később — a
    // szigorítás pedig mindig ingyen van. Ha a szinkron áll, marad a helyi
    // mérés: az app olyan, mint eddig, nem lazább.

    /** Amit egy eszköz ma mért. Csak a mai nap, csak a számok — pár száz bájt. */
    data class TodayDigest(
        val deviceId: String,
        /** az ADOTT eszköz helyi naptári napja, YYYY-MM-DD */
        val day: String,
        /** cél kulcsa ("site:…" / "app:…") -> másodperc */
        val seconds: Map<String, Double>,
    )

    /** A többi eszköz mai összegzése, és hogy közülük melyik vagyunk mi. */
    data class SharedToday(
        /** a saját eszközazonosítónk — az ő sorát KI KELL hagyni */
        val selfDeviceId: String,
        val devices: List<TodayDigest>,
    )

    /** Ennél több célt egy összegzésbe nem teszünk (és nem is fogadunk el). */
    const val MAX_DIGEST_TARGETS = 200

    /** A saját mai összegzésünk, feltöltésre kész. */
    fun makeTodayDigest(usage: UsageLogic.UsageState, deviceId: String, now: Long): TodayDigest {
        val day = UsageLogic.dayKey(now)
        val bucket = usage.days.firstOrNull { it.day == day }
        val seconds = LinkedHashMap<String, Double>()
        if (bucket != null) {
            // A legnagyobbak maradnak: a keret szempontjából a hosszú tételek
            // számítanak, a néhány másodperces szemét nem.
            bucket.seconds.entries
                .filter { it.value.isFinite() && it.value > 0 }
                .sortedByDescending { it.value }
                .take(MAX_DIGEST_TARGETS)
                .forEach { seconds[it.key] = Math.round(it.value).toDouble() }
        }
        return TodayDigest(deviceId, day, seconds)
    }

    /**
     * Amit a kiszolgálóról kaptunk -> használható összegzés, vagy null.
     *
     * A `deviceId` KÍVÜLRŐL jön (a kiszolgáló mondja meg, kié a sor), nem a
     * blob belsejéből: különben egy eszköz a másik nevében beszélhetne, és a
     * saját sorunkat is kihagyhatatlanná tehetné.
     */
    fun normalizeTodayDigest(
        day: String?, seconds: Map<String, Double>?, deviceId: String,
    ): TodayDigest? {
        if (day == null || !Regex("""^\d{4}-\d{2}-\d{2}$""").matches(day)) return null
        val out = LinkedHashMap<String, Double>()
        for ((k, v) in seconds.orEmpty()) {
            if (out.size >= MAX_DIGEST_TARGETS) break
            if (k.isEmpty() || !v.isFinite() || v <= 0) continue
            // Egy nap egy célra legfeljebb egy nap lehet. Ennél nagyobb szám nem
            // mérésből származik, és az egész keretet azonnal elégetné.
            out[k] = minOf(Math.round(v).toDouble(), 24.0 * 3600.0)
        }
        return TodayDigest(deviceId, day, out)
    }

    /**
     * A TÖBBI eszköz mai másodpercei egy oldalra.
     *
     * Két dolog marad ki, és mindkettő hibából származna:
     *   - a saját sorunk (a szinkron a mi összegzésünket is visszaadja) —
     *     enélkül minden percünk kétszer számítana, és a keret feleakkora lenne;
     *   - a nem mai nap — a másik eszköz más időzónában más napot ír, és a
     *     tegnapi perceit ma nem szabad felszámolni.
     */
    fun sharedTodaySeconds(shared: SharedToday?, domain: String, now: Long): Double {
        if (shared == null) return 0.0
        val today = UsageLogic.dayKey(now)
        val key = UsageLogic.siteKey(domain)
        var total = 0.0
        for (d in shared.devices) {
            if (d.deviceId == shared.selfDeviceId || d.day != today) continue
            val s = d.seconds[key] ?: continue
            if (s.isFinite() && s > 0) total += s
        }
        return total
    }

    /** Ma elhasznált idő MINDEN eszközön együtt. */
    fun usedTodayEverywhere(
        usage: UsageLogic.UsageState, shared: SharedToday?, domain: String, now: Long,
    ): Double = usedTodaySeconds(usage, domain, now) + sharedTodaySeconds(shared, domain, now)
}
