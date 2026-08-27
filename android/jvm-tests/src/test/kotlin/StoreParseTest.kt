import hu.breaker.app.core.AbandonRec
import hu.breaker.app.core.AppState
import hu.breaker.app.core.ChallengeEngine.Kind
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.ScheduleLogic
import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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

    private val fromJson = BreakerStore::class.java
        .getDeclaredMethod("fromJson", JSONObject::class.java)
        .apply { isAccessible = true }

    private fun parse(raw: String): AppState = fromJson.invoke(BreakerStore, JSONObject(raw)) as AppState

    private val toJson = BreakerStore::class.java
        .getDeclaredMethod("toJson", AppState::class.java)
        .apply { isAccessible = true }

    /** rejtett listával induló állapot, csak a sites tömb nyitva hagyva */
    private val HIDDEN_PREFIX = "{\"hideSiteList\":true,\"sites\":["

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
    @Test fun `az utolso meres ideje tulel egy mentest`() {
        // Ez a mező teszi a statisztikán a nullát olvashatóvá. Egy mai nullás
        // érték önmagában nem árulja el, hogy tényleg nem használtad a
        // telefont, vagy hogy a mérés hasalt el. Ha nem élné túl az
        // újraindítást, minden indítás után azt állítaná, hogy még soha nem
        // mértünk — vagyis pont a rosszabbik felét mondaná.
        val saved = toJson.invoke(BreakerStore, AppState(usageLastSampleAt = 1_700_000_000_000)) as JSONObject
        assertEquals(1_700_000_000_000, parse(saved.toString()).usageLastSampleAt)

        // A RÉGI mentésben nincs ilyen mező, és attól nem hasalhat el a
        // betöltés: a telefon különben üres állapotra esne vissza, és a
        // felhasználó azt látná, hogy a blokklistája eltűnt.
        val state = parse("""{"sites":[${site("youtube")}]}""")
        assertEquals(1, state.sites.size)
        assertNull(state.usageLastSampleAt)
    }

    @Test fun `the abandon record survives a save and load`() {
        // It is what stops a cancelled attempt from being a free re-roll, so it
        // has to outlive an app restart — otherwise closing the app would be the
        // re-roll instead.
        val state = AppState(abandons = listOf(
            AbandonRec("site_1", Kind.PAUSE, "MEMORY+REVERSE", 1_700_000_000_000)))
        val round = parse(toJson.invoke(BreakerStore, state).toString())
        assertEquals(state.abandons, round.abandons)
    }

    @Test fun `a corrupt abandon record costs only the re-roll guard`() {
        val state = parse("""{"sites":[${site("youtube")}],"abandons":[{"siteId":"x","kind":"QUANTUM"}]}""")
        assertTrue(state.abandons.isEmpty())
        assertEquals(1, state.sites.size, "and not the blocklist")
    }

    @Test fun `state written before this feature still loads`() {
        val state = parse("""{"sites":[${site("youtube")}]}""")
        assertTrue(state.abandons.isEmpty())
        assertEquals(1, state.sites.size)
    }

    @Test fun `the alias and the hidden list survive a save and load`() {
        val withAlias = site("youtube", ",\"alias\":\"A videós\"")
        val saved = toJson.invoke(BreakerStore, parse(HIDDEN_PREFIX + withAlias + "]}")).toString()
        val back = parse(saved)
        assertTrue(back.hideSiteList, "a rejtés beállítás, tehát újraindítás után is áll")
        assertEquals("A videós", back.sites[0].alias)
    }

    @Test fun `a hostile alias in the state file is cleaned on load`() {
        // A mentett állapotot egy korábbi verzió vagy egy kézi szerkesztés is
        // írhatta. Vezérlőkarakter a soron láthatatlan maradna, a hosszkorlátba
        // viszont beleszámítana — ezért betöltéskor is normalizálunk. A \u
        // szekvenciák itt a JSON-nak szólnak, nem a Kotlinnak.
        val junk = "A\\u0000vide\\u001Fós" + "x".repeat(200)
        val state = parse("{\"sites\":[" + site("youtube", ",\"alias\":\"" + junk + "\"") + "]}")
        val alias = state.sites[0].alias!!
        assertTrue(alias.length <= 40, "a hosszkorlát a betöltésre is áll")
        assertTrue(
            alias.none { ch -> ch.code < 0x20 || ch.code in 0x7f..0x9f },
            "vezérlőkarakter maradt a betöltött fedőnévben",
        )
    }

    @Test fun `state written before the hidden list still loads with it off`() {
        val state = parse("{\"sites\":[" + site("youtube") + "]}")
        assertFalse(state.hideSiteList)
        assertNull(state.sites[0].alias)
    }
}
