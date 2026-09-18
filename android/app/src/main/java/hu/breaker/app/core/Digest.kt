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
        /** feloldások az elmúlt 7 napban */
        val unlocks7d: Int,
        /** van-e egyáltalán mért nap */
        val daysTracked: Int,
        /**
         * Félbemaradt kísérletek az elmúlt 7 napban — feladva, lejárva,
         * lecsúszva, elszállva, újraindítva: hányszor indult el a lazítás,
         * és nem vitte végig. A tükör másik fele a feloldások mellett.
         */
        val dropped7d: Int = 0,
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
        }
        val f = input.focusWeek
        if (f.sessions > 0) {
            val early = if (f.stoppedEarly > 0) ", ${f.stoppedEarly} korán leállítva" else ", mind végigvive"
            parts.add("${f.sessions} menet (${hm(f.totalMs / 1000.0)}$early).")
        }
        // A félbemaradt kísérlet a feloldások mellé kerül — vagy helyettük: egy
        // elindított és félbehagyott lazítás is történés, ha feloldás nem is lett.
        val droppedPart = if (input.dropped7d > 0) ", ${input.dropped7d} félbemaradt kísérlet" else ""
        if (input.unlocks7d > 0) parts.add("${input.unlocks7d} feloldás$droppedPart.")
        else if (input.dropped7d > 0) parts.add("Feloldás nélkül$droppedPart.")
        else if (measured || f.sessions > 0) parts.add("Feloldás nélkül.")
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
            // A napló ablaka a gépével közös: a mai nap kezdete mínusz hat nap.
            focusWeek = Focus.summarizeFocus(st.focusLog, UsageLogic.startOfDay(now) - 6 * 86_400_000L, now),
            unlocks7d = st.unlockLog.count { it >= weekAgo },
            dropped7d = st.droppedAttempts.count { it >= weekAgo },
            daysTracked = summary.daysTracked,
            unblockedTop = UsageLogic.suggestBlocks(summary.topWeekSites, st.sites)
                .map { Top(it.label, it.seconds) },
        )
    }
}
