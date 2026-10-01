import hu.breaker.app.core.Scrypt
import hu.breaker.app.core.SyncCrypto
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Megfelelőség a géppel a SZINKRON TITKOSÍTÁSÁBAN: a `fixtures/crypto-cases.json`
 * a gép kulcsait, burkolatait és blobjait tartja (desktop/test/crypto-fixture.test.ts
 * írja és őrzi). Itt ugyanaz a jelszó és fiók az Android magjába megy: a
 * belépőkulcsnak bájtra egyeznie kell, a burkolatnak ki kell nyílnia, a blobnak
 * ugyanazt a szöveget kell adnia — és aminek a gépen nem szabad kinyílnia,
 * annak itt sem.
 *
 * A SyncCryptoTest kézzel bemásolt értékei ugyanezt mondják egy fiókra; ez a
 * fájl hat fiókra, és azokra az élekre, amiket a kézi másolás nem bír el:
 * ékezet két alakban, emodzsi, teljes szélességű betű, szóköz a szélen, és a
 * jelszó hossza — kódpontban, NFKC után, ahogy a gép méri.
 */
class CryptoFixtureTest {

    private fun fixtureFile(): File {
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            val f = File(dir, "fixtures/crypto-cases.json")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        error("fixtures/crypto-cases.json nincs meg a tároló gyökerében")
    }

    private fun fixture(): JSONObject = JSONObject(fixtureFile().readText())
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    private fun strings(a: JSONArray): List<String> = (0 until a.length()).map { a.getString(it) }

    @Test fun `scrypt - ugyanaz a kulcs, mint a gepen`() {
        val cases = fixture().getJSONArray("scrypt")
        assertTrue(cases.length() >= 2, "a fixture-ben van scrypt-vektor")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val out = Scrypt.scrypt(
                c.getString("password").toByteArray(Charsets.UTF_8), c.getString("salt").toByteArray(Charsets.UTF_8),
                c.getInt("n"), c.getInt("r"), c.getInt("p"), c.getInt("dkLen"),
            )
            assertEquals(c.getString("hex"), hex(out), "scrypt ${c.getString("password")}/${c.getString("salt")}")
        }
    }

    @Test fun `a helyreallito kod tiszta alakja ugyanaz, mint a gepen`() {
        val cases = fixture().getJSONArray("recoveryCodes")
        assertTrue(cases.length() >= 20, "a fixture-ben van elég kód-alak")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val raw = c.getString("raw")
            assertEquals(c.getString("norm"), SyncCrypto.normalizeRecoveryCode(raw), "kód ${JSONObject.quote(raw)}")
        }
    }

    @Test fun `a jelszo hossza ugyanugy szamol, mint a gepen - kodpontban, NFKC utan`() {
        val cases = fixture().getJSONArray("passwords")
        assertTrue(cases.length() >= 10, "a fixture-ben van elég jelszó")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val pw = c.getString("password")
            val n = SyncCrypto.passwordLength(pw)
            assertEquals(c.getInt("length"), n, "hossz ${JSONObject.quote(pw)}")
            assertEquals(c.getBoolean("ok"), n >= SyncCrypto.MIN_PASSWORD_LENGTH, "elég-e ${JSONObject.quote(pw)}")
        }
    }

    @Test fun `a gepen burkolt kulcs itt kinyilik, a gep blobja itt olvashato, a babralt nem`() {
        val accounts = fixture().getJSONArray("accounts")
        assertTrue(accounts.length() >= 4, "a fixture-ben van elég fiók")
        for (i in 0 until accounts.length()) {
            val a = accounts.getJSONObject(i)
            val seed = a.getInt("seed")
            val accountId = a.getString("accountId")
            val password = a.getString("password")
            val dataKey = a.getString("dataKey")
            // Egy scrypt fiókonként: a belépőkulcs és a kulcsburkoló ugyanabból a gyökérből jön.
            val root = SyncCrypto.rootKey(password, accountId)
            assertEquals(a.getString("authKey"), SyncCrypto.b64(SyncCrypto.subKey(root, "auth")), "belépőkulcs, fiók $seed")
            assertEquals(
                dataKey,
                SyncCrypto.b64(SyncCrypto.unwrapDataKey(SyncCrypto.subKey(root, "kek"), a.getString("wrappedByPassword"))),
                "jelszóval burkolt kulcs, fiók $seed",
            )
            for (alt in strings(a.getJSONArray("passwordAlt"))) {
                assertEquals(a.getString("authKey"), SyncCrypto.authKey(alt, accountId), "a jelszó másik alakja, fiók $seed")
            }
            if (!a.isNull("wrongPassword")) {
                assertFailsWith<Exception>("rossz jelszó, fiók $seed") {
                    SyncCrypto.unlockWithPassword(accountId, a.getString("wrongPassword"), a.getString("wrappedByPassword"))
                }
            }
            val code = a.getString("recoveryCode")
            val wrappedByRecovery = a.getString("wrappedByRecovery")
            assertEquals(a.getString("recoveryAuthKey"), SyncCrypto.recoveryAuthKey(code), "helyreállító belépőkulcs, fiók $seed")
            assertEquals(dataKey, SyncCrypto.b64(SyncCrypto.unlockWithRecovery(code, wrappedByRecovery)), "kód, fiók $seed")
            assertEquals(
                dataKey, SyncCrypto.b64(SyncCrypto.unlockWithRecovery(a.getString("messyRecovery"), wrappedByRecovery)),
                "kézzel írt kód, fiók $seed",
            )
            val key = SyncCrypto.unb64(dataKey)
            val blobs = a.getJSONArray("blobs")
            for (j in 0 until blobs.length()) {
                val b = blobs.getJSONObject(j)
                assertEquals(b.getString("text"), SyncCrypto.decrypt(key, b.getString("blob")), "blob $j, fiók $seed")
            }
            for (bad in strings(a.getJSONArray("rejects"))) {
                assertFailsWith<Exception>("nyitni nem szabad: $bad") { SyncCrypto.decrypt(key, bad) }
            }
            // Amit itt zárunk, az itt nyílik — és a gép alakjában áll: négy rész, friss IV.
            val own = SyncCrypto.encrypt(key, password)
            assertEquals(4, own.split(".").size)
            assertTrue(own != SyncCrypto.encrypt(key, password), "friss IV minden híváshoz")
            assertEquals(password, SyncCrypto.decrypt(key, own))
        }
    }
}
