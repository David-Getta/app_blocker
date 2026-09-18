import hu.breaker.app.core.Blocklist
import org.json.JSONArray
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Kategória-csomagok: ugyanaz a lista, mint a gépen. A `fixtures/category-packs.json`
 * a gép tesztjének írása; itt ehhez mérjük a Kotlin listát, sorrendestül.
 */
class CategoryPacksTest {

    private fun fixtureFile(): File {
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            val f = File(dir, "fixtures/category-packs.json")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        error("fixtures/category-packs.json nincs meg a tároló gyökerében")
    }

    @Test fun theListMatchesTheDesktop() {
        val arr = JSONArray(fixtureFile().readText())
        assertEquals(arr.length(), Blocklist.CATEGORY_PACKS.size, "csomagok száma")
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val p = Blocklist.CATEGORY_PACKS[i]
            assertEquals(o.getString("key"), p.key)
            assertEquals(o.getString("label"), p.label)
            val d = o.getJSONArray("domains")
            assertEquals((0 until d.length()).map { d.getString(it) }, p.domains, "${p.key}: domainek")
        }
    }

    @Test fun everyDomainIsAlreadyCleanAndListedOnce() {
        val seen = HashSet<String>()
        for (p in Blocklist.CATEGORY_PACKS) {
            assertTrue(p.domains.size >= 3, "${p.key}: üres csomag")
            for (d in p.domains) {
                assertEquals(d, Blocklist.normalizeDomain(d), "${p.key}: $d nem a tiszta alak")
                assertTrue(seen.add(d), "$d két csomagban is")
            }
        }
    }
}
