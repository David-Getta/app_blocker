import hu.breaker.app.core.DigestLogic
import hu.breaker.app.core.DigestLogic.Delta
import hu.breaker.app.core.DigestLogic.Input
import hu.breaker.app.core.DigestLogic.Top
import hu.breaker.app.core.Focus
import java.util.Calendar
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Heti visszatekintés: hétfő reggel egyszer, az elmúlt 7 napról, a statisztika
 * címkézésével — és csak akkor, ha van miről beszélni. A
 * `desktop/test/digest.test.ts` tükre: a két mag ugyanazt a mondatot adja.
 */
class DigestTest {

    private fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int = 0): Long {
        val c = Calendar.getInstance()
        c.clear()
        c.set(y, mo - 1, d, h, mi, 0)
        return c.timeInMillis
    }

    /** 2026. szeptember 7. hétfő. */
    private val MON = "2026-09-07"

    @Test fun `weekKey - a het kulcsa a hetfo datuma, vasarnap meg az elozo hete`() {
        assertEquals(MON, DigestLogic.weekKey(at(2026, 9, 7, 0)), "hétfő hajnal")
        assertEquals(MON, DigestLogic.weekKey(at(2026, 9, 10, 15)), "csütörtök")
        assertEquals(MON, DigestLogic.weekKey(at(2026, 9, 13, 23, 59)), "vasárnap este")
        assertEquals("2026-08-31", DigestLogic.weekKey(at(2026, 9, 6, 12)), "vasárnap: az előző hét")
        assertEquals("2026-09-14", DigestLogic.weekKey(at(2026, 9, 14, 0)), "a következő hétfő")
    }

    @Test fun `due - hetfo reggeltol esedekes, egy heten egyszer`() {
        val h = DigestLogic.DIGEST_HOUR
        assertNull(DigestLogic.due(null, at(2026, 9, 7, h - 1, 59)), "hétfő 6:59: még nem")
        assertEquals(MON, DigestLogic.due(null, at(2026, 9, 7, h)), "hétfő 7:00: igen")
        assertEquals(MON, DigestLogic.due("2026-08-31", at(2026, 9, 9, 10)), "szerdán is, ha hétfőn nem futott")
        assertNull(DigestLogic.due(MON, at(2026, 9, 9, 10)), "ezen a héten már volt")
        assertEquals("2026-09-14", DigestLogic.due(MON, at(2026, 9, 14, 8)), "a következő hétfőn újra")
        assertNull(DigestLogic.due(MON, at(2026, 9, 14, 3)), "de csak reggel héttől")
    }

    @Test fun `hm - orak es percek, mint a csempeken`() {
        assertEquals("58 p", DigestLogic.hm(58.0 * 60))
        assertEquals("1 ó 28 p", DigestLogic.hm(3600.0 + 28 * 60))
        assertEquals("7 ó 20 p", DigestLogic.hm(7.0 * 3600 + 20 * 60))
        assertEquals("0 p", DigestLogic.hm(0.0))
    }

    private val full = Input(
        last7Seconds = 7.0 * 3600 + 20 * 60,
        topWeekSites = listOf(Top("youtube.com", 2.0 * 3600 + 40 * 60)),
        weekOverWeek = listOf(Delta("youtube.com", -33.0)),
        focusWeek = Focus.FocusSummary(sessions = 9, totalMs = 7 * 3600_000L, stoppedEarly = 2, topPack = "Nyelvtanulás"),
        unlocks7d = 3,
        daysTracked = 12,
    )

    @Test fun `a teljes mondat - ido, a legtobb trenddel, menetek, feloldasok`() {
        assertEquals(
            "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). " +
                "9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás.",
            DigestLogic.text(full) { it },
        )
    }

    @Test fun `a cimkezes a felulete - a rejtett vagy fedonevu cim nem szivarog ki`() {
        val text = DigestLogic.text(full) { if (it == "youtube.com") "A videós" else it }!!
        assertTrue(text.contains("a legtöbb: A videós"), text)
        assertFalse(text.contains("youtube.com"), "a valódi cím sehol")
    }

    @Test fun `feloldas nelkul - ezt ki lehet mondani, a vegigvitt menetek is`() {
        val text = DigestLogic.text(
            full.copy(
                unlocks7d = 0,
                focusWeek = Focus.FocusSummary(sessions = 4, totalMs = 3600_000L, stoppedEarly = 0, topPack = null),
                weekOverWeek = listOf(Delta("youtube.com", 3.0)),
            ),
        ) { it }
        assertEquals(
            "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p. 4 menet (1 ó 0 p, mind végigvive). Feloldás nélkül.",
            text,
        )
    }

    @Test fun `meres nelkul a menetek es a feloldasok meg mondat, semmi nelkul null`() {
        val noUsage = full.copy(last7Seconds = 0.0, topWeekSites = emptyList(), weekOverWeek = emptyList(), daysTracked = 0)
        assertEquals("Elmúlt 7 nap: 9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás.", DigestLogic.text(noUsage) { it })
        val nothing = noUsage.copy(unlocks7d = 0, focusWeek = Focus.FocusSummary())
        assertNull(DigestLogic.text(nothing) { it }, "egy üres értesítés zaj lenne")
    }

    @Test fun `az app is bekerul - a mert idoben benne van, a mondat enelkul hazudna`() {
        val withApp = full.copy(
            topWeekApps = listOf(Top("Slack", 3.0 * 3600 + 10 * 60), Top("Terminal", 3600.0)),
            weekOverWeek = full.weekOverWeek + Delta("Slack", 41.6),
        )
        assertEquals(
            "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest); " +
                "appban a legtöbb: Slack 3 ó 10 p (▲ +42% az előző héthez képest). " +
                "9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás.",
            DigestLogic.text(withApp) { it },
        )
        // Oldal nélkül is: a telefonon lehet, hogy csak app van.
        val onlyApp = withApp.copy(topWeekSites = emptyList())
        assertTrue(DigestLogic.text(onlyApp) { it }!!.startsWith("Elmúlt 7 nap: 7 ó 20 p mért idő; appban a legtöbb: Slack 3 ó 10 p"))
        assertEquals(DigestLogic.text(full) { it }, DigestLogic.text(full.copy(topWeekApps = emptyList())) { it }, "üres lista: mint eddig")
    }

    @Test fun `a nem tiltott, sokat vitt oldal is bekerul - a legnagyobb, a felulet cimkejevel`() {
        val withOpen = full.copy(unblockedTop = listOf(Top("news.ycombinator.com", 2.0 * 3600 + 120), Top("github.com", 1800.0)))
        val text = DigestLogic.text(withOpen) { it }!!
        assertTrue(text.endsWith("Nincs tiltva, de sokat vitt: news.ycombinator.com 2 ó 2 p."), text)
        assertFalse(text.contains("github.com"), "csak a legnagyobb — a többi a kártyán vár")
        assertEquals(DigestLogic.text(full) { it }, DigestLogic.text(full.copy(unblockedTop = emptyList())) { it }, "üres lista: mint eddig")
        // Mérés nélkül nincs miről beszélni — az üres hétre a javaslat sem ül rá.
        val nothing = full.copy(last7Seconds = 0.0, daysTracked = 0, unblockedTop = listOf(Top("x.com", 9000.0)))
        assertFalse((DigestLogic.text(nothing) { it } ?: "").contains("x.com"))
    }

    @Test fun `a trend csak ot szazalek folott kerul be, es a jele a mondate`() {
        val up = full.copy(weekOverWeek = listOf(Delta("youtube.com", 12.4)))
        assertTrue(DigestLogic.text(up) { it }!!.contains("(▲ +12% az előző héthez képest)"))
        val flat = full.copy(weekOverWeek = listOf(Delta("youtube.com", 5.0)))
        assertFalse(DigestLogic.text(flat) { it }!!.contains("héthez"), "öt százalék még nem trend")
        val first = full.copy(weekOverWeek = listOf(Delta("youtube.com", null)))
        assertFalse(DigestLogic.text(first) { it }!!.contains("héthez"), "előző hét nélkül nincs trend")
    }
}
