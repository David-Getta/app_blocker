import android.content.Context
import hu.breaker.app.core.AppState
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.ChallengeEngine.Step
import hu.breaker.app.core.Referee
import hu.breaker.app.core.Focus
import hu.breaker.app.core.FocusSync
import hu.breaker.app.core.KeywordLogic
import hu.breaker.app.core.SyncClient
import hu.breaker.app.core.SyncRevisions
import org.json.JSONArray
import org.json.JSONObject
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Kulcsszó-szabályok a Kotlin tükrön — a desktop/test/keywords.test.ts esetei:
 * a mag (alak, lista, fésülés, illesztés), a jel, a drót és a mentés — és a
 * bíró: a telefon nem érvényesít (a DNS a címet nem látja), de szerkeszt és
 * hordoz: felvenni ingyen, levenni próbatétel.
 */
class KeywordsTest {

    private val now = 1_700_000_000_000L

    @BeforeTest fun reset() {
        BreakerStore.init(Context())
        BreakerStore.mutate { AppState() }
    }

    @Test fun `a kulcsszo kanonikus alakja - kisbetu, NFKC, szelek le`() {
        assertEquals("shorts", KeywordLogic.normalizeKeyword("  Shorts "))
        assertEquals("reels", KeywordLogic.normalizeKeyword("REELS"))
        assertNull(KeywordLogic.normalizeKeyword("ab"), "két betű mindenre illene")
        assertNull(KeywordLogic.normalizeKeyword("két szó"))
        assertNull(KeywordLogic.normalizeKeyword("x".repeat(KeywordLogic.MAX_KEYWORD_LENGTH + 1)))
        assertEquals("x".repeat(KeywordLogic.MAX_KEYWORD_LENGTH), KeywordLogic.normalizeKeyword("x".repeat(KeywordLogic.MAX_KEYWORD_LENGTH)))
        assertNull(KeywordLogic.normalizeKeyword(null))
        assertNull(KeywordLogic.normalizeKeyword(""))
        assertEquals("álom", KeywordLogic.normalizeKeyword("a" + Char(0x0301) + "lom"))
    }

    @Test fun `a lista tisztan es a kulcs rendezett`() {
        assertEquals(listOf("shorts", "reels"), KeywordLogic.cleanKeywords(listOf("Shorts", "shorts", "ab", "reels", null, " REELS ")))
        val many = (0 until KeywordLogic.MAX_KEYWORDS + 5).map { "szo${it.toString().padStart(3, '0')}" }
        assertEquals(KeywordLogic.MAX_KEYWORDS, KeywordLogic.cleanKeywords(many).size)
        assertEquals(KeywordLogic.keywordsKey(listOf("reels", "shorts")), KeywordLogic.keywordsKey(listOf("shorts", "reels")))
        assertTrue(KeywordLogic.sameKeywords(listOf("Shorts", "reels"), listOf("reels", "shorts")))
        assertFalse(KeywordLogic.isKeywordsLoosening(listOf("shorts"), listOf("shorts", "reels")), "bővítés: szigorítás")
        assertTrue(KeywordLogic.isKeywordsLoosening(listOf("shorts", "reels"), listOf("shorts")), "levétel: lazítás")
    }

    @Test fun `fesules a jel szerint es illesztes a cimre`() {
        assertEquals(listOf("reels"), KeywordLogic.mergeKeywords(3, listOf("shorts"), 5, listOf("reels")))
        assertEquals(listOf("shorts", "reels"), KeywordLogic.mergeKeywords(3, listOf("shorts"), 3, listOf("reels")), "azonos jel: unió")
        assertEquals(listOf("shorts"), KeywordLogic.mergeKeywords(0, listOf(), 0, listOf("shorts")), "a jeltelen nem töröl")
        val words = listOf("shorts", "tiktok", "játék")
        assertEquals("shorts", KeywordLogic.keywordHit(words, "https://www.youtube.com/shorts/abc"))
        assertEquals("shorts", KeywordLogic.keywordHit(words, "https://www.youtube.com/watch?v=x&list=SHORTS"))
        assertEquals("tiktok", KeywordLogic.keywordHit(words, "https://www.tiktok.com/@valaki"), "a hosztnév is a cím része")
        assertEquals("játék", KeywordLogic.keywordHit(words, "https://example.com/j%C3%A1t%C3%A9k"), "a százalék-kódolás feloldva")
        assertNull(KeywordLogic.keywordHit(words, "https://example.com/hirek"))
        assertNull(KeywordLogic.keywordHit(words, "https://example.com/%E0%A4%A"), "rossz kódolás: nem hasal el")
        assertNull(KeywordLogic.keywordHit(listOf("ab"), "https://ab.com"))
    }

    @Test fun `a jel - a lista cserele lepteti a blobot, az atvetel nem`() {
        var st = AppState()
        assertEquals(st.copy(focusRevFp = SyncRevisions.focusFingerprint(st)), SyncRevisions.bumpFocus(st, "telefon", now), "üres: nincs léptetés")
        st = SyncRevisions.bumpFocus(st.copy(keywords = listOf("shorts")), "telefon", now)
        assertEquals(1L, st.focusRev)
        assertEquals(1, st.keywordsRev)
        assertEquals(st, SyncRevisions.bumpFocus(st, "telefon", now + 1), "változatlanul nem léptet")
        st = SyncRevisions.bumpFocus(st.copy(focusPacks = listOf(Focus.FocusPack("p1", "Írás", emptyList(), emptyList(), 25))), "telefon", now + 2)
        assertEquals(2L, st.focusRev)
        assertEquals(1, st.keywordsRev, "a csomag szerkesztése nem a kulcsszavak jele")
        val adopted = SyncRevisions.adoptFocus(st.copy(keywords = listOf("reels"), keywordsRev = 9))
        assertEquals(adopted, SyncRevisions.bumpFocus(adopted, "telefon", now + 3), "az átvétel nem szerkesztés")
        val edited = SyncRevisions.bumpFocus(adopted.copy(focusPacks = emptyList()), "telefon", now + 4)
        assertEquals(9, edited.keywordsRev, "az átvett lista jele marad")
    }

    @Test fun `a drot - a lista es a jele oda-vissza, a szemet kiesik, a fesules a blobon`() {
        val base = FocusSync.SyncFocus(packs = emptyList(), run = null, log = emptyList(), rev = 0, updatedAt = 0, updatedBy = "dev")
        val f = SyncClient.focusFromJson(
            JSONObject().put("packs", JSONArray()).put("rev", 4).put("keywordsRev", 99)
                .put("keywords", JSONArray(listOf("Shorts", "ab", "shorts", "reels"))).toString(),
            "dev", null,
        )
        assertEquals(listOf("shorts", "reels"), f.keywords)
        assertNull(f.keywordsRev, "a jel legfeljebb a blob rev-je")
        val text = SyncClient.focusToJson(base.copy(keywords = listOf("shorts"), keywordsRev = 3, rev = 3))
        assertTrue(text.contains("\"keywords\""))
        assertTrue(text.contains("\"keywordsRev\":3"))
        assertFalse(SyncClient.focusToJson(base).contains("keywords"), "üresen nincs mező")

        val local = base.copy(keywords = listOf("shorts"), keywordsRev = 3, rev = 3)
        val removed = base.copy(keywordsRev = 5, rev = 5, updatedBy = "other")
        assertEquals(emptyList(), FocusSync.merge(local, removed).keywords, "a nagyobb jelű levétel átmegy")
        assertEquals(5, FocusSync.merge(local, removed).keywordsRev)
        assertEquals(listOf("shorts", "reels"), FocusSync.merge(local, base.copy(keywords = listOf("reels"), keywordsRev = 3, rev = 3)).keywords)
        assertEquals(listOf("shorts"), FocusSync.merge(local, base.copy(rev = 9, updatedAt = 999, updatedBy = "old")).keywords, "a jeltelen nem viszi el")
        assertFalse(FocusSync.same(local, local.copy(keywords = listOf("shorts", "reels"))), "a lista cseréje különbség")
    }

    @Test fun `a mentes - a lista, a jel es a kulcs tuleli`() {
        val toJson = BreakerStore::class.java.getDeclaredMethod("toJson", AppState::class.java).apply { isAccessible = true }
        val fromJson = BreakerStore::class.java.getDeclaredMethod("fromJson", JSONObject::class.java).apply { isAccessible = true }
        val st = AppState(keywords = listOf("shorts", "reels"), keywordsRev = 4, focusRevKeywords = "reels|shorts")
        val back = fromJson.invoke(BreakerStore, JSONObject(toJson.invoke(BreakerStore, st).toString())) as AppState
        assertEquals(listOf("shorts", "reels"), back.keywords)
        assertEquals(4, back.keywordsRev)
        assertEquals("reels|shorts", back.focusRevKeywords)
        // A kulcsszavak előtt írt fájl: üres lista, jel nélkül.
        val old = fromJson.invoke(BreakerStore, JSONObject("{\"sites\":[]}")) as AppState
        assertEquals(emptyList(), old.keywords)
        assertNull(old.keywordsRev)
    }

    @Test fun `a javaslatok maguk is ervenyes kulcsszavak`() {
        for (sug in KeywordLogic.SUGGESTIONS) assertEquals(sug, KeywordLogic.normalizeKeyword(sug), sug)
        assertEquals(KeywordLogic.SUGGESTIONS.size, KeywordLogic.SUGGESTIONS.toSet().size)
        assertEquals(KeywordLogic.SUGGESTIONS, KeywordLogic.cleanKeywords(KeywordLogic.SUGGESTIONS))
    }

    // ---------------------------------------------------------------- a bíró

    @Test fun `a biro - felvenni es boviteni ingyen, levenni probatetel - a levetel a teljesiteskor lep eletbe`() {
        assertTrue(Referee.setKeywords(listOf("Shorts"), now).applied, "felvétel ingyen")
        assertEquals(listOf("shorts"), BreakerStore.state.value.keywords)
        assertTrue(Referee.setKeywords(listOf("shorts", "reels"), now).applied, "bővítés ingyen")
        assertTrue(Referee.setKeywords(listOf("reels", "shorts"), now).applied, "ugyanaz más sorrendben: nincs mit tenni")
        assertNull(BreakerStore.state.value.session, "egyik sem indított próbatételt")

        val r = Referee.setKeywords(listOf("shorts"), now)
        assertFalse(r.applied, "levétel: próbatétel")
        assertEquals("keywords", r.session?.siteId)
        assertEquals(listOf("shorts"), r.session?.pendingKeywords)
        assertEquals(listOf("shorts", "reels"), BreakerStore.state.value.keywords, "amíg a próbatétel tart, a lista marad")
        assertEquals("BUSY", assertFailsWith<Referee.RefereeException> { Referee.setKeywords(emptyList(), now) }.code)
        // Futó levétel közben a felvétel ingyen — és a függő lista is tud róla,
        // különben a teljesítéskor a régi lista ülne vissza, és a live eltűnne.
        assertTrue(Referee.setKeywords(listOf("shorts", "reels", "live"), now).applied, "közben a live ingyen")
        assertEquals(listOf("shorts", "live"), BreakerStore.state.value.session?.pendingKeywords)
        solveWholeSession(now)
        assertNull(BreakerStore.state.value.session, "a kísérlet végigment")
        assertEquals(listOf("shorts", "live"), BreakerStore.state.value.keywords, "a reels lement, a live megmaradt")
        assertEquals(1, BreakerStore.state.value.unlockLog.size, "a lazítás a naplóban")
        // A mentés a függő listát is hordozza: egy újraindítás nem tenné feloldássá.
        val again = Referee.setKeywords(listOf("live"), now + 1000)
        assertFalse(again.applied)
        val toJson = BreakerStore::class.java.getDeclaredMethod("toJson", AppState::class.java).apply { isAccessible = true }
        val fromJson = BreakerStore::class.java.getDeclaredMethod("fromJson", JSONObject::class.java).apply { isAccessible = true }
        val back = fromJson.invoke(BreakerStore, JSONObject(toJson.invoke(BreakerStore, BreakerStore.state.value).toString())) as AppState
        assertEquals(listOf("live"), back.session?.pendingKeywords)
    }

    @Test fun `a biro - rossz kulcsszo es tul sok kulcsszo hiba, nem csendes csonkolas`() {
        for (bad in listOf(listOf("ab"), listOf("két szó"), listOf("shorts", "SHORTS"))) {
            assertEquals("BAD_KEYWORD", assertFailsWith<Referee.RefereeException> { Referee.setKeywords(bad, now) }.code, "$bad")
        }
        val many = (0 until KeywordLogic.MAX_KEYWORDS + 1).map { "szo" + it.toString().padStart(3, '0') }
        assertEquals("TOO_MANY_KEYWORDS", assertFailsWith<Referee.RefereeException> { Referee.setKeywords(many, now) }.code)
        assertTrue(BreakerStore.state.value.keywords.isEmpty(), "hibánál semmi nem változik")
        assertNull(BreakerStore.state.value.session)
    }

    /** Végigviszi a futó kísérletet — a várakozó lépést a célpontja után veszi át. */
    private fun solveWholeSession(now: Long) {
        var guard = 0
        while (BreakerStore.state.value.session != null && guard++ < 200) {
            val s = BreakerStore.state.value.session!!
            when (val step = s.steps[s.stepIndex]) {
                is Step.Delay -> Referee.claimDelay(s.id, (step.claimableAt ?: 0) + 1)
                else -> Referee.submitAnswer(s.id, solveStep(step, now), now)
            }
        }
    }

    /** A helyes válasz; a MEMORY lépést visszadátumozzuk a várakozása mögé. */
    private fun solveStep(step: Step, now: Long): String = when (step) {
        is Step.Transcribe -> step.text
        is Step.MathChain -> step.problems[step.pos].a.toString()
        is Step.Memory -> {
            BreakerStore.mutate { st ->
                val ses = st.session!!
                val steps = ses.steps.toMutableList()
                steps[ses.stepIndex] = step.copy(armedAt = now - step.showMs - step.waitMs - 1000)
                st.copy(session = ses.copy(steps = steps))
            }
            step.code
        }
        is Step.Reverse -> step.text.reversed()
        is Step.Delay -> error("a várakozást átvenni kell")
        is Step.Partner -> error("a megbízott lépése a jelmondat — ezek a tesztek megbízott nélkül futnak")
    }
}
