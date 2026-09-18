import hu.breaker.app.core.AppState
import hu.breaker.app.core.DigestLogic
import hu.breaker.app.core.DigestLogic.Delta
import hu.breaker.app.core.DigestLogic.Entry
import hu.breaker.app.core.DigestLogic.Input
import hu.breaker.app.core.DigestLogic.Top
import hu.breaker.app.core.FilterHitLogic
import hu.breaker.app.core.Focus
import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.Site
import hu.breaker.app.core.UsageLogic
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

    @Test fun `a csucs-orat nem fedi ablak - csak ha lehetne ra tenni, a fedes erosebb`() {
        val head = "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). " +
            "9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás. 12 megakadás a szűrőben, a csúcs 21–22 óra"
        val peak = full.copy(filterHits7d = 12, filterHitsPeak = 21 to 6)
        assertEquals("$head (nincs rá ablak).", DigestLogic.text(peak.copy(peakWindowOffer = true)) { it })
        assertEquals("$head.", DigestLogic.text(peak) { it })
        assertEquals("$head (magától indul: Nyelvtanulás).", DigestLogic.text(peak.copy(peakWindowOffer = true, filterHitsPeakPack = "Nyelvtanulás")) { it }, "a fedés erősebb")
    }

    @Test fun `az ablakbol indult menetek a mondatban - nulla nem mondat`() {
        assertEquals(
            "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). " +
                "9 menet (7 ó 0 p, 2 korán leállítva, 3 ablakból). 3 feloldás.",
            DigestLogic.text(full.copy(focusWeek = full.focusWeek.copy(windowRuns = 3))) { it },
        )
    }

    @Test fun `a felbemaradt kiserletek is a mondatban - a feloldasok mellett, vagy helyettuk`() {
        assertEquals(
            "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). " +
                "9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás, 2 félbemaradt kísérlet.",
            DigestLogic.text(full.copy(dropped7d = 2)) { it },
        )
        val none = DigestLogic.text(full.copy(unlocks7d = 0, dropped7d = 1, weekOverWeek = emptyList())) { it }!!
        assertTrue(none.endsWith("Feloldás nélkül, 1 félbemaradt kísérlet."), none)
        // Csak félbemaradt kísérlet: az is történés — mondat, még mérés és menet nélkül is.
        val only = full.copy(
            last7Seconds = 0.0, topWeekSites = emptyList(), weekOverWeek = emptyList(), daysTracked = 0,
            unlocks7d = 0, dropped7d = 3, focusWeek = Focus.FocusSummary(),
        )
        assertEquals("Elmúlt 7 nap: Feloldás nélkül, 3 félbemaradt kísérlet.", DigestLogic.text(only) { it })
        assertEquals(DigestLogic.text(full) { it }, DigestLogic.text(full.copy(dropped7d = 0)) { it }, "nulla: mint eddig")
    }

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

    @Test fun `naplo - hetenkent egy sor, a legfrissebb elol, fel ev a plafon`() {
        var log = emptyList<Entry>()
        log = DigestLogic.record(log, "2026-08-31", "Elmúlt 7 nap: 5 ó 0 p mért idő.")
        log = DigestLogic.record(log, "2026-09-07", "Elmúlt 7 nap: 7 ó 20 p mért idő.")
        assertEquals(listOf("2026-09-07", "2026-08-31"), log.map { it.week }, "a legfrissebb elöl")
        // Ugyanaz a hét újra: felülír, nem duplikál.
        log = DigestLogic.record(log, "2026-09-07", "Elmúlt 7 nap: 8 ó 0 p mért idő.")
        assertEquals(2, log.size)
        assertEquals("Elmúlt 7 nap: 8 ó 0 p mért idő.", log[0].text)
        // Üres hét: nem sor — és a hét régi sorát is elviszi.
        log = DigestLogic.record(log, "2026-09-07", null)
        assertEquals(listOf("2026-08-31"), log.map { it.week })
        // A plafon: a legrégebbi esik.
        for (i in 0 until DigestLogic.MAX_DIGEST_LOG + 5) {
            log = DigestLogic.record(log, DigestLogic.weekKey(at(2027, 1, 4 + 7 * i, 12)), "hét $i")
        }
        assertEquals(DigestLogic.MAX_DIGEST_LOG, log.size)
        assertEquals("hét ${DigestLogic.MAX_DIGEST_LOG + 4}", log[0].text, "a legfrissebb maradt")
        assertFalse(log.any { it.week == "2026-08-31" }, "a legrégebbi esett ki")
    }

    @Test fun `naplo a tarbol - ami nem sor, az nem sor, a mondat csonkul, a het egy`() {
        val junk = listOf(
            Entry("2026-9-7", "rossz kulcs"), Entry("2026-09-07", "   "),
            Entry("2026-09-07", "első"), Entry("2026-09-07", "utolsó"),
            Entry("2026-08-31", "x".repeat(900)),
        )
        val log = DigestLogic.clean(junk)
        assertEquals(listOf("2026-09-07", "2026-08-31"), log.map { it.week })
        assertEquals("utolsó", log[0].text, "ugyanarra a hétre az utolsó marad")
        assertEquals(500, log[1].text.length)
        assertEquals("2026. 09. 07.", DigestLogic.weekLabel("2026-09-07"))
    }

    @Test fun `a bemenet az allapotbol - a menetek es a feloldasok a gordulo hetbol`() {
        val now = at(2026, 9, 7, 8)
        val day = 86_400_000L
        val st = AppState(
            unlockLog = listOf(now - 2 * day, now - 20 * day),
            // A félbemaradt kísérletek ugyanezzel az ablakkal: a húsz napos nem az elmúlt hété.
            droppedAttempts = listOf(now - 3 * day, now - 20 * day),
            focusLog = listOf(
                Focus.FocusLogEntry("p", "Nyelvtanulás", now - 3 * day, now - 3 * day + 3600_000L, now - 3 * day + 3600_000L, false),
                Focus.FocusLogEntry("p", "Nyelvtanulás", now - 30 * day, now - 30 * day + 3600_000L, now - 30 * day + 3600_000L, false),
            ),
        )
        val input = DigestLogic.inputFor(st, UsageLogic.summarize(st.usage, now), now)
        assertEquals(1, input.unlocks7d, "a húsz napos feloldás nem az elmúlt hété")
        assertEquals(1, input.focusWeek.sessions, "a harminc napos menet nem az elmúlt hété")
        assertEquals(0, input.daysTracked)
        assertEquals(1, input.dropped7d, "a húsz napos félbemaradt kísérlet sem az elmúlt hété")
        assertEquals("Elmúlt 7 nap: 1 menet (1 ó 0 p, mind végigvive). A négy hét menet-napja: péntek (1 menet). A négy hét menet-órája: 8–9 óra (1 menet). 1 feloldás, 1 félbemaradt kísérlet.", DigestLogic.text(input) { it })
    }

    @Test fun `a menet-ora fedese a bemenetben - a fedo csomag neve, vagy ablak-ajanlat, a csucs-oran egyik sem`() {
        val now = at(2026, 9, 7, 8)
        val day = 86_400_000L
        // Egy menet, három napja nyolckor: a négy hét menet-órája 8–9.
        val log = listOf(Focus.FocusLogEntry("p", "Nyelvtanulás", now - 3 * day, now - 3 * day + 3600_000L, now - 3 * day + 3600_000L, false))
        val bare = Focus.FocusPack("p", "Nyelvtanulás", emptyList(), emptyList(), 60)
        // Csomag ablak nélkül, a menet-órát semmi nem fedi: lehetne rá ablakot tenni.
        val offer = AppState(focusLog = log, focusPacks = listOf(bare))
        val offerIn = DigestLogic.inputFor(offer, UsageLogic.summarize(offer.usage, now), now)
        assertEquals(null, offerIn.focusHourPack)
        assertEquals(true, offerIn.focusHourWindowOffer, "csomag ablak nélkül: lehetne rá ablakot tenni")
        assertEquals(true, DigestLogic.text(offerIn) { it }?.contains("A négy hét menet-órája: 8–9 óra (1 menet, nincs rá ablak)."))
        // A csomag ablaka fedi a menet-órát: a neve a mondatban, ajánlat nincs.
        val band = ScheduleLogic.Band(setOf(0, 1, 2, 3, 4, 5, 6), 8 * 60, 9 * 60)
        val covered = offer.copy(focusPacks = listOf(bare.copy(recurrence = band)))
        val coveredIn = DigestLogic.inputFor(covered, UsageLogic.summarize(covered.usage, now), now)
        assertEquals("Nyelvtanulás", coveredIn.focusHourPack)
        assertEquals(false, coveredIn.focusHourWindowOffer)
        assertEquals(true, DigestLogic.text(coveredIn) { it }?.contains("A négy hét menet-órája: 8–9 óra (1 menet, magától indul: Nyelvtanulás)."))
        // Ha a menet-óra a csúcs-óra, a csúcs mondata mondja a fedést — a menet-óra mondata a régi, kétszer ugyanazt nem.
        var hours = emptyMap<String, List<Int>>()
        repeat(3) { hours = FilterHitLogic.recordHour(hours, UsageLogic.dayKey(now - day), 8) }
        val same = covered.copy(filterHits = mapOf(UsageLogic.dayKey(now - day) to 3), filterHitHours = hours)
        val sameIn = DigestLogic.inputFor(same, UsageLogic.summarize(same.usage, now), now)
        assertEquals(8 to 3, sameIn.filterHitsPeak, "a csúcs-óra is a nyolc")
        assertEquals(null, sameIn.focusHourPack)
        assertEquals(false, sameIn.focusHourWindowOffer)
        val text = DigestLogic.text(sameIn) { it } ?: ""
        assertEquals(true, text.contains("A négy hét menet-órája: 8–9 óra (1 menet)."), text)
        assertEquals(true, text.contains("a csúcs 8–9 óra (magától indul: Nyelvtanulás)"), text)
    }

    @Test fun `a naplo sora a mostani cimkezessel - a fedonev es a rejtes visszamenoleg is fed`() {
        val text = "Elmúlt 7 nap: 7 ó mért idő; a legtöbb: youtube.com 2 ó 40 p. Nincs tiltva, de sokat vitt: m.youtube.com 1 ó; youtu.be 5 p; notyoutube.com 3 p; github.com 2 p."
        val sites = listOf(
            Site("y", "youtube.com", listOf("youtube.com", "m.youtube.com", "youtu.be"), 1L, null, null),
            Site("g", "github.com", listOf("github.com"), 1L, null, null),
        )
        assertEquals(
            "Elmúlt 7 nap: 7 ó mért idő; a legtöbb: A videós 2 ó 40 p. Nincs tiltva, de sokat vitt: A videós 1 ó; A videós 5 p; notyoutube.com 3 p; github.com 2 p.",
            DigestLogic.relabel(text, sites) { if (it == "youtube.com") "A videós" else it },
        )
        // A „notyoutube.com” nem a youtube.com aloldala — az marad; a listázottak sorszámot kapnak.
        val hidden = DigestLogic.relabel(text, sites) { d -> "${sites.indexOfFirst { it.domain == d } + 1}. rejtett oldal" }
        assertEquals(
            "Elmúlt 7 nap: 7 ó mért idő; a legtöbb: 1. rejtett oldal 2 ó 40 p. Nincs tiltva, de sokat vitt: 1. rejtett oldal 1 ó; 1. rejtett oldal 5 p; notyoutube.com 3 p; 2. rejtett oldal 2 p.",
            hidden,
        )
        assertEquals(text, DigestLogic.relabel(text, sites) { it }, "címke nélkül a sor változatlan")
    }

    @Test fun `a keret betelt napjai a mondatban - nulla nem mondat`() {
        val base = DigestLogic.Input(
            last7Seconds = 0.0, topWeekSites = emptyList(), weekOverWeek = emptyList(),
            focusWeek = Focus.FocusSummary(sessions = 9, totalMs = 7 * 3600_000L, stoppedEarly = 2, topPack = "Nyelvtanulás"),
            unlocks7d = 3, daysTracked = 0,
        )
        assertEquals("Elmúlt 7 nap: 9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás. A napi keret 3 napon betelt.",
            DigestLogic.text(base.copy(limitFullDays = 3)) { it })
        assertEquals(DigestLogic.text(base) { it }, DigestLogic.text(base.copy(limitFullDays = 0)) { it }, "nulla nap nem mondat")
        assertEquals("Elmúlt 7 nap: 9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás. Az adag a héten 7× telt be.",
            DigestLogic.text(base.copy(burstTripsWeek = 7)) { it })
    }

    @Test fun `az elozo het a menetek mellett - irany, nem itelet, ures elozo het nem sor, a menet nelkuli het mondat`() {
        val base = DigestLogic.Input(
            last7Seconds = 0.0, topWeekSites = emptyList(), weekOverWeek = emptyList(),
            focusWeek = Focus.FocusSummary(sessions = 9, totalMs = 7 * 3600_000L, stoppedEarly = 2, topPack = "Nyelvtanulás"),
            unlocks7d = 3, daysTracked = 0,
        )
        val prev = Focus.FocusSummary(sessions = 5, totalMs = 3 * 3600_000L + 10 * 60_000L, stoppedEarly = 1, topPack = null)
        assertEquals("Elmúlt 7 nap: 9 menet (7 ó 0 p, 2 korán leállítva), az előző héten 5 (3 ó 10 p). 3 feloldás.",
            DigestLogic.text(base.copy(focusPrevWeek = prev)) { it })
        assertEquals("Elmúlt 7 nap: Menet nélkül, az előző héten 5 (3 ó 10 p). 3 feloldás.",
            DigestLogic.text(base.copy(focusWeek = Focus.FocusSummary(), focusPrevWeek = prev)) { it })
        assertEquals(DigestLogic.text(base) { it }, DigestLogic.text(base.copy(focusPrevWeek = Focus.FocusSummary())) { it }, "üres előző hét: a régi mondat")
    }

    @Test fun `az elozo het feloldasai a szam mellett - irany, nem itelet, ures elozo het nem sor, feloldas nelkul is mondat`() {
        val base = DigestLogic.Input(
            last7Seconds = 0.0, topWeekSites = emptyList(), weekOverWeek = emptyList(),
            focusWeek = Focus.FocusSummary(sessions = 9, totalMs = 7 * 3600_000L, stoppedEarly = 2, topPack = "Nyelvtanulás"),
            unlocks7d = 3, daysTracked = 0,
        )
        val head = "Elmúlt 7 nap: 9 menet (7 ó 0 p, 2 korán leállítva). "
        assertEquals("${head}3 feloldás (az előző héten 5).", DigestLogic.text(base.copy(unlocksPrev7d = 5)) { it })
        assertEquals("${head}3 feloldás (az előző héten 5), 2 félbemaradt kísérlet.", DigestLogic.text(base.copy(unlocksPrev7d = 5, dropped7d = 2)) { it })
        assertEquals("${head}Feloldás nélkül (az előző héten 5).", DigestLogic.text(base.copy(unlocks7d = 0, unlocksPrev7d = 5)) { it })
        assertEquals("${head}Feloldás nélkül (az előző héten 5), 1 félbemaradt kísérlet.",
            DigestLogic.text(base.copy(unlocks7d = 0, unlocksPrev7d = 5, dropped7d = 1)) { it })
        assertEquals(DigestLogic.text(base) { it }, DigestLogic.text(base.copy(unlocksPrev7d = 0)) { it }, "üres előző hét: a régi mondat")
        val bare = base.copy(focusWeek = Focus.FocusSummary(), unlocks7d = 0)
        assertEquals("Elmúlt 7 nap: Feloldás nélkül (az előző héten 2).", DigestLogic.text(bare.copy(unlocksPrev7d = 2)) { it },
            "mérés és menet nélkül is mondat, ha az előző héten volt feloldás")
        assertEquals(null, DigestLogic.text(bare) { it })
    }

    @Test fun `a csucs-nap a mondatban - a statisztika sora szo szerint, nap nelkul nem mondat`() {
        val head = "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). " +
            "9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás."
        assertEquals("$head A négy hét csúcs-napja: vasárnap (14 megakadás).", DigestLogic.text(full.copy(filterHitsWeekday = 0 to 14)) { it })
        assertEquals("$head 12 megakadás a szűrőben. A négy hét csúcs-napja: szerda (9 megakadás).",
            DigestLogic.text(full.copy(filterHits7d = 12, filterHitsWeekday = 3 to 9)) { it }, "a megakadások mondata után")
        assertEquals(DigestLogic.text(full) { it }, DigestLogic.text(full.copy(filterHitsWeekday = null)) { it }, "nap nélkül a régi mondat")
    }

    @Test fun `a menet-nap a mondatban - a statisztika sora szo szerint, nap nelkul nem mondat`() {
        val head = "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). " +
            "9 menet (7 ó 0 p, 2 korán leállítva)."
        assertEquals("$head A négy hét menet-napja: kedd (6 menet). 3 feloldás.", DigestLogic.text(full.copy(focusWeekday = 2 to 6)) { it })
        assertEquals(DigestLogic.text(full) { it }, DigestLogic.text(full.copy(focusWeekday = null)) { it }, "nap nélkül a régi mondat")
    }

    @Test fun `a mert ido napja a mondatban - a statisztika sora szo szerint, meres es nap nelkul nem mondat`() {
        assertEquals(
            "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). " +
                "A négy hét legnagyobb napja: szombat (átlag 50 p). 9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás.",
            DigestLogic.text(full.copy(usageWeekday = 6 to 12000)) { it },
        )
        assertEquals(DigestLogic.text(full) { it }, DigestLogic.text(full.copy(usageWeekday = null)) { it }, "nap nélkül a régi mondat")
        assertEquals(
            DigestLogic.text(full.copy(last7Seconds = 0.0)) { it },
            DigestLogic.text(full.copy(last7Seconds = 0.0, usageWeekday = 6 to 12000)) { it },
            "mérés nélkül a nap sem mondat",
        )
    }

    @Test fun `a menet-sorozat a mondatban - a menetek mondata utan, kettotol, egy nap nem mondat`() {
        val head = "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). " +
            "9 menet (7 ó 0 p, 2 korán leállítva)."
        assertEquals("$head 5 napja minden nap leültél. 3 feloldás.", DigestLogic.text(full.copy(focusStreak = 5)) { it })
        assertEquals(DigestLogic.text(full) { it }, DigestLogic.text(full.copy(focusStreak = 1)) { it }, "egy nap nem sorozat")
        assertEquals("$head 5 napja minden nap leültél. A négy hét menet-napja: kedd (6 menet). 3 feloldás.",
            DigestLogic.text(full.copy(focusStreak = 5, focusWeekday = 2 to 6)) { it }, "a menet-nap előtt")
    }

    @Test fun `a leghosszabb sorozat a mondatban - csak a mostani sorozat mellett, zarojelben`() {
        val head = "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). " +
            "9 menet (7 ó 0 p, 2 korán leállítva)."
        assertEquals("$head 5 napja minden nap leültél (a leghosszabb sorozatod: 12 nap). 3 feloldás.",
            DigestLogic.text(full.copy(focusStreak = 5, focusLongestStreak = 12)) { it })
        assertEquals("$head 5 napja minden nap leültél. 3 feloldás.",
            DigestLogic.text(full.copy(focusStreak = 5, focusLongestStreak = 5)) { it }, "ha a mostani a rekord, nem ismétli")
        assertEquals(DigestLogic.text(full) { it }, DigestLogic.text(full.copy(focusStreak = 0, focusLongestStreak = 12)) { it },
            "sorozat nélkül a rekord nem mondat a hétről")
        assertEquals(DigestLogic.text(full) { it }, DigestLogic.text(full.copy(focusStreak = 1, focusLongestStreak = 12)) { it },
            "egy nap mellett sem")
    }

    @Test fun `a menet-ora a mondatban - a statisztika sora szo szerint, ora nelkul nem mondat`() {
        val head = "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). " +
            "9 menet (7 ó 0 p, 2 korán leállítva)."
        assertEquals("$head A négy hét menet-napja: kedd (6 menet). A négy hét menet-órája: 9–10 óra (6 menet). 3 feloldás.",
            DigestLogic.text(full.copy(focusWeekday = 2 to 6, focusHour = 9 to 6)) { it })
        assertEquals(DigestLogic.text(full) { it }, DigestLogic.text(full.copy(focusHour = null)) { it }, "óra nélkül a régi mondat")
        // A FEDÉS a szám mellett: a csomag, amelynek ablaka fedi — vagy „nincs rá ablak”, ha lehetne. A fedés erősebb.
        assertEquals("$head A négy hét menet-órája: 9–10 óra (6 menet, magától indul: Nyelvtanulás). 3 feloldás.",
            DigestLogic.text(full.copy(focusHour = 9 to 6, focusHourPack = "Nyelvtanulás", focusHourWindowOffer = true)) { it })
        assertEquals("$head A négy hét menet-órája: 9–10 óra (6 menet, nincs rá ablak). 3 feloldás.",
            DigestLogic.text(full.copy(focusHour = 9 to 6, focusHourWindowOffer = true)) { it })
        // AMIKOR A CSÚCS-ÓRA A MENET-ÓRA: a mondat kimondja, a menet-óra után; más órán nem.
        assertEquals("$head A négy hét menet-órája: 21–22 óra (6 menet). A csúcs-óra és a menet-óra ugyanaz: 21–22 óra — a kéz akkor jár, amikor le szoktál ülni. " +
            "3 feloldás. 12 megakadás a szűrőben, a csúcs 21–22 óra.",
            DigestLogic.text(full.copy(focusHour = 21 to 6, filterHits7d = 12, filterHitsPeak = 21 to 6)) { it })
        assertEquals("$head A négy hét menet-órája: 9–10 óra (6 menet). 3 feloldás. 12 megakadás a szűrőben, a csúcs 21–22 óra.",
            DigestLogic.text(full.copy(focusHour = 9 to 6, filterHits7d = 12, filterHitsPeak = 21 to 6)) { it })
    }
}
