import hu.breaker.app.core.ChallengeEngine
import java.util.Calendar
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * „Utolsó feloldás: N napja” — a `unlock-streak.test.ts` tükre: naptári
 * napokban, nem huszonnégy órás egységekben.
 */
class UnlockStreakTest {

    private fun at(y: Int, m: Int, d: Int, h: Int, min: Int = 0): Long =
        Calendar.getInstance().apply { clear(); set(y, m - 1, d, h, min) }.timeInMillis

    @Test
    fun `ures naplo - meg nem volt feloldas`() {
        assertNull(ChallengeEngine.daysSinceUnlock(emptyList(), at(2026, 9, 7, 10)))
    }

    @Test
    fun `a mai nulla, a tegnap esti egy - ejfel a hatar`() {
        assertEquals(0, ChallengeEngine.daysSinceUnlock(listOf(at(2026, 9, 7, 8)), at(2026, 9, 7, 10)))
        assertEquals(1, ChallengeEngine.daysSinceUnlock(listOf(at(2026, 9, 6, 23, 30)), at(2026, 9, 7, 0, 30)))
        assertEquals(1, ChallengeEngine.daysSinceUnlock(listOf(at(2026, 9, 6, 10)), at(2026, 9, 7, 9)))
    }

    @Test
    fun `a legutobbi szamit, nem a legregebbi`() {
        val log = listOf(at(2026, 8, 20, 9), at(2026, 9, 4, 9), at(2026, 8, 30, 9))
        assertEquals(3, ChallengeEngine.daysSinceUnlock(log, at(2026, 9, 7, 12)))
    }
}
