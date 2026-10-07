import hu.breaker.app.core.ScheduleLogic
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * A szerkesztők beírt időpontja: a telefonon a kettőspont a szimbólumok mögött
 * lapul (a számbillentyűzeten sokszor nincs is), ezért a pont, a vessző, az
 * egész óra és a csupa számjegy is megy — és ami nem időpont, az null.
 */
class ClockInputTest {
    @Test
    fun `a szokasos alakok mind ugyanazt adjak`() {
        for (v in listOf("8:30", "08:30", "8.30", "8,30", "830", "0830", " 8:30 ")) {
            assertEquals(510, ScheduleLogic.parseClock(v), "„$v”")
        }
        assertEquals(480, ScheduleLogic.parseClock("8"))
        assertEquals(1020, ScheduleLogic.parseClock("17"))
        assertEquals(1050, ScheduleLogic.parseClock("1730"))
        assertEquals(0, ScheduleLogic.parseClock("0"))
        assertEquals(0, ScheduleLogic.parseClock("00:00"))
        assertEquals(1440, ScheduleLogic.parseClock("24:00"), "a nap vége")
        assertEquals(1440, ScheduleLogic.parseClock("24"))
        assertEquals(1440, ScheduleLogic.parseClock("2400"))
    }

    @Test
    fun `ami nem idopont, az null`() {
        for (v in listOf("", " ", "25", "24:01", "2401", "8:60", "860", "8:3", "8.3", "12345", "8h", "a8:30", "8:30x", "-8", "٨:٣٠")) {
            assertNull(ScheduleLogic.parseClock(v), "„$v”")
        }
    }

    @Test
    fun `a sajat sav - a 00-00 veg az ejfel, a 24-00 kezdes ervenytelen`() {
        assertEquals(ScheduleLogic.Band(setOf(1, 2), 510, 1020), ScheduleLogic.customBand(setOf(1, 2), "8.30", "17"))
        assertEquals(ScheduleLogic.Band(setOf(5), 1320, 1440), ScheduleLogic.customBand(setOf(5), "22:00", "00:00"))
        assertNull(ScheduleLogic.customBand(setOf(1), "24:00", "08:00"))
        assertNull(ScheduleLogic.customBand(setOf(1), "8:30", "nem"))
    }
}
