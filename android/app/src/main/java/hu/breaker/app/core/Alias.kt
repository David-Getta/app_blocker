package hu.breaker.app.core

/**
 * Fedőnév a blokkolt oldalakhoz — a `desktop/src/shared/alias.ts` tükre.
 *
 * A lista MAGA is ingerforrás. Aki megnyitja az appot, és ott áll előtte a
 * `youtube.com`, az már fél lépéssel közelebb van ahhoz, hogy feloldja — a név
 * felidézi, mi van a másik oldalon. Ezért lehet minden oldalnak saját fedőnevet
 * adni; olyat, ami neki jelent valamit, de nem hív.
 *
 * A valódi cím ettől nem tűnik el: egy gombbal RÖVID IDŐRE előhívható, mert
 * néha tényleg tudni kell, melyik sor melyik. Csak épp nem ül ott állandóan.
 *
 * Ez nem biztonsági határ, és nem is akar az lenni: a blokk maga a VPN-ben és a
 * mentett állapotban ott van, bárki megnézheti. Inger-eltávolítás, nem
 * titkosítás — a felület szövege is így mondja, hogy senki ne higgye másnak.
 */
object AliasLogic {

    /** Ennél hosszabb fedőnevet nem tárolunk (a soron sem férne el). */
    const val MAX_ALIAS_LENGTH = 40
    /** Az indok (miért tiltottad) hossza — egy mondat, ami a soron és a tiltó lapon elfér. */
    const val MAX_REASON_LENGTH = 140

    /** Ennyi ideig látszik a valódi cím, ha a felhasználó előhívja. */
    const val REVEAL_MS = 6_000L

    /**
     * Használható fedőnév, vagy null („nincs fedőnév”).
     *
     * A vezérlőkaraktereket kiszedjük: azok a soron láthatatlanok maradnának, de
     * a hosszkorlátba beleszámítanának, és a mentett állapotban is ott ülnének.
     */
    fun normalize(value: String?): String? = normalizeTo(value, MAX_ALIAS_LENGTH)

    /** Az indok tiszta alakja — ugyanaz a tisztítás, mint a fedőnévé, hosszabb plafonnal. */
    fun normalizeReason(value: String?): String? = normalizeTo(value, MAX_REASON_LENGTH)

    private fun normalizeTo(value: String?, max: Int): String? {
        if (value == null) return null
        // A szóköz a kimondott készlet (TextLogic.SPACES), nem a Java regex
        // `\s`-e: az csak ASCII, és a nem törő szóköz belül maradt volna.
        val collapsed = TextLogic.collapseSpaces(value)
        if (collapsed.isEmpty()) return null
        // KÓDPONTBAN vágunk: a `take` egy emodzsit félbe vágott volna. A vágás
        // szóköz elé eshet; a maradék végén ne maradjon lógó szóköz.
        return TextLogic.trimSpaces(TextLogic.takeCodePoints(collapsed, max))
    }

    /** Van-e elrejtve a valódi cím? */
    fun isAliased(site: Site): Boolean = normalize(site.alias) != null

    /**
     * A FEDŐNÉV LEVÉTELE-e a változás: volt fedőnév, és a következő érték már nem az.
     * A levétel FELFED, ezért a felület a készülék azonosítását kéri hozzá; az
     * átnevezés nem fed fel. Egy helyen — a `shared/alias.ts` tükre.
     */
    fun isRemoval(current: String?, next: String?): Boolean =
        normalize(current) != null && normalize(next) == null

    /**
     * Amit a felületen KI SZABAD írni.
     *
     * Minden megjelenítés ezen megy át — a soron, a párbeszédek címében, a
     * próbatétel-képernyőn és a statisztikában is. Ha bárhol kimaradna, a
     * fedőnév értelmét vesztené: elég egyetlen hely, ahol ott a valódi cím.
     */
    fun displayName(site: Site): String = normalize(site.alias) ?: site.domain

    /**
     * Amit MOST kell kiírni, figyelembe véve az ideiglenes felfedést.
     *
     * @param revealedUntil mikorig látszik a valódi cím (ms), vagy null
     */
    fun displayNameNow(site: Site, now: Long, revealedUntil: Long?): String {
        if (revealedUntil != null && now < revealedUntil) return site.domain
        return displayName(site)
    }

    /**
     * Amit rejtett listánál a STATISZTIKÁBAN szabad kiírni egy blokkolt oldalról.
     *
     * A sorszám a lista sorrendjéből jön, tehát két frissítés között nem ugrál,
     * és ugyanazt az oldalt mindig ugyanaz a szám jelöli. Fedőnév esetén a
     * fedőnév erősebb: azt épp azért adta meg, hogy AZ látszódjon.
     */
    fun maskedLabel(site: Site, index: Int): String =
        normalize(site.alias) ?: "${index + 1}. rejtett oldal"

}
