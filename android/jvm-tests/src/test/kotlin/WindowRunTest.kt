import android.content.Context
import hu.breaker.app.core.AppState
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.Focus
import hu.breaker.app.core.FocusSync
import hu.breaker.app.core.SyncClient
import org.json.JSONArray
import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/** MENETEK ABLAKBÓL: az ablak jele a mentésben és a dróton — csak ha igaz; a régi sor nem ablak. */
class WindowRunTest {
    private val win = Focus.FocusLogEntry("p", "Nyelvtanulás", 1_000L, 2_000L, 2_000L, false, window = true)
    private val plain = Focus.FocusLogEntry("p", "Nyelvtanulás", 2_000L, 3_000L, 3_000L, false)

    @Test
    fun `a mentes - az ablak jele tuleli, a regi sor nem ablak`() {
        BreakerStore.init(Context())
        val toJson = BreakerStore::class.java.getDeclaredMethod("toJson", AppState::class.java).apply { isAccessible = true }
        val fromJson = BreakerStore::class.java.getDeclaredMethod("fromJson", JSONObject::class.java).apply { isAccessible = true }
        val text = toJson.invoke(BreakerStore, AppState(focusLog = listOf(win, plain))).toString()
        assertEquals(1, Regex("\"window\":true").findAll(text).count(), "csak az igaz sor viszi a mezőt")
        val back = fromJson.invoke(BreakerStore, JSONObject(text)) as AppState
        assertEquals(listOf(true, false), back.focusLog.map { it.window })
    }

    @Test
    fun `a drot - az ablak jele oda-vissza, a regi kliens sora nem ablak`() {
        val base = FocusSync.SyncFocus(packs = emptyList(), run = null, log = listOf(win, plain), rev = 3, updatedAt = 1, updatedBy = "dev")
        val text = SyncClient.focusToJson(base)
        assertEquals(1, Regex("\"window\":true").findAll(text).count())
        val back = SyncClient.focusFromJson(text, "dev", null)
        assertEquals(listOf(true, false), back.log.map { it.window })
        val oldRow = JSONObject().put("packId", "p").put("packName", "N").put("startedAt", 1)
            .put("endedAt", 2).put("plannedEndsAt", 2).put("stopped", false)
        val old = SyncClient.focusFromJson(
            JSONObject().put("packs", JSONArray()).put("rev", 1).put("log", JSONArray().put(oldRow)).toString(),
            "dev", null,
        )
        assertFalse(old.log.single().window)
    }
}
