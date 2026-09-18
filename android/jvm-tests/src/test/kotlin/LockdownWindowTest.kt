import android.content.Context
import hu.breaker.app.core.AppState
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.ChallengeEngine.Kind
import hu.breaker.app.core.ChallengeEngine.Step
import hu.breaker.app.core.Focus
import hu.breaker.app.core.FocusSync
import hu.breaker.app.core.LockdownLogic
import hu.breaker.app.core.LockdownLogic.LockdownWindow
import hu.breaker.app.core.Referee
import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.Site
import hu.breaker.app.core.SyncClient
import hu.breaker.app.core.SyncRevisions
import java.util.Calendar
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Zárlat-ablak a telefonon — a desktop/test/lockdown-windows.test.ts tükre.
 *
 * A telefon az ablakot hordozza, fésüli és érvényesíti (a köre zárlatot ír
 * belőle), de nem szerkeszti. Ami itt nem csúszhat el: a kör ugyanazt a
 * zárlatot állítja elő, mint a gép; a kapu az ablakot a kör előtt is látja;
 * az óra-ugrás az ablak zárlatát nem tolja el; a fésülés a JEL szerint dönt.
 *
 * Az időpontok a többi tesztosztály ideje (≈ 2027. január) UTÁN vannak, és
 * tesztenként más napon — a tick tizenöt másodperces szelete az objektumban
 * él, a tesztek között is.
 */
class LockdownWindowTest {

    private fun at(y: Int, m: Int, d: Int, h: Int, min: Int = 0, sec: Int = 0): Long =
        Calendar.getInstance().apply { clear(); set(y, m - 1, d, h, min, sec) }.timeInMillis

    // 2027. március 8. hétfő és a rá következő napok.
    private fun mon(h: Int, min: Int = 0, sec: Int = 0) = at(2027, 3, 8, h, min, sec)
    private fun tue(h: Int, min: Int = 0, sec: Int = 0) = at(2027, 3, 9, h, min, sec)
    private fun wed(h: Int, min: Int = 0, sec: Int = 0) = at(2027, 3, 10, h, min, sec)
    private fun sat(h: Int, min: Int = 0) = at(2027, 3, 13, h, min)
    private val hour = 3_600_000L

    private val work = LockdownWindow("w1", setOf(1, 2, 3, 4, 5), 9 * 60, 17 * 60)
    /** hétfő este → kedd hajnal */
    private val night = LockdownWindow("w2", setOf(1), 22 * 60, 6 * 60)
    private fun allDay(id: String, days: Set<Int>) = LockdownWindow(id, days, 0, 1440)
    private fun bands(vararg w: LockdownWindow) = w.map { it.band }

    @BeforeTest fun reset() {
        BreakerStore.init(Context())
        BreakerStore.mutate { AppState() }
        BreakerStore.saveLastTick(0)
    }

    private fun addSite(): String {
        val id = BreakerStore.newId("site")
        BreakerStore.mutate { s ->
            s.copy(sites = s.sites + Site(
                id = id, domain = "youtube.com", hostnames = listOf("youtube.com"),
                addedAt = mon(1), pauseUntil = null, pendingDeleteAt = null,
            ))
        }
        return id
    }

    // ------------------------------------------------------------------- mag

    @Test fun cleanWindowsKeepsOnlyValidOnesOnce() {
        assertNull(LockdownLogic.cleanWindow(work.copy(id = "")))
        assertNull(LockdownLogic.cleanWindow(work.copy(id = "x".repeat(41))))
        assertNull(LockdownLogic.cleanWindow(work.copy(days = emptySet())))
        assertNull(LockdownLogic.cleanWindow(work.copy(startMin = 1440)))
        assertEquals(setOf(1, 3, 5), LockdownLogic.cleanWindow(work.copy(days = setOf(5, 1, 3, 9)))!!.days,
            "a rossz nap kiesik, a többi rendezve")
        assertEquals(listOf(work), LockdownLogic.cleanWindows(listOf(work, work.copy(endMin = 18 * 60))),
            "azonos azonosító: az első")
        assertEquals(listOf(work), LockdownLogic.cleanWindows(listOf(work, work.copy(id = "masik"))),
            "azonos tartalom: az első")
        val many = (0 until LockdownLogic.MAX_LOCKDOWN_WINDOWS + 2).map { LockdownWindow("w$it", setOf(it % 7), it, it + 1) }
        assertEquals(LockdownLogic.MAX_LOCKDOWN_WINDOWS, LockdownLogic.cleanWindows(many).size)
        assertTrue(LockdownLogic.sameWindows(bands(work), bands(work.copy(id = "x"))), "a tartalom dönt")
        assertFalse(LockdownLogic.sameWindows(bands(work), bands(night)))
    }

    @Test fun theWholeWeekCannotBeLocked() {
        assertTrue(LockdownLogic.weekHasFreeTime(emptyList(), mon(10)))
        assertTrue(LockdownLogic.weekHasFreeTime(bands(work, night), mon(10)))
        assertFalse(LockdownLogic.weekHasFreeTime(bands(allDay("a", setOf(0, 1, 2, 3, 4, 5, 6))), mon(10)))
        assertTrue(LockdownLogic.weekHasFreeTime(bands(allDay("a", setOf(1, 2, 3, 4, 5, 6))), mon(10)), "a vasárnap szabad")
        val perDay = (LockdownLogic.MIN_FREE_MINUTES_PER_WEEK + 6) / 7
        assertTrue(LockdownLogic.weekHasFreeTime(bands(LockdownWindow("a", setOf(0, 1, 2, 3, 4, 5, 6), 0, 1440 - perDay)), mon(10)))
        assertFalse(LockdownLogic.weekHasFreeTime(bands(LockdownWindow("a", setOf(0, 1, 2, 3, 4, 5, 6), 0, 1440 - perDay + 1)), mon(10)))
    }

    @Test fun looseningIsRemovalOrNarrowing() {
        val sun = at(2027, 3, 7, 12)
        assertFalse(LockdownLogic.isWindowsLoosening(emptyList(), bands(work), sun), "felvétel")
        assertTrue(LockdownLogic.isWindowsLoosening(bands(work), emptyList(), sun), "levétel")
        assertFalse(LockdownLogic.isWindowsLoosening(bands(work), bands(work, night), sun), "második ablak")
        assertFalse(LockdownLogic.isWindowsLoosening(bands(work), bands(work.copy(startMin = 8 * 60)), sun), "bővítés")
        assertTrue(LockdownLogic.isWindowsLoosening(bands(work), bands(work.copy(endMin = 12 * 60)), sun), "szűkítés")
        assertTrue(LockdownLogic.isWindowsLoosening(bands(work, night), bands(work), sun), "az egyik levétele")
    }

    @Test fun dueWindowIsTheLatestEndingLiveOne() {
        assertEquals(Focus.Occurrence(mon(9), mon(17)), LockdownLogic.dueWindow(bands(work), mon(10)))
        assertNull(LockdownLogic.dueWindow(bands(work), mon(8, 59)))
        assertNull(LockdownLogic.dueWindow(bands(work), mon(17)), "a vég perce már nincs")
        assertNull(LockdownLogic.dueWindow(bands(work), sat(10)))
        assertEquals(Focus.Occurrence(mon(22), tue(6)), LockdownLogic.dueWindow(bands(work, night), mon(23)))
        assertEquals(Focus.Occurrence(mon(22), tue(6)), LockdownLogic.dueWindow(bands(work, night), tue(1)), "kedd hajnal")
        val late = LockdownWindow("w3", setOf(1), 16 * 60, 18 * 60)
        assertEquals(Focus.Occurrence(mon(16), mon(18)), LockdownLogic.dueWindow(bands(work, late), mon(16, 30)))
    }

    @Test fun windowLockdownEndsWithTheWindow() {
        assertEquals(LockdownLogic.Lockdown(mon(9), mon(17)), LockdownLogic.windowLockdown(null, bands(work), mon(10)))
        assertNull(LockdownLogic.windowLockdown(null, bands(work), mon(8)))
        assertEquals(LockdownLogic.Lockdown(mon(8), mon(17)),
            LockdownLogic.windowLockdown(LockdownLogic.Lockdown(mon(8), mon(10, 30)), bands(work), mon(10)),
            "a futó kézi zárlat vége kitolódik, a kezdése marad")
        assertNull(LockdownLogic.windowLockdown(LockdownLogic.Lockdown(mon(8), mon(18)), bands(work), mon(10)),
            "a hosszabb zárlat marad — sosem rövidül")
        assertEquals(LockdownLogic.Lockdown(mon(9), mon(17)),
            LockdownLogic.windowLockdown(LockdownLogic.Lockdown(mon(1), mon(2)), bands(work), mon(10)),
            "a lejárt nem futó: a kezdés az ablaké")
    }

    @Test fun theEndDecidesWhetherItIsTheWindowsLockdown() {
        assertTrue(LockdownLogic.isWindowLockdown(LockdownLogic.Lockdown(mon(9), mon(17)), bands(work)))
        assertTrue(LockdownLogic.isWindowLockdown(LockdownLogic.Lockdown(mon(8), mon(17)), bands(work)), "kitolt kézi is")
        assertFalse(LockdownLogic.isWindowLockdown(LockdownLogic.Lockdown(mon(9), mon(17, 30)), bands(work)), "meghosszabbítva nem")
        assertFalse(LockdownLogic.isWindowLockdown(LockdownLogic.Lockdown(mon(9), mon(17)), emptyList()))
        assertTrue(LockdownLogic.isWindowLockdown(LockdownLogic.Lockdown(mon(22), tue(6)), bands(night)), "éjfélen át")
        assertTrue(LockdownLogic.isWindowLockdown(LockdownLogic.Lockdown(mon(0), tue(0)), bands(allDay("a", setOf(1)))), "24:00-ig")
    }

    @Test fun mergeIsDecidedByTheMark() {
        assertEquals(listOf(work), LockdownLogic.mergeWindows(5, listOf(work), 3, emptyList()))
        assertEquals(emptyList(), LockdownLogic.mergeWindows(3, listOf(work), 5, emptyList()), "a jeles levétel átjön")
        assertEquals(listOf(work, night), LockdownLogic.mergeWindows(5, listOf(work), 5, listOf(night)), "azonos jel: unió")
        assertEquals(listOf(work), LockdownLogic.mergeWindows(3, listOf(work), 0, emptyList()), "a jeltelen nem töröl")
        assertEquals(listOf(work), LockdownLogic.mergeWindows(5, listOf(work), 5, listOf(work.copy(id = "idegen"))),
            "azonos tartalom: a helyi azonosító marad")
    }

    // ------------------------------------------------------------------ a bíró

    @Test fun theTickWritesTheWindowsLockdownAndTheGateSeesItFirst() {
        val siteId = addSite()
        BreakerStore.mutate { it.copy(lockdownWindows = listOf(work)) }
        Referee.tick(mon(8, 59))
        assertNull(BreakerStore.state.value.lockdown, "ablakon kívül nincs zárlat")
        // A kapu a kör ELŐTT is látja: az ablak kezdése és az első kör közt nincs rés.
        val e = assertFailsWith<Referee.RefereeException> {
            Referee.startSession(Kind.PAUSE, siteId, 15, mon(9, 0, 5))
        }
        assertEquals("LOCKDOWN", e.code)
        assertTrue(e.message!!.contains("Zárlat"))
        Referee.tick(mon(9, 0, 20))
        assertEquals(LockdownLogic.Lockdown(mon(9), mon(17)), BreakerStore.state.value.lockdown,
            "az ablak végéig, az ablak kezdésével — ugyanaz, mint a gépen")
        Referee.tick(mon(17, 0, 40))
        assertFalse(LockdownLogic.isLocked(BreakerStore.state.value.lockdown, mon(17, 0, 40)), "ötkor vége")
        // Ablakon kívül a feloldás megint indítható.
        Referee.startSession(Kind.PAUSE, siteId, 15, mon(17, 1))
        assertTrue(BreakerStore.state.value.session != null)
    }

    @Test fun theArrivingWindowDropsTheRunningAttempt() {
        val siteId = addSite()
        BreakerStore.mutate { it.copy(lockdownWindows = listOf(work)) }
        Referee.startSession(Kind.PAUSE, siteId, 15, tue(8, 50))
        assertTrue(BreakerStore.state.value.session != null)
        Referee.tick(tue(9, 0, 10))
        val st = BreakerStore.state.value
        assertNull(st.session, "bent nincs próbatétel — a félbehagyott is elszáll")
        assertEquals(LockdownLogic.Lockdown(tue(9), tue(17)), st.lockdown)
    }

    @Test fun clockJumpDoesNotMoveTheWindowsLockdownButMovesTheManualOne() {
        addSite()
        BreakerStore.mutate { it.copy(lockdownWindows = listOf(work)) }
        Referee.tick(wed(10))
        assertEquals(LockdownLogic.Lockdown(wed(9), wed(17)), BreakerStore.state.value.lockdown)
        // Három órát aludt a készülék az ablakon belül: az ablak vége az ablak vége.
        Referee.tick(wed(13))
        assertEquals(LockdownLogic.Lockdown(wed(9), wed(17)), BreakerStore.state.value.lockdown)
        // Kézzel meghosszabbítva már nem az ablaké: az ugrás tolja.
        Referee.startLockdown(24 * hour, wed(13, 1))
        val until = BreakerStore.state.value.lockdown!!.until
        assertEquals(wed(13, 1) + 24 * hour, until)
        Referee.tick(wed(16))
        assertTrue(BreakerStore.state.value.lockdown!!.until > until + 2 * hour, "a kézi vég tolódott")
    }

    // ------------------------------------------------------- a bíró: szerkesztés

    @Test fun aWindowStartingSoonIsAnnouncedUnlessALockdownAlreadyCoversIt() {
        val b = bands(work)
        val occ = LockdownLogic.windowStartingSoon(null, b, mon(8, 55))
        assertEquals(Focus.Occurrence(mon(9), mon(17)), occ, "tíz percen belül: jelez")
        assertNull(LockdownLogic.windowStartingSoon(null, b, mon(8, 45)), "negyed óra még sok")
        assertNull(LockdownLogic.windowStartingSoon(null, b, mon(9, 5)), "bent már nem közelgő")
        assertNull(
            LockdownLogic.windowStartingSoon(LockdownLogic.Lockdown(mon(8), mon(18)), b, mon(8, 55)),
            "a futó zárlat túlér rajta: nincs miről szólni",
        )
        assertEquals(
            occ, LockdownLogic.windowStartingSoon(LockdownLogic.Lockdown(mon(8), mon(12)), b, mon(8, 55)),
            "a rövidebb zárlatot kitolja: jelez",
        )
        assertNull(LockdownLogic.windowStartingSoon(null, emptyList(), mon(8, 55)))
    }

    @Test fun addingIsFreeAndKeepsIds() {
        val sun = at(2027, 3, 7, 12)
        assertTrue(Referee.setLockdownWindows(listOf(work.copy(id = "")), sun).applied, "felvétel")
        val first = BreakerStore.state.value.lockdownWindows
        assertEquals(1, first.size)
        assertTrue(first[0].id.startsWith("lw_"), "az azonosítót a bíró adja")
        assertTrue(Referee.setLockdownWindows(first + night, sun).applied, "második ablak")
        assertEquals(listOf(first[0].id, "w2"), BreakerStore.state.value.lockdownWindows.map { it.id })
        // Ugyanaz a tartalom más azonosítóval: nincs teendő, és nem kereszteli át.
        assertTrue(Referee.setLockdownWindows(listOf(work.copy(id = "zzz"), night), sun).applied)
        assertEquals(listOf(first[0].id, "w2"), BreakerStore.state.value.lockdownWindows.map { it.id })
        assertNull(BreakerStore.state.value.session, "egyik sem indított próbatételt")
    }

    @Test fun modifyingKeepsTheIdWideningIsFreeNarrowingIsAChallenge() {
        // A telefon módosító lapja az ablakot a HELYÉRE írja, ugyanazzal az
        // azonosítóval — a bíró a tartalmat hasonlítja: a bővítés azonnal él,
        // a szűkítés próbatétel, és addig a régi ablak marad. Vasárnap: egyik
        // ablak sem él, tehát a szűkítés el is indulhat.
        val sun = at(2027, 3, 7, 14)
        assertTrue(Referee.setLockdownWindows(listOf(work), sun).applied)
        val wider = LockdownWindow(work.id, work.days + 6, work.startMin, 18 * 60)
        assertTrue(Referee.setLockdownWindows(listOf(wider), sun).applied, "bővítés ingyen")
        assertEquals(listOf(wider), BreakerStore.state.value.lockdownWindows, "az azonosító maradt")

        val narrower = LockdownWindow(work.id, setOf(1, 2, 3), 10 * 60, 16 * 60)
        val r = Referee.setLockdownWindows(listOf(narrower), sun)
        assertFalse(r.applied, "szűkítés: próbatétel")
        assertEquals(listOf(wider), BreakerStore.state.value.lockdownWindows, "addig a bővebb ablak áll")
        assertEquals(listOf(narrower), BreakerStore.state.value.session?.pendingLockdownWindows)
    }

    @Test fun invalidAndWholeWeekAreRejected() {
        val sun = at(2027, 3, 7, 12)
        assertFailsWith<Referee.RefereeException> { Referee.setLockdownWindows(listOf(work.copy(days = emptySet())), sun) }
        val e = assertFailsWith<Referee.RefereeException> {
            Referee.setLockdownWindows(listOf(allDay("a", setOf(0, 1, 2, 3, 4, 5, 6))), sun)
        }
        assertEquals("NO_FREE_TIME", e.code)
        assertTrue(BreakerStore.state.value.lockdownWindows.isEmpty())
    }

    @Test fun removalIsAChallengeAndFinishingApplies() {
        val sun = at(2027, 3, 7, 12)
        Referee.setLockdownWindows(listOf(work, night), sun)
        val r = Referee.setLockdownWindows(listOf(work), sun)
        assertFalse(r.applied, "levétel: próbatétel")
        assertEquals("lockdown:windows", r.session!!.siteId)
        assertEquals(listOf(work), r.session.pendingLockdownWindows)
        assertEquals(listOf(work, night), BreakerStore.state.value.lockdownWindows, "amíg a próbatétel tart, az ablak marad")
        assertFailsWith<Referee.RefereeException> { Referee.setLockdownWindows(emptyList(), sun) }
        solveWholeSession(sun)
        assertNull(BreakerStore.state.value.session)
        assertEquals(listOf(work), BreakerStore.state.value.lockdownWindows, "a teljesítés után a levett ablak nincs")
        assertEquals(1, BreakerStore.state.value.unlockLog.size, "a próbatétel a feloldások közé számít")
        // Szűkítés is próbatétel; bővítés ingyen.
        assertFalse(Referee.setLockdownWindows(listOf(work.copy(endMin = 12 * 60)), sun).applied)
        solveWholeSession(sun)
        assertEquals(12 * 60, BreakerStore.state.value.lockdownWindows[0].endMin)
        assertTrue(Referee.setLockdownWindows(listOf(work.copy(endMin = 13 * 60)), sun).applied, "bővítés")
    }

    @Test fun removalInsideTheWindowDoesNotEvenStart() {
        Referee.setLockdownWindows(listOf(work), at(2027, 3, 7, 12))
        val thu = at(2027, 3, 11, 10)
        val e = assertFailsWith<Referee.RefereeException> { Referee.setLockdownWindows(emptyList(), thu) }
        assertEquals("LOCKDOWN", e.code)
        assertNull(BreakerStore.state.value.session)
        // Felvenni bent is ingyen — a szigorítás iránya.
        assertTrue(Referee.setLockdownWindows(listOf(work, night), thu).applied)
    }

    /** Végigviszi a futó kísérletet — a várakozó lépést a célpontja után veszi át. */
    private fun solveWholeSession(now: Long) {
        var guard = 0
        while (BreakerStore.state.value.session != null && guard++ < 200) {
            val s = BreakerStore.state.value.session!!
            when (val step = s.steps[s.stepIndex]) {
                is Step.Delay -> Referee.claimDelay(s.id, (step.claimableAt ?: 0) + 1)
                else -> Referee.submitAnswer(s.id, solveStep(step, now), now)
            }
        }
    }

    /** A helyes válasz; a MEMORY lépést visszadátumozzuk a várakozása mögé. */
    private fun solveStep(step: Step, now: Long): String = when (step) {
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
        is Step.Delay -> error("a várakozást átvenni kell")
        is Step.Partner -> error("a megbízott lépése a jelmondat — ezek a tesztek megbízott nélkül futnak")
    }

    // ---------------------------------------------------------------- szinkron

    @Test fun theBlobCarriesTheWindowsWithTheirMark() {
        val f = FocusSync.SyncFocus(rev = 3, updatedAt = 1, updatedBy = "gep",
            lockdownWindows = listOf(work, night), lockdownWindowsRev = 3)
        val back = SyncClient.focusFromJson(SyncClient.focusToJson(f), "y")
        assertEquals(listOf(work, night), back.lockdownWindows)
        assertEquals(3, back.lockdownWindowsRev)
        // A jel legfeljebb a blob rev-je; a szemét ablak kiesik.
        val junk = """{"packs":[],"run":null,"log":[],"rev":3,"updatedAt":1,"updatedBy":"x",""" +
            """"lockdownWindows":[{"id":"w1","days":[1,2,3,4,5],"startMin":540,"endMin":1020},{"id":"","days":[1],"startMin":0,"endMin":60},"szemét"],""" +
            """"lockdownWindowsRev":9}"""
        val parsed = SyncClient.focusFromJson(junk, "y")
        assertEquals(listOf(work), parsed.lockdownWindows)
        assertNull(parsed.lockdownWindowsRev, "a túl nagy jel nincs")
        assertFalse(SyncClient.focusToJson(FocusSync.SyncFocus(updatedBy = "x")).contains("lockdownWindows"),
            "üresen nincs mező")
    }

    @Test fun mergeFollowsTheMarkNotTheNewerBlob() {
        val mine = FocusSync.SyncFocus(rev = 3, updatedAt = 10, updatedBy = "a",
            lockdownWindows = listOf(work), lockdownWindowsRev = 3)
        val removed = FocusSync.SyncFocus(rev = 5, updatedAt = 20, updatedBy = "b", lockdownWindowsRev = 5)
        assertEquals(emptyList(), FocusSync.merge(mine, removed).lockdownWindows, "a levétel átjön")
        assertEquals(emptyList(), FocusSync.merge(removed, mine).lockdownWindows)
        assertEquals(5, FocusSync.merge(mine, removed).lockdownWindowsRev)
        // Régi kliens: magasabb rev, se ablak, se jel — nem törölhet.
        val old = FocusSync.SyncFocus(rev = 9, updatedAt = 30, updatedBy = "c")
        assertEquals(listOf(work), FocusSync.merge(mine, old).lockdownWindows)
        assertEquals(listOf(work), FocusSync.merge(old, mine).lockdownWindows)
        // Azonos jel: unió.
        val other = FocusSync.SyncFocus(rev = 5, updatedAt = 1, updatedBy = "d",
            lockdownWindows = listOf(night), lockdownWindowsRev = 3)
        assertEquals(listOf(work, night), FocusSync.merge(mine, other).lockdownWindows)
        assertFalse(FocusSync.same(mine, other), "más ablak: van mit feltölteni")
        assertTrue(FocusSync.same(mine, mine.copy(lockdownWindows = listOf(work.copy(id = "x")))), "az azonosító nem számít")
        assertFalse(FocusSync.isEmpty(FocusSync.SyncFocus(updatedBy = "x", lockdownWindows = listOf(work))))
    }

    @Test fun aLockdownAloneIsSomethingToUpload() {
        // Ez a gépen és az iPhone-on mindig így volt; itt lemaradt a kulcsból,
        // és egy csak a telefonon indított zárlat tényleg nem ment fel.
        val mine = FocusSync.SyncFocus(rev = 3, updatedAt = 1, updatedBy = "a",
            lockdown = LockdownLogic.Lockdown(mon(9), mon(17)))
        assertFalse(FocusSync.same(mine, mine.copy(lockdown = null)))
    }

    @Test fun theWindowsGetAMarkWhenTheyChange() {
        var st = AppState()
        st = SyncRevisions.bumpFocus(st, "telefon", mon(1))
        assertEquals(0L, st.focusRev, "az üresség nem szerkesztés")
        st = SyncRevisions.bumpFocus(st.copy(lockdownWindows = listOf(work)), "telefon", mon(1))
        assertEquals(1L, st.focusRev)
        assertEquals(1, st.lockdownWindowsRev, "az első jel is jel")
        assertEquals(st, SyncRevisions.bumpFocus(st, "telefon", mon(1)), "változatlanul nem léptet")
        st = SyncRevisions.bumpFocus(st.copy(focusPacks = listOf(Focus.FocusPack("p1", "Írás", emptyList(), emptyList(), 25))), "telefon", mon(1))
        assertEquals(2L, st.focusRev)
        assertEquals(1, st.lockdownWindowsRev, "a csomag szerkesztése nem az ablakok jele")
        st = SyncRevisions.bumpFocus(st.copy(lockdownWindows = listOf(work, night)), "telefon", mon(1))
        assertEquals(3, st.lockdownWindowsRev)
        val adopted = SyncRevisions.adoptFocus(st.copy(lockdownWindows = listOf(night)))
        assertEquals(adopted, SyncRevisions.bumpFocus(adopted, "telefon", mon(1)), "az átvétel nem szerkesztés")
    }
}
