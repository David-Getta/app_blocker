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
     * Rejtve induljon-e a blokkolt oldalak listája.
     *
     * Beállítás, nem pillanatnyi állapot: a felület minden indításkor rejtve
     * kezdi, és csak a munkamenetre nyitható meg. Így az app megnyitása
     * önmagában nem szembesít azzal, mi van blokkolva.
     */
    val hideSiteList: Boolean = false,
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
        val next = fn(_state.value)
        _state.value = next
        prefs.edit().putString(KEY, toJson(next).toString()).apply()
    }

    fun newId(prefix: String): String = "${prefix}_${UUID.randomUUID().toString().take(12)}"

    /** hostnames that must be blocked right now (pause + schedule + napi keret) */
    fun blockedHostnamesNow(now: Long): Set<String> {
        val state = _state.value
        val out = mutableSetOf<String>()
        for (site in state.sites) {
            if (LimitLogic.isBlockedNowWithLimit(site, state.usage, now)) out.addAll(site.hostnames)
        }
        return out
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
            }
        }))
        put("unlockLog", JSONArray(s.unlockLog))
        put("usage", usageToJson(s.usage))
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
                    )
                }.getOrNull()
            }
        } ?: emptyList()
        val unlockLog = o.optJSONArray("unlockLog")?.let { arr ->
            (0 until arr.length()).mapNotNull { i -> runCatching { arr.getLong(i) }.getOrNull() }
        } ?: emptyList()
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
            sites = sites,
            unlockLog = unlockLog,
            lastCombo = if (o.isNull("lastCombo")) null else o.optString("lastCombo"),
            session = session,
            abandons = abandons,
            hideSiteList = o.optBoolean("hideSiteList", false),
        )
    }
}
