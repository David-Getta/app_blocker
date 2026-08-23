package hu.lakat.app.core

import android.content.Context
import android.content.SharedPreferences
import hu.lakat.app.core.ChallengeEngine.Kind
import hu.lakat.app.core.ChallengeEngine.Step
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
)

data class AppState(
    val protectionOn: Boolean = false,
    val sites: List<Site> = emptyList(),
    val unlockLog: List<Long> = emptyList(),
    val lastCombo: String? = null,
    val session: SessionRec? = null,
    /** active-time tracking history (never leaves the device) */
    val usage: UsageLogic.UsageState = UsageLogic.UsageState(),
)

/**
 * Single source of truth, persisted to app-private SharedPreferences as JSON.
 * The VPN service and the UI both observe [state].
 */
object LakatStore {

    private const val PREFS = "lakat_state"
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

    /** hostnames that must be blocked right now (pause + schedule aware) */
    fun blockedHostnamesNow(now: Long): Set<String> {
        val out = mutableSetOf<String>()
        for (site in _state.value.sites) {
            if (ScheduleLogic.isBlockedNow(site.pauseUntil, site.pendingDeleteAt, site.schedule, now)) {
                out.addAll(site.hostnames)
            }
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
        val days = mutableListOf<UsageLogic.UsageDay>()
        o.optJSONArray("days")?.let { arr ->
            for (i in 0 until arr.length()) {
                val d = arr.getJSONObject(i)
                val secs = mutableMapOf<String, Double>()
                val so = d.getJSONObject("seconds")
                for (k in so.keys()) secs[k] = so.getDouble(k)
                days.add(UsageLogic.UsageDay(d.getString("day"), secs))
            }
        }
        val labels = mutableMapOf<String, String>()
        o.optJSONObject("labels")?.let { lo -> for (k in lo.keys()) labels[k] = lo.getString(k) }
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
        val mode = ScheduleLogic.Mode.valueOf(o.getString("mode"))
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
        put("sites", JSONArray(s.sites.map { site ->
            JSONObject().apply {
                put("id", site.id); put("domain", site.domain)
                put("hostnames", JSONArray(site.hostnames))
                put("addedAt", site.addedAt)
                put("pauseUntil", site.pauseUntil ?: JSONObject.NULL)
                put("pendingDeleteAt", site.pendingDeleteAt ?: JSONObject.NULL)
                put("schedule", site.schedule?.let { scheduleToJson(it) } ?: JSONObject.NULL)
            }
        }))
        put("unlockLog", JSONArray(s.unlockLog))
        put("usage", usageToJson(s.usage))
        put("lastCombo", s.lastCombo ?: JSONObject.NULL)
        put("session", s.session?.let { ses ->
            JSONObject().apply {
                put("id", ses.id); put("kind", ses.kind.name); put("siteId", ses.siteId)
                put("minutes", ses.minutes ?: JSONObject.NULL)
                put("stepIndex", ses.stepIndex); put("createdAt", ses.createdAt)
                put("steps", JSONArray(ses.steps.map { stepToJson(it) }))
                put("pendingSchedule", ses.pendingSchedule?.let { scheduleToJson(it) } ?: JSONObject.NULL)
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

    private fun fromJson(o: JSONObject): AppState {
        val sites = o.optJSONArray("sites")?.let { arr ->
            (0 until arr.length()).map { i ->
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
                )
            }
        } ?: emptyList()
        val unlockLog = o.optJSONArray("unlockLog")?.let { arr ->
            (0 until arr.length()).map { i -> arr.getLong(i) }
        } ?: emptyList()
        val session = if (o.isNull("session")) null else o.getJSONObject("session").let { ses ->
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
            )
        }
        return AppState(
            protectionOn = o.optBoolean("protectionOn", false),
            usage = if (o.isNull("usage")) UsageLogic.UsageState()
                    else usageFromJson(o.getJSONObject("usage")),
            sites = sites,
            unlockLog = unlockLog,
            lastCombo = if (o.isNull("lastCombo")) null else o.optString("lastCombo"),
            session = session,
        )
    }
}
