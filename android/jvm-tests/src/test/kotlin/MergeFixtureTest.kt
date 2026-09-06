import hu.breaker.app.core.FocusSync
import hu.breaker.app.core.SyncClient
import hu.breaker.app.core.SyncMerge
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
        return "hosts=[${s.hostnames.sorted().joinToString(",")}] marks=[$marks] rev=${s.rev}" +
            " pending=${opt(s.pendingDeleteAt)} limit=${opt(s.dailyLimitSeconds)} alias=${opt(s.alias)}" +
            " at=${s.updatedAt} by=${s.updatedBy}"
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
        return "packs=[$packs] run=$run marks=[$marks] rev=${f.rev} at=${f.updatedAt} by=${f.updatedBy}"
    }

    private fun site(o: JSONObject): SyncMerge.SyncSite =
        SyncClient.sitesFromJson(JSONArray().put(o).toString()).single()

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
        }
    }
}
