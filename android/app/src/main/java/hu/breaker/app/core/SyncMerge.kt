package hu.breaker.app.core

/**
 * Két eszköz blokklistájának összefésülése — a `desktop/src/shared/sync/merge.ts`
 * tükre.
 *
 * Ez a szinkron kockázatos fele. Egy blokkoló appnál minden új funkció egyben
 * egy lehetséges KIBÚVÓ is, és a szinkron a legcsábítóbb: ha az összefésülés
 * bármikor a lazább oldal felé dől, elég két eszköz és egy jól időzített
 * művelet ahhoz, hogy próbatétel nélkül oldódjon fel valami.
 *
 * Ezért itt is ugyanaz a szabály, ami az app többi részét tartja:
 *
 *   szigorítás ingyen van, lazítás munkába kerül.
 *
 * MEZŐNKÉNT dől el, nem rekordonként: a négy tiltó mező (törlés, menetrend,
 * napi keret, adag-szabály) a saját kifizetett lazítás-számlálóját hordja —
 * a bíró írja, a próbatétel teljesítésekor. A több kifizetett lazítás nyer;
 * egyenlő számnál a mező SZIGORÚBB alakja jön ki (a menetrendek uniója, a
 * kisebb keret, a kisebb adag és a hosszabb szünet, törlés csak ha mindkettő
 * vár). A rekord `rev`-je nem hitelesít lazítást: az ingyenes szigorítás is
 * lépteti, és egy elavult eszköz így felhúzott rekordja eddig egészében nyert.
 *
 * Ha ez a fájl elcsúszik a TypeScript változatától, a felhasználó ugyanazt az
 * appot kapja két különböző viselkedéssel — a telefonján más lesz blokkolva,
 * mint a gépén.
 */
object SyncMerge {

    /**
     * Egy oldal a szinkronban.
     *
     * Ugyanaz, mint a helyi [Site], két mezővel bővítve: a [rev] a módosítások
     * száma, az [updatedAt] az utolsó módosítás ideje. Ez a kettő adja az
     * összefésülés sorrendjét. A SZÜNET szándékosan nincs benne: eszközfüggő és
     * rövid életű, fel se megy a kiszolgálóra.
     */
    data class SyncSite(
        val id: String,
        val domain: String,
        val hostnames: List<String>,
        val addedAt: Long,
        val pendingDeleteAt: Long? = null,
        val schedule: ScheduleLogic.Schedule? = null,
        val dailyLimitSeconds: Long? = null,
        /** adag-szabály: a kettő csak együtt értelmes (lásd core/Burst.kt) */
        val burstSeconds: Long? = null,
        val cooldownSeconds: Long? = null,
        val alias: String? = null,
        /** indok: miért tiltottad — a nyertes rekorddal jön, mint a fedőnév */
        val reason: String? = null,
        /**
         * Részleges szabályok (`youtube.com/@valaki`).
         *
         * A `null` és az ÜRES LISTA két különböző dolog, és ezen múlik, hogy egy
         * régi kliens le tudja-e törölni a szabályokat. A `null` jelentése:
         * nem tudok erről a mezőről. Az üres listáé: volt, és el lett
         * távolítva. Lásd `mergeRules`.
         */
        val rules: List<UrlRules.UrlRule>? = null,
        val rev: Int = 1,
        val updatedAt: Long = 0,
        val updatedBy: String = "",
        /**
         * A hosztnevek JELEI: név → a rekord rev-je, amelyik a nevet utoljára
         * felvette vagy levette (melyik történt, azt a `hostnames` mondja). A
         * nagyobb jel dönt az összefésülésnél; jel nélkül a bővebb nyer. A
         * telefon nem szerkeszt hosztnevet: hordozza és fésüli a jeleket, nem
         * ír újat. Lásd `withHostnames` (merge.ts tükre).
         */
        val hostnameMarks: Map<String, Int>? = null,
        /**
         * A szabálylista JELE: a rekord rev-je, amelyik a listát utoljára
         * változtatta. Már csak a RÉGI klienseknek szól (ők ebből fésülnek); a
         * fésülés a szabályonkénti jeleket nézi, ezt csak továbbviszi. A
         * telefon nem ír ilyet, hordozza. Lásd `mergeRules`.
         */
        val rulesRev: Int? = null,
        /**
         * A KIFIZETETT LAZÍTÁSOK száma mezőnként — a bíró írja, a próbatétel
         * teljesítésekor. A fésülésben a több nyer, egyenlőnél a szigorúbb
         * alak. Null = nulla (régi kliens). A merge.ts tükre.
         */
        val deleteLoosens: Int? = null,
        val scheduleLoosens: Int? = null,
        val limitLoosens: Int? = null,
        val burstLoosens: Int? = null,
        /**
         * A szabályok JELEI: szabály-kulcs (hoszt + út) → a rekord rev-je,
         * amelyik a szabályt utoljára felvette vagy levette (a levett szabály
         * jele sírkő). Szabályonként a nagyobb jel dönt; egyenlőnél a
         * jelenlét. Az Android a bírónál írja (felvétel, kifizetett levétel).
         * A merge.ts tükre.
         */
        val ruleMarks: Map<String, Int>? = null,
        /**
         * A VÉGIGMENT törlés jele: annak a törlés-kérésnek a számlálója
         * ([deleteLoosens]), amelyik valahol végigment. A fésülésben a nagyobb
         * marad. A rekord halott ([isGone]), ha ez a kérés még mindig az utolsó,
         * és senki nem vonta vissza. A merge.ts tükre.
         */
        val goneLoosens: Int? = null,
    )

    // --------------------------------------------------------- szigorúság
    //
    // A menetrend SZERKEZET szerint fésülődik, nem időbélyeg szerint: két eszköz
    // lehet más időzónában, és akkor ugyanaz a két menetrend máshogy fésülődne
    // a két gépen — a szinkron sosem konvergálna. A sávok amúgy is helyi-óra
    // percekben vannak megadva.

    /** Az `inAnyBand` szerkezeti párja — ugyanaz az éjfél-átfordulás. */
    private fun anyBandAtGrid(bands: List<ScheduleLogic.Band>, day: Int, minute: Int): Boolean {
        val prevDay = (day + 6) % 7
        for (b in bands) {
            if (b.endMin > b.startMin) {
                if (b.days.contains(day) && minute >= b.startMin && minute < b.endMin) return true
            } else {
                if (b.days.contains(day) && minute >= b.startMin) return true
                if (b.days.contains(prevDay) && minute < b.endMin) return true
            }
        }
        return false
    }

    /** A heti rács: 7×1440 perc, igaz ahol a menetrend tilt — a merge.ts `scheduleGrid`-je. */
    private fun scheduleGrid(s: ScheduleLogic.Schedule?): BooleanArray {
        val sch = ScheduleLogic.normalize(s)
        val g = BooleanArray(7 * 1440)
        if (sch.mode == ScheduleLogic.Mode.ALWAYS) {
            g.fill(true)
            return g
        }
        val block = sch.mode == ScheduleLogic.Mode.SCHEDULED_BLOCK
        for (day in 0 until 7) {
            for (minute in 0 until 1440) {
                if (anyBandAtGrid(sch.bands, day, minute) == block) g[day * 1440 + minute] = true
            }
        }
        return g
    }

    /**
     * Egy rács menetrendként — a merge.ts `scheduleFromGrid`-je: a tiltott
     * percek napon belüli szakaszai, az azonos szakaszú napok egy sávban,
     * kezdés, aztán vég szerint. Ha minden perc tiltva: mindig.
     */
    private fun scheduleFromGrid(g: BooleanArray): ScheduleLogic.Schedule {
        if (g.all { it }) return ScheduleLogic.Schedule(ScheduleLogic.Mode.ALWAYS, emptyList())
        val runs = LinkedHashMap<Pair<Int, Int>, MutableList<Int>>()
        for (day in 0 until 7) {
            var minute = 0
            while (minute < 1440) {
                if (!g[day * 1440 + minute]) { minute++; continue }
                val start = minute
                while (minute < 1440 && g[day * 1440 + minute]) minute++
                runs.getOrPut(start to minute) { mutableListOf() }.add(day)
            }
        }
        val bands = runs.entries.sortedWith(compareBy({ it.key.first }, { it.key.second }))
            .map { ScheduleLogic.Band(it.value.toSortedSet(), it.key.first, it.key.second) }
        return ScheduleLogic.Schedule(ScheduleLogic.Mode.SCHEDULED_BLOCK, bands)
    }

    /** A menetrend nyers kulcsa — bájtra a merge.ts `scheduleRawKey`-je; a hiányzó az üres szöveg. */
    private fun scheduleRawKey(s: ScheduleLogic.Schedule?): String {
        if (s == null) return ""
        val mode = when (s.mode) {
            ScheduleLogic.Mode.ALWAYS -> "always"
            ScheduleLogic.Mode.SCHEDULED_BLOCK -> "scheduled_block"
            ScheduleLogic.Mode.SCHEDULED_ALLOW -> "scheduled_allow"
        }
        return mode + "|" + s.bands.joinToString(";") { b ->
            b.days.sorted().joinToString(",") + "/" + b.startMin + "/" + b.endMin
        }
    }

    private fun isGridForm(s: ScheduleLogic.Schedule?, g: BooleanArray): Boolean =
        s != null && scheduleRawKey(s) == scheduleRawKey(scheduleFromGrid(g))

    /**
     * Két menetrend SZIGORÚBB alakja — a merge.ts `joinSchedule`-je: minden perc
     * tiltva, amit bármelyik tilt. Ha az egyik lefedi a másikat, az marad;
     * egyenlőnél a felhasználó saját alakja a rácsból épített ellen, két saját
     * közül a kisebb nyers kulcsú; különben a rácsból épül.
     */
    fun joinSchedule(a: ScheduleLogic.Schedule?, b: ScheduleLogic.Schedule?): ScheduleLogic.Schedule? {
        if (scheduleRawKey(a) == scheduleRawKey(b)) return a
        val ga = scheduleGrid(a)
        val gb = scheduleGrid(b)
        var aCovers = true
        var bCovers = true
        for (i in ga.indices) {
            if (gb[i] && !ga[i]) aCovers = false
            if (ga[i] && !gb[i]) bCovers = false
        }
        if (aCovers && bCovers) {
            val fa = isGridForm(a, ga)
            val fb = isGridForm(b, gb)
            if (fa != fb) return if (fa) b else a
            return if (scheduleRawKey(a) <= scheduleRawKey(b)) a else b
        }
        if (aCovers) return a
        if (bCovers) return b
        return scheduleFromGrid(BooleanArray(ga.size) { ga[it] || gb[it] })
    }

    /** A szigorúbb napi keret — a merge.ts `joinLimit`-je: a kisebb; a keret nélküli a leglazább. */
    fun joinLimit(a: Long?, b: Long?): Long? {
        val na = LimitLogic.normalizeLimit(a)
        val nb = LimitLogic.normalizeLimit(b)
        if (na == null) return if (nb == null) null else b
        if (nb == null) return a
        if (na != nb) return if (na < nb) a else b
        return minOf(a!!, b!!)
    }

    /**
     * A szigorúbb adag-szabály — a merge.ts `joinBurst`-je: a kisebb adag ÉS a
     * hosszabb szünet; ha az egyik mindkettőben legalább olyan szigorú, az marad.
     */
    fun joinBurst(a: Pair<Long?, Long?>, b: Pair<Long?, Long?>): Pair<Long?, Long?> {
        val na = BurstLogic.normalize(a.first, a.second)
        val nb = BurstLogic.normalize(b.first, b.second)
        if (na == null) return if (nb == null) Pair(null, null) else b
        if (nb == null) return a
        val aStricter = na.burstSeconds <= nb.burstSeconds && na.cooldownSeconds >= nb.cooldownSeconds
        val bStricter = nb.burstSeconds <= na.burstSeconds && nb.cooldownSeconds >= na.cooldownSeconds
        if (aStricter && bStricter) {
            val ka0 = a.first ?: 0L
            val kb0 = b.first ?: 0L
            return if (ka0 != kb0) (if (ka0 < kb0) a else b) else (if ((a.second ?: 0L) <= (b.second ?: 0L)) a else b)
        }
        if (aStricter) return a
        if (bStricter) return b
        return Pair(minOf(na.burstSeconds, nb.burstSeconds), maxOf(na.cooldownSeconds, nb.cooldownSeconds))
    }

    /** A törlésre várás szigorúbb alakja: csak ha mindkettő vár — akkor a későbbi határidő. */
    private fun joinDelete(a: Long?, b: Long?): Long? = if (a == null || b == null) null else maxOf(a, b)

    private fun loosensOf(v: Int?): Int = if (v != null && v > 0) v else 0

    /** Egy mező a fésülésben: a több kifizetett lazítás nyer; egyenlőnél a szigorúbb alak. */
    private fun <T> byLoosens(ca: Int, cb: Int, va: T, vb: T, join: (T, T) -> T): T =
        if (ca != cb) (if (ca > cb) va else vb) else join(va, vb)

    /** A FRISSEBB rekord — rev, idő, eszköz. Már csak a fedőnév és az indok múlik rajta. */
    private fun newerSite(a: SyncSite, b: SyncSite): SyncSite = when {
        a.rev != b.rev -> if (a.rev > b.rev) a else b
        a.updatedAt != b.updatedAt -> if (a.updatedAt > b.updatedAt) a else b
        else -> if (a.updatedBy <= b.updatedBy) a else b
    }

    // -------------------------------------------------------- összefésülés

    /**
     * Két azonos azonosítójú rekord összefésülése — MEZŐNKÉNT (lásd a fájl
     * elejét). Szimmetrikus: a hívónak mindegy, melyik a helyi és melyik a
     * távoli, minden eszköz ugyanazt kapja.
     */
    fun mergeSite(a: SyncSite, b: SyncSite): SyncSite {
        val newer = newerSite(a, b)
        val dA = loosensOf(a.deleteLoosens); val dB = loosensOf(b.deleteLoosens)
        val sA = loosensOf(a.scheduleLoosens); val sB = loosensOf(b.scheduleLoosens)
        val lA = loosensOf(a.limitLoosens); val lB = loosensOf(b.limitLoosens)
        val bA = loosensOf(a.burstLoosens); val bB = loosensOf(b.burstLoosens)
        // A törlésre várás nem tűnhet el csendben: a kérése próbatétel (a
        // számláló nő), a visszavonása ingyen — egyenlő számnál a nem váró nyer.
        val pendingDeleteAt = byLoosens(dA, dB, a.pendingDeleteAt, b.pendingDeleteAt, ::joinDelete)
        val schedule = byLoosens(sA, sB, a.schedule, b.schedule, ::joinSchedule)
        val limit = byLoosens(lA, lB, a.dailyLimitSeconds, b.dailyLimitSeconds, ::joinLimit)
        val burst = byLoosens(bA, bB, Pair(a.burstSeconds, a.cooldownSeconds), Pair(b.burstSeconds, b.cooldownSeconds), ::joinBurst)
        val out = newer.copy(
            pendingDeleteAt = pendingDeleteAt,
            schedule = schedule,
            dailyLimitSeconds = limit,
            burstSeconds = burst.first,
            cooldownSeconds = burst.second,
            rev = maxOf(a.rev, b.rev),
            deleteLoosens = maxOf(dA, dB).takeIf { it > 0 },
            scheduleLoosens = maxOf(sA, sB).takeIf { it > 0 },
            limitLoosens = maxOf(lA, lB).takeIf { it > 0 },
            burstLoosens = maxOf(bA, bB).takeIf { it > 0 },
            goneLoosens = maxOf(loosensOf(a.goneLoosens), loosensOf(b.goneLoosens)).takeIf { it > 0 },
        )
        // A hosztnevek nevenként, a jelük szerint; a szabályok a listájuk jele szerint.
        return withHostnames(withRules(out, a, b), a, b)
    }

    /**
     * A hosztnevek NEVENKÉNT fésülődnek, a jelük szerint: a nagyobb jelnél
     * álló állapot (benne van vagy nincs) marad; egyenlő jelnél (a jel nélküli
     * név is ilyen) a rekord dönt, ahogy eddig — eltérő revnél az újabb, egyenlő
     * revnél a bővebb: versenyhelyzet sosem old fel. Rendezve, hogy két eszköz
     * ugyanazt kapja. A TypeScript- és Swift-tükör ugyanezt teszi (merge.ts
     * withHostnames).
     */
    private fun withHostnames(merged: SyncSite, a: SyncSite, b: SyncSite): SyncSite {
        val am = a.hostnameMarks ?: emptyMap()
        val bm = b.hostnameMarks ?: emptyMap()
        val names = (a.hostnames + b.hostnames + am.keys + bm.keys).toSortedSet()
        val hostnames = ArrayList<String>()
        val marks = LinkedHashMap<String, Int>()
        for (h in names) {
            val ma = am[h] ?: 0
            val mb = bm[h] ?: 0
            val inA = h in a.hostnames
            val inB = h in b.hostnames
            // Egyenlő POZITÍV jelnél a jelenlét nyer (szigorúbb, és sorrendtől
            // független); jel nélkül a rekord dönt, ahogy eddig.
            val present = when {
                ma > mb -> inA
                mb > ma -> inB
                ma > 0 -> inA || inB
                a.rev != b.rev -> if (a.rev > b.rev) inA else inB
                else -> inA || inB
            }
            if (present) hostnames.add(h)
            if (maxOf(ma, mb) > 0) marks[h] = maxOf(ma, mb)
        }
        return merged.copy(hostnames = hostnames, hostnameMarks = capHostnameMarks(marks, hostnames))
    }

    /** Ennél több hosztnév-jelet nem hordunk egy oldalon. */
    const val MAX_HOSTNAME_MARKS = 64

    /**
     * A jelek plafonja — EGY szabály a fésülésre és a bemenetre: a jelen lévő
     * nevek jele mindig marad, a levett nevekből a legnagyobb jelűek férnek
     * be. Üresen null. A merge.ts `capHostnameMarks` tükre.
     */
    fun capHostnameMarks(marks: Map<String, Int>, hostnames: List<String>): Map<String, Int>? {
        if (marks.isEmpty()) return null
        if (marks.size <= MAX_HOSTNAME_MARKS) return LinkedHashMap(marks)
        val present = hostnames.toSet()
        val out = LinkedHashMap<String, Int>()
        for ((h, v) in marks) if (h in present) out[h] = v
        val gone = marks.entries.filter { it.key !in present }
            .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
        for ((h, v) in gone) {
            if (out.size >= MAX_HOSTNAME_MARKS) break
            out[h] = v
        }
        return out
    }

    private fun withRules(winner: SyncSite, a: SyncSite, b: SyncSite): SyncSite {
        val merged = mergeRules(a, b)
        val rulesRev = merged.mark.takeIf { it > 0 && merged.rules != null }
        val ruleMarks = merged.marks?.takeIf { merged.rules != null && it.isNotEmpty() }
        return if (merged.rules == winner.rules && rulesRev == winner.rulesRev && ruleMarks == winner.ruleMarks) winner
            else winner.copy(rules = merged.rules, rulesRev = rulesRev, ruleMarks = ruleMarks)
    }

    /** Egy szabály kulcsa a jelekhez: a kanonikus hoszt + út — a merge.ts `ruleKey`-je. */
    fun ruleKey(r: UrlRules.UrlRule): String = r.host + r.path

    private fun markOf(v: Int?): Int = if (v != null && v > 0) v else 0

    private class MergedRules(val rules: List<UrlRules.UrlRule>?, val marks: Map<String, Int>?, val mark: Int)

    /**
     * A részleges szabályok összefésülése — a rekord többi mezőjétől KÜLÖN,
     * SZABÁLYONKÉNT (a merge.ts `mergeRules`-a):
     *
     *  1. **A szabály jele dönt.** A nagyobb jelnél álló állapot (benne van
     *     vagy nincs) marad — a kifizetett levétel átmegy, és egy régebbi
     *     eszköz ingyenes szerkesztése sem hozza vissza.
     *  2. **Egyenlő jelnél a jelenlét** — a jel nélküli szabály is ilyen.
     *  3. **A lista-jel (`rulesRev`) már nem dönt**, csak továbbmegy (a
     *     nagyobb): egy ingyenes felvétel eddig nagyobb jellel egészében vitte
     *     a listáját, és a másik eszközön felvett szabály eltűnt.
     *  4. **A `null` NEM ugyanaz, mint az üres lista.** A mező nélküli rekord
     *     (régi kliens) a másik oldal listáját, jeleit és lista-jelét viszi.
     *
     * A plafon: legfeljebb 50 szabály marad (a nagyobb jelűek, egyenlőnél
     * kulcs szerint); a kiesett szabály jele is kiesik.
     */
    private fun mergeRules(a: SyncSite, b: SyncSite): MergedRules {
        val ar = cleanRules(a.rules)
        val br = cleanRules(b.rules)
        if (ar == null && br == null) return MergedRules(null, null, 0)
        if (ar == null) return MergedRules(br, b.ruleMarks, markOf(b.rulesRev))
        if (br == null) return MergedRules(ar, a.ruleMarks, markOf(a.rulesRev))
        val am = a.ruleMarks ?: emptyMap()
        val bm = b.ruleMarks ?: emptyMap()
        val byKey = LinkedHashMap<String, UrlRules.UrlRule>()
        for (r in ar + br) byKey[ruleKey(r)] = r
        val inA = ar.map { ruleKey(it) }.toSet()
        val inB = br.map { ruleKey(it) }.toSet()
        val marks = HashMap<String, Int>()
        val present = ArrayList<String>()
        val keys = LinkedHashSet<String>().apply { addAll(byKey.keys); addAll(am.keys); addAll(bm.keys) }
        for (k in keys) {
            val ma = markOf(am[k])
            val mb = markOf(bm[k])
            val here = if (ma > mb) k in inA else if (mb > ma) k in inB else (k in inA || k in inB)
            if (maxOf(ma, mb) > 0) marks[k] = maxOf(ma, mb)
            if (here) present.add(k)
        }
        present.sortWith(compareByDescending<String> { markOf(marks[it]) }.thenBy { it })
        for (k in present.drop(UrlRules.MAX_RULES_PER_SITE)) marks.remove(k)
        val kept = present.take(UrlRules.MAX_RULES_PER_SITE)
        // Stabil sorrend, hogy két eszköz bájtra ugyanazt a listát kapja.
        val rules = kept.map { byKey.getValue(it) }.sortedBy { ruleKey(it) }
        return MergedRules(rules, capHostnameMarks(marks, kept), maxOf(markOf(a.rulesRev), markOf(b.rulesRev)))
    }

    /** Szemétszűrés: a szinkronon át érkező szabály ugyanolyan megbízhatatlan, mint bármi más. */
    private fun cleanRules(rules: List<UrlRules.UrlRule>?): List<UrlRules.UrlRule>? {
        if (rules == null) return null
        val out = ArrayList<UrlRules.UrlRule>()
        for (r in rules) {
            // Ugyanazon a magon megy át, mint a kézzel beírt szabály.
            val norm = UrlRules.normalizeRule(r.host + r.path) ?: continue
            if (out.any { UrlRules.sameRule(it, norm) }) continue
            if (out.size >= UrlRules.MAX_RULES_PER_SITE) break
            out.add(norm)
        }
        return out
    }

    /**
     * HALOTT-e a rekord: a törlése végigment valahol ([SyncSite.goneLoosens]),
     * és azóta senki nem vonta vissza (a kérés ugyanaz, és még vár) — új kérés
     * sem jött. A visszavonás és az újabb kérés élő rekordot ad. A halott rekord
     * nem tilt semmit, de UTAZIK: egy régi eszköz rekordja vele fésülődve maga
     * is halott lesz. A merge.ts tükre.
     */
    fun isGone(s: SyncSite): Boolean {
        val g = loosensOf(s.goneLoosens)
        return g > 0 && loosensOf(s.deleteLoosens) == g && s.pendingDeleteAt != null
    }

    /** Ennél több halott rekordot nem hordunk: a legutóbb töröltek maradnak. */
    const val MAX_GONE_SITES = 64

    /**
     * A végigment törlés SÍRKÖVE: a rekord, a kérés számlálójával megjelölve.
     * Csak kifizetett — számlálós — törlésnek van; a rekord minden mezője
     * marad (ha egy visszavonás feltámasztja, a menetrendje ne vesszen el).
     */
    fun tombstoneOf(s: SyncSite): SyncSite? {
        val del = loosensOf(s.deleteLoosens)
        if (del == 0 || s.pendingDeleteAt == null) return null
        return s.copy(goneLoosens = del)
    }

    /** Esedékes-e a törlés EZEN az eszközön: vár, és a határideje itt lejárt. */
    private fun isDue(s: SyncSite, now: Long): Boolean = s.pendingDeleteAt != null && s.pendingDeleteAt <= now

    /**
     * A beérkezett lista előkészítése ezen az eszközön, a fésülés ELŐTT: ami
     * nincs a helyi tiltólistán, és a törlése itt már esedékes, az itt
     * végrehajtott törlés — kifizetett kérésnél sírkő lesz belőle. Sírkőként
     * kimarad a domain szerinti összevonásból. A merge.ts tükre.
     */
    fun settleIncoming(incoming: List<SyncSite>, localIds: Set<String>, now: Long): List<SyncSite> =
        incoming.map { s -> if (s.id in localIds || !isDue(s, now) || isGone(s)) s else tombstoneOf(s) ?: s }

    /** A fésült lista szétosztása: mi tilt itt, és mi sírkő. */
    data class Split(val sites: List<SyncSite>, val gone: List<SyncSite>)

    /**
     * A fésült lista szétosztása ezen az eszközön. A helyi rekord a listán
     * marad (a sorsát a bíró dönti el), és az is, ami itt még nem esedékes (a
     * saját határidejéig tilt); az esedékes halott a sírkövek közé kerül; az
     * esedékes, számlálós, nem halott a listára (a bíró végrehajtja); a
     * számláló nélküli, régi végigment törlés egyik közé sem. A merge.ts tükre.
     */
    fun splitMerged(merged: List<SyncSite>, localIds: Set<String>, now: Long): Split {
        val sites = mutableListOf<SyncSite>()
        val gone = mutableListOf<SyncSite>()
        for (m in merged) {
            when {
                m.id in localIds || !isDue(m, now) -> sites.add(m)
                isGone(m) -> gone.add(m)
                loosensOf(m.deleteLoosens) > 0 -> sites.add(m)
            }
        }
        return Split(sites, gone)
    }

    /**
     * A sírkövek sorrendje és plafonja: a legkésőbbi határidejűek maradnak,
     * holtversenyben azonosító szerint (kódegység — mint a gépen). A helyi
     * sírkövekre is ez áll (a bíró ezzel tartja őket).
     */
    fun <T> capGone(gone: List<T>, id: (T) -> String, pending: (T) -> Long?): List<T> =
        gone.sortedWith(compareByDescending<T> { pending(it) ?: 0L }.thenBy { id(it) }).take(MAX_GONE_SITES)

    /**
     * Két lista összefésülése.
     *
     * Ami csak az egyik oldalon van, bekerül — ez SZIGORÍTÁS, tehát ingyen van,
     * és pont ez az, amiért a szinkron kell. Egy hiányzó rekord SOSEM jelent
     * törlést: különben elég lenne egy üres fiókkal belépni, és a lista eltűnne.
     *
     * A végigment törlés HALOTT rekordként marad ([isGone]): azonosító szerint
     * ugyanúgy fésülődik, mint az élők, csak utána dől el, melyik él. A domain
     * szerinti összevonás csak az élőkre áll; a halottak a végén, plafonnal
     * ([MAX_GONE_SITES]). A merge.ts tükre.
     */
    fun mergeLists(local: List<SyncSite>, incoming: List<SyncSite>): List<SyncSite> {
        val byId = LinkedHashMap<String, SyncSite>()
        for (s in local) byId[s.id] = s
        for (s in incoming) {
            val mine = byId[s.id]
            byId[s.id] = if (mine == null) s else mergeSite(mine, s)
        }
        val gone = capGone(byId.values.filter { isGone(it) }, { it.id }, { it.pendingDeleteAt })
        // Ugyanaz a domain kétszer, két eszközről külön felvéve: egy rekordba
        // fésüljük. Enélkül két sorban ugyanaz állna, és az egyiket feloldva a
        // felhasználó azt hinné, feloldotta.
        val byDomain = LinkedHashMap<String, SyncSite>()
        for (s in byId.values.filter { !isGone(it) }.sortedWith(SORT)) {
            val mine = byDomain[s.domain]
            if (mine == null) { byDomain[s.domain] = s; continue }
            val keep = if (mine.addedAt <= s.addedAt) mine else s
            val drop = if (keep === mine) s else mine
            val merged = mergeSite(keep, drop.copy(id = keep.id))
            // A hosztneveket EGYESÍTJÜK: ha az egyik eszközön a társoldalak
            // is fel voltak véve, a másikon meg nem, az egyesítés a szigorúbb.
            // Csak a JEL NÉLKÜLI nevekre: a jelesről a mergeSite már döntött.
            val marks = merged.hostnameMarks ?: emptyMap()
            val extra = (keep.hostnames + drop.hostnames).filter { it !in marks }
            byDomain[s.domain] = merged.copy(
                id = keep.id,
                addedAt = minOf(keep.addedAt, drop.addedAt),
                hostnames = (merged.hostnames + extra).distinct().sorted(),
            )
        }
        return byDomain.values.sortedWith(SORT) + gone.sortedWith(SORT)
    }

    /** Stabil sorrend: minden eszközön ugyanaz a lista, ugyanabban a sorrendben. */
    private val SORT = compareBy<SyncSite>({ it.addedAt }, { it.id })
}
