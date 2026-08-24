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

    /** Ennyi ideig látszik a valódi cím, ha a felhasználó előhívja. */
    const val REVEAL_MS = 6_000L

    /**
     * Használható fedőnév, vagy null („nincs fedőnév”).
     *
     * A vezérlőkaraktereket kiszedjük: azok a soron láthatatlanok maradnának, de
     * a hosszkorlátba beleszámítanának, és a mentett állapotban is ott ülnének.
     */
    fun normalize(value: String?): String? {
        if (value == null) return null
        val sb = StringBuilder(value.length)
        for (ch in value) sb.append(if (isControl(ch)) ' ' else ch)
        val collapsed = sb.toString().replace(WHITESPACE, " ").trim()
        if (collapsed.isEmpty()) return null
        return collapsed.take(MAX_ALIAS_LENGTH).trim()
    }

    /** Van-e elrejtve a valódi cím? */
    fun isAliased(site: Site): Boolean = normalize(site.alias) != null

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

    /** C0, DEL és C1 — ugyanaz a tartomány, mint a TS `CONTROL_CHARS`. */
    private fun isControl(ch: Char): Boolean =
        ch.code < 0x20 || (ch.code in 0x7f..0x9f)

    private val WHITESPACE = Regex("\\s+")
}
