import hu.breaker.app.core.AppState
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.Focus
import hu.breaker.app.core.FocusSync
import hu.breaker.app.core.ScheduleLogic
import hu.breaker.app.core.SyncRevisions
import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Az ablakos csomag OSZTÁLYA a telefonon — a gép focus-pack-loosens.test.ts-ének
 * párja: a kifizetett ablak-lazítás száma, aztán az ablak dönt, egészében; az
 * osztályon belül a SAJÁT jel.
 */
class PackClassTest {

    private val win = ScheduleLogic.Band(setOf(1, 2, 3, 4, 5), 540, 720)
    private fun pack(id: String, name: String = "csomag $id", rec: ScheduleLogic.Band? = null) =
        Focus.FocusPack(id, name, listOf("quizlet.com"), emptyList(), 50, rec)
    private fun focus(
        packs: List<Focus.FocusPack>, marks: Map<String, Int>? = null, loosens: Map<String, Int>? = null,
        rev: Long, by: String = "gep", run: Focus.FocusRun? = null,
    ) = FocusSync.SyncFocus(
        packs = packs, run = run, rev = rev, updatedAt = 1, updatedBy = by, packMarks = marks, packLoosens = loosens,
    )

    @Test
    fun `a kifizetett levetel nyer - egy elavult eszkoz atnevezese nem hozza vissza az ablakot`() {
        val paid = focus(listOf(pack("p1")), mapOf("p1" to 4), mapOf("p1" to 1), rev = 4)
        val stale = focus(listOf(pack("p1", "átnevezve", win)), mapOf("p1" to 7), rev = 7, by = "telefon")
        for (m in listOf(FocusSync.merge(paid, stale), FocusSync.merge(stale, paid))) {
            assertNull(m.packs.single().recurrence, "az ablak levétele marad")
            assertEquals("csomag p1", m.packs.single().name, "a győztes változat egészében")
            assertEquals(mapOf("p1" to 7), m.packMarks)
            assertEquals(mapOf("p1" to 1), m.packLoosens)
            assertEquals(mapOf("p1" to 4), m.packOwnMarks, "a győztes saját jele, mert kisebb a közösnél")
        }
    }

    @Test
    fun `a sajat jel - az osztaly-dontes vesztesenek nagy jele nem dont a gyoztes osztalyon belul`() {
        val a = focus(emptyList(), mapOf("p3" to 5), rev = 5)
        val b = focus(listOf(pack("p3")), mapOf("p3" to 1), mapOf("p3" to 1), rev = 2, by = "b")
        val c = focus(emptyList(), null, mapOf("p3" to 1), rev = 1, by = "c")
        val m = { x: FocusSync.SyncFocus, y: FocusSync.SyncFocus -> FocusSync.merge(x, y) }
        for (r in listOf(m(m(a, b), c), m(m(c, a), b), m(m(b, c), a), m(m(a, c), b), m(m(b, a), c), m(m(c, b), a))) {
            assertEquals(listOf("p3"), r.packs.map { it.id }, "a „b” saját jele (1) a „c”-é (0) fölött")
            assertEquals(mapOf("p3" to 5), r.packMarks)
            assertEquals(mapOf("p3" to 1), r.packOwnMarks)
        }
    }

    @Test
    fun `a futo menet csomagja marad - de a kifizetetten levett ablaka nem jon vissza`() {
        val running = focus(
            listOf(pack("p1", rec = win)), mapOf("p1" to 2), rev = 3,
            run = Focus.FocusRun("p1", 100, 100 + 3 * 3_600_000L),
        )
        val removed = focus(emptyList(), mapOf("p1" to 6), mapOf("p1" to 1), rev = 6, by = "telefon")
        for (m in listOf(FocusSync.merge(running, removed), FocusSync.merge(removed, running))) {
            assertEquals("p1", m.run?.packId, "a menet marad")
            assertEquals(listOf("p1"), m.packs.map { it.id }, "a csomagja is")
            assertNull(m.packs.single().recurrence, "az ablaka nem")
        }
    }

    @Test
    fun `a sajat csomag-szerkesztes torli a sajat jelet, a mentes megorzi`() {
        var st = SyncRevisions.bumpFocus(AppState(focusPacks = listOf(pack("p1"), pack("p2"))), "telefon", 10)
        st = st.copy(focusPackMarks = mapOf("p1" to 1, "p2" to 1), focusPackOwnMarks = mapOf("p1" to 0, "p2" to 0))
        st = SyncRevisions.bumpFocus(st.copy(focusPacks = listOf(pack("p1", "új"), pack("p2"))), "telefon", 20)
        assertEquals(st.focusRev.toInt(), st.focusPackMarks?.get("p1"))
        assertEquals(mapOf("p2" to 0), st.focusPackOwnMarks, "csak a szerkesztetté törlődik")
        val toJson = BreakerStore::class.java.getDeclaredMethod("toJson", AppState::class.java).apply { isAccessible = true }
        val fromJson = BreakerStore::class.java.getDeclaredMethod("fromJson", JSONObject::class.java).apply { isAccessible = true }
        val withLoosens = st.copy(focusPackLoosens = mapOf("p2" to 1))
        val back = fromJson.invoke(BreakerStore, JSONObject(toJson.invoke(BreakerStore, withLoosens).toString())) as AppState
        assertEquals(mapOf("p2" to 1), back.focusPackLoosens)
        assertEquals(mapOf("p2" to 0), back.focusPackOwnMarks)
    }
}
