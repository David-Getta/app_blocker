package hu.breaker.app.ui

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
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
    focusSeries: List<Pair<String, Double>>,
    focusLabel: String,
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
    hasUsageAccess: Boolean,
    /**
     * Mikor rögzítettünk utoljára mért időt, vagy `null`, ha még soha.
     *
     * A nulla önmagában néma: nem lehet megmondani belőle, hogy tényleg nem
     * használtad a telefont, vagy hogy a mérés hasalt el. Ez a sor teszi a
     * kettőt megkülönböztethetővé, anélkül hogy naplót kellene nézni hozzá.
     */
    lastSampleAt: Long?,
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
        FocusStatsBlock(focusToday, focusWeek)

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
private fun FocusStatsBlock(today: Focus.FocusSummary, week: Focus.FocusSummary) {
    if (week.sessions == 0) return
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
    // A „korán leállítva” szándékosan NEM szégyenpad. Ha sokszor fordul elő,
    // nem a csomaggal van baj, hanem a hosszal.
    parts.add(
        if (week.stoppedEarly > 0) {
            "${week.stoppedEarly} menet ért véget a tervezettnél korábban. Ha ez sokszor " +
                "fordul elő, nem a csomaggal van baj: rövidebb menetet érdemes indítani."
        } else {
            "A héten minden menetet végigvittél."
        },
    )
    // MINDEN ESZKÖZ menete beleszámít, és ezt ki kell mondani: a mérés
    // eszközönként külön áll, a munkamenet viszont a fiók egészére szól.
    parts.add("Minden eszközöd menete beleszámít.")
    Text(parts.joinToString(" "), style = MaterialTheme.typography.bodySmall)
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
