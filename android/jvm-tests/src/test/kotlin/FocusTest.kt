import hu.breaker.app.core.Focus
import hu.breaker.app.core.ScheduleLogic
import java.util.Calendar
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

    // ---------------------------------------------------------- heti ablak
    //
    // A `focus-recurrence.test.ts` tükre: az ablak az ígéret (a kezdés mindig
    // az ablak kezdete, hogy a gép és a telefon ugyanazt a menetet állítsa
    // elő), és a napló az őr (ami ebben az ablakban egyszer indult, nem indul
    // újra — különben a leállítás próbatétele egy percig érne).

    /** Helyi idő — a mag is helyi időben gondolkodik, mint a menetrend. */
    private fun localMs(y: Int, m: Int, d: Int, h: Int, min: Int): Long =
        Calendar.getInstance().apply { clear(); set(y, m - 1, d, h, min) }.timeInMillis

    private val weekdays = ScheduleLogic.Band(setOf(1, 2, 3, 4, 5), 9 * 60, 12 * 60)
    private fun windowed(id: String = "pack_1") = pack("github.com").copy(id = id, recurrence = weekdays)

    @Test
    fun `az ablak mostani elofordulasa helyi idoben, a veg mar nincs benne`() {
        // 2026. szeptember 7. hétfő.
        val occ = Focus.occurrenceAt(weekdays, localMs(2026, 9, 7, 9, 30))!!
        assertEquals(localMs(2026, 9, 7, 9, 0), occ.startsAt)
        assertEquals(localMs(2026, 9, 7, 12, 0), occ.endsAt)
        assertNull(Focus.occurrenceAt(weekdays, localMs(2026, 9, 7, 12, 0)), "a vég perce már nincs benne")
        assertNull(Focus.occurrenceAt(weekdays, localMs(2026, 9, 6, 10, 0)), "vasárnap nem")
        // Éjfélen át: a hétfő esti ablak a kedd hajnalt is fedi.
        val night = ScheduleLogic.Band(setOf(1), 22 * 60, 6 * 60)
        val dawn = Focus.occurrenceAt(night, localMs(2026, 9, 8, 1, 0))!!
        assertEquals(localMs(2026, 9, 7, 22, 0), dawn.startsAt)
        assertEquals(localMs(2026, 9, 8, 6, 0), dawn.endsAt)
    }

    @Test
    fun `menetrend szerinti inditas - az ablak kezdesevel, es a naplo az or`() {
        val now = localMs(2026, 9, 7, 9, 30)
        val due = Focus.dueRecurrence(listOf(windowed()), null, emptyList(), now)!!
        assertEquals(localMs(2026, 9, 7, 9, 0), due.startsAt, "a kezdés az ablaké, nem a mostani perc")
        assertEquals(localMs(2026, 9, 7, 12, 0), due.endsAt)
        assertNull(
            Focus.dueRecurrence(listOf(windowed()), null, emptyList(), localMs(2026, 9, 7, 8, 0)),
            "ablakon kívül nem",
        )

        // A csomag SAJÁT futó menete mellett nincs esedékes; egy MÁSIK csomag
        // kézi menete nem tartja vissza az ablakot — azt a kör zárja le.
        val own = Focus.FocusRun("pack_1", now - 1000, now + 1000)
        assertNull(Focus.dueRecurrence(listOf(windowed()), own, emptyList(), now), "a saját menete fut")
        val other = Focus.FocusRun("other", now - 1000, now + 1000)
        assertTrue(Focus.dueRecurrence(listOf(windowed()), other, emptyList(), now) != null, "a másik csomag menete nem véd")

        // A leállított menet sora az ablak SAJÁT menete (a kezdése az ablaké): nem indul újra.
        val stopped = Focus.FocusLogEntry("pack_1", "x", due.startsAt, now, due.endsAt, true)
        assertNull(Focus.dueRecurrence(listOf(windowed()), null, listOf(stopped), now + 60_000))
        // A csomag kézi menete az ablakon belül (nem az ablak kezdésével) nem költi el.
        val manual = Focus.FocusLogEntry("pack_1", "x", due.startsAt + 5_000, due.startsAt + 65_000, due.startsAt + 65_000, false)
        assertTrue(Focus.dueRecurrence(listOf(windowed()), null, listOf(manual), now + 60_000) != null, "az egyperces kézi menet nem váltja ki")
        // Másnap viszont igen.
        assertTrue(
            Focus.dueRecurrence(listOf(windowed()), null, listOf(stopped), localMs(2026, 9, 8, 9, 30)) != null,
        )
        // Egy percnél kevesebb hátralévő idővel nem indul.
        assertNull(Focus.dueRecurrence(listOf(windowed()), null, emptyList(), due.endsAt - 30_000))

        assertTrue(Focus.isWindowRun(Focus.FocusRun("pack_1", due.startsAt, due.endsAt), listOf(windowed())))
        assertFalse(
            Focus.isWindowRun(Focus.FocusRun("pack_1", due.startsAt, due.endsAt + 60_000), listOf(windowed())),
            "a meghosszabbított menet már kézi",
        )
    }

    @Test
    fun `az ablak tisztitasa - ervenyes sav, legfeljebb nyolc ora`() {
        assertEquals(weekdays, Focus.cleanRecurrence(weekdays))
        assertNull(Focus.cleanRecurrence(ScheduleLogic.Band(emptySet(), 540, 720)), "nap nélkül nem")
        assertNull(Focus.cleanRecurrence(ScheduleLogic.Band(setOf(1), 0, 1440)), "huszonnégy óra nem munkamenet")
        assertNull(Focus.cleanRecurrence(null))
    }

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
