import Foundation

/// SZÖVEG-TISZTÍTÁS a három mag közös fogalmaival — a `desktop/src/shared/alias.ts`
/// `WHITESPACE_CODE_POINTS` listájának és kódpontos vágásának tükre; Androidon a
/// `TextLogic` (Text.kt).
///
/// MIÉRT KELL KIMONDANI. A fedőnév, az indok, a kulcsszó, a megbízott neve és
/// jelmondata, a domain a felhasználó billentyűzetéről jön, és a szinkronon át
/// utazik. A három platform saját szóköz-fogalma eltér: a Swift `isWhitespace`
/// (és a Kotliné) a BOM-ot (U+FEFF) nem ismeri, a JS `\s` igen; a Java regex
/// `\s`-e csak ASCII. Ha a gép szóköznek vesz valamit, amit a telefon nem, a
/// rekord minden szinkron-körben átíródik — vagy a jelmondat az egyik eszközön
/// nem nyit. Ezért itt a JS készlete áll, kimondva; a `fixtures/text-cases.json`
/// (TextFixtureTests) őrzi, hogy a tisztítás bájtra ugyanaz.
///
/// SKALÁR SZINTEN dolgozik, nem `Character`-en: a Swift `prefix` grafémát
/// számolna (egy zászló egy, a gépen kettő), és egy vezérlő egy rá tapadó
/// ékezettel együtt egy `Character` — így kimaradt volna a cseréből. A három
/// mag kódpontban (Unicode-skalárban) számol.
enum TextLogic {

    /// A JS `\s` készlete — pontosan ez a huszonöt kódpont.
    static let spaces: Set<UInt32> = [
        0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
        0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
        0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
    ]

    /// Szóköz-e a kimondott készlet szerint — nem a platform fogalma szerint.
    static func isSpace(_ u: Unicode.Scalar) -> Bool { spaces.contains(u.value) }

    /// Vezérlőkarakterek: C0, DEL és C1 — a TS `CONTROL_CHARS` tartománya.
    static func isControl(_ u: Unicode.Scalar) -> Bool {
        u.value < 0x20 || (u.value >= 0x7f && u.value <= 0x9f)
    }

    /// A vezérlők szóközre, skalár szinten — egy vezérlő egy ékezettel együtt is az.
    static func controlsToSpaces(_ value: String) -> String {
        var out = String.UnicodeScalarView()
        for u in value.unicodeScalars { out.append(isControl(u) ? " " : u) }
        return String(out)
    }

    /// A vezérlők szóközre, a szóköz-futamok egy szóközre, a szélek le — egy
    /// menetben. A TS `replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()` tükre.
    static func collapseSpaces(_ value: String) -> String {
        var out = String.UnicodeScalarView()
        var pendingSpace = false
        for raw in value.unicodeScalars {
            let u: Unicode.Scalar = isControl(raw) ? " " : raw
            if isSpace(u) {
                pendingSpace = true
                continue
            }
            if pendingSpace && !out.isEmpty { out.append(" ") }
            pendingSpace = false
            out.append(u)
        }
        return String(out)
    }

    /// A szélek le a kimondott készlet szerint — a JS `trim()` tükre.
    static func trimSpaces(_ value: String) -> String {
        var scalars = Array(value.unicodeScalars)
        while let first = scalars.first, isSpace(first) { scalars.removeFirst() }
        while let last = scalars.last, isSpace(last) { scalars.removeLast() }
        var out = String.UnicodeScalarView()
        out.append(contentsOf: scalars)
        return String(out)
    }

    /// Az első `max` skalár — egy emodzsi (és egy helyettesítő-pár) együtt marad vagy együtt esik.
    static func takeScalars(_ value: String, _ max: Int) -> String {
        var out = String.UnicodeScalarView()
        var n = 0
        for u in value.unicodeScalars {
            if n >= max { break }
            out.append(u)
            n += 1
        }
        return String(out)
    }
}
