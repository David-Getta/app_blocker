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
    }

    @Test fun `a het alakja - het nap, a legregebbi elol, az ures nap nulla`() {
        val days = mapOf(today to 2, UsageLogic.dayKey(now - 6 * 86_400_000L) to 3, UsageLogic.dayKey(now - 7 * 86_400_000L) to 9)
        val series = FilterHitLogic.daySeries(days, now, 7)
        assertEquals(7, series.size)
        assertEquals(UsageLogic.dayKey(now - 6 * 86_400_000L), series.first().first)
        assertEquals(today, series.last().first)
        assertEquals(listOf(3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 2.0), series.map { it.second }, "a nyolcadik nap már nem a hété")
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

        val toJson = BreakerStore::class.java.getDeclaredMethod("toJson", AppState::class.java).apply { isAccessible = true }
        val fromJson = BreakerStore::class.java.getDeclaredMethod("fromJson", JSONObject::class.java).apply { isAccessible = true }
        val st = AppState(filterHits = mapOf(today to 3, "szemét" to 4))
        val back = fromJson.invoke(BreakerStore, JSONObject(toJson.invoke(BreakerStore, st).toString())) as AppState
        assertEquals(mapOf(today to 3), back.filterHits, "a mentés hordozza, a szemét kiesik")
        val old = fromJson.invoke(BreakerStore, JSONObject("{\"sites\":[]}")) as AppState
        assertEquals(emptyMap(), old.filterHits, "régi mentés: üres könyv")
    }
}
