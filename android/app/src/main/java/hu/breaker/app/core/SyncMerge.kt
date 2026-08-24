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
        val alias: String? = null,
        val rev: Int = 1,
        val updatedAt: Long = 0,
        val updatedBy: String = "",
    )

    // --------------------------------------------------------- szigorúság

    /**
     * Hány percet tilt a menetrend egy héten (0..10080).
     *
     * SZERKEZET szerint néz, nem időbélyeg szerint. Ez nem szőrözés: két eszköz
     * lehet más időzónában, és akkor ugyanaz a két menetrend máshogy hasonlítana
     * össze a két gépen — a szinkron sosem konvergálna. A sávok amúgy is
     * helyi-óra percekben vannak megadva.
     */
    fun blockedMinutesPerWeek(s: ScheduleLogic.Schedule?): Int {
        val sch = ScheduleLogic.normalize(s)
        if (sch.mode == ScheduleLogic.Mode.ALWAYS) return 7 * 1440
        var n = 0
        for (day in 0 until 7) {
            for (minute in 0 until 1440) {
                if (blocksAtGrid(sch, day, minute)) n++
            }
        }
        return n
    }

    private fun blocksAtGrid(sch: ScheduleLogic.Schedule, day: Int, minute: Int): Boolean {
        val inBand = anyBandAtGrid(sch.bands, day, minute)
        return if (sch.mode == ScheduleLogic.Mode.SCHEDULED_BLOCK) inBand else !inBand
    }

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

    /**
     * Melyik rekord szigorúbb: -1 = `a`, 1 = `b`, 0 = egyforma.
     *
     * A mezők sorrendje számít: az első különbség dönt, és a nyertes rekord
     * EGYBEN marad. Így az eredmény mindig olyan állapot, ami tényleg létezett
     * valamelyik eszközön — nem egy összeollózott, sosem volt beállítás.
     */
    fun compareStrictness(a: SyncSite, b: SyncSite): Int {
        val aDel = a.pendingDeleteAt != null
        val bDel = b.pendingDeleteAt != null
        if (aDel != bDel) return if (aDel) 1 else -1

        val aMin = blockedMinutesPerWeek(a.schedule)
        val bMin = blockedMinutesPerWeek(b.schedule)
        if (aMin != bMin) return if (aMin > bMin) -1 else 1

        // Napi keret: kisebb = szigorúbb; a keret nélküli a leglazább.
        val aLim = a.dailyLimitSeconds ?: Long.MAX_VALUE
        val bLim = b.dailyLimitSeconds ?: Long.MAX_VALUE
        if (aLim != bLim) return if (aLim < bLim) -1 else 1

        return 0
    }

    // -------------------------------------------------------- összefésülés

    /**
     * Két azonos azonosítójú rekord összefésülése.
     *
     * Szimmetrikus: a hívónak mindegy, melyik a helyi és melyik a távoli, minden
     * eszköz ugyanazt kapja.
     */
    fun mergeSite(a: SyncSite, b: SyncSite): SyncSite {
        if (a.rev != b.rev) {
            val newer = if (a.rev > b.rev) a else b
            val older = if (a.rev > b.rev) b else a
            return carryPendingDelete(newer, older)
        }
        val strict = compareStrictness(a, b)
        if (strict != 0) {
            return if (strict < 0) carryPendingDelete(a, b) else carryPendingDelete(b, a)
        }
        if (a.updatedAt != b.updatedAt) return if (a.updatedAt > b.updatedAt) a else b
        return if (a.updatedBy <= b.updatedBy) a else b
    }

    /**
     * A törlésre várás nem tűnhet el csendben.
     *
     * Ha az egyik eszközön elindult a törlés (végigcsinált próbatételek + 24
     * óra), a másik nem dobhatja el csak azért, mert a saját rekordja frissebb:
     * az a munkát törölné el. A türelmi idő megmarad, és ott is visszavonható —
     * a visszavonás szigorítás, tehát ingyen van.
     */
    private fun carryPendingDelete(winner: SyncSite, loser: SyncSite): SyncSite {
        val loserDelete = loser.pendingDeleteAt ?: return winner
        val winnerDelete = winner.pendingDeleteAt
        if (winnerDelete != null) {
            val at = minOf(winnerDelete, loserDelete)
            return if (at == winnerDelete) winner else winner.copy(pendingDeleteAt = at)
        }
        if (winner.rev > loser.rev) return winner // egy későbbi körben visszavonták
        return winner.copy(pendingDeleteAt = loserDelete)
    }

    /**
     * Két lista összefésülése.
     *
     * Ami csak az egyik oldalon van, bekerül — ez SZIGORÍTÁS, tehát ingyen van,
     * és pont ez az, amiért a szinkron kell. Egy hiányzó rekord SOSEM jelent
     * törlést: különben elég lenne egy üres fiókkal belépni, és a lista eltűnne.
     */
    fun mergeLists(local: List<SyncSite>, incoming: List<SyncSite>): List<SyncSite> {
        val byId = LinkedHashMap<String, SyncSite>()
        for (s in local) byId[s.id] = s
        for (s in incoming) {
            val mine = byId[s.id]
            byId[s.id] = if (mine == null) s else mergeSite(mine, s)
        }
        // Ugyanaz a domain kétszer, két eszközről külön felvéve: egy rekordba
        // fésüljük. Enélkül két sorban ugyanaz állna, és az egyiket feloldva a
        // felhasználó azt hinné, feloldotta.
        val byDomain = LinkedHashMap<String, SyncSite>()
        for (s in byId.values.sortedWith(SORT)) {
            val mine = byDomain[s.domain]
            if (mine == null) { byDomain[s.domain] = s; continue }
            val keep = if (mine.addedAt <= s.addedAt) mine else s
            val drop = if (keep === mine) s else mine
            byDomain[s.domain] = mergeSite(keep, drop.copy(id = keep.id)).copy(
                id = keep.id,
                addedAt = minOf(keep.addedAt, drop.addedAt),
                // A hosztneveket EGYESÍTJÜK: ha az egyik eszközön a társoldalak
                // is fel voltak véve, a másikon meg nem, az egyesítés a szigorúbb.
                hostnames = (keep.hostnames + drop.hostnames).distinct().sorted(),
            )
        }
        return byDomain.values.sortedWith(SORT)
    }

    /** Stabil sorrend: minden eszközön ugyanaz a lista, ugyanabban a sorrendben. */
    private val SORT = compareBy<SyncSite>({ it.addedAt }, { it.id })
}
