package hu.breaker.app.ui

import androidx.compose.ui.platform.LocalContext
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hu.breaker.app.core.DigestLogic
import hu.breaker.app.core.FilterHitLogic
import hu.breaker.app.core.LimitLogic
import hu.breaker.app.core.Focus
import hu.breaker.app.core.UsageLogic

/** Validated dark-surface categorical slots (same values as the desktop charts). */
private val SERIES_1 = Color(0xFF3987E5) // time spent
private val SERIES_2 = Color(0xFFD95926) // time spent on a site that is blocked

@Composable
fun StatsSection(
    summary: UsageLogic.Summary,
    /**
     * A munkamenet-statisztika — MINDEN eszközről.
     *
     * Semmi köze a méréshez: nem az Android hozzáférés-engedélyéből jön, hanem
     * a saját naplónkból, amit a menet lezárásakor írunk. Ezért látszik akkor
     * is, ha a mérés ki van kapcsolva vagy nincs engedélye.
     */
    focusToday: Focus.FocusSummary,
    focusWeek: Focus.FocusSummary,
    /** az előző hét menetei — a hét az előző héthez képest; null, ha a hívó nem adja */
    focusPrevWeek: Focus.FocusSummary? = null,
    focusSeries: List<Pair<String, Double>>,
    focusLabel: String,
    /** az elmúlt 7 nap napi összesenje (minden célpont), a legrégebbitől — a hét alakja */
    weekSeries: List<Pair<String, Double>> = emptyList(),
    /** fókuszban töltött idő naponta az elmúlt 7 napra (a menet a végének napjára számít) */
    focusDays: List<Pair<String, Double>> = emptyList(),
    /** az elmúlt 7 nap megakadásai naponként (a szűrő könyve), a legrégebbitől */
    filterHitDays: List<Pair<String, Double>> = emptyList(),
    /** az elmúlt 30 nap megakadásai naponként — a hónap alakja; csak ha a hét előtt is volt */
    filterHitMonth: List<Pair<String, Double>> = emptyList(),
    /** a hét csúcs-órája (óra, szám) — mikor jár a kéz magától; null, ha nem volt */
    filterHitsPeak: Pair<Int, Int>? = null,
    /** az órák sávja: a hét megakadásai a nap 24 rekeszében — a csúcs-óra ebből áll; üres, ha nem volt */
    filterHitHours: List<Int> = emptyList(),
    /** a csomag, amelynek heti ablaka fedi a csúcs-órát („Nyelvtanulás (minden nap 21:00–22:00)”) — null, ha egyik sem */
    filterHitsPeakPack: String? = null,
    /** a csúcs-óra ablakának gombja („Heti ablak a csúcs-órára: Nyelvtanulás, minden nap 21:00–22:00”) — null, ha nincs gomb */
    peakWindowLabel: String? = null,
    onPeakWindow: () -> Unit = {},
    /** a négy hét csúcs-napja (0 = vasárnap; szám) — melyik napon akad meg a kéz a legtöbbször; null, ha nem volt */
    filterHitsWeekday: Pair<Int, Int>? = null,
    /** a hét csúcs-oldala (nyers név, szám) — melyik oldal akaszt meg a legtöbbször; null, ha nem volt */
    filterHitsTop: Pair<String, Int>? = null,
    filterHitsReasons: List<Pair<String, Int>> = emptyList(),
    /** a hét megakadásai kulcsszavanként (szó, szám) — melyik kulcsszó dolgozik */
    filterHitsKeywords: List<Pair<String, Int>> = emptyList(),
    /** a lista szavai, amelyek a héten nem fogtak — csak ha volt kulcsszó-megakadás */
    filterHitsIdleKeywords: List<String> = emptyList(),
    /** a hét és az előző hét megakadásai — a két szám egymás mellett, irány, nem ítélet */
    filterHits7d: Int = 0,
    filterHitsPrev7d: Int = 0,
    /** ha nem kéred, csendben marad: az értesítés a sokadik megakadásnál és a csúcs-óra előtt kikapcsolva */
    quietSuggestions: Boolean = false,
    onToggleQuiet: () -> Unit = {},
    /** a megakadások könyvének törlése — a tiéd, törölhető */
    onClearHits: () -> Unit = {},
    blockedDomains: Set<String>,
    /**
     * Amit egy célpontról ki szabad írni.
     *
     * A hívó dönti el: fedőnév, rejtett listánál sorszámozott álnév, egyébként
     * maga a cím. Itt azért függvény, mert MINDEN címke ezen megy át — a sávok,
     * a heti összevetés és a napi diagram címe is. Elég egyetlen kihagyott hely,
     * és a fedőnév meg a rejtés annyit ér, mint egy lyukas zsák.
     */
    labelOf: (String) -> String = { it },
    /**
     * Adag-betelések ma, oldalanként (domain → darabszám), a legtöbbször
     * betelt elöl. A hívó a mai kulcsra szűri; itt csak kiírjuk, a címke a
     * `labelOf`-on át megy, mint minden más.
     */
    burstTripsToday: List<Pair<String, Int>> = emptyList(),
    /** adag-betelések az elmúlt 7 napon oldalanként (domain → darab), a könyvből — a szabály dolgozik-e a héten */
    burstTripsWeek: List<Pair<String, Int>> = emptyList(),
    /** a keret betelt napjai a héten (napok, oldalanként) — ezen a készüléken mérve; null, ha nincs keret */
    limitFullDays: LimitLogic.FullDays? = null,
    hasUsageAccess: Boolean,
    /**
     * Mikor rögzítettünk utoljára mért időt, vagy `null`, ha még soha.
     *
     * A nulla önmagában néma: nem lehet megmondani belőle, hogy tényleg nem
     * használtad a telefont, vagy hogy a mérés hasalt el. Ez a sor teszi a
     * kettőt megkülönböztethetővé, anélkül hogy naplót kellene nézni hozzá.
     */
    lastSampleAt: Long?,
    /**
     * A heti napló: a visszatekintés mondatai hetenként (a legfrissebb elöl),
     * és az élő mondat — ami MOST szólna. A hívó adja, a felület címkézésével;
     * a hozzáférés-kapu FÖLÖTT áll, mert a menetek és a feloldások mérés
     * nélkül is mondat.
     */
    digestLog: List<DigestLogic.Entry> = emptyList(),
    digestNow: String? = null,
    onGrantAccess: () -> Unit,
    onToggleEnabled: () -> Unit,
    onClear: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Statisztika", style = MaterialTheme.typography.titleLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onToggleEnabled) {
                    Text(if (summary.enabled) "Mérés ki" else "Mérés be")
                }
                OutlinedButton(onClick = onClear) { Text("Törlés") }
            }
        }

        // A MUNKAMENET-STATISZTIKA ELÖL ÁLL, a hozzáférés-kapu FÖLÖTT.
        //
        // Nem a mérésből jön, hanem a saját naplónkból: a menet lezárásakor
        // írjuk, engedély nélkül is. Ha a kapu alatt lenne, egy mérés nélküli
        // telefonon az app azt mondaná, hogy nincs mit mutatni — pedig pontosan
        // tudja, hányszor ültél le dolgozni.
        FocusStatsBlock(focusToday, focusWeek, focusDays, focusPrevWeek)
        // A MEGAKADÁSOK napról napra — a szűrő könyve: ugyanaz a rajz, mint a
        // mért időé, csak darabban. Üresen nincs.
        // A NULLA HÉT is mondat, ha volt mihez mérni: az előző hét mellett a blokk marad.
        if (filterHitDays.any { it.second > 0.0 } || filterHitsPrev7d > 0) {
            StatsSectionLabel("Megakadások a szűrőben, naponta")
            WeekChart(filterHitDays, format = { "${it.toInt()} megakadás" })
            // A HÓNAP alakja is — csak ha a hét előtt is volt mit rajzolni.
            if (FilterHitLogic.monthHasOlderHits(filterHitMonth)) {
                Text("Megakadások a szűrőben, 30 nap", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Bold)
                DailyChart(filterHitMonth)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(filterHitMonth.first().first, style = MaterialTheme.typography.bodySmall)
                    Text(filterHitMonth.last().first, style = MaterialTheme.typography.bodySmall)
                }
            }
            // MIKOR jár a kéz magától: a hét csúcs-órája — tény, nem ítélet.
            filterHitsPeak?.let { (hour, count) ->
                Text(
                    "A hét csúcsa: ${FilterHitLogic.hourLabel(hour)} ($count megakadás) — akkor jár a kéz magától.",
                    style = MaterialTheme.typography.bodySmall,
                )
                // AZ ÓRÁK SÁVJA: a nap 24 rekesze a hét megakadásaival — a csúcs a
                // mondat, a sáv az alakja (mikor jár a kéz magától, és mikor nem).
                HourStrip(filterHitHours, peakHour = hour, peakCount = count)
                // LE VAN-E FEDVE: ha egy csomag heti ablaka a csúcs-órát fedi, a menet
                // magától indul, amikor a kéz indulna — a statisztika kimondja.
                filterHitsPeakPack?.let { Text("A csúcs-órában magától indul: $it.", style = MaterialTheme.typography.bodySmall) }
                // ABLAK A CSÚCS-ÓRÁRA: a gépi gomb tükre — a legutóbbi csomagra, a
                // csúcs egy órájában, minden napra. Felvenni ingyen; levenni a gépen,
                // próbatétellel — a gomb ezt nem rejti. Ha a csúcs-órát fedi valami,
                // a sor mondja, gomb nincs.
                if (filterHitsPeakPack == null && peakWindowLabel != null) {
                    Button(onClick = onPeakWindow) { Text(peakWindowLabel) }
                }
            }
            // A CSÚCS-NAP: melyik napon akad meg a kéz a legtöbbször — négy hétből; tény, nem ítélet.
            filterHitsWeekday?.let { Text(FilterHitLogic.peakWeekdayText(it), style = MaterialTheme.typography.bodySmall) }
            // MELYIK oldal akaszt meg a legtöbbször: a hét csúcs-oldala — a lista címkézésével.
            filterHitsTop?.let { (site, count) ->
                Text("A legtöbbször: ${labelOf(site)} ($count×).", style = MaterialTheme.typography.bodySmall)
            }
            // MELYIK szabály dolgozik: a hét okonként (lista, kulcsszó) — a gépi sor tükre.
            if (filterHitsReasons.isNotEmpty()) {
                Text("Ebből: ${FilterHitLogic.reasonLine(filterHitsReasons)}.", style = MaterialTheme.typography.bodySmall)
            }
            // MELYIK kulcsszó dolgozik: a hét kulcsszavanként — a gépi kártya tükre.
            if (filterHitsKeywords.isNotEmpty()) {
                Text("Kulcsszavanként: ${FilterHitLogic.keywordLine(filterHitsKeywords)}.", style = MaterialTheme.typography.bodySmall)
            }
            // A LISTA SZAVAI, amelyek a héten nem fogtak — a tükör másik fele.
            if (filterHitsIdleKeywords.isNotEmpty()) {
                Text("A héten nem fogott: ${filterHitsIdleKeywords.joinToString(", ")}.", style = MaterialTheme.typography.bodySmall)
            }
            // A HÉT AZ ELŐZŐ HÉTHEZ KÉPEST: a két szám egymás mellett — irány, nem
            // ítélet. Előző hét nélkül nincs: egy nulla nem összehasonlítás.
            FilterHitLogic.trendText(filterHits7d, filterHitsPrev7d).takeIf { it.isNotEmpty() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall)
            }
            // HA NEM KÉRED, csendben marad: az értesítés a sokadik megakadásnál és a
            // csúcs-óra előtt kikapcsolható — a kártya a lapon akkor is mondja.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Switch(checked = !quietSuggestions, onCheckedChange = { onToggleQuiet() })
                Text("Szóljon a sokadik megakadásnál és a csúcs-óra előtt", style = MaterialTheme.typography.bodySmall)
            }
            // A KÖNYV TÖRLÉSE: a megakadások könyve a tiéd — törölhető. Két
            // koppintás: az első kérdez, a második töröl.
            var clearArmed by remember { mutableStateOf(false) }
            OutlinedButton(onClick = { if (clearArmed) { onClearHits(); clearArmed = false } else clearArmed = true }) {
                Text(if (clearArmed) "Biztos? Törlés" else "A könyv törlése")
            }
        }

        // A HETI NAPLÓ. A hétfői mondat elszáll az értesítéssel; itt megmarad —
        // fél év hetei egy-egy sorban, és fölötte az, ami most szólna. Üresen
        // (se sor, se mondat) a blokk nincs — mint a többi.
        if (digestNow != null || digestLog.isNotEmpty()) {
            StatsSectionLabel("Heti napló")
            if (digestNow != null) {
                Text("Így szólna a visszatekintés most: $digestNow", style = MaterialTheme.typography.bodySmall)
                // A MONDAT MEGOSZTHATÓ, ahogy van — egy megbízottnak, egy naplóba. A
                // tükör a tiéd; hogy kinek mutatod, te döntöd el.
                val context = LocalContext.current
                OutlinedButton(onClick = {
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, digestNow)
                    runCatching { context.startActivity(Intent.createChooser(send, "A heti mondat megosztása")) }
                }) { Text("A mondat megosztása") }
            }
            for (e in digestLog) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    Text(
                        DigestLogic.weekLabel(e.week),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.outline,
                    )
                    Text(e.text, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                }
            }
        }

        Text(
            "Csak az az idő számít, amikor tényleg ott vagy: az app előtérben van, " +
                "a képernyő be van kapcsolva és nincs zárolva. Fiók nélkül semmi nem " +
                "hagyja el a készüléket; bejelentkezve a mérés és a munkamenet-napló " +
                "felkerül a saját fiókkiszolgálódra is, végponttól végpontig " +
                "titkosítva — a kiszolgáló nem látja. Telemetria sehol nincs.",
            style = MaterialTheme.typography.bodySmall,
        )

        if (!hasUsageAccess) {
            Card {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("A méréshez hozzáférés kell", fontWeight = FontWeight.Bold)
                    Text(
                        "Az Android csak külön engedéllyel árulja el, melyik app van előtérben. " +
                            "Ez rendszerbeállítás, egyszer kell megadni.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Button(onClick = onGrantAccess) { Text("Hozzáférés megadása") }
                }
            }
            return@Column
        }

        if (!summary.enabled) {
            Text("A mérés jelenleg ki van kapcsolva.", style = MaterialTheme.typography.bodySmall)
            return@Column
        }

        // Stat tiles
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            StatTile("ma", summary.todaySeconds, Modifier.weight(1f))
            StatTile("tegnap", summary.yesterdaySeconds, Modifier.weight(1f))
        }
        Text(lastSampleLine(lastSampleAt), style = MaterialTheme.typography.bodySmall)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            StatTile("utolsó 7 nap", summary.last7Seconds, Modifier.weight(1f))
            StatTile("utolsó 30 nap", summary.last30Seconds, Modifier.weight(1f))
        }

        // A HÉT NAPJAI. A csempe egy számban mondja a hetet; itt a hét ALAKJA
        // látszik — a hétvégi kiugrás, a szerdai lyuk. Ugyanaz, mint a gépen:
        // egy szín (az oszlop nem kategória), a mai nap a feliratával kiemelve,
        // szám csak a mai és a legnagyobb oszlopon. Üresen a blokk eltűnik.
        if (weekSeries.any { it.second > 0.0 }) {
            StatsSectionLabel("Az elmúlt 7 nap, naponta")
            WeekChart(weekSeries)
        }

        // A MAI NAP KÜLÖN. A csempesorban eddig is volt egy mai szám, de hogy
        // MIRE ment el, azt csak a hétnapos listából lehetett kihámozni — abban
        // viszont a hét eleje elnyomja a mát. Üresen a blokk eltűnik; hogy
        // MIÉRT nulla, azt az „utoljára mért idő” sor mondja meg.
        if (summary.topToday.isNotEmpty()) {
            StatsSectionLabel("Mire ment ma az idő")
            BarList(summary.topToday, blockedDomains, markBlocked = true, labelOf = labelOf)
        }

        // ADAG-BETELÉSEK MA — a nap történetének az a fele, amit a mérés nem
        // mutat: a szünetben töltött idő szándékosan nem könyvelődik. Nem
        // szégyenpad: azt mutatja, hogy a szabály dolgozik. Ugyanaz a sor, mint
        // a gépen; a címke a fedőnév/rejtés útján megy.
        if (burstTripsToday.isNotEmpty()) {
            Text(
                "Adag-betelések ma: " +
                    burstTripsToday.joinToString(", ") { (label, n) -> "${labelOf(label)} ${n}×" },
                style = MaterialTheme.typography.bodySmall,
            )
        }
        // AZ ADAG A HÉTEN: hányszor telt be oldalanként az elmúlt 7 napon — a
        // szabály dolgozik-e. Csak ha a hét több a mainál; különben a mai sor elég.
        if (burstTripsWeek.isNotEmpty() && burstTripsWeek.sumOf { it.second } > burstTripsToday.sumOf { it.second }) {
            Text(
                "Adag-betelések a héten: " +
                    burstTripsWeek.joinToString(", ") { (label, n) -> "${labelOf(label)} ${n}×" },
                style = MaterialTheme.typography.bodySmall,
            )
        }
        // A KERET BETELT NAPJAI: hány napon érte el a mért idő a napi keretet a
        // héten, és melyik oldalé hányszor — ezen a készüléken mérve. Tükör:
        // azt mutatja, dolgozik-e a keret. Üresen nincs sor.
        limitFullDays?.let { LimitLogic.limitFullLine(it, labelOf) }?.takeIf { it.isNotEmpty() }?.let {
            Text(it, style = MaterialTheme.typography.bodySmall)
        }

        if (summary.topWeekSites.isNotEmpty()) {
            StatsSectionLabel("Oldalak (7 nap)")
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                LegendItem(SERIES_1, "nem blokkolt")
                LegendItem(SERIES_2, "blokkolt oldal")
            }
            Text(
                "Az oldal-idő közelítés: a böngésző előtérben van és a Breaker DNS-szűrője " +
                    "ezt a domaint látta utoljára.",
                style = MaterialTheme.typography.bodySmall,
            )
            BarList(summary.topWeekSites, blockedDomains, markBlocked = true, labelOf = labelOf)
        }

        if (summary.topWeekApps.isNotEmpty()) {
            StatsSectionLabel("Alkalmazások (7 nap)")
            BarList(summary.topWeekApps, emptySet(), markBlocked = false, labelOf = labelOf)
        }

        if (focusSeries.isNotEmpty()) {
            Text(
                if (focusLabel.isEmpty()) "Napi bontás (30 nap)"
                else "Napi bontás — ${labelOf(focusLabel)} (30 nap)",
                fontWeight = FontWeight.Bold,
            )
            DailyChart(focusSeries)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(focusSeries.first().first, style = MaterialTheme.typography.bodySmall)
                Text(focusSeries.last().first, style = MaterialTheme.typography.bodySmall)
            }
        }

        if (summary.weekOverWeek.isNotEmpty()) {
            StatsSectionLabel("Ez a hét az előzőhöz képest")
            for (row in summary.weekOverWeek) WeekDeltaRow(row, labelOf)
        }
    }
}

/**
 * Munkamenetek — hányszor ültél le, és mennyit vittél végig.
 *
 * Nulla menetnél nem mutatunk üres dobozt: egy minden nap ott álló nullás sor
 * nem információ, csak zaj.
 */
@Composable
private fun FocusStatsBlock(
    today: Focus.FocusSummary, week: Focus.FocusSummary,
    focusDays: List<Pair<String, Double>> = emptyList(),
    prevWeek: Focus.FocusSummary? = null,
) {
    // Nulla menetnél nincs üres blokk — kivéve, ha az előző héten volt menet:
    // a nulla hét is mondat, ha volt mihez mérni.
    if (week.sessions == 0 && (prevWeek?.sessions ?: 0) == 0) return
    StatsSectionLabel("Munkamenetek")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        CountTile(today.sessions.toString(), "menet ma", Modifier.weight(1f))
        StatTile("fókuszban ma", today.totalMs / 1000.0, Modifier.weight(1f))
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        CountTile(week.sessions.toString(), "menet a héten", Modifier.weight(1f))
        StatTile("fókuszban a héten", week.totalMs / 1000.0, Modifier.weight(1f))
    }
    val parts = mutableListOf<String>()
    week.topPack?.let { parts.add("A hét leggyakoribb csomagja: $it.") }
    // A NULLA HÉT kimondva — a blokk csak azért áll, mert az előző héten volt menet.
    if (week.sessions == 0) parts.add("A héten nem volt menet.")
    // AZ ELŐZŐ HÉT a menetek mellett — irány, nem ítélet. Üres előző hét nem
    // összehasonlítás: akkor nincs mondat.
    prevWeek?.takeIf { it.sessions > 0 }?.let {
        parts.add("Az előző héten ${it.sessions} menet (${UsageLogic.formatDuration(it.totalMs / 1000.0)}).")
    }
    // A „korán leállítva” szándékosan NEM szégyenpad. Ha sokszor fordul elő,
    // nem a csomaggal van baj, hanem a hosszal.
    if (week.sessions > 0) {
        parts.add(
            if (week.stoppedEarly > 0) {
                "${week.stoppedEarly} menet ért véget a tervezettnél korábban. Ha ez sokszor " +
                    "fordul elő, nem a csomaggal van baj: rövidebb menetet érdemes indítani."
            } else {
                "A héten minden menetet végigvittél."
            },
        )
    }
    // A HETI ABLAKBÓL indult menetek: dolgozik-e az ablak — tény, nem ítélet.
    if (week.windowRuns > 0) parts.add("${week.windowRuns} menet a heti ablakból indult, magától.")
    // MINDEN ESZKÖZ menete beleszámít, és ezt ki kell mondani: a mérés
    // eszközönként külön áll, a munkamenet viszont a fiók egészére szól.
    parts.add("Minden eszközöd menete beleszámít.")
    Text(parts.joinToString(" "), style = MaterialTheme.typography.bodySmall)
    // A hét alakja a menetekre — ugyanaz a rajz, mint a mért időé fent:
    // egyenletesen jött-e össze a hét, vagy egy napból. Üresen nincs.
    if (focusDays.any { it.second > 0.0 }) {
        StatsSectionLabel("Fókuszban, naponta")
        WeekChart(focusDays)
    }
}

/** Ugyanaz a doboz, mint a StatTile, csak darabszámmal — az nem időtartam. */
@Composable
private fun CountTile(value: String, label: String, modifier: Modifier = Modifier) {
    Card(modifier) {
        Column(Modifier.padding(12.dp)) {
            Text(value, style = MaterialTheme.typography.headlineSmall)
            Text(label, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun StatTile(label: String, seconds: Double, modifier: Modifier = Modifier) {
    Card(modifier) {
        Column(Modifier.padding(12.dp)) {
            Text(UsageLogic.formatDuration(seconds), style = MaterialTheme.typography.headlineSmall)
            Text(label, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun LegendItem(color: Color, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.width(10.dp).height(10.dp).clip(RoundedCornerShape(3.dp)).background(color))
        Text(label, style = MaterialTheme.typography.bodySmall)
    }
}

/** Szakaszcím: apró, ritkított, NAGYBETŰS, halk — mint a főképernyőn. */
@Composable
private fun StatsSectionLabel(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun BarList(
    rows: List<UsageLogic.TargetTotal>,
    blockedDomains: Set<String>,
    markBlocked: Boolean,
    labelOf: (String) -> String,
) {
    val max = rows.maxOfOrNull { it.seconds }?.coerceAtLeast(1.0) ?: 1.0
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        for (row in rows) {
            val isBlocked = markBlocked && row.label in blockedDomains
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(
                        // colour is never the only signal: blocked rows say so in words
                        labelOf(row.label).let { if (isBlocked) "$it · blokkolt" else it },
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Text(UsageLogic.formatDuration(row.seconds), style = MaterialTheme.typography.bodySmall)
                }
                Box(
                    Modifier.fillMaxWidth().height(8.dp)
                        .clip(RoundedCornerShape(4.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant),
                ) {
                    Box(
                        Modifier
                            .fillMaxWidth((row.seconds / max).toFloat().coerceIn(0.02f, 1f))
                            .height(8.dp)
                            .clip(RoundedCornerShape(4.dp))
                            .background(if (isBlocked) SERIES_2 else SERIES_1),
                    )
                }
            }
        }
    }
}

@Composable
private fun DailyChart(series: List<Pair<String, Double>>) {
    val max = series.maxOfOrNull { it.second }?.coerceAtLeast(1.0) ?: 1.0
    Row(
        Modifier.fillMaxWidth().height(96.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        for ((_, seconds) in series) {
            val frac = (seconds / max).toFloat().coerceIn(0f, 1f)
            Box(
                Modifier
                    .weight(1f)
                    .height((96 * frac).dp.coerceAtLeast(2.dp))
                    .clip(RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp))
                    .background(if (seconds <= 0.0) MaterialTheme.colorScheme.surfaceVariant else SERIES_1),
            )
        }
    }
}

/** A hét napjainak rövid neve, a `Calendar.DAY_OF_WEEK` sorrendjében (1 = vasárnap). */
private val DAY_SHORT = listOf("V", "H", "K", "Sze", "Cs", "P", "Szo")

/** Egy „ÉÉÉÉ-HH-NN” napkulcs hétköznapja, a fenti listába indexelve (0 = vasárnap). */
private fun weekdayOf(day: String): Int {
    val cal = java.util.Calendar.getInstance()
    cal.clear()
    cal.set(day.substring(0, 4).toInt(), day.substring(5, 7).toInt() - 1, day.substring(8, 10).toInt())
    return cal.get(java.util.Calendar.DAY_OF_WEEK) - 1
}

/**
 * AZ ÓRÁK SÁVJA: huszonnégy rekesz egy színnel (a rekesz nem kategória), a
 * csúcs teljes erővel, a többi halványan — a gépi statisztika és a bővítmény
 * sávjának tükre, ugyanabban a mértékben (a csúcs a teljes magasság).
 */
@Composable
private fun HourStrip(hours: List<Int>, peakHour: Int, peakCount: Int) {
    if (hours.size != 24 || peakCount <= 0) return
    Row(
        Modifier.fillMaxWidth().height(30.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        hours.forEachIndexed { hour, n ->
            val frac = (n.toFloat() / peakCount).coerceIn(0f, 1f)
            Box(
                Modifier
                    .weight(1f)
                    .height((28 * frac).dp.coerceAtLeast(2.dp))
                    .clip(RoundedCornerShape(topStart = 2.dp, topEnd = 2.dp))
                    .background(SERIES_1.copy(alpha = if (hour == peakHour) 1f else 0.45f)),
            )
        }
    }
    // Az óra-tengely a sáv alatt: öt szám, hogy a rekeszeket órára lehessen olvasni.
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        for (h in listOf(0, 6, 12, 18, 24)) {
            Text("$h", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun WeekChart(
    series: List<Pair<String, Double>>,
    // Az érték felirata: idő (a mérés, a menetek) vagy darab (a megakadások).
    format: (Double) -> String = UsageLogic::formatDuration,
) {
    val max = series.maxOfOrNull { it.second }?.coerceAtLeast(1.0) ?: 1.0
    val today = UsageLogic.dayKey(System.currentTimeMillis())
    val peak = series.indexOfFirst { it.second >= max }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        series.forEachIndexed { i, (day, seconds) ->
            val isToday = day == today
            val labelled = (isToday || i == peak) && seconds > 0.0
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                // A szám sora akkor is foglal, ha üres: az oszlopok alja egy vonalban marad.
                Text(
                    if (labelled) format(seconds) else " ",
                    style = MaterialTheme.typography.labelSmall, maxLines = 1,
                )
                Box(Modifier.fillMaxWidth().height(96.dp), contentAlignment = Alignment.BottomCenter) {
                    val frac = (seconds / max).toFloat().coerceIn(0f, 1f)
                    Box(
                        Modifier
                            .fillMaxWidth(0.72f)
                            .height((96 * frac).dp.coerceAtLeast(2.dp))
                            .clip(RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp))
                            .background(if (seconds <= 0.0) MaterialTheme.colorScheme.surfaceVariant else SERIES_1),
                    )
                }
                Text(
                    if (isToday) "ma" else DAY_SHORT[weekdayOf(day)],
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = if (isToday) FontWeight.Bold else FontWeight.Normal,
                    color = if (isToday) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun WeekDeltaRow(row: UsageLogic.WeekDelta, labelOf: (String) -> String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(labelOf(row.label), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        val pct = row.deltaPct
        if (pct == null) {
            Text("új — ${UsageLogic.formatDuration(row.thisWeek)}", style = MaterialTheme.typography.bodySmall)
        } else {
            val p = Math.round(pct)
            // Dead zone: a couple of percent either way is noise, not a trend.
            val flat = Math.abs(p) <= 5
            val arrow = if (flat) "＝" else if (p > 0) "▲" else "▼"
            val color = when {
                flat -> MaterialTheme.colorScheme.onSurfaceVariant
                p > 0 -> MaterialTheme.colorScheme.error
                else -> MaterialTheme.colorScheme.secondary
            }
            Text(
                "$arrow ${if (p > 0) "+" else ""}$p% · ${UsageLogic.formatDuration(row.thisWeek)}",
                color = color, style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

/**
 * „Mikor mértünk utoljára?”
 *
 * A DÁTUM is kiírandó, ha nem ma volt: egy csupasz óraérték mellé a szem
 * automatikusan a mai napot képzeli — és pont az a kérdés, hogy ma volt-e
 * egyáltalán.
 */
private fun lastSampleLine(at: Long?): String {
    if (at == null) return "Még egyetlen mért időt sem rögzítettünk ezen a készüléken."
    val cal = java.util.Calendar.getInstance()
    val today = UsageLogic.dayKey(cal.timeInMillis)
    val clock = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale("hu")).format(java.util.Date(at))
    return if (UsageLogic.dayKey(at) == today) {
        "Utoljára mért idő: ma $clock."
    } else {
        val day = UsageLogic.dayKey(at)
        "Utoljára mért idő: $day $clock — azóta a mérés nem rögzített semmit."
    }
}
