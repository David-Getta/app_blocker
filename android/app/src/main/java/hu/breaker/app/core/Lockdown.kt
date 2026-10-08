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
    // ablakot hordozza, fésüli, érvényesíti és szerkeszti is — ugyanazzal a
    // bíróval, mint a gép.
    // A lockdown.ts ablak-részének tükre; lásd docs/feature-lockdown-windows.md.

    /** Ennél több ablak nem fér ki — és nem is kell: hét nap van. */
    const val MAX_LOCKDOWN_WINDOWS = 7
    /**
     * Legalább ennyi szabad perc kell a héten az ablakok mellett. Enélkül az
     * ablakot sosem lehetne levenni — az nem döntés lenne, hanem csapda.
     */
    const val MIN_FREE_MINUTES_PER_WEEK = 60
    /** Ennyivel a heti ablak beérése előtt szólunk egyszer — ami nyitva van, mentsd el. */
    const val WINDOW_PRE_WARN_MS = 10 * 60_000L
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

    /** Ennél több ablak-jelet nem hordunk — a `lockdown.ts` `MAX_WINDOW_MARKS`-e. */
    const val MAX_WINDOW_MARKS = 64

    private val WINDOW_KEY = Regex("^([0-6](?:,[0-6])*)/([0-9]{1,4})/([0-9]{1,4})$")

    /** Kanonikus tartalmi kulcs-e: érvényes sáv, a napok szigorúan növekvő sorrendben, vezető nulla nélkül. */
    fun isWindowKey(k: String): Boolean {
        val m = WINDOW_KEY.matchEntire(k) ?: return false
        val days = m.groupValues[1].split(",").map { it.toInt() }
        for (i in 1 until days.size) if (days[i] <= days[i - 1]) return false
        val band = ScheduleLogic.Band(days.toSortedSet(), m.groupValues[2].toInt(), m.groupValues[3].toInt())
        return ScheduleLogic.isValidBand(band) && windowKey(band) == k
    }

    /**
     * A jelek plafonja — a gép `capWindowMarks`-e: a jelen lévő ablakok jele
     * mindig marad, a levettekből a legnagyobb jelűek (holtversenyben kódegység
     * szerint). Üresen null.
     */
    fun capWindowMarks(marks: Map<String, Int>, present: List<String>): Map<String, Int>? {
        if (marks.isEmpty()) return null
        val here = present.toHashSet()
        val kept = marks.entries.filter { it.key in here }
        val gone = marks.entries.filter { it.key !in here }
            .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
        val limit = maxOf(kept.size, MAX_WINDOW_MARKS)
        val out = LinkedHashMap<String, Int>()
        for (e in kept + gone) {
            if (out.size >= limit) break
            out[e.key] = e.value
        }
        return out
    }

    /** A kívülről jött ablak-jelek tisztán: kanonikus tartalmi kulcs, pozitív egész, legfeljebb a rev. */
    fun cleanWindowMarks(raw: Map<String, Int>?, windows: List<LockdownWindow>, maxRev: Int): Map<String, Int>? {
        if (raw == null) return null
        val marks = LinkedHashMap<String, Int>()
        for ((k, v) in raw) {
            if (v <= 0 || v > maxRev || !isWindowKey(k)) continue
            marks[k] = v
        }
        return capWindowMarks(marks, windows.map { windowKey(it.band) })
    }

    /** Egy sáv heti percei SZERKEZET szerint — az óraátállítás nélkül. */
    private fun bandMinutes(b: ScheduleLogic.Band): Int =
        b.days.size * (if (b.endMin > b.startMin) b.endMin - b.startMin else 1440 - b.startMin + b.endMin)

    /**
     * A hét szabad percei az ablakok mellett — SZERKEZET szerint (7×1440 perc,
     * óraátállítás és időzóna nélkül), a gép `freeMinutesPerWeek`-je: a
     * fésülésnek minden eszközön, minden pillanatban ugyanazt kell adnia. Az
     * érvénytelen sáv nem fed le semmit.
     */
    fun freeMinutesPerWeek(windows: List<ScheduleLogic.Band>): Int {
        val covered = BooleanArray(7 * 1440)
        for (b in windows) {
            if (!ScheduleLogic.isValidBand(b)) continue
            for (d in b.days) {
                val base = d * 1440
                if (b.endMin > b.startMin) {
                    covered.fill(true, base + b.startMin, base + b.endMin)
                } else {
                    covered.fill(true, base + b.startMin, base + 1440)
                    val next = ((d + 1) % 7) * 1440
                    covered.fill(true, next, next + b.endMin)
                }
            }
        }
        return covered.count { !it }
    }

    /** Az ablakok egy eszközön: a lista és a tartalmi kulcsonkénti jelek. */
    data class WindowSet(val windows: List<LockdownWindow>, val marks: Map<String, Int>? = null)

    private data class Candidate(val w: LockdownWindow, val k: String, val m: Int, val size: Int)

    /**
     * Két eszköz ablakai TARTALMI KULCSONKÉNT fésülve — a gép `mergeWindowSets`-e.
     * A jel a tartalomhoz tartozik, a nagyobb dönt, egyenlő vagy hiányzó jelnél
     * az unió; azonos tartalomnál a kisebb azonosító marad, és ha egy azonosító
     * két tartalomhoz is tartozna, a későbbi a tartalmi kulcsát kapja. A
     * sorrend a régebbi ígéreté (jel, aztán a kisebb ablak, aztán a kulcs); a
     * hetes plafon és a heti egy szabad óra ebben a sorrendben vág — a
     * legfrissebb esik ki, a jele marad.
     */
    fun mergeWindowSets(a: WindowSet, b: WindowSet): WindowSet {
        val listA = cleanWindows(a.windows)
        val listB = cleanWindows(b.windows)
        val byKey = LinkedHashMap<String, LockdownWindow>()
        for (w in listA + listB) {
            val k = windowKey(w.band)
            val had = byKey[k]
            if (had == null || w.id < had.id) byKey[k] = w
        }
        val keysA = listA.map { windowKey(it.band) }.toHashSet()
        val keysB = listB.map { windowKey(it.band) }.toHashSet()
        val names = LinkedHashSet<String>(keysA + keysB)
        for (m in listOf(a.marks, b.marks)) m?.keys?.forEach { if (isWindowKey(it)) names.add(it) }
        val present = ArrayList<Candidate>()
        val marks = LinkedHashMap<String, Int>()
        for (k in names) {
            val ma = a.marks?.get(k)?.takeIf { it > 0 } ?: 0
            val mb = b.marks?.get(k)?.takeIf { it > 0 } ?: 0
            val inA = k in keysA
            val inB = k in keysB
            val here = if (ma > mb) inA else if (mb > ma) inB else inA || inB
            val m = maxOf(ma, mb)
            if (here) {
                val w = byKey.getValue(k)
                present.add(Candidate(w, k, m, bandMinutes(w.band)))
            }
            if (m > 0) marks[k] = m
        }
        val kept = ArrayList<LockdownWindow>()
        val ids = HashSet<String>()
        for (p in present.sortedWith(compareBy<Candidate>({ it.m }, { it.size }, { it.k }))) {
            if (kept.size >= MAX_LOCKDOWN_WINDOWS) break
            if (freeMinutesPerWeek((kept + p.w).map { it.band }) < MIN_FREE_MINUTES_PER_WEEK) continue
            var id = p.w.id
            var n = 1
            while (id in ids) {
                id = if (n == 1) p.k else "${p.k}#$n"
                n++
            }
            ids.add(id)
            kept.add(p.w.copy(id = id))
        }
        return WindowSet(kept, capWindowMarks(marks, kept.map { windowKey(it.band) }))
    }

    /**
     * Az ablak-jelek a léptetésben — a gép `markWindowChanges`-e: ami tartalom az
     * előző léptetés óta bekerült vagy kikerült, az ezt a blob-rev-et kapja.
     */
    fun markWindowChanges(marks: Map<String, Int>?, prevKeys: List<String>, next: List<LockdownWindow>, rev: Int): Map<String, Int>? {
        val out = LinkedHashMap<String, Int>()
        marks?.forEach { (k, v) -> if (v > 0) out[k] = v }
        val nextKeys = next.map { windowKey(it.band) }
        val before = prevKeys.toHashSet()
        val after = nextKeys.toHashSet()
        for (k in nextKeys) if (k !in before) out[k] = rev
        for (k in prevKeys) if (k !in after && isWindowKey(k)) out[k] = rev
        return capWindowMarks(out, nextKeys)
    }

    /** Az ablak-jelek tartalmi kulcsa — rendezve, a különbség-vizsgálathoz. */
    fun windowMarksKey(marks: Map<String, Int>?): String =
        (marks ?: emptyMap()).toSortedMap().entries.joinToString(";") { "${it.key}=${it.value}" }

    /**
     * A legközelebb beérő ablak-előfordulás, ha `withinMs`-en belül kezdődik —
     * a jelzéshez. Nem közelgő, ami már él (arról a zárlat beszél), és nincs
     * miről szólni, ha egy futó zárlat úgyis túlér rajta: az érkezése semmin
     * nem változtat. Két eszköz ugyanazt találja: ugyanaz a lista, ugyanaz az óra.
     */
    fun windowStartingSoon(
        cur: Lockdown?, windows: List<ScheduleLogic.Band>, now: Long, withinMs: Long = WINDOW_PRE_WARN_MS,
    ): Focus.Occurrence? {
        var soonest: Focus.Occurrence? = null
        for (w in windows) {
            if (!ScheduleLogic.isValidBand(w)) continue
            val occ = Focus.nextOccurrence(w, now) ?: continue
            if (occ.startsAt <= now) continue
            val best = soonest
            if (best == null || occ.startsAt < best.startsAt) soonest = occ
        }
        val s = soonest ?: return null
        if (s.startsAt - now > withinMs) return null
        if (isLocked(cur, now) && cur!!.until >= s.endsAt) return null
        return s
    }
}
