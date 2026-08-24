import hu.breaker.app.core.Pairing
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Párosító kód — a `desktop/test/pairing.test.ts` párja.
 *
 * A KÓDNAK BÁJTRA EGYEZNIE KELL a gépen kiadottal. Ha nem, a felhasználó a
 * gépen kapott kódot begépeli a telefonba, és vagy nem történik semmi, vagy —
 * ami rosszabb — MÁS címre kerül a jelszava.
 *
 * A várt kódok itt nincsenek kiszámolva, csak BEMÁSOLVA: a TypeScript oldal
 * tényleges kimenete. Így a teszt nem azt bizonyítja, hogy a Kotlin kód
 * önmagával konzisztens, hanem hogy a kettő ugyanaz.
 */
class PairingTest {

    @Test
    fun `the code matches what the desktop produces, character for character`() {
        // Ezek nincsenek kiszámolva, csak BEMÁSOLVA: a TypeScript oldal
        // tényleges kimenetei. Így a teszt nem azt bizonyítja, hogy a Kotlin
        // kód önmagával konzisztens, hanem hogy a kettő UGYANAZ — enélkül a
        // gépen kiadott kód a telefonon nem nyílna ki.
        val fixtures = mapOf(
            "http://192.168.1.10:8787" to "00GMR",
            "http://10.0.0.5:8787" to "800019G",
            "http://172.20.3.4:8787" to "H030JR",
            "http://8.8.8.8:8787" to "R40G208N",
            "http://192.168.1.10:9000" to "4HJG08AM",
        )
        for ((url, want) in fixtures) {
            assertEquals(want, Pairing.encode(url), "eltérő kód: $url")
            assertEquals(url, Pairing.decode(want), "a gépen kiadott kód nem nyílik ki: $want")
        }
    }

    @Test
    fun `a home address becomes a very short code`() {
        // A rövidség a lényeg: ha a kód is tíz karakter, semmivel nem jobb az
        // IP-címnél.
        val code = Pairing.encode("http://192.168.1.10:8787")
        assertTrue(code != null && code.length == 5, "öt karakter, nem ${code?.length}")
        assertEquals("http://192.168.1.10:8787", Pairing.decode(code!!))
    }

    @Test
    fun `every private range survives the round trip`() {
        for (url in listOf(
            "http://192.168.0.1:8787",
            "http://192.168.255.255:8787",
            "http://10.0.0.5:8787",
            "http://10.255.255.254:8787",
            "http://172.16.4.9:8787",
            "http://172.31.200.1:8787",
            "http://100.64.3.7:8787",
            "http://8.8.8.8:8787",
            "http://192.168.1.10:9000",
        )) {
            val code = Pairing.encode(url)
            assertTrue(code != null, "nem kódolható: $url")
            assertEquals(url, Pairing.decode(code!!), "oda-vissza eltér: $url -> $code")
            assertTrue(code.length <= 8, "túl hosszú (${code.length}): $url")
        }
    }

    @Test
    fun `a mistyped code is refused, not silently pointed elsewhere`() {
        val good = Pairing.encode("http://192.168.1.10:8787")!!
        val alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
        var refused = 0
        var total = 0
        for (i in good.indices) {
            for (ch in alphabet) {
                if (ch == good[i]) continue
                total++
                val bad = good.substring(0, i) + ch + good.substring(i + 1)
                val decoded = Pairing.decode(bad)
                if (decoded == null) refused++
                else assertTrue(decoded != "http://192.168.1.10:8787")
            }
        }
        assertTrue(refused.toDouble() / total > 0.9, "csak ${refused * 100 / total}%-ot fogott meg")
    }

    @Test
    fun `hyphens, spaces and look-alikes never decide whether a code works`() {
        // Kézzel másolva senki nem figyel ezekre. Egy kód, ami emiatt nem megy,
        // ugyanolyan rossz, mint a be nem gépelt IP-cím.
        val code = Pairing.encode("http://192.168.1.10:8787")!!
        val want = "http://192.168.1.10:8787"
        assertEquals(want, Pairing.decode(code.lowercase()))
        assertEquals(want, Pairing.decode(Pairing.format(code)))
        assertEquals(want, Pairing.decode(" " + code.toCharArray().joinToString(" ") + " "))
        assertEquals(want, Pairing.decode(code.replace("1", "I").replace("0", "O")))
    }

    @Test
    fun `junk does not become a valid address`() {
        // A bizonytalanság az ELUTASÍTÁS felé dől: egy véletlenül elfogadott
        // kód olyan gépre küldené a jelszót, amiről a felhasználó nem tud.
        for (bad in listOf("", "   ", "ZZZZZ", "ABC", "nem egy kód", "!!!!!", "A".repeat(40))) {
            assertNull(Pairing.decode(bad), bad)
        }
        assertNull(Pairing.encode("https://192.168.1.10:8787"))
        assertNull(Pairing.encode("http://sync.pelda.hu:8787"))
        assertNull(Pairing.encode("nem egy cím"))
    }

    @Test
    fun `one field takes both a code and an address`() {
        val code = Pairing.encode("http://192.168.1.10:8787")!!
        assertEquals("http://192.168.1.10:8787", Pairing.resolveServerInput(code))
        assertEquals("http://192.168.1.10:8787", Pairing.resolveServerInput("http://192.168.1.10:8787"))
        assertEquals("https://sync.pelda.hu", Pairing.resolveServerInput("https://sync.pelda.hu"))
        assertEquals("http://192.168.1.10:8787", Pairing.resolveServerInput("192.168.1.10:8787"))
        assertNull(Pairing.resolveServerInput(""))
        assertNull(Pairing.resolveServerInput("   "))
    }
}
