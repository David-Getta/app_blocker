import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.SyncMerge
import hu.breaker.app.core.SyncMerge.SyncSite
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * Az összefésülés nem oldhat fel semmit — a `desktop/test/sync-merge.test.ts`
 * tükre.
 *
 * Ha ez a mag elcsúszik a TypeScript változatától, a felhasználó telefonján más
 * lesz blokkolva, mint a gépén. A tesztek nagy része ezért nem azt nézi, hogy
 * „jó-e az eredmény”, hanem hogy NEM LETT-E LAZÁBB.
 */
class SyncMergeTest {

    private val work = ScheduleLogic.Schedule(
        ScheduleLogic.Mode.SCHEDULED_BLOCK,
        listOf(ScheduleLogic.Band(setOf(1, 2, 3, 4, 5), 9 * 60, 17 * 60)),
    )
    private val evening = ScheduleLogic.Schedule(
        ScheduleLogic.Mode.SCHEDULED_BLOCK,
        listOf(ScheduleLogic.Band(setOf(0, 1, 2, 3, 4, 5, 6), 22 * 60, 6 * 60)),
    )

    private fun site(
        id: String = "site_1",
        domain: String = "youtube.com",
        hostnames: List<String> = listOf("youtube.com"),
        addedAt: Long = 1_000,
        pendingDeleteAt: Long? = null,
        schedule: ScheduleLogic.Schedule? = null,
        dailyLimitSeconds: Long? = null,
        burstSeconds: Long? = null,
        cooldownSeconds: Long? = null,
        alias: String? = null,
        reason: String? = null,
        rules: List<hu.breaker.app.core.UrlRules.UrlRule>? = null,
        rev: Int = 1,
        updatedAt: Long = 5_000,
        updatedBy: String = "gep-a",
        deleteLoosens: Int? = null,
        scheduleLoosens: Int? = null,
        limitLoosens: Int? = null,
        burstLoosens: Int? = null,
        // NEVESÍTVE, nem sorrend szerint: egy új mező a SyncSite-ban így nem
        // csúsztatja el csendben az összes többit.
    ) = SyncSite(
        id = id, domain = domain, hostnames = hostnames, addedAt = addedAt,
        pendingDeleteAt = pendingDeleteAt, schedule = schedule,
        dailyLimitSeconds = dailyLimitSeconds, burstSeconds = burstSeconds,
        cooldownSeconds = cooldownSeconds, alias = alias, reason = reason, rules = rules,
        rev = rev, updatedAt = updatedAt, updatedBy = updatedBy,
        deleteLoosens = deleteLoosens, scheduleLoosens = scheduleLoosens,
        limitLoosens = limitLoosens, burstLoosens = burstLoosens,
    )

    /** Tilt-e a menetrend egy napon, egy percben — a sávok szerkezete szerint. */
    private fun blocked(s: ScheduleLogic.Schedule, day: Int, minute: Int): Boolean =
        s.bands.any { day in it.days && minute >= it.startMin && minute < it.endMin } ==
            (s.mode == ScheduleLogic.Mode.SCHEDULED_BLOCK)

    @Test
    fun `the stricter form of two schedules is their union, by structure, whatever the timezone`() {
        // Ha az összevetés a telefon helyi idejét használná, két eszköz két
        // különböző eredményre jutna, és a szinkron sosem állna meg.
        val both = SyncMerge.joinSchedule(work, evening)!!
        assertEquals(ScheduleLogic.Mode.SCHEDULED_BLOCK, both.mode)
        assertTrue(blocked(both, 1, 10 * 60), "hétfő délelőtt: a munkaidő tilt")
        assertTrue(blocked(both, 3, 23 * 60), "szerda este: az esti sáv tilt")
        assertFalse(blocked(both, 6, 12 * 60), "szombat délben egyik sem")
        assertEquals(both, SyncMerge.joinSchedule(evening, work), "a sorrend nem számít")
        assertNull(SyncMerge.joinSchedule(work, null), "a menetrend nélküli (mindig tilt) lefed mindent")
        assertSame(work, SyncMerge.joinSchedule(work, work), "ugyanaz marad, nem íródik újra")
        val wider = ScheduleLogic.Schedule(
            ScheduleLogic.Mode.SCHEDULED_BLOCK,
            listOf(ScheduleLogic.Band(setOf(1, 2, 3, 4, 5), 8 * 60, 18 * 60)),
        )
        assertSame(wider, SyncMerge.joinSchedule(work, wider), "ha az egyik lefedi a másikat, az marad")
        // A megengedő mód a komplemens: ami ott nincs megengedve, az tilt.
        val allow = ScheduleLogic.Schedule(ScheduleLogic.Mode.SCHEDULED_ALLOW, work.bands)
        assertEquals(ScheduleLogic.Schedule(ScheduleLogic.Mode.ALWAYS, emptyList()), SyncMerge.joinSchedule(allow, work),
            "a munkaidőn kívül tilt + munkaidőben tilt = mindig")
    }

    @Test
    fun `at equal counters each field takes its stricter form, not one record whole`() {
        // A régi szabály a rekordokat rendezte (előbb a menetrend, aztán a
        // keret): a menetrendben szigorúbb, keretben lazább rekord egészében
        // nyert, és a máshol lecsökkentett keret ingyen visszanőtt.
        val a = site(rev = 4, schedule = work, dailyLimitSeconds = 3600)
        val b = site(rev = 4, dailyLimitSeconds = 600, schedule = evening, updatedBy = "gep-b")
        for (m in listOf(SyncMerge.mergeSite(a, b), SyncMerge.mergeSite(b, a))) {
            assertEquals(600L, m.dailyLimitSeconds, "a kisebb keret")
            assertEquals(SyncMerge.joinSchedule(work, evening), m.schedule, "a két menetrend uniója")
        }
        val burst = SyncMerge.mergeSite(
            site(burstSeconds = 300, cooldownSeconds = 600),
            site(burstSeconds = 600, cooldownSeconds = 1200, updatedBy = "gep-b"),
        )
        assertEquals(300L to 1200L, burst.burstSeconds to burst.cooldownSeconds, "a kisebb adag és a hosszabb szünet")
    }

    @Test
    fun `a loosening only lands with the paid counter, a higher rev alone carries nothing`() {
        val strict = site(rev = 4, dailyLimitSeconds = 600)
        val earned = site(rev = 5, dailyLimitSeconds = 3600, limitLoosens = 1, updatedBy = "gep-b")
        assertEquals(3600L, SyncMerge.mergeSite(strict, earned).dailyLimitSeconds, "a próbatétel megvolt")
        assertEquals(3600L, SyncMerge.mergeSite(earned, strict).dailyLimitSeconds)
        // A TRÜKK: egy elavult eszköz ingyenes szerkesztésekkel felhúzza a rev-et.
        val stale = site(rev = 99, dailyLimitSeconds = 7200, updatedAt = 99_999, updatedBy = "gep-b")
        assertEquals(600L, SyncMerge.mergeSite(strict, stale).dailyLimitSeconds, "régi, lazább rekord nem lazít")
        assertEquals(600L, SyncMerge.mergeSite(stale, strict).dailyLimitSeconds)
        // A számláló mezőnként: a keret lazítása nem viszi el a máshol felvett menetrendet.
        val scheduled = site(rev = 6, schedule = work, dailyLimitSeconds = 600)
        val earnedEvening = site(rev = 5, schedule = evening, dailyLimitSeconds = 3600, limitLoosens = 1, updatedBy = "gep-b")
        val m = SyncMerge.mergeSite(scheduled, earnedEvening)
        assertEquals(3600L, m.dailyLimitSeconds)
        assertEquals(SyncMerge.joinSchedule(work, evening), m.schedule, "a menetrend a saját számlálója szerint dől el")
    }

    @Test
    fun `the alias and the reason come from the newer record, they do not block`() {
        val older = site(rev = 3, alias = "Régi", reason = "régi indok")
        val newer = site(rev = 5, alias = "Új", reason = "új indok", updatedBy = "gep-b")
        for (m in listOf(SyncMerge.mergeSite(older, newer), SyncMerge.mergeSite(newer, older))) {
            assertEquals("Új", m.alias)
            assertEquals("új indok", m.reason)
            assertEquals(5, m.rev)
        }
    }

    @Test
    fun `a pending deletion does not vanish silently, only one who saw it can cancel`() {
        val deleting = site(rev = 3, pendingDeleteAt = 9_000_000, deleteLoosens = 1)
        // A másik eszköz nem is tudott a kérésről — a nagyobb rev-je ellenére sem dobja el.
        val unaware = site(rev = 9, alias = "A videós", updatedBy = "gep-b")
        val m = SyncMerge.mergeSite(deleting, unaware)
        assertEquals("A videós", m.alias, "a frissebb rekord fedőneve jön")
        assertEquals(9_000_000L, m.pendingDeleteAt, "a kifizetett kérés megmarad")
        // Aki látta a kérést (a számlálója ugyanannyi) és visszavonta: az ingyen van, és átmegy.
        val cancelled = site(rev = 4, deleteLoosens = 1, updatedBy = "gep-b")
        assertNull(SyncMerge.mergeSite(deleting, cancelled).pendingDeleteAt)
        assertNull(SyncMerge.mergeSite(cancelled, deleting).pendingDeleteAt)
    }

    @Test
    fun `two independent deletion requests at equal counters keep the later deadline`() {
        val a = site(rev = 3, pendingDeleteAt = 9_000_000, deleteLoosens = 1)
        val b = site(rev = 4, pendingDeleteAt = 8_000_000, deleteLoosens = 1, updatedBy = "gep-b")
        assertEquals(9_000_000L, SyncMerge.mergeSite(a, b).pendingDeleteAt)
        assertEquals(9_000_000L, SyncMerge.mergeSite(b, a).pendingDeleteAt)
        // Az újra kért (két kérés) nyer — az övé a frissebb kifizetett döntés.
        val again = site(rev = 6, pendingDeleteAt = 7_000_000, deleteLoosens = 2)
        assertEquals(7_000_000L, SyncMerge.mergeSite(a, again).pendingDeleteAt)
    }

    @Test
    fun `the merge is symmetric and settles on one answer`() {
        val a = site(rev = 4, schedule = work, updatedAt = 10, updatedBy = "gep-a")
        val b = site(rev = 4, schedule = evening, updatedAt = 10, updatedBy = "gep-b")
        val ab = SyncMerge.mergeSite(a, b)
        assertEquals(ab, SyncMerge.mergeSite(b, a), "mindkét eszköz ugyanazt kapja")
        assertEquals(SyncMerge.joinSchedule(work, evening), ab.schedule, "mindkettő tiltása marad")
        assertEquals(ab, SyncMerge.mergeSite(ab, a), "és stabil")
        assertEquals(ab, SyncMerge.mergeSite(ab, b))
    }

    @Test
    fun `signing in unions the lists instead of replacing them`() {
        val local = listOf(site(id = "a", domain = "youtube.com"))
        val remote = listOf(site(id = "b", domain = "reddit.com", addedAt = 2_000))
        assertEquals(
            listOf("youtube.com", "reddit.com"),
            SyncMerge.mergeLists(local, remote).map { it.domain },
        )
        // Üres fiókkal belépve sem tűnhet el semmi — különben a kijelentkezés és
        // a visszalépés lenne a legolcsóbb feloldás.
        assertEquals(listOf("youtube.com"), SyncMerge.mergeLists(local, emptyList()).map { it.domain })
        assertEquals(listOf("reddit.com"), SyncMerge.mergeLists(emptyList(), remote).map { it.domain })
    }

    @Test
    fun `the same domain added on two devices becomes one record`() {
        val a = site(id = "a", addedAt = 1_000, hostnames = listOf("youtube.com"))
        val b = site(id = "b", addedAt = 2_000, updatedBy = "gep-b",
            hostnames = listOf("youtube.com", "youtu.be", "m.youtube.com"))
        val m = SyncMerge.mergeLists(listOf(a), listOf(b))
        assertEquals(1, m.size, "két sor ugyanarról az oldalról félrevezető lenne")
        assertEquals("b", m[0].id, "az újabban felvett azonosító marad — a régi törlés sírköve így nem viheti el")
        assertEquals(2_000, m[0].addedAt, "a felvétel ideje is az övé")
        assertEquals(listOf("m.youtube.com", "youtu.be", "youtube.com"), m[0].hostnames,
            "a hosztnevek egyesülnek: az egyesítés a szigorúbb")
    }

    @Test
    fun `equal rev unions the hostnames, only a higher rev carries a removal`() {
        // A hosztnév-lista a tiltás része. Egy név levétele lazítás, ami csak
        // próbatétel után, rev-emeléssel mehet át; versenyhelyzet nem old fel.
        val a = site(rev = 4, hostnames = listOf("youtube.com", "www.youtube.com"), updatedAt = 100)
        val b = site(rev = 4, hostnames = listOf("youtube.com", "music.youtube.com"),
            updatedAt = 200, updatedBy = "gep-b")
        val union = listOf("music.youtube.com", "www.youtube.com", "youtube.com")
        assertEquals(union, SyncMerge.mergeSite(a, b).hostnames, "a versenyhelyzet nem old fel")
        assertEquals(union, SyncMerge.mergeSite(b, a).hostnames, "a sorrend nem számít")

        val trimmed = site(rev = 5, hostnames = listOf("youtube.com"), updatedBy = "gep-b")
        val old = site(rev = 4, hostnames = listOf("youtube.com", "music.youtube.com"))
        assertEquals(listOf("youtube.com"), SyncMerge.mergeSite(trimmed, old).hostnames,
            "a próbatétel mögötte van")
        assertEquals(listOf("youtube.com"), SyncMerge.mergeSite(old, trimmed).hostnames)
    }

    @Test
    fun `merging is idempotent and order-independent`() {
        val a = listOf(site(id = "a", rev = 2, dailyLimitSeconds = 600))
        val b = listOf(site(id = "a", rev = 2, dailyLimitSeconds = 1200, updatedBy = "gep-b"))
        val once = SyncMerge.mergeLists(a, b)
        assertEquals(once, SyncMerge.mergeLists(once, b), "újra lefuttatva nem mozdul")
        assertEquals(once, SyncMerge.mergeLists(b, a), "a sorrend nem számít")
    }

    @Test
    fun `the stricter form of a budget and of a burst rule`() {
        assertEquals(600L, SyncMerge.joinLimit(600, 3600))
        assertEquals(3600L, SyncMerge.joinLimit(null, 3600), "a keret nélküli a leglazább")
        assertNull(SyncMerge.joinLimit(null, null))
        assertEquals(300L to 900L, SyncMerge.joinBurst(300L to 900L, null to null))
        assertEquals(200L to 900L, SyncMerge.joinBurst(300L to 600L, 200L to 900L), "mindkettő szigorúbbja")
    }

    // ------------------------------------------------------------- jelek
    //
    // A név jele a rekord rev-je, amelyik felvette vagy levette. Enélkül egyenlő
    // revnél az egyesítés visszahozná a kifizetett levételt, nagyobb revnél a
    // kétszer író gép egyben vinné a régi listát. A merge-hostnames.test.ts
    // tükre; a telefon jelet nem ír, de fésül és hordoz.

    @Test fun `a marked removal beats the union at equal rev, and the other edit survives`() {
        val removed = site(rev = 4, hostnames = listOf("youtube.com"), updatedAt = 100)
            .copy(hostnameMarks = mapOf("music.youtube.com" to 4))
        val other = site(rev = 4, hostnames = listOf("music.youtube.com", "youtube.com"), updatedAt = 200, updatedBy = "telefon")
            .copy(alias = "tube")
        for ((x, y) in listOf(removed to other, other to removed)) {
            val m = SyncMerge.mergeSite(x, y)
            assertEquals(listOf("youtube.com"), m.hostnames, "a kifizetett levétel áll")
            assertEquals("tube", m.alias, "a másik szerkesztés nem veszett el")
            assertEquals(mapOf("music.youtube.com" to 4), m.hostnameMarks, "a jel utazik tovább")
        }
    }

    @Test fun `a newer record does not resurrect a marked removal, a newer mark re-adds, no mark means the wider list`() {
        val removed = site(rev = 3, hostnames = listOf("youtube.com"))
            .copy(hostnameMarks = mapOf("music.youtube.com" to 3))
        val twice = site(rev = 5, hostnames = listOf("music.youtube.com", "youtube.com"), updatedBy = "telefon")
        assertEquals(listOf("youtube.com"), SyncMerge.mergeSite(twice, removed).hostnames)
        assertEquals(listOf("youtube.com"), SyncMerge.mergeSite(removed, twice).hostnames)

        val readded = site(rev = 6, hostnames = listOf("music.youtube.com", "youtube.com"))
            .copy(hostnameMarks = mapOf("music.youtube.com" to 6))
        assertEquals(listOf("music.youtube.com", "youtube.com"), SyncMerge.mergeSite(removed, readded).hostnames)
        assertEquals(mapOf("music.youtube.com" to 6), SyncMerge.mergeSite(readded, removed).hostnameMarks)

        // A régebbi rekord ingyenes felvétele sem vész el a nagyobb rev mögött.
        val newer = site(rev = 5, hostnames = listOf("youtube.com"))
        val older = site(rev = 4, hostnames = listOf("m.youtube.com", "youtube.com"), updatedBy = "telefon")
            .copy(hostnameMarks = mapOf("m.youtube.com" to 4))
        assertEquals(listOf("m.youtube.com", "youtube.com"), SyncMerge.mergeSite(newer, older).hostnames)

        // Jel nélkül (régi kliens) a bővebb nyer, és jel sem keletkezik.
        val plain = site(rev = 4, hostnames = listOf("youtube.com"))
        val legacy = site(rev = 4, hostnames = listOf("m.youtube.com", "youtube.com"), updatedBy = "telefon")
        val m = SyncMerge.mergeSite(plain, legacy)
        assertEquals(listOf("m.youtube.com", "youtube.com"), m.hostnames)
        assertEquals(null, m.hostnameMarks)
    }

    @Test fun `equal positive marks with opposite presence keep the name, whatever the rev`() {
        // Sorrendtől független, és sosem lazább: a jelenlét nyer.
        val gone = site(rev = 9, hostnames = listOf("youtube.com")).copy(hostnameMarks = mapOf("music.youtube.com" to 4))
        val here = site(rev = 4, hostnames = listOf("music.youtube.com", "youtube.com"), updatedBy = "telefon")
            .copy(hostnameMarks = mapOf("music.youtube.com" to 4))
        assertEquals(listOf("music.youtube.com", "youtube.com"), SyncMerge.mergeSite(gone, here).hostnames)
        assertEquals(listOf("music.youtube.com", "youtube.com"), SyncMerge.mergeSite(here, gone).hostnames)
    }

    @Test fun `the marks cap keeps present names and the freshest removed ones`() {
        val marks = LinkedHashMap<String, Int>()
        marks["www.youtube.com"] = 3
        for (i in 0 until 70) marks["h${i.toString().padStart(2, '0')}.youtube.com"] = 100 + (i % 7)
        val capped = SyncMerge.capHostnameMarks(marks, listOf("www.youtube.com", "youtube.com"))!!
        assertEquals(SyncMerge.MAX_HOSTNAME_MARKS, capped.size)
        assertEquals(3, capped["www.youtube.com"], "a jelen lévő név jele marad")
        assertEquals(60, capped.values.count { it > 100 }, "minden 101-es és fölötti megmaradt")
        assertNull(SyncMerge.capHostnameMarks(emptyMap(), emptyList()))
    }
}
