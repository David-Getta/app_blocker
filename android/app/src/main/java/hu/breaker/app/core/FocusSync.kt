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
         * jel nélkül az újabb blob. A telefon jelet csak a saját csomag-
         * szerkesztésénél ír (SyncRevisions.bumpFocus). Lásd `mergePacks`.
         */
        val packMarks: Map<String, Int>? = null,
        /**
         * A csomagok KIFIZETETT ABLAK-LAZÍTÁSAI: azonosító → hányszor szűkítették
         * vagy vették le a heti ablakát próbatétellel. A gép bírója írja, a
         * teljesítéskor; a telefon hordozza és fésüli. A törölt csomagé is
         * marad. Lásd `mergePacks`.
         */
        val packLoosens: Map<String, Int>? = null,
        /**
         * A csomagok SAJÁT JELE: a győztes osztály saját legnagyobb jele — csak
         * ahol KISEBB a közös jelnél. Az osztályon belül ez dönt, nem a felhúzott
         * közös jel. A helyi szerkesztés törli. Lásd `mergePacks`.
         */
        val packOwnMarks: Map<String, Int>? = null,
        /**
         * A ZÁRLAT, ha van. A `rev`-hez SEMMI köze: a fésülése tiszta
         * magasvízjel, a későbbi vég nyer. A zárlat csak szigorítani tud,
         * tehát nem kell megvédeni attól, hogy régebbi rekord írja felül —
         * visszafelé úgysem tud lépni. Lásd core/Lockdown.kt.
         */
        val lockdown: LockdownLogic.Lockdown? = null,
        /**
         * A ZÁRLAT-ABLAKOK: beállítás, mint a csomagok — de a levétele
         * próbatétel, tehát nem az újabb blob dönt róla, hanem a TARTALMANKÉNTI
         * jelek. Üresen nincs mező a dróton. Lásd `LockdownLogic.mergeWindowSets`.
         */
        val lockdownWindows: List<LockdownLogic.LockdownWindow> = emptyList(),
        /** Az ablak-lista egészének jele — csak a régi klienseknek utazik. Null = nincs. */
        val lockdownWindowsRev: Int? = null,
        /** Az ablak-jelek: tartalmi kulcs → a blob rev-je, amelyik az ilyen ablakot utoljára felvette vagy levette. */
        val lockdownWindowMarks: Map<String, Int>? = null,
        /**
         * PÁRBAN ZÁROLÁS: a FŐ megbízott lenyomata és a jele. A fésülés NEM a
         * jel szerint megy, hanem azonosság szerint (`PartnerLogic.mergePartners`):
         * élő megbízottat csak a nyoma visz el. A jelet a régi kliensek miatt
         * hordjuk tovább. Null = nincs.
         */
        val partner: PartnerLogic.PartnerLock? = null,
        val partnerRev: Int? = null,
        /** A fő mellett élő TÁRS-megbízottak — a lazítás végén mindegyik jelmondata kell. */
        val partnerCo: List<PartnerLogic.PartnerLock> = emptyList(),
        /** A levett megbízottak nyoma: csak a jelmondatos levételből születik. */
        val partnersGone: List<PartnerLogic.PartnerGone> = emptyList(),
        /**
         * A LISTA REJTÉSE: fiók-szintű beállítás, a JELÉVEL. A bekapcsolás egy
         * koppintás (szigorítás), a kikapcsolás a készülék azonosítása (munka)
         * — és a kifizetett kikapcsolás átmegy: a jel dönt, azonos jelnél a
         * rejtett. Csak igazként utazik; a régi kliens (mező nélkül) semleges.
         */
        val hideSiteList: Boolean = false,
        val hideSiteListRev: Int? = null,
        /**
         * KULCSSZÓ-SZABÁLYOK: a lista, és KULCSSZAVANKÉNT a jelük (kulcsszó → a
         * blob rev-je, amelyik utoljára felvette vagy levette). A fésülés
         * kulcsszavanként megy — lásd `KeywordLogic.mergeKeywordSets`; a lista
         * egészének jele csak a régi klienseknek utazik. Üresen nincs mező.
         */
        val keywords: List<String> = emptyList(),
        val keywordsRev: Int? = null,
        val keywordMarks: Map<String, Int>? = null,
    )

    /**
     * Két állapot összefésülése.
     *
     * A csomagok és a futás KÜLÖN dőlnek el, mert más a szabályuk: a
     * csomagoknál az utolsó író nyer (ez beállítás — egy régi lista
     * visszatérése bosszantó, de nem kibúvó), a futásnál a szigorúbb, és
     * lazítani csak a nyomával lehet: a rövidítés számlálójával, a leállítás
     * naplósorával. A `now` a jövőbeli naplósorokhoz kell: ami a jövőben ért
     * véget, az nem zár le menetet; nélküle minden sor múltbeli. A
     * focus-merge.ts `mergeFocus` tükre.
     */
    fun merge(local: SyncFocus, incoming: SyncFocus, now: Long? = null): SyncFocus {
        val newer = pickNewer(local, incoming)
        val older = if (newer === local) incoming else local
        // A megbízottak AZONOSSÁG szerint: élő megbízottat csak a nyoma visz el,
        // két különböző élő közül egyik sem esik ki (`PartnerLogic.mergePartners`).
        val partners = PartnerLogic.mergePartners(partnerSetOf(local), partnerSetOf(incoming))
        // Az ablakok TARTALMANKÉNT, a jelük szerint (`LockdownLogic.mergeWindowSets`).
        val windows = LockdownLogic.mergeWindowSets(
            LockdownLogic.WindowSet(local.lockdownWindows, local.lockdownWindowMarks),
            LockdownLogic.WindowSet(incoming.lockdownWindows, incoming.lockdownWindowMarks),
        )
        // A kulcsszavak KULCSSZAVANKÉNT, a jelük szerint (`KeywordLogic.mergeKeywordSets`).
        val kw = KeywordLogic.mergeKeywordSets(
            KeywordLogic.KeywordSet(local.keywords, local.keywordMarks),
            KeywordLogic.KeywordSet(incoming.keywords, incoming.keywordMarks),
        )
        // EGYESÍTÉS, nem választás: lásd a `log` mező magyarázatát. ELŐBB a
        // napló: a menet sorsát ez dönti el (a leállítás nyoma a naplósor).
        val log = mergeLog(local.log, incoming.log)
        val (run, carriers) = mergeRun(local, incoming, log, now)
        val pm = mergePacks(newer, older, run?.packId, carriers)
        return SyncFocus(
            packs = pm.packs,
            run = run,
            log = log,
            rev = maxOf(local.rev, incoming.rev),
            // Az idő a GYŐZTESÉ, nem a nagyobb: az eredmény kulcsa így az újabb
            // blobé, és három eszköz bármilyen sorrendben ugyanoda jut.
            updatedAt = newer.updatedAt,
            updatedBy = newer.updatedBy,
            packMarks = pm.packMarks,
            packLoosens = pm.packLoosens,
            packOwnMarks = pm.packOwnMarks,
            // MAGASVÍZJEL, nem döntés: a későbbi vég nyer, rev-re való
            // tekintet nélkül. Egy hálózat nélkül maradt eszköz így nem tud
            // feloldani semmit azzal, hogy a régi állapotát tolja fel.
            lockdown = LockdownLogic.merge(local.lockdown, incoming.lockdown),
            // TARTALMANKÉNT a jel dönt (fent), nem az újabb blob; a lista
            // egészének jele csak a régi klienseknek utazik tovább.
            lockdownWindows = windows.windows,
            lockdownWindowsRev = maxOf(local.lockdownWindowsRev ?: 0, incoming.lockdownWindowsRev ?: 0)
                .takeIf { it > 0 },
            lockdownWindowMarks = windows.marks,
            // A megbízott NEM a jel szerint: azonosság szerint (fent). A jel a
            // régi klienseknek utazik tovább, a nagyobbik.
            partner = partners.partner,
            partnerRev = maxOf(local.partnerRev ?: 0, incoming.partnerRev ?: 0).takeIf { it > 0 },
            partnerCo = partners.partnerCo,
            partnersGone = partners.partnersGone,
            // A kulcsszavak kulcsszavanként (fent); a lista egészének jele csak a
            // régi klienseknek utazik tovább, a nagyobbik.
            keywords = kw.keywords,
            keywordsRev = maxOf(local.keywordsRev ?: 0, incoming.keywordsRev ?: 0).takeIf { it > 0 },
            keywordMarks = kw.keywordMarks,
            // A rejtés ugyanígy: a jel dönt, azonos jelnél a rejtett — a szigorúbb irány.
            hideSiteList = mergeHide(
                local.hideSiteListRev ?: 0, local.hideSiteList, incoming.hideSiteListRev ?: 0, incoming.hideSiteList,
            ),
            hideSiteListRev = maxOf(local.hideSiteListRev ?: 0, incoming.hideSiteListRev ?: 0).takeIf { it > 0 },
        )
    }

    /** A blob megbízottjai a fésülés alakjában. */
    fun partnerSetOf(f: SyncFocus): PartnerLogic.PartnerSet =
        PartnerLogic.PartnerSet(f.partner, f.partnerCo, f.partnersGone)

    /**
     * A REJTÉS fésülése — a `shared/sync/focus-merge.ts` `mergeHide` tükre: a
     * nagyobb jel nyer (a kikapcsolás munkába került, tehát átmegy); azonos
     * jelnél a rejtett — ha bárhol rejtve van, mindenhol az.
     */
    fun mergeHide(localRev: Int, local: Boolean, incomingRev: Int, incoming: Boolean): Boolean = when {
        incomingRev > localRev -> incoming
        localRev > incomingRev -> local
        else -> local || incoming
    }

    /** A csomagok fésülésének eredménye: a lista és a három jel-térkép. */
    private data class PackMerge(
        val packs: List<Focus.FocusPack>,
        val packMarks: Map<String, Int>?,
        val packLoosens: Map<String, Int>?,
        val packOwnMarks: Map<String, Int>?,
    )

    /**
     * A csomagok CSOMAGONKÉNT fésülődnek — a focus-merge.ts `mergePacks` tükre.
     *
     * Előbb az OSZTÁLY dönt, egészében: a kifizetett ablak-lazítások száma (a
     * több nyer — a változat vagy a törlése), egyenlő számnál az ABLAKOS
     * változat (ablakot felvenni ingyen van, levenni csak próbatétellel — az
     * pedig a számláló). Az osztályon belül két ablakos változat mezőnként a
     * szigorúbb (`stricterPack`), két ablak nélküli a jel szerint: a nagyobb
     * jelnél álló állapot (ez a változat, vagy nincs) marad; egyenlő jelnél (a
     * jel nélküli csomag is ilyen) az újabb blob állapota, ahogy eddig.
     *
     * A jel az osztályon belül a SAJÁT jel: a győztes osztály saját legnagyobb
     * jele. A közös jel (`packMarks`) a nagyobb marad — a régi kliens csak azt
     * látja —, de egy osztály-döntés vesztesének nagyobb jele különben a
     * győztesre ragadna, és három eszköznél a sorrendtől függne, melyik
     * változat marad. A sorrend az újabb blobé, a csak a régebbin élő csomagok
     * a végére. A telefon jelet csak a saját csomag-szerkesztésénél ír.
     */
    private fun mergePacks(
        newer: SyncFocus, older: SyncFocus, runPackId: String?, carriers: List<SyncFocus>,
    ): PackMerge {
        val en = newer.packMarks ?: emptyMap()
        val eo = older.packMarks ?: emptyMap()
        val ln = newer.packLoosens ?: emptyMap()
        val lo = older.packLoosens ?: emptyMap()
        val sn = newer.packOwnMarks ?: emptyMap()
        val so = older.packOwnMarks ?: emptyMap()
        // A MENET CSOMAGJA ELÖL: a 30-as plafon vágásából sem eshet ki.
        val ids = LinkedHashSet<String>()
        if (runPackId != null) ids.add(runPackId)
        newer.packs.forEach { ids.add(it.id) }
        older.packs.forEach { ids.add(it.id) }
        ids.addAll(en.keys); ids.addAll(eo.keys); ids.addAll(ln.keys); ids.addAll(lo.keys)
        val chosen = ArrayList<Pair<Focus.FocusPack, Boolean>>()
        val marks = LinkedHashMap<String, Int>()
        val loosens = LinkedHashMap<String, Int>()
        val owns = LinkedHashMap<String, Int>()
        for (id in ids) {
            val mn = en[id] ?: 0
            val mo = eo[id] ?: 0
            val cn = ln[id] ?: 0
            val co = lo[id] ?: 0
            // A saját jel alapból a közös: csak ott van külön szám, ahol kisebb.
            val tn = sn[id] ?: mn
            val to = so[id] ?: mo
            val pn = newer.packs.firstOrNull { it.id == id }
            val po = older.packs.firstOrNull { it.id == id }
            val wn = if (pn?.recurrence != null) 1 else 0
            val wo = if (po?.recurrence != null) 1 else 0
            var pick: Focus.FocusPack?
            val own: Int
            if (cn != co || wn != wo) {
                // AZ OSZTÁLY dönt, egészében — a változat a saját jelével megy tovább.
                val newerWins = if (cn != co) cn > co else wn > wo
                pick = if (newerWins) pn else po
                own = if (newerWins) tn else to
            } else if (pn != null && po != null && wn == 1) {
                pick = stricterPack(pn, po, tn, to)
                own = maxOf(tn, to)
            } else {
                // Ablak nélkül a saját jel dönt. Egyenlő POZITÍV jelnél (vagy
                // kifizetett lazítás után) a jelenlét nyer, két változat közül a
                // `preferPack`; jel nélkül, az alsó osztályban, az újabb blob.
                own = maxOf(tn, to)
                pick = when {
                    tn != to -> if (tn > to) pn else po
                    tn > 0 || cn > 0 -> if (pn != null && po != null) preferPack(pn, po) else pn ?: po
                    else -> pn
                }
            }
            if (id == runPackId) pick = runPack(id, pick, carriers, pn, po)
            val m = maxOf(mn, mo)
            val c = maxOf(cn, co)
            if (pick != null) chosen.add(pick to (id == runPackId || m > 0 || c > 0))
            if (m > 0) marks[id] = m
            if (c > 0) loosens[id] = c
            if (own < m) owns[id] = own
        }
        val packs = capPacks(chosen)
        // Ugyanaz a plafon, mint a bemeneten — különben a három hely három
        // listát tartana, és sosem érnének össze. A saját jel a vágott jelekhez
        // igazodik.
        val presentIds = packs.map { it.id }
        val packMarks = capPackMarks(marks, presentIds)
        return PackMerge(packs, packMarks, capPackMarks(loosens, presentIds), cleanOwnMarks(owns, packMarks))
    }

    /**
     * Két ABLAKOS változat, azonos kifizetett-számmal: a SZIGORÚBB, mezőnként
     * — a focus-merge.ts `stricterPack` tükre. Az ablak a hosszabb (több heti
     * perc, holtversenyben a kulcs), a fehérlista a metszet, a név és a hossz a
     * nagyobb saját jelű változaté, egyenlő jelnél a kettő kódegység-sorrendje.
     */
    private fun stricterPack(pn: Focus.FocusPack, po: Focus.FocusPack, tn: Int, to: Int): Focus.FocusPack {
        val named = if (tn != to) (if (tn > to) pn else po) else (if (nameKey(pn) <= nameKey(po)) pn else po)
        return named.copy(
            allowSites = meetAllow(pn.allowSites, po.allowSites),
            allowApps = meetAllow(pn.allowApps, po.allowApps),
            recurrence = longerBand(pn.recurrence!!, po.recurrence!!),
        )
    }

    /** A név és a hossz sorrendje a döntetlenhez — bájtra ugyanez a három nyelvben. */
    private fun nameKey(p: Focus.FocusPack): String = p.name + "\u0001" + p.defaultMinutes

    /**
     * Két fehérlista szigorúbbja: a METSZET, rendezve; ha mindkettő engedett
     * valamit, de közös elemük nincs, a rövidebb (holtversenyben a rendezett
     * kulcs) — a focus-merge.ts `meetAllow` tükre.
     */
    private fun meetAllow(a: List<String>, b: List<String>): List<String> {
        val common = a.filter { it in b }.sorted()
        if (common.isNotEmpty() || a.isEmpty() || b.isEmpty()) return common
        val sa = a.sorted()
        val sb = b.sorted()
        if (sa.size != sb.size) return if (sa.size < sb.size) sa else sb
        return if (sa.joinToString("\u0001") <= sb.joinToString("\u0001")) sa else sb
    }

    /** Két heti ablak szigorúbbja: a hosszabb (heti percben), holtversenyben a kulcs. */
    private fun longerBand(a: ScheduleLogic.Band, b: ScheduleLogic.Band): ScheduleLogic.Band {
        val wa = a.days.size * Focus.bandMinutes(a)
        val wb = b.days.size * Focus.bandMinutes(b)
        if (wa != wb) return if (wa > wb) a else b
        return if (bandKey(a) <= bandKey(b)) a else b
    }

    private fun bandKey(b: ScheduleLogic.Band): String =
        b.days.sorted().joinToString(",") + "/" + b.startMin + "/" + b.endMin

    /**
     * A csomagok plafonja (30): a JELES csomag (és a menet csomagja) marad, a
     * jel nélküli esik ki előbb; a sorrend a fésülésé. A focus-merge.ts
     * `capPacks` tükre.
     */
    private fun capPacks(chosen: List<Pair<Focus.FocusPack, Boolean>>): List<Focus.FocusPack> {
        if (chosen.size <= MAX_PACKS) return chosen.map { it.first }
        val keep = LinkedHashSet<Focus.FocusPack>()
        for ((p, marked) in chosen) if (marked && keep.size < MAX_PACKS) keep.add(p)
        for ((p, marked) in chosen) if (!marked && keep.size < MAX_PACKS) keep.add(p)
        return chosen.filter { it.first in keep }.map { it.first }
    }

    /**
     * A FUTÓ MENET CSOMAGJA: mindig marad, és a fehérlistája nem bővülhet — a
     * focus-merge.ts `runPack` tükre. A mezői a jelek szerinti győztesé; ha a
     * jelek szerint törölni kellene, a menetet hordozó blob változata áll (a
     * törlés így megsemmisül, nem halasztódik — kimondott ár), AZ ABLAKA
     * NÉLKÜL: ablakos változattal szemben törlés csak magasabb osztályból
     * nyerhet, tehát a levétele ki volt fizetve; a
     * fehérlistája csak az, ami a menetet hordozó változat(ok)ban IS benne
     * van (metszet). A menetről már nem a `rev` dönt, tehát a csomagját sem
     * védheti — egy felhúzott jelű törlés vagy bővítés különben ingyen vinné el
     * vagy nyitná meg a futó menetet.
     */
    private fun runPack(
        id: String, pick: Focus.FocusPack?, carriers: List<SyncFocus>,
        pn: Focus.FocusPack?, po: Focus.FocusPack?,
    ): Focus.FocusPack? {
        val held = carriers.mapNotNull { f -> f.packs.firstOrNull { it.id == id } }
        val base = pick ?: (held.firstOrNull() ?: pn ?: po)?.copy(recurrence = null)
        if (base == null || held.isEmpty()) return base
        return base.copy(
            allowSites = base.allowSites.filter { x -> held.all { x in it.allowSites } },
            allowApps = base.allowApps.filter { x -> held.all { x in it.allowApps } },
        )
    }

    /**
     * Ennél több csomag-jelet nem hordunk egy blobban. Szándékosan magas: egy
     * eldobott sírkő feltámaszthatja a csomagot a másik eszközön, tehát a
     * vágás nem lehet mindennapos — 256 jel több mint kétszáz valaha törölt
     * csomag, a lista maga 30-as.
     */
    const val MAX_PACK_MARKS = 256

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
     * A saját jelek kiegyenesítése — a focus-merge.ts `cleanOwnMarks` tükre:
     * azonosító → nemnegatív egész, KISEBB a csomag közös jelénél. Ami nem
     * kisebb, az nem hordoz hírt, és közös jel nélkül saját jel sincs. Üresen null.
     */
    fun cleanOwnMarks(raw: Map<String, Int>?, marks: Map<String, Int>?): Map<String, Int>? {
        if (raw == null || marks == null) return null
        val out = LinkedHashMap<String, Int>()
        for ((k, v) in raw) {
            val m = marks[k] ?: continue
            if (v in 0 until m) out[k] = v
        }
        return out.ifEmpty { null }
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
        if (a.updatedBy != b.updatedBy) return if (a.updatedBy > b.updatedBy) a else b
        // AZONOS KULCS, más tartalom: egy fésülés után minden eszköz a győztes
        // kulcsát veszi át, a tartalma viszont a saját fésülése. Ha az első
        // argumentum nyerne, két eszköz örökké egymást írná felül. A TARTALOM
        // dönt, ugyanazzal a kulccsal mindhárom nyelvben.
        return if (contentKey(a) <= contentKey(b)) a else b
    }

    /** A blob tartalmának kulcsa a döntetlenhez — bájtra ugyanez a három nyelvben. */
    private fun contentKey(f: SyncFocus): String {
        val packs = f.packs.sortedBy { it.id }.joinToString("\u0002") { it.id + "\u0001" + packOrderKey(it) }
        // A rövidítés és az eredeti kezdés csak ha van: a nélkülük lévő menet
        // kulcsa ugyanaz, mint a frissítés előtt — a focus-merge.ts tükre.
        val run = f.run?.let {
            "${it.packId}/${it.startedAt}/${it.endsAt}" +
                (if (it.cuts > 0) "/c${it.cuts}" else "") + (it.origin?.let { o -> "/o$o" } ?: "")
        } ?: "-"
        val marks = (f.packMarks ?: emptyMap()).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
        // A kifizetett ablak-lazítások és a saját jelek csak ha vannak: a
        // nélkülük lévő blob kulcsa ugyanaz, mint a frissítés előtt.
        val loosens = (f.packLoosens ?: emptyMap()).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
        val owns = (f.packOwnMarks ?: emptyMap()).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
        return "$packs\u0003$run\u0003$marks" + (if (loosens.isNotEmpty()) "\u0003$loosens" else "") +
            (if (owns.isNotEmpty()) "\u0004$owns" else "")
    }

    /**
     * A FUTÓ munkamenet összefésülése — a kockázatos fele. A focus-merge.ts
     * `mergeRun` tükre.
     *
     * NEM a blob `rev`-je dönt: azt egy átnevezés is lépteti, ingyen, és egy
     * régi, „nem fut” állapot nagy rev-vel feltöltve próbatétel nélkül
     * leállította a menetet. A szabály a menet AZONOSSÁGÁN áll (csomag +
     * eredeti kezdés), és azon, amit a változat tud:
     *
     *   - menetet csak a rá hivatkozó NAPLÓSOR zár le (`endedInLog`); a
     *     jövőben véget ért sor nem számít;
     *   - két változat ugyanarról a menetről: a több rövidítés, azonos számnál
     *     a hosszabb, azonos hossznál a később végződő;
     *   - két különböző élő menet: a szigorúbb (`stricterRun`).
     *
     * A második érték a menetet HORDOZÓ blob(ok): akinél pontosan ez a változat
     * áll — a futó csomag fehérlistája ezekhez képest nem bővülhet.
     */
    private fun mergeRun(
        a: SyncFocus, b: SyncFocus, log: List<Focus.FocusLogEntry>, now: Long?,
    ): Pair<Focus.FocusRun?, List<SyncFocus>> {
        val ra = a.run?.takeIf { !endedInLog(log, it, now) }
        val rb = b.run?.takeIf { !endedInLog(log, it, now) }
        if (ra == null && rb == null) return null to emptyList()
        if (rb == null) return ra to listOf(a)
        if (ra == null) return rb to listOf(b)
        val win = if (Focus.sameRun(ra, rb)) newerVariant(ra, rb) else stricterRun(ra, rb)
        return win to listOf(a, b).filter { sameVariant(it.run!!, win) }
    }

    /**
     * Lezárta-e a menetnek EZT a változatát egy naplósor — a sírköve: ugyanerről
     * a menetről szól, nem a jövőben ért véget, és több rövidítést ismert, vagy
     * ugyanannyit, és a terve legalább ilyen hosszú volt.
     */
    private fun endedInLog(log: List<Focus.FocusLogEntry>, run: Focus.FocusRun, now: Long?): Boolean {
        val limit = if (now == null) Long.MAX_VALUE else now + Focus.FUTURE_LOG_TOLERANCE_MS
        val length = run.endsAt - run.startedAt
        return log.any { e ->
            Focus.sameRun(e, run) && e.endedAt <= limit &&
                (run.cuts < e.cuts || length <= e.plannedEndsAt - e.startedAt)
        }
    }

    /** Két változat ugyanarról a menetről: a több rövidítés, a hosszabb, végül a később végződő. */
    private fun newerVariant(x: Focus.FocusRun, y: Focus.FocusRun): Focus.FocusRun {
        if (x.cuts != y.cuts) return if (x.cuts > y.cuts) x else y
        val lx = x.endsAt - x.startedAt
        val ly = y.endsAt - y.startedAt
        if (lx != ly) return if (lx > ly) x else y
        return stricterRun(x, y)
    }

    /** Pontosan ugyanaz-e a két változat: azonosság, vég, rövidítések. */
    private fun sameVariant(x: Focus.FocusRun, y: Focus.FocusRun): Boolean =
        Focus.sameRun(x, y) && x.startedAt == y.startedAt && x.endsAt == y.endsAt && x.cuts == y.cuts

    /** A szigorúbb menet, teljes rendezéssel — döntetlen nincs. */
    private fun stricterRun(x: Focus.FocusRun, y: Focus.FocusRun): Focus.FocusRun {
        if (x.endsAt != y.endsAt) return if (x.endsAt > y.endsAt) x else y
        if (x.startedAt != y.startedAt) return if (x.startedAt < y.startedAt) x else y
        if (x.packId != y.packId) return if (x.packId < y.packId) x else y
        val ox = Focus.runOrigin(x)
        val oy = Focus.runOrigin(y)
        if (ox != oy) return if (ox < oy) x else y
        return if (x.cuts >= y.cuts) x else y
    }

    /**
     * Két napló egyesítése.
     *
     * A sor AZONOSSÁGA a csomag és a menet EREDETI kezdése (`runOrigin`: az
     * óra-ugrás eltolhatja a kezdést, a menet attól ugyanaz). Egyszerre egy
     * menet fut az egész fiókban, tehát ez a pár egyértelmű — és pont ezért fésülődik össze
     * helyesen az a gyakori eset, amikor UGYANAZT a menetet két eszköz is
     * lezárja: a telefon próbatétellel, a gép meg később, a szinkronból véve
     * észre. Enélkül minden ilyen menet kettőnek számítana.
     *
     * Ütközésnél a TÖBBET TUDÓ sor marad (`better`), azonos tudásnál a
     * KORÁBBI vég, mert az van közelebb a valósághoz. Azonos végnél a
     * próbatételes leállítás — azt az egyik oldal láthatta, a másik nem.
     */
    fun mergeLog(
        a: List<Focus.FocusLogEntry>,
        b: List<Focus.FocusLogEntry>,
    ): List<Focus.FocusLogEntry> {
        val byKey = LinkedHashMap<String, Focus.FocusLogEntry>()
        for (e in a + b) {
            val key = "${e.packId}|${Focus.runOrigin(e)}"
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
     * ELŐBB A TUDÁS, aztán a vég — a focus-merge.ts `better` tükre: a több
     * rövidítést ismerő, aztán a hosszabb tervet ismerő; azonos tudásnál a
     * korábbi vég, aztán a próbatételes leállítás; a maradék csak a teljes
     * rendezésért (a korábbi kezdés, az ablak jele, a csomag neve
     * kódegységenként). A terv HOSSZA számít, nem a vége: az óra-ugrás a
     * kezdést és a véget együtt tolja.
     */
    private fun better(x: Focus.FocusLogEntry, y: Focus.FocusLogEntry): Focus.FocusLogEntry {
        if (x.cuts != y.cuts) return if (x.cuts > y.cuts) x else y
        val px = x.plannedEndsAt - x.startedAt
        val py = y.plannedEndsAt - y.startedAt
        if (px != py) return if (px > py) x else y
        if (x.endedAt != y.endedAt) return if (x.endedAt < y.endedAt) x else y
        if (x.stopped != y.stopped) return if (x.stopped) x else y
        if (x.startedAt != y.startedAt) return if (x.startedAt < y.startedAt) x else y
        if (x.window != y.window) return if (x.window) x else y
        if (x.packName != y.packName) return if (x.packName < y.packName) x else y
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
        // A NEGYEDIK az azonosság maradéka: az eltolt menet sora a kezdésében
        // egyezhet egy másikéval, az eredetiében nem.
        rows.sortedWith(compareBy({ it.endedAt }, { it.packId }, { it.startedAt }, { Focus.runOrigin(it) }))
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
        val run = f.run?.let { "${it.packId};${it.startedAt};${it.endsAt};${it.cuts};${Focus.runOrigin(it)}" } ?: "-"
        // A NAPLÓ IS BENNE VAN — enélkül egy itt lezárult menet sosem érne fel
        // a kiszolgálóra: a kör azt látná, hogy „nincs mit feltölteni”.
        val log = f.log.joinToString("|") {
            "${it.packId};${it.startedAt};${it.endedAt};${it.plannedEndsAt};${it.stopped};${it.cuts};${Focus.runOrigin(it)}"
        }
        // A jelek is: ha csak ők különböznek, akkor is fel kell menniük. A
        // kifizetett ablak-lazítások és a saját jelek is: egy levétel
        // számlálója vagy egy osztály-döntés nyoma nélkül a döntés nem érne át.
        val marks = (f.packMarks ?: emptyMap()).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" } +
            "~" + (f.packLoosens ?: emptyMap()).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" } +
            "~" + (f.packOwnMarks ?: emptyMap()).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
        // A ZÁRLAT IS: enélkül egy itt indított zárlat sosem érne fel a
        // kiszolgálóra — a kör azt látná, hogy nincs mit feltölteni. (A gép és
        // az iPhone kulcsában mindig benne volt; itt lemaradt, és egy csak a
        // telefonon indított zárlat tényleg nem ment fel.)
        val lock = f.lockdown?.let { "${it.startedAt};${it.until}" } ?: "-"
        // Az ablakok a jelükkel, tartalom szerint rendezve: az azonosító és a
        // sorrend nem jelentés.
        // …és a tartalmankénti jelek is: egy levétel jele nélkül a levétel sosem érne át.
        val windows = f.lockdownWindows.map { LockdownLogic.windowKey(it.band) }.sorted().joinToString("|") +
            "~" + LockdownLogic.windowMarksKey(f.lockdownWindowMarks)
        // A MEGBÍZOTT IS, a jelével: enélkül a felvétele sosem érne fel. A
        // társak és a nyomok is — egy levétel nyoma nélkül sosem érne át.
        val partner = PartnerLogic.partnerKey(f.partner) +
            "~" + f.partnerCo.joinToString(";") { PartnerLogic.partnerKey(it) } +
            "~" + f.partnersGone.joinToString(";") { "${it.id}@${it.at}" }
        // A kulcsszavak a jelükkel — tartalom szerint, rendezve; a kulcsszavankénti
        // jelek is: egy levétel jele nélkül a levétel sosem érne át.
        val keywords = KeywordLogic.keywordsKey(f.keywords) + "~" + KeywordLogic.keywordMarksKey(f.keywordMarks)
        return "$packs//$run//$log//$marks//$lock//$windows//${f.lockdownWindowsRev ?: 0}//$partner//${f.partnerRev ?: 0}" +
            "//$keywords//${f.keywordsRev ?: 0}//${if (f.hideSiteList) 1 else 0}//${f.hideSiteListRev ?: 0}//${f.rev}"
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
    fun isEmpty(f: SyncFocus): Boolean = f.packs.isEmpty() && f.run == null && f.lockdownWindows.isEmpty()
}
