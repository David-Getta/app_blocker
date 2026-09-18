package hu.breaker.app.core

/**
 * MEGAKADÁSOK A SZŰRŐBEN: hányszor állította meg a DNS-szűrő a telefont.
 *
 * MIÉRT VAN. A tiltás akkor dolgozik, amikor az ember nem figyel oda — pont
 * ezért nem látszik, mennyit dolgozik. A gépen a böngésző-bővítmény számolja
 * a tiltó lapra vitt navigációkat; a telefonon tiltó lap nincs (a DNS a
 * hosztnévnél tovább nem lát), de a tiltott lekérdezés ugyanaz a pillanat:
 * a kéz odanyúlt, a szűrő megállította. Tükör, nem ítélet.
 *
 * MIT SZÁMOL. Egy hosztnevet két percen belül EGYSZER: egy oldalbetöltés
 * tucatnyi lekérdezést küld, és a böngésző újra is próbálja — az egy
 * megakadás, nem tíz. A könyv naponként egy szám, harminc napig; a gépen
 * marad, a fiókba nem megy — mint a heti napló.
 *
 * Tiszta logika: a szolgáltatás könyvel vele, a statisztika és a heti mondat
 * kérdezi. A Swift-tükör a `Shared/FilterHits.swift`.
 */
object FilterHitLogic {
    /** Ennyi napot tartunk meg — mint a mérés és a böngésző könyve. */
    const val RETENTION_DAYS = 30
    /** Egy hosztnév ennyin belül egy megakadás. */
    const val DEDUPE_MS = 120_000L
    /** Naponta legfeljebb ennyi — fölötte nem mérés, hanem hiba. */
    const val MAX_PER_DAY = 10_000
    /** A szolgáltatás memóriája (hoszt → utolsó idő) ennél nem nő nagyobbra. */
    private const val MAX_SEEN = 500

    private val DAY_KEY = Regex("""^\d{4}-\d{2}-\d{2}$""")

    /**
     * Számít-e ez a tiltott lekérdezés új megakadásnak. A `lastSeen` a hívó
     * memóriája (hoszt → utolsó számolt idő), itt frissül; nem tárolódik — egy
     * újraindítás legfeljebb egy duplát enged át, az nem hazugság.
     */
    fun shouldCount(lastSeen: MutableMap<String, Long>, host: String, now: Long): Boolean {
        val h = host.trim().lowercase().trimEnd('.')
        if (h.isEmpty()) return false
        val last = lastSeen[h]
        if (last != null && now >= last && now - last < DEDUPE_MS) return false
        if (lastSeen.size >= MAX_SEEN) {
            val stale = lastSeen.entries.filter { now - it.value >= DEDUPE_MS || it.value > now }.map { it.key }
            stale.forEach { lastSeen.remove(it) }
            if (lastSeen.size >= MAX_SEEN) lastSeen.clear()
        }
        lastSeen[h] = now
        return true
    }

    /**
     * A könyv egy megakadással több a napon. Rossz nap vagy a napi plafon:
     * változatlan. Nem takarít — az a hívóé, a MAI nappal (`sweep`): a felvett
     * nap nem a mai nap, és egy régebbi nappal takarítva a mai sor esne ki.
     */
    fun record(days: Map<String, Int>, day: String): Map<String, Int> {
        if (!DAY_KEY.matches(day)) return days
        val n = days[day] ?: 0
        if (n >= MAX_PER_DAY) return days
        return days + (day to n + 1)
    }

    /** A megtartási időn túli és a jövőbeli napok kiesnek (a jövő nem mérés, hanem elállított óra). */
    fun sweep(days: Map<String, Int>, today: String): Map<String, Int> {
        val keep = days.keys.filter { DAY_KEY.matches(it) && it <= today }.sorted().takeLast(RETENTION_DAYS).toSet()
        return days.filterKeys { it in keep }
    }

    /** A tárból jött könyv tisztán: jó nap, pozitív szám a plafonig, a legfrissebb harminc. */
    fun clean(raw: Map<String, Int>?): Map<String, Int> {
        val good = (raw ?: emptyMap())
            .filter { (k, v) -> DAY_KEY.matches(k) && v > 0 }
            .mapValues { minOf(it.value, MAX_PER_DAY) }
        val keep = good.keys.sorted().takeLast(RETENTION_DAYS).toSet()
        return good.filterKeys { it in keep }
    }

    /** Megakadások a két nap között, mindkettőt beleértve. */
    fun hitsBetween(days: Map<String, Int>, fromDay: String, toDay: String): Int =
        days.entries.filter { it.key >= fromDay && it.key <= toDay }.sumOf { it.value }

    /** Az elmúlt 7 nap (a mai nappal) — a statisztika és a visszatekintés ablaka. */
    fun hits7d(days: Map<String, Int>, now: Long): Int =
        hitsBetween(days, UsageLogic.dayKey(now - 6 * 86_400_000L), UsageLogic.dayKey(now))

    /** A mai nap. */
    fun hitsToday(days: Map<String, Int>, now: Long): Int {
        val d = UsageLogic.dayKey(now)
        return hitsBetween(days, d, d)
    }

    /** Az utolsó `count` nap sora, a legrégebbi elöl — a hét alakja a megakadásokra (darab, Double-ben a rajz kedvéért). */
    fun daySeries(days: Map<String, Int>, now: Long, count: Int): List<Pair<String, Double>> =
        UsageLogic.dayKeysBack(now, count).map { it to hitsBetween(days, it, it).toDouble() }

    // ------------------------------------------------------------ óránként

    /** A nap órája helyi idő szerint, 0–23. */
    fun hourOf(now: Long): Int = java.util.Calendar.getInstance().apply { timeInMillis = now }.get(java.util.Calendar.HOUR_OF_DAY)

    /**
     * Az órák könyve egy megakadással több: { nap → 24 rekesz }. MIKOR jár a kéz
     * magától — a napi könyv mellett, ugyanazzal a takarítással. Rossz óra: változatlan.
     */
    fun recordHour(hours: Map<String, List<Int>>, day: String, hour: Int): Map<String, List<Int>> {
        if (!DAY_KEY.matches(day) || hour !in 0..23) return hours
        val row = (hours[day]?.takeIf { it.size == 24 } ?: List(24) { 0 }).toMutableList()
        if (row[hour] >= MAX_PER_DAY) return hours
        row[hour] = row[hour] + 1
        return hours + (day to row.toList())
    }

    /** Az órák könyve tisztán: jó nap, 24 rekesz, nem negatív, a plafonig, a legfrissebb harminc nap. */
    fun cleanHours(raw: Map<String, List<Int>>?): Map<String, List<Int>> {
        val good = (raw ?: emptyMap())
            .filter { (k, v) -> DAY_KEY.matches(k) && v.size == 24 && v.any { it > 0 } }
            .mapValues { (_, v) -> v.map { it.coerceIn(0, MAX_PER_DAY) } }
        val keep = good.keys.sorted().takeLast(RETENTION_DAYS).toSet()
        return good.filterKeys { it in keep }
    }

    /** A csúcs-óra az elmúlt 7 napon: (óra, szám) — vagy null. Holtversenynél a korábbi óra. */
    fun peakHour(hours: Map<String, List<Int>>, now: Long): Pair<Int, Int>? {
        val days = UsageLogic.dayKeysBack(now, 7).toSet()
        val by = IntArray(24)
        for ((day, row) in hours) if (day in days && row.size == 24) for (i in 0 until 24) by[i] += maxOf(0, row[i])
        var best = -1
        for (i in 0 until 24) if (by[i] > 0 && (best < 0 || by[i] > by[best])) best = i
        return if (best < 0) null else best to by[best]
    }

    /** „21–22 óra” — a csúcs-óra felirata. */
    fun hourLabel(hour: Int): String = "$hour–${(hour + 1) % 24} óra"
}
