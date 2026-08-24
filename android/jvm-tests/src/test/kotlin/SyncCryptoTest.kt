import hu.breaker.app.core.SyncCrypto
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * A szinkron titkosítása — és ami ennél is fontosabb: hogy UGYANAZ, mint a gépen.
 *
 * Az alábbi értékeket NEM ez a kód gyártotta: a Node oldal (a valódi asztali
 * kód) állította elő őket, és ide vannak másolva. Ha a Kotlin mag bármiben
 * elcsúszik — kulcsszármaztatás, HKDF-címke, blob-formátum, base64 —, akkor ezek
 * a burkolatok nem nyílnak ki, és a teszt elbukik. Enélkül a hiba csak ott
 * derülne ki, ahol a legrosszabb: a felhasználó telefonján, belépéskor.
 */
class SyncCryptoTest {

    private val accountId = "acc_teszt"
    private val password = "ez-egy-elég-hosszú-jelszó"
    private val recoveryCode = "1THW-EBEP-44H9-33JC-EP8S-0S7Q-DVTF-CD6Q"
    private val wrappedByPassword = "brk1.ifgZSdAaT1J8Ijg3.a_WINPyrRBkB_ESkOI3cFg.Z9ftmx5XrbXx_bzxB9ceUFhysScGHpCJUU5AnMG1eHBVtQQJCZ8JOgFxBCc"
    private val wrappedByRecovery = "brk1.LYoCmyhyaS6jd-CB.vNAQ2qd5Z5F5_649M-q-7A.xeEMppLrHg-J2ytfrDieBEV3KOvLpJILtAmwnmifrH5F1tvUUdOu25-cQWY"
    private val dataKeyB64 = "nsAQTtKsDABPQkyrFumULr0hngffP/plHMWKEbBkifQ="
    private val blobFromNode = "brk1.FojyZdtJYV03Fzh1.V8csd6RWCZUHcg2aT-ij4A.63ep7GMAD9KX7kwNOoMERrLzHaK4imI4mU-2fII2lweHaPa3RMIXIA"

    @Test
    fun `the password opens a data key wrapped on the desktop`() {
        val key = SyncCrypto.unlockWithPassword(accountId, password, wrappedByPassword)
        assertEquals(dataKeyB64, SyncCrypto.b64(key))
    }

    @Test
    fun `the recovery code opens the same data key`() {
        val key = SyncCrypto.unlockWithRecovery(recoveryCode, wrappedByRecovery)
        assertEquals(dataKeyB64, SyncCrypto.b64(key))
        // Kötőjelek és kisbetűk nélkül is: kézzel másolva senki nem figyel ezekre.
        val messy = recoveryCode.lowercase().replace("-", " ")
        assertEquals(dataKeyB64, SyncCrypto.b64(SyncCrypto.unlockWithRecovery(messy, wrappedByRecovery)))
    }

    @Test
    fun `a blob written on the desktop decrypts here`() {
        val key = SyncCrypto.unb64(dataKeyB64)
        assertEquals("""[{"id":"site_1","domain":"youtube.com"}]""", SyncCrypto.decrypt(key, blobFromNode))
    }

    @Test
    fun `the auth keys match the ones the desktop sends`() {
        assertEquals("SPgYkvURBdAHhJqHf6fDAAWoPBMxS3oqvosFvdPTU0w=", SyncCrypto.authKey(password, accountId))
        assertEquals("tzOn+uxOlbCzUTlK0caIOxaRH3/pNxf+Yeq7826wlFI=", SyncCrypto.recoveryAuthKey(recoveryCode))
    }

    @Test
    fun `what we encrypt here can be read back here`() {
        val key = SyncCrypto.unb64(dataKeyB64)
        val a = SyncCrypto.encrypt(key, "youtube.com")
        val b = SyncCrypto.encrypt(key, "youtube.com")
        assertTrue(a != b, "azonos IV ugyanazzal a kulccsal GCM-nél a kulcs eldobása lenne")
        assertEquals("youtube.com", SyncCrypto.decrypt(key, a))
        assertEquals("youtube.com", SyncCrypto.decrypt(key, b))
    }

    @Test
    fun `a tampered blob is refused, not silently accepted`() {
        val key = SyncCrypto.unb64(dataKeyB64)
        val parts = blobFromNode.split(".")
        val ct = SyncCrypto.unb64(parts[3])
        ct[0] = (ct[0].toInt() xor 1).toByte()
        val tampered = listOf(parts[0], parts[1], parts[2], SyncCrypto.b64(ct).replace("+", "-").replace("/", "_").replace("=", ""))
            .joinToString(".")
        assertFailsWith<Exception> { SyncCrypto.decrypt(key, tampered) }
        assertFailsWith<IllegalArgumentException> { SyncCrypto.decrypt(key, "csak.harom.resz") }
        assertFailsWith<IllegalArgumentException> { SyncCrypto.decrypt(key, blobFromNode.replace("brk1", "brk9")) }
    }

    @Test
    fun `a wrong password does not open the wrapper`() {
        assertFailsWith<Exception> {
            SyncCrypto.unlockWithPassword(accountId, password + "x", wrappedByPassword)
        }
    }

    @Test
    fun `look-alike letters in the recovery code land in the same place`() {
        assertEquals("0111", SyncCrypto.normalizeRecoveryCode("o1-Il"))
        assertFailsWith<IllegalArgumentException> { SyncCrypto.recoveryKey("rövid") }
    }
}
