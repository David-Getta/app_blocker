import hu.breaker.app.core.BurstLogic
import hu.breaker.app.core.Focus
import hu.breaker.app.core.FocusSync
import hu.breaker.app.core.KeywordLogic
import hu.breaker.app.core.LimitLogic
import hu.breaker.app.core.LockdownLogic
import hu.breaker.app.core.PartnerLogic
import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.SyncClient
import hu.breaker.app.core.Site
import hu.breaker.app.core.SyncMerge
import hu.breaker.app.core.UsageLogic
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Megfelelőség a géppel: a `fixtures/merge-cases.json` a gép által kiszámolt
 * bemeneteket és eredmény-kulcsokat tartja (desktop/test/merge-fixture.test.ts
 * írja és őrzi). Itt ugyanazok a bemenetek a DRÓTON át jönnek (a Kotlin
 * JSON-olvasóján), a Kotlin fésülés számol, és a kulcsnak bájtra egyeznie
 * kell. Ha a tükör egy szabályban elcsúszik, itt bukik — a mag számával.
 *
 * A kulcs formátuma a merge-random.ts `siteConformanceKey` /
 * `focusConformanceKey` párja; a Swift tükör (MergeFixtureTests) ugyanezt.
 */
class MergeFixtureTest {

    private fun fixtureFile(): File {
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            val f = File(dir, "fixtures/merge-cases.json")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        error("fixtures/merge-cases.json nincs meg a tároló gyökerében")
    }

    private fun opt(v: Any?): String = v?.toString() ?: "-"

    private fun siteKey(s: SyncMerge.SyncSite): String {
        val marks = (s.hostnameMarks ?: emptyMap()).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
        // A menetrend a módjával és a sávjaival (tartalom szerint rendezve), az adag
        // a párjával, a szabályok rendezve — és a „nincs mező” (-) más, mint az üres ([]).
        val sched = s.schedule?.let { sc ->
            val mode = when (sc.mode) {
                ScheduleLogic.Mode.ALWAYS -> "always"
                ScheduleLogic.Mode.SCHEDULED_BLOCK -> "scheduled_block"
                ScheduleLogic.Mode.SCHEDULED_ALLOW -> "scheduled_allow"
            }
            mode + ":" + sc.bands.map { LockdownLogic.windowKey(it) }.sorted().joinToString(";")
        } ?: "-"
        val burst = if (s.burstSeconds != null && s.cooldownSeconds != null) "${s.burstSeconds}/${s.cooldownSeconds}" else "-"
        val rules = s.rules?.let { "[" + it.map { r -> r.host + r.path }.sorted().joinToString(",") + "]" } ?: "-"
        return "hosts=[${s.hostnames.sorted().joinToString(",")}] marks=[$marks] rev=${s.rev}" +
            " pending=${opt(s.pendingDeleteAt)} limit=${opt(s.dailyLimitSeconds)} alias=${opt(s.alias)}" +
            " reason=${opt(s.reason)}" +
            " at=${s.updatedAt} by=${s.updatedBy}" +
            " sched=$sched burst=$burst rules=$rules rmark=${s.rulesRev ?: 0}"
    }

    private fun focusKey(f: FocusSync.SyncFocus): String {
        val packs = f.packs.sortedBy { it.id }.joinToString(";") { p ->
            val rec = p.recurrence?.let { b -> b.days.sorted().joinToString(",") + "/" + b.startMin + "/" + b.endMin } ?: "-"
            listOf(
                p.id, p.name, p.allowSites.sorted().joinToString(","), p.allowApps.sorted().joinToString(","),
                p.defaultMinutes.toString(), rec,
            ).joinToString("|")
        }
        val marks = (f.packMarks ?: emptyMap()).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
        val run = f.run?.let { "${it.packId}/${it.startedAt}/${it.endsAt}" } ?: "-"
        val lock = f.lockdown?.let { "${it.startedAt}/${it.until}" } ?: "-"
        // Az ablakok TARTALOM szerint, rendezve: az azonosító és a sorrend nem jelentés.
        val windows = f.lockdownWindows.map { LockdownLogic.windowKey(it.band) }.sorted().joinToString(";")
        return "packs=[$packs] run=$run marks=[$marks] rev=${f.rev} at=${f.updatedAt} by=${f.updatedBy}" +
            " lock=$lock windows=[$windows] wmark=${f.lockdownWindowsRev ?: 0}" +
            " hide=${if (f.hideSiteList) 1 else 0} hmark=${f.hideSiteListRev ?: 0}" +
            " kw=[${KeywordLogic.keywordsKey(f.keywords)}] kmark=${f.keywordsRev ?: 0}" +
            " partner=[${PartnerLogic.partnerKey(f.partner)}] pmark=${f.partnerRev ?: 0}" +
            " log=[" + f.log.joinToString(";") { "${it.packId}/${it.startedAt}/${it.endedAt}/${it.plannedEndsAt}/${if (it.stopped) 1 else 0}/${if (it.window) 1 else 0}" } + "]"
    }

    private fun site(o: JSONObject): SyncMerge.SyncSite =
        SyncClient.sitesFromJson(JSONArray().put(o).toString()).single()

    /** A használati statisztika kulcsa: a napok az egyesített sorrendben, a célok és a címkék rendezve. */
    private fun usageKey(u: UsageLogic.UsageState): String {
        val days = u.days.joinToString(";") { d ->
            d.day + ":{" + d.seconds.toSortedMap().entries.joinToString(",") { "${it.key}=${it.value.toLong()}" } + "}"
        }
        val labels = u.labels.toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
        return "enabled=${if (u.enabled) 1 else 0} days=[$days] labels=[$labels]"
    }

    @Test
    fun `dontes - tilt-e most, ugyanugy mint a gep`() {
        // A napkulcs helyi időben számolódik: a fixtúra UTC-ben készül, dél UTC-s
        // időponttal. Itt kimondjuk az UTC-t, hogy a futtató gép időzónája ne játsszon.
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"))
        val cases = JSONObject(fixtureFile().readText()).getJSONArray("decisions")
        assertTrue(cases.length() >= 50, "a fixture-ben van elég eset")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val seed = c.getInt("seed")
            val now = c.getLong("now")
            val s = c.getJSONObject("site")
            // A menetrend a dróton: a mód szövege és a sávok — mint a SyncClient olvasója.
            val schedule = if (s.isNull("schedule")) null else s.getJSONObject("schedule").let { sc ->
                val mode = when (sc.getString("mode")) {
                    "scheduled_block" -> ScheduleLogic.Mode.SCHEDULED_BLOCK
                    "scheduled_allow" -> ScheduleLogic.Mode.SCHEDULED_ALLOW
                    else -> ScheduleLogic.Mode.ALWAYS
                }
                val bands = sc.getJSONArray("bands")
                ScheduleLogic.Schedule(mode, (0 until bands.length()).map { j ->
                    val b = bands.getJSONObject(j)
                    val days = b.getJSONArray("days")
                    ScheduleLogic.Band((0 until days.length()).map { days.getInt(it) }.toSet(), b.getInt("startMin"), b.getInt("endMin"))
                })
            }
            val site = Site(
                id = "s", domain = s.getString("domain"), hostnames = listOf(s.getString("domain")), addedAt = 0,
                pauseUntil = if (s.isNull("pauseUntil")) null else s.getLong("pauseUntil"),
                pendingDeleteAt = if (s.isNull("pendingDeleteAt")) null else s.getLong("pendingDeleteAt"),
                schedule = schedule,
                dailyLimitSeconds = if (s.isNull("dailyLimitSeconds")) null else s.getLong("dailyLimitSeconds"),
            )
            val usage = SyncClient.usageFromJson(c.getJSONObject("usage").toString())
            val shared = if (c.isNull("shared")) null else c.getJSONObject("shared").let { sh ->
                val devs = sh.getJSONArray("devices")
                LimitLogic.SharedToday(
                    selfDeviceId = sh.getString("selfDeviceId"),
                    devices = (0 until devs.length()).map { j ->
                        val d = devs.getJSONObject(j)
                        val secs = d.getJSONObject("seconds")
                        LimitLogic.TodayDigest(d.getString("deviceId"), d.getString("day"), secs.keys().asSequence().associateWith { secs.getDouble(it) })
                    },
                )
            }
            assertEquals(c.getBoolean("blocked"), LimitLogic.isBlockedNowWithLimit(site, usage, now, shared), "döntés, mag $seed")
        }
    }

    @Test
    fun `adag-szamlalo - ugyanaz a hutes ugyanabbol a meres-sorozatbol, mint a gepen`() {
        // Az iPhone nem mér előteret, ott az adag-szabály nem érvényesül — ez a
        // két mérő nyelv (gép, Android) tükre. Lépésenként: egy eltérés a helyén látszik.
        val cases = JSONObject(fixtureFile().readText()).getJSONArray("bursts")
        assertTrue(cases.length() >= 50, "a fixture-ben van elég eset")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val seed = c.getInt("seed")
            val ro = c.getJSONObject("rule")
            val rule = BurstLogic.Rule(ro.getLong("burstSeconds"), ro.getLong("cooldownSeconds"))
            val samples = c.getJSONArray("samples")
            val expected = c.getJSONArray("states")
            var st: BurstLogic.State? = null
            for (j in 0 until samples.length()) {
                val sm = samples.getJSONObject(j)
                st = BurstLogic.noteUsage(rule, st, sm.getDouble("seconds"), sm.getLong("at"))
                val key = "${st.usedSeconds.toLong()}/${st.lastAt}/${st.cooldownUntil}"
                assertEquals(expected.getString(j), key, "adag, mag $seed, ${j + 1}. minta")
            }
        }
    }

    @Test
    fun `munkamenet-dontes - mi mehet egy menet alatt, ugyanugy mint a referencia`() {
        // A DNS-motor döntése: lista, kulcsszó a hosztnévben, csomag, saját
        // fiókkiszolgáló. A rendszer-infrastruktúra kivétele szándékosan nincs a
        // fixtúrában (a két telefon listája különbözik; a check-infra-allow őrzi).
        val cases = JSONObject(fixtureFile().readText()).getJSONArray("verdicts")
        assertTrue(cases.length() >= 50, "a fixture-ben van elég eset")
        fun strings(a: JSONArray) = (0 until a.length()).map { a.getString(it) }
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val seed = c.getInt("seed")
            val pack = if (c.isNull("pack")) null else c.getJSONObject("pack").let { p ->
                Focus.FocusPack(
                    p.getString("id"), p.getString("name"), strings(p.getJSONArray("allowSites")),
                    strings(p.getJSONArray("allowApps")), p.getInt("defaultMinutes"),
                )
            }
            val run = if (c.isNull("run")) null else c.getJSONObject("run").let { r ->
                Focus.FocusRun(r.getString("packId"), r.getLong("startedAt"), r.getLong("endsAt"))
            }
            val verdict = Focus.verdict(
                c.getString("host"), run, pack, c.getLong("now"), strings(c.getJSONArray("blocked")),
                if (c.isNull("syncHost")) null else c.getString("syncHost"), strings(c.getJSONArray("keywords")),
            )
            val label = when (verdict) {
                Focus.Verdict.ALLOW -> "allow"
                Focus.Verdict.BLOCKED_BY_LIST -> "list"
                Focus.Verdict.BLOCKED_BY_KEYWORD -> "keyword"
                Focus.Verdict.BLOCKED_BY_FOCUS -> "focus"
            }
            assertEquals(c.getString("verdict"), label, "munkamenet-döntés, mag $seed: ${c.getString("host")}")
        }
    }

    @Test
    fun `hasznalat - a Kotlin egyesites ugyanazt adja, mint a gep`() {
        // Az összegző napkulcsa helyi időben jár; a fixtúra UTC-ben készült.
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"))
        val cases = JSONObject(fixtureFile().readText()).getJSONArray("usage")
        assertTrue(cases.length() >= 50, "a fixture-ben van elég eset")
        val tops = { rows: List<UsageLogic.TargetTotal> -> rows.joinToString(",") { "${it.key}=${it.label}=${it.seconds.toLong()}" } }
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val seed = c.getInt("seed")
            val states = listOf("a", "b", "c").map { SyncClient.usageFromJson(c.getJSONObject(it).toString()) }
            val combined = UsageLogic.combineUsage(states)
            assertEquals(c.getString("abc"), usageKey(combined), "használat, három eszköz, mag $seed")
            // AZ ÖSSZEGZŐ: a statisztika képernyőjének számai az egyesített
            // mérésből — ugyanannak kell lenniük, mint a gépen. Holtversenyben a
            // kulcs dönt, mindhárom magban.
            val now = c.getLong("now")
            val want = c.getJSONObject("summary")
            val s = UsageLogic.summarize(combined, now, 8)
            assertEquals(want.getInt("enabled"), if (s.enabled) 1 else 0, "összegző kapcsoló, mag $seed")
            assertEquals(want.getLong("today"), s.todaySeconds.toLong(), "összegző ma, mag $seed")
            assertEquals(want.getLong("yday"), s.yesterdaySeconds.toLong(), "összegző tegnap, mag $seed")
            assertEquals(want.getLong("w7"), s.last7Seconds.toLong(), "összegző hét, mag $seed")
            assertEquals(want.getLong("w30"), s.last30Seconds.toLong(), "összegző hónap, mag $seed")
            assertEquals(want.getString("topToday"), tops(s.topToday), "összegző mai toplista, mag $seed")
            assertEquals(want.getString("weekSites"), tops(s.topWeekSites), "összegző heti oldalak, mag $seed")
            assertEquals(want.getString("weekApps"), tops(s.topWeekApps), "összegző heti appok, mag $seed")
            val mixed = UsageLogic.rank(combined, UsageLogic.totalsForDays(combined, UsageLogic.dayKeysBack(now, 7)), null, 8)
            assertEquals(want.getString("weekMixed"), tops(mixed), "összegző heti vegyes toplista, mag $seed")
            val wow = s.weekOverWeek.joinToString(",") {
                val delta = it.deltaPct?.let { d -> Math.floor(d * 100 + 0.5).toLong().toString() } ?: "-"
                "${it.key}=${it.label}=${it.thisWeek.toLong()}/${it.lastWeek.toLong()}/$delta"
            }
            assertEquals(want.getString("wow"), wow, "összegző a hét az előző héthez, mag $seed")
            assertEquals(want.getInt("days"), s.daysTracked, "összegző napok, mag $seed")
        }
    }

    private fun focus(o: JSONObject): FocusSync.SyncFocus =
        SyncClient.focusFromJson(o.toString(), "x")

    @Test
    fun `oldalak - a Kotlin fesules ugyanazt adja, mint a gep`() {
        val cases = JSONObject(fixtureFile().readText()).getJSONArray("sites")
        assertTrue(cases.length() >= 50, "a fixture-ben van elég eset")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val seed = c.getInt("seed")
            val a = site(c.getJSONObject("a"))
            val b = site(c.getJSONObject("b"))
            val cc = site(c.getJSONObject("c"))
            val ab = SyncMerge.mergeSite(a, b)
            assertEquals(c.getString("ab"), siteKey(ab), "oldal, két eszköz, mag $seed")
            assertEquals(c.getString("abc"), siteKey(SyncMerge.mergeSite(ab, cc)), "oldal, három eszköz, mag $seed")
            // KÖZELI REKORDOK: az a és egy egy mezőben más párja, mindkét sorrendben —
            // a szigorúság-lánc és a döntetlen-törés éles esetei.
            val flip = site(c.getJSONObject("flip"))
            val what = c.getString("what")
            assertEquals(c.getString("af"), siteKey(SyncMerge.mergeSite(a, flip)), "közeli, mag $seed: $what")
            assertEquals(c.getString("fa"), siteKey(SyncMerge.mergeSite(flip, a)), "közeli fordítva, mag $seed: $what")
        }
    }

    @Test
    fun `munkamenet-blob - a Kotlin fesules ugyanazt adja, mint a gep`() {
        val cases = JSONObject(fixtureFile().readText()).getJSONArray("focus")
        assertTrue(cases.length() >= 50, "a fixture-ben van elég eset")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val seed = c.getInt("seed")
            val a = focus(c.getJSONObject("a"))
            val b = focus(c.getJSONObject("b"))
            val cc = focus(c.getJSONObject("c"))
            val ab = FocusSync.merge(a, b)
            assertEquals(c.getString("ab"), focusKey(ab), "munkamenet, két eszköz, mag $seed")
            assertEquals(c.getString("abc"), focusKey(FocusSync.merge(ab, cc)), "munkamenet, három eszköz, mag $seed")
            // EGY MEZŐ CSERÉJE: ugyanazt tartja-e különbségnek a Kotlin, mint a gép —
            // és ami nem jelentés (időbélyeg, eszköznév, ablak-azonosító, a
            // csomagok sorrendje), azt nem. A v0.4.170-ben a Swift kulcsából kimaradt
            // rejtést a fésülés fixtúrája nem látta; ez látja.
            val flip = focus(c.getJSONObject("flip"))
            assertEquals(c.getBoolean("same"), FocusSync.same(a, flip), "különbség, mag $seed: ${c.getString("what")}")
        }
    }

    private fun schedule(o: JSONObject): ScheduleLogic.Schedule {
        val mode = when (o.getString("mode")) {
            "scheduled_block" -> ScheduleLogic.Mode.SCHEDULED_BLOCK
            "scheduled_allow" -> ScheduleLogic.Mode.SCHEDULED_ALLOW
            else -> ScheduleLogic.Mode.ALWAYS
        }
        val bands = o.getJSONArray("bands")
        return ScheduleLogic.Schedule(mode, (0 until bands.length()).map { j ->
            val b = bands.getJSONObject(j)
            val days = b.getJSONArray("days")
            ScheduleLogic.Band((0 until days.length()).map { days.getInt(it) }.toSet(), b.getInt("startMin"), b.getInt("endMin"))
        })
    }

    @Test
    fun `menetrend - a Kotlin ugyanazt donti, mint a gep, UTC-ben`() {
        // A sávok helyi időben értékelődnek ki; a fixtúra UTC-ben készült, és itt
        // is abban jár — kimondva, nem a futtató gép véletlen beállításából. Ez
        // dönt a gépen és a telefonon EGYSZERRE ugyanarról az oldalról: egy
        // elcsúszott sáv-számtan az oldalt az egyiken zárja, a másikon nyitja.
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"))
        val cases = JSONObject(fixtureFile().readText()).getJSONArray("schedules")
        assertTrue(cases.length() >= 60, "a fixture-ben van elég eset")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val seed = c.getInt("seed")
            val s = schedule(c.getJSONObject("schedule"))
            val other = schedule(c.getJSONObject("other"))
            val now = c.getLong("now")
            assertEquals(c.getBoolean("blocked"), ScheduleLogic.isBlockedBySchedule(s, now), "menetrend tilt-e, mag $seed")
            assertEquals(c.getBoolean("loosening"), ScheduleLogic.isLoosening(s, other, now), "menetrend lazítás-e, mag $seed")
        }
    }

    private fun bands(a: JSONArray): List<ScheduleLogic.Band> = (0 until a.length()).map { i ->
        val w = a.getJSONObject(i)
        val days = w.getJSONArray("days")
        ScheduleLogic.Band((0 until days.length()).map { days.getInt(it) }.toSet(), w.getInt("startMin"), w.getInt("endMin"))
    }

    private fun str(c: JSONObject, key: String): String? = if (c.isNull(key)) null else c.getString(key)

    private fun occKey(o: Focus.Occurrence?): String? = o?.let { "${it.startsAt}/${it.endsAt}" }

    private fun lockKey(l: LockdownLogic.Lockdown?): String? = l?.let { "${it.startedAt}/${it.until}" }

    @Test
    fun `zarlat-ablakok - a Kotlin ugyanazt donti, mint a gep, UTC-ben`() {
        // A heti ablak minden eszközön UGYANAKKOR zár és ugyanakkor enged; az
        // előfordulás-számtan helyi időben jár, a fixtúra UTC-ben készült.
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"))
        val cases = JSONObject(fixtureFile().readText()).getJSONArray("windows")
        assertTrue(cases.length() >= 60, "a fixture-ben van elég eset")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val seed = c.getInt("seed")
            val windows = bands(c.getJSONArray("windows"))
            val next = bands(c.getJSONArray("next"))
            val cur = if (c.isNull("cur")) null else c.getJSONObject("cur").let {
                LockdownLogic.Lockdown(it.getLong("startedAt"), it.getLong("until"))
            }
            val now = c.getLong("now")
            val within = c.getLong("within")
            assertEquals(c.getBoolean("free"), LockdownLogic.weekHasFreeTime(windows, now), "szabad idő, mag $seed")
            assertEquals(c.getBoolean("loosening"), LockdownLogic.isWindowsLoosening(windows, next, now), "lazítás, mag $seed")
            assertEquals(str(c, "due"), occKey(LockdownLogic.dueWindow(windows, now)), "élő ablak, mag $seed")
            val lock = LockdownLogic.windowLockdown(cur, windows, now)
            assertEquals(str(c, "lock"), lockKey(lock), "megkövetelt zárlat, mag $seed")
            val probe = lock ?: cur
            val isWin: Boolean? = probe?.let { LockdownLogic.isWindowLockdown(it, windows) }
            val wantWin: Boolean? = if (c.isNull("isWin")) null else c.getBoolean("isWin")
            assertEquals(wantWin, isWin, "ablak-zárlat-e, mag $seed")
            assertEquals(
                str(c, "soon"), occKey(LockdownLogic.windowStartingSoon(cur, windows, now, within)),
                "közelgő ablak, mag $seed",
            )
            val first = windows.firstOrNull()
            val nextOcc = if (first != null && ScheduleLogic.isValidBand(first)) occKey(Focus.nextOccurrence(first, now)) else null
            assertEquals(str(c, "nextOcc"), nextOcc, "következő előfordulás, mag $seed")
        }
    }

    private fun logEntries(a: JSONArray): List<Focus.FocusLogEntry> = (0 until a.length()).map { i ->
        val e = a.getJSONObject(i)
        Focus.FocusLogEntry(
            packId = e.getString("packId"), packName = e.getString("packName"), startedAt = e.getLong("startedAt"),
            endedAt = e.getLong("endedAt"), plannedEndsAt = e.getLong("plannedEndsAt"), stopped = e.getBoolean("stopped"),
            window = e.optBoolean("window", false),
        )
    }

    private fun summaryKey(s: Focus.FocusSummary): String =
        "${s.sessions}/${s.totalMs}/${s.stoppedEarly}/${s.windowRuns}/${s.topPack ?: "-"}"

    @Test
    fun `menetek osszegzese - a Kotlin ugyanazt szamolja a naplobol, mint a gep, UTC-ben`() {
        // A napló a szinkronon utazik; a statisztika és a heti mondat belőle
        // számol. A napkulcs helyi időben jár; a fixtúra UTC-ben készült.
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"))
        val cases = JSONObject(fixtureFile().readText()).getJSONArray("focusLogs")
        assertTrue(cases.length() >= 50, "a fixture-ben van elég eset")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val seed = c.getInt("seed")
            val log = logEntries(c.getJSONArray("log"))
            val now = c.getLong("now")
            val weekAgo = now - 7 * 86_400_000L
            assertEquals(c.getString("week"), summaryKey(Focus.summarizeFocus(log, weekAgo, now)), "a hét összegzője, mag $seed")
            assertEquals(c.getString("prev"), summaryKey(Focus.summarizeFocusPrevWeek(log, now)), "az előző hét összegzője, mag $seed")
            assertEquals(c.getString("byWeekday"), Focus.byWeekday(log, now).joinToString(","), "menet-napok, mag $seed")
            assertEquals(c.getString("byHour"), Focus.byHour(log, now).joinToString(","), "menet-órák, mag $seed")
            assertEquals(c.getInt("streak"), Focus.dayStreak(log, now), "sorozat, mag $seed")
            assertEquals(c.getInt("longest"), Focus.longestStreak(log, now), "leghosszabb sorozat, mag $seed")
            val runs = Focus.windowRunsByPack(log, weekAgo, now).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
            assertEquals(c.getString("runs"), runs, "ablakból indult menetek, mag $seed")
            val series = Focus.daySeries(log, now, 7).joinToString(",") { "${it.first}:${it.second.toLong()}" }
            assertEquals(c.getString("series"), series, "napi rajz, mag $seed")
        }
    }
}
