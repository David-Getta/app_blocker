import android.content.Context
import hu.breaker.app.core.AppState
import hu.breaker.app.core.Blocklist
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.ChallengeEngine
import hu.breaker.app.core.ChallengeEngine.Kind
import hu.breaker.app.core.ChallengeEngine.Step
import hu.breaker.app.core.Focus
import hu.breaker.app.core.FocusSync
import hu.breaker.app.core.PartnerLogic
import hu.breaker.app.core.Referee
import hu.breaker.app.core.Site
import hu.breaker.app.core.SyncClient
import hu.breaker.app.core.SyncRevisions
import org.json.JSONObject
import java.io.File
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Párban zárolás a Kotlin tükrön — a desktop/test/partner.test.ts esetei. A
 * lenyomat a `fixtures/partner-hash.json`-nal mérve: a gépen felvett
 * megbízottnak a telefonon is stimmelnie kell.
 */
class PartnerTest {

    private val now = 1_700_000_000_000L
    private val phrase = "alma bogrács cinege délután"

    @BeforeTest fun reset() {
        BreakerStore.init(Context())
        BreakerStore.mutate { AppState() }
        BreakerStore.saveLastTick(0)
    }

    private fun fixtureFile(): File {
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            val f = File(dir, "fixtures/partner-hash.json")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        error("fixtures/partner-hash.json nincs meg a tároló gyökerében")
    }

    @Test fun `a jelmondat kanonikus alakja - kis-nagybetu, szokozok, NFKC nem szamit`() {
        assertEquals(phrase, PartnerLogic.normalizePhrase("  Alma  BOGRÁCS\tcinege\n délután "))
        // Bontott ékezet (a + kombináló vessző) ugyanaz, mint az összetett á.
        assertEquals(PartnerLogic.normalizePhrase("álma"), PartnerLogic.normalizePhrase("a" + Char(0x0301) + "lma"))
        assertEquals("", PartnerLogic.normalizePhrase("   "))
        assertEquals("Anna Kovács", PartnerLogic.normalizePartnerName("  Anna   Kovács "))
        assertNull(PartnerLogic.normalizePartnerName(""))
        assertNull(PartnerLogic.normalizePartnerName(null))
        assertEquals(PartnerLogic.MAX_PARTNER_NAME, PartnerLogic.normalizePartnerName("x".repeat(100))!!.length)
    }

    @Test fun `a lenyomat a gepevel egyezik - fixtures partner-hash json`() {
        val fx = JSONObject(fixtureFile().readText())
        val salt = fx.getString("salt")
        assertEquals(fx.getString("hash"), PartnerLogic.hashPhrase(fx.getString("phrase"), salt), "ugyanaz a jelmondat, ugyanaz a lenyomat — mint a gépen")
        assertEquals(fx.getString("hash"), PartnerLogic.hashPhrase(" Alma bogrács CINEGE délután", salt), "a kanonikus alak számít")
        assertNotEquals(fx.getString("hash"), PartnerLogic.hashPhrase(fx.getString("wrong"), salt))
        val lock = PartnerLogic.PartnerLock("Anna", salt, fx.getString("hash"), 1L)
        assertTrue(PartnerLogic.verify(lock, "ALMA  bogrács cinege délután "))
        assertFalse(PartnerLogic.verify(lock, fx.getString("wrong")))
        assertFalse(PartnerLogic.verify(lock, ""))
        val made = PartnerLogic.makeLock("Anna", phrase, now)
        assertTrue(PartnerLogic.verify(made, phrase))
        assertNotEquals(salt, made.salt, "friss só minden felvételnél")
        assertNull(PartnerLogic.normalizeLock("Anna", "rövid", fx.getString("hash"), 1L))
        assertNull(PartnerLogic.normalizeLock("", salt, fx.getString("hash"), 1L))
        assertEquals(lock, PartnerLogic.normalizeLock("Anna", salt, fx.getString("hash"), 1L))
    }

    @Test fun `fesules - AZONOSSAG szerint, elo megbizottat csak a nyoma visz el, a jel nem`() {
        val a = PartnerLogic.PartnerLock("Anna", "A".repeat(24), "B".repeat(44), 100)
        val b = PartnerLogic.PartnerLock("Béla", "C".repeat(24), "D".repeat(44), 200)
        val set = { p: PartnerLogic.PartnerLock?, co: List<PartnerLogic.PartnerLock>, gone: List<PartnerLogic.PartnerGone> ->
            PartnerLogic.PartnerSet(p, co, gone)
        }
        assertEquals(set(a, emptyList(), emptyList()), PartnerLogic.mergePartners(set(a, emptyList(), emptyList()), PartnerLogic.PartnerSet()))
        assertEquals(set(a, listOf(b), emptyList()), PartnerLogic.mergePartners(set(b, emptyList(), emptyList()), set(a, emptyList(), emptyList())),
            "két különböző élő: mindkettő marad, a korábban felvett a fő")
        val goneA = listOf(PartnerLogic.PartnerGone(PartnerLogic.partnerId(a), 7))
        assertEquals(set(null, emptyList(), goneA), PartnerLogic.mergePartners(set(a, emptyList(), emptyList()), set(null, emptyList(), goneA)))
        assertEquals(set(b, emptyList(), goneA), PartnerLogic.mergePartners(set(null, emptyList(), goneA), set(a, listOf(b), emptyList())),
            "a fő levétele után a társ lép a helyére")
        assertEquals(
            listOf(PartnerLogic.PartnerGone(PartnerLogic.partnerId(a), 9)),
            PartnerLogic.cleanPartnersGone(listOf(
                PartnerLogic.PartnerGone(PartnerLogic.partnerId(a), 3), PartnerLogic.PartnerGone(PartnerLogic.partnerId(a), 9),
                PartnerLogic.PartnerGone("rossz", 1),
            )),
        )

        // A TRÜKK: friss eszközön, felhúzott jellel felvett saját megbízott nem váltja le a valódit.
        val own = PartnerLogic.PartnerLock("Én", "E".repeat(24), "F".repeat(44), 50)
        val base = FocusSync.SyncFocus(packs = emptyList(), run = null, log = emptyList(), rev = 0, updatedAt = 0, updatedBy = "dev")
        val account = base.copy(partner = a, partnerRev = 3, rev = 3, updatedBy = "gep")
        val fresh = base.copy(partner = own, partnerRev = 40, rev = 40, updatedAt = 999, updatedBy = "friss")
        for (merged in listOf(FocusSync.merge(account, fresh), FocusSync.merge(fresh, account))) {
            assertEquals(listOf("Anna", "Én"), (listOfNotNull(merged.partner) + merged.partnerCo).map { it.name }.sorted(),
                "a valódi megmarad — a saját csak mellé kerül")
            assertEquals(40, merged.partnerRev)
        }
        // A „nincs megbízott” felhúzott jellel sem viszi el.
        val none = base.copy(partnerRev = 50, rev = 50, updatedBy = "friss")
        assertEquals(a, FocusSync.merge(account, none).partner)
        assertEquals(a, FocusSync.merge(none, account).partner)
        // A nyom viszont elviszi.
        val removed = base.copy(partnersGone = listOf(PartnerLogic.PartnerGone(PartnerLogic.partnerId(a), 5)), partnerRev = 4, rev = 4)
        assertNull(FocusSync.merge(account, removed).partner)
        assertFalse(FocusSync.same(account, account.copy(partnerCo = listOf(own))), "a társ is különbség")
        assertFalse(FocusSync.same(account, account.copy(partnersGone = listOf(PartnerLogic.PartnerGone(PartnerLogic.partnerId(own), 1)))))
    }

    @Test fun `drot-alak - a megbizott JSON-ja oda-vissza, a rossz alaku kiesik`() {
        val a = PartnerLogic.PartnerLock("Anna", "A".repeat(24), "B".repeat(44), 100)
        assertEquals(a, SyncClient.partnerFromJson(SyncClient.partnerToJson(a)))
        assertNull(SyncClient.partnerFromJson(JSONObject().put("name", "X").put("salt", "rövid").put("hash", "rövid")))
        assertNull(SyncClient.partnerFromJson(null))
        val f = SyncClient.focusFromJson(
            JSONObject().put("packs", org.json.JSONArray()).put("rev", 4).put("partnerRev", 99)
                .put("partner", SyncClient.partnerToJson(a)).toString(),
            "dev", null,
        )
        assertEquals(a, f.partner)
        assertNull(f.partnerRev, "a jel legfeljebb a blob rev-je")
    }

    // ------------------------------------------------------------------ a bíró

    private fun addSite(domain: String): String {
        val id = BreakerStore.newId("site")
        BreakerStore.mutate { s ->
            s.copy(sites = s.sites + Site(
                id = id, domain = domain, hostnames = Blocklist.expandHostnames(domain, false),
                addedAt = now, pauseUntil = null, pendingDeleteAt = null,
            ))
        }
        return id
    }

    private fun currentStep(): Step {
        val s = BreakerStore.state.value.session!!
        return s.steps[s.stepIndex]
    }

    private fun solve(step: Step): String = when (step) {
        is Step.Transcribe -> step.text
        is Step.MathChain -> step.problems[step.pos].a.toString()
        is Step.Memory -> {
            BreakerStore.mutate { s ->
                val ses = s.session!!
                val steps = ses.steps.toMutableList()
                steps[ses.stepIndex] = step.copy(armedAt = now - step.showMs - step.waitMs - 1000)
                s.copy(session = ses.copy(steps = steps))
            }
            step.code
        }
        is Step.Reverse -> step.text.reversed()
        is Step.Delay -> error("a várakozást átvenni kell")
        is Step.Partner -> error("a megbízott lépése a jelmondat")
    }

    /** Végigviszi a kísérletet a megbízott lépéséig — a várakozást is átveszi. */
    private fun solveUntilPartner(id: String) {
        var guard = 0
        while (BreakerStore.state.value.session != null && guard++ < 200) {
            when (val step = currentStep()) {
                is Step.Partner -> return
                is Step.Delay -> Referee.claimDelay(id, (step.claimableAt ?: now) + 1)
                else -> Referee.submitAnswer(id, solve(step), now)
            }
        }
        error("a kísérlet elfogyott a megbízott lépése előtt")
    }

    @Test fun `megbizottal a terv utolso lepese az o jelmondata - a varakozas utan`() {
        val siteId = addSite("youtube.com")
        val setup = Referee.setPartner("  Anna ", now)
        assertEquals("Anna", setup.name)
        assertEquals(PartnerLogic.PARTNER_PHRASE_WORDS, setup.phrase.split(" ").size, "négy szó")
        assertEquals(setup.phrase, setup.phrase.lowercase())
        assertEquals("Anna", BreakerStore.state.value.partner?.name)
        assertFailsWith<Referee.RefereeException> { Referee.setPartner("Béla", now) }

        val ses = Referee.startSession(Kind.PAUSE, siteId, 15, now)
        assertTrue(ses.steps.last() is Step.Partner)
        assertTrue(ses.steps[ses.steps.size - 2] is Step.Delay)
        assertEquals("Anna", (ses.steps.last() as Step.Partner).name)

        solveUntilPartner(ses.id)
        // Rossz jelmondat: nem sorsol újat, csak számol; a plafonnál a kísérlet elszáll.
        repeat(PartnerLogic.MAX_PARTNER_TRIES - 1) {
            val r = Referee.submitAnswer(ses.id, "alma bogrács cinege este", now)
            assertFalse(r.accepted)
            assertTrue(r.message!!.contains("Nem ez a jelmondat"))
            assertNotNull(BreakerStore.state.value.session, "a kísérlet még él")
        }
        val last = Referee.submitAnswer(ses.id, "megint rossz", now)
        assertFalse(last.accepted)
        assertTrue(last.message!!.contains("elölről"))
        assertNull(BreakerStore.state.value.session, "a plafonnál elszállt")
        assertNull(BreakerStore.state.value.sites[0].pauseUntil, "feloldás nem történt")

        // Újra: minden lépés elölről, és a jó jelmondat a végén feloldja.
        val again = Referee.startSession(Kind.PAUSE, siteId, 15, now + 1000)
        solveUntilPartner(again.id)
        val r = Referee.submitAnswer(again.id, " ${setup.phrase.uppercase()} ", now + 1000)
        assertTrue(r.accepted)
        assertTrue(r.sessionDone)
        assertNotNull(BreakerStore.state.value.sites[0].pauseUntil, "a szünet elindult")
    }

    @Test fun `a feladott kiserlet kombinacioja nem tartalmazza a megbizott lepeset`() {
        val siteId = addSite("youtube.com")
        Referee.setPartner("Anna", now)
        val ses = Referee.startSession(Kind.PAUSE, siteId, 15, now)
        Referee.abandon(ses.id)
        val debt = BreakerStore.state.value.abandons.first()
        assertFalse(debt.comboKey.contains("PARTNER"), debt.comboKey)
        assertNotNull(ChallengeEngine.parseCombo(debt.comboKey), "a kulcs visszaolvasható")
    }

    @Test fun `a megbizott levetele probatetel, a vegen az o jelmondataval`() {
        addSite("youtube.com")
        assertTrue(Referee.startPartnerRemoval(now).applied, "megbízott nélkül nincs mit levenni")
        val setup = Referee.setPartner("Anna", now)
        val r = Referee.startPartnerRemoval(now)
        assertFalse(r.applied)
        val ses = r.session!!
        assertTrue(ses.pendingPartnerRemoval)
        assertTrue(ses.steps.last() is Step.Partner)
        solveUntilPartner(ses.id)
        val done = Referee.submitAnswer(ses.id, setup.phrase, now)
        assertTrue(done.sessionDone)
        assertNull(BreakerStore.state.value.partner, "a megbízott lekerült")
        assertEquals(1, BreakerStore.state.value.unlockLog.size, "a lazítás a naplóban")
    }

    @Test fun `tars-megbizottnal mindegyik jelmondata kell, a levetel mindegyiket nyommal viszi`() {
        val siteId = addSite("youtube.com")
        val anna = Referee.setPartner("Anna", now)
        val annaId = PartnerLogic.partnerId(BreakerStore.state.value.partner!!)
        // Egy másik eszközön, egymástól függetlenül felvett megbízott a szinkronból.
        val belaPhrase = "alma bogrács cinege este"
        val bela = PartnerLogic.makeLock("Béla", belaPhrase, now + 1)
        BreakerStore.mutate { it.copy(partnerCo = listOf(bela)) }
        assertFailsWith<Referee.RefereeException> { Referee.setPartner("Cili", now) }

        val ses = Referee.startSession(Kind.PAUSE, siteId, 15, now)
        assertEquals(listOf("Anna", "Béla"), ses.steps.filterIsInstance<Step.Partner>().map { it.name }, "mindkettőjüké, sorban")
        solveUntilPartner(ses.id)
        assertFalse(Referee.submitAnswer(ses.id, belaPhrase, now).accepted, "Anna lépésére Béla jelmondata nem jó")
        assertTrue(Referee.submitAnswer(ses.id, anna.phrase, now).accepted)
        assertFalse(Referee.submitAnswer(ses.id, anna.phrase, now).accepted, "Béla lépésére Anna jelmondata sem")
        assertTrue(Referee.submitAnswer(ses.id, belaPhrase, now).sessionDone)

        val removal = Referee.startPartnerRemoval(now + 10).session!!
        solveUntilPartner(removal.id)
        Referee.submitAnswer(removal.id, anna.phrase, now + 10)
        // Közben egy harmadik érkezik a szinkronból: ő nem bólintott — marad.
        val cili = PartnerLogic.makeLock("Cili", "dió eper füge gomba", now + 2)
        BreakerStore.mutate { it.copy(partnerCo = it.partnerCo + cili) }
        assertTrue(Referee.submitAnswer(removal.id, belaPhrase, now + 10).sessionDone)
        val st = BreakerStore.state.value
        assertEquals("Cili", st.partner?.name, "aki nem bólintott, marad")
        assertTrue(st.partnerCo.isEmpty())
        assertEquals(listOf(annaId, PartnerLogic.partnerId(bela)).sorted(), st.partnersGone.map { it.id }.sorted(),
            "a két bólintó nyomot kap")
    }

    @Test fun `ha a megbizott kozben lekerult, a lepese targytalan - atmegy`() {
        val siteId = addSite("youtube.com")
        Referee.setPartner("Anna", now)
        val ses = Referee.startSession(Kind.PAUSE, siteId, 15, now)
        solveUntilPartner(ses.id)
        BreakerStore.mutate { it.copy(partner = null) }
        assertTrue(Referee.submitAnswer(ses.id, "bármi", now).sessionDone)
    }

    @Test fun `a folyamatban levo levetel es a lepes tuleli a mentest`() {
        val toJson = BreakerStore::class.java.getDeclaredMethod("toJson", AppState::class.java).apply { isAccessible = true }
        val fromJson = BreakerStore::class.java.getDeclaredMethod("fromJson", JSONObject::class.java).apply { isAccessible = true }
        Referee.setPartner("Anna", now)
        Referee.startPartnerRemoval(now)
        val saved = toJson.invoke(BreakerStore, BreakerStore.state.value).toString()
        val back = fromJson.invoke(BreakerStore, JSONObject(saved)) as AppState
        assertTrue(back.session!!.pendingPartnerRemoval)
        assertTrue(back.session!!.steps.last() is Step.Partner)
        assertEquals("Anna", (back.session!!.steps.last() as Step.Partner).name)
    }

    @Test fun `a felvetel es a levetel lepteti a blobot, es a jel a blob szama`() {
        var state = AppState()
        assertEquals(state.copy(focusRevFp = SyncRevisions.focusFingerprint(state), focusRevKeywordList = emptyList()),
            SyncRevisions.bumpFocus(state, "dev", now), "üres állapot: nincs léptetés")
        state = state.copy(partner = PartnerLogic.makeLock("Anna", phrase, now))
        state = SyncRevisions.bumpFocus(state, "dev", now)
        assertEquals(1L, state.focusRev)
        assertEquals(1, state.partnerRev)
        assertEquals(state, SyncRevisions.bumpFocus(state, "dev", now + 1), "változatlan: nem léptet")
        state = SyncRevisions.bumpFocus(state.copy(partner = null), "dev", now + 2)
        assertEquals(2L, state.focusRev, "a levétel is döntés")
        assertEquals(2, state.partnerRev)
        // Egy másik eszközről átvett megbízott: a lenyomat és a kulcs újraszámolva —
        // nincs léptetés, és egy későbbi saját szerkesztés sem bélyegzi át a jelét
        // (azzal a másik eszköz levételét írná felül: azonos jelnél a beállított nyer).
        val adopted = SyncRevisions.adoptFocus(state.copy(partner = PartnerLogic.makeLock("Béla", phrase, now), partnerRev = 7))
        assertEquals(adopted, SyncRevisions.bumpFocus(adopted, "dev", now + 3), "az átvétel nem szerkesztés")
        val edited = SyncRevisions.bumpFocus(
            adopted.copy(focusPacks = listOf(Focus.FocusPack("p1", "Írás", emptyList(), emptyList(), 25))), "dev", now + 4,
        )
        assertEquals(3L, edited.focusRev)
        assertEquals(7, edited.partnerRev, "az átvett megbízott jele marad")
    }
}
