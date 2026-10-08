import hu.breaker.app.core.AppState
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.Focus
import hu.breaker.app.core.FocusSync
import hu.breaker.app.core.SyncClient
import hu.breaker.app.core.SyncRevisions
import org.json.JSONArray
import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

// A LISTA REJTÉSE a fiók egészére szól — a desktop/test/hide-sync.test.ts és az
// iOS HideSyncTests párja: a fésülés (a jel dönt, azonos jelnél a rejtett, a
// régi kliens semleges), a drót (a jel legfeljebb a blob rev-je, a rejtés csak
// igazként utazik), a jel (a be- és kikapcsolás lépteti a blobot, az átvett jel
// marad) és a mentés. A három nyelv fésülését a fixtúra (merge-cases.json) is
// összeveti.
class HideSyncTest {
    private val now = 1_700_000_000_000L

    private fun doc(dev: String, rev: Long, hide: Boolean, mark: Int? = null) = FocusSync.SyncFocus(
        rev = rev, updatedAt = 100, updatedBy = dev, hideSiteList = hide, hideSiteListRev = mark,
    )

    @Test fun `a fesules - a jel dont, azonos jelnel a rejtett, a regi kliens semleges`() {
        // A nagyobb jelű, kifizetett kikapcsolás átmegy — a rejtés nem támad fel egy régi blobból.
        assertFalse(FocusSync.merge(doc("a", 5, false, 5), doc("b", 3, true, 3)).hideSiteList)
        assertFalse(FocusSync.merge(doc("a", 3, true, 3), doc("b", 5, false, 5)).hideSiteList)
        // A nagyobb jelű rejtés átmegy.
        assertTrue(FocusSync.merge(doc("a", 5, true, 5), doc("b", 3, false, 3)).hideSiteList)
        // Azonos jelnél a rejtett — a szigorúbb irány.
        assertTrue(FocusSync.merge(doc("a", 4, true, 4), doc("b", 4, false, 4)).hideSiteList)
        assertTrue(FocusSync.merge(doc("a", 4, false, 4), doc("b", 4, true, 4)).hideSiteList)
        // A régi kliens (jel nélkül) nem tud kikapcsolni: a jeles rejtés marad.
        assertTrue(FocusSync.merge(doc("a", 9, false), doc("b", 2, true, 2)).hideSiteList)
        // A jel a nagyobb; rejtés nélkül nincs jel.
        assertEquals(5, FocusSync.merge(doc("a", 5, true, 5), doc("b", 3, false, 3)).hideSiteListRev)
        assertNull(FocusSync.merge(doc("a", 1, false), doc("b", 1, false)).hideSiteListRev)
        // Sorrendfüggetlen.
        val x = doc("a", 6, true, 6)
        val y = doc("b", 6, false, 2)
        assertEquals(FocusSync.merge(x, y).hideSiteList, FocusSync.merge(y, x).hideSiteList)
        // A tiszta szabály is.
        assertTrue(FocusSync.mergeHide(0, true, 0, false), "jel nélkül a rejtett nyer")
        assertFalse(FocusSync.mergeHide(2, false, 1, true), "a nagyobb jelű kikapcsolás nyer")
        // A rejtés cseréje különbség: azonos rev mellett is fel kell mennie.
        assertFalse(FocusSync.same(doc("a", 3, true, 3), doc("a", 3, false)), "a rejtés cseréje különbség")
        assertTrue(FocusSync.same(doc("a", 3, true, 3), doc("a", 3, true, 3)))
    }

    @Test fun `a drot - a rejtes es a jele oda-vissza, a jel legfeljebb a blob rev-je`() {
        val f = SyncClient.focusFromJson(
            JSONObject().put("packs", JSONArray()).put("rev", 3).put("hideSiteList", true).put("hideSiteListRev", 3).toString(),
            "dev", null,
        )
        assertTrue(f.hideSiteList)
        assertEquals(3, f.hideSiteListRev)
        val over = SyncClient.focusFromJson(
            JSONObject().put("packs", JSONArray()).put("rev", 3).put("hideSiteList", true).put("hideSiteListRev", 9).toString(),
            "dev", null,
        )
        assertTrue(over.hideSiteList)
        assertNull(over.hideSiteListRev, "a jel legfeljebb a blob rev-je")
        val off = SyncClient.focusFromJson(
            JSONObject().put("packs", JSONArray()).put("rev", 3).put("hideSiteList", false).toString(), "dev", null,
        )
        assertFalse(off.hideSiteList)
        val text = SyncClient.focusToJson(doc("dev", 3, true, 3))
        assertTrue(text.contains("\"hideSiteList\":true"))
        assertTrue(text.contains("\"hideSiteListRev\":3"))
        assertFalse(SyncClient.focusToJson(doc("dev", 1, false)).contains("hideSiteList"), "rejtés nélkül nincs mező")
    }

    @Test fun `a jel - a be- es kikapcsolas lepteti a blobot, az atvett jel marad`() {
        var st = AppState()
        assertEquals(st.copy(focusRevFp = SyncRevisions.focusFingerprint(st), focusRevKeywordList = emptyList()),
            SyncRevisions.bumpFocus(st, "telefon", now), "üres: nincs léptetés")
        st = SyncRevisions.bumpFocus(st.copy(hideSiteList = true), "telefon", now + 1)
        assertEquals(1L, st.focusRev, "a bekapcsolás döntés")
        assertEquals(1, st.hideSiteListRev)
        assertEquals(st, SyncRevisions.bumpFocus(st, "telefon", now + 2), "változatlanul nem léptet")
        st = SyncRevisions.bumpFocus(st.copy(hideSiteList = false), "telefon", now + 3)
        assertEquals(2L, st.focusRev, "a kikapcsolás is döntés")
        assertEquals(2, st.hideSiteListRev)
        // Másik eszközről átvett rejtés: nincs léptetés, és egy későbbi saját, más
        // szerkesztés sem bélyegzi át a jelét (azzal a másik eszköz döntését írná felül).
        val adopted = SyncRevisions.adoptFocus(st.copy(hideSiteList = true, hideSiteListRev = 7))
        assertEquals(adopted, SyncRevisions.bumpFocus(adopted, "telefon", now + 4), "az átvétel nem szerkesztés")
        val edited = SyncRevisions.bumpFocus(
            adopted.copy(focusPacks = listOf(Focus.FocusPack("p1", "Írás", emptyList(), emptyList(), 25))), "telefon", now + 5,
        )
        assertEquals(3L, edited.focusRev)
        assertEquals(7, edited.hideSiteListRev, "az átvett rejtés jele marad")
    }

    @Test fun `a mentes - a rejtes, a jel es a kulcs tuleli`() {
        val toJson = BreakerStore::class.java.getDeclaredMethod("toJson", AppState::class.java).apply { isAccessible = true }
        val fromJson = BreakerStore::class.java.getDeclaredMethod("fromJson", JSONObject::class.java).apply { isAccessible = true }
        val st = AppState(hideSiteList = true, hideSiteListRev = 4, focusRevHide = "1")
        val back = fromJson.invoke(BreakerStore, JSONObject(toJson.invoke(BreakerStore, st).toString())) as AppState
        assertTrue(back.hideSiteList)
        assertEquals(4, back.hideSiteListRev)
        assertEquals("1", back.focusRevHide)
        // A jel előtt írt fájl: rejtés jel nélkül — a következő léptetés adja meg.
        val old = fromJson.invoke(BreakerStore, JSONObject("{\"sites\":[],\"hideSiteList\":true}")) as AppState
        assertTrue(old.hideSiteList)
        assertNull(old.hideSiteListRev)
        assertNull(old.focusRevHide)
    }
}
