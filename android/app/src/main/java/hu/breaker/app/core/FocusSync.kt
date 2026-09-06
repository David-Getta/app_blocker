package hu.breaker.app.core

/**
 * A munkamenet összefésülése két eszköz között —
 * a `desktop/src/shared/sync/focus-merge.ts` tükre.
 *
 * Ez a szinkron kockázatos fele. Itt dől el, hogy egy MÁSIK eszköz köre ki
 * tudja-e kapcsolni azt a munkamenetet, amit épp futtatsz — mert ha igen, a
 * leállítás próbatétele megkerülhető: elég két eszköz és egy jól időzített kör.
 *
 * A SZABÁLY UGYANAZ, MINT MINDENHOL:
 *
 *   szigorítás ingyen van, lazítás munkába kerül.
 *
 * A munkamenetnél a szigorítás iránya:
 *
 *   - INDÍTANI és HOSSZABBÍTANI szigorítás  -> azonos `rev` mellett is nyer;
 *   - RÖVIDÍTENI és LEÁLLÍTANI lazítás      -> csak NAGYOBB `rev`-vel nyer.
 *
 * A `rev` csak akkor nő, ha valaki ténylegesen végigcsinálta a próbatételt.
 */
object FocusSync {

    /** Legfeljebb ennyi csomag utazhat — a felületen sem fér ki több. */
    const val MAX_PACKS = 30

    data class SyncFocus(
        val packs: List<Focus.FocusPack> = emptyList(),
        val run: Focus.FocusRun? = null,
        /**
         * A LEZÁRULT menetek naplója — ebből lesz a statisztika.
         *
         * Szándékosan MÁS a szabálya, mint a fenti kettőnek. A csomagok és a
         * futás ENGEDÉLYEK: azt mondják meg, mi történhet, tehát rájuk
         * vonatkozik a súrlódás iránya, és a `rev` őrzi őket. A napló a MÚLT
         * feljegyzése: nem enged meg semmit, és egy elveszett sora nem kibúvó,
         * csak pontatlan statisztika.
         *
         * Ezért a napló EGYESÍTÉS, nem döntés. Aki egységesíteni akarja a
         * hármat, ezt olvassa el előbb: a `rev` léptetése egy naplósorért azt
         * jelentené, hogy egy statisztika-bejegyzés le tud állítani egy futó
         * menetet a másik eszközön.
         */
        val log: List<Focus.FocusLogEntry> = emptyList(),
        val rev: Long = 0,
        val updatedAt: Long = 0,
        val updatedBy: String = "",
        /**
         * A csomagok JELEI: azonosító → a blob rev-je, amelyik a csomagot
         * utoljára felvette, szerkesztette vagy törölte (a törölt csomag jele
         * marad, a csomag nincs a listán). Csomagonként a nagyobb jel dönt;
         * jel nélkül az újabb blob. A telefon jelet nem ír. Lásd `mergePacks`.
         */
        val packMarks: Map<String, Int>? = null,
    )

    /**
     * Két állapot összefésülése.
     *
     * A csomagok és a futás KÜLÖN dőlnek el, mert más a szabályuk: a
     * csomagoknál az utolsó író nyer (ez beállítás — egy régi lista
     * visszatérése bosszantó, de nem kibúvó), a futásnál a szigorúbb.
     */
    fun merge(local: SyncFocus, incoming: SyncFocus): SyncFocus {
        val newer = pickNewer(local, incoming)
        val older = if (newer === local) incoming else local
        val (packs, packMarks) = mergePacks(newer, older)
        return SyncFocus(
            packs = packs,
            run = mergeRun(local, incoming),
            // EGYESÍTÉS, nem választás: lásd a `log` mező magyarázatát.
            log = mergeLog(local.log, incoming.log),
            rev = maxOf(local.rev, incoming.rev),
            // Az idő a GYŐZTESÉ, nem a nagyobb: az eredmény kulcsa így az újabb
            // blobé, és három eszköz bármilyen sorrendben ugyanoda jut.
            updatedAt = newer.updatedAt,
            updatedBy = newer.updatedBy,
            packMarks = packMarks,
        )
    }

    /**
     * A csomagok CSOMAGONKÉNT fésülődnek, a jelük szerint: a nagyobb jelnél
     * álló állapot (ez a változat, vagy nincs) marad; egyenlő jelnél (a jel
     * nélküli csomag is ilyen) az újabb blob állapota, ahogy eddig. A sorrend
     * az újabb blobé, a csak a régebbin élő csomagok a végére. A telefon jelet
     * nem ír, csak hordozza és fésüli. A merge.ts `mergePacks` tükre.
     */
    private fun mergePacks(newer: SyncFocus, older: SyncFocus): Pair<List<Focus.FocusPack>, Map<String, Int>?> {
        val nm = effectiveMarks(newer)
        val om = effectiveMarks(older)
        val ids = LinkedHashSet<String>()
        newer.packs.forEach { ids.add(it.id) }
        older.packs.forEach { ids.add(it.id) }
        ids.addAll(nm.keys); ids.addAll(om.keys)
        val packs = ArrayList<Focus.FocusPack>()
        val marks = LinkedHashMap<String, Int>()
        for (id in ids) {
            val mn = nm[id] ?: 0
            val mo = om[id] ?: 0
            val pn = newer.packs.firstOrNull { it.id == id }
            val po = older.packs.firstOrNull { it.id == id }
            // Egyenlő POZITÍV jelnél a jelenlét nyer, két változat közül a
            // `preferPack` — a blobtól független, ezért sorrendtől független;
            // jel nélkül az újabb blob állapota.
            val chosen = when {
                mo > mn -> po
                mn > mo -> pn
                mn > 0 -> if (pn != null && po != null) preferPack(pn, po) else pn ?: po
                else -> pn
            }
            if (chosen != null && packs.size < MAX_PACKS) packs.add(chosen)
            if (maxOf(mn, mo) > 0) marks[id] = maxOf(mn, mo)
        }
        // Ugyanaz a plafon, mint a bemeneten — különben 64 fölött a három
        // hely három listát tartana, és sosem érnének össze.
        return packs to capPackMarks(marks, packs.map { it.id })
    }

    /**
     * A blob HATÁSOS jelei: a jelei, és a futó menet csomagján legalább a
     * blob `rev`-je. A menet és a csomagja együtt jár: a törlés jele nem
     * viheti el a csomagot, amíg a másik eszközön menet fut rajta — csomag
     * nélküli menetet a fogadó eldobna, a menetet tartó eszköz meg minden
     * körben újra feltöltené. A sírkő csak akkor nyer, ha a jele nagyobb a
     * menetes blob rev-jénél, de akkor a másik blob rev-je is nagyobb, és a
     * menet is elveszett volna. A focus-merge.ts `effectiveMarks` tükre.
     */
    private fun effectiveMarks(f: SyncFocus): Map<String, Int> {
        val run = f.run ?: return f.packMarks ?: emptyMap()
        if (f.rev <= 0 || f.packs.none { it.id == run.packId }) return f.packMarks ?: emptyMap()
        val marks = LinkedHashMap(f.packMarks ?: emptyMap())
        marks[run.packId] = maxOf(marks[run.packId] ?: 0, f.rev.toInt())
        return marks
    }

    /** Ennél több csomag-jelet nem hordunk egy blobban. */
    const val MAX_PACK_MARKS = 64

    /**
     * A jelek plafonja — EGY szabály a fésülésre és a bemenetre: a jelen
     * lévő csomagok jele mindig marad, a törölt csomagokéból a legnagyobb
     * jelűek férnek be, holtversenyben az azonosító szerint. Üresen null.
     * A focus-merge.ts `capPackMarks` tükre.
     */
    fun capPackMarks(marks: Map<String, Int>, presentIds: Collection<String>): Map<String, Int>? {
        if (marks.isEmpty()) return null
        if (marks.size <= MAX_PACK_MARKS) return marks
        val present = presentIds.toSet()
        val out = LinkedHashMap<String, Int>()
        for ((id, v) in marks) if (id in present) out[id] = v
        val gone = marks.entries.filter { it.key !in present }
            .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
        for ((id, v) in gone) {
            if (out.size >= MAX_PACK_MARKS) break
            out[id] = v
        }
        return out
    }

    /**
     * Egyenlő jelű két változat közül melyik: az ablakos, aztán a szűkebb
     * lista, végül a tartalom kulcsa szerint — a két változatból, nem a
     * hordozó blobból. A focus-merge.ts `preferPack` tükre.
     */
    private fun preferPack(x: Focus.FocusPack, y: Focus.FocusPack): Focus.FocusPack {
        val rx = if (x.recurrence != null) 1 else 0
        val ry = if (y.recurrence != null) 1 else 0
        if (rx != ry) return if (rx > ry) x else y
        val nx = x.allowSites.size + x.allowApps.size
        val ny = y.allowSites.size + y.allowApps.size
        if (nx != ny) return if (nx < ny) x else y
        return if (packOrderKey(x) <= packOrderKey(y)) x else y
    }

    /** A változat kulcsa a sorrendhez — bájtra ugyanez a három nyelvben. */
    private fun packOrderKey(p: Focus.FocusPack): String {
        val rec = p.recurrence?.let { b -> b.days.sorted().joinToString(",") + "/" + b.startMin + "/" + b.endMin } ?: ""
        return listOf(
            p.name, p.defaultMinutes.toString(),
            p.allowSites.sorted().joinToString(","), p.allowApps.sorted().joinToString(","), rec,
        ).joinToString("\u0001")
    }

    /**
     * Melyik oldal FRISSEBB. Sorrend: `rev`, majd idő, majd eszközazonosító.
     *
     * Az azonosító nem esztétika: ez teszi a döntést determinisztikussá.
     * Enélkül két eszköz ugyanabban a másodpercben írva örökké oda-vissza
     * cserélgetné a listát, és mindkettő azt látná, hogy „a másik elrontja”.
     */
    private fun pickNewer(a: SyncFocus, b: SyncFocus): SyncFocus {
        if (a.rev != b.rev) return if (a.rev > b.rev) a else b
        if (a.updatedAt != b.updatedAt) return if (a.updatedAt > b.updatedAt) a else b
        return if (a.updatedBy >= b.updatedBy) a else b
    }

    /**
     * A FUTÓ munkamenet összefésülése — a kockázatos fele.
     *
     * Egy régi, „nem fut” állapot visszajátszása nem kapcsol ki semmit; egy
     * hosszabbítás viszont próbatétel nélkül is átmegy, pontosan úgy, ahogy az
     * appban. Azonos rev-nél a szigorúbb nyer, TELJES rendezéssel: a később
     * végződő, azonos lejáratnál a korábban indult, ha az is egyezik, a kisebb
     * csomagazonosítójú — így nem az nyer, amelyik előbb ért a kiszolgálóra,
     * és három eszköz bármilyen sorrendben ugyanoda jut.
     */
    private fun mergeRun(a: SyncFocus, b: SyncFocus): Focus.FocusRun? {
        if (a.rev != b.rev) return (if (a.rev > b.rev) a else b).run
        val ar = a.run ?: return b.run
        val br = b.run ?: return ar
        return stricterRun(ar, br)
    }

    /** A szigorúbb menet, teljes rendezéssel — döntetlen nincs. */
    private fun stricterRun(x: Focus.FocusRun, y: Focus.FocusRun): Focus.FocusRun {
        if (x.endsAt != y.endsAt) return if (x.endsAt > y.endsAt) x else y
        if (x.startedAt != y.startedAt) return if (x.startedAt < y.startedAt) x else y
        return if (x.packId <= y.packId) x else y
    }

    /**
     * Két napló egyesítése.
     *
     * A sor AZONOSSÁGA a `packId` + `startedAt` pár. Egyszerre egy menet fut az
     * egész fiókban, tehát ez a pár egyértelmű — és pont ezért fésülődik össze
     * helyesen az a gyakori eset, amikor UGYANAZT a menetet két eszköz is
     * lezárja: a telefon próbatétellel, a gép meg később, a szinkronból véve
     * észre. Enélkül minden ilyen menet kettőnek számítana.
     *
     * Ütközésnél a KORÁBBI vég nyer, mert az van közelebb a valósághoz.
     * Azonos végnél a próbatételes leállítás — azt az egyik oldal láthatta,
     * a másik nem.
     */
    fun mergeLog(
        a: List<Focus.FocusLogEntry>,
        b: List<Focus.FocusLogEntry>,
    ): List<Focus.FocusLogEntry> {
        val byKey = LinkedHashMap<String, Focus.FocusLogEntry>()
        for (e in a + b) {
            val key = "${e.packId}|${e.startedAt}"
            val prev = byKey[key]
            byKey[key] = if (prev == null) e else better(prev, e)
        }
        return capLog(byKey.values.toList())
    }

    /**
     * Két változat UGYANARRÓL a menetről — melyik marad.
     *
     * TELJES rendezés kell: ha a végén marad döntetlen, a válasz a hívás
     * sorrendjétől függ, az pedig a két eszközön más. Onnantól ugyanazt a
     * menetet másképp sorosítják, a `same` örökre „különbözőt” mond, és minden
     * körben feltöltenek — nem hibás adat, hanem NEM KONVERGÁLÓ szinkron.
     *
     * A tervezett vég is holtverseny lehet: az egyik eszköz még a hosszabbítás
     * előtti tervet ismerte. Ilyenkor a KÉSŐBBI terv marad.
     */
    private fun better(x: Focus.FocusLogEntry, y: Focus.FocusLogEntry): Focus.FocusLogEntry {
        if (x.endedAt != y.endedAt) return if (x.endedAt < y.endedAt) x else y
        if (x.stopped != y.stopped) return if (x.stopped) x else y
        if (x.plannedEndsAt != y.plannedEndsAt) {
            return if (x.plannedEndsAt > y.plannedEndsAt) x else y
        }
        return x
    }

    /**
     * Idősorrend, és a LEGÚJABBAK maradnak.
     *
     * A statisztika a mai napot és a hetet nézi; ha valamit el kell dobni, az a
     * legrégebbi sor. Fordítva a mai menetek esnének ki, és pont az a képernyő
     * lenne üres, amit a felhasználó néz.
     */
    fun capLog(rows: List<Focus.FocusLogEntry>): List<Focus.FocusLogEntry> =
        // A `startedAt` a HARMADIK kulcs, és nem díszítés: a `packId` +
        // `startedAt` pár egyedi, tehát ettől lesz a rendezés TELJES. Enélkül a
        // döntetlen sorok sorrendje a bemenettől függne — az meg a két eszközön
        // más, és a szinkron sosem konvergálna.
        rows.sortedWith(compareBy({ it.endedAt }, { it.packId }, { it.startedAt }))
            .takeLast(Focus.MAX_FOCUS_LOG)

    /**
     * A futó menet megtisztítása: ha a csomagja nincs meg, eldobjuk.
     *
     * Nem tippelünk. A fehérlista TARTALMA nem az a dolog, amit kitalálni
     * szabad: egy futás ismeretlen csomaggal azt jelentené, hogy tiltunk
     * mindent, és nem tudjuk megmondani, mi az a valami, ami mehet.
     */
    fun cleanRun(run: Focus.FocusRun?, packs: List<Focus.FocusPack>): Focus.FocusRun? {
        if (run == null || run.endsAt <= 0) return null
        return if (packs.any { it.id == run.packId }) run else null
    }

    /** Ugyanaz-e a két állapot (nincs mit feltölteni). */
    fun same(a: SyncFocus, b: SyncFocus): Boolean =
        stable(a) == stable(b)

    private fun stable(f: SyncFocus): String {
        val packs = f.packs.sortedBy { it.id }.joinToString("|") { p ->
            listOf(
                p.id, p.name,
                p.allowSites.sorted().joinToString(","),
                p.allowApps.sorted().joinToString(","),
                p.defaultMinutes.toString(),
                Focus.recurrenceKey(p.recurrence),
            ).joinToString(";")
        }
        val run = f.run?.let { "${it.packId};${it.startedAt};${it.endsAt}" } ?: "-"
        // A NAPLÓ IS BENNE VAN — enélkül egy itt lezárult menet sosem érne fel
        // a kiszolgálóra: a kör azt látná, hogy „nincs mit feltölteni”.
        val log = f.log.joinToString("|") {
            "${it.packId};${it.startedAt};${it.endedAt};${it.plannedEndsAt};${it.stopped}"
        }
        // A jelek is: ha csak ők különböznek, akkor is fel kell menniük.
        val marks = (f.packMarks ?: emptyMap()).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
        return "$packs//$run//$log//$marks//${f.rev}"
    }

    /**
     * AZ ÜRESSÉG NEM SZERKESZTÉS.
     *
     * Egy eszköz, ami még sosem látott munkamenetet, ne lépjen 1-es
     * számlálóra pusztán attól, hogy először számolunk neki lenyomatot. Ha
     * léptetne, a következő történne, és ez NEM elméleti: a telefon először
     * szinkronizál, a semmiből 1-es számlálót kap, az ideje pedig frissebb,
     * mint a gépé — így az „utolsó író nyer” szabály szerint az ÜRES listája
     * nyerne, és csendben letörölné a gépen felvett összes csomagot.
     */
    fun isEmpty(f: SyncFocus): Boolean = f.packs.isEmpty() && f.run == null
}
