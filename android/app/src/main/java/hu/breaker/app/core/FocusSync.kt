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
        return "$packs//$run//${f.rev}"
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
