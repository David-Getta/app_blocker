import hu.lakat.app.core.AppState
import hu.lakat.app.core.LakatStore
import hu.lakat.app.core.ScheduleLogic
import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * How the store survives a state file it does not fully understand.
 *
 * This matters more here than in a normal app: the loader's only fallback is an
 * EMPTY state, and an empty state means every block silently disappears. A
 * state file written by a newer version (then a downgrade), a half-written file
 * after a battery death, one unknown enum name — none of them may be allowed to
 * turn into "nothing is blocked any more".
 */
class StoreParseTest {

    private val fromJson = LakatStore::class.java
        .getDeclaredMethod("fromJson", JSONObject::class.java)
        .apply { isAccessible = true }

    private fun parse(raw: String): AppState = fromJson.invoke(LakatStore, JSONObject(raw)) as AppState

    private fun site(id: String, extra: String = "") =
        """{"id":"$id","domain":"$id.com","hostnames":["$id.com"],"addedAt":1,
            "pauseUntil":null,"pendingDeleteAt":null$extra}"""

    @Test fun `an unknown schedule mode falls back to always blocked`() {
        // A mode this build has never heard of used to throw out of valueOf,
        // and the caller's runCatching turned that into a blank state.
        val unknownMode = ""","schedule":{"mode":"SCHEDULED_HOLIDAY","bands":[]}"""
        val state = parse("""{"sites":[${site("youtube", unknownMode)}]}""")
        assertEquals(1, state.sites.size, "the site must not disappear")
        assertEquals(ScheduleLogic.Mode.ALWAYS, state.sites[0].schedule?.mode)
        assertTrue(
            ScheduleLogic.isBlockedNow(null, null, state.sites[0].schedule, System.currentTimeMillis()),
            "an unreadable schedule blocks, it does not free",
        )
    }

    @Test fun `one broken site does not take the rest of the blocklist with it`() {
        val broken = """{"id":"x","domain":"x.com","addedAt":1}""" // no hostnames array
        val state = parse("""{"sites":[$broken,${site("reddit")}]}""")
        assertEquals(listOf("reddit.com"), state.sites.map { it.domain })
    }

    @Test fun `a corrupt session is dropped but the sites stay`() {
        val session = """{"id":"ses_1","kind":"PAUSE","siteId":"youtube","minutes":15,
            "steps":[{"id":"st1","type":"QUANTUM_RIDDLE"}],"stepIndex":0,"createdAt":1,
            "pendingSchedule":null}"""
        val state = parse("""{"sites":[${site("youtube")}],"session":$session}""")
        assertNull(state.session, "an unreadable unlock attempt is dropped")
        assertEquals(1, state.sites.size, "…but the blocklist is not collateral damage")
    }

    @Test fun `a session pointing past its own steps is not loaded`() {
        // Every referee operation reads steps[stepIndex]; an out-of-range index
        // would throw on the DNS hot path instead of merely failing the unlock.
        val session = """{"id":"ses_1","kind":"PAUSE","siteId":"youtube","minutes":15,
            "steps":[{"id":"st1","type":"TRANSCRIBE","text":"abc"}],"stepIndex":7,"createdAt":1,
            "pendingSchedule":null}"""
        val state = parse("""{"sites":[${site("youtube")}],"session":$session}""")
        assertNull(state.session)
    }

    @Test fun `a valid session is still loaded`() {
        val session = """{"id":"ses_1","kind":"PAUSE","siteId":"youtube","minutes":15,
            "steps":[{"id":"st1","type":"TRANSCRIBE","text":"abc"}],"stepIndex":0,"createdAt":1,
            "pendingSchedule":null}"""
        val state = parse("""{"sites":[${site("youtube")}],"session":$session}""")
        assertNotNull(state.session)
        assertEquals(1, state.session!!.steps.size)
    }

    @Test fun `a malformed usage day does not cost the blocklist`() {
        val usage = """{"enabled":true,"days":[{"day":"2026-05-20"},
            {"day":"2026-05-21","seconds":{"app:slack":42}}],"labels":{}}"""
        val state = parse("""{"sites":[${site("youtube")}],"usage":$usage}""")
        assertEquals(1, state.sites.size)
        assertEquals(1, state.usage.days.size, "only the unreadable day is lost")
        assertEquals(42.0, state.usage.days[0].seconds["app:slack"])
    }
}
