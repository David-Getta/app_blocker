import hu.breaker.app.core.Focus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A munkamenet magja Androidon.
 *
 * A telefonon a fehérlistát a DNS-szűrő érvényesíti, tehát ez a néhány függvény
 * dönti el, mi jön be és mi nem. Két hibafajta van, és mindkettő rossz:
 *
 *   - túl SZŰK: a telefon használhatatlan lesz (nem jön értesítés, a rendszer
 *     hálózati hibát jelez), és a felhasználó az appot fogja hibásnak tartani;
 *   - túl TÁG: a munkamenet nem ér semmit, mert a `notgoogle.com` átcsúszik.
 */
class FocusTest {

    private fun pack(vararg sites: String) = Focus.FocusPack(
        id = "pack_1",
        name = "Nyelvtanulás",
        allowSites = sites.toList(),
        allowApps = listOf("Word"),
        defaultMinutes = 50,
    )

    private val noBlocklist = emptyList<String>()

    @Test
    fun `aldomain atmegy, a vegen hasonlito nev nem`() {
        val p = pack("google.com")
        assertTrue(Focus.isSiteAllowed(p, "translate.google.com"))
        assertTrue(Focus.isSiteAllowed(p, "google.com"))
        // Ez a megtévesztés klasszikus alakja: a végén stimmel, mégis más
        // tartomány. Ha ez átmenne, a fehérlista bármivel megkerülhető lenne.
        assertFalse(Focus.isSiteAllowed(p, "notgoogle.com"))
        assertFalse(Focus.isSiteAllowed(p, "google.com.evil.example"))
    }

    @Test
    fun `a blokklista eros a munkamenetnel`() {
        // A csomagba felvett tiltott oldal NEM oldódik fel. Enélkül a
        // munkamenet lenne a kiskapu a blokklistán: felveszem a youtube.com-ot
        // egy csomagba, elindítom, és próbatétel nélkül megnyílik.
        val p = pack("youtube.com")
        val run = Focus.FocusRun("pack_1", 0L, 10_000L)
        assertEquals(
            Focus.Verdict.BLOCKED_BY_LIST,
            Focus.verdict("youtube.com", run, p, 1_000L, listOf("youtube.com")),
        )
    }

    @Test
    fun `munkamenet nelkul minden mehet, amit a blokklista enged`() {
        assertEquals(
            Focus.Verdict.ALLOW,
            Focus.verdict("example.com", null, null, 1_000L, noBlocklist),
        )
        // Lejárt munkamenet ugyanaz, mint a nincs: a fehérlista nem ragad be.
        val expired = Focus.FocusRun("pack_1", 0L, 500L)
        assertEquals(
            Focus.Verdict.ALLOW,
            Focus.verdict("example.com", expired, pack("a.com"), 1_000L, noBlocklist),
        )
    }

    @Test
    fun `munkamenet alatt a listan kivul minden tiltva`() {
        val p = pack("quizlet.com")
        val run = Focus.FocusRun("pack_1", 0L, 10_000L)
        assertEquals(
            Focus.Verdict.ALLOW,
            Focus.verdict("quizlet.com", run, p, 1_000L, noBlocklist),
        )
        assertEquals(
            Focus.Verdict.BLOCKED_BY_FOCUS,
            Focus.verdict("reddit.com", run, p, 1_000L, noBlocklist),
        )
    }

    @Test
    fun `a rendszer-infrastruktura atmegy`() {
        // Enélkül a munkamenet nem korlátozná a telefont, hanem elrontaná:
        // értesítés nem jön, a rendszer hálózati hibát jelez.
        val p = pack("quizlet.com")
        val run = Focus.FocusRun("pack_1", 0L, 10_000L)
        for (h in listOf("mtalk.google.com", "connectivitycheck.gstatic.com", "0.pool.ntp.org")) {
            assertEquals(
                Focus.Verdict.ALLOW, Focus.verdict(h, run, p, 1_000L, noBlocklist),
                "az infrastruktúrának át kell mennie: $h",
            )
        }
        // De a kivétellista SEM erősebb a blokklistánál.
        assertEquals(
            Focus.Verdict.BLOCKED_BY_LIST,
            Focus.verdict("mtalk.google.com", run, p, 1_000L, listOf("mtalk.google.com")),
        )
    }

    @Test
    fun `a sajat fiokkiszolgalo atmegy`() {
        // Enélkül a telefon a munkamenet alatt nem látná, ha egy MÁSIK eszközön
        // leállítod — egy zár, amit a saját kulcsod sem ér el, nem zár.
        val p = pack("quizlet.com")
        val run = Focus.FocusRun("pack_1", 0L, 10_000L)
        assertEquals(
            Focus.Verdict.ALLOW,
            Focus.verdict("sync.pelda.hu", run, p, 1_000L, noBlocklist, syncHost = "sync.pelda.hu"),
        )
        assertEquals(
            Focus.Verdict.BLOCKED_BY_FOCUS,
            Focus.verdict("mas.pelda.hu", run, p, 1_000L, noBlocklist, syncHost = "sync.pelda.hu"),
        )
    }

    @Test
    fun `a hossz normalizalasa ugyanaz, mint a gepen`() {
        assertEquals(43, Focus.normalizeMinutes(43.0))
        assertEquals(43, Focus.normalizeMinutes(42.6))
        assertNull(Focus.normalizeMinutes(0.0))
        assertNull(Focus.normalizeMinutes(null))
        assertNull(Focus.normalizeMinutes(Double.NaN))
        assertEquals(Focus.MAX_SESSION_MINUTES, Focus.normalizeMinutes(99_999.0))
    }

    @Test
    fun `a hosszabbitas ingyen, a rovidites nem`() {
        assertFalse(Focus.isSessionLoosening(1_000L, 2_000L))
        assertFalse(Focus.isSessionLoosening(1_000L, 1_000L))
        assertTrue(Focus.isSessionLoosening(1_000L, 500L))
    }

    @Test
    fun `a hatralevo ido szovege egyezik a gepevel`() {
        assertEquals("kevesebb mint egy perc", Focus.formatRemaining(30_000L))
        assertEquals("42 perc", Focus.formatRemaining(42 * 60_000L))
        assertEquals("1 óra", Focus.formatRemaining(60 * 60_000L))
        assertEquals("1 ó 12 p", Focus.formatRemaining(72 * 60_000L))
        assertEquals("kevesebb mint egy perc", Focus.formatRemaining(-5L))
    }

    @Test
    fun `az app-egyezes mindket iranyban reszleges`() {
        val p = pack("a.com")
        assertTrue(Focus.isAppAllowed(p, "Microsoft Word"))
        assertTrue(Focus.isAppAllowed(p, "word"))
        assertFalse(Focus.isAppAllowed(p, "Excel"))
        assertFalse(Focus.isAppAllowed(p, ""))
    }
}
