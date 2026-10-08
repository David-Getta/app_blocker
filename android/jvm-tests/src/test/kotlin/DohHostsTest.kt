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
        assertTrue(DohHosts.shouldNote(null, null, "dns.google", t))
        assertFalse(DohHosts.shouldNote("dns.google", t, "dns.google", t + 9 * min))
        assertTrue(DohHosts.shouldNote("dns.google", t, "dns.google", t + 10 * min))
        // Másik név azonnal: a kártya a legutóbbit mondja.
        assertTrue(DohHosts.shouldNote("dns.google", t, "dns.quad9.net", t + 1))
        // Ha az óra visszaugrott, a régi idő nem némítja el.
        assertTrue(DohHosts.shouldNote("dns.google", t, "dns.google", t - 1))
    }

    @Test
    fun theCardSpeaksOnlyOfAFreshUndismissedTrace() {
        val t = 1_000_000_000_000L
        assertNull(DohHosts.cardText(null, null, null, t, true))
        assertNull(DohHosts.cardText("dns.google", t, "dns.google", t, true))
        assertNull(DohHosts.cardText("dns.google", t, null, t + 24 * hour + 1, true))
        assertNull(DohHosts.cardText("dns.google", t + 2 * min, null, t, true))
        // Egy MÁSIK név visszahozza a kártyát.
        val back = DohHosts.cardText("dns.quad9.net", t, "dns.google", t + 5 * min, true)
        assertTrue(back != null && back.contains("dns.quad9.net, 5 perce"), back)
    }

    @Test
    fun theCardNamesTheChromeSettingOnAndroidOnly() {
        val t = 1_000_000_000_000L
        val a = DohHosts.cardText("dns.google", t, null, t, true)!!
        val i = DohHosts.cardText("dns.google", t, null, t, false)!!
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
