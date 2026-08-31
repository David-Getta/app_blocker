import hu.breaker.app.core.BurstLogic
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Az adag-szabály magja — a desktop/test/burst.test.ts tükre, ugyanazokkal a
 * számokkal. Ha a két oldal szétcsúszik, ugyanaz a beállítás a gépen mást
 * tiltana, mint a telefonon, és senki nem értené, miért.
 */
class BurstTest {

    private val rule = BurstLogic.Rule(burstSeconds = 120, cooldownSeconds = 600)
    private val t0 = 1_000_000_000L

    @Test
    fun `a szabalyhoz mindket szam kell`() {
        assertEquals(rule, BurstLogic.normalize(120, 600))
        assertNull(BurstLogic.normalize(120, null))
        assertNull(BurstLogic.normalize(null, 600))
        assertNull(BurstLogic.normalize(0, 600))
        assertNull(BurstLogic.normalize(120, -1))
    }

    @Test
    fun `a plafon egy nap — ugyanaz, mint a TS ikren`() {
        val r = BurstLogic.normalize(999L * 3600, 999L * 3600)!!
        assertEquals(24L * 3600, r.burstSeconds)
        assertEquals(24L * 3600, r.cooldownSeconds)
    }

    @Test
    fun `az adag betelik, indul a hutes, a szamlalo nullarol jon vissza`() {
        var st = BurstLogic.noteUsage(rule, null, 60.0, t0)
        assertEquals(60.0, st.usedSeconds)
        assertFalse(BurstLogic.isCoolingDown(st, t0), "fél adag még nem tilt")
        st = BurstLogic.noteUsage(rule, st, 60.0, t0 + 60_000)
        assertEquals(0.0, st.usedSeconds, "beteléskor a számláló nullázódik")
        assertEquals(t0 + 60_000 + 600_000, st.cooldownUntil, "a hűtés a minta idejétől számít")
        assertTrue(BurstLogic.isCoolingDown(st, t0 + 120_000))
        assertFalse(BurstLogic.isCoolingDown(st, t0 + 60_000 + 600_000), "a hűtés magától lejár")
    }

    @Test
    fun `hutes alatt a minta nem szamit`() {
        var st = BurstLogic.noteUsage(rule, null, 120.0, t0) // azonnal betelik
        val until = st.cooldownUntil
        st = BurstLogic.noteUsage(rule, st, 300.0, t0 + 60_000)
        assertEquals(until, st.cooldownUntil, "a tiltott oldalon mért idő nem hosszabbít")
        assertEquals(0.0, st.usedSeconds, "és a következő adagba sem számít bele")
    }

    @Test
    fun `egy hutesnyi piheno utan tiszta lap`() {
        var st = BurstLogic.noteUsage(rule, null, 100.0, t0)
        st = BurstLogic.noteUsage(rule, st, 30.0, t0 + 601_000)
        assertEquals(30.0, st.usedSeconds)
    }

    @Test
    fun `az elkesett regi minta nem gyarthat hamis pihenot`() {
        var st = BurstLogic.noteUsage(rule, null, 80.0, t0)
        st = BurstLogic.noteUsage(rule, st, 10.0, t0 - 700_000)
        assertEquals(t0, st.lastAt, "a lastAt nem lép hátra")
        st = BurstLogic.noteUsage(rule, st, 15.0, t0 + 5_000)
        assertEquals(105.0, st.usedSeconds, "nem volt pihenő — a számláló gyűlik tovább")
    }

    @Test
    fun `mi lazitas es mi nem`() {
        assertFalse(BurstLogic.isLoosening(null, rule), "szabályt felvenni szigorítás")
        assertTrue(BurstLogic.isLoosening(rule, null), "levenni lazítás")
        assertFalse(BurstLogic.isLoosening(rule, rule.copy(burstSeconds = 60)), "kisebb adag: szigorítás")
        assertTrue(BurstLogic.isLoosening(rule, rule.copy(burstSeconds = 300)), "nagyobb adag: lazítás")
        assertFalse(BurstLogic.isLoosening(rule, rule.copy(cooldownSeconds = 1200)), "hosszabb szünet: szigorítás")
        assertTrue(BurstLogic.isLoosening(rule, rule.copy(cooldownSeconds = 60)), "rövidebb szünet: lazítás")
        assertTrue(
            BurstLogic.isLoosening(rule, BurstLogic.Rule(60, 60)),
            "vegyes módosításnál a lazító fele dönt",
        )
    }
}
