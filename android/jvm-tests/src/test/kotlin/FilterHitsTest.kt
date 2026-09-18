import android.content.Context
import hu.breaker.app.core.AppState
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.DigestLogic
import hu.breaker.app.core.FilterHitLogic
import hu.breaker.app.core.Focus
import hu.breaker.app.core.UsageLogic
import org.json.JSONObject
import java.util.Calendar
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * A szűrő megakadásai: hosztonként két percen belül egyszer; a könyv
 * naponként, harminc napig; az elmúlt hét; a mondat; a mentés.
 */
class FilterHitsTest {

    private val now: Long = Calendar.getInstance().apply {
        set(2026, Calendar.SEPTEMBER, 18, 12, 0, 0); set(Calendar.MILLISECOND, 0)
    }.timeInMillis
    private val today = UsageLogic.dayKey(now)

    @BeforeTest fun reset() {
        BreakerStore.init(Context())
        BreakerStore.mutate { AppState() }
    }

    @Test fun `hosztonkent ket percen belul egyszer - a kis-nagybetu es a zaro pont nem szamit`() {
        val seen = HashMap<String, Long>()
        assertTrue(FilterHitLogic.shouldCount(seen, "youtube.com", now))
        assertFalse(FilterHitLogic.shouldCount(seen, "YouTube.com.", now + 1000), "ugyanaz a hoszt, egy percen belül")
        assertTrue(FilterHitLogic.shouldCount(seen, "reddit.com", now + 1000), "másik hoszt: másik megakadás")
        assertFalse(FilterHitLogic.shouldCount(seen, "youtube.com", now + FilterHitLogic.DEDUPE_MS - 1))
        assertTrue(FilterHitLogic.shouldCount(seen, "youtube.com", now + FilterHitLogic.DEDUPE_MS), "két perc után újra")
        assertFalse(FilterHitLogic.shouldCount(seen, "  ", now), "üres név nem hoszt")
        // A memória nem nő a végtelenbe: a régi bejegyzések kiesnek.
        for (i in 0 until 600) FilterHitLogic.shouldCount(seen, "h$i.example", now + 2 * FilterHitLogic.DEDUPE_MS)
        assertTrue(seen.size <= 600)
    }

    @Test fun `a konyv naponkent - takaritva, plafonnal, a jovo nem nap`() {
        var days = FilterHitLogic.record(emptyMap(), today)
        days = FilterHitLogic.record(days, today)
        days = FilterHitLogic.record(days, "nem nap")
        assertEquals(mapOf(today to 2), days)
        for (i in 1..40) days = FilterHitLogic.record(days, UsageLogic.dayKey(now - i * 86_400_000L))
        assertEquals(FilterHitLogic.RETENTION_DAYS, FilterHitLogic.sweep(days, today).size)
        val future = FilterHitLogic.record(days, "2099-01-01")
        assertEquals(null, FilterHitLogic.sweep(future, today)["2099-01-01"], "a jövő elállított óra")
        val full = mapOf(today to FilterHitLogic.MAX_PER_DAY)
        assertEquals(full, FilterHitLogic.record(full, today), "a napi plafon fölött nem nő")
        assertEquals(mapOf(today to 3), FilterHitLogic.clean(mapOf(today to 3, "x" to 5, "2026-09-17" to 0, "2026-09-16" to -1)))
    }

    @Test fun `az elmult het es a mai nap - a hetedik nap benne, a nyolcadik nem`() {
        val days = mapOf(
            today to 2,
            UsageLogic.dayKey(now - 6 * 86_400_000L) to 3,
            UsageLogic.dayKey(now - 7 * 86_400_000L) to 9,
        )
        assertEquals(5, FilterHitLogic.hits7d(days, now))
        assertEquals(2, FilterHitLogic.hitsToday(days, now))
        assertEquals(0, FilterHitLogic.hits7d(emptyMap(), now))
        // Az előző hét: a 13.–7. nap — a hetedik és a tizenharmadik benne, a tizennegyedik nem.
        val two = days + mapOf(
            UsageLogic.dayKey(now - 13 * 86_400_000L) to 4,
            UsageLogic.dayKey(now - 14 * 86_400_000L) to 100,
        )
        assertEquals(13, FilterHitLogic.hitsPrev7d(two, now))
        assertEquals(0, FilterHitLogic.hitsPrev7d(emptyMap(), now))
        assertEquals("A héten 12 megakadás, az előző héten 18.", FilterHitLogic.trendText(12, 18))
        assertEquals("A héten 0 megakadás, az előző héten 18.", FilterHitLogic.trendText(0, 18), "a nulla hét is mondat, ha volt mihez mérni")
        assertEquals("", FilterHitLogic.trendText(12, 0), "előző hét nélkül nincs összehasonlítás")
    }

    @Test fun `a het alakja - het nap, a legregebbi elol, az ures nap nulla`() {
        val days = mapOf(today to 2, UsageLogic.dayKey(now - 6 * 86_400_000L) to 3, UsageLogic.dayKey(now - 7 * 86_400_000L) to 9)
        val series = FilterHitLogic.daySeries(days, now, 7)
        assertEquals(7, series.size)
        assertEquals(UsageLogic.dayKey(now - 6 * 86_400_000L), series.first().first)
        assertEquals(today, series.last().first)
        assertEquals(listOf(3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 2.0), series.map { it.second }, "a nyolcadik nap már nem a hété")
        // A HÓNAP rajza csak akkor mond többet a hétnél, ha a hét előtt is volt.
        val month = FilterHitLogic.daySeries(days, now, 30)
        assertEquals(30, month.size)
        assertEquals(true, FilterHitLogic.monthHasOlderHits(month), "a nyolc napos a hónapé: áll")
        assertEquals(false, FilterHitLogic.monthHasOlderHits(month.takeLast(7)), "csak a hét: nem áll")
        assertEquals(false, FilterHitLogic.monthHasOlderHits(emptyList()))
    }

    @Test fun `orankent - a csucs-ora a heten, holtversenynel a korabbi, a mentes hordozza`() {
        var hours = FilterHitLogic.recordHour(emptyMap(), today, 21)
        hours = FilterHitLogic.recordHour(hours, today, 21)
        hours = FilterHitLogic.recordHour(hours, UsageLogic.dayKey(now - 86_400_000L), 9)
        hours = FilterHitLogic.recordHour(hours, UsageLogic.dayKey(now - 86_400_000L), 9)
        hours = FilterHitLogic.recordHour(hours, UsageLogic.dayKey(now - 8 * 86_400_000L), 9) // nem a hété
        hours = FilterHitLogic.recordHour(hours, today, 99) // rossz óra: változatlan
        assertEquals(2, hours.getValue(today)[21])
        assertEquals(9 to 2, FilterHitLogic.peakHour(hours, now), "holtverseny: a korábbi óra")
        val by = FilterHitLogic.byHour(hours, now)
        assertEquals(24, by.size, "az órák sávja huszonnégy rekesz")
        assertEquals(2, by[9], "a rekesz a hét összege — a nyolcadik nap nélkül")
        assertEquals(2, by[21])
        assertEquals(4, by.sum())
        assertEquals(List(24) { 0 }, FilterHitLogic.byHour(emptyMap(), now), "üresen csupa nulla")
        assertEquals(null, FilterHitLogic.peakHour(emptyMap(), now))
        assertEquals("23–0 óra", FilterHitLogic.hourLabel(23))
        assertEquals(mapOf(today to hours.getValue(today)),
            FilterHitLogic.cleanHours(mapOf(today to hours.getValue(today), "x" to List(24) { 1 }, "2026-09-17" to listOf(1, 2))))
        val toJson = BreakerStore::class.java.getDeclaredMethod("toJson", AppState::class.java).apply { isAccessible = true }
        val fromJson = BreakerStore::class.java.getDeclaredMethod("fromJson", JSONObject::class.java).apply { isAccessible = true }
        val st = AppState(filterHitHours = mapOf(today to hours.getValue(today)))
        val back = fromJson.invoke(BreakerStore, JSONObject(toJson.invoke(BreakerStore, st).toString())) as AppState
        assertEquals(st.filterHitHours, back.filterHitHours, "a mentés hordozza az órákat")
        assertEquals(12, FilterHitLogic.hourOf(now))
        val base = DigestLogic.Input(
            last7Seconds = 0.0, topWeekSites = emptyList(), weekOverWeek = emptyList(),
            focusWeek = Focus.summarizeFocus(emptyList(), 0L, now), unlocks7d = 0, daysTracked = 0,
        )
        assertEquals("Elmúlt 7 nap: 12 megakadás a szűrőben, a csúcs 21–22 óra.",
            DigestLogic.text(base.copy(filterHits7d = 12, filterHitsPeak = 21 to 7)) { it })
        assertEquals("Elmúlt 7 nap: 12 megakadás a szűrőben, a csúcs 21–22 óra (magától indul: Nyelvtanulás).",
            DigestLogic.text(base.copy(filterHits7d = 12, filterHitsPeak = 21 to 7, filterHitsPeakPack = "Nyelvtanulás")) { it },
            "a lefedett csúcs-óra a csúcs mellett")
        assertEquals("Elmúlt 7 nap: 12 megakadás a szűrőben.",
            DigestLogic.text(base.copy(filterHits7d = 12, filterHitsPeak = null, filterHitsPeakPack = "Nyelvtanulás")) { it },
            "csúcs nélkül a csomag sem szerepel")
    }

    @Test fun `a sokadik megakadas - a lepcso es a mondat`() {
        assertEquals(0, FilterHitLogic.nudgeStep(4), "négynél még nem szól")
        assertEquals(5, FilterHitLogic.nudgeStep(5))
        assertEquals(5, FilterHitLogic.nudgeStep(9), "a következő lépcsőig ugyanaz")
        assertEquals(10, FilterHitLogic.nudgeStep(12))
        assertEquals(20, FilterHitLogic.nudgeStep(250), "a legfelső lépcső fölött is a legfelső")
        assertEquals(listOf(5, 10, 20), FilterHitLogic.NUDGE_STEPS)
        assertEquals(
            "Ma már 5 megakadás a szűrőben. Egy munkamenet vagy egy rövid zárlat most segítene — te döntesz.",
            FilterHitLogic.nudgeText(5),
        )
    }

    @Test fun `elojelzes a csucs-ora elott - tiz perces ablak, naponta egy kulcs, a nulla ora az elozo esten`() {
        val peak = 21 to 7
        fun at2(hh: Int, mm: Int, d: Int = 18): Long =
            Calendar.getInstance().apply { set(2026, Calendar.SEPTEMBER, d, hh, mm, 0); set(Calendar.MILLISECOND, 0) }.timeInMillis
        assertEquals(10 * 60_000L, FilterHitLogic.PEAK_WARN_LEAD_MS)
        assertEquals(3, FilterHitLogic.PEAK_WARN_MIN_COUNT)
        assertEquals(null, FilterHitLogic.peakWarnKey(peak, at2(20, 49)), "tizenegy perccel előtte még nem")
        assertEquals("2026-09-18:21", FilterHitLogic.peakWarnKey(peak, at2(20, 50)))
        assertEquals("2026-09-18:21", FilterHitLogic.peakWarnKey(peak, at2(20, 59)))
        assertEquals(null, FilterHitLogic.peakWarnKey(peak, at2(21, 0)), "az órában már nem előjelzés")
        assertEquals(null, FilterHitLogic.peakWarnKey(21 to 2, at2(20, 55)), "kettő nem csúcs")
        assertEquals(null, FilterHitLogic.peakWarnKey(null, at2(20, 55)))
        assertEquals("2026-09-19:0", FilterHitLogic.peakWarnKey(0 to 3, at2(23, 55)), "a nulla óra ablaka az előző este")
        assertEquals(null, FilterHitLogic.peakWarnKey(0 to 3, at2(0, 5, 19)))
        assertEquals(
            "Mindjárt 21 óra — a héten ilyenkor akadt meg a kéz a legtöbbször (7×). Egy munkamenet most segítene — te döntesz.",
            FilterHitLogic.peakWarnText(peak),
        )
        assertEquals(true, FilterHitLogic.isPeakNow(peak, at2(21, 0)), "az óra elején már most van")
        assertEquals(true, FilterHitLogic.isPeakNow(peak, at2(21, 59)))
        assertEquals(false, FilterHitLogic.isPeakNow(peak, at2(20, 59)), "előtte még nem")
        assertEquals(false, FilterHitLogic.isPeakNow(peak, at2(22, 0)), "utána már nem")
        assertEquals(false, FilterHitLogic.isPeakNow(null, at2(21, 0)))
        assertEquals(
            "Most a hét csúcs-órája van (21–22 óra, 7 megakadás a héten) — ilyenkor jár a kéz magától.",
            FilterHitLogic.peakNowText(peak),
        )
    }

    @Test fun `okonkent - az ok az iteletbol, a het okonkent, a sor es a mentes`() {
        assertEquals("list", FilterHitLogic.reasonOf(Focus.Verdict.BLOCKED_BY_LIST))
        assertEquals("keyword", FilterHitLogic.reasonOf(Focus.Verdict.BLOCKED_BY_KEYWORD))
        assertEquals(null, FilterHitLogic.reasonOf(Focus.Verdict.BLOCKED_BY_FOCUS), "a munkamenet fehérlistáján kívül nem megakadás")
        assertEquals(null, FilterHitLogic.reasonOf(Focus.Verdict.ALLOW))
        var reasons = FilterHitLogic.recordSite(emptyMap(), today, "list")
        reasons = FilterHitLogic.recordSite(reasons, today, "keyword")
        reasons = FilterHitLogic.recordSite(reasons, today, "keyword")
        reasons = FilterHitLogic.recordSite(reasons, UsageLogic.dayKey(now - 8 * 86_400_000L), "list") // nem a hété
        assertEquals(listOf("keyword" to 2, "list" to 1), FilterHitLogic.byReason(reasons, now), "a legnagyobb elöl")
        assertEquals(
            listOf("list" to 1, "keyword" to 1),
            FilterHitLogic.byReason(mapOf(today to mapOf("keyword" to 1, "list" to 1)), now),
            "holtverseny: a rögzített sorrend",
        )
        assertEquals(emptyList<Pair<String, Int>>(), FilterHitLogic.byReason(emptyMap(), now))
        assertEquals("2 kulcsszó · 1 lista", FilterHitLogic.reasonLine(FilterHitLogic.byReason(reasons, now)))
        assertEquals("", FilterHitLogic.reasonLine(emptyList()))
        val toJson = BreakerStore::class.java.getDeclaredMethod("toJson", AppState::class.java).apply { isAccessible = true }
        val fromJson = BreakerStore::class.java.getDeclaredMethod("fromJson", JSONObject::class.java).apply { isAccessible = true }
        val back = fromJson.invoke(BreakerStore, JSONObject(toJson.invoke(BreakerStore, AppState(filterHitReasons = reasons)).toString())) as AppState
        assertEquals(FilterHitLogic.cleanSites(reasons), back.filterHitReasons, "a mentés hordozza az okokat")
    }

    @Test fun `kulcsszavankent - a het sora a legnagyobb elol, a sor es a mentes`() {
        var book = FilterHitLogic.recordSite(emptyMap(), today, "shorts")
        book = FilterHitLogic.recordSite(book, today, "shorts")
        book = FilterHitLogic.recordSite(book, today, "reels")
        book = FilterHitLogic.recordSite(book, UsageLogic.dayKey(now - 8 * 86_400_000L), "live") // nem a hété
        assertEquals(listOf("shorts" to 2, "reels" to 1), FilterHitLogic.keywordsWeek(book, now), "a legnagyobb elöl")
        assertEquals(listOf("a" to 1, "b" to 1), FilterHitLogic.keywordsWeek(mapOf(today to mapOf("b" to 1, "a" to 1)), now), "holtverseny: az ábécé")
        assertEquals(emptyList<Pair<String, Int>>(), FilterHitLogic.keywordsWeek(emptyMap(), now))
        assertEquals("shorts 2 · reels 1", FilterHitLogic.keywordLine(FilterHitLogic.keywordsWeek(book, now)))
        assertEquals("", FilterHitLogic.keywordLine(emptyList()))
        // Ami nem fogott: a lista szavai a hét sorai nélkül — csak ha volt kulcsszó-megakadás.
        val rows = FilterHitLogic.keywordsWeek(book, now)
        assertEquals(listOf("live", "stream"), FilterHitLogic.idleKeywords(listOf("Shorts", "live", " stream ", ""), rows), "kisbetűsen, üres nélkül")
        assertEquals(emptyList<String>(), FilterHitLogic.idleKeywords(listOf("live"), emptyList()), "kulcsszó-megakadás nélkül a hiány nem tény")
        val toJson = BreakerStore::class.java.getDeclaredMethod("toJson", AppState::class.java).apply { isAccessible = true }
        val fromJson = BreakerStore::class.java.getDeclaredMethod("fromJson", JSONObject::class.java).apply { isAccessible = true }
        val back = fromJson.invoke(BreakerStore, JSONObject(toJson.invoke(BreakerStore, AppState(filterHitKeywords = book)).toString())) as AppState
        assertEquals(FilterHitLogic.cleanSites(book), back.filterHitKeywords, "a mentés hordozza a szavakat")
    }

    @Test fun `oldalankent - a nev az oldalhoz, a konyv es a csucs-oldal, a mentes es a mondat`() {
        val sites = listOf("youtube.com" to listOf("youtube.com", "www.youtube.com"))
        assertEquals("youtube.com", FilterHitLogic.siteOf("M.YouTube.com.", sites), "aldomain és nagybetű: az oldal")
        assertEquals("notyoutube.com", FilterHitLogic.siteOf("notyoutube.com", sites), "a hasonló név nem az oldal")
        var hosts = FilterHitLogic.recordSite(emptyMap(), today, "youtube.com")
        hosts = FilterHitLogic.recordSite(hosts, today, "youtube.com")
        hosts = FilterHitLogic.recordSite(hosts, today, "reddit.com")
        hosts = FilterHitLogic.recordSite(hosts, UsageLogic.dayKey(now - 8 * 86_400_000L), "old.com") // nem a hété
        hosts = FilterHitLogic.recordSite(hosts, "szemét", "youtube.com")
        hosts = FilterHitLogic.recordSite(hosts, today, " ")
        assertEquals(mapOf("youtube.com" to 2, "reddit.com" to 1), hosts[today])
        assertEquals("youtube.com" to 2, FilterHitLogic.topSite(hosts, now))
        assertEquals(null, FilterHitLogic.topSite(emptyMap(), now))
        assertEquals("a.com" to 1, FilterHitLogic.topSite(mapOf(today to mapOf("b.com" to 1, "a.com" to 1)), now), "holtverseny: az ábécé")
        assertEquals(
            mapOf(today to mapOf("youtube.com" to 2)),
            FilterHitLogic.cleanSites(mapOf(today to mapOf("youtube.com" to 2, "" to 3, "z.com" to 0), "x" to mapOf("a" to 1))),
        )
        val toJson = BreakerStore::class.java.getDeclaredMethod("toJson", AppState::class.java).apply { isAccessible = true }
        val fromJson = BreakerStore::class.java.getDeclaredMethod("fromJson", JSONObject::class.java).apply { isAccessible = true }
        val back = fromJson.invoke(BreakerStore, JSONObject(toJson.invoke(BreakerStore, AppState(filterHitHosts = hosts)).toString())) as AppState
        assertEquals(FilterHitLogic.cleanSites(hosts), back.filterHitHosts, "a mentés hordozza az oldalakat")
        val base = DigestLogic.Input(
            last7Seconds = 0.0, topWeekSites = emptyList(), weekOverWeek = emptyList(),
            focusWeek = Focus.summarizeFocus(emptyList(), 0L, now), unlocks7d = 0, daysTracked = 0,
        )
        assertEquals(
            "Elmúlt 7 nap: 12 megakadás a szűrőben, a csúcs 21–22 óra, a legtöbbször: A videós (5×).",
            DigestLogic.text(base.copy(filterHits7d = 12, filterHitsPeak = 21 to 7, filterHitsTop = "youtube.com" to 5)) {
                if (it == "youtube.com") "A videós" else it
            },
        )
    }

    @Test fun `a mondat es a mentes`() {
        val base = DigestLogic.Input(
            last7Seconds = 0.0, topWeekSites = emptyList(), weekOverWeek = emptyList(),
            focusWeek = Focus.summarizeFocus(emptyList(), 0L, now), unlocks7d = 1, daysTracked = 0,
        )
        assertEquals("Elmúlt 7 nap: 1 feloldás. 12 megakadás a szűrőben.",
            DigestLogic.text(base.copy(filterHits7d = 12)) { it })
        assertEquals("Elmúlt 7 nap: 3 megakadás a szűrőben.",
            DigestLogic.text(base.copy(unlocks7d = 0, filterHits7d = 3)) { it }, "megakadás feloldás nélkül is mondat")
        assertEquals("Elmúlt 7 nap: 1 feloldás.", DigestLogic.text(base) { it })
        assertEquals("Elmúlt 7 nap: 12 megakadás a szűrőben (az előző héten 18), a csúcs 21–22 óra.",
            DigestLogic.text(base.copy(unlocks7d = 0, filterHits7d = 12, filterHitsPrev7d = 18, filterHitsPeak = 21 to 7)) { it },
            "az előző hét a szám mellett, a csúcs utána")
        assertEquals("Elmúlt 7 nap: Megakadás nélkül a szűrőben (az előző héten 18).",
            DigestLogic.text(base.copy(unlocks7d = 0, filterHits7d = 0, filterHitsPrev7d = 18)) { it },
            "a nulla hét is mondat, ha volt mihez mérni")

        val toJson = BreakerStore::class.java.getDeclaredMethod("toJson", AppState::class.java).apply { isAccessible = true }
        val fromJson = BreakerStore::class.java.getDeclaredMethod("fromJson", JSONObject::class.java).apply { isAccessible = true }
        val st = AppState(filterHits = mapOf(today to 3, "szemét" to 4))
        val back = fromJson.invoke(BreakerStore, JSONObject(toJson.invoke(BreakerStore, st).toString())) as AppState
        assertEquals(mapOf(today to 3), back.filterHits, "a mentés hordozza, a szemét kiesik")
        val old = fromJson.invoke(BreakerStore, JSONObject("{\"sites\":[]}")) as AppState
        assertEquals(emptyMap(), old.filterHits, "régi mentés: üres könyv")
        // Ha nem kéred, csendben marad — a beállítás a mentésben; a régi mentésben nincs: szól.
        val quiet = fromJson.invoke(BreakerStore, JSONObject(toJson.invoke(BreakerStore, AppState(quietSuggestions = true)).toString())) as AppState
        assertTrue(quiet.quietSuggestions, "a mentés hordozza a csendet")
        assertFalse(old.quietSuggestions, "régi mentés: szól")
    }

    @Test
    fun `a csucs-nap - negy hetbol, a het napjaira osztva, holtversenynel a het elejehez kozelebbi`() {
        // 2026-09-18 péntek. Három péntek a négy hétben, a 28 nappal ezelőtti már nincs benne.
        val cal = java.util.Calendar.getInstance().apply {
            set(2026, java.util.Calendar.SEPTEMBER, 18, 12, 0, 0); set(java.util.Calendar.MILLISECOND, 0)
        }
        val now = cal.timeInMillis
        val day = 86_400_000L
        fun k(back: Int) = hu.breaker.app.core.UsageLogic.dayKey(now - back * day)
        val days = mapOf(k(0) to 2, k(7) to 3, k(14) to 1, k(1) to 5, k(28) to 100)
        val by = FilterHitLogic.byWeekday(days, now)
        assertEquals(7, by.size)
        assertEquals(6, by[5], "péntek: három péntek összege, a huszonnyolc napos nélkül")
        assertEquals(5, by[4], "csütörtök")
        assertEquals(5 to 6, FilterHitLogic.peakWeekday(by))
        assertEquals(4 to 6, FilterHitLogic.peakWeekday(listOf(0, 0, 0, 0, 6, 6, 0)), "holtverseny: a hét elejéhez közelebbi")
        assertEquals(6 to 3, FilterHitLogic.peakWeekday(listOf(3, 0, 0, 0, 0, 0, 3)), "a vasárnap a hét vége: a szombat előbb jön")
        assertEquals(null, FilterHitLogic.peakWeekday(listOf(0, 0, 0, 0, 0, 0, 0)))
        assertEquals(listOf(0, 0, 0, 0, 0, 0, 0), FilterHitLogic.byWeekday(emptyMap(), now))
        assertEquals("A négy hét csúcs-napja: vasárnap (14 megakadás).", FilterHitLogic.peakWeekdayText(0 to 14))
    }

    @Test fun `a csucs-nap a kisertes napjan - ma van-e, es csak eleg mintabol`() {
        // 2026-09-20 vasárnap, 2026-09-21 hétfő.
        fun at(day: Int) = java.util.Calendar.getInstance().apply {
            set(2026, java.util.Calendar.SEPTEMBER, day, 15, 0, 0); set(java.util.Calendar.MILLISECOND, 0)
        }.timeInMillis
        val peak = 0 to 14
        assertEquals(true, FilterHitLogic.isPeakDayNow(peak, at(20)))
        assertEquals(false, FilterHitLogic.isPeakDayNow(peak, at(21)), "más napon nem")
        assertEquals(false, FilterHitLogic.isPeakDayNow(0 to FilterHitLogic.PEAK_DAY_MIN_COUNT - 1, at(20)), "kevés minta: nem mondat")
        assertEquals(true, FilterHitLogic.isPeakDayNow(0 to FilterHitLogic.PEAK_DAY_MIN_COUNT, at(20)))
        assertEquals(false, FilterHitLogic.isPeakDayNow(null, at(20)))
        assertEquals("Ma a négy hét csúcs-napja van (vasárnap, 14 megakadás) — ezen a napon akad meg a kéz a legtöbbször.", FilterHitLogic.peakDayNowText(peak))
    }
}
