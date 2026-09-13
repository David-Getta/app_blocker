import hu.breaker.app.core.ChallengeEngine
import hu.breaker.app.core.ChallengeEngine.Kind
import hu.breaker.app.core.ChallengeEngine.Step
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A kísérlet ALAKJA — a desktop/test/challenges.test.ts párja.
 *
 * Két szabály van itt, és mindkettő szándékos kellemetlenség:
 *  - minden fokon TÖBB aktív próba jár, és a végén MINDIG várakozás;
 *  - a hátralévő lépések számát a felület sosem tudja meg.
 */
class ChallengePlanTest {

    @Test fun `minden fokon a fok szerinti aktív próba, a végén mindig várakozás`() {
        for (tier in 0..3) {
            val want = ChallengeEngine.activeStepCount(tier)
            repeat(15) {
                val plan = ChallengeEngine.generatePlan(Kind.PAUSE, tier, null)
                assertEquals(want + 1, plan.steps.size, "fok $tier")
                assertTrue(plan.steps.last() is Step.Delay, "a végén várakozás áll")
                assertTrue(plan.steps.dropLast(1).none { it is Step.Delay })
                // Amíg kifér a négyes készletből, nincs ismétlés.
                if (want <= 4) {
                    assertEquals(want, plan.steps.dropLast(1).map { ChallengeEngine.typeNameOf(it) }.toSet().size)
                }
            }
        }
    }

    @Test fun `a feladott kísérlet rövid kulcsa nem ad kevesebb munkát`() {
        val plan = ChallengeEngine.generatePlan(Kind.PAUSE, 3, null, "MEMORY+TRANSCRIBE")
        assertEquals(ChallengeEngine.activeStepCount(3) + 1, plan.steps.size)
        val types = plan.steps.dropLast(1).map { ChallengeEngine.typeNameOf(it) }
        assertTrue("MEMORY" in types && "TRANSCRIBE" in types, "a kifizetett páros visszajön")
    }

    @Test fun `négy lépésnél a kombináció kényszerű - és ettől nem akad meg`() {
        // Négy aktív lépésnél MINDEN terv mind a négy típust tartalmazza, tehát
        // nincs másik kombináció. Az „ne ismétlődjön” szabály ilyenkor csak
        // próbálkozás — korlát nélkül a sorsolás örökké pörögne.
        val first = ChallengeEngine.generatePlan(Kind.PAUSE, 1, null)
        val again = ChallengeEngine.generatePlan(Kind.PAUSE, 1, first.comboKey)
        assertEquals(first.comboKey, again.comboKey, "ugyanaz a halmaz — mást nem lehet húzni")
        val a = first.steps.filterIsInstance<Step.Transcribe>().first().text
        val b = again.steps.filterIsInstance<Step.Transcribe>().first().text
        assertTrue(a != b, "a tartalom viszont friss")
    }

    @Test fun `a hátralévő lépések száma nem szivárog ki`() {
        assertEquals(ChallengeEngine.RemainingHint.MANY, ChallengeEngine.remainingHint(0, 7))
        assertEquals(ChallengeEngine.RemainingHint.MANY, ChallengeEngine.remainingHint(4, 7))
        // Kettő van hátra — de hogy kettő, az nem derül ki.
        assertEquals(ChallengeEngine.RemainingHint.FEW, ChallengeEngine.remainingHint(5, 7))
        // Az utolsó lépés sem kap lendületet.
        assertEquals(ChallengeEngine.RemainingHint.FEW, ChallengeEngine.remainingHint(6, 7))
        // A legkisebb terv is négy lépés, tehát az indulás mindig MANY.
        assertEquals(
            ChallengeEngine.RemainingHint.MANY,
            ChallengeEngine.remainingHint(0, ChallengeEngine.activeStepCount(0) + 1),
        )
    }
}
