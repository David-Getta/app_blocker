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

    /// Kódegység (UTF-16) szerinti sorrend — a gép (`<` a JS-ben) és az Android
    /// (`String.compareTo`) rendje. A Swift `<` a kanonikus alakot hasonlítja.
    static func utf16Less(_ a: String, _ b: String) -> Bool {
        a.utf16.lexicographicallyPrecedes(b.utf16)
    }

    /// Egyezés KÓDPONTRA — a Swift `==` a kanonikusan egyenértékű alakokat
    /// (NFC „é” és NFD „e + ékezet”) egynek veszi, a gép és az Android nem.
    static func sameScalars(_ a: String, _ b: String) -> Bool {
        a.unicodeScalars.elementsEqual(b.unicodeScalars)
    }

    /// Részszöveg-e KÓDEGYSÉGRE — a JS `includes` és a Kotlin `contains` tükre.
    /// A Swift `contains` grafémában keres, kanonikus egyenértékűséggel: az
    /// „e + ékezet”-ben nem találja az „e”-t, a gép igen. Az üres részszöveg
    /// mindenben benne van, mint a JS-ben.
    static func utf16Contains(_ haystack: String, _ needle: String) -> Bool {
        let h = Array(haystack.utf16), n = Array(needle.utf16)
        if n.isEmpty { return true }
        if n.count > h.count { return false }
        for i in 0...(h.count - n.count) where h[i] == n[0] {
            if h[i..<(i + n.count)].elementsEqual(n) { return true }
        }
        return false
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

    /// Kisbetű a gép (JS) és az Android (Java) szabálya szerint. A Swift
    /// `lowercased()` a görög nagy szigmát (Σ) mindig σ-ra írja; a JS és a Java
    /// a szó végén ς-t ad (Unicode Final_Sigma: előtte cased betű áll, utána nem
    /// — a case-ignorable jeleket átlépve). Egy görög kulcsszó vagy jelmondat
    /// így a telefonon más bájtsor lett volna, mint a gépen — a fixtúra fogta ki.
    static func lowercase(_ value: String) -> String {
        let scalars = Array(value.unicodeScalars)
        guard scalars.contains(where: { $0.value == 0x03A3 }) else { return value.lowercased() }
        // A szabály CSAK a nagy Σ-ra szól, és az EREDETI szöveg szomszédain
        // dől el: a már kisbetűs σ a szó végén is σ marad — a gép és a Java így
        // teszi. (Az első változat a kisbetűsítés UTÁN cserélt minden szó végi
        // σ-t, és a kisbetűs bemenetet is átírta; a fixtúra fogta ki.)
        var pre = String.UnicodeScalarView()
        for (i, u) in scalars.enumerated() {
            pre.append(u.value == 0x03A3 ? (isFinalSigma(scalars, at: i) ? finalSigma : smallSigma) : u)
        }
        return String(pre).lowercased()
    }

    private static let finalSigma = Unicode.Scalar(UInt32(0x03C2))!
    private static let smallSigma = Unicode.Scalar(UInt32(0x03C3))!

    /// Final_Sigma: előtte (case-ignorable jeleken át) cased betű áll, utána (ugyanúgy) nem.
    private static func isFinalSigma(_ s: [Unicode.Scalar], at i: Int) -> Bool {
        var j = i - 1
        while j >= 0, s[j].properties.isCaseIgnorable { j -= 1 }
        guard j >= 0, s[j].properties.isCased else { return false }
        var k = i + 1
        while k < s.count, s[k].properties.isCaseIgnorable { k += 1 }
        return !(k < s.count && s[k].properties.isCased)
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
