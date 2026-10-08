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
        rulesRev: Int? = null,
        ruleMarks: Map<String, Int>? = null,
        alias: String? = null,
    ) = SyncSite(
        id = "site_1", domain = "youtube.com", hostnames = listOf("youtube.com"),
        addedAt = 1_000, pendingDeleteAt = null, schedule = null, dailyLimitSeconds = null,
        alias = alias, rules = rules, rev = rev, updatedAt = updatedAt, updatedBy = updatedBy,
        rulesRev = rulesRev, ruleMarks = ruleMarks,
    )

    @Test fun `a free addition with a higher mark does not take the rule the other device added`() {
        // A RÉGI HIBA: a lista egy jellel utazott, és az ingyenes felvétel nagyobb
        // jellel EGÉSZÉBEN vitte a listáját. Szabályonként mindkettő megmarad.
        val a = site(rev = 10, rules = listOf(r("youtube.com/@egy"), r("youtube.com/@t")),
            ruleMarks = mapOf("youtube.com/@t" to 10), rulesRev = 10)
        val b = site(rev = 4, rules = listOf(r("youtube.com/@egy"), r("youtube.com/@s")),
            ruleMarks = mapOf("youtube.com/@s" to 4), rulesRev = 4, updatedBy = "gep-b")
        for (m in listOf(SyncMerge.mergeSite(a, b), SyncMerge.mergeSite(b, a))) {
            assertEquals(listOf("youtube.com/@egy", "youtube.com/@s", "youtube.com/@t"), labels(m))
            assertEquals(mapOf("youtube.com/@s" to 4, "youtube.com/@t" to 10), m.ruleMarks)
            assertEquals(10, m.rulesRev, "a lista-jelből a nagyobb megy tovább — a régi kliensek abból fésülnek")
        }
    }

    @Test fun `per rule the higher mark decides, a later re-add beats the removal, equal marks keep the rule`() {
        val kept = site(rev = 6, rules = listOf(r("youtube.com/@egy")), ruleMarks = mapOf("youtube.com/@egy" to 2))
        val removed = site(rev = 4, rules = emptyList(), ruleMarks = mapOf("youtube.com/@egy" to 4), updatedBy = "gep-b")
        assertEquals(emptyList(), labels(SyncMerge.mergeSite(kept, removed)))
        assertEquals(emptyList(), labels(SyncMerge.mergeSite(removed, kept)))
        val readded = site(rev = 8, rules = listOf(r("youtube.com/@egy")), ruleMarks = mapOf("youtube.com/@egy" to 8))
        assertEquals(listOf("youtube.com/@egy"), labels(SyncMerge.mergeSite(removed, readded)))
        assertEquals(mapOf("youtube.com/@egy" to 8), SyncMerge.mergeSite(readded, removed).ruleMarks)
        val here = site(rev = 4, rules = listOf(r("youtube.com/@egy")), ruleMarks = mapOf("youtube.com/@egy" to 4))
        assertEquals(listOf("youtube.com/@egy"), labels(SyncMerge.mergeSite(removed, here)))
        assertEquals(listOf("youtube.com/@egy"), labels(SyncMerge.mergeSite(here, removed)))
    }

    @Test fun `three devices in any order agree, an old client among them too`() {
        val old = site(rev = 9, updatedBy = "telefon")
        val d = site(rev = 2, rules = listOf(r("youtube.com/@egy")), ruleMarks = mapOf("youtube.com/@egy" to 2), rulesRev = 2)
        val e = site(rev = 3, rules = emptyList(), ruleMarks = mapOf("youtube.com/@egy" to 3), rulesRev = 3, updatedBy = "gep-b")
        val f = site(rev = 5, rules = listOf(r("youtube.com/@ketto")), ruleMarks = mapOf("youtube.com/@ketto" to 5),
            rulesRev = 5, updatedBy = "gep-c")
        val m = SyncMerge::mergeSite
        for (x in listOf(m(m(m(old, d), e), f), m(m(m(f, e), d), old), m(m(old, f), m(e, d)), m(m(d, f), m(old, e)))) {
            assertEquals(listOf("youtube.com/@ketto"), labels(x))
            assertEquals(mapOf("youtube.com/@egy" to 3, "youtube.com/@ketto" to 5), x.ruleMarks)
            assertEquals(5, x.rulesRev)
        }
    }

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
        // A levétel SÍRKÖVET kap: a szabály jele a rev, amelyik levette.
        val before = site(rev = 5, rules = listOf(r("youtube.com/@egy"), r("youtube.com/@ketto")))
        val after = site(rev = 6, rules = listOf(r("youtube.com/@ketto")), updatedAt = 2_000,
            ruleMarks = mapOf("youtube.com/@egy" to 6))
        assertEquals(listOf("youtube.com/@ketto"), labels(SyncMerge.mergeSite(before, after)))
        assertEquals(listOf("youtube.com/@ketto"), labels(SyncMerge.mergeSite(after, before)))
        assertEquals(mapOf("youtube.com/@egy" to 6), SyncMerge.mergeSite(before, after).ruleMarks, "a sírkő utazik tovább")

        val empty = site(rev = 7, rules = emptyList(), updatedAt = 3_000,
            ruleMarks = mapOf("youtube.com/@egy" to 6, "youtube.com/@ketto" to 7))
        assertEquals(emptyList(), labels(SyncMerge.mergeSite(after, empty)))
        assertEquals(emptyList(), labels(SyncMerge.mergeSite(before, empty)))

        // A régi eszköz ingyenes szerkesztései (nagyobb rev) sem hozzák vissza.
        val busy = site(rev = 40, rules = listOf(r("youtube.com/@egy"), r("youtube.com/@ketto")), alias = "tube", updatedBy = "gep-b")
        assertEquals(listOf("youtube.com/@ketto"), labels(SyncMerge.mergeSite(busy, after)))
        assertEquals("tube", SyncMerge.mergeSite(busy, after).alias, "a fedőnév a frissebb rekordé")
    }

    @Test fun `an app version that does not know the field cannot delete the rules`() {
        // EZ A LEGVESZÉLYESEBB ESET, és Androidon a legvalószínűbb: a szabályokat
        // itt semmi nem érvényesíti, tehát könnyű lenne „nem foglalkozni velük”.
        val mine = site(rev = 5, rules = listOf(r("youtube.com/@egy")))
        val old = site(rev = 9, rules = null, updatedAt = 9_000, updatedBy = "regi")
        assertEquals(listOf("youtube.com/@egy"), labels(SyncMerge.mergeSite(mine, old)),
            "a nagyobb rev sem törölhet olyan mezőt, amiről nem tud")
        assertEquals(listOf("youtube.com/@egy"), labels(SyncMerge.mergeSite(old, mine)))

        // Az üres lista a SÍRKÖVEIVEL valódi állítás: „volt, és levettem”.
        val emptied = site(rev = 9, rules = emptyList(), updatedAt = 9_000, ruleMarks = mapOf("youtube.com/@egy" to 9))
        assertEquals(emptyList(), labels(SyncMerge.mergeSite(mine, emptied)))
        // Sírkő nélkül viszont nem: egyenlő jelnél a jelenlét nyer.
        val unmarked = site(rev = 9, rules = emptyList(), updatedAt = 9_000)
        assertEquals(listOf("youtube.com/@egy"), labels(SyncMerge.mergeSite(mine, unmarked)))
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

        // A jelek a listával utaznak, a sírkő is — lista nélkül nincs jel.
        val marked = site(rev = 3, rules = emptyList(), ruleMarks = mapOf("youtube.com/@egy" to 3))
        assertEquals(mapOf("youtube.com/@egy" to 3), SyncClientJson.decode(SyncClientJson.encode(marked)).ruleMarks)
        assertNull(SyncClientJson.decode(SyncClientJson.encode(marked.copy(rules = null))).ruleMarks)
    }
}

/** A `sitesToJson`/`sitesFromJson` egyetlen rekordra, hogy a teszt olvasható maradjon. */
private object SyncClientJson {
    fun encode(s: SyncSite): String =
        hu.breaker.app.core.SyncClient.sitesToJson(listOf(s)).replace(" ", "")

    fun decode(text: String): SyncSite = hu.breaker.app.core.SyncClient.sitesFromJson(text).first()
}
