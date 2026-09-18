package hu.breaker.app.core

import java.util.Calendar

/**
 * Heti visszatekintés: hétfő reggel egy értesítés az elmúlt hét napról — a
 * `desktop/src/shared/digest.ts` tükre.
 *
 * MIÉRT. A statisztika ott van az appban — de oda be kell menni, és pont az
 * nem megy be, akinek a legtöbbet mondaná. Egy hétfő reggeli mondat viszont
 * magától jön: mennyi ment el, mire a legtöbb, hányszor ültél le dolgozni,
 * hányszor oldottál fel. Nem ítélet, hanem tükör — ugyanaz a hang, mint a
 * statisztikáé.
 *
 * A telefonon ezt a szűrő szolgáltatása mondja, ami az app nélkül is fut:
 * ez az egy hely, ahol a gépnél is jobb a helyzet — ott csak a futó app szól.
 * Egy hétről EGYSZER, eszközönként (a kulcs az állapotban marad).
 *
 * A számok a mérés és a napló GÖRDÜLŐ hét napja (az elmúlt 7 nap), nem a
 * naptári hét — pontosan az, amit a statisztika is mutat.
 *
 * Tiszta: a hívó adja az időt, a tárolt kulcsot és a címkézést (rejtett lista,
 * fedőnév) — az értesítés sem szivárogtathat ki olyan címet, amit a lista
 * elrejt.
 */
object DigestLogic {

    /** Hétfőn ettől az órától esedékes (helyi idő). A gépen ugyanez. */
    const val DIGEST_HOUR = 7

    /** A hét kulcsa: a hétfő helyi dátuma, ÉÉÉÉ-HH-NN. */
    fun weekKey(now: Long): String {
        val c = Calendar.getInstance().apply { timeInMillis = now }
        // Calendar: vasárnap = 1 … szombat = 7; a JS getDay vasárnap = 0 …
        // szombat = 6. Ugyanaz a visszalépés: hétfőn nulla, vasárnap hat.
        val jsDay = (c.get(Calendar.DAY_OF_WEEK) + 6) % 7
        c.add(Calendar.DAY_OF_MONTH, -((jsDay + 6) % 7))
        return "%04d-%02d-%02d".format(
            c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH),
        )
    }

    /**
     * Esedékes-e a visszatekintés: ezen a héten még nem volt, és hétfő reggel
     * [DIGEST_HOUR] már elmúlt. Ha igen, a hét kulcsát adja — ezt kell eltenni.
     */
    fun due(lastKey: String?, now: Long): String? {
        val key = weekKey(now)
        if (lastKey == key) return null
        val parts = key.split("-").map { it.toInt() }
        val dueAt = Calendar.getInstance().apply {
            clear()
            set(parts[0], parts[1] - 1, parts[2], DIGEST_HOUR, 0, 0)
        }.timeInMillis
        return if (now >= dueAt) key else null
    }

    /** Egy célpont a hét listájából: a felület címkéje és a másodpercek. */
    data class Top(val label: String, val seconds: Double)

    /** Ez a hét az előzőhöz képest, egy célra; null, ha nem volt előző hét. */
    data class Delta(val label: String, val deltaPct: Double?)

    data class Input(
        /** az elmúlt 7 nap mért ideje, másodpercben */
        val last7Seconds: Double,
        /** a hét legtöbb idejét vivő oldalak, a legnagyobb elöl */
        val topWeekSites: List<Top>,
        /**
         * A hét legtöbb idejét vivő appok, a legnagyobb elöl. A mért idő az
         * appokat is tartalmazza — ha a legnagyobb egy app, a mondat enélkül
         * hazudna: „7 óra; a legtöbb: youtube.com 40 perc”.
         */
        val topWeekApps: List<Top> = emptyList(),
        /** ez a hét az előzőhöz képest, célonként */
        val weekOverWeek: List<Delta>,
        /** a munkamenetek összegzése az elmúlt 7 napra */
        val focusWeek: Focus.FocusSummary,
        /** az előző hét menetei — a hét az előző héthez képest; null, ha a hívó nem adja */
        val focusPrevWeek: Focus.FocusSummary? = null,
        /** feloldások az elmúlt 7 napban */
        val unlocks7d: Int,
        /** az előző hét feloldásai — a hét az előző héthez képest; nulla, ha a hívó nem adja */
        val unlocksPrev7d: Int = 0,
        /** van-e egyáltalán mért nap */
        val daysTracked: Int,
        /**
         * Félbemaradt kísérletek az elmúlt 7 napban — feladva, lejárva,
         * lecsúszva, elszállva, újraindítva: hányszor indult el a lazítás,
         * és nem vitte végig. A tükör másik fele a feloldások mellett.
         */
        val dropped7d: Int = 0,
        /** a keret betelt napjai az elmúlt 7 napon (ezen a készüléken mérve) — dolgozik-e a keret */
        val limitFullDays: Int = 0,
        /** adag-betelések az elmúlt 7 napon, minden oldalon összesen (a könyvből) — a szabály dolgozik-e */
        val burstTripsWeek: Int = 0,
        /**
         * A szűrő megakadásai az elmúlt 7 napban — hányszor állította meg a
         * DNS-szűrő a telefont (a gépen a böngésző könyve ugyanez). A tükör
         * harmadik fele: a tiltás akkor dolgozik, amikor nem figyelsz — ez
         * mondja, mennyit.
         */
        val filterHits7d: Int = 0,
        /** az azt megelőző 7 nap — a hét az előző héthez képest; nulla, ha nem volt (vagy a könyv akkor kezdődött) */
        val filterHitsPrev7d: Int = 0,
        /** a hét csúcs-órája a szűrő megakadásaira (óra, szám) — mikor jár a kéz magától; null, ha nem volt */
        val filterHitsPeak: Pair<Int, Int>? = null,
        /** a csomag neve, amelynek heti ablaka fedi a csúcs-órát — a menet magától indul, amikor a kéz indulna; null, ha egyik sem */
        val filterHitsPeakPack: String? = null,
        /** a csúcs-órára LEHETNE ablakot tenni: van csomag ablak nélkül, és a csúcs-órát semmi nem fedi — a mondat kimondja */
        val peakWindowOffer: Boolean = false,
        /** a négy hét csúcs-napja a szűrő megakadásaira (nap 0 = vasárnap, szám) — a statisztika sora a mondatban; null, ha nem volt */
        val filterHitsWeekday: Pair<Int, Int>? = null,
        /** a négy hét menet-napja (nap 0 = vasárnap, szám) — melyik napon ülsz le a legtöbbször; null, ha nem volt */
        val focusWeekday: Pair<Int, Int>? = null,
        /** a mért idő napja (nap 0 = vasárnap, másodperc négy hét alatt) — melyik napon megy el a legtöbb idő; null, ha nem volt mérés */
        val usageWeekday: Pair<Int, Int>? = null,
        /** a négy hét menet-órája (óra, szám) — mikor ülsz le a legtöbbször, az indulás órája szerint; null, ha nem volt */
        val focusHour: Pair<Int, Int>? = null,
        /** a csomag neve, amelynek heti ablaka fedi a menet-órát — a menet magától indul, amikor le szoktál ülni; null, ha egyik sem (vagy a menet-óra a csúcs-óra) */
        val focusHourPack: String? = null,
        /** a menet-órára LEHETNE ablakot tenni: van csomag ablak nélkül, és a menet-órát semmi nem fedi — a mondat kimondja */
        val focusHourWindowOffer: Boolean = false,
        /** a hét csúcs-oldala (nyers név, a címkézés a mondaté; szám) — melyik oldal akaszt meg a legtöbbször */
        val filterHitsTop: Pair<String, Int>? = null,
        /**
         * A hét legnagyobb, NEM tiltott idővivői (a felvevő javaslata), a
         * legnagyobb elöl. Mérés nélkül üres.
         */
        val unblockedTop: List<Top> = emptyList(),
    )

    /** „2 ó 40 p” / „58 p” — mint a statisztika csempéin. */
    fun hm(seconds: Double): String {
        val total = maxOf(0L, Math.round(seconds / 60.0))
        val h = total / 60
        val m = total % 60
        return if (h > 0) "$h ó $m p" else "$m p"
    }

    /**
     * A visszatekintés szövege — vagy null, ha nincs miről beszélni (se mérés,
     * se menet, se feloldás): egy üres értesítés zaj lenne, nem tükör.
     *
     * A [labelOf] a felület címkézése: rejtett listánál sorszám, fedőnévnél a
     * fedőnév — az értesítés ugyanazt a szabályt követi, mint a statisztika.
     */
    fun text(input: Input, labelOf: (String) -> String): String? {
        val parts = mutableListOf<String>()
        val measured = input.daysTracked > 0 && input.last7Seconds > 0
        if (measured) {
            var line = "${hm(input.last7Seconds)} mért idő"
            // A trend csak öt százalék fölött mondat: alatta zaj, nem irány.
            fun trendOf(label: String): String {
                val pct = input.weekOverWeek.firstOrNull { it.label == label }?.deltaPct
                return if (pct != null && Math.abs(pct) > 5) {
                    " (${if (pct > 0) "▲ +" else "▼ "}${Math.round(pct)}% az előző héthez képest)"
                } else ""
            }
            val top = input.topWeekSites.firstOrNull()
            if (top != null && top.seconds > 0) {
                line += "; a legtöbb: ${labelOf(top.label)} ${hm(top.seconds)}${trendOf(top.label)}"
            }
            // Az app külön: a telefonon a legtöbb idő appban megy el, nem
            // oldalon — a mért időben benne van.
            val app = input.topWeekApps.firstOrNull()
            if (app != null && app.seconds > 0) {
                line += "; appban a legtöbb: ${labelOf(app.label)} ${hm(app.seconds)}${trendOf(app.label)}"
            }
            parts.add("$line.")
            // A MÉRT IDŐ NAPJA: melyik napon megy el a legtöbb idő — négy hétből, a
            // statisztika mondata szó szerint. Csak mérés mellett; nap nélkül nincs.
            input.usageWeekday?.let { parts.add(UsageLogic.weekdayText(it)) }
        }
        val f = input.focusWeek
        val p = input.focusPrevWeek
        // Az előző hét a menetek mellett — irány, nem ítélet. Üres előző hét nem
        // összehasonlítás; a menet nélküli hét viszont mondat, ha volt mihez mérni.
        val prevFocus = if (p != null && p.sessions > 0) ", az előző héten ${p.sessions} (${hm(p.totalMs / 1000.0)})" else ""
        if (f.sessions > 0) {
            val early = if (f.stoppedEarly > 0) ", ${f.stoppedEarly} korán leállítva" else ", mind végigvive"
            // A HETI ABLAKBÓL indult menetek: dolgozik-e az ablak — csak ha volt ilyen.
            val win = if (f.windowRuns > 0) ", ${f.windowRuns} ablakból" else ""
            parts.add("${f.sessions} menet (${hm(f.totalMs / 1000.0)}$early$win)$prevFocus.")
        } else if (prevFocus.isNotEmpty()) {
            parts.add("Menet nélkül$prevFocus.")
        }
        // A MENET-NAP: melyik napon ülsz le a legtöbbször — négy hétből, a statisztika
        // mondata szó szerint; a csúcs-nap tükre. Nincs nap, nincs mondat.
        input.focusWeekday?.let { parts.add(Focus.weekdayText(it)) }
        // A MENET-ÓRA: mikor ülsz le a legtöbbször — négy hétből, az indulás órája
        // szerint, a statisztika mondata szó szerint. Nincs menet, nincs mondat.
        input.focusHour?.let { parts.add(Focus.hourText(it, input.focusHourPack, input.focusHourWindowOffer)) }
        // A félbemaradt kísérlet a feloldások mellé kerül — vagy helyettük: egy
        // elindított és félbehagyott lazítás is történés, ha feloldás nem is lett.
        val droppedPart = if (input.dropped7d > 0) ", ${input.dropped7d} félbemaradt kísérlet" else ""
        // Az előző hét feloldásai a szám mellett, zárójelben — irány, nem ítélet;
        // üres előző hét nem összehasonlítás. A tükör harmadik mércéje is két hetet mond.
        val prevUnlPart = if (input.unlocksPrev7d > 0) " (az előző héten ${input.unlocksPrev7d})" else ""
        if (input.unlocks7d > 0) parts.add("${input.unlocks7d} feloldás$prevUnlPart$droppedPart.")
        else if (input.dropped7d > 0) parts.add("Feloldás nélkül$prevUnlPart$droppedPart.")
        else if (measured || f.sessions > 0 || input.unlocksPrev7d > 0) parts.add("Feloldás nélkül$prevUnlPart.")
        // A keret betelt napjai: dolgozik-e a keret — tény, nem ítélet. Nulla nem mondat.
        if (input.limitFullDays > 0) parts.add("A napi keret ${input.limitFullDays} napon betelt.")
        // Az adag a héten: hányszor telt be — a szabály dolgozik-e. Nulla nem mondat.
        if (input.burstTripsWeek > 0) parts.add("Az adag a héten ${input.burstTripsWeek}× telt be.")
        // A megakadás: hányszor állította meg a szűrő — tény, nem ítélet.
        // Az előző hét a szám mellett, zárójelben — irány, nem ítélet. Nulla előző
        // hét nem összehasonlítás; a nulla hét viszont mondat, ha volt mihez mérni.
        val prev = if (input.filterHitsPrev7d > 0) " (az előző héten ${input.filterHitsPrev7d})" else ""
        if (input.filterHits7d > 0) {
            // A lefedett csúcs-óra a csúcs mellett, zárójelben: a menet magától indul, amikor a kéz indulna.
            // Ha nem fedi semmi, de lehetne: „nincs rá ablak” — tükör, nem ítélet; a gomb a statisztikán vár.
            val covered = input.filterHitsPeakPack?.let { " (magától indul: $it)" }
                ?: (if (input.peakWindowOffer) " (nincs rá ablak)" else "")
            val peak = input.filterHitsPeak?.let { ", a csúcs ${FilterHitLogic.hourLabel(it.first)}$covered" } ?: ""
            val top = input.filterHitsTop?.let { ", a legtöbbször: ${labelOf(it.first)} (${it.second}×)" } ?: ""
            parts.add("${input.filterHits7d} megakadás a szűrőben$prev$peak$top.")
        } else if (input.filterHitsPrev7d > 0) {
            parts.add("Megakadás nélkül a szűrőben$prev.")
        }
        // A csúcs-nap: melyik napon akad meg a kéz a legtöbbször — négy hétből, a
        // statisztika mondata szó szerint. Nincs nap, nincs mondat.
        input.filterHitsWeekday?.let { parts.add(FilterHitLogic.peakWeekdayText(it)) }
        // A tükör másik fele: ami sokat vitt, és nincs a listán. Egy név, a
        // legnagyobb — a többi a felvevő kártyán vár, egy kattintásra.
        val open = input.unblockedTop.firstOrNull()
        if (measured && open != null && open.seconds > 0) {
            parts.add("Nincs tiltva, de sokat vitt: ${labelOf(open.label)} ${hm(open.seconds)}.")
        }
        if (parts.isEmpty()) return null
        return "Elmúlt 7 nap: ${parts.joinToString(" ")}"
    }

    // ------------------------------------------------------------- NAPLÓ
    //
    // A hétfői mondat elszáll az értesítéssel; a napló megtartja. Fél év hetei
    // egy-egy sorban: a pálya látszik, nem csak a pillanat — tükör, nem
    // ítélet. Eszközönként, mint a hét kulcsa.

    /** Egy hét a naplóban: a hét kulcsa (a hétfő dátuma) és a mondat. */
    data class Entry(val week: String, val text: String)

    /** Ennyi hetet őrzünk — fél év. Több már nem tükör, hanem archívum. */
    const val MAX_DIGEST_LOG = 26

    /** A napló sora mondat, nem esszé; a mag mondata ennél jóval rövidebb. */
    private const val MAX_DIGEST_TEXT = 500
    private val WEEK_KEY = Regex("^\\d{4}-\\d{2}-\\d{2}$")

    /**
     * Egy hét mondata a naplóba: a hétnek egy sora van (az újabb felülír), a
     * lista a legfrissebbel kezdődik, a plafonnál a legrégebbi esik. Üres
     * mondat (null) nem sor — de a hét régi sorát sem hagyja ott.
     */
    fun record(log: List<Entry>, week: String, text: String?): List<Entry> {
        val kept = log.filter { it.week != week }.toMutableList()
        if (!text.isNullOrEmpty()) kept.add(Entry(week, text))
        return clean(kept)
    }

    /**
     * A tárból jött napló megtisztítva: csak a jó alakú sorok, hetenként egy
     * (az utolsó marad), a legfrissebb elöl, a plafonig.
     */
    fun clean(entries: List<Entry>): List<Entry> {
        val byWeek = LinkedHashMap<String, String>()
        for (e in entries) {
            if (!WEEK_KEY.matches(e.week)) continue
            val t = e.text.trim()
            if (t.isEmpty()) continue
            byWeek[e.week] = t.take(MAX_DIGEST_TEXT)
        }
        return byWeek.entries.map { Entry(it.key, it.value) }
            .sortedByDescending { it.week }
            .take(MAX_DIGEST_LOG)
    }

    /** A napló sorának feje: a hét kulcsa olvashatóan — „2026. 09. 07.” */
    fun weekLabel(week: String): String = week.replace("-", ". ") + "."

    /**
     * A napló sora a MOSTANI címkézéssel. Ami akkor a valódi címmel szólt, az
     * a fedőnév felvétele vagy a lista elrejtése után is a lista címkéjével
     * jelenik meg — a napló sem szivárogtathat ki olyan címet, amit a lista
     * elrejt. A cím társneveit és az aloldalait is a listázott oldal címkéje
     * fedi; ami nincs a listán, az marad, ahogy volt.
     */
    fun relabel(text: String, sites: List<Site>, labelOf: (String) -> String): String {
        var out = text
        for (site in sites) {
            val label = labelOf(site.domain)
            if (label == site.domain) continue
            for (name in listOf(site.domain) + site.hostnames) {
                if (name.isEmpty()) continue
                val re = Regex("(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\\.)*" + Regex.escape(name) + "(?![A-Za-z0-9-])")
                out = re.replace(out) { label }
            }
        }
        return out
    }

    /** A menet-óra, ha nem a csúcs-óra — a fedését csak akkor mondja a saját mondata; null, ha nincs, vagy a csúcs-óráé. */
    private fun ownFocusHour(st: AppState, now: Long): Int? =
        Focus.peakHour(Focus.byHour(st.focusLog, now))?.first
            ?.takeIf { it != FilterHitLogic.peakHour(st.filterHitHours, now)?.first }

    /**
     * A visszatekintés bemenete a mostani állapotból — a szolgáltatás (hétfő
     * reggel) és a felület (az élő mondat a statisztikán) ugyanezt kérdezi,
     * hogy a kettő ne csúszhasson szét.
     */
    fun inputFor(st: AppState, summary: UsageLogic.Summary, now: Long): Input {
        val weekAgo = now - 7 * 24 * 3600_000L
        return Input(
            last7Seconds = summary.last7Seconds,
            topWeekSites = summary.topWeekSites.map { Top(it.label, it.seconds) },
            topWeekApps = summary.topWeekApps.map { Top(it.label, it.seconds) },
            weekOverWeek = summary.weekOverWeek.map { Delta(it.label, it.deltaPct) },
            // A mért idő napja — négy hétből, a statisztika sora: a mondat is mondja.
            usageWeekday = FilterHitLogic.peakWeekday(UsageLogic.byWeekday(st.usage, now)),
            // A napló ablaka a gépével közös: a mai nap kezdete mínusz hat nap.
            focusWeek = Focus.summarizeFocus(st.focusLog, UsageLogic.startOfDay(now) - 6 * 86_400_000L, now),
            focusPrevWeek = Focus.summarizeFocusPrevWeek(st.focusLog, now),
            // A menet-nap — négy hétből, a statisztika sora: a mondat is mondja.
            focusWeekday = FilterHitLogic.peakWeekday(Focus.byWeekday(st.focusLog, now)),
            // A menet-óra — négy hétből, az indulás órája szerint: a mondat is mondja.
            focusHour = Focus.peakHour(Focus.byHour(st.focusLog, now)),
            // A menet-óra fedése: a csomag, amelynek heti ablaka fedi — a mondat mondja; ha nem fedi semmi,
            // de lehetne: „nincs rá ablak”. Ha a menet-óra a csúcs-óra, a csúcs mondata mondja — kétszer ugyanazt nem.
            focusHourPack = ownFocusHour(st, now)?.let { Focus.packCoveringHour(st.focusPacks, it)?.name },
            focusHourWindowOffer = ownFocusHour(st, now)?.let { Focus.peakWindowPick(st.focusPacks, st.focusLog, null, it, now) } != null,
            unlocks7d = st.unlockLog.count { it >= weekAgo },
            unlocksPrev7d = st.unlockLog.count { it >= weekAgo - 7 * 24 * 3600_000L && it < weekAgo },
            dropped7d = st.droppedAttempts.count { it >= weekAgo },
            limitFullDays = LimitLogic.limitFullDays(st.usage, st.sites.map { it.domain to it.dailyLimitSeconds }, now).days,
            burstTripsWeek = st.sites.sumOf { BurstLogic.tripsInDays(st.burstTripLog, it.id, UsageLogic.dayKeysBack(now, 7)) },
            filterHits7d = FilterHitLogic.hits7d(st.filterHits, now),
            filterHitsPrev7d = FilterHitLogic.hitsPrev7d(st.filterHits, now),
            filterHitsPeak = FilterHitLogic.peakHour(st.filterHitHours, now),
            filterHitsPeakPack = FilterHitLogic.peakHour(st.filterHitHours, now)?.let { Focus.packCoveringHour(st.focusPacks, it.first)?.name },
            // Lehetne-e ablakot tenni a csúcs-órára (a menet állapota itt nem számít): a mondat kimondja.
            peakWindowOffer = Focus.peakWindowPick(st.focusPacks, st.focusLog, null, FilterHitLogic.peakHour(st.filterHitHours, now)?.first, now) != null,
            filterHitsTop = FilterHitLogic.topSite(st.filterHitHosts, now),
            // A csúcs-nap — négy hétből, a statisztika sora: a mondat is mondja.
            filterHitsWeekday = FilterHitLogic.peakWeekday(FilterHitLogic.byWeekday(st.filterHits, now)),
            daysTracked = summary.daysTracked,
            unblockedTop = UsageLogic.suggestBlocks(summary.topWeekSites, st.sites)
                .map { Top(it.label, it.seconds) },
        )
    }
}
