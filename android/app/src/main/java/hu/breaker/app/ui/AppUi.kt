package hu.breaker.app.ui

import android.Manifest
import android.app.Activity
import android.net.VpnService
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hu.breaker.app.core.AliasLogic
import hu.breaker.app.core.AppState
import hu.breaker.app.core.Focus
import hu.breaker.app.core.Blocklist
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.ChallengeEngine
import hu.breaker.app.core.ChallengeEngine.Kind
import hu.breaker.app.core.ChallengeEngine.Step
import hu.breaker.app.core.LimitLogic
import hu.breaker.app.core.Referee
import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.SessionRec
import hu.breaker.app.core.Site
import hu.breaker.app.core.Pairing
import hu.breaker.app.core.SyncClient
import hu.breaker.app.core.UrlRules
import hu.breaker.app.core.UsageLogic
import hu.breaker.app.update.UpdateChecker
import hu.breaker.app.usage.UsageTracker
import hu.breaker.app.vpn.BreakerVpnService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private fun fmtRemain(ms: Long): String {
    val total = (ms.coerceAtLeast(0) + 999) / 1000
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "$h ó ${m.toString().padStart(2, '0')} p"
    else "$m:${s.toString().padStart(2, '0')}"
}

@Composable
fun BreakerApp() {
    val state by BreakerStore.state.collectAsState()
    val vpnRunning by BreakerVpnService.running.collectAsState()
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
    val state by BreakerStore.state.collectAsState()
    val scope = rememberCoroutineScope()
    var update by remember { mutableStateOf<UpdateChecker.Update?>(null) }
    var updateBusy by remember { mutableStateOf(false) }
    var updateNote by remember { mutableStateOf<String?>(null) }
    var needsInstallPermission by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { update = UpdateChecker.check() }

    // Szinkron az app megnyitásakor.
    //
    // A telefonon nincs értelme percenként ébresztgetni a hálózatot: az app
    // akkor számít, amikor épp nézed. Viszont AKKOR számítson: aki a gépén
    // felvett egy oldalt, azt a telefonján a megnyitáskor lássa, ne csak akkor,
    // ha eszébe jut megnyomni egy gombot.
    LaunchedEffect(Unit) {
        if (BreakerStore.state.value.sync == null) return@LaunchedEffect
        withContext(Dispatchers.IO) {
            try {
                val r = SyncClient.syncNow(BreakerStore.state.value, System.currentTimeMillis())
                BreakerStore.mutate { r.state }
            } catch (e: Exception) {
                // Csendben: offline telefonnál a megnyitás nem hibaüzenettel
                // kezdődik. A fiókkártyán ott lesz, mikor volt utoljára szinkron.
                BreakerStore.mutate { st ->
                    st.sync?.let { st.copy(sync = it.copy(lastError = e.message)) } ?: st
                }
            }
        }
    }

    val vpnConsent = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) BreakerVpnService.start(context)
    }
    val notifPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { }

    fun startProtection() {
        if (Build.VERSION.SDK_INT >= 33) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        val consent = VpnService.prepare(context)
        if (consent != null) vpnConsent.launch(consent) else BreakerVpnService.start(context)
    }

    var addInput by rememberSaveable { mutableStateOf("") }
    var usePreset by rememberSaveable { mutableStateOf(true) }
    var addError by remember { mutableStateOf<String?>(null) }
    var pauseSite by remember { mutableStateOf<Site?>(null) }
    var deleteSite by remember { mutableStateOf<Site?>(null) }
    var scheduleSite by remember { mutableStateOf<Site?>(null) }
    var limitSite by remember { mutableStateOf<Site?>(null) }
    var aliasSite by remember { mutableStateOf<Site?>(null) }
    var rulesSite by remember { mutableStateOf<Site?>(null) }
    var flowError by remember { mutableStateOf<String?>(null) }

    // Ideiglenes felfedés oldalanként: meddig látszik a valódi cím. Szándékosan
    // nem mentjük — az app újranyitása után megint a fedőnév áll ott.
    val revealedUntil = remember { mutableStateMapOf<String, Long>() }

    // A lista MOST nyitva van-e, ha egyébként rejtettre van állítva. Ez sem
    // mentett: a beállítás azt mondja, hogy rejtve INDULJON, a megnyitás pedig
    // csak erre a munkamenetre szól.
    var listOpenThisSession by remember { mutableStateOf(false) }
    val listHidden = state.hideSiteList && !listOpenThisSession

    /**
     * Amit a statisztikában ki szabad írni egy célpontról.
     *
     * Ez az EGY tölcsér: a sávok, a heti összevetés és a napi diagram címe is
     * ezen megy át. Ha bármelyik kimaradna, a fedőnév és a rejtés annyit érne,
     * mint egy lyukas zsák — elég egyetlen hely, ahol ott a valódi cím.
     */
    val siteLabel: (String) -> String = { raw ->
        val idx = state.sites.indexOfFirst { it.domain == raw }
        when {
            idx < 0 -> raw
            listHidden -> AliasLogic.maskedLabel(state.sites[idx], idx)
            else -> AliasLogic.displayName(state.sites[idx])
        }
    }

    fun addSite(raw: String) {
        addError = null
        val domain = Blocklist.normalizeDomain(raw)
        if (domain == null) {
            addError = "Ez nem tűnik érvényes címnek."
            return
        }
        if (BreakerStore.state.value.sites.any { it.domain == domain }) {
            addError = "Ez az oldal már a listán van."
            return
        }
        BreakerStore.mutate { s ->
            s.copy(sites = s.sites + Site(
                id = BreakerStore.newId("site"),
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
                Row(
                    horizontalArrangement = Arrangement.spacedBy(9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    BreakerMark()
                    Text("Breaker", style = MaterialTheme.typography.titleLarge)
                }
                StatusDot(
                    text = if (vpnRunning) "Védelem aktív" else "Védelem kikapcsolva",
                    color = if (vpnRunning) MaterialTheme.colorScheme.secondary
                    else MaterialTheme.colorScheme.error,
                )
            }

            // FUTÓ MUNKAMENET. Ez a telefonon fehérlista: amíg megy, csak a
            // csomagban felsoroltak jönnek be, minden más NXDOMAIN. Ha ez nem
            // látszana, a felhasználó egy hálózati hibát keresne — nem értené,
            // miért nem jön be egy oldal, és az appot hinné rossznak.
            // A `now` a másodpercenként frissülő óra: enélkül a hátralévő idő
            // csak akkor mozdulna, ha az ÁLLAPOT változik — vagyis állna.
            // HA A MUNKAMENET SZINKRONJA ELHASALT, azt ki kell írni. A leggyakoribb
            // ok egy régi fiókkiszolgáló, ami nem ismeri a `focus` gyűjteményt: a
            // gépen elindított menet ilyenkor SOSEM ér ide, és a felhasználó
            // semmiből nem tudná meg, miért. Azt hinné, a funkció rossz.
            state.focusSyncError?.let { msg ->
                Card {
                    Text(
                        msg,
                        Modifier.padding(14.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
            FocusRunningCard(state, now, onError = { flowError = it })
            FocusPacksCard(state, vpnRunning, onError = { flowError = it })

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
                                if (needsInstallPermission) {
                                    // A második koppintás már a beállításba visz:
                                    // ott adható meg az engedély, enélkül a
                                    // rendszertelepítő el sem indul.
                                    context.startActivity(UpdateChecker.installPermissionIntent(context))
                                    needsInstallPermission = false
                                    updateNote = null
                                    return@Button
                                }
                                updateBusy = true
                                updateNote = null
                                scope.launch {
                                    when (val r = UpdateChecker.downloadAndInstall(context, upd)) {
                                        is UpdateChecker.InstallResult.Started -> updateNote = null
                                        is UpdateChecker.InstallResult.NeedsPermission -> {
                                            needsInstallPermission = true
                                            updateNote = "A telepítéshez engedély kell " +
                                                "(ismeretlen forrásból származó appok, a Breakernél). " +
                                                "Koppints újra, és odaviszlek."
                                        }
                                        is UpdateChecker.InstallResult.Failed ->
                                            updateNote = "A frissítés nem sikerült: ${r.message}"
                                    }
                                    updateBusy = false
                                }
                            },
                        ) {
                            Text(
                                when {
                                    updateBusy -> "Letöltés…"
                                    needsInstallPermission -> "Beállítás megnyitása"
                                    else -> "Frissítés"
                                },
                            )
                        }
                    }
                    // A gomb magától nem mond semmit, ha nem sikerül: eddig a
                    // felhasználó annyit látott, hogy visszaugrik „Frissítés”-re.
                    updateNote?.let {
                        Text(
                            it,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.padding(horizontal = 16.dp).padding(bottom = 12.dp),
                        )
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
                OutlinedButton(onClick = { BreakerVpnService.stop(context) }) {
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
                    SectionLabel("Oldal blokkolása")
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            value = addInput,
                            onValueChange = { addInput = it },
                            placeholder = {
                                Text(
                                    if (listHidden) "a cím, amit blokkolni akarsz"
                                    else "pl. www.youtube.com",
                                )
                            },
                            modifier = Modifier.weight(1f),
                            singleLine = true,
                        )
                        Spacer(Modifier.width(8.dp))
                        Button(onClick = { addSite(addInput) }) { Text("Blokk") }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = usePreset, onCheckedChange = { usePreset = it })
                        Text(
                            if (listHidden) "Társoldalak blokkolása is (a mobilos és a rövidített címek)"
                            else "Társoldalak blokkolása is (pl. youtu.be, m.youtube.com)",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    // Rejtett listánál a gyorsgombok is elmaradnak: PONT azok a
                    // címek állnak rajtuk, amiket az ember tipikusan blokkol.
                    // Hiába rejtenénk a listát, ha eggyel feljebb ott sorakozik
                    // ugyanaz hat gombon.
                    if (!listHidden) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            for (preset in listOf("youtube.com", "facebook.com", "instagram.com", "tiktok.com", "x.com", "reddit.com")) {
                                OutlinedButton(onClick = { addSite(preset) }) { Text(preset) }
                            }
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
                        // A munkamenet leállítása NEM oldalhoz tartozik: a
                        // `siteId` ott `focus:<csomag>`, tehát a fenti keresés
                        // üresen tér vissza. Enélkül a sáv azt írná ki, hogy
                        // „Folyamatban: feloldás — ”, név nélkül.
                        val focusPack = ses.pendingFocusEnd?.let {
                            state.focusPacks.find { p -> "focus:" + p.id == ses.siteId }
                        }
                        Text(
                            if (ses.pendingFocusEnd != null) {
                                "Folyamatban: munkamenet leállítása — " +
                                    (focusPack?.name ?: "munkamenet")
                            } else {
                                "Folyamatban: ${if (ses.kind == Kind.DELETE) "törlés" else "feloldás"} — " +
                                    (site?.let { AliasLogic.displayName(it) } ?: "")
                            },
                            modifier = Modifier.weight(1f),
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Button(onClick = onOpenChallenge) { Text("Folytatás") }
                    }
                }
            }

            // Site list
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SectionLabel("Blokkolt oldalak")
                // A gomb a BEÁLLÍTÁST kapcsolja, nem a pillanatnyi láthatóságot:
                // ha rejtettre van állítva, de most nyitva van, akkor a rejtést
                // kapcsolja KI. Enélkül nem lenne mód visszavonni.
                if (!listHidden && (state.sites.isNotEmpty() || state.hideSiteList)) {
                    TextButton(onClick = {
                        val turningOn = !state.hideSiteList
                        listOpenThisSession = !turningOn
                        BreakerStore.mutate { it.copy(hideSiteList = turningOn) }
                    }) {
                        Text(if (state.hideSiteList) "Ne rejtse ezután" else "Lista elrejtése")
                    }
                }
            }
            if (listHidden) {
                // A darabszám marad: a kérés az volt, hogy MIK vannak blokkolva
                // ne látszódjon, nem az, hogy hány.
                Card {
                    Row(
                        Modifier.fillMaxWidth().padding(14.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            if (state.sites.isEmpty())
                                "A lista el van rejtve. Még nincs benne egyetlen oldal sem."
                            else "${state.sites.size} oldal van blokkolva. A lista el van rejtve, " +
                                "hogy a puszta megnyitás se emlékeztessen rájuk. Megnyitva csak " +
                                "eddig a bezárásig marad.",
                            modifier = Modifier.weight(1f),
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Button(onClick = { listOpenThisSession = true }) { Text("Megnyitás") }
                    }
                }
            } else if (state.sites.isEmpty()) {
                Text("Még nincs blokkolt oldal.", style = MaterialTheme.typography.bodySmall)
            } else {
                Card {
                    Column {
                        state.sites.forEachIndexed { index, site ->
                            if (index > 0) {
                                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                            }
                            SiteCard(
                                site = site, now = now, hasSession = state.session != null,
                                usage = state.usage, shared = state.sharedToday,
                                revealedUntil = revealedUntil[site.id],
                                onReveal = {
                                    revealedUntil[site.id] =
                                        System.currentTimeMillis() + AliasLogic.REVEAL_MS
                                },
                                onPause = { pauseSite = site },
                                onDelete = { deleteSite = site },
                                onSchedule = { scheduleSite = site },
                                onLimit = { limitSite = site },
                                onAlias = { aliasSite = site },
                                onRules = { rulesSite = site },
                            )
                        }
                    }
                }
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
                // A NAP KEZDETE helyi idő szerint — ugyanaz a számítás, mint a
                // gépen. Nem a `now - 24 óra`, mert az reggel nyolckor a tegnap
                // esti menetet is mainak mondaná.
                focusToday = Focus.summarizeFocus(state.focusLog, UsageLogic.startOfDay(now), now),
                focusWeek = Focus.summarizeFocus(
                    state.focusLog, UsageLogic.startOfDay(now) - 6 * 86_400_000L, now,
                ),
                focusSeries = focusTarget?.let { UsageLogic.series(state.usage, it.key, now, 30) }
                    ?: emptyList(),
                focusLabel = focusTarget?.label ?: "",
                blockedDomains = state.sites.map { it.domain }.toSet(),
                labelOf = siteLabel,
                hasUsageAccess = UsageTracker.hasUsageAccess(context),
                lastSampleAt = state.usageLastSampleAt,
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
                    BreakerStore.mutate { s ->
                        val keep = s.usage.enabled
                        s.copy(usage = UsageLogic.UsageState(enabled = keep))
                    }
                },
            )

            SyncCard(state, scope, siteLabel)

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
                    "A(z) ${AliasLogic.displayName(site)} törléséhez a legnehezebb próbatételek tartoznak, és a törlés " +
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

    // Fedőnév dialógus
    rulesSite?.let { site ->
        RulesDialog(
            site = site,
            onDismiss = { rulesSite = null },
            onChanged = { rulesSite = BreakerStore.state.value.sites.find { s -> s.id == site.id } },
            onChallenge = { rulesSite = null; onOpenChallenge() },
            onError = { rulesSite = null; flowError = it },
        )
    }

    aliasSite?.let { site ->
        AliasDialog(
            site = site,
            onDismiss = { aliasSite = null },
            onSave = { text ->
                BreakerStore.mutate { st ->
                    st.copy(sites = st.sites.map {
                        if (it.id == site.id) it.copy(alias = AliasLogic.normalize(text)) else it
                    })
                }
                // Új fedőnév után a felfedés nem élhet tovább: különben a
                // beállítás pillanatában is a valódi cím maradna ott.
                revealedUntil.remove(site.id)
                aliasSite = null
            },
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

/**
 * Fedőnév beállítása.
 *
 * Nincs próbatétel: a fedőnév a blokkolást egy hajszálnyit sem gyengíti — az
 * oldal ugyanúgy tiltva marad, a szűrő ugyanazt a hosztnevet dobja el. A
 * súrlódás ott van, ahol a védelem gyengülne.
 */
@Composable
private fun AliasDialog(site: Site, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var text by remember(site.id) { mutableStateOf(site.alias ?: "") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Fedőnév") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "Ha adsz nevet, a felület ezt írja ki a cím helyett — a listán, a " +
                        "párbeszédek címében és a statisztikában is. A valódi cím egy gombbal, " +
                        "hat másodpercre előhívható.",
                    style = MaterialTheme.typography.bodySmall,
                )
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it.take(AliasLogic.MAX_ALIAS_LENGTH) },
                    placeholder = { Text("pl. A videós") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "Ez nem titkosítás: a blokk maga a készüléken ott van, a fedőnév csak " +
                        "annyit tesz, hogy ne emlékeztessen.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = { TextButton(onClick = { onSave(text) }) { Text("Mentés") } },
        dismissButton = {
            Row {
                if (site.alias != null) {
                    TextButton(onClick = { onSave("") }) { Text("Fedőnév levétele") }
                }
                TextButton(onClick = onDismiss) { Text("Mégse") }
            }
        },
    )
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
        title = { Text("Menetrend: ${AliasLogic.displayName(site)}") },
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
    site: Site, usage: UsageLogic.UsageState, shared: LimitLogic.SharedToday?,
    now: Long, hasSession: Boolean,
    revealedUntil: Long?, onReveal: () -> Unit,
    onPause: () -> Unit, onDelete: () -> Unit, onSchedule: () -> Unit, onLimit: () -> Unit,
    onAlias: () -> Unit, onRules: () -> Unit,
) {
    val paused = site.pauseUntil != null && site.pauseUntil > now
    val deleting = site.pendingDeleteAt != null
    val scheduled = site.schedule != null && site.schedule.mode != ScheduleLogic.Mode.ALWAYS
    val blockedNow = LimitLogic.isBlockedNowWithLimit(site, usage, now, shared)

    // Nincs saját kártyája: a sorokat a LISTA kártyája fogja össze, egymástól
    // pedig hajszálvonal választja el őket. Külön kártyákban tíz oldal
    // kártyafalnak látszott, és semmi nem volt fontosabb a másiknál.
    Column {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            // Fejléc: a NÉV és az ÁLLAPOT egy sorban — ez a kettő kell ránézésre.
            // Minden más ez alá kerül, halkabban.
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Column(Modifier.weight(1f)) {
                    val aliased = AliasLogic.isAliased(site)
                    val revealing = revealedUntil != null && now < revealedUntil
                    Text(
                        AliasLogic.displayNameNow(site, now, revealedUntil),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            if (aliased && !revealing) "fedőnév alatt"
                            else "${site.hostnames.size} hosztnév",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        // A valódi cím nem tűnik el, csak nem ül ott: néha
                        // tényleg tudni kell, melyik sor melyik.
                        if (aliased && !revealing) {
                            TextButton(onClick = onReveal, contentPadding = PaddingValues(horizontal = 6.dp)) {
                                Text("Mutasd", style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
                when {
                    paused -> StatusChip(
                        "Szünetel még ${fmtRemain(site.pauseUntil!! - now)}",
                        MaterialTheme.colorScheme.tertiary,
                    )
                    deleting -> StatusChip(
                        "Törlés ${fmtRemain(site.pendingDeleteAt!! - now)} múlva",
                        MaterialTheme.colorScheme.error,
                    )
                    scheduled -> StatusChip(
                        if (blockedNow) "Most blokkolva (menetrend)" else "Most szabad (menetrend)",
                        if (blockedNow) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.tertiary,
                    )
                    else -> StatusChip("Blokkolva", MaterialTheme.colorScheme.secondary)
                }
            }
            when {
                paused -> {
                    // A keret a szünet alatt IS fogy — az idő akkor is elmegy az
                    // oldalra. Ha ezt elrejtenénk, a szünet végén jönne a
                    // meglepetés, hogy az oldal azonnal zár.
                    LimitMeter(site, usage, shared, now, duringPause = true)
                    OutlinedButton(onClick = {
                        BreakerStore.mutate { s ->
                            s.copy(sites = s.sites.map {
                                if (it.id == site.id) it.copy(pauseUntil = null) else it
                            })
                        }
                    }) { Text("Blokkolás visszakapcsolása most") }
                }
                deleting -> {
                    OutlinedButton(onClick = {
                        BreakerStore.mutate { s ->
                            s.copy(sites = s.sites.map {
                                if (it.id == site.id) it.copy(pendingDeleteAt = null) else it
                            })
                        }
                    }) { Text("Törlés visszavonása") }
                }
                else -> {
                    LimitMeter(site, usage, shared, now, duringPause = false)
                    if (!hasSession) {
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        // A műveletek nem főszereplők: keret nélküli szöveggombok,
                        // nem négy egyforma körvonalas gomb. A törlés utolsó, és
                        // egyedül visel hibaszínt — így nem téveszthető össze a
                        // rutinműveletekkel. (Súlyozott térköz itt szándékosan
                        // nincs: telefonszélességen a sor úgyis tördelődik, és a
                        // rugalmas hézag ilyenkor széttolná a tördelt sorokat.)
                        FlowRow(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            TextButton(onClick = onPause) { Text("Feloldás időre…") }
                            TextButton(onClick = onSchedule) { Text("Menetrend…") }
                            TextButton(onClick = onLimit) { Text("Napi keret…") }
                            TextButton(onClick = onAlias) { Text("Fedőnév…") }
                            TextButton(onClick = onRules) {
                                val n = site.rules?.size ?: 0
                                Text(if (n > 0) "Részek · $n" else "Részek…")
                            }
                            TextButton(onClick = onDelete) {
                                Text("Törlés…", color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Állapotjelző a kártya fejlécében.
 *
 * A színt MINDIG kíséri felirat: aki a zöldet és a sárgát nem különbözteti meg,
 * annak is meg kell tudnia, hogy az oldal most tiltva van-e.
 */
@Composable
private fun StatusChip(text: String, tone: Color) {
    Surface(
        color = tone.copy(alpha = 0.14f),
        contentColor = tone,
        shape = MaterialTheme.shapes.small,
        border = BorderStroke(1.dp, tone.copy(alpha = 0.3f)),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

/**
 * Mai keret egy sávon. Kettős kódolás: a szín MELLETT a felirat is kimondja,
 * hogy elfogyott-e — így annak is olvasható, aki a két színt nem különbözteti meg.
 */
@Composable
private fun LimitMeter(
    site: Site, usage: UsageLogic.UsageState, shared: LimitLogic.SharedToday?,
    now: Long, duringPause: Boolean,
) {
    val limit = LimitLogic.normalizeLimit(site.dailyLimitSeconds) ?: return
    // A keret KÖZÖS: a mérő a többi eszköz mai idejét is tartalmazza, különben
    // a felület mást mutatna, mint ami alapján blokkolunk.
    val used = LimitLogic.usedTodayEverywhere(usage, shared, site.domain, now)
    val elsewhere = LimitLogic.sharedTodaySeconds(shared, site.domain, now)
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
        // Enélkül úgy nézne ki, mintha az app rosszul számolna: a telefonon öt
        // perc telt el, a mérő mégis húszat mutat.
        if (elsewhere > 0) {
            Text(
                "Ebből ${UsageLogic.formatDuration(elsewhere)} másik eszközön",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        LinearProgressIndicator(
            progress = { fraction },
            modifier = Modifier.fillMaxWidth(),
            color = if (exhausted) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
        )
    }
}

private val LIMIT_CHOICES_MIN = listOf(10, 20, 30, 45, 60, 90, 120)

/**
 * Részleges szabályok: nem az egész oldal, csak egy darabja.
 *
 * MIÉRT VAN EZ A TELEFONON, HA ITT NEM ÉRVÉNYESÜL. A linket a telefonról
 * másolja ki az ember — onnan oszt meg, ott látja a csatornát. Ha a szabályt
 * csak a gépen lehetne felvenni, a leggyakoribb út lenne a legnehezebb.
 * Amit felveszünk, az a fiókon át a gépre kerül, és ott a böngésző-bővítmény
 * érvényesíti. A felület ezt KI IS MONDJA: nem hazudunk védelmet oda, ahol
 * nincs.
 */
@Composable
private fun RulesDialog(
    site: Site,
    onDismiss: () -> Unit,
    onChanged: () -> Unit,
    onChallenge: () -> Unit,
    onError: (String) -> Unit,
) {
    var input by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val rules = site.rules ?: emptyList()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Csak egy rész: ${AliasLogic.displayName(site)}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Nem az egész oldal, csak egy darabja — például egy csatorna. " +
                        "Illeszd be a címét úgy, ahogy megosztod.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Surface(
                    color = MaterialTheme.colorScheme.error.copy(alpha = 0.10f),
                    contentColor = MaterialTheme.colorScheme.error,
                    shape = MaterialTheme.shapes.small,
                ) {
                    Text(
                        "EZEN A TELEFONON EZ NEM TILT. A telefonos böngészőkben nincs " +
                            "bővítmény-rendszer, a DNS pedig csak a hosztnevet látja — az " +
                            "utat nem. Amit itt felveszel, az a gépeden érvényesül, a " +
                            "böngésző-bővítményen keresztül. Az egész oldal tiltása " +
                            "viszont itt is megkerülhetetlen.",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(10.dp),
                    )
                }
                if (rules.isEmpty()) {
                    Text(
                        "Még nincs egyetlen részleges szabály sem ezen az oldalon.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                for (rule in rules) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            UrlRules.ruleLabel(rule),
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(onClick = {
                            try {
                                val r = Referee.startRuleChange(
                                    site.id, rule, remove = true, now = System.currentTimeMillis(),
                                )
                                if (r.applied) onChanged() else onChallenge()
                            } catch (e: Referee.RefereeException) {
                                onError(e.message ?: "Ismeretlen hiba")
                            }
                        }) { Text("Levétel…") }
                    }
                }
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it; error = null },
                    singleLine = true,
                    label = { Text("pl. ${site.domain}/@valaki") },
                    isError = error != null,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "Felvenni egy koppintás. Levenni próbatétel — ugyanúgy, mint a feloldást.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                error?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                val rule = UrlRules.normalizeRule(input)
                if (rule == null) {
                    // Megmondjuk, mit várunk. Csendben eldobva a felhasználó azt
                    // hinné, hogy felvette a szabályt.
                    error = "Ehhez út is kell, például ${site.domain}/@valaki."
                    return@TextButton
                }
                try {
                    val r = Referee.startRuleChange(
                        site.id, rule, remove = false, now = System.currentTimeMillis(),
                    )
                    input = ""
                    if (r.applied) onChanged() else onChallenge()
                } catch (e: Referee.RefereeException) {
                    error = e.message ?: "Ismeretlen hiba"
                }
            }) { Text("Hozzáadás") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Bezárás") } },
    )
}

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
        title = { Text("Napi keret: ${AliasLogic.displayName(site)}") },
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
    val state by BreakerStore.state.collectAsState()
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
                if (session.kind == Kind.DELETE)
                    "Végleges törlés: ${site?.let { AliasLogic.displayName(it) } ?: ""}"
                else "Feloldás ${session.minutes} percre: ${site?.let { AliasLogic.displayName(it) } ?: ""}",
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

// -------------------------------------------------------------------- fiók

/**
 * Fiók és eszközök közti szinkron.
 *
 * Amit a kártya KIMOND, mert enélkül félreérthető lenne: a blokkolt oldalak és
 * a mért idők titkosítva mennek fel, és a kijelentkezés egyetlen blokkot sem
 * visz el. Az első nélkül a felhasználó abban a hitben lépne be, hogy a
 * listája valahol olvashatóan fekszik; a második nélkül abban a hitben nem
 * merne kilépni.
 */
@Composable
private fun SyncCard(
    state: AppState,
    scope: kotlinx.coroutines.CoroutineScope,
    /**
     * UGYANAZ a címke-tölcsér, mint a saját statisztikáé. Ha a lista rejtve
     * van, a MÁSIK eszköz adata sem nevezheti meg a blokkolt oldalt — enélkül
     * a rejtés pont ott lyukadna ki, ahol senki nem keresi.
     */
    siteLabel: (String) -> String,
) {
    var server by rememberSaveable { mutableStateOf("") }
    var account by rememberSaveable { mutableStateOf("") }
    // A jelszó SZÁNDÉKOSAN nem rememberSaveable: az a mentett példányállapotba
    // kerülne, amit a rendszer lemezre is írhat. Egy elforgatás után újra be kell
    // gépelni — ez a helyes ár.
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var localError by remember { mutableStateOf<String?>(null) }
    var recovery by remember { mutableStateOf<String?>(null) }
    var devices by remember { mutableStateOf<SyncClient.DevicesResult?>(null) }

    /**
     * Minden hálózati művelet háttérszálon; a felület közben letiltva.
     *
     * Nem `run` a neve: az a Kotlin stdlib függvénye, és egy helyi azonos nevű
     * függvény árnyékolná — pont az a fajta csendes zavar, amit egy átnéző nem
     * vesz észre.
     */
    fun background(work: () -> Unit) {
        if (busy) return
        busy = true
        localError = null
        scope.launch(Dispatchers.IO) {
            try {
                work()
            } catch (e: Exception) {
                localError = e.message ?: "Ismeretlen hiba."
            } finally {
                busy = false
            }
        }
    }

    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SectionLabel("Fiók és eszközök")
            val acc = state.sync
            if (acc == null) {
                Text(
                    "Ha ugyanabba a fiókba lépsz be a többi eszközödön is, nem kell mindenhol " +
                        "újra felvenned a listát — és látod a többi eszköz statisztikáját. A " +
                        "blokkolt oldalak és a mért idők titkosítva mennek fel: a kiszolgáló " +
                        "nem látja őket.",
                    style = MaterialTheme.typography.bodySmall,
                )
                // A mező PÁROSÍTÓ KÓDOT is elfogad, nem csak címet. A gépen
                // kiírt öt karaktert begépelni még megteszi az ember; egy
                // IP-címet a legtöbben nem — és pont ott halt meg eddig a
                // szinkron.
                OutlinedTextField(
                    value = server, onValueChange = { server = it },
                    placeholder = { Text("párosító kód a gépről (vagy teljes cím)") },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = account, onValueChange = { account = it },
                    placeholder = { Text("fiókazonosító") },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = password, onValueChange = { password = it },
                    placeholder = { Text("jelszó (legalább 10 karakter)") },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                    visualTransformation = PasswordVisualTransformation(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(enabled = !busy, onClick = {
                        background {
                            val url = Pairing.resolveServerInput(server)
                                ?: throw SyncClient.SyncException(
                                    "Ez nem tűnik érvényes párosító kódnak vagy címnek. " +
                                        "A kód a gépen, a fiókkártyán áll.",
                                    "BAD_SERVER",
                                )
                            val next = SyncClient.signIn(
                                BreakerStore.state.value, url, account.trim(), password, deviceName(),
                            )
                            BreakerStore.mutate { next }
                            password = ""
                            val r = SyncClient.syncNow(BreakerStore.state.value, System.currentTimeMillis())
                            BreakerStore.mutate { r.state }
                        }
                    }) { Text(if (busy) "Belépés…" else "Belépés") }
                    OutlinedButton(enabled = !busy, onClick = {
                        background {
                            val url = Pairing.resolveServerInput(server)
                                ?: throw SyncClient.SyncException(
                                    "Ez nem tűnik érvényes párosító kódnak vagy címnek. " +
                                        "A kód a gépen, a fiókkártyán áll.",
                                    "BAD_SERVER",
                                )
                            val (next, code) = SyncClient.signUp(
                                BreakerStore.state.value, url, account.trim(), password, deviceName(),
                            )
                            BreakerStore.mutate { next }
                            password = ""
                            val r = SyncClient.syncNow(BreakerStore.state.value, System.currentTimeMillis())
                            BreakerStore.mutate { r.state }
                            recovery = code
                        }
                    }) { Text("Új fiók") }
                }
                Text(
                    "Kijelentkezni bármikor lehet, és egyetlen blokkot sem visz el — a szinkron nem kibúvó.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Text("${acc.accountId} — ez az eszköz: ${acc.deviceName}",
                    style = MaterialTheme.typography.bodySmall)
                Text(
                    acc.lastSyncAt?.let { "Legutóbbi szinkron: ${fmtClock(it)}" } ?: "Még nem volt szinkron.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                devices?.let { res ->
                    // Elöl az ÖSSZESÍTETT szám: nem az, hogy mennyi ment el a
                    // gépen és külön mennyi itt, hanem hogy mennyi összesen.
                    // Egy eszköznél nincs mit összesíteni, ott csak zaj lenne.
                    if (res.combined.deviceCount > 1) {
                        DeviceBlock(
                            title = "Mind a(z) ${res.combined.deviceCount} eszköz együtt",
                            todaySeconds = res.combined.todaySeconds,
                            last7Seconds = res.combined.last7Seconds,
                            top = res.combined.top,
                            siteLabel = siteLabel,
                            emphasis = true,
                        )
                    }
                    for (d in res.devices) {
                        DeviceBlock(
                            title = if (d.self) "${d.name} (ez az eszköz)" else d.name,
                            todaySeconds = d.todaySeconds,
                            last7Seconds = d.last7Seconds,
                            top = d.top,
                            siteLabel = siteLabel,
                            emphasis = false,
                        )
                    }
                }
                FlowRowActions(busy = busy,
                    onSync = {
                        background {
                            val r = SyncClient.syncNow(BreakerStore.state.value, System.currentTimeMillis())
                            BreakerStore.mutate { r.state }
                        }
                    },
                    onDevices = {
                        background {
                            devices = SyncClient.pullDevices(BreakerStore.state.value, System.currentTimeMillis())
                        }
                    },
                    onSignOut = {
                        // Nincs megerősítés: a kijelentkezés nem visz el semmit.
                        // Egy „biztos?” azt sugallná, hogy veszélyes.
                        BreakerStore.mutate { SyncClient.signOut(it) }
                        devices = null
                    })
            }
            localError?.let { Text(it, color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall) }
        }
    }

    // A helyreállító kódot EGYSZER látja, és meg is állítjuk vele: ha a jelszót
    // és ezt is elveszti, a kiszolgáló nem tud segíteni — nem lát bele.
    recovery?.let { code ->
        AlertDialog(
            onDismissRequest = { recovery = null },
            title = { Text("Helyreállító kód") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Írd fel, és tedd el biztos helyre:", style = MaterialTheme.typography.bodySmall)
                    Text(code, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
                    Text(
                        "Ha elfelejted a jelszót, EZ az egyetlen út vissza. A kiszolgáló nem tud " +
                            "segíteni, mert nem látja az adataidat.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            },
            confirmButton = { TextButton(onClick = { recovery = null }) { Text("Felírtam") } },
        )
    }
}

/**
 * Egy eszköz (vagy az összes együtt) egy blokkban: mai idő, heti idő, és a hét
 * három legtöbb időt vivő célpontja.
 *
 * A címkék a `siteLabel` tölcséren mennek át — a segéd és a kliens NYERS
 * címkét ad, mert nem tudhatják, hogy a felületen épp rejtve van-e a lista.
 */
@Composable
private fun DeviceBlock(
    title: String,
    todaySeconds: Long,
    last7Seconds: Long,
    top: List<SyncClient.TopTarget>,
    siteLabel: (String) -> String,
    emphasis: Boolean,
) {
    Column(
        Modifier.fillMaxWidth().padding(top = 6.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(
                title,
                style = MaterialTheme.typography.bodySmall,
                fontWeight = if (emphasis) FontWeight.Bold else FontWeight.Normal,
                modifier = Modifier.weight(1f, fill = false),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "ma ${UsageLogic.formatDuration(todaySeconds.toDouble())} · " +
                    "7 nap ${UsageLogic.formatDuration(last7Seconds.toDouble())}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        for (t in top) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(
                    siteLabel(t.label),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f, fill = false),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    UsageLogic.formatDuration(t.seconds.toDouble()),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * A védjegy: MEGSZAKÍTOTT gyűrű — a kör, ami nem zárul be.
 *
 * Rajzolva, nem emojival. Az emoji minden készüléken és minden Android-verzión
 * máshogy néz ki, és egy márkajel nem függhet a rendszer betűkészletétől —
 * ugyanez a döntés az asztali felületen és az ikonon is.
 */
@Composable
private fun BreakerMark(size: Dp = 22.dp) {
    val color = MaterialTheme.colorScheme.onBackground
    Canvas(Modifier.size(size)) {
        val stroke = this.size.minDimension * 0.135f
        val inset = stroke / 2f
        // A rés FELÜL, 72 fokos. Keskenyebbnél apró méretben összezáródna, és a
        // jel sima karikának látszana.
        drawArc(
            color = color,
            startAngle = -90f + 36f,
            sweepAngle = 288f,
            useCenter = false,
            topLeft = Offset(inset, inset),
            size = Size(this.size.width - stroke, this.size.height - stroke),
            style = Stroke(width = stroke, cap = StrokeCap.Round),
        )
    }
}

/**
 * Állapot: halk szöveg + színes pötty.
 *
 * A teljesen színes felirat ugyanakkora hangsúlyt kapott, mint az elsődleges
 * gomb — pedig csak közöl, nem hív cselekvésre. A kettős kódolás megmarad: a
 * jelentést a FELIRAT mondja ki, a szín csak megerősíti.
 */
@Composable
private fun StatusDot(text: String, color: Color) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Canvas(Modifier.size(7.dp)) { drawCircle(color) }
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * Szakaszcím: apró, ritkított, NAGYBETŰS, halk.
 *
 * Eddig ugyanakkora és ugyanolyan sötét volt, mint a tartalom, tehát versenyzett
 * vele. Egy cím dolga az, hogy megnevezze a szakaszt — nem az, hogy elvigye a
 * tekintetet a tartalomról.
 */
@Composable
private fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlowRowActions(busy: Boolean, onSync: () -> Unit, onDevices: () -> Unit, onSignOut: () -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(enabled = !busy, onClick = onSync) { Text(if (busy) "Szinkron…" else "Szinkronizálás most") }
        OutlinedButton(enabled = !busy, onClick = onDevices) { Text("Eszközök") }
        TextButton(enabled = !busy, onClick = onSignOut) { Text("Kijelentkezés") }
    }
}

/**
 * A futó munkamenet kártyája.
 *
 * A telefonon a munkamenet FEHÉRLISTA, és a DNS-szűrő tényleg érvényesíti: ami
 * nincs a csomagon, arra NXDOMAIN a válasz. Ez erősebb, mint amit a gép tud —
 * és pont ezért kell kimondani, mi történik. Enélkül a felhasználó azt látná,
 * hogy „nem jön be semmi”, és hálózati hibát keresne.
 */
@Composable
private fun FocusRunningCard(state: AppState, now: Long, onError: (String) -> Unit) {
    val run = state.focusRun
    if (run == null || !Focus.isRunning(run, now)) return
    val pack = state.focusPacks.firstOrNull { it.id == run.packId } ?: return
    var extra by remember { mutableStateOf("") }

    Card {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            SectionLabel("Munkamenet fut")
            Text(pack.name, style = MaterialTheme.typography.titleMedium)
            Text(
                "Még ${Focus.formatRemaining(run.endsAt - now)} — eddig: ${fmtClock(run.endsAt)}",
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                if (pack.allowSites.isEmpty()) {
                    "Ebben a csomagban nincs engedélyezett oldal — minden más tiltva."
                } else {
                    "Most csak ez mehet: ${pack.allowSites.joinToString(", ")}. Minden más tiltva."
                },
                style = MaterialTheme.typography.bodySmall,
            )
            // A kivétellista LÉTEZÉSÉT kimondjuk. Egy titkos kivétel rosszabb
            // lenne, mint egy nyílt: a felhasználó előbb-utóbb észreveszi, hogy
            // valami mégis átment, és onnantól semmiben nem hisz.
            Text(
                "Az értesítések, a kapcsolat-ellenőrzés és az óra átmennek — enélkül a " +
                    "telefon nem korlátozott lenne, hanem elromlott. Böngészni egyiken sem lehet.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            // HOSSZABBÍTANI ingyen van — ez a szigorítás iránya.
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (min in listOf(15, 30, 60)) {
                    OutlinedButton(onClick = {
                        runCatching {
                            Referee.changeFocus(run.endsAt + min * 60_000L, System.currentTimeMillis())
                        }.onFailure { onError(it.message ?: "Nem sikerült.") }
                    }) { Text("+$min p") }
                }
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = extra,
                    onValueChange = { extra = it.filter { c -> c.isDigit() }.take(4) },
                    label = { Text("perc") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                OutlinedButton(onClick = {
                    val mins = extra.toIntOrNull()
                    if (mins == null || mins < 1) {
                        onError("Írd be percben, mennyivel hosszabbítanád.")
                    } else {
                        runCatching {
                            Referee.changeFocus(
                                run.endsAt + minOf(mins, Focus.MAX_SESSION_MINUTES) * 60_000L,
                                System.currentTimeMillis(),
                            )
                        }.onFailure { onError(it.message ?: "Nem sikerült.") }
                        extra = ""
                    }
                }) { Text("Hozzáad") }
            }
            // LEÁLLÍTANI próbatétel — ugyanaz, mint egy feloldásnál. A gomb
            // csak elindítja; a munkamenet addig ÉRVÉNYES marad, különben a
            // puszta kérés feloldás lenne.
            TextButton(onClick = {
                runCatching { Referee.changeFocus(null, System.currentTimeMillis()) }
                    .onFailure { onError(it.message ?: "Nem sikerült.") }
            }) { Text("Leállítás…") }
            Text(
                "A leállítás próbatétel — ahogy egy feloldás is. A munkamenet a saját " +
                    "idejéig magától lejár.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * A csomagok listája — innen indul egy munkamenet.
 *
 * INDÍTANI ingyen van (ez a szigorítás iránya), LEÁLLÍTANI próbatétel. A
 * hosszat percre pontosan lehet megadni: a gyorsgombok a gyakori eseteket
 * fedik, a mező azt, amikor tudod, hogy negyvenhárom perced van ebédig.
 *
 * A csomagokat a GÉPEN lehet összeállítani — ott látszik a teljes lista, és ott
 * kényelmes gépelni. A telefon indítja és betartatja őket.
 */
@Composable
private fun FocusPacksCard(state: AppState, vpnRunning: Boolean, onError: (String) -> Unit) {
    val now = System.currentTimeMillis()
    if (state.focusPacks.isEmpty()) return
    if (Focus.isRunning(state.focusRun, now)) return

    var minutes by remember { mutableStateOf("") }
    Card {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionLabel("Munkamenet indítása")
            Text(
                "Amíg tart, csak a csomagban felsoroltak jönnek be. Minden más tiltva.",
                style = MaterialTheme.typography.bodySmall,
            )
            // A menetet a DNS-szűrő tartatja be. Ha az nem fut, az indítás
            // CSENDBEN nem csinálna semmit: a felhasználó azt hinné, hogy
            // fókuszban van, közben minden nyitva. Ezt ki kell mondani.
            if (!vpnRunning) {
                Text(
                    "A védelem most nincs bekapcsolva — a munkamenetet a DNS-szűrő tartatja " +
                        "be, tehát addig nem tiltana semmit. Kapcsold be fent.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            OutlinedTextField(
                value = minutes,
                onValueChange = { minutes = it.filter { c -> c.isDigit() }.take(4) },
                label = { Text("Hossz percben (üresen a csomag szokásos hossza)") },
                singleLine = true,
            )
            for (pack in state.focusPacks) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(pack.name, style = MaterialTheme.typography.bodyMedium)
                        Text(
                            if (pack.allowSites.isEmpty()) "nincs engedélyezett oldal"
                            else pack.allowSites.joinToString(", "),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Button(onClick = {
                        // Üres mező = a csomag szokásos hossza. Így az indítás
                        // egy koppintás marad annak, aki nem akar számolni.
                        val mins = minutes.toIntOrNull() ?: pack.defaultMinutes
                        runCatching { Referee.startFocus(pack.id, mins, System.currentTimeMillis()) }
                            .onFailure { onError(it.message ?: "Nem sikerült elindítani.") }
                        minutes = ""
                    }) { Text("Indítás") }
                }
            }
        }
    }
}

private fun deviceName(): String {
    val model = android.os.Build.MODEL ?: "Telefon"
    return model.take(30)
}

private fun fmtClock(ms: Long): String =
    java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(java.util.Date(ms))
