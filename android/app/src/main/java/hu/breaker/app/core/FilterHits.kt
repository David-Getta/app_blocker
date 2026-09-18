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
 * megakadás, nem tíz. És csak a LISTA és a KULCSSZÓ tiltását: a munkamenet fehérlistáján
 * kívül rekedt háttér-forgalom (követők, CDN-ek, más appok) nem a kéz
 * mozdulata. A könyv naponként egy szám, harminc napig; a gépen marad, a
 * fiókba nem megy — mint a heti napló.
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

    // ------------------------------------------------------------ oldalanként

    /** Naponta legfeljebb ennyi oldal a könyvben — a lista úgysem hosszabb. */
    const val MAX_SITES_PER_DAY = 50

    /**
     * Melyik LISTÁS oldalhoz tartozik a tiltott név: a lista tétele (tartomány,
     * hosztnevek), amelynek a neve a név vagy annak szülője — különben a név
     * maga. A könyv az oldal nevével megy, nem a nyers hoszttal: a
     * `m.youtube.com` és a `www.youtube.com` egy oldal.
     */
    fun siteOf(name: String, sites: List<Pair<String, List<String>>>): String {
        val h = name.trim().lowercase().trimEnd('.')
        for ((domain, hostnames) in sites) {
            if ((listOf(domain) + hostnames).any { n -> h == n || h.endsWith(".$n") }) return domain
        }
        return h
    }

    /** Az oldalak könyve egy megakadással több: nap → (oldal → szám). Rossz nap, üres oldal vagy a plafon: változatlan. */
    fun recordSite(hosts: Map<String, Map<String, Int>>, day: String, site: String): Map<String, Map<String, Int>> {
        if (!DAY_KEY.matches(day) || site.isBlank()) return hosts
        val row = hosts[day] ?: emptyMap()
        val n = row[site] ?: 0
        if (n >= MAX_PER_DAY) return hosts
        if (site !in row && row.size >= MAX_SITES_PER_DAY) return hosts
        return hosts + (day to row + (site to n + 1))
    }

    /** Az oldalak könyve tisztán: jó nap, nem üres oldal, pozitív szám a plafonig, a legfrissebb harminc nap. */
    fun cleanSites(raw: Map<String, Map<String, Int>>?): Map<String, Map<String, Int>> {
        val good = (raw ?: emptyMap())
            .filter { (k, _) -> DAY_KEY.matches(k) }
            .mapValues { (_, row) ->
                row.filter { (s, n) -> s.isNotBlank() && n > 0 }.mapValues { minOf(it.value, MAX_PER_DAY) }
                    .toList().sortedBy { it.first }.take(MAX_SITES_PER_DAY).toMap()
            }
            .filter { it.value.isNotEmpty() }
        val keep = good.keys.sorted().takeLast(RETENTION_DAYS).toSet()
        return good.filterKeys { it in keep }
    }

    /** A hét csúcs-oldala: (oldal, szám) — vagy null. Holtversenynél az ábécé szerint korábbi. */
    fun topSite(hosts: Map<String, Map<String, Int>>, now: Long): Pair<String, Int>? {
        val days = UsageLogic.dayKeysBack(now, 7).toSet()
        val sum = HashMap<String, Int>()
        for ((day, row) in hosts) if (day in days) for ((s, n) in row) sum[s] = (sum[s] ?: 0) + maxOf(0, n)
        return sum.entries.filter { it.value > 0 }
            .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
            .firstOrNull()?.let { it.key to it.value }
    }

    // ------------------------------------------------------------ okonként

    /**
     * MELYIK szabály dolgozik: a megakadás oka a szűrő ítélete — a lista vagy a
     * kulcsszó. A munkamenet fehérlistáján kívül rekedt forgalom nem megakadás
     * (lásd fent), ezért oknak sem számít: null. A könyv alakja az oldalakéval
     * azonos (nap → ok → szám), ugyanaz a felvétel és takarítás — a gépi
     * okonkénti sor tükre.
     */
    const val REASON_LIST = "list"
    const val REASON_KEYWORD = "keyword"
    /** Az okok rögzített sorrendje és felirata — a sor holtversenynél sem ugrál. */
    val REASON_ORDER = listOf(REASON_LIST, REASON_KEYWORD)
    val REASON_LABELS = mapOf(REASON_LIST to "lista", REASON_KEYWORD to "kulcsszó")

    /** A megakadás oka a szűrő ítéletéből — vagy null, ha ez nem megakadás. */
    fun reasonOf(verdict: Focus.Verdict): String? = when (verdict) {
        Focus.Verdict.BLOCKED_BY_LIST -> REASON_LIST
        Focus.Verdict.BLOCKED_BY_KEYWORD -> REASON_KEYWORD
        else -> null
    }

    /** Az elmúlt 7 nap megakadásai okonként: (ok, szám), a legnagyobb elöl; holtversenynél a rögzített sorrend. Csak a nem nulla. */
    fun byReason(reasons: Map<String, Map<String, Int>>, now: Long): List<Pair<String, Int>> {
        val days = UsageLogic.dayKeysBack(now, 7).toSet()
        val sum = HashMap<String, Int>()
        for ((day, row) in reasons) if (day in days) for ((r, n) in row) sum[r] = (sum[r] ?: 0) + maxOf(0, n)
        fun rank(r: String): Int = REASON_ORDER.indexOf(r).let { if (it < 0) REASON_ORDER.size else it }
        return sum.entries.filter { it.value > 0 }
            .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { rank(it.key) }.thenBy { it.key })
            .map { it.key to it.value }
    }

    /** „30 lista · 12 kulcsszó” — üresen üres. A gépi sor tükre. */
    fun reasonLine(rows: List<Pair<String, Int>>): String =
        rows.joinToString(" · ") { (r, n) -> "$n ${REASON_LABELS[r] ?: r}" }

    // ------------------------------------------------------------ a sokadik

    /**
     * A SOKADIK megakadás lépcsői: ezeknél a mai számoknál egyszer szól a
     * telefon, hogy egy munkamenet vagy egy rövid zárlat most segítene. Nem
     * ítélet, és nem tilt semmit — egy lépést javasol, a döntés az emberé. A
     * gépével azonos lista (a core-sync ellenőrző tartja együtt).
     */
    val NUDGE_STEPS = listOf(5, 10, 20)

    /** A legmagasabb lépcső, amit a mai szám elért — 0, ha egyet sem. */
    fun nudgeStep(today: Int, steps: List<Int> = NUDGE_STEPS): Int = steps.filter { today >= it }.maxOrNull() ?: 0

    /** A javaslat mondata egy lépcsőnél. */
    fun nudgeText(step: Int): String =
        "Ma már $step megakadás a szűrőben. Egy munkamenet vagy egy rövid zárlat most segítene — te döntesz."

    // ------------------------------------------------------------ előjelzés

    /**
     * ELŐJELZÉS a csúcs-óra előtt: ennyivel a hét csúcs-órájának kezdete előtt
     * egyszer szól a telefon — naponta egyszer, és csak ha a csúcs legalább
     * ennyi. Tükör időzítéssel: ilyenkor jár a kéz magától. Nem tilt, nem ítél.
     */
    const val PEAK_WARN_LEAD_MS = 10 * 60_000L
    const val PEAK_WARN_MIN_COUNT = 3

    /**
     * A mai előjelzés kulcsa („nap:óra”), ha most esedékes — különben null. A
     * nulla órás csúcs ablaka az előző estén van: a kulcs a csúcs napjáé.
     */
    fun peakWarnKey(peak: Pair<Int, Int>?, now: Long): String? {
        if (peak == null || peak.second < PEAK_WARN_MIN_COUNT) return null
        for (offset in 0..1) {
            val c = java.util.Calendar.getInstance().apply {
                timeInMillis = now
                add(java.util.Calendar.DAY_OF_MONTH, offset)
                set(java.util.Calendar.HOUR_OF_DAY, peak.first)
                set(java.util.Calendar.MINUTE, 0)
                set(java.util.Calendar.SECOND, 0)
                set(java.util.Calendar.MILLISECOND, 0)
            }
            val start = c.timeInMillis
            if (now >= start - PEAK_WARN_LEAD_MS && now < start) return "${UsageLogic.dayKey(start)}:${peak.first}"
        }
        return null
    }

    /** Az előjelzés mondata. */
    fun peakWarnText(peak: Pair<Int, Int>): String =
        "Mindjárt ${peak.first} óra — a héten ilyenkor akadt meg a kéz a legtöbbször (${peak.second}×). Egy munkamenet most segítene — te döntesz."
}
