import android.content.Context
import hu.lakat.app.core.AppState
import hu.lakat.app.core.Blocklist
import hu.lakat.app.core.LakatStore
import hu.lakat.app.core.ScheduleLogic
import hu.lakat.app.core.Site
import hu.lakat.app.core.UsageLogic
import hu.lakat.app.usage.UsageTracker
import java.util.Calendar
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * The usage tracker's buffering and the store's JSON persistence. Both are easy
 * to get subtly wrong (midnight boundaries, StateFlow equality, migration of
 * older state files) and neither is covered by anything else.
 */
class TrackerAndStoreTest {

    private val now = System.currentTimeMillis()

    @BeforeTest fun reset() {
        LakatStore.init(Context())
        LakatStore.mutate { AppState() }
        UsageTracker.flush(now) // drain anything a previous test buffered
        LakatStore.mutate { AppState() }
    }

    // Reach the private buffering path so the real code is what gets exercised.
    private val bufferM = UsageTracker::class.java
        .getDeclaredMethod("buffer", UsageLogic.SampleDecision::class.java, java.lang.Long.TYPE)
        .apply { isAccessible = true }

    private fun buffer(key: String, seconds: Double, at: Long) {
        bufferM.invoke(UsageTracker, UsageLogic.SampleDecision(key, key.substringAfter(':'), seconds), at)
    }

    private fun yesterdayNoon(): Long {
        val c = Calendar.getInstance().apply {
            timeInMillis = now
            set(Calendar.HOUR_OF_DAY, 12); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }
        c.add(Calendar.DAY_OF_MONTH, -1)
        return c.timeInMillis
    }

    @Test fun `measurement is buffered and written once, not on every tick`() {
        buffer("app:slack", 5.0, now)
        buffer("app:slack", 5.0, now)
        assertTrue(LakatStore.state.value.usage.days.isEmpty(),
            "writing the whole state every 5s would hammer SharedPreferences")

        UsageTracker.flush(now)
        val today = UsageLogic.dayKey(now)
        assertEquals(10.0, LakatStore.state.value.usage.days.first { it.day == today }.seconds["app:slack"])
    }

    @Test fun `an empty flush does not touch the store`() {
        UsageTracker.flush(now)
        val before = LakatStore.state.value
        UsageTracker.flush(now)
        assertSame(before, LakatStore.state.value)
    }

    @Test fun `time buffered before midnight stays on its own day`() {
        val yesterday = yesterdayNoon()
        buffer("site:youtube.com", 30.0, yesterday)
        buffer("site:youtube.com", 20.0, now)
        UsageTracker.flush(now)

        val usage = LakatStore.state.value.usage
        val yKey = UsageLogic.dayKey(yesterday)
        assertEquals(30.0, usage.days.first { it.day == yKey }.seconds["site:youtube.com"])
        assertEquals(20.0, usage.days.first { it.day == UsageLogic.dayKey(now) }.seconds["site:youtube.com"])
    }

    @Test fun `successive tracker writes emit a distinct state`() {
        buffer("app:x", 5.0, now)
        UsageTracker.flush(now)
        val first = LakatStore.state.value
        buffer("app:x", 5.0, now)
        UsageTracker.flush(now)
        val second = LakatStore.state.value

        assertTrue(first != second, "otherwise StateFlow never emits and the UI never updates")
        assertEquals(5.0, first.usage.days[0].seconds["app:x"], "the earlier state is not mutated after the fact")
        assertEquals(10.0, second.usage.days[0].seconds["app:x"])
    }

    // ------------------------------------------------------- domain attribution

    private val noteM = UsageTracker::class.java
        .getDeclaredMethod("noteDomain", String::class.java, java.lang.Long.TYPE)
        .apply { isAccessible = true }

    @Suppress("UNCHECKED_CAST")
    private val lastDomainRef = UsageTracker::class.java
        .getDeclaredField("lastDomain").apply { isAccessible = true }
        .get(UsageTracker) as AtomicReference<Any?>

    private fun noteDomain(d: String) = noteM.invoke(UsageTracker, d, now)

    private fun sightedDomain(): String? {
        val s = lastDomainRef.get() ?: return null
        val f = s.javaClass.getDeclaredField("domain").apply { isAccessible = true }
        return f.get(s) as String
    }

    /** The tracker only attributes DNS while a browser is foreground. */
    private fun pretendBrowserForeground() {
        UsageTracker::class.java.getDeclaredField("cachedFgPackage")
            .apply { isAccessible = true }.set(UsageTracker, "com.android.chrome")
    }

    @Test fun `DNS is only attributed while a browser is in the foreground`() {
        // the VPN sees DNS for the whole device; another app's lookup is not a
        // page the user was reading
        UsageTracker::class.java.getDeclaredField("cachedFgPackage")
            .apply { isAccessible = true }.set(UsageTracker, "com.some.other.app")
        lastDomainRef.set(null)
        noteDomain("api.example.com")
        assertNull(sightedDomain(), "a background app's lookup is not attributed")

        pretendBrowserForeground()
        noteDomain("api.example.com")
        assertEquals("example.com", sightedDomain())
    }

    @Test fun `random subdomains collapse to the registrable domain`() {
        pretendBrowserForeground()
        lastDomainRef.set(null)
        noteDomain("a1b2c3.tracker.example")
        assertEquals("tracker.example", sightedDomain(),
            "a page inventing subdomains must not invent stored targets")
        noteDomain("shop.foo.co.uk")
        assertEquals("foo.co.uk", sightedDomain(), "multi-part suffixes are respected")
    }

    @Test fun `asset and telemetry hosts are never mistaken for the page`() {
        pretendBrowserForeground()
        lastDomainRef.set(null)
        noteDomain("fonts.gstatic.com")
        assertNull(sightedDomain(), "a CDN host is not a page")
        noteDomain("rr3---sn-abc.googlevideo.com")
        assertNull(sightedDomain(), "a media host is not a page")
        noteDomain("www.google-analytics.com")
        assertNull(sightedDomain(), "analytics is not a page")

        noteDomain("www.wikipedia.org")
        assertEquals("wikipedia.org", sightedDomain(), "a real page is recorded, without the www")
    }

    @Test fun `a blocked site's hostnames are canonicalised to that site`() {
        pretendBrowserForeground()
        LakatStore.mutate { s ->
            s.copy(sites = listOf(Site(
                id = "s1", domain = "youtube.com",
                hostnames = Blocklist.expandHostnames("youtube.com", true),
                addedAt = now, pauseUntil = null, pendingDeleteAt = null,
            )))
        }
        lastDomainRef.set(null)
        noteDomain("m.youtube.com")
        assertEquals("youtube.com", sightedDomain(),
            "statistics and the block list must speak the same language")
    }

    // ------------------------------------------------------------ persistence

    private val toJson = LakatStore::class.java
        .getDeclaredMethod("toJson", AppState::class.java).apply { isAccessible = true }
    private val fromJson = LakatStore::class.java
        .getDeclaredMethod("fromJson", org.json.JSONObject::class.java).apply { isAccessible = true }

    private fun roundTrip(state: AppState): AppState {
        val json = toJson.invoke(LakatStore, state).toString()
        return fromJson.invoke(LakatStore, org.json.JSONObject(json)) as AppState
    }

    @Test fun `usage history survives a save and load`() {
        buffer("site:youtube.com", 120.0, now)
        buffer("app:com.slack", 60.0, now)
        UsageTracker.flush(now)

        val back = roundTrip(LakatStore.state.value)
        assertEquals(1, back.usage.days.size)
        assertEquals(120.0, back.usage.days[0].seconds["site:youtube.com"])
        assertEquals("com.slack", back.usage.labels["app:com.slack"])
        assertTrue(back.usage.enabled)
    }

    @Test fun `the measurement off switch survives a save and load`() {
        LakatStore.mutate { s ->
            val u = UsageLogic.snapshot(s.usage); u.enabled = false; s.copy(usage = u)
        }
        assertTrue(!roundTrip(LakatStore.state.value).usage.enabled)
    }

    @Test fun `schedules and sessions survive a save and load`() {
        val work = ScheduleLogic.Schedule(
            ScheduleLogic.Mode.SCHEDULED_BLOCK,
            listOf(ScheduleLogic.Band(setOf(1, 2, 3, 4, 5), 9 * 60, 17 * 60)),
        )
        LakatStore.mutate { s ->
            s.copy(sites = listOf(Site(
                id = "s1", domain = "twitch.tv",
                hostnames = Blocklist.expandHostnames("twitch.tv", false),
                addedAt = now, pauseUntil = null, pendingDeleteAt = null, schedule = work,
            )))
        }
        val back = roundTrip(LakatStore.state.value)
        assertEquals(work, back.sites[0].schedule)
    }

    @Test fun `a state file written before usage tracking existed still loads`() {
        val legacy = org.json.JSONObject(
            """{"protectionOn":false,"sites":[],"unlockLog":[],"lastCombo":null,"session":null}""")
        val migrated = fromJson.invoke(LakatStore, legacy) as AppState
        assertNotNull(migrated.usage)
        assertTrue(migrated.usage.days.isEmpty())
        assertTrue(migrated.usage.enabled, "tracking defaults to on for existing installs")
    }
}
