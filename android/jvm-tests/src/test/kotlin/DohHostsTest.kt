import hu.breaker.app.core.DohHosts
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A titkosított DNS nyoma: melyik név számít, mikor jegyezzük fel újra, és mit
 * mond a kártya. A tükör: ios/SharedTests/DohHostsTests.swift.
 */
class DohHostsTest {
    private val min = 60_000L
    private val hour = 60 * min

    @Test
    fun knownNamesMatchInAnyCaseAndWithTheRootDot() {
        assertEquals("dns.google", DohHosts.hostOf("dns.google"))
        assertEquals("dns.google", DohHosts.hostOf("DNS.Google."))
        assertEquals("cloudflare-dns.com", DohHosts.hostOf("cloudflare-dns.com"))
        assertEquals("mozilla.cloudflare-dns.com", DohHosts.hostOf("mozilla.cloudflare-dns.com"))
        assertTrue(DohHosts.matches("dns.quad9.net"))
        assertTrue(DohHosts.matches("doh.opendns.com"))
        // A Chromium listájának DoT-nevei és szolgáltatói is (doh_provider_entry.cc).
        for (n in listOf("dot.xfinity.com", "dot.cox.net", "doh.quickline.ch", "dot.quickline.ch",
            "doh-01.spectrum.com", "doh-02.spectrum.com")) {
            assertTrue(DohHosts.matches(n), n)
        }
    }

    @Test
    fun perProfileNamesMatchBySuffix() {
        assertEquals("abc123.dns.nextdns.io", DohHosts.hostOf("abc123.dns.nextdns.io"))
        assertTrue(DohHosts.matches("x9.dns.controld.com"))
    }

    @Test
    fun ordinaryAndLookalikeNamesDoNotMatch() {
        for (n in listOf("google.com", "www.google.com", "dns.google.evil.com", "evildns.google",
            "nextdns.io", "dns.nextdns.io.evil.com", "xdns.nextdns.io.com", "cloudflare.com",
            "use-application-dns.net", "", ".")) {
            assertFalse(DohHosts.matches(n), n)
        }
    }

    @Test
    fun theSameNameIsNotedAgainOnlyAfterTenMinutes() {
        val t = 1_000_000_000_000L
        val none = emptyList<String>()
        assertTrue(DohHosts.shouldNote(null, null, "dns.google", t, none))
        assertFalse(DohHosts.shouldNote("dns.google", t, "dns.google", t + 9 * min, none))
        assertTrue(DohHosts.shouldNote("dns.google", t, "dns.google", t + 10 * min, none))
        // Másik név azonnal: a kártya a legutóbbit mondja.
        assertTrue(DohHosts.shouldNote("dns.google", t, "dns.quad9.net", t + 1, none))
        // Ha az óra visszaugrott, a régi idő nem némítja el.
        assertTrue(DohHosts.shouldNote("dns.google", t, "dns.google", t - 1, none))
    }

    @Test
    fun aDismissedNameDoesNotPushOutAnUnseenTrace() {
        // A Chrome a dns.google-t kérdezi, erre már „értem”; aztán a Firefox a
        // Cloudflare-t. A Chrome következő kérdése nem tüntetheti el a Cloudflare-t.
        val t = 1_000_000_000_000L
        val dismissed = listOf("dns.google")
        assertTrue(DohHosts.shouldNote("dns.google", t, "mozilla.cloudflare-dns.com", t + min, dismissed))
        assertFalse(DohHosts.shouldNote("mozilla.cloudflare-dns.com", t + min, "dns.google", t + 30 * min, dismissed))
        assertFalse(DohHosts.shouldNote(null, null, "dns.google", t, dismissed))
        assertTrue(DohHosts.cardText("mozilla.cloudflare-dns.com", t + min, dismissed, t + 30 * min, true) != null)
    }

    @Test
    fun dismissKeepsEveryNameUpToTheCap() {
        assertEquals(listOf("dns.google"), DohHosts.dismiss(emptyList(), "dns.google"))
        assertEquals(listOf("dns.google"), DohHosts.dismiss(listOf("dns.google"), "dns.google"))
        assertEquals(listOf("dns.google"), DohHosts.dismiss(listOf("dns.google"), null))
        // A második „értem” nem oldja fel az elsőt.
        val two = DohHosts.dismiss(listOf("dns.google"), "dns.quad9.net")
        assertEquals(listOf("dns.google", "dns.quad9.net"), two)
        val full = (1..DohHosts.MAX_DISMISSED).map { "h$it.dns.nextdns.io" }
        val more = DohHosts.dismiss(full, "dns.sb")
        assertEquals(DohHosts.MAX_DISMISSED, more.size)
        assertEquals("h2.dns.nextdns.io", more.first(), "a legrégebbi esik ki")
        assertEquals("dns.sb", more.last())
    }

    @Test
    fun theCardSpeaksOnlyOfAFreshUndismissedTrace() {
        val t = 1_000_000_000_000L
        val none = emptyList<String>()
        assertNull(DohHosts.cardText(null, null, none, t, true))
        assertNull(DohHosts.cardText("dns.google", t, listOf("dns.google"), t, true))
        assertNull(DohHosts.cardText("dns.google", t, none, t + 24 * hour + 1, true))
        assertNull(DohHosts.cardText("dns.google", t + 2 * min, none, t, true))
        // Egy MÁSIK név visszahozza a kártyát.
        val back = DohHosts.cardText("dns.quad9.net", t, listOf("dns.google"), t + 5 * min, true)
        assertTrue(back != null && back.contains("dns.quad9.net, 5 perce"), back)
    }

    @Test
    fun theCardNamesTheChromeSettingOnAndroidOnly() {
        val t = 1_000_000_000_000L
        val a = DohHosts.cardText("dns.google", t, emptyList(), t, true)!!
        val i = DohHosts.cardText("dns.google", t, emptyList(), t, false)!!
        assertTrue(a.startsWith("Valami a telefonon titkosított DNS-kiszolgálót keresett (dns.google, épp most)."), a)
        assertTrue(a.contains("Biztonságos DNS használata"), a)
        assertTrue(i.startsWith("Valami az eszközön"), i)
        assertTrue(i.contains("DNS-profil") && !i.contains("Chrome"), i)
        assertTrue(a.endsWith("A Breaker csak a nevet látja, azt nem, ki kérdezte."), a)
        assertTrue(i.endsWith("A Breaker csak a nevet látja, azt nem, ki kérdezte."), i)
    }

    @Test
    fun agoTextUsesMinutesThenHours() {
        assertEquals("épp most", DohHosts.agoText(0))
        assertEquals("épp most", DohHosts.agoText(-5 * min))
        assertEquals("épp most", DohHosts.agoText(119_999))
        assertEquals("2 perce", DohHosts.agoText(2 * min))
        assertEquals("59 perce", DohHosts.agoText(59 * min))
        assertEquals("1 órája", DohHosts.agoText(60 * min))
        assertEquals("23 órája", DohHosts.agoText(23 * hour + 59 * min))
    }
}
