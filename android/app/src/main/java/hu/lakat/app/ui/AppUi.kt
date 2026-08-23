package hu.lakat.app.ui

import android.Manifest
import android.app.Activity
import android.net.VpnService
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.RadioButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hu.lakat.app.core.Blocklist
import hu.lakat.app.core.ChallengeEngine
import hu.lakat.app.core.ChallengeEngine.Kind
import hu.lakat.app.core.ChallengeEngine.Step
import hu.lakat.app.core.LakatStore
import hu.lakat.app.core.LimitLogic
import hu.lakat.app.core.Referee
import hu.lakat.app.core.ScheduleLogic
import hu.lakat.app.core.SessionRec
import hu.lakat.app.core.Site
import hu.lakat.app.core.UsageLogic
import hu.lakat.app.update.UpdateChecker
import hu.lakat.app.usage.UsageTracker
import hu.lakat.app.vpn.LakatVpnService
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private fun fmtRemain(ms: Long): String {
    val total = (ms.coerceAtLeast(0) + 999) / 1000
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "$h ó ${m.toString().padStart(2, '0')} p"
    else "$m:${s.toString().padStart(2, '0')}"
}

@Composable
fun LakatApp() {
    val state by LakatStore.state.collectAsState()
    val vpnRunning by LakatVpnService.running.collectAsState()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var challengeOpen by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        while (true) {
            now = System.currentTimeMillis()
            Referee.tick(now)
            delay(1000)
        }
    }

    var successMsg by remember { mutableStateOf<String?>(null) }
    val session = state.session
    if (challengeOpen && session != null) {
        ChallengeScreen(
            session = session,
            now = now,
            onClose = { challengeOpen = false },
            onSuccess = { msg ->
                successMsg = msg
                challengeOpen = false
            },
        )
    } else {
        HomeScreen(
            now = now,
            vpnRunning = vpnRunning,
            onOpenChallenge = { challengeOpen = true },
        )
        successMsg?.let {
            AlertDialog(
                onDismissRequest = { successMsg = null },
                title = { Text("Siker") },
                text = { Text(it) },
                confirmButton = { TextButton(onClick = { successMsg = null }) { Text("OK") } },
            )
        }
    }
}

// =============================================================== HOME SCREEN

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HomeScreen(now: Long, vpnRunning: Boolean, onOpenChallenge: () -> Unit) {
    val context = LocalContext.current
    val state by LakatStore.state.collectAsState()
    val scope = rememberCoroutineScope()
    var update by remember { mutableStateOf<UpdateChecker.Update?>(null) }
    var updateBusy by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { update = UpdateChecker.check() }

    val vpnConsent = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) LakatVpnService.start(context)
    }
    val notifPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { }

    fun startProtection() {
        if (Build.VERSION.SDK_INT >= 33) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        val consent = VpnService.prepare(context)
        if (consent != null) vpnConsent.launch(consent) else LakatVpnService.start(context)
    }

    var addInput by rememberSaveable { mutableStateOf("") }
    var usePreset by rememberSaveable { mutableStateOf(true) }
    var addError by remember { mutableStateOf<String?>(null) }
    var pauseSite by remember { mutableStateOf<Site?>(null) }
    var deleteSite by remember { mutableStateOf<Site?>(null) }
    var scheduleSite by remember { mutableStateOf<Site?>(null) }
    var limitSite by remember { mutableStateOf<Site?>(null) }
    var flowError by remember { mutableStateOf<String?>(null) }

    fun addSite(raw: String) {
        addError = null
        val domain = Blocklist.normalizeDomain(raw)
        if (domain == null) {
            addError = "Ez nem tűnik érvényes címnek."
            return
        }
        if (LakatStore.state.value.sites.any { it.domain == domain }) {
            addError = "Ez az oldal már a listán van."
            return
        }
        LakatStore.mutate { s ->
            s.copy(sites = s.sites + Site(
                id = LakatStore.newId("site"),
                domain = domain,
                hostnames = Blocklist.expandHostnames(domain, usePreset),
                addedAt = System.currentTimeMillis(),
                pauseUntil = null,
                pendingDeleteAt = null,
            ))
        }
        addInput = ""
        if (!vpnRunning) startProtection()
    }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // Header
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("🔒 Lakat", fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Text(
                    if (vpnRunning) "Védelem aktív" else "Védelem kikapcsolva",
                    color = if (vpnRunning) MaterialTheme.colorScheme.secondary
                    else MaterialTheme.colorScheme.error,
                    fontWeight = FontWeight.SemiBold,
                )
            }

            // Update banner (direct-download track)
            update?.let { upd ->
                Card {
                    Row(
                        Modifier.fillMaxWidth().padding(12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Új verzió elérhető: ${upd.version}", modifier = Modifier.weight(1f),
                            style = MaterialTheme.typography.bodyMedium)
                        Button(
                            enabled = !updateBusy,
                            onClick = {
                                updateBusy = true
                                scope.launch {
                                    runCatching { UpdateChecker.downloadAndInstall(context, upd) }
                                    updateBusy = false
                                }
                            },
                        ) { Text(if (updateBusy) "Letöltés…" else "Frissítés") }
                    }
                }
            }

            // Protection card
            if (!vpnRunning) {
                Card {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("A DNS-szűrő nem fut", fontWeight = FontWeight.Bold)
                        Text(
                            "A blokkolás egy helyi VPN-en keresztül működik: minden névfeloldás " +
                                "átmegy rajta, így a tiltás minden böngészőben él, inkognitóban is. " +
                                "A forgalmad nem hagyja el a készüléket.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Button(onClick = { startProtection() }) { Text("Védelem bekapcsolása") }
                    }
                }
            } else if (state.sites.isEmpty()) {
                OutlinedButton(onClick = { LakatVpnService.stop(context) }) {
                    Text("Védelem kikapcsolása")
                }
            } else {
                Text(
                    "A védelem az appból nem kapcsolható ki, amíg van blokkolt oldal. " +
                        "(A rendszer VPN-beállítása erősebb nálunk — ha ott kapcsolod ki, szólni fogunk.)",
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            // Add site
            Card {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Oldal blokkolása", fontWeight = FontWeight.Bold)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            value = addInput,
                            onValueChange = { addInput = it },
                            placeholder = { Text("pl. www.youtube.com") },
                            modifier = Modifier.weight(1f),
                            singleLine = true,
                        )
                        Spacer(Modifier.width(8.dp))
                        Button(onClick = { addSite(addInput) }) { Text("Blokk") }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = usePreset, onCheckedChange = { usePreset = it })
                        Text(
                            "Társoldalak blokkolása is (pl. youtu.be, m.youtube.com)",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (preset in listOf("youtube.com", "facebook.com", "instagram.com", "tiktok.com", "x.com", "reddit.com")) {
                            OutlinedButton(onClick = { addSite(preset) }) { Text(preset) }
                        }
                    }
                    addError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    Text(
                        "Oldalt felvenni mindig egy kattintás. Levenni — az szándékosan nem az.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }

            // Resume banner
            state.session?.let { ses ->
                val site = state.sites.find { it.id == ses.siteId }
                Card {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "Folyamatban: ${if (ses.kind == Kind.DELETE) "törlés" else "feloldás"} — ${site?.domain ?: ""}",
                            modifier = Modifier.weight(1f),
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Button(onClick = onOpenChallenge) { Text("Folytatás") }
                    }
                }
            }

            // Site list
            Text("Blokkolt oldalak", fontWeight = FontWeight.Bold)
            if (state.sites.isEmpty()) {
                Text("Még nincs blokkolt oldal.", style = MaterialTheme.typography.bodySmall)
            }
            for (site in state.sites) {
                SiteCard(
                    site = site, now = now, hasSession = state.session != null,
                    usage = state.usage,
                    onPause = { pauseSite = site },
                    onDelete = { deleteSite = site },
                    onSchedule = { scheduleSite = site },
                    onLimit = { limitSite = site },
                )
            }

            // Usage statistics. The summary is derived from state.usage, so it is
            // only recomputed when the stored history actually changes.
            Spacer(Modifier.height(4.dp))
            val usageSummary = remember(state.usage, now / 60_000) {
                UsageLogic.summarize(state.usage, now)
            }
            val focusTarget = usageSummary.topWeekSites.firstOrNull()
                ?: usageSummary.topWeekApps.firstOrNull()
            StatsSection(
                summary = usageSummary,
                focusSeries = focusTarget?.let { UsageLogic.series(state.usage, it.key, now, 30) }
                    ?: emptyList(),
                focusLabel = focusTarget?.label ?: "",
                blockedDomains = state.sites.map { it.domain }.toSet(),
                hasUsageAccess = UsageTracker.hasUsageAccess(context),
                onGrantAccess = { context.startActivity(UsageTracker.usageAccessIntent()) },
                onToggleEnabled = {
                    // Napi keret mellett a mérés nem kapcsolható ki: abból fogy
                    // a keret, kikapcsolva sosem fogyna el. A referee mondja ki.
                    try {
                        Referee.setUsageEnabled(!state.usage.enabled)
                    } catch (e: Referee.RefereeException) {
                        flowError = e.message
                    }
                },
                onClear = {
                    LakatStore.mutate { s ->
                        val keep = s.usage.enabled
                        s.copy(usage = UsageLogic.UsageState(enabled = keep))
                    }
                },
            )

            val tier = ChallengeEngine.computeTier(state.unlockLog, now)
            val names = listOf("alap", "emelt", "magas", "maximális")
            Text(
                "Próbatétel-nehézség: ${names[tier]} (${tier + 1}/4) — minél többször oldasz fel, annál nehezebb.",
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center,
            )
        }
    }

    // Pause length dialog
    pauseSite?.let { site ->
        AlertDialog(
            onDismissRequest = { pauseSite = null },
            title = { Text("Mennyi időre oldanád fel?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("A feloldás előtt próbatételeket kell teljesíteni. A megadott idő után a blokkolás magától visszakapcsol.")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (m in ChallengeEngine.PAUSE_CHOICES_MIN) {
                            OutlinedButton(onClick = {
                                pauseSite = null
                                try {
                                    Referee.startSession(Kind.PAUSE, site.id, m, System.currentTimeMillis())
                                    onOpenChallenge()
                                } catch (e: Referee.RefereeException) {
                                    flowError = e.message
                                }
                            }) { Text("$m p") }
                        }
                    }
                }
            },
            confirmButton = { },
            dismissButton = { TextButton(onClick = { pauseSite = null }) { Text("Mégse") } },
        )
    }

    // Delete confirm dialog
    deleteSite?.let { site ->
        AlertDialog(
            onDismissRequest = { deleteSite = null },
            title = { Text("Végleges törlés?") },
            text = {
                Text(
                    "A(z) ${site.domain} törléséhez a legnehezebb próbatételek tartoznak, és a törlés " +
                        "csak 24 órával a teljesítésük UTÁN válik véglegessé. Addig bármikor visszavonhatod.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    deleteSite = null
                    try {
                        Referee.startSession(Kind.DELETE, site.id, null, System.currentTimeMillis())
                        onOpenChallenge()
                    } catch (e: Referee.RefereeException) {
                        flowError = e.message
                    }
                }) { Text("Indítom a próbákat") }
            },
            dismissButton = { TextButton(onClick = { deleteSite = null }) { Text("Mégse") } },
        )
    }

    // Schedule editor dialog
    scheduleSite?.let { site ->
        ScheduleDialog(
            site = site,
            onDismiss = { scheduleSite = null },
            onApplied = { scheduleSite = null },
            onChallenge = { scheduleSite = null; onOpenChallenge() },
            onError = { scheduleSite = null; flowError = it },
        )
    }

    // Daily budget dialog
    limitSite?.let { site ->
        LimitDialog(
            site = site,
            onDismiss = { limitSite = null },
            onApplied = { limitSite = null },
            onChallenge = { limitSite = null; onOpenChallenge() },
            onError = { limitSite = null; flowError = it },
        )
    }

    flowError?.let {
        AlertDialog(
            onDismissRequest = { flowError = null },
            title = { Text("Hoppá") },
            text = { Text(it) },
            confirmButton = { TextButton(onClick = { flowError = null }) { Text("OK") } },
        )
    }
}

/** Preset bands offered in the schedule editor (0=Sunday..6=Saturday). */
private val SCHEDULE_PRESETS = listOf(
    Triple("Munkaidő (H–P 9–17)", "workHours", ScheduleLogic.Band(setOf(1, 2, 3, 4, 5), 9 * 60, 17 * 60)),
    Triple("Esti lekapcsolás (22–06)", "evening", ScheduleLogic.Band(setOf(0, 1, 2, 3, 4, 5, 6), 22 * 60, 6 * 60)),
    Triple("Hétvége (Szo–V egész nap)", "weekend", ScheduleLogic.Band(setOf(0, 6), 0, 1440)),
)

@Composable
private fun ScheduleDialog(
    site: Site,
    onDismiss: () -> Unit,
    onApplied: () -> Unit,
    onChallenge: () -> Unit,
    onError: (String) -> Unit,
) {
    var mode by remember { mutableStateOf(site.schedule?.mode ?: ScheduleLogic.Mode.ALWAYS) }
    val selected = remember {
        mutableStateListOf<String>().apply {
            val bands = site.schedule?.bands ?: emptyList()
            for ((_, key, band) in SCHEDULE_PRESETS) if (bands.contains(band)) add(key)
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Menetrend: ${site.domain}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    "Szigorítani (több tiltott idő) azonnal megy. Lazítani ugyanúgy próbatételekbe kerül, mint egy feloldás.",
                    style = MaterialTheme.typography.bodySmall,
                )
                val modes = listOf(
                    ScheduleLogic.Mode.ALWAYS to "Mindig tiltva",
                    ScheduleLogic.Mode.SCHEDULED_BLOCK to "Csak a kijelölt sávokban tiltva",
                    ScheduleLogic.Mode.SCHEDULED_ALLOW to "A kijelölt sávokban szabad, egyébként tiltva",
                )
                for ((m, label) in modes) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = mode == m, onClick = { mode = m })
                        Text(label, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                if (mode != ScheduleLogic.Mode.ALWAYS) {
                    Text("Sávok:", style = MaterialTheme.typography.bodySmall)
                    for ((label, key, _) in SCHEDULE_PRESETS) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(
                                checked = selected.contains(key),
                                onCheckedChange = { on -> if (on) selected.add(key) else selected.remove(key) },
                            )
                            Text(label, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                val bands = if (mode == ScheduleLogic.Mode.ALWAYS) emptyList()
                    else SCHEDULE_PRESETS.filter { selected.contains(it.second) }.map { it.third }
                if (mode != ScheduleLogic.Mode.ALWAYS && bands.isEmpty()) {
                    onError("Válassz legalább egy sávot, vagy a „Mindig tiltva” módot."); return@TextButton
                }
                try {
                    val r = Referee.startScheduleChange(
                        site.id, ScheduleLogic.Schedule(mode, bands), System.currentTimeMillis())
                    if (r.applied) onApplied() else onChallenge()
                } catch (e: Referee.RefereeException) {
                    onError(e.message ?: "Ismeretlen hiba")
                }
            }) { Text("Alkalmaz") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Mégse") } },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SiteCard(
    site: Site, usage: UsageLogic.UsageState, now: Long, hasSession: Boolean,
    onPause: () -> Unit, onDelete: () -> Unit, onSchedule: () -> Unit, onLimit: () -> Unit,
) {
    Card {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(site.domain, fontWeight = FontWeight.Bold)
            Text("${site.hostnames.size} hosztnév", style = MaterialTheme.typography.bodySmall)
            val paused = site.pauseUntil != null && site.pauseUntil > now
            val deleting = site.pendingDeleteAt != null
            val scheduled = site.schedule != null && site.schedule.mode != ScheduleLogic.Mode.ALWAYS
            when {
                paused -> {
                    Text(
                        "Szünetel még ${fmtRemain(site.pauseUntil!! - now)}",
                        color = MaterialTheme.colorScheme.tertiary,
                    )
                    // A keret a szünet alatt IS fogy — az idő akkor is elmegy az
                    // oldalra. Ha ezt elrejtenénk, a szünet végén jönne a
                    // meglepetés, hogy az oldal azonnal zár.
                    LimitMeter(site, usage, now, duringPause = true)
                    OutlinedButton(onClick = {
                        LakatStore.mutate { s ->
                            s.copy(sites = s.sites.map {
                                if (it.id == site.id) it.copy(pauseUntil = null) else it
                            })
                        }
                    }) { Text("Blokkolás visszakapcsolása most") }
                }
                deleting -> {
                    Text(
                        "Törlés ${fmtRemain(site.pendingDeleteAt!! - now)} múlva",
                        color = MaterialTheme.colorScheme.error,
                    )
                    OutlinedButton(onClick = {
                        LakatStore.mutate { s ->
                            s.copy(sites = s.sites.map {
                                if (it.id == site.id) it.copy(pendingDeleteAt = null) else it
                            })
                        }
                    }) { Text("Törlés visszavonása") }
                }
                else -> {
                    val blockedNow = LimitLogic.isBlockedNowWithLimit(site, usage, now)
                    if (scheduled) {
                        Text(
                            if (blockedNow) "Most blokkolva (menetrend)" else "Most szabad (menetrend szerint)",
                            color = if (blockedNow) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.tertiary,
                        )
                    } else {
                        Text("Blokkolva", color = MaterialTheme.colorScheme.secondary)
                    }
                    LimitMeter(site, usage, now, duringPause = false)
                    if (!hasSession) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = onPause) { Text("Feloldás időre…") }
                            OutlinedButton(onClick = onSchedule) { Text("Menetrend…") }
                            OutlinedButton(onClick = onLimit) { Text("Napi keret…") }
                            OutlinedButton(onClick = onDelete) { Text("Törlés…") }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Mai keret egy sávon. Kettős kódolás: a szín MELLETT a felirat is kimondja,
 * hogy elfogyott-e — így annak is olvasható, aki a két színt nem különbözteti meg.
 */
@Composable
private fun LimitMeter(site: Site, usage: UsageLogic.UsageState, now: Long, duringPause: Boolean) {
    val limit = LimitLogic.normalizeLimit(site.dailyLimitSeconds) ?: return
    val used = LimitLogic.usedTodaySeconds(usage, site.domain, now)
    val exhausted = used >= limit
    val fraction = (used / limit).coerceIn(0.0, 1.0).toFloat()
    val whole = UsageLogic.formatDuration(limit.toDouble())
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(
            when {
                // A szünet erősebb a keretnél, tehát az oldal MOST még megy —
                // de a szünet végén már nem fog. Mondjuk ki előre.
                exhausted && duringPause -> "Napi keret elfogyott ($whole) — a szünet végén visszazár"
                exhausted -> "Napi keret elfogyott ($whole) — holnap újraindul"
                duringPause ->
                    "Napi keret: ${UsageLogic.formatDuration(used)} / $whole — a szünet alatt is fogy"
                else -> "Napi keret: ${UsageLogic.formatDuration(used)} / $whole"
            },
            style = MaterialTheme.typography.bodySmall,
        )
        LinearProgressIndicator(
            progress = { fraction },
            modifier = Modifier.fillMaxWidth(),
            color = if (exhausted) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
        )
    }
}

private val LIMIT_CHOICES_MIN = listOf(10, 20, 30, 45, 60, 90, 120)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LimitDialog(
    site: Site,
    onDismiss: () -> Unit,
    onApplied: () -> Unit,
    onChallenge: () -> Unit,
    onError: (String) -> Unit,
) {
    var chosen by remember { mutableStateOf(site.dailyLimitSeconds) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Napi keret: ${site.domain}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    "Ha a mai aktív idő eléri a keretet, az oldal a nap hátralévő " +
                        "részére magától visszazár, éjfélkor pedig a keret újraindul. " +
                        "Keretet bevezetni vagy csökkenteni azonnal megy; emelni vagy " +
                        "megszüntetni ugyanúgy próbatételekbe kerül, mint egy feloldás.",
                    style = MaterialTheme.typography.bodySmall,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (min in LIMIT_CHOICES_MIN) {
                        val seconds = min * 60L
                        if (chosen == seconds) {
                            Button(onClick = { chosen = seconds }) { Text("$min perc") }
                        } else {
                            OutlinedButton(onClick = { chosen = seconds }) { Text("$min perc") }
                        }
                    }
                    if (chosen == null) {
                        Button(onClick = { chosen = null }) { Text("Nincs keret") }
                    } else {
                        OutlinedButton(onClick = { chosen = null }) { Text("Nincs keret") }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                try {
                    val r = Referee.startLimitChange(site.id, chosen, System.currentTimeMillis())
                    if (r.applied) onApplied() else onChallenge()
                } catch (e: Referee.RefereeException) {
                    onError(e.message ?: "Ismeretlen hiba")
                }
            }) { Text("Alkalmaz") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Mégse") } },
    )
}

// ========================================================= CHALLENGE SCREEN

@Composable
private fun ChallengeScreen(
    session: SessionRec,
    now: Long,
    onClose: () -> Unit,
    onSuccess: (String) -> Unit,
) {
    val state by LakatStore.state.collectAsState()
    val site = state.sites.find { it.id == session.siteId }
    var message by remember { mutableStateOf<String?>(null) }

    val doneText = if (session.kind == Kind.DELETE) {
        "Kész. A törlés 24 óra múlva válik véglegessé — addig visszavonhatod."
    } else {
        "Sikerült! Az oldal ${session.minutes} percre elérhető, utána magától visszazár."
    }

    fun submit(answer: String) {
        try {
            val r = Referee.submitAnswer(session.id, answer, System.currentTimeMillis())
            message = r.message
            if (r.sessionDone) onSuccess(doneText)
        } catch (e: Referee.RefereeException) {
            message = e.message
        }
    }

    fun claim() {
        try {
            val r = Referee.claimDelay(session.id, System.currentTimeMillis())
            message = r.message
            if (r.sessionDone) onSuccess(doneText)
        } catch (e: Referee.RefereeException) {
            message = e.message
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                if (session.kind == Kind.DELETE) "Végleges törlés: ${site?.domain ?: ""}"
                else "Feloldás ${session.minutes} percre: ${site?.domain ?: ""}",
                fontSize = 18.sp, fontWeight = FontWeight.Bold,
            )
            Text(
                "${session.stepIndex + 1}/${session.steps.size}. próba",
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.SemiBold,
            )

            when (val step = session.steps.getOrNull(session.stepIndex)) {
                is Step.Transcribe -> TranscribeStepUi(step, ::submit)
                is Step.MathChain -> MathStepUi(step, ::submit)
                is Step.Memory -> MemoryStepUi(step, now, ::submit)
                is Step.Reverse -> ReverseStepUi(step, ::submit)
                is Step.Delay -> DelayStepUi(step, now, onClaim = ::claim)
                null -> onClose()
            }

            message?.let { Text(it, color = MaterialTheme.colorScheme.error) }

            Text(
                "A feladás nem sorsol könnyebb feladatot: egy órán belül ugyanezeket a " +
                    "próbatípusokat kapod vissza, csak friss tartalommal.",
                style = MaterialTheme.typography.bodySmall,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = {
                    Referee.abandon(session.id)
                    onClose()
                }) { Text("Feladom — maradjon blokkolva") }
                TextButton(onClick = onClose) { Text("Vissza (a kísérlet megmarad)") }
            }
        }
    }

}

/** paste/autofill guard: large sudden growth clears the field */
private fun guarded(prev: String, next: String, onViolation: () -> Unit): String {
    return if (next.length - prev.length > 12) {
        onViolation()
        prev
    } else next
}

@Composable
private fun TranscribeStepUi(step: Step.Transcribe, onSubmit: (String) -> Unit) {
    var input by rememberSaveable(step.id) { mutableStateOf("") }
    var warn by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Gépeld át pontosan az alábbi szöveget", fontWeight = FontWeight.Bold)
        Text(
            "Karakterre pontosan: kis-/nagybetű, írásjelek, számok. Beilleszteni nem lehet.",
            style = MaterialTheme.typography.bodySmall,
        )
        Card { Text(step.text, Modifier.padding(12.dp)) }
        OutlinedTextField(
            value = input,
            onValueChange = { input = guarded(input, it) { warn = true } },
            modifier = Modifier
                .fillMaxWidth()
                .height(160.dp),
        )
        val prefixOk = step.text.startsWith(input)
        Text(
            when {
                input.isEmpty() -> " "
                prefixOk -> "Eddig hibátlan (${input.length}/${step.text.length})"
                else -> {
                    var i = 0
                    while (i < input.length && i < step.text.length && input[i] == step.text[i]) i++
                    "Eltérés a(z) ${i + 1}. karakternél."
                }
            },
            style = MaterialTheme.typography.bodySmall,
            color = if (input.isNotEmpty() && !prefixOk) MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.secondary,
        )
        if (warn) Text("A beillesztés nem játszik — kézzel kell begépelni.", color = MaterialTheme.colorScheme.error)
        Button(onClick = { onSubmit(input) }) { Text("Kész, ellenőrzés") }
    }
}

@Composable
private fun MathStepUi(step: Step.MathChain, onSubmit: (String) -> Unit) {
    var input by rememberSaveable(step.id, step.pos) { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Fejszámolás-lánc — ${step.pos + 1}/${step.problems.size}. feladat", fontWeight = FontWeight.Bold)
        Text(
            "Hibás válasznál a teljes lánc elölről indul, új feladatokkal. Papírt szabad, számológépet nem érdemes — magadat csapod be.",
            style = MaterialTheme.typography.bodySmall,
        )
        Card {
            Text(
                "${step.problems[step.pos].q} = ?",
                Modifier
                    .fillMaxWidth()
                    .padding(18.dp),
                fontSize = 24.sp,
                textAlign = TextAlign.Center,
            )
        }
        OutlinedTextField(
            value = input,
            onValueChange = { v -> input = v.filter { it.isDigit() || it == '-' } },
            placeholder = { Text("Eredmény") },
            singleLine = true,
        )
        Button(onClick = { onSubmit(input); input = "" }) { Text("Ellenőrzés") }
    }
}

@Composable
private fun MemoryStepUi(step: Step.Memory, now: Long, onSubmit: (String) -> Unit) {
    var input by rememberSaveable(step.id) { mutableStateOf("") }
    // Az időzítés szerveroldali (armedAt): az app bezárása/újranyitása nem
    // indítja újra a mutatási fázist, és a bíró a kivárás előtt nem fogad választ.
    // Ha még nincs bélyeg, az elsőt rögzítjük, különben a visszaszámláló
    // másodpercenként újraindulna.
    val armedAt = remember(step.id) { step.armedAt ?: now }
    val showEnd = armedAt + step.showMs
    val waitEnd = showEnd + step.waitMs

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Memória-próba", fontWeight = FontWeight.Bold)
        when {
            now < showEnd -> {
                Text("Jegyezd meg a kódot! Hamarosan végleg eltűnik.", style = MaterialTheme.typography.bodySmall)
                Card {
                    Text(
                        step.code,
                        Modifier
                            .fillMaxWidth()
                            .padding(22.dp),
                        fontSize = 26.sp,
                        fontFamily = FontFamily.Monospace,
                        textAlign = TextAlign.Center,
                        letterSpacing = 6.sp,
                    )
                }
                Text("Eltűnik: ${fmtRemain(showEnd - now)}", textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            }
            now < waitEnd -> {
                Text("Most várni kell — közben ne írd le sehova!", style = MaterialTheme.typography.bodySmall)
                Text("Beírható: ${fmtRemain(waitEnd - now)}", textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            }
            else -> {
                Text("Írd be a kódot emlékezetből:", style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = guarded(input, it) { } },
                    singleLine = true,
                )
                Button(onClick = { onSubmit(input) }) { Text("Ellenőrzés") }
            }
        }
    }
}

@Composable
private fun ReverseStepUi(step: Step.Reverse, onSubmit: (String) -> Unit) {
    var input by rememberSaveable(step.id) { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Gépeld be visszafelé", fontWeight = FontWeight.Bold)
        Text(
            "A teljes mondatot karakterről karakterre fordítva, írásjelekkel és szóközökkel. Példa: „Kis fa.” → „.af siK”",
            style = MaterialTheme.typography.bodySmall,
        )
        Card { Text(step.text, Modifier.padding(12.dp)) }
        OutlinedTextField(
            value = input,
            onValueChange = { input = guarded(input, it) { } },
            modifier = Modifier.fillMaxWidth(),
        )
        Button(onClick = { onSubmit(input) }) { Text("Ellenőrzés") }
    }
}

@Composable
private fun DelayStepUi(step: Step.Delay, now: Long, onClaim: () -> Unit) {
    val claimableAt = step.claimableAt ?: return
    val inWindow = now >= claimableAt && now <= claimableAt + step.claimWindowMs
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Kötelező várakozás: ${step.minutes} perc", fontWeight = FontWeight.Bold)
        Text(
            "A visszaszámlálás akkor is megy, ha kilépsz az appból. Amikor lejár, 10 perced van átvenni a feloldást — ha lecsúszol róla, az egész kísérlet elölről kezdődik.",
            style = MaterialTheme.typography.bodySmall,
        )
        Text(
            when {
                now < claimableAt -> "Átvehető: ${fmtRemain(claimableAt - now)} múlva"
                inWindow -> "Átvehető még: ${fmtRemain(claimableAt + step.claimWindowMs - now)}"
                else -> "Az átvételi ablak lejárt."
            },
            fontSize = 20.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        Button(enabled = inWindow, onClick = onClaim) { Text("Feloldás átvétele") }
    }
}
