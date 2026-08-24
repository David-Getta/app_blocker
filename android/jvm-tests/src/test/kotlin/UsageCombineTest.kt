import hu.breaker.app.core.UsageLogic
import hu.breaker.app.core.UsageLogic.TargetKind
import java.util.Calendar
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Több eszköz mérése együtt — a `desktop/test/usage-combine.test.ts` párja.
 *
 * A kérdés, ami tényleg számít, nem az eszközönkénti bontás: nem az, hogy
 * mennyi ment el YouTube-ra a gépen, hanem hogy MENNYI MENT EL ÖSSZESEN. Ha ez
 * a szám hibás, az app pont arról hazudik, amiért létezik.
 */
class UsageCombineTest {

    private fun at(y: Int, mo: Int, d: Int, h: Int): Long {
        val c = Calendar.getInstance()
        c.set(y, mo - 1, d, h, 0, 0); c.set(Calendar.MILLISECOND, 0)
        return c.timeInMillis
    }

    private val now = at(2026, 8, 24, 10)
    private val today = UsageLogic.dayKey(now)
    private val yesterday = UsageLogic.dayKeysBack(now, 2).first()

    private fun st(
        days: Map<String, Map<String, Double>>,
        labels: Map<String, String> = emptyMap(),
        enabled: Boolean = true,
    ) = UsageLogic.UsageState(
        days.entries.map { UsageLogic.UsageDay(it.key, it.value.toMutableMap()) }.toMutableList(),
        labels.toMutableMap(),
        enabled,
    )

    @Test
    fun `the same site on two devices adds up`() {
        val combined = UsageLogic.combineUsage(listOf(
            st(mapOf(today to mapOf("site:youtube.com" to 1200.0))),
            st(mapOf(today to mapOf("site:youtube.com" to 900.0))),
        ))
        assertEquals(2100.0, UsageLogic.totalsForDays(combined, listOf(today))["site:youtube.com"])
    }

    @Test
    fun `the summary of the combined state is the sum of the devices`() {
        // Ugyanaz a `summarize` fut rajta, mint a helyi nézeten — szándékosan.
        val a = st(mapOf(
            today to mapOf("site:youtube.com" to 600.0),
            yesterday to mapOf("site:reddit.com" to 300.0),
        ))
        val b = st(mapOf(today to mapOf("site:reddit.com" to 400.0)))
        val sum = UsageLogic.summarize(UsageLogic.combineUsage(listOf(a, b)), now)
        assertEquals(1000.0, sum.todaySeconds)
        assertEquals(1300.0, sum.last7Seconds)
        assertEquals(
            UsageLogic.summarize(a, now).todaySeconds + UsageLogic.summarize(b, now).todaySeconds,
            sum.todaySeconds,
        )
    }

    @Test
    fun `two apps stay two rows, one site becomes one row`() {
        // A `site:` kulcs minden platformon azonos, tehát a weboldal tényleg
        // összeadódik. A telefonos és a gépes böngésző viszont KÉT app, és az,
        // hogy nem olvadnak össze, helyes: nem ugyanaz a program.
        val combined = UsageLogic.combineUsage(listOf(
            st(
                mapOf(today to mapOf("site:youtube.com" to 100.0, "app:com.google.Chrome" to 500.0)),
                mapOf("app:com.google.Chrome" to "Google Chrome"),
            ),
            st(
                mapOf(today to mapOf("site:youtube.com" to 100.0, "app:com.android.chrome" to 700.0)),
                mapOf("app:com.android.chrome" to "Chrome"),
            ),
        ))
        val rows = UsageLogic.rank(combined, UsageLogic.totalsForDays(combined, listOf(today)))
        assertEquals(
            listOf(
                "app:com.android.chrome" to 700.0,
                "app:com.google.Chrome" to 500.0,
                "site:youtube.com" to 200.0,
            ),
            rows.map { it.key to it.seconds },
        )
    }

    @Test
    fun `the label comes from where the target was used, not from call order`() {
        // Ha a sorrend döntene, ugyanaz a nézet más címkét mutatna attól
        // függően, melyik eszköz válaszolt előbb a hálózaton.
        val little = st(mapOf(today to mapOf("app:x" to 10.0)), mapOf("app:x" to "kevés"))
        val much = st(mapOf(today to mapOf("app:x" to 9000.0)), mapOf("app:x" to "sok"))
        assertEquals("sok", UsageLogic.combineUsage(listOf(little, much)).labels["app:x"])
        assertEquals("sok", UsageLogic.combineUsage(listOf(much, little)).labels["app:x"])
    }

    @Test
    fun `a device that is not measuring does not zero out the others`() {
        // Ha a helyi kapcsoló ki van kapcsolva, az összesített szám attól még
        // valódi: a másik eszköz mérte, és a felhasználó ideje elment.
        val off = st(emptyMap(), emptyMap(), enabled = false)
        val on = st(mapOf(today to mapOf("site:youtube.com" to 60.0)), enabled = true)
        assertTrue(UsageLogic.combineUsage(listOf(off, on)).enabled)
        assertTrue(!UsageLogic.combineUsage(listOf(off, off)).enabled)
        assertEquals(
            60.0,
            UsageLogic.summarize(UsageLogic.combineUsage(listOf(off, on)), now).todaySeconds,
        )
    }

    @Test
    fun `junk from another device does not corrupt the total`() {
        // A blobok egy MÁSIK eszközről, egy kiszolgálón át érkeznek. Egyetlen
        // hibás érték nem viheti el az egész összesítést.
        val broken = st(mapOf(today to mapOf(
            "site:a.com" to -100.0,
            "site:b.com" to Double.NaN,
            "site:c.com" to 7.0,
        )))
        val combined = UsageLogic.combineUsage(
            listOf(broken, st(mapOf(today to mapOf("site:a.com" to 30.0)))),
        )
        val totals = UsageLogic.totalsForDays(combined, listOf(today))
        assertEquals(30.0, totals["site:a.com"])
        assertEquals(7.0, totals["site:c.com"])
        assertEquals(null, totals["site:b.com"])
        assertEquals(0, UsageLogic.combineUsage(emptyList()).days.size)
    }

    @Test
    fun `the days come back in order, because the charts assume it`() {
        val combined = UsageLogic.combineUsage(listOf(
            st(mapOf(
                "2026-08-20" to mapOf("site:a.com" to 1.0),
                "2026-08-24" to mapOf("site:a.com" to 1.0),
            )),
            st(mapOf("2026-08-22" to mapOf("site:a.com" to 1.0))),
        ))
        assertEquals(
            listOf("2026-08-20", "2026-08-22", "2026-08-24"),
            combined.days.map { it.day },
        )
    }

    @Test
    fun `sites and apps stay separable after combining`() {
        // A felület külön sávlistát rajzol a kettőnek; ha a kulcs fajtája
        // elveszne az összefésülésnél, a két lista összekeveredne.
        val combined = UsageLogic.combineUsage(listOf(
            st(mapOf(today to mapOf("site:a.com" to 10.0))),
            st(mapOf(today to mapOf("app:b" to 20.0))),
        ))
        val totals = UsageLogic.totalsForDays(combined, listOf(today))
        assertEquals(1, UsageLogic.rank(combined, totals, TargetKind.SITE).size)
        assertEquals(1, UsageLogic.rank(combined, totals, TargetKind.APP).size)
    }
}
