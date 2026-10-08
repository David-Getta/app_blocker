import android.content.Context
import hu.breaker.app.core.AbandonRec
import hu.breaker.app.core.AppState
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.BurstLogic
import hu.breaker.app.core.BurstTrip
import hu.breaker.app.core.ChallengeEngine
import hu.breaker.app.core.LockdownLogic
import hu.breaker.app.core.Referee
import hu.breaker.app.core.Site
import hu.breaker.app.core.SyncClient
import hu.breaker.app.core.SyncMerge
import org.json.JSONObject
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A végigment törlés SÍRKÖVE (SyncMerge.isGone) — a gép gone-sites.test.ts-ének
 * párja. Eddig a végigment törlés örökre a fiókban maradt, minden kör
 * visszahozta, és egy régi, a kérést sem látott eszköz feltámaszthatta.
 */
class GoneSitesTest {

    private fun site(
        id: String = "s1", pending: Long? = null, del: Int? = null, gone: Int? = null,
        rev: Int = 3, addedAt: Long = 1_000, alias: String? = null, by: String = "gep-a",
    ) = SyncMerge.SyncSite(
        id = id, domain = "x.com", hostnames = listOf("x.com"), addedAt = addedAt, pendingDeleteAt = pending,
        alias = alias, rev = rev, updatedAt = 100L + rev, updatedBy = by, deleteLoosens = del, goneLoosens = gone,
    )

    private fun stone(id: String = "s1", pending: Long = 5_000) = site(id, pending = pending, del = 1, gone = 1)

    @BeforeTest fun reset() {
        BreakerStore.init(Context())
        BreakerStore.mutate { AppState() }
        BreakerStore.saveLastTick(0)
    }

    @Test fun `halott - a vegigment keres a legutobbi, es senki nem vonta vissza`() {
        assertTrue(SyncMerge.isGone(stone()))
        assertFalse(SyncMerge.isGone(site(pending = null, del = 1, gone = 1)), "visszavonva")
        assertFalse(SyncMerge.isGone(site(pending = 5_000, del = 2, gone = 1)), "új kérés jött")
        assertFalse(SyncMerge.isGone(site(pending = 5_000)), "jel nélkül nincs sírkő")
        assertEquals(1, SyncMerge.tombstoneOf(site(pending = 5_000, del = 1))?.goneLoosens)
        assertNull(SyncMerge.tombstoneOf(site(pending = 5_000)), "a régi, számláló nélküli kérés nem kap sírkövet")
    }

    @Test fun `a regi eszkoz rekordja a sirkovel fesulve halott, a visszavonas feltamaszt`() {
        val stale = site(rev = 9, alias = "iksz", by = "telefon")
        assertTrue(SyncMerge.isGone(SyncMerge.mergeSite(stone(), stale)))
        assertTrue(SyncMerge.isGone(SyncMerge.mergeSite(stale, stone())))
        val cancelled = site(del = 1, rev = 4, by = "telefon")
        val revived = SyncMerge.mergeSite(stone(), cancelled)
        assertFalse(SyncMerge.isGone(revived))
        assertNull(revived.pendingDeleteAt)
        assertEquals(1, revived.goneLoosens, "a jel marad")
    }

    @Test fun `a halott kimarad a domain szerinti osszevonasbol - az ujra felvett oldal el`() {
        val readded = site(id = "s2", addedAt = 7_000, rev = 1)
        val m = SyncMerge.mergeLists(listOf(stone()), listOf(readded))
        assertEquals(listOf("s2" to false, "s1" to true), m.map { it.id to SyncMerge.isGone(it) })
        assertNull(m[0].pendingDeleteAt)
    }

    @Test fun `a halozat nelkul vegigment regi torles sirkove az ujra felvett oldalt akkor sem viszi el, ha elobb osszevonodtak`() {
        // A gép gone-sites.test.ts-ének párja: egy elavult eszköz a kettőt
        // egybe fésülte, mielőtt a régi törlés sírköve átért. Az újabban
        // felvett azonosító marad, tehát bármilyen sorrendben él.
        val stale = listOf(site("old"))
        val phone = listOf(site("new", addedAt = 9_000, rev = 1, by = "telefon"))
        val laptop = listOf(stone("old"))
        val m = SyncMerge::mergeLists
        for (r in listOf(m(m(stale, phone), laptop), m(m(phone, laptop), stale), m(m(laptop, stale), phone))) {
            assertEquals(listOf("new" to false, "old" to true), r.map { it.id to SyncMerge.isGone(it) })
        }
    }

    @Test fun `kimondott korlat - az ujabb peldany torlese a beleolvadt regebbit is viszi, ha az osszevonas elobb volt`() {
        val stale = listOf(site("old"))
        val phone = listOf(site("new", addedAt = 9_000, rev = 1, by = "telefon"))
        val phoneDeleted = listOf(site("new", pending = 5_000, del = 1, gone = 1, addedAt = 9_000, rev = 2, by = "telefon"))
        val m = SyncMerge::mergeLists
        assertEquals(listOf("new" to true), m(m(stale, phone), phoneDeleted).map { it.id to SyncMerge.isGone(it) })
        assertEquals(listOf("old" to false, "new" to true), m(stale, m(phone, phoneDeleted)).map { it.id to SyncMerge.isGone(it) })
    }

    @Test fun `az osszevonas nyoma - a helyi szunet, hutes, beteles es adossag az uj azonositora kerul`() {
        val merged = listOf(
            site("s3", addedAt = 3_000).copy(domain = "youtube.com"), site("s2").copy(domain = "reddit.com"),
            stone("s5").copy(domain = "x.com"),
        )
        val folded = SyncMerge.foldedIds(listOf("s1" to "youtube.com", "s2" to "reddit.com", "s4" to "x.com"), merged)
        assertEquals(mapOf("s1" to "s3"), folded, "a megmaradt nem olvadt bele semmibe; halottba nem olvad semmi")
        val before = AppState(
            bursts = mapOf("s1" to BurstLogic.State(300.0, 5_000, 9_000_000), "s3" to BurstLogic.State(10.0, 6_000, 0)),
            burstTrips = mapOf("s1" to BurstTrip("2026-10-08", 2)),
            burstTripLog = mapOf("s1" to mapOf("2026-10-08" to 2)),
            abandons = listOf(AbandonRec("s1", ChallengeEngine.Kind.PAUSE, "TYPE+MATH", 4_000)),
        )
        val after = SyncClient.carryFolded(before, folded)
        assertEquals(mapOf("s3" to BurstLogic.State(300.0, 6_000, 9_000_000)), after.bursts, "a szigorúbb: a futó hűtés nem esik le")
        assertEquals(mapOf("s3" to BurstTrip("2026-10-08", 2)), after.burstTrips)
        assertEquals(mapOf("s3" to mapOf("2026-10-08" to 2)), after.burstTripLog)
        assertEquals(listOf(AbandonRec("s3", ChallengeEngine.Kind.PAUSE, "TYPE+MATH", 4_000)), after.abandons)
    }

    @Test fun `elokeszites es szetosztas - mint a gepen`() {
        val now = 6_000L
        val out = SyncMerge.settleIncoming(
            listOf(site("z", pending = 5_000, del = 1), site("l", pending = 5_000), site("f", pending = 9_000, del = 1),
                site("m", pending = 5_000, del = 1)),
            setOf("m"), now,
        )
        assertEquals(listOf(1, null, null, null), out.map { it.goneLoosens })
        val split = SyncMerge.splitMerged(
            listOf(site("alive"), stone("local-dead"), stone("not-due", pending = 9_000), stone("dead"),
                site("counted-due", pending = 5_000, del = 1), site("legacy-due", pending = 5_000)),
            setOf("alive", "local-dead"), now,
        )
        assertEquals(listOf("alive", "local-dead", "not-due", "counted-due"), split.sites.map { it.id })
        assertEquals(listOf("dead"), split.gone.map { it.id })
    }

    private fun rec(id: String, del: Int?, pending: Long? = 5_000) = Site(
        id = id, domain = "$id.com", hostnames = listOf("$id.com"), addedAt = 1, pauseUntil = null,
        pendingDeleteAt = pending, rev = 4, updatedAt = 10, updatedBy = "telefon", revFp = "fp", deleteLoosens = del,
    )

    @Test fun `a biro - a kifizetett torles vegen sirko marad, a regi keres utan nem, zarlat alatt nincs vegrehajtas`() {
        BreakerStore.mutate {
            AppState(
                sites = listOf(rec("a", del = 2), rec("b", del = null)),
                goneSites = listOf(rec("a", del = 1, pending = 1_000).copy(goneLoosens = 1)),
            )
        }
        Referee.tick(6_000)
        val st = BreakerStore.state.value
        assertEquals(emptyList(), st.sites)
        assertEquals(listOf(Triple("a", 2, 5_000L)), st.goneSites.map { Triple(it.id, it.goneLoosens, it.pendingDeleteAt) },
            "ugyanannak az azonosítónak egy sírköve van: az újabb; a régi kérés után nincs")
        assertNull(st.goneSites[0].revFp, "a lenyomat nem kerül a sírkőre")

        BreakerStore.mutate {
            AppState(sites = listOf(rec("c", del = 1)), lockdown = LockdownLogic.Lockdown(startedAt = 0, until = 99_000))
        }
        Referee.tick(6_100)
        val locked = BreakerStore.state.value
        assertEquals(listOf<Long?>(null), locked.sites.map { it.pendingDeleteAt }, "zárlat alatt a törlés visszavonódik")
        assertEquals(emptyList(), locked.goneSites)
    }

    @Test fun `a droton a sirko jele legfeljebb a torles szamlaloja`() {
        fun raw(extra: String) = """{"id":"s1","domain":"x.com","hostnames":["x.com"],"addedAt":1,"pendingDeleteAt":5000,
            "rev":5,"updatedAt":1,"updatedBy":"a"$extra}"""
        val parsed = SyncClient.sitesFromJson(
            "[" + listOf(
                raw(""","deleteLoosens":2,"goneLoosens":2"""), raw(""","deleteLoosens":2,"goneLoosens":3"""),
                raw(""","goneLoosens":1"""), raw(""","deleteLoosens":2,"goneLoosens":1.5"""),
            ).joinToString(",") + "]",
        )
        assertEquals(listOf(2, null, null, null), parsed.map { it.goneLoosens })
        // És vissza: a sírkő jele a dróton megy.
        assertTrue(SyncClient.sitesToJson(listOf(parsed[0])).contains("\"goneLoosens\":2"))
    }

    private val fromJson = BreakerStore::class.java
        .getDeclaredMethod("fromJson", JSONObject::class.java).apply { isAccessible = true }
    private val toJson = BreakerStore::class.java
        .getDeclaredMethod("toJson", AppState::class.java).apply { isAccessible = true }

    @Test fun `az allapotfajl sirkovei - csak halott, a plafonnal, es oda-vissza`() {
        // Az org.json nem tűr ismétlődő kulcsot: az eltérés a mezők értékében van.
        fun g(id: String, pending: String = "5000", del: Int = 1, gone: Int = 1) =
            """{"id":"$id","domain":"x.com","hostnames":["x.com"],"addedAt":1,"pauseUntil":null,"pendingDeleteAt":$pending,
                "rev":3,"deleteLoosens":$del,"goneLoosens":$gone}"""
        val raw = """{"sites":[],"goneSites":[${g("ok")},${g("cancelled", pending = "null")},
            ${g("big", gone = 2)},${g("junk", del = 9)},"szemét"]}"""
        val st = fromJson.invoke(BreakerStore, JSONObject(raw)) as AppState
        assertEquals(listOf("ok"), st.goneSites.map { it.id })
        val back = fromJson.invoke(BreakerStore, toJson.invoke(BreakerStore, st) as JSONObject) as AppState
        assertEquals(st.goneSites, back.goneSites, "a sírkő oda-vissza ugyanaz")
        val notArray = fromJson.invoke(BreakerStore, JSONObject("""{"sites":[],"goneSites":{"nem":"tömb"}}""")) as AppState
        assertEquals(emptyList(), notArray.goneSites)
    }
}
