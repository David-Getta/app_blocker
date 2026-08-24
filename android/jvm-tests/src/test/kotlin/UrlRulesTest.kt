import hu.breaker.app.core.UrlRules
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Részleges tiltás magja — a `desktop/test/urlrules.test.ts` párja.
 *
 * Itt egyetlen hiba két irányba tud sülni, és mindkettő rossz:
 *
 *   - túl szűken fog  -> a felhasználó azt hiszi, letiltotta a csatornát, és az
 *                        mégis megjelenik;
 *   - túl tágan fog   -> letilt valamit, amit nem akart, és nem érti, miért.
 *
 * A második a veszélyesebb, mert bizalmat veszít: ha egyszer véletlenül elvesz
 * valamit, az ember kikapcsolja az egészet.
 *
 * A tesztek szándékosan UGYANAZOK az esetek, mint a TypeScript oldalon. Ha a
 * két mag eltér, ugyanaz a szabály az egyik eszközön fogna, a másikon nem — és
 * semmi nem mondaná meg, melyik a hibás.
 */
class UrlRulesTest {

    private fun rule(input: String) = UrlRules.normalizeRule(input)

    @Test fun `what people actually paste becomes a rule`() {
        assertEquals(UrlRules.UrlRule("youtube.com", "/@valaki"), rule("https://www.youtube.com/@valaki"))
        assertEquals(UrlRules.UrlRule("youtube.com", "/@valaki"), rule("youtube.com/@valaki"))
        // Záró perjel, több perjel, nagybetű: mind ugyanaz a csatorna.
        assertEquals(UrlRules.UrlRule("youtube.com", "/@valaki"), rule("www.YouTube.com//@Valaki/"))
        assertEquals(UrlRules.UrlRule("reddit.com", "/r/hirek"), rule("  reddit.com/r/hirek/  "))
        assertEquals(UrlRules.UrlRule("youtube.com", "/channel/ucabc123"), rule("youtube.com/channel/UCabc123"))
    }

    @Test fun `the query string is dropped, because it names a video and not a channel`() {
        // Ha a `?v=…` bent maradna, a szabály EGYETLEN videóra vonatkozna, a
        // felhasználó viszont azt hinné, hogy a csatornát tiltotta le.
        assertEquals(UrlRules.UrlRule("youtube.com", "/@valaki/videos"),
            rule("https://www.youtube.com/@valaki/videos?x=1&y=2"))
        assertEquals(UrlRules.UrlRule("youtube.com", "/@valaki"), rule("youtube.com/@valaki#rolam"))
    }

    @Test fun `a rule without a path is refused, that would be the whole site`() {
        // Az egész oldal tiltására ott a DNS-szintű blokk. Egy „részleges”
        // szabály, ami mindent tilt, csak félreértés forrása lenne — ráadásul
        // gyengébb is, mert csak a böngészőben él.
        for (bad in listOf("youtube.com", "https://www.youtube.com", "youtube.com/", "youtube.com/?x=1")) {
            assertNull(rule(bad), bad)
        }
    }

    @Test fun `junk is refused rather than turned into something surprising`() {
        for (bad in listOf("", "   ", "/@valaki", "nem egy cím", "youtube.com/@va laki")) {
            assertNull(rule(bad), bad)
        }
        assertNull(rule("youtube.com/" + "a".repeat(UrlRules.MAX_RULE_PATH_LENGTH + 5)))
    }

    @Test fun `a channel is blocked, and a similarly named one is NOT`() {
        // Sztring-előtagként a `/@ab` ráillene a `/@abc`-re is: egy csatorna
        // tiltása csendben letiltana egy másikat, akinek hasonlóan kezdődik a
        // neve — és a felhasználó nem értené, hova tűnt.
        val r = rule("youtube.com/@ab")
        assertNotNull(r)
        assertTrue(UrlRules.matchesRule(r, "https://www.youtube.com/@ab"))
        assertTrue(UrlRules.matchesRule(r, "https://www.youtube.com/@ab/videos"))
        assertTrue(UrlRules.matchesRule(r, "https://www.youtube.com/@ab?tab=1"))
        assertFalse(UrlRules.matchesRule(r, "https://www.youtube.com/@abc"))
        assertFalse(UrlRules.matchesRule(r, "https://www.youtube.com/@abc/videos"))
    }

    @Test fun `a rule pasted from a phone covers the desktop site too`() {
        // Telefonos appban ez a leggyakoribb eset, nem a kivétel: a megosztott
        // link `m.youtube.com`-mal kezdődik.
        assertEquals(UrlRules.UrlRule("youtube.com", "/@valaki"), rule("https://m.youtube.com/@valaki"))
        assertEquals(UrlRules.UrlRule("twitter.com", "/valaki"), rule("mobile.twitter.com/valaki"))
        // Viszont egy `m.`-mel kezdődő VALÓDI domainből nem csinálunk csonkot.
        assertEquals(UrlRules.UrlRule("m.hu", "/valami"), rule("m.hu/valami"))
    }

    @Test fun `the mobile host is the same channel`() {
        val r = rule("youtube.com/@valaki")!!
        assertTrue(UrlRules.matchesRule(r, "https://m.youtube.com/@valaki"))
        assertTrue(UrlRules.matchesRule(r, "https://music.youtube.com/@valaki"))
        // Viszont egy MÁSIK oldal, ami csak a végén hasonlít, nem esik alá.
        assertFalse(UrlRules.matchesRule(r, "https://notyoutube.com/@valaki"))
        assertFalse(UrlRules.matchesRule(r, "https://youtube.com.hamis.hu/@valaki"))
    }

    @Test fun `the front page stays reachable when only a channel is blocked`() {
        // Ez a lényeg: „a YouTube maradjon, de EZ a csatorna ne”. Ha a főoldal
        // is elesne, a részleges tiltás nem különbözne a teljestől.
        val r = rule("youtube.com/@valaki")!!
        for (url in listOf(
            "https://www.youtube.com/",
            "https://www.youtube.com",
            "https://www.youtube.com/watch?v=abc",
            "https://www.youtube.com/@masik",
        )) {
            assertFalse(UrlRules.matchesRule(r, url), url)
        }
    }

    @Test fun `case and trailing slashes never decide whether a rule bites`() {
        val r = rule("youtube.com/@Valaki")!!
        for (url in listOf(
            "https://www.YouTube.com/@valaki",
            "https://www.youtube.com/@VALAKI/",
            "http://youtube.com:443/@Valaki/videos",
            "https://www.youtube.com//@valaki",
        )) {
            assertTrue(UrlRules.matchesRule(r, url), url)
        }
    }

    @Test fun `garbage URLs do not match, instead of matching everything`() {
        // A bizonytalanság a NEM ILLESZKEDÉS felé dől: egy hibás címre ráhúzott
        // szabály olyat venne el, amit a felhasználó nem tiltott.
        val r = rule("youtube.com/@valaki")!!
        for (bad in listOf("", "   ", "about:blank", "chrome://extensions", "nem url")) {
            assertFalse(UrlRules.matchesRule(r, bad), bad)
        }
    }

    @Test fun `a list of rules answers as one`() {
        val rules = listOf(rule("youtube.com/@a")!!, rule("reddit.com/r/hirek")!!)
        assertTrue(UrlRules.anyRuleMatches(rules, "https://youtube.com/@a/videos"))
        assertTrue(UrlRules.anyRuleMatches(rules, "https://old.reddit.com/r/hirek/top"))
        assertFalse(UrlRules.anyRuleMatches(rules, "https://youtube.com/@b"))
        assertFalse(UrlRules.anyRuleMatches(emptyList(), "https://youtube.com/@a"))
    }

    @Test fun `the same rule twice is the same rule, and reads back as typed`() {
        val a = rule("https://www.youtube.com/@valaki/")!!
        val b = rule("youtube.com/@Valaki")!!
        assertTrue(UrlRules.sameRule(a, b))
        assertFalse(UrlRules.sameRule(a, rule("youtube.com/@masik")!!))
        assertEquals("youtube.com/@valaki", UrlRules.ruleLabel(a))
    }
}
