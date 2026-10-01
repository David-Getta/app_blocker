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
            val site = Site(
                id = "s", domain = s.getString("domain"), hostnames = listOf(s.getString("domain")), addedAt = 0,
                pauseUntil = if (s.isNull("pauseUntil")) null else s.getLong("pauseUntil"),
                pendingDeleteAt = if (s.isNull("pendingDeleteAt")) null else s.getLong("pendingDeleteAt"),
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
    fun `hasznalat - a Kotlin egyesites ugyanazt adja, mint a gep`() {
        val cases = JSONObject(fixtureFile().readText()).getJSONArray("usage")
        assertTrue(cases.length() >= 50, "a fixture-ben van elég eset")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val seed = c.getInt("seed")
            val states = listOf("a", "b", "c").map { SyncClient.usageFromJson(c.getJSONObject(it).toString()) }
            assertEquals(c.getString("abc"), usageKey(UsageLogic.combineUsage(states)), "használat, három eszköz, mag $seed")
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
}
