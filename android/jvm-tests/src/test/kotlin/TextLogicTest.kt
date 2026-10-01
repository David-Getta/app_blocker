import hu.breaker.app.core.AliasLogic
import hu.breaker.app.core.Blocklist
import hu.breaker.app.core.KeywordLogic
import hu.breaker.app.core.PartnerLogic
import hu.breaker.app.core.TextLogic
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * A szöveg-tisztítás éles esetei név szerint — a `desktop/test/alias.test.ts`,
 * `keywords.test.ts`, `partner.test.ts` és `blocklist.test.ts` megfelelő
 * eseteinek tükre. A teljes megfelelőséget a TextFixtureTest nézi; ez a fájl
 * azt mondja ki, MIÉRT: melyik buktató melyik.
 */
class TextLogicTest {

    private val pizza = "🍕"

    @Test fun `a vagas kodpontban szamol - egy emodzsi nem vagodik felbe`() {
        // 39 betű + két emodzsi: UTF-16 egységben vágva a 40. egy fél emodzsi
        // lett volna — párja nélküli helyettesítő, amit az iPhone JSON-olvasója eldob.
        val a = AliasLogic.normalize("a".repeat(AliasLogic.MAX_ALIAS_LENGTH - 1) + pizza + pizza)!!
        assertEquals("a".repeat(AliasLogic.MAX_ALIAS_LENGTH - 1) + pizza, a)
        assertEquals(AliasLogic.MAX_ALIAS_LENGTH, a.codePointCount(0, a.length))
        assertEquals(pizza.repeat(AliasLogic.MAX_ALIAS_LENGTH), AliasLogic.normalize(pizza.repeat(45)))
    }

    @Test fun `a nem toro szokoz es a BOM is szokoz - a kimondott lista a JS keszlete`() {
        assertEquals("A videós", AliasLogic.normalize("A\u00A0videós"))
        assertEquals("A videós", AliasLogic.normalize("\uFEFFA videós\uFEFF"))
        assertNull(AliasLogic.normalize("\u00A0\uFEFF"))
        // Ami láthatatlan, de nem szóköz, marad: egyik mag sem veszi szóköznek.
        assertEquals("A\u200Bvideós", AliasLogic.normalize("A\u200Bvideós"))
        for (ch in TextLogic.SPACES) assertEquals("A B", AliasLogic.normalize("A${ch}B"), "U+%04X".format(ch.code))
    }

    @Test fun `a kulcsszo - BOM es nem toro szokoz a szelen le, belul nem szabaly, a hossz kodpontban`() {
        assertEquals("shorts", KeywordLogic.normalizeKeyword("\uFEFFShorts\uFEFF"))
        assertEquals("reels", KeywordLogic.normalizeKeyword("\u00A0reels\u00A0"))
        assertNull(KeywordLogic.normalizeKeyword("két\u00A0szó"), "a nem törő szóköz is szóköz")
        assertNull(KeywordLogic.normalizeKeyword("két\uFEFFszó"), "a BOM is szóköz")
        assertEquals("két\u200Bszó", KeywordLogic.normalizeKeyword("két\u200Bszó"), "a nulla szélességű szóköz nem szóköz")
        assertEquals(pizza.repeat(3), KeywordLogic.normalizeKeyword(pizza.repeat(3)), "három kódpont: elég")
        assertNull(KeywordLogic.normalizeKeyword(pizza.repeat(2)), "két kódpont: kevés — UTF-16 egységben négy lenne")
    }

    @Test fun `a jelmondat es a nev szokozei - a nev kodpontban vagva, logo szokoz nelkul`() {
        // A jelmondatot hasoljuk: ha a gép és a telefon mást tart szóköznek, az
        // egyik eszközön nem nyit.
        assertEquals("alma bogrács cinege", PartnerLogic.normalizePhrase("Alma\u00A0Bogrács\uFEFF Cinege"))
        assertEquals("alma bogrács", PartnerLogic.normalizePhrase("\uFEFFalma\u3000bogrács"))
        assertEquals("Anya", PartnerLogic.normalizePartnerName("Anya\u00A0"))
        assertEquals(pizza.repeat(PartnerLogic.MAX_PARTNER_NAME), PartnerLogic.normalizePartnerName(pizza.repeat(45)))
        assertEquals("a".repeat(39), PartnerLogic.normalizePartnerName("a".repeat(39) + " bbbb"))
    }

    @Test fun `a domain szelen a BOM es a nem toro szokoz lekerul, belul nem`() {
        assertEquals("youtube.com", Blocklist.normalizeDomain("\uFEFFyoutube.com\uFEFF"))
        assertEquals("youtube.com", Blocklist.normalizeDomain("\u00A0youtube.com\u00A0"))
        assertNull(Blocklist.normalizeDomain("youtube\u00A0.com"))
        assertNull(Blocklist.normalizeDomain("youtube.com\u200B"))
    }

    @Test fun `a gorog szo vegi szigma kisbetuje - a Java is a Final_Sigma szabalyt koveti, mint a JS`() {
        assertEquals("\u03BF\u03B4\u03BF\u03C2", KeywordLogic.normalizeKeyword("ΟΔΟΣ"))
        assertEquals("\u03C3\u03BF\u03C6\u03BF\u03C2", KeywordLogic.normalizeKeyword("ΣΟΦΟΣ"))
        assertEquals("\u03BF\u03B4\u03BF\u03C2 \u03BF\u03B4\u03BF\u03C2", PartnerLogic.normalizePhrase("ΟΔΟΣ ΟΔΟΣ"))
        assertEquals("\u03C3 \u03B1\u03C3\u03B1", PartnerLogic.normalizePhrase("Σ ΑΣΑ"))
    }
}
