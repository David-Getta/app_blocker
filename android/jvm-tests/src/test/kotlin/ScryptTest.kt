import hu.breaker.app.core.Scrypt
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * A saját scrypt-megvalósítás helyessége.
 *
 * Két dolgot kell bizonyítania, és mindkettő nélkül használhatatlan:
 *
 *  1. az RFC 7914 vektorait pontosan hozza — vagyis tényleg scrypt, nem
 *     „valami hasonló”;
 *  2. UGYANAZT adja, mint a Node `crypto.scryptSync` a MI paramétereinkkel —
 *     mert ha eltér, a telefonon nem lehet belépni abba a fiókba, amit a gépen
 *     hoztak létre. Az elvárt érték a Node kimenete, ide másolva.
 */
class ScryptTest {

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    @Test
    fun `rfc 7914 first vector`() {
        val out = Scrypt.scrypt(ByteArray(0), ByteArray(0), 16, 1, 1, 64)
        assertEquals(
            "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442" +
                "fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906",
            hex(out),
        )
    }

    @Test
    fun `rfc 7914 second vector`() {
        val out = Scrypt.scrypt(
            "password".toByteArray(), "NaCl".toByteArray(), 1024, 8, 16, 64,
        )
        assertEquals(
            "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162" +
                "2eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640",
            hex(out),
        )
    }

    @Test
    fun `the same key comes out here as in Node, with our parameters`() {
        // Ez a teszt őrzi, hogy a telefonon és a gépen UGYANAZ a kulcs jöjjön ki.
        // Az elvárt érték a Node crypto.scryptSync kimenete ugyanezekre a
        // bemenetekre; ha ez elhasal, a fiók az egyik eszközön nyithatatlan.
        val out = Scrypt.scrypt(
            "ez-egy-elég-hosszú-jelszó".toByteArray(Charsets.UTF_8),
            "breaker:acc_teszt".toByteArray(Charsets.UTF_8),
            1 shl 15, 8, 1, 32,
        )
        assertEquals("a11d8c4888507e8daf02f0465e429b3342a4bdcae8e5019a55838994d62a521b", hex(out))
    }

    @Test
    fun `a different password gives a different key`() {
        val a = Scrypt.scrypt("alma".toByteArray(), "so".toByteArray(), 256, 4, 1, 32)
        val b = Scrypt.scrypt("almb".toByteArray(), "so".toByteArray(), 256, 4, 1, 32)
        assertTrue(!a.contentEquals(b))
    }

    @Test
    fun `nonsense parameters are refused instead of returning garbage`() {
        assertFailsWith<IllegalArgumentException> {
            Scrypt.scrypt(ByteArray(0), ByteArray(0), 15, 1, 1, 32) // N nem kettőhatvány
        }
        assertFailsWith<IllegalArgumentException> {
            Scrypt.scrypt(ByteArray(0), ByteArray(0), 16, 0, 1, 32) // r = 0
        }
        assertFailsWith<IllegalArgumentException> {
            Scrypt.scrypt(ByteArray(0), ByteArray(0), 16, 1, 1, 0) // üres kulcs
        }
    }
}
