import android.content.Context
import hu.breaker.app.core.AppState
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.Referee
import hu.breaker.app.core.Referee.RefereeException
import hu.breaker.app.core.ChallengeEngine.Step
import hu.breaker.app.core.Site
import hu.breaker.app.core.UrlRules
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Részleges szabály felvétele és levétele a telefonon.
 *
 * Androidon a szabályt semmi nem érvényesíti (nincs böngésző-bővítmény) — a
 * SÚRLÓDÁSNAK viszont ugyanannak kell lennie, mint a gépen. Ha itt egy
 * kattintás lenne levenni, a telefon lenne a legolcsóbb kiskapu a gépen
 * beállított szabályokhoz: felveszem a gépen próbatétellel, leveszem a
 * telefonon egy gombbal.
 */
class RuleChangeTest {

    private val now = System.currentTimeMillis()

    @BeforeTest fun reset() {
        BreakerStore.init(Context())
        BreakerStore.mutate {
            AppState(sites = listOf(Site(
                id = "s1", domain = "youtube.com", hostnames = listOf("youtube.com"),
                addedAt = 0, pauseUntil = null, pendingDeleteAt = null,
            )))
        }
    }

    private fun rules() = BreakerStore.state.value.sites.first().rules ?: emptyList()
    private fun rule(s: String) = UrlRules.normalizeRule(s)!!

    @Test fun `adding a rule is free and takes effect at once`() {
        // A szigorítás soha nem kér semmit. Ha a felvétel is súrlódna, senki nem
        // venne fel szabályt — és a funkció nem létezne.
        val r = Referee.startRuleChange("s1", rule("m.youtube.com/@valaki"), remove = false, now = now)
        assertTrue(r.applied)
        assertNull(r.session)
        // A telefonról másolt mobil cím ugyanarra a csatornára szól, mint a gépen.
        assertEquals(listOf("youtube.com/@valaki"), rules().map { UrlRules.ruleLabel(it) })
    }

    @Test fun `the same rule twice stays one rule`() {
        Referee.startRuleChange("s1", rule("youtube.com/@valaki"), remove = false, now = now)
        val again = Referee.startRuleChange("s1", rule("youtube.com/@valaki"), remove = false, now = now)
        assertTrue(again.applied)
        assertEquals(1, rules().size)
    }

    @Test fun `removing a rule costs the same as an unlock`() {
        // EZ A LÉNYEG. A levétel lazítás, tehát próbatételbe kerül — ugyanabba,
        // mint egy feloldás. Enélkül a részleges tiltás egy kikapcsoló gomb
        // lenne.
        Referee.startRuleChange("s1", rule("youtube.com/@valaki"), remove = false, now = now)
        val r = Referee.startRuleChange("s1", rule("youtube.com/@valaki"), remove = true, now = now)
        assertFalse(r.applied, "levenni nem lehet azonnal")
        assertNotNull(r.session)
        assertEquals(1, rules().size, "amíg a próbatétel nincs meg, a szabály ÉRVÉNYES")
        assertNotNull(BreakerStore.state.value.session, "és fut egy kísérlet")
    }

    @Test fun `a rule that is not there cannot start an attempt`() {
        // Enélkül egy nem létező szabály levételével lehetne próbatételt
        // indítani — és a kísérlet befejezése után a bíró bármit tehetne.
        assertFailsWith<RefereeException> {
            Referee.startRuleChange("s1", rule("youtube.com/@nincs"), remove = true, now = now)
        }
        assertNull(BreakerStore.state.value.session)
    }

    @Test fun `only one attempt runs at a time`() {
        Referee.startRuleChange("s1", rule("youtube.com/@egy"), remove = false, now = now)
        Referee.startRuleChange("s1", rule("youtube.com/@ketto"), remove = false, now = now)
        Referee.startRuleChange("s1", rule("youtube.com/@egy"), remove = true, now = now)
        assertFailsWith<RefereeException> {
            Referee.startRuleChange("s1", rule("youtube.com/@ketto"), remove = true, now = now)
        }
    }

    @Test fun `adding stays free even while an attempt is running`() {
        // Szigorítani MINDIG szabad, akkor is, ha épp fut egy kísérlet: a
        // segítő irány sosem kerül semmibe.
        Referee.startRuleChange("s1", rule("youtube.com/@egy"), remove = false, now = now)
        Referee.startRuleChange("s1", rule("youtube.com/@egy"), remove = true, now = now)
        val r = Referee.startRuleChange("s1", rule("youtube.com/@masik"), remove = false, now = now)
        assertTrue(r.applied)
        assertEquals(2, rules().size)
    }

    @Test fun `the rule list has a ceiling`() {
        for (i in 0 until UrlRules.MAX_RULES_PER_SITE) {
            Referee.startRuleChange("s1", rule("youtube.com/@x$i"), remove = false, now = now)
        }
        assertFailsWith<RefereeException> {
            Referee.startRuleChange("s1", rule("youtube.com/@tulcsordul"), remove = false, now = now)
        }
        assertEquals(UrlRules.MAX_RULES_PER_SITE, rules().size)
    }

    @Test fun `a finished attempt removes exactly the one rule`() {
        // A kísérlet teljesítése után a szabálynak el kell tűnnie — de csak
        // annak az egynek. Ha többet vinne, a próbatétel többet fizetne ki,
        // mint amit kértek.
        Referee.startRuleChange("s1", rule("youtube.com/@egy"), remove = false, now = now)
        Referee.startRuleChange("s1", rule("youtube.com/@ketto"), remove = false, now = now)
        Referee.startRuleChange("s1", rule("youtube.com/@egy"), remove = true, now = now)
        finishSession()
        assertEquals(listOf("youtube.com/@ketto"), rules().map { UrlRules.ruleLabel(it) })
        assertNull(BreakerStore.state.value.session)
        // És a szünet NEM indult el: ez nem feloldás volt, hanem szabály-levétel.
        assertNull(BreakerStore.state.value.sites.first().pauseUntil)
    }

    /** Végigcsinálja a futó kísérlet lépéseit — bármilyen kombinációt kapott. */
    private fun finishSession() {
        var guard = 0
        while (BreakerStore.state.value.session != null && guard++ < 200) {
            val s = BreakerStore.state.value.session!!
            when (val step = s.steps[s.stepIndex]) {
                is Step.Delay -> Referee.claimDelay(s.id, (step.claimableAt ?: 0) + 1)
                else -> Referee.submitAnswer(s.id, solve(step), now)
            }
        }
    }

    /** A helyes válasz; a MEMORY lépést visszadátumozzuk a várakozása mögé. */
    private fun solve(step: Step): String = when (step) {
        is Step.Transcribe -> step.text
        is Step.MathChain -> step.problems[step.pos].a.toString()
        is Step.Memory -> {
            BreakerStore.mutate { st ->
                val ses = st.session!!
                val steps = ses.steps.toMutableList()
                steps[ses.stepIndex] = step.copy(armedAt = now - step.showMs - step.waitMs - 1000)
                st.copy(session = ses.copy(steps = steps))
            }
            step.code
        }
        is Step.Reverse -> step.text.reversed()
        is Step.Delay -> error("a várakozást nem válasszal kell teljesíteni")
    }
}
