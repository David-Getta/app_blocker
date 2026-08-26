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
        return SyncFocus(
            packs = newer.packs,
            run = mergeRun(local, incoming),
            // EGYESÍTÉS, nem választás: lásd a `log` mező magyarázatát.
            log = mergeLog(local.log, incoming.log),
            rev = maxOf(local.rev, incoming.rev),
            updatedAt = maxOf(local.updatedAt, incoming.updatedAt),
            updatedBy = newer.updatedBy,
        )
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
     * appban.
     */
    private fun mergeRun(a: SyncFocus, b: SyncFocus): Focus.FocusRun? {
        if (a.rev != b.rev) return (if (a.rev > b.rev) a else b).run
        val ar = a.run ?: return b.run
        val br = b.run ?: return ar
        return if (ar.endsAt >= br.endsAt) ar else br
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

    private fun better(x: Focus.FocusLogEntry, y: Focus.FocusLogEntry): Focus.FocusLogEntry {
        if (x.endedAt != y.endedAt) return if (x.endedAt < y.endedAt) x else y
        if (x.stopped != y.stopped) return if (x.stopped) x else y
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
        rows.sortedWith(compareBy({ it.endedAt }, { it.packId })).takeLast(Focus.MAX_FOCUS_LOG)

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
            ).joinToString(";")
        }
        val run = f.run?.let { "${it.packId};${it.startedAt};${it.endsAt}" } ?: "-"
        // A NAPLÓ IS BENNE VAN — enélkül egy itt lezárult menet sosem érne fel
        // a kiszolgálóra: a kör azt látná, hogy „nincs mit feltölteni”.
        val log = f.log.joinToString("|") {
            "${it.packId};${it.startedAt};${it.endedAt};${it.plannedEndsAt};${it.stopped}"
        }
        return "$packs//$run//$log//${f.rev}"
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
