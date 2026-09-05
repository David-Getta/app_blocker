import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.SyncMerge
import hu.breaker.app.core.SyncMerge.SyncSite
import kotlin.test.Test
import kotlin.test.assertEquals
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
        rules: List<hu.breaker.app.core.UrlRules.UrlRule>? = null,
        rev: Int = 1,
        updatedAt: Long = 5_000,
        updatedBy: String = "gep-a",
        // NEVESÍTVE, nem sorrend szerint: egy új mező a SyncSite-ban így nem
        // csúsztatja el csendben az összes többit.
    ) = SyncSite(
        id = id, domain = domain, hostnames = hostnames, addedAt = addedAt,
        pendingDeleteAt = pendingDeleteAt, schedule = schedule,
        dailyLimitSeconds = dailyLimitSeconds, alias = null, rules = rules,
        rev = rev, updatedAt = updatedAt, updatedBy = updatedBy,
    )

    @Test
    fun `a schedule is measured by structure, so two timezones agree`() {
        assertEquals(7 * 1440, SyncMerge.blockedMinutesPerWeek(null))
        assertEquals(5 * 8 * 60, SyncMerge.blockedMinutesPerWeek(work), "H–P 9–17 = heti 2400 perc")
        assertEquals(7 * 8 * 60, SyncMerge.blockedMinutesPerWeek(evening), "22–06 = heti 3360 perc")
        val allow = ScheduleLogic.Schedule(ScheduleLogic.Mode.SCHEDULED_ALLOW, work.bands)
        assertEquals(7 * 1440 - 5 * 8 * 60, SyncMerge.blockedMinutesPerWeek(allow),
            "a megengedő a komplemens")
    }

    @Test
    fun `the stricter record wins when neither is newer`() {
        val strict = site(rev = 4, dailyLimitSeconds = 600)
        val loose = site(rev = 4, dailyLimitSeconds = 3600, updatedAt = 9_999, updatedBy = "gep-b")
        assertEquals(600L, SyncMerge.mergeSite(strict, loose).dailyLimitSeconds)
        assertEquals(600L, SyncMerge.mergeSite(loose, strict).dailyLimitSeconds, "a sorrend nem számít")
    }

    @Test
    fun `a loosening only lands with a higher rev`() {
        val strict = site(rev = 4, dailyLimitSeconds = 600)
        val earned = site(rev = 5, dailyLimitSeconds = 3600, updatedBy = "gep-b")
        assertEquals(3600L, SyncMerge.mergeSite(strict, earned).dailyLimitSeconds,
            "a próbatétel megvolt")

        val stale = site(rev = 3, dailyLimitSeconds = 7200, updatedAt = 99_999, updatedBy = "gep-b")
        assertEquals(600L, SyncMerge.mergeSite(strict, stale).dailyLimitSeconds,
            "régi, lazább rekord nem lazít")
    }

    @Test
    fun `a pending deletion is not lost just because the other device wrote later`() {
        val deleting = site(rev = 3, pendingDeleteAt = 9_000_000)
        val newer = site(rev = 9, updatedBy = "gep-b")
        assertEquals(null, SyncMerge.mergeSite(deleting, newer).pendingDeleteAt,
            "a nagyobb rev azt jelenti, hogy később vonták vissza")

        val older = site(rev = 2, updatedBy = "gep-b")
        assertEquals(9_000_000L, SyncMerge.mergeSite(deleting, older).pendingDeleteAt,
            "a törlés folyamatban marad")
    }

    @Test
    fun `two deletions in flight keep the earlier deadline`() {
        val a = site(rev = 3, pendingDeleteAt = 9_000_000)
        val b = site(rev = 4, pendingDeleteAt = 8_000_000, updatedBy = "gep-b")
        assertEquals(8_000_000L, SyncMerge.mergeSite(a, b).pendingDeleteAt)
        assertEquals(8_000_000L, SyncMerge.mergeSite(b, a).pendingDeleteAt)
    }

    @Test
    fun `the merge is symmetric and settles on one answer`() {
        val a = site(rev = 4, schedule = work, updatedAt = 10, updatedBy = "gep-a")
        val b = site(rev = 4, schedule = evening, updatedAt = 10, updatedBy = "gep-b")
        val ab = SyncMerge.mergeSite(a, b)
        assertEquals(ab, SyncMerge.mergeSite(b, a), "mindkét eszköz ugyanazt kapja")
        assertEquals(7 * 8 * 60, SyncMerge.blockedMinutesPerWeek(ab.schedule), "a többet tiltó marad")
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
        assertEquals("a", m[0].id, "a régebbi azonosító marad")
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
    fun `strictness ranks deletion, schedule and budget in that order`() {
        val plain = site()
        assertEquals(-1, SyncMerge.compareStrictness(plain, site(pendingDeleteAt = 1)))
        assertEquals(1, SyncMerge.compareStrictness(site(schedule = work), plain),
            "a menetrend nélküli szigorúbb")
        assertEquals(-1, SyncMerge.compareStrictness(site(dailyLimitSeconds = 600), plain),
            "a keret szigorít")
        assertEquals(0, SyncMerge.compareStrictness(plain, site()))
        assertTrue(SyncMerge.blockedMinutesPerWeek(null) > SyncMerge.blockedMinutesPerWeek(work))
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
}
