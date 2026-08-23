import hu.breaker.app.core.UsageLogic
import hu.breaker.app.core.UsageLogic.Foreground
import hu.breaker.app.core.UsageLogic.TargetKind
import java.util.Calendar
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Usage aggregation, mirroring desktop/test/usage.test.ts. The two cores must
 * agree — this file is what keeps the Kotlin mirror honest.
 */
class UsageLogicTest {

    private fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int): Long {
        val c = Calendar.getInstance()
        c.set(y, mo - 1, d, h, mi, 0); c.set(Calendar.MILLISECOND, 0)
        return c.timeInMillis
    }

    private fun daysAgo(now: Long, k: Int): Long {
        val c = Calendar.getInstance().apply {
            timeInMillis = now
            set(Calendar.HOUR_OF_DAY, 12); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }
        c.add(Calendar.DAY_OF_MONTH, -k)
        return c.timeInMillis
    }

    private val now = at(2026, 5, 20, 15, 30)

    @Test fun `keys build and parse`() {
        assertEquals("site:youtube.com", UsageLogic.siteKey("youtube.com"))
        assertEquals(TargetKind.APP, UsageLogic.kindOf("app:Slack"))
        assertEquals(TargetKind.SITE, UsageLogic.kindOf("site:youtube.com"))
        // ids containing a colon survive: only the first separator is consumed
        assertEquals("com.foo:bar", UsageLogic.idOf("app:com.foo:bar"))
    }

    @Test fun `day keys are ASCII and chronologically ordered`() {
        assertEquals("2026-05-20", UsageLogic.dayKey(now))
        assertEquals(listOf("2026-05-18", "2026-05-19", "2026-05-20"), UsageLogic.dayKeysBack(now, 3))
        val keys = UsageLogic.dayKeysBack(now, 40)
        assertEquals(keys.sorted(), keys, "lexicographic order must equal chronological order")
        // a locale with native digit shapes would break every aggregation
        assertTrue(keys.all { it.matches(Regex("^\\d{4}-\\d{2}-\\d{2}$")) })
    }

    @Test fun `records accumulate into today and remember labels`() {
        val st = UsageLogic.UsageState()
        UsageLogic.recordSample(st, "site:youtube.com", 5.0, now, "YouTube")
        UsageLogic.recordSample(st, "site:youtube.com", 5.0, now)
        UsageLogic.recordSample(st, "app:Slack", 10.0, now, "Slack")
        assertEquals(1, st.days.size)
        assertEquals(10.0, st.days[0].seconds["site:youtube.com"])
        assertEquals("YouTube", UsageLogic.labelOf(st, "site:youtube.com"))
        assertEquals("reddit.com", UsageLogic.labelOf(st, "site:reddit.com"), "unknown label falls back to the id")
    }

    @Test fun `invalid samples are ignored and the off switch is honoured`() {
        val st = UsageLogic.UsageState()
        UsageLogic.recordSample(st, "site:a.com", 0.0, now)
        UsageLogic.recordSample(st, "site:a.com", -5.0, now)
        UsageLogic.recordSample(st, "site:a.com", Double.NaN, now)
        assertTrue(st.days.isEmpty())

        val off = UsageLogic.UsageState(enabled = false)
        UsageLogic.recordSample(off, "site:b.com", 5.0, now)
        assertTrue(off.days.isEmpty())
    }

    @Test fun `batched time survives but a day cap still applies`() {
        val st = UsageLogic.UsageState()
        // a batch that waited out a long outage is legitimate and must not truncate
        UsageLogic.recordSample(st, "site:a.com", 8.0 * 3600, now)
        assertEquals(8.0 * 3600, st.days[0].seconds["site:a.com"])
        // more than a day for one target in one day is impossible
        UsageLogic.recordSample(st, "site:b.com", 40.0 * 3600, now)
        assertEquals(UsageLogic.MAX_RECORD_SECONDS, st.days[0].seconds["site:b.com"])
    }

    @Test fun `retention is bounded by bucket count`() {
        val st = UsageLogic.UsageState()
        for (i in UsageLogic.RETENTION_DAYS + 10 downTo 0) {
            UsageLogic.recordSample(st, "site:a.com", 10.0, daysAgo(now, i), "A")
        }
        assertEquals(UsageLogic.RETENTION_DAYS, st.days.size)
        assertEquals(UsageLogic.dayKey(now), st.days.last().day)
    }

    @Test fun `a wrong system clock never wipes history`() {
        val st = UsageLogic.UsageState()
        UsageLogic.recordSample(st, "site:a.com", 10.0, daysAgo(now, 1))
        UsageLogic.recordSample(st, "site:a.com", 10.0, now)
        val before = st.days.size
        UsageLogic.pruneOld(st, now + 365L * 24 * 3600_000)
        assertEquals(before, st.days.size, "forward jump keeps history")
        UsageLogic.pruneOld(st, now - 365L * 24 * 3600_000)
        assertEquals(before, st.days.size, "backward jump keeps history")
    }

    @Test fun `a backdated sample never deletes newer buckets`() {
        val st = UsageLogic.UsageState()
        UsageLogic.recordSample(st, "site:a.com", 10.0, now)
        UsageLogic.recordSample(st, "site:a.com", 10.0, daysAgo(now, 1))
        UsageLogic.recordSample(st, "site:a.com", 10.0, daysAgo(now, 20))
        assertEquals(3, st.days.size)
        assertEquals(10.0, UsageLogic.totalsForDays(st, listOf(UsageLogic.dayKey(now)))["site:a.com"])
    }

    @Test fun `orphaned labels are cleaned up`() {
        val st = UsageLogic.UsageState()
        UsageLogic.recordSample(st, "site:old.com", 10.0, daysAgo(now, 5), "Old")
        UsageLogic.recordSample(st, "site:new.com", 10.0, now, "New")
        st.days.removeAll { it.day != UsageLogic.dayKey(now) } // the old day ages out
        UsageLogic.pruneOld(st, now)
        assertNull(st.labels["site:old.com"])
        assertEquals("New", st.labels["site:new.com"])
    }

    @Test fun `ranking sorts by time and can filter by kind`() {
        val st = UsageLogic.UsageState()
        UsageLogic.recordSample(st, "site:youtube.com", 100.0, now, "YouTube")
        UsageLogic.recordSample(st, "site:reddit.com", 50.0, now, "Reddit")
        UsageLogic.recordSample(st, "app:Slack", 75.0, now, "Slack")
        val totals = UsageLogic.totalsForDays(st, listOf(UsageLogic.dayKey(now)))
        assertEquals(225.0, UsageLogic.sumOf(totals))
        assertEquals(
            listOf("site:youtube.com", "app:Slack", "site:reddit.com"),
            UsageLogic.rank(st, totals).map { it.key },
        )
        assertEquals(
            listOf("site:youtube.com", "site:reddit.com"),
            UsageLogic.rank(st, totals, TargetKind.SITE).map { it.key },
        )
        assertEquals(2, UsageLogic.rank(st, totals, null, 2).size)
    }

    @Test fun `series is zero-filled and oldest first`() {
        val st = UsageLogic.UsageState()
        UsageLogic.recordSample(st, "site:a.com", 30.0, daysAgo(now, 2))
        UsageLogic.recordSample(st, "site:a.com", 10.0, now)
        assertEquals(listOf(30.0, 0.0, 10.0), UsageLogic.series(st, "site:a.com", now, 3).map { it.second })
        assertEquals(listOf(0.0, 0.0, 0.0), UsageLogic.series(st, "site:none.com", now, 3).map { it.second })
    }

    @Test fun `week over week compares the last 7 days with the 7 before`() {
        val st = UsageLogic.UsageState()
        UsageLogic.recordSample(st, "site:youtube.com", 100.0, daysAgo(now, 8), "YouTube")
        UsageLogic.recordSample(st, "site:youtube.com", 100.0, daysAgo(now, 9))
        UsageLogic.recordSample(st, "site:youtube.com", 100.0, daysAgo(now, 10))
        UsageLogic.recordSample(st, "site:youtube.com", 100.0, daysAgo(now, 2))
        UsageLogic.recordSample(st, "site:new.com", 50.0, now, "New")

        val rows = UsageLogic.weekOverWeek(st, now)
        val yt = rows.first { it.key == "site:youtube.com" }
        assertEquals(100.0, yt.thisWeek)
        assertEquals(300.0, yt.lastWeek)
        assertEquals(-67L, Math.round(yt.deltaPct!!))
        assertNull(rows.first { it.key == "site:new.com" }.deltaPct, "no baseline -> null, not infinity")
    }

    @Test fun `summary reports today yesterday and the rolling windows`() {
        val st = UsageLogic.UsageState()
        UsageLogic.recordSample(st, "site:youtube.com", 120.0, now, "YouTube")
        UsageLogic.recordSample(st, "app:Slack", 60.0, now, "Slack")
        UsageLogic.recordSample(st, "site:youtube.com", 90.0, daysAgo(now, 1))
        UsageLogic.recordSample(st, "site:youtube.com", 30.0, daysAgo(now, 20))

        val s = UsageLogic.summarize(st, now)
        assertEquals(180.0, s.todaySeconds)
        assertEquals(90.0, s.yesterdaySeconds)
        assertEquals(270.0, s.last7Seconds)
        assertEquals(300.0, s.last30Seconds)
        assertEquals(3, s.daysTracked)
        assertEquals(listOf("site:youtube.com"), s.topWeekSites.map { it.key })
        assertEquals(listOf("app:Slack"), s.topWeekApps.map { it.key })
    }

    @Test fun `empty state summarises to zeros`() {
        val s = UsageLogic.summarize(UsageLogic.UsageState(), now)
        assertEquals(0.0, s.todaySeconds)
        assertTrue(s.topWeekSites.isEmpty())
        assertTrue(s.weekOverWeek.isEmpty())
    }

    @Test fun `only focused non-idle time is counted`() {
        val fgSite = Foreground("com.android.chrome", "Chrome", "youtube.com")
        val d = UsageLogic.decideSample(now - 5000, now, 2000, fgSite)!!
        assertEquals("site:youtube.com", d.key, "a browser tab counts towards the SITE")
        assertEquals(5.0, d.seconds)

        assertEquals("app:com.slack",
            UsageLogic.decideSample(now - 5000, now, 2000, Foreground("com.slack", "Slack"))!!.key)

        assertNull(UsageLogic.decideSample(now - 5000, now, 60_000, fgSite), "idle at the threshold")
        assertNotNull(UsageLogic.decideSample(now - 5000, now, 59_000, fgSite), "just under the threshold")
        assertNull(UsageLogic.decideSample(now - 5000, now, 2000, null), "nothing focused")
    }

    @Test fun `sleep and clock anomalies cannot inflate a sample`() {
        val fg = Foreground("x", "X")
        // slept 8 hours between ticks; the user was not present for it
        assertEquals(10.0, UsageLogic.decideSample(now - 8 * 3600_000, now, 1000, fg)!!.seconds)
        assertNull(UsageLogic.decideSample(now, now, 1000, fg), "non-advancing clock")
        assertNull(UsageLogic.decideSample(now + 1000, now, 1000, fg), "backwards clock")
    }

    @Test fun `a day cannot hold unbounded targets and the tail is not lost`() {
        val st = UsageLogic.UsageState()
        // a page fetching random subdomains, or anything else inventing names
        for (i in 0 until UsageLogic.MAX_TARGETS_PER_DAY + 150) {
            UsageLogic.recordSample(st, "site:flood$i.example", (i + 1).toDouble(), now)
        }
        val bucket = st.days[0]
        assertTrue(bucket.seconds.size <= UsageLogic.MAX_TARGETS_PER_DAY,
            "kept ${bucket.seconds.size}, cap is ${UsageLogic.MAX_TARGETS_PER_DAY}")
        assertTrue(UsageLogic.OTHER_SITE_KEY in bucket.seconds, "the folded tail goes to a catch-all")

        val n = UsageLogic.MAX_TARGETS_PER_DAY + 150
        val expectedTotal = (n.toDouble() * (n + 1)) / 2
        assertEquals(expectedTotal, bucket.seconds.values.sum(), "no measured time is dropped")
        assertTrue("site:flood${n - 1}.example" in bucket.seconds, "the largest target survives")
    }

    @Test fun `long labels are truncated before they are stored`() {
        val st = UsageLogic.UsageState()
        UsageLogic.recordSample(st, "site:a.com", 5.0, now, "x".repeat(10_000))
        assertEquals(UsageLogic.MAX_LABEL_LENGTH, st.labels["site:a.com"]!!.length)
    }

    @Test fun `durations format the way a person reads them`() {
        assertEquals("0 mp", UsageLogic.formatDuration(0.0))
        assertEquals("30 mp", UsageLogic.formatDuration(30.0))
        assertEquals("1 p", UsageLogic.formatDuration(60.0))
        assertEquals("45 p", UsageLogic.formatDuration(45.0 * 60))
        assertEquals("1 ó", UsageLogic.formatDuration(3600.0))
        assertEquals("2 ó 15 p", UsageLogic.formatDuration(2.0 * 3600 + 15 * 60))
        assertEquals("0 mp", UsageLogic.formatDuration(-5.0))
    }

    @Test fun `a snapshot detaches from later mutation so StateFlow emits`() {
        val a = UsageLogic.UsageState()
        UsageLogic.recordSample(a, "app:x", 5.0, now, "X")
        val b = UsageLogic.snapshot(a)
        UsageLogic.recordSample(a, "app:x", 5.0, now)
        val c = UsageLogic.snapshot(a)
        assertEquals(5.0, b.days[0].seconds["app:x"], "the earlier snapshot is frozen")
        assertEquals(10.0, c.days[0].seconds["app:x"])
        assertTrue(b != c, "successive snapshots must compare unequal or the UI never updates")
    }
}
