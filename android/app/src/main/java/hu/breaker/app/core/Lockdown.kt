package hu.breaker.app.core

/**
 * Zárlat — a desktop/src/shared/lockdown.ts tükre.
 *
 * Az az időszak, amikor a lazítás nem drága, hanem NEM LÉTEZIK: a bíró el sem
 * indít próbatételt rá. Eddig minden lazításnak volt ára, tehát útja is; ez az
 * egyetlen művelet az egész appban, aminek nincs visszaútja.
 *
 * Indítani ingyen van, hosszabbítani ingyen van. Rövidíteni, visszavonni,
 * kivételt tenni sehogy sem lehet — se gombbal, se próbatétellel.
 *
 * Nem lakatolja le a telefont, és nem is állítjuk, hogy megtenné: az app
 * letörölhető. Az appon BELÜL zár le mindent, vagyis az impulzus ellen véd.
 *
 * Ha itt változtatsz, a TS és a Swift ikren is.
 */
object LockdownLogic {

    /** Egy zárlat legfeljebb ennyi lehet. Ami ennél hosszabb, az már nem döntés. */
    const val MAX_LOCKDOWN_DAYS = 30
    const val MAX_LOCKDOWN_MS = MAX_LOCKDOWN_DAYS * 24 * 3600_000L

    /** A felület gyorsgombjai, percben. A leghosszabb szándékosan egy hét. */
    val LOCKDOWN_CHOICES_MIN = listOf(60, 180, 8 * 60, 24 * 60, 3 * 24 * 60, 7 * 24 * 60)

    /**
     * A futó zárlat. A [startedAt] nem dísz: ebből látszik, mennyi telt el és
     * mennyi van hátra — egy puszta határidő mellett a hosszú zárlat első
     * napja ugyanúgy néz ki, mint az utolsó.
     */
    data class Lockdown(val startedAt: Long, val until: Long)

    /** Tart-e most zárlat. */
    fun isLocked(l: Lockdown?, now: Long): Boolean = l != null && l.until > now

    /**
     * Csak az ÉLŐ zárlat — a lejárt nincs. A szinkron határán kell: ha a
     * helyi oldal nem viszi fel a lejártat, a lejövőt viszont átvenné, a kettő
     * minden körben különbözne, és a telefon örökké „változást” látna.
     */
    fun live(l: Lockdown?, now: Long): Lockdown? = if (isLocked(l, now)) l else null

    /** Mennyi van még hátra, ms-ben. Nulla, ha nincs zárlat. */
    fun remainingMs(l: Lockdown?, now: Long): Long = if (isLocked(l, now)) l!!.until - now else 0L

    /**
     * Zárlat indítása vagy hosszabbítása [ms] időre MOSTTÓL.
     *
     * Az eredmény SOSEM rövidebb a mostaninál: ez az egyetlen út a mezőhöz, és
     * így a rövidítés nem elfelejtett ellenőrzés kérdése, hanem
     * megfogalmazhatatlan.
     */
    fun start(cur: Lockdown?, ms: Long, now: Long): Lockdown? {
        if (ms <= 0) return cur
        val want = now + minOf(ms, MAX_LOCKDOWN_MS)
        if (isLocked(cur, now)) {
            return if (want > cur!!.until) Lockdown(cur.startedAt, want) else cur
        }
        return Lockdown(now, want)
    }

    /**
     * Két eszköz zárlata EGGYÉ fésülve: a KÉSŐBBI vég nyer.
     *
     * Nem versenyhelyzet-feloldás, hanem maga a szabály: a zárlat szigorítás,
     * tehát a szinkron sosem viheti vissza. Azonos végnél a korábbi kezdés az
     * igaz — az mutatja a teljes hosszt.
     */
    fun merge(a: Lockdown?, b: Lockdown?): Lockdown? {
        if (a == null) return b
        if (b == null) return a
        if (b.until > a.until) return b
        if (a.until > b.until) return a
        return if (a.startedAt <= b.startedAt) a else b
    }

    /**
     * A dróton érkezett zárlat beolvasása. Minden mező gyanús: másik eszköz
     * írta. Ami nem értelmes, az nincs.
     */
    fun parse(until: Double?, startedAt: Double?): Lockdown? {
        val u = until ?: return null
        if (!u.isFinite() || u <= 0) return null
        val end = u.toLong()
        val s = startedAt?.takeIf { it.isFinite() && it > 0 }?.toLong() ?: end
        return Lockdown(minOf(s, end), end)
    }

    /**
     * Magyar, olvasható hátralévő idő: 6 nap 3 óra, 2 ó 15 p, 4 perc.
     *
     * A zárlat hossza napokban is mérhető, ezért nem a percre pontos alak kell
     * — aki hét napot zárt le, annak a másodpercek csak nézegetnivalót adnának.
     */
    fun formatRemaining(ms: Long): String {
        val total = maxOf(0L, (ms + 999) / 1000)
        val days = total / 86_400
        val hours = (total % 86_400) / 3600
        val mins = (total % 3600) / 60
        if (days > 0) return if (hours > 0) "$days nap $hours óra" else "$days nap"
        if (hours > 0) return if (mins > 0) "$hours ó $mins p" else "$hours óra"
        return "${maxOf(1L, mins)} perc"
    }

    // --------------------------------------------------------- ZÁRLAT-ABLAK
    //
    // Heti ablak, amiben a zárlat MAGÁTÓL él: például hétköznap 9-től 17-ig.
    // Nem új érvényesítés, hanem egy időzítő a meglévő elé: a kör az ablak
    // végéig szóló zárlatot ír, és onnantól minden ugyanaz. A telefon az
    // ablakot hordozza, fésüli és érvényesíti; szerkeszteni a gépen lehet.
    // A lockdown.ts ablak-részének tükre; lásd docs/feature-lockdown-windows.md.

    /** Ennél több ablak nem fér ki — és nem is kell: hét nap van. */
    const val MAX_LOCKDOWN_WINDOWS = 7
    /**
     * Legalább ennyi szabad perc kell a héten az ablakok mellett. Enélkül az
     * ablakot sosem lehetne levenni — az nem döntés lenne, hanem csapda.
     */
    const val MIN_FREE_MINUTES_PER_WEEK = 60
    /** Az ablak azonosítója legfeljebb ennyi karakter — kívülről jött szöveg. */
    private const val MAX_WINDOW_ID = 40

    /** Egy zárlat-ablak: a sáv mezői (napok, kezdés, vég) és az azonosító, ami a felületé. */
    data class LockdownWindow(val id: String, val days: Set<Int>, val startMin: Int, val endMin: Int) {
        val band: ScheduleLogic.Band get() = ScheduleLogic.Band(days, startMin, endMin)
    }

    /** Az ablak tartalmi kulcsa: napok (rendezve), kezdés, vég. */
    fun windowKey(b: ScheduleLogic.Band): String =
        "${b.days.sorted().joinToString(",")}/${b.startMin}/${b.endMin}"

    /** Egy kívülről jött ablak használható alakja, vagy null. */
    fun cleanWindow(w: LockdownWindow?): LockdownWindow? {
        if (w == null || w.id.isEmpty() || w.id.length > MAX_WINDOW_ID) return null
        val days = w.days.filter { it in 0..6 }.toSortedSet()
        val band = ScheduleLogic.Band(days, w.startMin, w.endMin)
        if (!ScheduleLogic.isValidBand(band)) return null
        return LockdownWindow(w.id, days, w.startMin, w.endMin)
    }

    /**
     * Egy lista használható alakja: csak érvényes ablakok, azonosító és
     * tartalom szerint is egyszer, legfeljebb a plafonig. A duplát az első nyeri.
     */
    fun cleanWindows(raw: List<LockdownWindow>): List<LockdownWindow> {
        val out = mutableListOf<LockdownWindow>()
        val ids = HashSet<String>()
        val keys = HashSet<String>()
        for (item in raw) {
            val w = cleanWindow(item) ?: continue
            val key = windowKey(w.band)
            if (w.id in ids || key in keys) continue
            if (out.size >= MAX_LOCKDOWN_WINDOWS) break
            ids.add(w.id); keys.add(key)
            out.add(w)
        }
        return out
    }

    /** Ugyanaz-e a két lista tartalmilag (az azonosító nem számít). */
    fun sameWindows(a: List<ScheduleLogic.Band>, b: List<ScheduleLogic.Band>): Boolean =
        a.map { windowKey(it) }.sorted() == b.map { windowKey(it) }.sorted()

    /** Marad-e szabad idő a héten az ablakok mellett — percenkénti mintavétellel. */
    fun weekHasFreeTime(windows: List<ScheduleLogic.Band>, now: Long): Boolean {
        if (windows.isEmpty()) return true
        var free = 0
        for (i in 0 until 7 * 24 * 60) {
            if (!ScheduleLogic.inAnyBand(windows, now + i * 60_000L)) {
                free++
                if (free >= MIN_FREE_MINUTES_PER_WEEK) return true
            }
        }
        return false
    }

    /**
     * LAZÍTÁS-e a lista cseréje: van-e perc a következő héten, amikor a régi
     * lista zárlatot tartana, az új nem. Az üres lista külön eset: a menetrend
     * normalizálója az üres sávlistát „mindig tiltva”-ként érti.
     */
    fun isWindowsLoosening(current: List<ScheduleLogic.Band>, next: List<ScheduleLogic.Band>, now: Long): Boolean {
        if (current.isEmpty()) return false
        if (next.isEmpty()) return true
        return ScheduleLogic.isLoosening(
            ScheduleLogic.Schedule(ScheduleLogic.Mode.SCHEDULED_BLOCK, current),
            ScheduleLogic.Schedule(ScheduleLogic.Mode.SCHEDULED_BLOCK, next),
            now,
        )
    }

    /** Az ÉLŐ ablak MOSTANI előfordulása — több közül a legkésőbb végződő. */
    fun dueWindow(windows: List<ScheduleLogic.Band>, now: Long): Focus.Occurrence? {
        var best: Focus.Occurrence? = null
        for (w in windows) {
            if (!ScheduleLogic.isValidBand(w)) continue
            val occ = Focus.occurrenceAt(w, now) ?: continue
            val b = best
            if (b == null || occ.endsAt > b.endsAt || (occ.endsAt == b.endsAt && occ.startsAt < b.startsAt)) best = occ
        }
        return best
    }

    /**
     * A zárlat, amit az ablakok MOST megkövetelnek — vagy null, ha a meglévő
     * elég. A kezdés az ablak kezdése, ha nem futott zárlat (így két eszköz
     * ugyanazt állítja elő); futó zárlat mellett a futóé marad, az ablak csak
     * a végét tolja ki. A lockdown.ts `windowLockdown` tükre.
     */
    fun windowLockdown(cur: Lockdown?, windows: List<ScheduleLogic.Band>, now: Long): Lockdown? {
        val occ = dueWindow(windows, now) ?: return null
        if (isLocked(cur, now) && cur!!.until >= occ.endsAt) return null
        return Lockdown(if (isLocked(cur, now)) cur!!.startedAt else occ.startsAt, occ.endsAt)
    }

    /**
     * Ablak-zárlat-e ez: a vége pontosan egy ablak-előfordulás vége. Az ilyet
     * az óra-ugrás elnyelése nem tolja el — az ablak vége az ablak vége. A
     * VÉG dönt, nem a kezdés: az ablak előtt indított kézi zárlatot az ablak
     * csak kitolja. A lockdown.ts `isWindowLockdown` tükre.
     */
    fun isWindowLockdown(l: Lockdown, windows: List<ScheduleLogic.Band>): Boolean {
        for (w in windows) {
            if (!ScheduleLogic.isValidBand(w)) continue
            // Egy ezredmásodperccel a vég előtt még az ablakban vagyunk.
            val occ = Focus.occurrenceAt(w, l.until - 1) ?: continue
            if (occ.endsAt == l.until) return true
        }
        return false
    }

    /**
     * Két eszköz ablak-listája EGGYÉ fésülve, a JELÜK szerint: nagyobb jel
     * nyer (a levétel próbatétellel jár, ami lépteti), azonos jelnél a bővebb
     * lista — a kettő uniója tartalom szerint. A jeltelen blob (régi kliens)
     * jele nulla: az ilyen sosem törölhet listát. A `mergeWindows` tükre.
     */
    fun mergeWindows(
        localMark: Int, local: List<LockdownWindow>, incomingMark: Int, incoming: List<LockdownWindow>,
    ): List<LockdownWindow> {
        if (localMark > incomingMark) return cleanWindows(local)
        if (incomingMark > localMark) return cleanWindows(incoming)
        return cleanWindows(local + incoming)
    }
}
