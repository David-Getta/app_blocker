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
    /// Az indok (miért tiltottad) hossza — egy mondat, ami a soron és a tiltó lapon elfér.
    static let maxReasonLength = 140

    /// Ennyi ideig látszik a valódi cím, ha a felhasználó előhívja (ms).
    static let revealMs: Double = 6_000

    /// Használható fedőnév, vagy nil („nincs fedőnév”).
    ///
    /// A vezérlőkaraktereket kiszedjük: azok a soron láthatatlanok maradnának,
    /// de a hosszkorlátba beleszámítanának, és a mentett állapotban is ott
    /// ülnének.
    static func normalize(_ value: String?) -> String? { normalizeTo(value, maxAliasLength) }

    /// Az indok tiszta alakja — ugyanaz a tisztítás, mint a fedőnévé, hosszabb plafonnal.
    static func normalizeReason(_ value: String?) -> String? { normalizeTo(value, maxReasonLength) }

    private static func normalizeTo(_ value: String?, _ max: Int) -> String? {
        guard let value else { return nil }
        // A szóköz a kimondott készlet (TextLogic), nem a Swift `isWhitespace`-e:
        // az a BOM-ot nem ismeri, a gép igen — és skalár szinten, hogy egy
        // vezérlő a rá tapadó ékezettel együtt se maradjon benne.
        let collapsed = TextLogic.collapseSpaces(value)
        if collapsed.isEmpty { return nil }
        // SKALÁRBAN vágunk, nem grafémában: a `prefix` egy zászlót egynek
        // számolt, a gép kettőnek. A vágás szóköz elé eshet; a maradék végén
        // ne maradjon lógó szóköz.
        return TextLogic.trimSpaces(TextLogic.takeScalars(collapsed, max))
    }

    /// Van-e elrejtve a valódi cím?
    static func isAliased(_ site: Site) -> Bool {
        normalize(site.alias) != nil
    }

    /// A FEDŐNÉV LEVÉTELE-e a változás: volt fedőnév, és a következő érték már nem az.
    /// A levétel FELFED, ezért a felület a készülék azonosítását kéri hozzá; az
    /// átnevezés nem fed fel. Egy helyen — a `shared/alias.ts` tükre.
    static func isRemoval(_ current: String?, _ next: String?) -> Bool {
        normalize(current) != nil && normalize(next) == nil
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
}
