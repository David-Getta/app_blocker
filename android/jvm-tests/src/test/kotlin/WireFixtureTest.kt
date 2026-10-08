import hu.breaker.app.core.FocusSync
import hu.breaker.app.core.KeywordLogic
import hu.breaker.app.core.LockdownLogic
import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.SyncClient
import hu.breaker.app.core.SyncMerge
import hu.breaker.app.core.UsageLogic
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A dróton jött rekordok közös fixtúrája (`fixtures/wire-cases.json`, írja a
 * `desktop/test/wire-fixture.test.ts`): egy rossz elem nem viheti a többit, és
 * az Android olvasója (SyncClient.sitesFromJson / focusFromJson) ugyanazt
 * tartja meg belőle, mint a gépé — ugyanazokkal az alapértékekkel, és a
 * kiesett, de látott csomag jelét is ugyanúgy dobja.
 */
class WireFixtureTest {

    private fun fixtureFile(): File {
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            val f = File(dir, "fixtures/wire-cases.json")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        error("fixtures/wire-cases.json nincs meg a tároló gyökerében")
    }

    private val fixture: JSONObject by lazy { JSONObject(fixtureFile().readText()) }

    private fun opt(v: Any?): String = v?.toString() ?: "-"

    private fun siteKey(s: SyncMerge.SyncSite): String =
        "${s.id}|${s.domain}|${s.hostnames.joinToString(",")}|added=${s.addedAt}|del=${opt(s.pendingDeleteAt)}" +
            "|limit=${opt(s.dailyLimitSeconds)}|alias=${opt(s.alias)}|reason=${opt(s.reason)}" +
            "|rev=${s.rev}|at=${s.updatedAt}|by=${s.updatedBy}" +
            "|marks=" + (s.hostnameMarks ?: emptyMap()).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" } +
            "|sched=" + scheduleKey(s.schedule) +
            "|rules=" + (s.rules?.let { list -> "[" + list.joinToString(",") { it.host + it.path } + "]" } ?: "-") +
            "|rmarks=" + (s.ruleMarks ?: emptyMap()).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" } +
            "|loos=${s.deleteLoosens ?: 0}/${s.scheduleLoosens ?: 0}/${s.limitLoosens ?: 0}/${s.burstLoosens ?: 0}"

    /** A menetrend HATÁSA (a döntés normalizálása után), mint a gép kulcsában. */
    private fun scheduleKey(s: ScheduleLogic.Schedule?): String {
        if (s == null) return "-"
        val n = ScheduleLogic.normalize(s)
        val mode = when (n.mode) {
            ScheduleLogic.Mode.ALWAYS -> "always"
            ScheduleLogic.Mode.SCHEDULED_BLOCK -> "scheduled_block"
            ScheduleLogic.Mode.SCHEDULED_ALLOW -> "scheduled_allow"
        }
        return "$mode:" + n.bands.joinToString(";") { b -> b.days.sorted().joinToString(",") + "/" + b.startMin + "/" + b.endMin }
    }

    private fun focusKey(f: FocusSync.SyncFocus): String {
        val packs = f.packs.joinToString(";") { p ->
            val rec = p.recurrence?.let { b -> b.days.sorted().joinToString(",") + "/" + b.startMin + "/" + b.endMin } ?: "-"
            "${p.id}|${p.name}|${p.allowSites.joinToString(",")}|${p.allowApps.joinToString(",")}|${p.defaultMinutes}|$rec"
        }
        val marks = (f.packMarks ?: emptyMap()).toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
        val log = f.log.joinToString(";") { e ->
            "${e.packId}/${e.packName}/${e.startedAt}/${e.endedAt}/${e.plannedEndsAt}" +
                "/${if (e.stopped) 1 else 0}/${if (e.window) 1 else 0}"
        }
        val run = f.run?.let { "${it.packId}/${it.startedAt}/${it.endsAt}" } ?: "-"
        val lock = f.lockdown?.let { "${it.startedAt}/${it.until}" } ?: "-"
        val windows = f.lockdownWindows.joinToString(";") { w -> "${w.id}:${w.days.sorted().joinToString(",")}/${w.startMin}/${w.endMin}" }
        val partner = f.partner?.let { "${it.name}|${it.salt}|${it.hash}|${it.setAt}" } ?: "-"
        val co = f.partnerCo.joinToString(";") { "${it.name}|${it.salt}|${it.hash}|${it.setAt}" }
        val gone = f.partnersGone.joinToString(";") { "${it.id}@${it.at}" }
        return "packs=[$packs] marks=[$marks] log=[$log] rev=${f.rev} at=${f.updatedAt} by=${f.updatedBy}" +
            " run=$run lock=$lock windows=[$windows] wmark=${f.lockdownWindowsRev ?: 0}" +
            " wm=[${LockdownLogic.windowMarksKey(f.lockdownWindowMarks)}]" +
            " kw=[${f.keywords.joinToString(",")}] kmark=${f.keywordsRev ?: 0} kwm=[${KeywordLogic.keywordMarksKey(f.keywordMarks)}]" +
            " partner=$partner pmark=${f.partnerRev ?: 0} co=[$co] gone=[$gone]" +
            " hide=${if (f.hideSiteList) 1 else 0} hmark=${f.hideSiteListRev ?: 0}"
    }

    /** A mérés kulcsa: a napok az egyesített sorrendben, a másodpercek és a címkék rendezve. */
    private fun usageKey(u: UsageLogic.UsageState): String {
        val days = u.days.joinToString(";") { d ->
            d.day + ":{" + d.seconds.toSortedMap().entries.joinToString(",") { "${it.key}=${it.value.toLong()}" } + "}"
        }
        val labels = u.labels.toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
        return "enabled=${if (u.enabled) 1 else 0} days=[$days] labels=[$labels]"
    }

    @Test fun `egy masik eszkoz meresenek olvasasa ugyanaz, mint a gepen`() {
        val cases = fixture.getJSONArray("usage")
        assertTrue(cases.length() > 15, "usage: kevés eset — a fixtúra csonka?")
        val bad = mutableListOf<String>()
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val got = usageKey(UsageLogic.combineUsage(listOf(SyncClient.usageFromJson(c.getString("in")))))
            if (got != c.getString("out")) bad.add("usage #$i: ${c.getString("in")}\n  a gép:   ${c.getString("out")}\n  Android: $got")
        }
        assertEquals(emptyList(), bad.take(8), "${bad.size} eltérés")
    }

    @Test fun `az oldal-lista olvasasa ugyanaz, mint a gepen - egy rossz rekord nem viszi a tobbit`() {
        val cases = fixture.getJSONArray("sites")
        assertTrue(cases.length() > 40, "sites: kevés eset — a fixtúra csonka?")
        val bad = mutableListOf<String>()
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val got = SyncClient.sitesFromJson(c.getString("in")).joinToString("\n") { siteKey(it) }
            if (got != c.getString("out")) bad.add("sites #$i: ${c.getString("in")}\n  a gép:   ${c.getString("out")}\n  Android: $got")
        }
        // Az összes eltérés egyszerre — egy olvasó-szabály több esetet is érint.
        assertEquals(emptyList(), bad.take(8), "${bad.size} eltérés")
    }

    @Test fun `a munkamenet-dokumentum olvasasa ugyanaz, mint a gepen - a kiesett csomag jele is kiesik`() {
        val cases = fixture.getJSONArray("focus")
        assertTrue(cases.length() > 40, "focus: kevés eset — a fixtúra csonka?")
        val bad = mutableListOf<String>()
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val got = focusKey(SyncClient.focusFromJson(c.getString("in"), "gep"))
            if (got != c.getString("out")) bad.add("focus #$i: ${c.getString("in")}\n  a gép:   ${c.getString("out")}\n  Android: $got")
        }
        assertEquals(emptyList(), bad.take(8), "${bad.size} eltérés")
    }
}
