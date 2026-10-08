import hu.breaker.app.core.DohCanary
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** A Firefox kanárija: csak a pontos név — egy aldomain vagy hasonló név nem. */
class DohCanaryTest {
    @Test
    fun theCanaryMatchesInAnyCaseAndWithTheRootDot() {
        assertTrue(DohCanary.matches("use-application-dns.net"))
        assertTrue(DohCanary.matches("Use-Application-DNS.net"))
        assertTrue(DohCanary.matches("use-application-dns.net."))
    }

    @Test
    fun nothingElseMatches() {
        for (n in listOf("www.use-application-dns.net", "use-application-dns.net.evil.com",
            "application-dns.net", "dns.google", "", "net")) {
            assertFalse(DohCanary.matches(n), n)
        }
    }
}
