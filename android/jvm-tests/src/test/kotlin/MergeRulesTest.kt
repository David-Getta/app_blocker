import hu.breaker.app.core.SyncMerge
import hu.breaker.app.core.SyncMerge.SyncSite
import hu.breaker.app.core.UrlRules
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Részleges szabályok a szinkronban — a `desktop/test/merge-rules.test.ts` párja.
 *
 * Két kimenetel van, ami rosszabb, mint ha a szabályok egyáltalán nem
 * szinkronizálódnának:
 *
 *   1. egy szabály CSENDBEN eltűnik (a felhasználó azt hiszi, tilt, és nem);
 *   2. egy kifizetett eltávolítás visszajön (a próbatétel értéktelen lesz).
 *
 * A legalattomosabb az első egy változata: EZ AZ APP maga a „régi kliens”, ha
 * nem tud a mezőről. Androidon a szabályokat semmi nem érvényesíti, tárolni és
 * továbbadni viszont KELL őket — enélkül elég egy telefon a fiókban, és a gépen
 * felvett szabályok minden körben eltűnnének.
 */
class MergeRulesTest {

    private fun r(s: String) = UrlRules.normalizeRule(s)!!

    private fun site(
        rev: Int = 1,
        rules: List<UrlRules.UrlRule>? = null,
        updatedAt: Long = 1_000,
        updatedBy: String = "gep-a",
    ) = SyncSite(
        id = "site_1", domain = "youtube.com", hostnames = listOf("youtube.com"),
        addedAt = 1_000, pendingDeleteAt = null, schedule = null, dailyLimitSeconds = null,
        alias = null, rules = rules, rev = rev, updatedAt = updatedAt, updatedBy = updatedBy,
    )

    private fun labels(s: SyncSite) = (s.rules ?: emptyList()).map { it.host + it.path }.sorted()

    @Test fun `rules added on two devices at once are both kept`() {
        // Egyenlő rev: senki nem „újabb”. Ha ilyenkor egy egész listát
        // választanánk, az egyik eszközön felvett szabály némán elveszne.
        val a = site(rev = 5, rules = listOf(r("youtube.com/@egy")))
        val b = site(rev = 5, rules = listOf(r("youtube.com/@ketto")), updatedBy = "telefon")
        assertEquals(listOf("youtube.com/@egy", "youtube.com/@ketto"), labels(SyncMerge.mergeSite(a, b)))
        // Szimmetrikus: minden eszköz ugyanarra jut, különben örökké írnák egymást.
        assertEquals(labels(SyncMerge.mergeSite(a, b)), labels(SyncMerge.mergeSite(b, a)))
    }

    @Test fun `a removal that was paid for is not resurrected`() {
        val before = site(rev = 5, rules = listOf(r("youtube.com/@egy"), r("youtube.com/@ketto")))
        val after = site(rev = 6, rules = listOf(r("youtube.com/@ketto")), updatedAt = 2_000)
        assertEquals(listOf("youtube.com/@ketto"), labels(SyncMerge.mergeSite(before, after)))
        assertEquals(listOf("youtube.com/@ketto"), labels(SyncMerge.mergeSite(after, before)))

        val empty = site(rev = 7, rules = emptyList(), updatedAt = 3_000)
        assertEquals(emptyList(), labels(SyncMerge.mergeSite(after, empty)))
    }

    @Test fun `an app version that does not know the field cannot delete the rules`() {
        // EZ A LEGVESZÉLYESEBB ESET, és Androidon a legvalószínűbb: a szabályokat
        // itt semmi nem érvényesíti, tehát könnyű lenne „nem foglalkozni velük”.
        val mine = site(rev = 5, rules = listOf(r("youtube.com/@egy")))
        val old = site(rev = 9, rules = null, updatedAt = 9_000, updatedBy = "regi")
        assertEquals(listOf("youtube.com/@egy"), labels(SyncMerge.mergeSite(mine, old)),
            "a nagyobb rev sem törölhet olyan mezőt, amiről nem tud")
        assertEquals(listOf("youtube.com/@egy"), labels(SyncMerge.mergeSite(old, mine)))

        // Az ÜRES LISTA viszont valódi állítás: „volt, és levettem”.
        val emptied = site(rev = 9, rules = emptyList(), updatedAt = 9_000)
        assertEquals(emptyList(), labels(SyncMerge.mergeSite(mine, emptied)))
    }

    @Test fun `a site that never had rules stays without the field`() {
        val a = site(rev = 2)
        val b = site(rev = 3, updatedAt = 2_000)
        assertNull(SyncMerge.mergeSite(a, b).rules)
    }

    @Test fun `junk from the other device does not become a rule`() {
        // Egy út nélküli „szabály” az EGÉSZ oldalt jelentené a bővítményben —
        // vagyis a gyengébb réteg többet tiltana, mint amit bárki beállított.
        val a = site(rev = 5, rules = listOf(
            UrlRules.UrlRule("youtube.com", ""),
            UrlRules.UrlRule("", "/@valaki"),
            UrlRules.UrlRule("youtube.com", "/@ok"),
            UrlRules.UrlRule("youtube.com", "/@ok"),
            UrlRules.UrlRule("M.YouTube.com", "/@Masik"),
        ))
        val b = site(rev = 5, updatedBy = "telefon")
        assertEquals(listOf("youtube.com/@masik", "youtube.com/@ok"), labels(SyncMerge.mergeSite(a, b)))
    }

    @Test fun `the rule list cannot grow without bound through sync`() {
        fun many(prefix: String) = (0 until 50).map { r("youtube.com/@$prefix$it") }
        val a = site(rev = 5, rules = many("a"))
        val b = site(rev = 5, rules = many("b"), updatedBy = "telefon")
        assertEquals(UrlRules.MAX_RULES_PER_SITE, SyncMerge.mergeSite(a, b).rules!!.size)
    }

    @Test fun `rules survive a whole-list merge, and the union is stable`() {
        val a = listOf(site(rev = 4, rules = listOf(r("youtube.com/@egy"))))
        val b = listOf(site(rev = 4, rules = listOf(r("youtube.com/@ketto")), updatedBy = "telefon"))
        val once = SyncMerge.mergeLists(a, b)
        assertEquals(listOf("youtube.com/@egy", "youtube.com/@ketto"), labels(once[0]))
        // Kétszer lefuttatva ugyanaz: enélkül a két eszköz felváltva írná felül
        // egymást, és a szinkron sosem érne véget.
        assertEquals(once, SyncMerge.mergeLists(once, b))
        assertEquals(once, SyncMerge.mergeLists(b, once))
    }

    @Test fun `the uploaded JSON keeps the difference between unknown and emptied`() {
        // Ez a különbség a szinkron DRÓTFORMÁJÁN is meg kell maradjon: ha az
        // üres lista és a hiányzó kulcs ugyanúgy nézne ki, a fenti védelem a
        // hálózaton veszne el.
        val unknown = site(rev = 1, rules = null)
        val emptied = site(rev = 1, rules = emptyList())
        val withOne = site(rev = 1, rules = listOf(r("youtube.com/@egy")))

        assertTrue(!SyncClientJson.encode(unknown).contains("\"rules\""), "nincs kulcs, ha nem tudunk róla")
        assertTrue(SyncClientJson.encode(emptied).contains("\"rules\":[]"), "üres lista viszont kimegy")

        assertNull(SyncClientJson.decode(SyncClientJson.encode(unknown)).rules)
        assertEquals(emptyList(), SyncClientJson.decode(SyncClientJson.encode(emptied)).rules)
        assertEquals(listOf("youtube.com/@egy"), labels(SyncClientJson.decode(SyncClientJson.encode(withOne))))
    }
}

/** A `sitesToJson`/`sitesFromJson` egyetlen rekordra, hogy a teszt olvasható maradjon. */
private object SyncClientJson {
    fun encode(s: SyncSite): String =
        hu.breaker.app.core.SyncClient.sitesToJson(listOf(s)).replace(" ", "")

    fun decode(text: String): SyncSite = hu.breaker.app.core.SyncClient.sitesFromJson(text).first()
}
