import hu.breaker.app.core.UpdateLogic
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A frissítés-ellenőrzés tiszta része. A verzió-összevetés az a fajta kód, ami
 * ránézésre mindig helyes — és amiben mindig ott a 0.10 < 0.9 hiba.
 */
class UpdateLogicTest {

    @Test fun `numeric order, not text order`() {
        // A klasszikus: szövegként a "0.9" nagyobb, mint a "0.10".
        assertTrue(UpdateLogic.compareVersions("0.10.0", "0.9.0") > 0)
        assertTrue(UpdateLogic.compareVersions("1.0.0", "0.99.99") > 0)
        assertEquals(0, UpdateLogic.compareVersions("1.2.3", "1.2.3"))
        assertTrue(UpdateLogic.compareVersions("1.2.3", "1.2.4") < 0)
    }

    @Test fun `missing parts count as zero`() {
        assertEquals(0, UpdateLogic.compareVersions("1.2", "1.2.0"))
        assertTrue(UpdateLogic.compareVersions("1.2.1", "1.2") > 0)
    }

    @Test fun `the v prefix and stray text do not confuse it`() {
        assertTrue(UpdateLogic.isNewer("v0.1.4", "0.1.3"))
        assertTrue(UpdateLogic.isNewer("V0.2.0", "0.1.9"))
        assertFalse(UpdateLogic.isNewer("v0.1.3", "0.1.3"), "ugyanaz a verzió nem frissítés")
        assertFalse(UpdateLogic.isNewer("v0.1.2", "0.1.3"), "visszafelé sosem")
    }

    @Test fun `a nonsense tag never triggers an update`() {
        // Egy elgépelt vagy üres címke ne indítson letöltést.
        assertFalse(UpdateLogic.isNewer("", "0.1.3"))
        assertFalse(UpdateLogic.isNewer("   ", "0.1.3"))
        assertFalse(UpdateLogic.isNewer("valami", "0.1.3"))
    }

    @Test fun `a prerelease suffix does not make it older than the release`() {
        assertEquals(0, UpdateLogic.compareVersions("1.2.3-rc1", "1.2.3"))
        assertTrue(UpdateLogic.isNewer("v1.3.0-beta", "1.2.9"))
    }

    @Test fun `the aab is never offered for install`() {
        // Az .aab a Play Store feltöltési formátuma; telepíteni nem lehet.
        // Ha ezt választanánk, a felhasználó letöltene 6 MB-ot, hogy aztán a
        // rendszertelepítő értelmezhetetlen hibát adjon.
        val assets = listOf("Breaker-v0.1.4.aab", "latest.yml", "Breaker-v0.1.4.apk", "Breaker-0.1.4.dmg")
        assertEquals("Breaker-v0.1.4.apk", UpdateLogic.pickApk(assets))
    }

    @Test fun `no apk means no update offer`() {
        assertNull(UpdateLogic.pickApk(listOf("Breaker-v0.1.4.aab", "latest.yml")))
        assertNull(UpdateLogic.pickApk(emptyList()))
    }

    @Test fun `the partial download has a different name from the finished one`() {
        // Erre áll az egész: a félbemaradt letöltésből sosem lehet
        // „telepíthetőnek látszó” APK, mert a végleges nevet csak átnevezés adja.
        val name = "breaker-0.1.4.apk"
        assertTrue(UpdateLogic.partName(name) != name)
        assertFalse(UpdateLogic.partName(name).endsWith(".apk"))
    }
}
