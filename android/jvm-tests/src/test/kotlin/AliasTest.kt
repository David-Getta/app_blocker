import hu.breaker.app.core.AliasLogic
import hu.breaker.app.core.Site
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A fedőnév Kotlin-magja — a `desktop/test/alias.test.ts` tükre.
 *
 * Ugyanazok az esetek ugyanazokkal az elvárásokkal: ha a két mag elcsúszik, a
 * felhasználó ugyanazt az appot kapja két különböző viselkedéssel.
 */
class AliasTest {

    private fun site(domain: String, alias: String? = null) = Site(
        id = "site_1", domain = domain, hostnames = listOf(domain),
        addedAt = 0L, pauseUntil = null, pendingDeleteAt = null, alias = alias,
    )

    @Test
    fun `no alias means the domain is shown`() {
        assertEquals("youtube.com", AliasLogic.displayName(site("youtube.com")))
        assertEquals("youtube.com", AliasLogic.displayName(site("youtube.com", "")))
        assertEquals("youtube.com", AliasLogic.displayName(site("youtube.com", "   ")))
        assertFalse(AliasLogic.isAliased(site("youtube.com", "  ")))
    }

    @Test
    fun `an alias replaces the domain`() {
        val s = site("youtube.com", "A videós")
        assertEquals("A videós", AliasLogic.displayName(s))
        assertTrue(AliasLogic.isAliased(s))
    }

    @Test
    fun `control characters cannot hide inside an alias`() {
        val a = AliasLogic.normalize("A\u0000vide\u001Fós\u007F")
        assertEquals("A vide ós", a)
        assertFalse(a!!.any { it.code < 0x20 || it.code in 0x7f..0x9f })
    }

    @Test
    fun `whitespace is collapsed and trimmed`() {
        assertEquals("A videós", AliasLogic.normalize("  A    videós  "))
        assertEquals("A videós", AliasLogic.normalize("\n\tA videós\n"))
    }

    @Test
    fun `a very long alias is cut, and never left with a trailing space`() {
        val long = "x".repeat(AliasLogic.MAX_ALIAS_LENGTH + 20)
        assertEquals(AliasLogic.MAX_ALIAS_LENGTH, AliasLogic.normalize(long)!!.length)
        // A vágás szóköz közepére eshet; a maradék végén ne maradjon lógó szóköz.
        val spaced = "a".repeat(AliasLogic.MAX_ALIAS_LENGTH - 1) + " bbbb"
        assertEquals("a".repeat(AliasLogic.MAX_ALIAS_LENGTH - 1), AliasLogic.normalize(spaced))
    }

    @Test
    fun `nonsense input is treated as no alias`() {
        assertNull(AliasLogic.normalize(null))
        assertNull(AliasLogic.normalize(" "))
        assertNull(AliasLogic.normalize(""))
    }

    @Test
    fun `a reveal shows the real domain, but only while it lasts`() {
        val s = site("youtube.com", "A videós")
        val now = 1_000_000L
        val until = now + AliasLogic.REVEAL_MS
        assertEquals("youtube.com", AliasLogic.displayNameNow(s, now, until))
        assertEquals("youtube.com", AliasLogic.displayNameNow(s, until - 1, until))
        assertEquals("A videós", AliasLogic.displayNameNow(s, until, until))
        assertEquals("A videós", AliasLogic.displayNameNow(s, now + 60_000, until))
        assertEquals("A videós", AliasLogic.displayNameNow(s, now, null))
    }

    @Test
    fun `a reveal on a site with no alias changes nothing`() {
        assertEquals("reddit.com", AliasLogic.displayNameNow(site("reddit.com"), 0L, 9_999_999L))
    }

    @Test
    fun `a hidden list masks the domain in statistics, but an alias wins`() {
        assertEquals("1. rejtett oldal", AliasLogic.maskedLabel(site("youtube.com"), 0))
        assertEquals("3. rejtett oldal", AliasLogic.maskedLabel(site("reddit.com"), 2))
        assertEquals("A videós", AliasLogic.maskedLabel(site("youtube.com", "A videós"), 0))
    }
}
