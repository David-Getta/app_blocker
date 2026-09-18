import android.content.Context
import hu.breaker.app.core.AppState
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.ChallengeEngine.Kind
import hu.breaker.app.core.LockdownLogic
import hu.breaker.app.core.Referee
import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.Site
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Zárlat: amíg tart, a lazítás nem drága — NINCS.
 *
 * A desktop/test/lockdown.test.ts tükre. A mag számtana mellett a lényeg a
 * bíró kapuja: a telefonon ugyanaz a hat belépési pont egyike sem indíthat
 * próbatételt zárlat alatt.
 */
class LockdownTest {

    private val t0 = 1_736_160_000_000L // 2025-01-06 10:00 UTC
    private val hour = 3_600_000L

    @BeforeTest fun reset() {
        BreakerStore.init(Context())
        BreakerStore.mutate { AppState() }
        BreakerStore.saveLastTick(0)
    }

    private fun addSite(): String {
        val id = BreakerStore.newId("site")
        BreakerStore.mutate { s ->
            s.copy(sites = s.sites + Site(
                id = id, domain = "youtube.com",
                hostnames = listOf("youtube.com", "www.youtube.com", "music.youtube.com"),
                addedAt = t0 - hour, pauseUntil = null, pendingDeleteAt = null,
                schedule = ScheduleLogic.Schedule(
                    ScheduleLogic.Mode.SCHEDULED_BLOCK,
                    listOf(ScheduleLogic.Band(setOf(0, 1, 2, 3, 4, 5, 6), 0, 1440)),
                ),
                dailyLimitSeconds = 600L,
                burstSeconds = 120L, cooldownSeconds = 600L,
            ))
        }
        return id
    }

    // ------------------------------------------------------------------- mag

    @Test fun neverShortens() {
        val long = LockdownLogic.start(null, 8 * hour, t0)!!
        val shorter = LockdownLogic.start(long, hour, t0 + 60_000)!!
        assertEquals(long.until, shorter.until, "a rövidebb kérés nem vihette le")
        assertEquals(long.startedAt, shorter.startedAt)
    }

    @Test fun extendsAndKeepsStart() {
        val first = LockdownLogic.start(null, hour, t0)!!
        val longer = LockdownLogic.start(first, 24 * hour, t0 + 30 * 60_000)!!
        assertEquals(t0 + 30 * 60_000 + 24 * hour, longer.until)
        assertEquals(t0, longer.startedAt, "a hosszabbítás nem nulláz vissza")
    }

    @Test fun cappedAtThirtyDays() {
        val l = LockdownLogic.start(null, 400 * 24 * hour, t0)!!
        assertEquals(t0 + LockdownLogic.MAX_LOCKDOWN_MS, l.until)
    }

    @Test fun mergeTakesTheLaterEnd() {
        val a = LockdownLogic.Lockdown(t0, t0 + hour)
        val b = LockdownLogic.Lockdown(t0 - hour, t0 + 5 * hour)
        assertEquals(b.until, LockdownLogic.merge(a, b)!!.until)
        assertEquals(b.until, LockdownLogic.merge(b, a)!!.until)
        assertEquals(a.until, LockdownLogic.merge(a, null)!!.until)
        assertEquals(a.until, LockdownLogic.merge(null, a)!!.until)
        assertNull(LockdownLogic.merge(null, null))
        // Azonos végnél a korábbi kezdés marad — az mutatja a teljes hosszt.
        val c = LockdownLogic.Lockdown(t0 - hour, t0 + hour)
        assertEquals(t0 - hour, LockdownLogic.merge(a, c)!!.startedAt)
    }

    @Test fun parseRejectsJunk() {
        assertNull(LockdownLogic.parse(null, null))
        assertNull(LockdownLogic.parse(0.0, t0.toDouble()))
        assertNull(LockdownLogic.parse(-1.0, null))
        assertEquals(t0 + hour, LockdownLogic.parse((t0 + hour).toDouble(), t0.toDouble())!!.until)
        // Kezdés nélkül a vég a kezdés is: inkább rövidnek látsszon, mint hosszabbnak.
        assertEquals(t0 + hour, LockdownLogic.parse((t0 + hour).toDouble(), null)!!.startedAt)
    }

    @Test fun readableRemaining() {
        assertEquals("6 nap 3 óra", LockdownLogic.formatRemaining(6 * 24 * hour + 3 * hour))
        assertEquals("2 nap", LockdownLogic.formatRemaining(2 * 24 * hour))
        assertEquals("2 ó 15 p", LockdownLogic.formatRemaining(2 * hour + 15 * 60_000))
        assertEquals("4 perc", LockdownLogic.formatRemaining(4 * 60_000))
        assertEquals("1 perc", LockdownLogic.formatRemaining(3000), "a maradék sosem nulla perc")
    }

    // ------------------------------------------------------------ a bíró kapuja

    @Test fun noLooseningStartsUnderLockdown() {
        val siteId = addSite()
        Referee.startLockdown(24 * hour, t0)
        val now = t0 + 1000

        // feloldás
        assertFailsWith<Referee.RefereeException> { Referee.startSession(Kind.PAUSE, siteId, 15, now) }
        // végleges törlés
        assertFailsWith<Referee.RefereeException> {
            Referee.startSession(Kind.DELETE, siteId, null, now)
        }
        // menetrend lazítása: a napi huszonnégy óra helyett hétfő 9-10
        assertFailsWith<Referee.RefereeException> {
            Referee.startScheduleChange(siteId, ScheduleLogic.Schedule(
                ScheduleLogic.Mode.SCHEDULED_BLOCK,
                listOf(ScheduleLogic.Band(setOf(1), 540, 600)),
            ), now)
        }
        // keret emelése
        assertFailsWith<Referee.RefereeException> { Referee.startLimitChange(siteId, 7200L, now) }
        // adag lazítása: nagyobb adag, rövidebb szünet
        assertFailsWith<Referee.RefereeException> {
            Referee.startBurstChange(siteId, 3600L, 60L, now)
        }
        // kulcsszó levétele — a gépi böngésző addig tilt vele
        BreakerStore.mutate { it.copy(keywords = listOf("shorts")) }
        assertEquals("LOCKDOWN", assertFailsWith<Referee.RefereeException> { Referee.setKeywords(emptyList(), now) }.code)
        assertNull(BreakerStore.state.value.session, "zárlat alatt próbatétel keletkezett")
    }

    @Test fun lockdownCodeIsSaid() {
        val siteId = addSite()
        Referee.startLockdown(24 * hour, t0)
        val e = assertFailsWith<Referee.RefereeException> {
            Referee.startSession(Kind.PAUSE, siteId, 15, t0 + 1000)
        }
        assertEquals("LOCKDOWN", e.code)
        assertTrue(e.message!!.contains("Zárlat"), "a hibaüzenet nem mondja ki")
    }

    @Test fun tighteningStaysFree() {
        val siteId = addSite()
        Referee.startLockdown(24 * hour, t0)
        val now = t0 + 1000
        assertTrue(Referee.startLimitChange(siteId, 60L, now).applied, "keret csökkentése")
        assertTrue(Referee.startBurstChange(siteId, 60L, 1800L, now).applied, "adag szigorítása")
        assertTrue(Referee.setKeywords(listOf("shorts"), now).applied, "kulcsszó felvétele")
        assertNull(BreakerStore.state.value.session, "szigorítás indított próbatételt")
    }

    @Test fun startTakesBackWhatWasHalfWayOut() {
        val siteId = addSite()
        Referee.startSession(Kind.PAUSE, siteId, 15, t0)
        assertTrue(BreakerStore.state.value.session != null, "a kísérlet elindult a zárlat előtt")
        BreakerStore.mutate { s ->
            s.copy(sites = s.sites.map {
                it.copy(pauseUntil = t0 + 30 * 60_000, pendingDeleteAt = t0 + 20 * hour)
            })
        }

        Referee.startLockdown(24 * hour, t0 + 1000)

        val st = BreakerStore.state.value
        assertNull(st.session, "a futó kísérlet elszállt")
        assertNull(st.sites.first().pauseUntil, "a feloldott oldal visszazárt")
        assertNull(st.sites.first().pendingDeleteAt, "a törlés visszavonódott")
        assertTrue(st.sites.any { it.id == siteId }, "az oldal megvan")
        assertTrue(LockdownLogic.isLocked(st.lockdown, t0 + hour))
    }

    @Test fun lockdownFromAnotherDeviceLandsInTheTick() {
        val siteId = addSite()
        Referee.startSession(Kind.PAUSE, siteId, 15, t0)
        BreakerStore.mutate { s ->
            s.copy(
                sites = s.sites.map {
                    it.copy(pauseUntil = t0 + 30 * 60_000, pendingDeleteAt = t0 + 20 * hour)
                },
                // A szinkron beteszi a másik eszköz zárlatát — a kapu ezt nem látta.
                lockdown = LockdownLogic.Lockdown(t0, t0 + 6 * hour),
            )
        }

        Referee.tick(t0 + 2000)

        val st = BreakerStore.state.value
        assertNull(st.session, "a futó kísérlet itt is elszállt")
        assertNull(st.sites.first().pauseUntil, "a feloldás itt is véget ért")
        assertNull(st.sites.first().pendingDeleteAt, "a törlés itt is visszavonódott")
    }

    @Test fun clockJumpDoesNotEndIt() {
        addSite()
        Referee.tick(t0)
        Referee.startLockdown(7 * 24 * hour, t0)
        val left = LockdownLogic.remainingMs(BreakerStore.state.value.lockdown, t0)

        // három nappal előre ugrik az óra (vagy ennyit aludt a készülék)
        val jumped = t0 + 3 * 24 * hour
        Referee.tick(jumped)

        val after = BreakerStore.state.value.lockdown
        assertTrue(LockdownLogic.isLocked(after, jumped), "az ugrás nem oldhatta fel")
        val leftAfter = LockdownLogic.remainingMs(after, jumped)
        // Az ugrásból a szokásos kör-ütem (pár perc) nem számít ugrásnak — ennyi
        // tényleg eltelhetett. A három napból viszont egy perc sem megy le.
        assertTrue(left - leftAfter < 5 * 60_000, "amennyi hátra volt, annyi van hátra")
        assertFalse(leftAfter > left)
    }
}
