import hu.breaker.app.core.AbandonRec
import hu.breaker.app.core.AppState
import hu.breaker.app.core.BurstLogic
import hu.breaker.app.core.ChallengeEngine
import hu.breaker.app.core.SessionRec
import hu.breaker.app.core.Site
import hu.breaker.app.core.SyncClient
import hu.breaker.app.core.SyncRevisions
import java.io.File
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * A teljes szinkron-kör Androidról, VALÓDI kiszolgálóval.
 *
 * A kiszolgálót (`server/server.js`) gyerekfolyamatként indítjuk, és két
 * „eszközt” játszunk el két külön állapottal. Így nemcsak az összefésülés van
 * letesztelve, hanem a titkosítás, a verziókezelés és a HTTP is — együtt, úgy,
 * ahogy a felhasználónál működni fog. És ami a legfontosabb: ugyanaz a
 * kiszolgáló szolgálja ki a gépet és a telefont.
 *
 * Ha nincs `node` a gépen, a teszt kihagyja magát — a CI-ban van.
 */
class SyncClientTest {

    private var process: Process? = null
    private var baseUrl: String? = null

    private fun serverJs(): File? {
        var dir: File? = File(".").absoluteFile
        repeat(8) {
            val f = File(dir, "server/server.js")
            if (f.isFile) return f
            dir = dir?.parentFile
        }
        return null
    }

    /** Van-e egyáltalán `node` a gépen? Ha van, a kihagyás HIBA, nem mentség. */
    private fun hasNode(): Boolean = System.getenv("PATH").orEmpty().split(File.pathSeparator)
        .any { File(it, "node").canExecute() }

    private fun start(): String? {
        baseUrl?.let { return it }
        val js = serverJs()
        // Csendben kihagyni a legrosszabb kimenetel: a teszt zöld lenne, közben
        // semmit nem ellenőrzött. Ahol van node, ott futnia KELL.
        if (js == null || !hasNode()) {
            check(!hasNode() || js != null) { "van node, de nincs meg a server/server.js" }
            return null
        }
        val dataDir = File(System.getProperty("java.io.tmpdir"), "breaker-sync-kt-" + System.nanoTime())
        val pb = ProcessBuilder("node", js.absolutePath)
        pb.environment()["PORT"] = "0"
        pb.environment()["BREAKER_SYNC_DIR"] = dataDir.absolutePath
        pb.redirectErrorStream(true)
        val p = pb.start()
        process = p
        val reader = p.inputStream.bufferedReader()
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            val line = reader.readLine() ?: break
            val m = Regex("(http://[\\d.]+:\\d+)").find(line)
            if (m != null) {
                baseUrl = m.groupValues[1].replace("0.0.0.0", "127.0.0.1")
                return baseUrl
            }
        }
        error("a kiszolgáló nem indult el 15 másodperc alatt")
    }

    @AfterTest
    fun stop() {
        process?.destroy()
    }

    private fun site(id: String, domain: String, addedAt: Long = 1_000) = Site(
        id = id, domain = domain, hostnames = listOf(domain),
        addedAt = addedAt, pauseUntil = null, pendingDeleteAt = null,
    )

    private fun device(vararg sites: Site) = SyncRevisions.bump(
        AppState(sites = sites.toList()), 1_000,
    )

    @Test
    fun `two devices end up with the same list, and nothing is lost`() {
        val url = start() ?: return // node nélkül kihagyjuk
        val account = "kt-" + System.nanoTime()
        val password = "ez-egy-elég-hosszú-jelszó"

        // Az első eszköz fiókot nyit, és felviszi, ami nála van.
        var (phone, recovery) = SyncClient.signUp(
            device(site("s1", "youtube.com")), url, account, password, "Telefon",
        )
        assertTrue(Regex("^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$").matches(recovery), "helyreállító kód: $recovery")
        phone = SyncClient.syncNow(phone, 2_000).state
        assertEquals(1, phone.sites.size)

        // A második eszköz belép, és a SAJÁT oldala sem vész el.
        var laptop = SyncClient.signIn(
            device(site("s2", "reddit.com", 2_000)), url, account, password, "Gép",
        )
        val r = SyncClient.syncNow(laptop, 3_000)
        laptop = r.state
        assertTrue(r.changed)
        assertEquals(listOf("youtube.com", "reddit.com"), laptop.sites.map { it.domain })

        // És visszafelé: a telefon megkapja a gépen felvettet.
        phone = SyncClient.syncNow(phone, 4_000).state
        assertEquals(listOf("youtube.com", "reddit.com"), phone.sites.map { it.domain })
    }

    @Test
    fun `a pause stays on the device where the challenge was done`() {
        val url = start() ?: return
        val account = "kt-pause-" + System.nanoTime()
        val password = "ez-egy-elég-hosszú-jelszó"

        var phone = SyncClient.signUp(device(site("s1", "youtube.com")), url, account, password, "Telefon").first
        phone = SyncClient.syncNow(phone, 2_000).state
        // Feloldás a telefonon.
        phone = phone.copy(sites = phone.sites.map { it.copy(pauseUntil = 9_999_999_999_999) })
        phone = SyncClient.syncNow(phone, 3_000).state
        assertEquals(9_999_999_999_999, phone.sites[0].pauseUntil,
            "a saját feloldás nem veszhet el attól, hogy szinkronizált")

        // A gépen viszont NEM lesz feloldva: egy próbatétel egy eszközön nem
        // oldhat fel mindenhol.
        var laptop = SyncClient.signIn(AppState(), url, account, password, "Gép")
        laptop = SyncClient.syncNow(laptop, 4_000).state
        assertEquals(null, laptop.sites.first { it.domain == "youtube.com" }.pauseUntil)
    }

    @Test
    fun `a row folded into a newer id keeps its pause, cooldown, debt and running challenge`() {
        // A gép sync-client.test.ts-ének párja, valódi kiszolgálóval: a régóta
        // használt telefonon a sor a régi azonosítót viselte, egy új gépen
        // ugyanazt a domaint külön felvették — az összevonás az újabbat tartja,
        // és ami a telefonon azonosító szerint állt, az vele megy.
        val url = start() ?: return
        val account = "kt-fold-" + System.nanoTime()
        val password = "ez-egy-elég-hosszú-jelszó"

        var phone = SyncClient.signUp(
            device(site("site_a", "reddit.com").copy(pauseUntil = 9_999_000)), url, account, password, "Telefon",
        ).first
        phone = SyncClient.syncNow(phone, 2_000).state.copy(
            bursts = mapOf("site_a" to BurstLogic.State(300.0, 1_500, 9_000_000)),
            abandons = listOf(AbandonRec("site_a", ChallengeEngine.Kind.PAUSE, "TYPE+MATH", 1_800)),
            session = SessionRec("ses", ChallengeEngine.Kind.DELETE, "site_a", null, emptyList(), 0, 1_900),
        )

        var laptop = SyncClient.signIn(
            device(site("site_b", "reddit.com", 5_000).copy(hostnames = listOf("old.reddit.com", "reddit.com"))),
            url, account, password, "Gép",
        )
        laptop = SyncClient.syncNow(laptop, 6_000).state
        assertEquals(listOf("site_b"), laptop.sites.map { it.id }, "egy sor, az újabban felvett azonosítóval")

        phone = SyncClient.syncNow(phone, 7_000).state
        assertEquals(listOf("site_b"), phone.sites.map { it.id }, "a telefonon is az újabb azonosító")
        assertEquals(listOf("old.reddit.com", "reddit.com"), phone.sites[0].hostnames, "a két felvétel nevei együtt tiltanak")
        assertEquals(9_999_000, phone.sites[0].pauseUntil, "a kifizetett szünet megmarad")
        assertEquals(mapOf("site_b" to BurstLogic.State(300.0, 1_500, 9_000_000)), phone.bursts, "a futó hűtés nem esik le")
        assertEquals(listOf(AbandonRec("site_b", ChallengeEngine.Kind.PAUSE, "TYPE+MATH", 1_800)), phone.abandons, "az adósság sem")
        assertEquals("site_b", phone.session?.siteId, "a futó próbatétel az összevont sorra hat")
    }

    @Test
    fun `signing out keeps every block`() {
        val url = start() ?: return
        val account = "kt-out-" + System.nanoTime()
        var phone = SyncClient.signUp(
            device(site("s1", "youtube.com"), site("s2", "reddit.com", 2_000)),
            url, account, "ez-egy-elég-hosszú-jelszó", "Telefon",
        ).first
        phone = SyncClient.syncNow(phone, 2_000).state
        val before = phone.sites.map { it.domain }

        val after = SyncClient.signOut(phone)
        assertEquals(null, after.sync, "a fiók lekapcsolva")
        assertEquals(before, after.sites.map { it.domain }, "a lista érintetlen")
    }

    @Test
    fun `a bad server address is refused before anything is sent`() {
        assertEquals("https://sync.pelda.hu", SyncClient.normalizeServerUrl("sync.pelda.hu"))
        assertEquals("http://127.0.0.1:8787", SyncClient.normalizeServerUrl("http://127.0.0.1:8787/valami"))
        assertFailsWith<SyncClient.SyncException> { SyncClient.normalizeServerUrl("file:///etc/passwd") }
        assertFailsWith<SyncClient.SyncException> { SyncClient.normalizeServerUrl("  ") }
    }

    @Test
    fun `syncing without an account fails loudly instead of doing nothing`() {
        assertFailsWith<SyncClient.SyncException> { SyncClient.syncNow(AppState(), 1_000) }
    }

    @Test
    fun `the sync result does not undo what this device wrote meanwhile`() {
        // A kör egy pillanatképen dolgozott; közben a szűrő egy titkosított-DNS
        // nyomot és egy megakadást írt, a felhasználó „Értem”-et nyomott, a
        // mérő mintát vett, a védelem kikapcsolt.
        val snapshot = AppState(sites = listOf(site("a", "a.example")))
        val result = snapshot.copy(sites = listOf(site("a", "a.example"), site("b", "b.example")))
        val fresh = snapshot.copy(
            protectionOn = !snapshot.protectionOn,
            dohSeenHost = "dns.google", dohSeenAt = 5_000, dohDismissedHosts = listOf("dns.quad9.net"),
            filterHits = mapOf("2026-10-15" to 3), filterHitHours = mapOf("2026-10-15" to List(24) { if (it == 9) 3 else 0 }),
            filterHitHosts = mapOf("2026-10-15" to mapOf("a.example" to 3)),
            filterHitReasons = mapOf("2026-10-15" to mapOf("list" to 3)),
            filterHitKeywords = mapOf("2026-10-15" to mapOf("x" to 1)),
            usageLastSampleAt = 4_000,
        )
        val applied = SyncClient.keepLocal(result, fresh)
        assertEquals(result.sites, applied.sites, "a szinkron mezői az eredményből jönnek")
        assertEquals(fresh.protectionOn, applied.protectionOn)
        assertEquals("dns.google", applied.dohSeenHost)
        assertEquals(5_000L, applied.dohSeenAt)
        assertEquals(listOf("dns.quad9.net"), applied.dohDismissedHosts)
        assertEquals(fresh.filterHits, applied.filterHits)
        assertEquals(fresh.filterHitHours, applied.filterHitHours)
        assertEquals(fresh.filterHitHosts, applied.filterHitHosts)
        assertEquals(fresh.filterHitReasons, applied.filterHitReasons)
        assertEquals(fresh.filterHitKeywords, applied.filterHitKeywords)
        assertEquals(4_000L, applied.usageLastSampleAt)
    }
}
