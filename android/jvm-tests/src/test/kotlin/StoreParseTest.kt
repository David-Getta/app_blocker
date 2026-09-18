import hu.breaker.app.core.AbandonRec
import hu.breaker.app.core.AppState
import hu.breaker.app.core.ChallengeEngine.Kind
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.LockdownLogic
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

    // ---- zárlat-ablakok ----------------------------------------------------

    private fun window(id: String, days: Set<Int>, start: Int, end: Int) =
        LockdownLogic.LockdownWindow(id, days, start, end)

    @Test fun `a zarlat-ablakok es a jeluk tulelik a mentest`() {
        // Az ablakból a kör zárlatot ír; ha a lista nem élné túl az
        // újraindítást, az app kilövése lenne az ablak levétele — ingyen.
        val state = AppState(
            lockdownWindows = listOf(
                window("lw_work", setOf(1, 2, 3, 4, 5), 9 * 60, 17 * 60),
                window("lw_night", setOf(0, 6), 22 * 60, 6 * 60),
            ),
            lockdownWindowsRev = 5,
            focusRevWindows = "1,2,3,4,5/540/1020;0,6/1320/360",
        )
        val round = parse(toJson.invoke(BreakerStore, state).toString())
        assertEquals(state.lockdownWindows, round.lockdownWindows)
        assertEquals(5, round.lockdownWindowsRev, "a jel nélkül a másik eszköz jeles levétele nem menne át")
        assertEquals(state.focusRevWindows, round.focusRevWindows)
    }

    @Test fun `az utolso ablak levetele ujrainditas utan is levetel marad`() {
        // A függő lista ÜRES listaként utazik, nem null-ként: a null azt
        // jelentené, hogy a kísérlet közönséges feloldás, és a próbatétel
        // végén a bíró szünetet adna az ablak levétele helyett.
        val session = """{"id":"ses_1","kind":"PAUSE","siteId":"lockdown:windows","minutes":null,
            "steps":[{"id":"st1","type":"TRANSCRIBE","text":"abc"}],"stepIndex":0,"createdAt":1,
            "pendingSchedule":null,"pendingLockdownWindows":[]}"""
        val first = parse("""{"sites":[${site("youtube")}],"session":$session}""")
        assertNotNull(first.session)
        assertEquals(emptyList(), first.session!!.pendingLockdownWindows, "üres lista, nem null")

        val second = parse(toJson.invoke(BreakerStore, first).toString())
        assertEquals(emptyList(), second.session!!.pendingLockdownWindows, "a mentés sem teszi null-lá")

        // Egy másik kísérlet, aminek nincs köze az ablakokhoz, null-t hordoz.
        val plain = parse("""{"sites":[${site("youtube")}],"session":${session.replace(
            ""","pendingLockdownWindows":[]""", "")}}""")
        assertNull(plain.session!!.pendingLockdownWindows)
        assertNull(parse(toJson.invoke(BreakerStore, plain).toString()).session!!.pendingLockdownWindows)
    }

    @Test fun `a fuggo szukites is tulel egy mentest`() {
        val session = """{"id":"ses_1","kind":"PAUSE","siteId":"lockdown:windows","minutes":null,
            "steps":[{"id":"st1","type":"TRANSCRIBE","text":"abc"}],"stepIndex":0,"createdAt":1,
            "pendingLockdownWindows":[{"id":"lw_work","days":[1,2,3],"startMin":540,"endMin":1020}]}"""
        val first = parse("""{"sites":[${site("youtube")}],"session":$session}""")
        val round = parse(toJson.invoke(BreakerStore, first).toString())
        assertEquals(listOf(window("lw_work", setOf(1, 2, 3), 540, 1020)), round.session!!.pendingLockdownWindows)
    }

    @Test fun `szemet ablak a mentett fajlban kiesik, a tobbi marad`() {
        // A fájlt egy újabb verzió vagy egy kézi szerkesztés is írhatta. Egy
        // rossz ablak nem viheti el a jókat — és főleg nem a blokklistát.
        val windows = listOf(
            """{"id":"ok","days":[1,2,3],"startMin":540,"endMin":1020}""",
            """{"id":"bad_day","days":[9],"startMin":540,"endMin":1020}""",
            """{"id":"bad_band","days":[1],"startMin":540,"endMin":0}""",
            """{"id":"bad_start","days":[1],"startMin":1440,"endMin":60}""",
            """{"days":[1],"startMin":600,"endMin":700}""",
            """{"id":"dupe","days":[3,2,1],"startMin":540,"endMin":1020}""",
            """{"id":"ok","days":[4],"startMin":100,"endMin":200}""",
            """{"id":"${"x".repeat(41)}","days":[5],"startMin":100,"endMin":200}""",
            "\"nem is objektum\"",
            """{"id":"ok2","days":[6],"startMin":1380,"endMin":120}""",
        ).joinToString(",")
        val state = parse(
            """{"sites":[${site("youtube")}],"lockdownWindows":[$windows],
               "lockdownWindowsRev":-3,"focusRevWindows":null}""",
        )
        assertEquals(1, state.sites.size, "a blokklista nem járulékos kár")
        assertEquals(listOf("ok", "ok2"), state.lockdownWindows.map { it.id })
        assertEquals(setOf(1, 2, 3), state.lockdownWindows[0].days)
        assertNull(state.lockdownWindowsRev, "a nem pozitív jel nincs jel")
        assertNull(state.focusRevWindows)

        // Nem szám a jel helyén: ugyanúgy nincs jel, és nem hasal el a betöltés.
        val junkRev = parse("""{"sites":[${site("youtube")}],"lockdownWindowsRev":"abc"}""")
        assertEquals(1, junkRev.sites.size)
        assertNull(junkRev.lockdownWindowsRev)
    }

    @Test fun `az ablakok elott irt allapotfajl ablakok nelkul tolt be`() {
        val state = parse("""{"sites":[${site("youtube")}]}""")
        assertTrue(state.lockdownWindows.isEmpty())
        assertNull(state.lockdownWindowsRev)
        assertNull(state.focusRevWindows)
        assertEquals(1, state.sites.size)
    }
}
