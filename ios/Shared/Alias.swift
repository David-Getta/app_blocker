import Foundation

/// Fedőnév a blokkolt oldalakhoz — a `desktop/src/shared/alias.ts` tükre.
///
/// A lista MAGA is ingerforrás. Aki megnyitja az appot, és ott áll előtte a
/// `youtube.com`, az már fél lépéssel közelebb van ahhoz, hogy feloldja — a név
/// felidézi, mi van a másik oldalon. Ezért lehet minden oldalnak saját fedőnevet
/// adni; olyat, ami neki jelent valamit, de nem hív.
///
/// A valódi cím ettől nem tűnik el: egy gombbal RÖVID IDŐRE előhívható, mert
/// néha tényleg tudni kell, melyik sor melyik. Csak épp nem ül ott állandóan.
///
/// Ez nem biztonsági határ, és nem is akar az lenni: a blokk maga az állapotban
/// ott van, bárki megnézheti. Inger-eltávolítás, nem titkosítás — a felület
/// szövege is így mondja, hogy senki ne higgye másnak.
enum AliasLogic {

    /// Ennél hosszabb fedőnevet nem tárolunk (a soron sem férne el).
    static let maxAliasLength = 40

    /// Ennyi ideig látszik a valódi cím, ha a felhasználó előhívja (ms).
    static let revealMs: Double = 6_000

    /// Használható fedőnév, vagy nil („nincs fedőnév”).
    ///
    /// A vezérlőkaraktereket kiszedjük: azok a soron láthatatlanok maradnának,
    /// de a hosszkorlátba beleszámítanának, és a mentett állapotban is ott
    /// ülnének.
    static func normalize(_ value: String?) -> String? {
        guard let value else { return nil }
        let withoutControls = String(value.map { isControl($0) ? " " : $0 })
        let collapsed = withoutControls
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        if collapsed.isEmpty { return nil }
        let cut = String(collapsed.prefix(maxAliasLength))
        let trimmed = cut.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Van-e elrejtve a valódi cím?
    static func isAliased(_ site: Site) -> Bool {
        normalize(site.alias) != nil
    }

    /// Amit a felületen KI SZABAD írni.
    ///
    /// Minden megjelenítés ezen megy át — a soron, a párbeszédek címében, a
    /// próbatétel-képernyőn és a statisztikában is. Ha bárhol kimaradna, a
    /// fedőnév értelmét vesztené: elég egyetlen hely, ahol ott a valódi cím.
    static func displayName(_ site: Site) -> String {
        normalize(site.alias) ?? site.domain
    }

    /// Amit MOST kell kiírni, figyelembe véve az ideiglenes felfedést.
    ///
    /// - Parameter revealedUntil: mikorig látszik a valódi cím (ms), vagy nil
    static func displayNameNow(_ site: Site, now: Double, revealedUntil: Double?) -> String {
        if let revealedUntil, now < revealedUntil { return site.domain }
        return displayName(site)
    }

    /// Amit rejtett listánál a STATISZTIKÁBAN szabad kiírni egy blokkolt oldalról.
    ///
    /// A sorszám a lista sorrendjéből jön, tehát két frissítés között nem ugrál,
    /// és ugyanazt az oldalt mindig ugyanaz a szám jelöli. Fedőnév esetén a
    /// fedőnév erősebb: azt épp azért adta meg, hogy AZ látszódjon.
    static func maskedLabel(_ site: Site, index: Int) -> String {
        normalize(site.alias) ?? "\(index + 1). rejtett oldal"
    }

    /// C0, DEL és C1 — ugyanaz a tartomány, mint a TS `CONTROL_CHARS`.
    private static func isControl(_ ch: Character) -> Bool {
        guard let scalar = ch.unicodeScalars.first, ch.unicodeScalars.count == 1 else { return false }
        return scalar.value < 0x20 || (scalar.value >= 0x7f && scalar.value <= 0x9f)
    }
}
