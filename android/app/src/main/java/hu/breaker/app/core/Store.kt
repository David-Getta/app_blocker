package hu.breaker.app.core

import android.content.Context
import android.content.SharedPreferences
import hu.breaker.app.core.ChallengeEngine.Kind
import hu.breaker.app.core.ChallengeEngine.Step
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class Site(
    val id: String,
    val domain: String,
    val hostnames: List<String>,
    val addedAt: Long,
    val pauseUntil: Long?,
    val pendingDeleteAt: Long?,
    /** optional weekly schedule; null = always blocked */
    val schedule: ScheduleLogic.Schedule? = null,
    /** napi aktív-idő keret másodpercben; null = nincs keret */
    val dailyLimitSeconds: Long? = null,
    /** fedőnév: ha van, a felület ezt írja ki a cím helyett (AliasLogic) */
    val alias: String? = null,
    /**
     * Részleges szabályok: az oldal egy-egy darabja (pl. `/@valaki`).
     *
     * ANDROIDON EZEKET SEMMI NEM ÉRVÉNYESÍTI — a Chrome-nak telefonon nincs
     * bővítmény-rendszere, a DNS-motor pedig a hosztnévnél tovább nem lát.
     * Tárolni és szinkronizálni MÉGIS kell őket, mert enélkül a telefon minden
     * szinkron-körben LETÖRÖLNÉ a gépen felvett szabályokat: ami átmegy egy
     * kliensen, ami nem ismeri a mezőt, abból eltűnik. Lásd
     * docs/feature-partial-block.md.
     */
    val rules: List<UrlRules.UrlRule>? = null,

    // --- szinkron (lásd SyncMerge) ---
    /** hányszor változott érdemben ez a rekord; ez dönt az összefésülésnél */
    val rev: Int = 0,
    /** mikor változott utoljára (ms) */
    val updatedAt: Long = 0,
    /** melyik eszközön — a döntetlen eltörésére */
    val updatedBy: String = "",
    /** a szinkron-mezők lenyomata a legutóbbi léptetéskor */
    val revFp: String? = null,
)

data class SessionRec(
    val id: String,
    val kind: Kind,
    val siteId: String,
    val minutes: Int?,
    val steps: List<Step>,
    val stepIndex: Int,
    val createdAt: Long,
    /** when set, finishing applies this schedule instead of pausing (gated loosening) */
    val pendingSchedule: ScheduleLogic.Schedule? = null,
    /** when set, finishing applies this daily budget instead of pausing;
     *  a -1 érték azt jelenti: „vedd le a keretet” (mindkettő kapuzott lazítás) */
    val pendingLimit: Long? = null,
    /** ha van, a teljesítés EZT a részleges szabályt veszi le (kapuzott lazítás) */
    val pendingRuleRemoval: UrlRules.UrlRule? = null,
    /**
     * Ha van, a teljesítés a MUNKAMENET végét tolja el — vagy leállítja.
     *
     * A -1 azt jelenti: „állítsd le most”. A nulla nem lenne jó jelölés, mert az
     * érvényes időpont. A munkamenet nem egy OLDALHOZ tartozik, hanem az egész
     * készülékhez, ezért a teljesítés ezt az ágat az oldal-keresés ELŐTT nézi.
     */
    val pendingFocusEnd: Long? = null,
)

/**
 * What an abandoned attempt leaves behind, so restarting cannot re-roll it.
 *
 * Kept PER SITE: with a single shared slot, starting and cancelling an attempt
 * on any other site (or the delete flow on the same one) would evict the debt
 * and hand back a fresh draw — the re-roll again, one step removed.
 */
data class AbandonRec(
    val siteId: String,
    val kind: Kind,
    val comboKey: String,
    val at: Long,
)

data class AppState(
    val protectionOn: Boolean = false,
    val sites: List<Site> = emptyList(),
    val unlockLog: List<Long> = emptyList(),
    val lastCombo: String? = null,
    val session: SessionRec? = null,
    /** attempts given up on, per site; see ChallengeEngine.REROLL_COOLDOWN_MS */
    val abandons: List<AbandonRec> = emptyList(),
    /** active-time tracking history (never leaves the device) */
    val usage: UsageLogic.UsageState = UsageLogic.UsageState(),
    /**
     * Mikor rögzítettünk UTOLJÁRA mért időt.
     *
     * A statisztikán a nulla önmagában NÉMA: nem lehet megmondani belőle, hogy
     * tényleg nem használtad a telefont, vagy hogy a mérés hasalt el. Ez a
     * mező teszi különbséggé a kettőt. Helyi diagnosztika, nem adat — a
     * szinkronizált mérés-blobban szándékosan nincs benne, mert a MÁSIK
     * eszközödnek semmit nem mondana arról, hogy itt mikor mértünk.
     */
    val usageLastSampleAt: Long? = null,
    /**
     * Rejtve induljon-e a blokkolt oldalak listája.
     *
     * Beállítás, nem pillanatnyi állapot: a felület minden indításkor rejtve
     * kezdi, és csak a munkamenetre nyitható meg. Így az app megnyitása
     * önmagában nem szembesít azzal, mi van blokkolva.
     */
    val hideSiteList: Boolean = false,
    /** fiók a szinkronhoz; null = nincs bejelentkezve */
    val sync: SyncAccount? = null,
    /**
     * A többi eszköz mai összegzése — ebből lesz a KÖZÖS napi keret.
     *
     * Azért van elmentve, és nem csak a memóriában: ha az appot kilövik, vagy a
     * szinkron épp nem érhető el, a délelőtt a gépen elhasznált keret ne
     * induljon újra nulláról. Elavulni nem tud, mert minden sor a saját napját
     * hozza — éjfélkor magától kiürül.
     */
    val sharedToday: LimitLogic.SharedToday? = null,
    /**
     * Munkamenet-csomagok: „most csak EZ mehet”.
     *
     * A blokklista feketelista, ez FEHÉRLISTA. A telefonon ez erősebb, mint a
     * gépen: a szűrő minden névfeloldást lát. Lásd core/Focus.kt.
     */
    val focusPacks: List<Focus.FocusPack> = emptyList(),
    /** a FUTÓ munkamenet, ha van — a fiók egészére szól, nem eszközönként */
    val focusRun: Focus.FocusRun? = null,
    /**
     * A LEZÁRULT menetek naplója — ebből lesz a statisztika.
     *
     * A telefonon ugyanúgy kell, mint a gépen: a menetet MÁR itt is lehet
     * indítani és leállítani, tehát ha csak a gép naplózna, a telefonon
     * lefutott menetek nem léteznének.
     */
    val focusLog: List<Focus.FocusLogEntry> = emptyList(),
    /** a munkamenet szinkron-számlálója; lásd shared/sync/focus-merge.ts */
    val focusRev: Long = 0,
    val focusUpdatedAt: Long = 0,
    val focusUpdatedBy: String? = null,
    /** a lenyomat, amiből kiderül, hogy változott-e (lásd SyncRevisions) */
    val focusRevFp: String? = null,
    /**
     * Miért nem sikerült a munkamenet szinkronja — vagy null, ha sikerült.
     *
     * NEM MENTJÜK a lemezre: átmeneti állapot, a következő kör újraszámolja.
     * Egy régi mentésből visszatöltött hibaüzenet olyasmiről szólna, ami már
     * nincs. (A mentés itt kézzel felsorolt mezőkből épül, ezért elég nem
     * felvenni; iPhone-on az `AppState` `Codable`-ja mindent elment, ott ez
     * nem megy — lásd az ottani megjegyzést.)
     */
    val focusSyncError: String? = null,
)

/**
 * Fiók a szinkronhoz.
 *
 * Az `dataKey` az app SAJÁT, privát tárában marad (SharedPreferences, csak
 * ennek az appnak olvasható). A végpontok közti titkosítás a KISZOLGÁLÓ ellen
 * véd, nem a saját készüléked ellen.
 */
data class SyncAccount(
    val serverUrl: String,
    val accountId: String,
    val deviceId: String,
    val authKey: String,
    /** az adatkulcs base64-ben */
    val dataKey: String,
    val deviceName: String,
    val lastSyncAt: Long? = null,
    val lastError: String? = null,
)

/**
 * Single source of truth, persisted to app-private SharedPreferences as JSON.
 * The VPN service and the UI both observe [state].
 */
object BreakerStore {

    private const val PREFS = "breaker_state"
    private const val KEY = "state_json"

    private lateinit var prefs: SharedPreferences
    private val _state = MutableStateFlow(AppState())
    val state: StateFlow<AppState> get() = _state

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY, null)?.let { raw ->
            runCatching { _state.value = fromJson(JSONObject(raw)) }
        }
    }

    @Synchronized
    fun mutate(fn: (AppState) -> AppState) {
        // EGYETLEN fogópont a szinkron verziószámaihoz. Kézzel vezetni
        // reménytelen lenne: tucatnyi helyen módosul egy rekord (szünet,
        // menetrend, keret, fedőnév, törlés indítása és visszavonása), és elég
        // egyetlen kihagyott hely ahhoz, hogy egy változás SOSE menjen át a
        // másik eszközre — vagy fordítva, hogy egy régi állapot felülírja az
        // újat.
        val next = SyncRevisions.bump(fn(_state.value), System.currentTimeMillis())
        _state.value = next
        prefs.edit().putString(KEY, toJson(next).toString()).apply()
    }

    fun newId(prefix: String): String = "${prefix}_${UUID.randomUUID().toString().take(12)}"

    /** hostnames that must be blocked right now (pause + schedule + napi keret) */
    fun blockedHostnamesNow(now: Long): Set<String> {
        val state = _state.value
        val out = mutableSetOf<String>()
        for (site in state.sites) {
            if (LimitLogic.isBlockedNowWithLimit(site, state.usage, now, state.sharedToday)) out.addAll(site.hostnames)
        }
        return out
    }

    /**
     * A FUTÓ munkamenet csomagja, ha van — a DNS-szűrő ebből dolgozik.
     *
     * Ha a futás csomagja nincs meg, nem tippelünk: a fehérlista TARTALMA nem
     * az a dolog, amit kitalálni szabad. Ilyenkor `null` jön vissza, tehát a
     * szűrő úgy dönt, mintha nem futna semmi — a blokklista marad. Ez a
     * biztonságos irány: kevesebb kárt okoz, mint mindent eltiltani egy
     * hiányzó rekord miatt.
     */
    fun runningFocusPack(now: Long): Focus.FocusPack? {
        val state = _state.value
        val run = state.focusRun ?: return null
        if (!Focus.isRunning(run, now)) return null
        return state.focusPacks.firstOrNull { it.id == run.packId }
    }

    /** A futó menet maga, ha tényleg fut. */
    fun runningFocus(now: Long): Focus.FocusRun? {
        val run = _state.value.focusRun ?: return null
        return if (Focus.isRunning(run, now)) run else null
    }

    /**
     * A fiókkiszolgáló hosztneve, ha van fiók.
     *
     * A szűrőnek azért kell, mert a munkamenet alatt sem tilthatjuk el: enélkül
     * a telefon nem látná, ha egy MÁSIK eszközön leállítod a menetet.
     */
    fun syncHost(): String? {
        val url = _state.value.sync?.serverUrl ?: return null
        return try {
            java.net.URI(url).host
        } catch (_: Exception) {
            null
        }
    }

    // ------------------------------------------------------------- JSON i/o

    private fun usageToJson(u: UsageLogic.UsageState): JSONObject = JSONObject().apply {
        put("enabled", u.enabled)
        put("days", JSONArray(u.days.map { d ->
            JSONObject().apply {
                put("day", d.day)
                put("seconds", JSONObject().apply { for ((k, v) in d.seconds) put(k, v) })
            }
        }))
        put("labels", JSONObject().apply { for ((k, v) in u.labels) put(k, v) })
    }

    private fun usageFromJson(o: JSONObject): UsageLogic.UsageState {
        // Per-record tolerance, like the rest of fromJson: statistics are the
        // least important thing in this file, and a single malformed day must
        // not be able to take the blocklist down with it.
        val days = mutableListOf<UsageLogic.UsageDay>()
        o.optJSONArray("days")?.let { arr ->
            for (i in 0 until arr.length()) {
                runCatching {
                    val d = arr.getJSONObject(i)
                    val secs = mutableMapOf<String, Double>()
                    val so = d.getJSONObject("seconds")
                    for (k in so.keys()) secs[k] = so.getDouble(k)
                    days.add(UsageLogic.UsageDay(d.getString("day"), secs))
                }
            }
        }
        val labels = mutableMapOf<String, String>()
        o.optJSONObject("labels")?.let { lo ->
            for (k in lo.keys()) runCatching { labels[k] = lo.getString(k) }
        }
        return UsageLogic.UsageState(days, labels, o.optBoolean("enabled", true))
    }

    private fun scheduleToJson(sch: ScheduleLogic.Schedule): JSONObject = JSONObject().apply {
        put("mode", sch.mode.name)
        put("bands", JSONArray(sch.bands.map { b ->
            JSONObject().apply {
                put("days", JSONArray(b.days.toList()))
                put("startMin", b.startMin); put("endMin", b.endMin)
            }
        }))
    }

    /**
     * Részleges szabályok visszaolvasása.
     *
     * A HIÁNYZÓ kulcs `null`-t ad, nem üres listát: a kettő mást jelent (lásd
     * SyncMerge.mergeRules). Minden szabály ugyanazon a magon megy át, mint a
     * kézzel beírt — így egy kézzel szerkesztett állapotfájlból sem kerülhet be
     * olyan alak, amit egyébként sosem fogadnánk el.
     */
    private fun rulesFromJson(s: JSONObject): List<UrlRules.UrlRule>? {
        if (s.isNull("rules")) return null
        val arr = s.optJSONArray("rules") ?: return null
        val out = ArrayList<UrlRules.UrlRule>()
        for (i in 0 until arr.length()) {
            val r = arr.optJSONObject(i) ?: continue
            val norm = UrlRules.normalizeRule(r.optString("host") + r.optString("path")) ?: continue
            if (out.any { UrlRules.sameRule(it, norm) }) continue
            if (out.size >= UrlRules.MAX_RULES_PER_SITE) break
            out.add(norm)
        }
        return out
    }

    private fun scheduleFromJson(o: JSONObject): ScheduleLogic.Schedule {
        // Unknown mode -> ALWAYS, never an exception. valueOf() throws on a mode
        // this build does not know (state written by a newer version, then a
        // downgrade), and the whole load is wrapped in runCatching: one unknown
        // string would silently reset the app to "nothing is blocked". Falling
        // back to always-blocked keeps the failure on the safe side.
        val mode = runCatching { ScheduleLogic.Mode.valueOf(o.getString("mode")) }
            .getOrDefault(ScheduleLogic.Mode.ALWAYS)
        val bandsArr = o.optJSONArray("bands")
        val bands = if (bandsArr == null) emptyList() else (0 until bandsArr.length()).map { i ->
            val bo = bandsArr.getJSONObject(i)
            val daysArr = bo.getJSONArray("days")
            ScheduleLogic.Band(
                days = (0 until daysArr.length()).map { daysArr.getInt(it) }.toSet(),
                startMin = bo.getInt("startMin"), endMin = bo.getInt("endMin"),
            )
        }
        return ScheduleLogic.Schedule(mode, bands)
    }

    private fun toJson(s: AppState): JSONObject = JSONObject().apply {
        put("protectionOn", s.protectionOn)
        put("hideSiteList", s.hideSiteList)
        put("sync", s.sync?.let { a ->
            JSONObject().apply {
                put("serverUrl", a.serverUrl); put("accountId", a.accountId)
                put("deviceId", a.deviceId); put("authKey", a.authKey)
                put("dataKey", a.dataKey); put("deviceName", a.deviceName)
                put("lastSyncAt", a.lastSyncAt ?: JSONObject.NULL)
                put("lastError", a.lastError ?: JSONObject.NULL)
            }
        } ?: JSONObject.NULL)
        put("sites", JSONArray(s.sites.map { site ->
            JSONObject().apply {
                put("id", site.id); put("domain", site.domain)
                put("hostnames", JSONArray(site.hostnames))
                put("addedAt", site.addedAt)
                put("pauseUntil", site.pauseUntil ?: JSONObject.NULL)
                put("pendingDeleteAt", site.pendingDeleteAt ?: JSONObject.NULL)
                put("schedule", site.schedule?.let { scheduleToJson(it) } ?: JSONObject.NULL)
                put("dailyLimitSeconds", site.dailyLimitSeconds ?: JSONObject.NULL)
                put("alias", site.alias ?: JSONObject.NULL)
                // A hiányzó kulcs és az üres tömb KÉT KÜLÖNBÖZŐ dolog: az első
                // azt jelenti, hogy nincs tudomásunk szabályokról, a második
                // azt, hogy voltak és levették. Lásd SyncMerge.mergeRules.
                put("rules", site.rules?.let { rs ->
                    JSONArray(rs.map { r ->
                        JSONObject().apply { put("host", r.host); put("path", r.path) }
                    })
                } ?: JSONObject.NULL)
                put("rev", site.rev)
                put("updatedAt", site.updatedAt)
                put("updatedBy", site.updatedBy)
                put("revFp", site.revFp ?: JSONObject.NULL)
            }
        }))
        put("unlockLog", JSONArray(s.unlockLog))
        put("usage", usageToJson(s.usage))
        put("usageLastSampleAt", s.usageLastSampleAt ?: JSONObject.NULL)
        // A közös napi keret adatai. Kis blob, de blokkolási döntés függ tőle,
        // ezért újraindulás után is meg kell maradnia.
        put("sharedToday", s.sharedToday?.let { sh ->
            JSONObject().apply {
                put("selfDeviceId", sh.selfDeviceId)
                put("devices", JSONArray(sh.devices.map { d ->
                    JSONObject().apply {
                        put("deviceId", d.deviceId); put("day", d.day)
                        put("seconds", JSONObject(d.seconds.mapValues { it.value }))
                    }
                }))
            }
        } ?: JSONObject.NULL)
        // A munkamenet. Blokkolási döntés függ tőle (fehérlista!), ezért
        // újraindulás után is meg kell maradnia — enélkül az app kilövése
        // feloldás lenne, próbatétel nélkül.
        put("focusPacks", JSONArray(s.focusPacks.map { p ->
            JSONObject().apply {
                put("id", p.id); put("name", p.name)
                put("allowSites", JSONArray(p.allowSites))
                put("allowApps", JSONArray(p.allowApps))
                put("defaultMinutes", p.defaultMinutes)
            }
        }))
        put("focusRun", s.focusRun?.let { r ->
            JSONObject().apply {
                put("packId", r.packId); put("startedAt", r.startedAt); put("endsAt", r.endsAt)
            }
        } ?: JSONObject.NULL)
        put("focusLog", JSONArray(s.focusLog.map { e ->
            JSONObject().apply {
                put("packId", e.packId); put("packName", e.packName)
                put("startedAt", e.startedAt); put("endedAt", e.endedAt)
                put("plannedEndsAt", e.plannedEndsAt); put("stopped", e.stopped)
            }
        }))
        put("focusRev", s.focusRev)
        put("focusUpdatedAt", s.focusUpdatedAt)
        put("focusUpdatedBy", s.focusUpdatedBy ?: JSONObject.NULL)
        put("focusRevFp", s.focusRevFp ?: JSONObject.NULL)
        put("lastCombo", s.lastCombo ?: JSONObject.NULL)
        put("abandons", JSONArray(s.abandons.map { a ->
            JSONObject().apply {
                put("siteId", a.siteId); put("kind", a.kind.name)
                put("comboKey", a.comboKey); put("at", a.at)
            }
        }))
        put("session", s.session?.let { ses ->
            JSONObject().apply {
                put("id", ses.id); put("kind", ses.kind.name); put("siteId", ses.siteId)
                put("minutes", ses.minutes ?: JSONObject.NULL)
                put("stepIndex", ses.stepIndex); put("createdAt", ses.createdAt)
                put("steps", JSONArray(ses.steps.map { stepToJson(it) }))
                put("pendingSchedule", ses.pendingSchedule?.let { scheduleToJson(it) } ?: JSONObject.NULL)
                put("pendingLimit", ses.pendingLimit ?: JSONObject.NULL)
                put("pendingRuleRemoval", ses.pendingRuleRemoval?.let { r ->
                    JSONObject().apply { put("host", r.host); put("path", r.path) }
                } ?: JSONObject.NULL)
                // Enélkül egy app-újraindítás a folyamatban lévő LEÁLLÍTÁST
                // közönséges feloldássá változtatná: a próbatétel végén a bíró
                // nem tudná, mit kért a felhasználó.
                put("pendingFocusEnd", ses.pendingFocusEnd ?: JSONObject.NULL)
            }
        } ?: JSONObject.NULL)
    }

    private fun stepToJson(step: Step): JSONObject = JSONObject().apply {
        put("id", step.id)
        when (step) {
            is Step.Transcribe -> { put("type", "TRANSCRIBE"); put("text", step.text) }
            is Step.MathChain -> {
                put("type", "MATH_CHAIN"); put("pos", step.pos)
                put("problems", JSONArray(step.problems.map {
                    JSONObject().put("q", it.q).put("a", it.a)
                }))
            }
            is Step.Memory -> {
                put("type", "MEMORY"); put("code", step.code)
                put("showMs", step.showMs); put("waitMs", step.waitMs)
                put("armedAt", step.armedAt ?: JSONObject.NULL)
            }
            is Step.Reverse -> { put("type", "REVERSE"); put("text", step.text) }
            is Step.Delay -> {
                put("type", "DELAY"); put("minutes", step.minutes)
                put("claimableAt", step.claimableAt ?: JSONObject.NULL)
                put("claimWindowMs", step.claimWindowMs)
            }
        }
    }

    private fun stepFromJson(o: JSONObject): Step {
        val id = o.getString("id")
        return when (o.getString("type")) {
            "TRANSCRIBE" -> Step.Transcribe(id, o.getString("text"))
            "MATH_CHAIN" -> Step.MathChain(
                id,
                o.getJSONArray("problems").let { arr ->
                    (0 until arr.length()).map { i ->
                        val p = arr.getJSONObject(i)
                        ChallengeEngine.Problem(p.getString("q"), p.getLong("a"))
                    }
                },
                o.getInt("pos"),
            )
            "MEMORY" -> Step.Memory(
                id, o.getString("code"), o.getLong("showMs"), o.getLong("waitMs"),
                if (o.isNull("armedAt")) null else o.getLong("armedAt"),
            )
            "REVERSE" -> Step.Reverse(id, o.getString("text"))
            "DELAY" -> Step.Delay(
                id, o.getInt("minutes"),
                if (o.isNull("claimableAt")) null else o.getLong("claimableAt"),
                o.getLong("claimWindowMs"),
            )
            else -> throw IllegalArgumentException("bad step json")
        }
    }

    /**
     * Reads persisted state. Damage is contained per record on purpose: the
     * caller can only fall back to an EMPTY state, which means every block
     * silently disappears — the one outcome this app must never produce by
     * accident. So one unreadable site costs that site, not the list, and an
     * unreadable session costs the unlock attempt in progress (starting over
     * is more friction, never less).
     */
    private fun fromJson(o: JSONObject): AppState {
        val sites = o.optJSONArray("sites")?.let { arr ->
            (0 until arr.length()).mapNotNull { i ->
                runCatching {
                    val s = arr.getJSONObject(i)
                    Site(
                        id = s.getString("id"),
                        domain = s.getString("domain"),
                        hostnames = s.getJSONArray("hostnames").let { hs ->
                            (0 until hs.length()).map { j -> hs.getString(j) }
                        },
                        addedAt = s.getLong("addedAt"),
                        pauseUntil = if (s.isNull("pauseUntil")) null else s.getLong("pauseUntil"),
                        pendingDeleteAt = if (s.isNull("pendingDeleteAt")) null else s.getLong("pendingDeleteAt"),
                        schedule = if (s.isNull("schedule")) null else scheduleFromJson(s.getJSONObject("schedule")),
                        dailyLimitSeconds = if (s.isNull("dailyLimitSeconds")) null else s.getLong("dailyLimitSeconds"),
                        // Betöltéskor is normalizálunk: egy régebbi (vagy kézzel
                        // szerkesztett) állapotból is csak tiszta név jöhet be.
                        alias = AliasLogic.normalize(if (s.isNull("alias")) null else s.optString("alias")),
                        rules = rulesFromJson(s),
                        rev = s.optInt("rev", 0),
                        updatedAt = s.optLong("updatedAt", 0),
                        updatedBy = s.optString("updatedBy", ""),
                        revFp = if (s.isNull("revFp")) null else s.optString("revFp"),
                    )
                }.getOrNull()
            }
        } ?: emptyList()
        val unlockLog = o.optJSONArray("unlockLog")?.let { arr ->
            (0 until arr.length()).mapNotNull { i -> runCatching { arr.getLong(i) }.getOrNull() }
        } ?: emptyList()
        // Egyszer olvassuk ki: a futás érvényessége a csomagoktól függ, és két
        // külön elemzés két külön listát adna, ha a blob közben nem is változik.
        val focusPacks = focusPacksFromJson(o)
        val session = if (o.isNull("session")) null else runCatching {
            o.getJSONObject("session").let { ses ->
                SessionRec(
                    id = ses.getString("id"),
                    kind = Kind.valueOf(ses.getString("kind")),
                    siteId = ses.getString("siteId"),
                    minutes = if (ses.isNull("minutes")) null else ses.getInt("minutes"),
                    steps = ses.getJSONArray("steps").let { arr ->
                        (0 until arr.length()).map { i -> stepFromJson(arr.getJSONObject(i)) }
                    },
                    stepIndex = ses.getInt("stepIndex"),
                    createdAt = ses.getLong("createdAt"),
                    pendingSchedule = if (ses.isNull("pendingSchedule")) null
                        else scheduleFromJson(ses.getJSONObject("pendingSchedule")),
                    pendingLimit = if (ses.isNull("pendingLimit")) null else ses.getLong("pendingLimit"),
                    pendingRuleRemoval = if (ses.isNull("pendingRuleRemoval")) null else {
                        val r = ses.getJSONObject("pendingRuleRemoval")
                        UrlRules.normalizeRule(r.optString("host") + r.optString("path"))
                    },
                    pendingFocusEnd = if (ses.isNull("pendingFocusEnd")) null
                        else ses.getLong("pendingFocusEnd"),
                )
            }
        }.getOrNull()?.takeIf { it.steps.isNotEmpty() && it.stepIndex in it.steps.indices }
        val abandons = o.optJSONArray("abandons")?.let { arr ->
            (0 until arr.length()).mapNotNull { i ->
                runCatching {
                    val a = arr.getJSONObject(i)
                    AbandonRec(
                        siteId = a.getString("siteId"),
                        kind = Kind.valueOf(a.getString("kind")),
                        comboKey = a.getString("comboKey"),
                        at = a.getLong("at"),
                    )
                }.getOrNull()
            }
        } ?: emptyList()
        return AppState(
            protectionOn = o.optBoolean("protectionOn", false),
            usage = if (o.isNull("usage")) UsageLogic.UsageState()
                    else usageFromJson(o.getJSONObject("usage")),
            usageLastSampleAt =
                if (o.isNull("usageLastSampleAt")) null else o.optLong("usageLastSampleAt"),
            sites = sites,
            unlockLog = unlockLog,
            lastCombo = if (o.isNull("lastCombo")) null else o.optString("lastCombo"),
            session = session,
            abandons = abandons,
            hideSiteList = o.optBoolean("hideSiteList", false),
            // Egy sérült fiókbejegyzés a szinkront viszi el, a blokklistát nem:
            // a kettő közül a lista a fontos.
            sync = if (o.isNull("sync")) null else runCatching {
                val a = o.getJSONObject("sync")
                SyncAccount(
                    serverUrl = a.getString("serverUrl"),
                    accountId = a.getString("accountId"),
                    deviceId = a.getString("deviceId"),
                    authKey = a.getString("authKey"),
                    dataKey = a.getString("dataKey"),
                    deviceName = a.optString("deviceName", "Telefon"),
                    lastSyncAt = if (a.isNull("lastSyncAt")) null else a.getLong("lastSyncAt"),
                    lastError = if (a.isNull("lastError")) null else a.optString("lastError"),
                )
            }.getOrNull(),
            // Kívülről jött adat: ha nem a várt alakú, inkább ne legyen. Egy
            // hibás sor itt a blokkolási döntést befolyásolná.
            sharedToday = if (o.isNull("sharedToday")) null else runCatching {
                val sh = o.getJSONObject("sharedToday")
                val arr = sh.optJSONArray("devices") ?: JSONArray()
                val devices = (0 until arr.length()).mapNotNull { i ->
                    val d = arr.getJSONObject(i)
                    val secs = d.optJSONObject("seconds") ?: JSONObject()
                    val map = secs.keys().asSequence().associateWith { k -> secs.optDouble(k, 0.0) }
                    LimitLogic.normalizeTodayDigest(
                        d.optString("day", ""), map, d.optString("deviceId", ""),
                    )
                }
                LimitLogic.SharedToday(sh.getString("selfDeviceId"), devices)
            }.getOrNull(),
            focusPacks = focusPacks,
            // A futás csak akkor él, ha a csomagja megvan: nem tippelünk, mert a
            // fehérlista TARTALMA nem az a dolog, amit kitalálni szabad.
            focusRun = FocusSync.cleanRun(focusRunFromJson(o), focusPacks),
            // A NAPLÓ nem függ a csomagoktól: egy lezárult menet sora akkor is
            // igaz marad, ha a csomagot azóta törölték.
            focusLog = focusLogFromJson(o),
            focusRev = o.optLong("focusRev", 0),
            focusUpdatedAt = o.optLong("focusUpdatedAt", 0),
            focusUpdatedBy = if (o.isNull("focusUpdatedBy")) null else o.optString("focusUpdatedBy"),
            focusRevFp = if (o.isNull("focusRevFp")) null else o.optString("focusRevFp"),
        )
    }

    /** Csomagonként tűrünk: egy sérült sor ne vigye el a többit. */
    private fun focusPacksFromJson(o: JSONObject): List<Focus.FocusPack> {
        val arr = o.optJSONArray("focusPacks") ?: return emptyList()
        val out = mutableListOf<Focus.FocusPack>()
        for (i in 0 until arr.length()) {
            runCatching {
                val p = arr.getJSONObject(i)
                val id = p.optString("id")
                val name = p.optString("name").trim().take(Focus.MAX_PACK_NAME)
                if (id.isEmpty() || name.isEmpty()) return@runCatching
                if (out.any { it.id == id }) return@runCatching
                out.add(Focus.FocusPack(
                    id = id,
                    name = name,
                    allowSites = jsonStrings(p, "allowSites") { Focus.normalizeAllowSite(it) },
                    allowApps = jsonStrings(p, "allowApps") { Focus.normalizeAllowApp(it) },
                    defaultMinutes = Focus.normalizeMinutes(p.optDouble("defaultMinutes")) ?: 25,
                ))
            }
        }
        return out
    }

    /**
     * A napló betöltése. Egy sérült sor nem viheti el a többit — és főleg nem
     * viheti el az egész mentett állapotot.
     */
    private fun focusLogFromJson(o: JSONObject): List<Focus.FocusLogEntry> {
        val arr = o.optJSONArray("focusLog") ?: return emptyList()
        val out = mutableListOf<Focus.FocusLogEntry>()
        for (i in 0 until arr.length()) {
            runCatching {
                val e = arr.getJSONObject(i)
                val packId = e.optString("packId")
                val endedAt = e.optLong("endedAt", 0)
                if (packId.isEmpty() || endedAt <= 0) return@runCatching
                out.add(Focus.FocusLogEntry(
                    packId = packId,
                    packName = e.optString("packName").ifEmpty { "Ismeretlen csomag" },
                    startedAt = e.optLong("startedAt", 0),
                    endedAt = endedAt,
                    plannedEndsAt = e.optLong("plannedEndsAt", endedAt),
                    stopped = e.optBoolean("stopped", false),
                ))
            }
        }
        return FocusSync.capLog(out)
    }

    private fun focusRunFromJson(o: JSONObject): Focus.FocusRun? {
        if (o.isNull("focusRun")) return null
        val r = o.optJSONObject("focusRun") ?: return null
        return Focus.FocusRun(
            packId = r.optString("packId"),
            startedAt = r.optLong("startedAt", 0),
            endsAt = r.optLong("endsAt", 0),
        )
    }

    private fun jsonStrings(
        o: JSONObject, key: String, normalize: (String) -> String?,
    ): List<String> {
        val arr = o.optJSONArray(key) ?: return emptyList()
        val out = mutableListOf<String>()
        for (i in 0 until arr.length()) {
            val n = normalize(arr.optString(i)) ?: continue
            if (out.contains(n) || out.size >= Focus.MAX_ALLOW_ENTRIES) continue
            out.add(n)
        }
        return out
    }
}
