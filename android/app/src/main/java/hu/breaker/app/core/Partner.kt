package hu.breaker.app.core

import java.security.MessageDigest
import java.security.SecureRandom
import java.text.Normalizer
import java.util.Base64

/**
 * PÁRBAN ZÁROLÁS: a lazítás végén egy MEGBÍZOTT jelmondata is kell — a
 * `desktop/src/shared/partner.ts` (és a segéd `partner-crypto.ts`) tükre.
 *
 * A próbatétel a saját impulzusod ellen véd; van, akinek az kell, hogy a
 * lazítás MÁS EMBER döntése is legyen. A megbízott egy jelmondatot kap, és
 * minden lazító próbatétel utolsó lépése az, hogy ő beírja. Felvenni ingyen
 * (szigorítás), levenni próbatétel — a végén az ő jelmondatával. A jelmondat
 * egy eszközön születik, és csak a lenyomata (scrypt, a fiók kulcsáé) marad
 * meg; a lenyomat nyelvfüggetlen, tehát a gépen felvett megbízott a telefonon
 * is stimmel — a `fixtures/partner-hash.json` ezt őrzi.
 *
 * Őszinte határ: nem gépzár — az impulzus ellen véd, nem a szándék ellen.
 */
object PartnerLogic {

    /** A jelmondat szavainak száma — a próbatételek szólistájából. */
    const val PARTNER_PHRASE_WORDS = 4
    /** A megbízott nevének hossza felülről kötve. */
    const val MAX_PARTNER_NAME = 40
    /** Ennyi rossz jelmondat után a kísérlet érvénytelen: elölről, minden lépéssel. */
    const val MAX_PARTNER_TRIES = 5

    private const val HASH_LEN = 32
    private const val SALT_LEN = 16
    private val random = SecureRandom()
    private val B64 = Regex("^[A-Za-z0-9+/=]+$")

    data class PartnerLock(
        /** a megbízott neve, ahogy a felület mondja */
        val name: String,
        /** a lenyomat sója, base64 */
        val salt: String,
        /** a jelmondat scrypt-lenyomata, base64 — a jelmondat maga sehol nincs */
        val hash: String,
        /** mikor vették fel */
        val setAt: Long,
    )

    /**
     * NFKC, a vezérlők szóközre, a szóközök egyre, a szélek le. A szóköz a
     * kimondott készlet (TextLogic.SPACES), nem a Java regex `\s`-e: az csak
     * ASCII, és a jelmondatba került nem törő szóköz a gépen szóköz lett
     * volna, itt nem — a lenyomat nem egyezett volna.
     */
    private fun clean(raw: String): String =
        TextLogic.collapseSpaces(Normalizer.normalize(raw, Normalizer.Form.NFKC))

    /**
     * A jelmondat KANONIKUS alakja — ezt hasoljuk, és ezt hasonlítjuk.
     * Kis-nagybetű, dupla szóköz nem számít; NFKC, hogy ugyanaz a leütött
     * szöveg ugyanaz a bájtsor legyen minden platformon.
     */
    fun normalizePhrase(raw: String): String = clean(raw).lowercase()

    /** A megbízott neve tisztán — vagy null, ha nem maradt belőle semmi. */
    fun normalizePartnerName(raw: String?): String? {
        if (raw == null) return null
        val cleaned = clean(raw)
        if (cleaned.isEmpty()) return null
        // Kódpontban vágva, a lógó szóköz nélkül — mint a gépen.
        return TextLogic.trimSpaces(TextLogic.takeCodePoints(cleaned, MAX_PARTNER_NAME))
    }

    /** A tárból vagy a szinkronból jött rekord, ha jó alakú — különben semmi. */
    fun normalizeLock(name: String?, salt: String?, hash: String?, setAt: Long?): PartnerLock? {
        val n = normalizePartnerName(name) ?: return null
        if (salt == null || salt.length !in 16..64 || !B64.matches(salt)) return null
        if (hash == null || hash.length !in 32..96 || !B64.matches(hash)) return null
        return PartnerLock(n, salt, hash, setAt ?: 0L)
    }

    /** A rekord tartalmi kulcsa a lenyomatokhoz és az összevetéshez. */
    fun partnerKey(p: PartnerLock?): String =
        if (p == null) "" else listOf(p.salt, p.hash, p.name, p.setAt.toString()).joinToString("|")

    /** Ennél több élő megbízott nem lehet egyszerre — a `partner.ts` `MAX_PARTNERS`-e. */
    const val MAX_PARTNERS = 8
    /** Ennyi levett megbízott nyomát hordozzuk — a legutóbb levettekét. */
    const val MAX_PARTNERS_GONE = 32

    private val GONE_ID = Regex("^[A-Za-z0-9+/=]{16,64}\\|[A-Za-z0-9+/=]{32,96}$")

    /** A megbízott AZONOSSÁGA: a só és a lenyomat — minden felvételnél új. */
    fun partnerId(p: PartnerLock): String = "${p.salt}|${p.hash}"

    /** Jó alakú-e egy levett megbízott azonossága (só|lenyomat). */
    fun isGoneId(id: String): Boolean = GONE_ID.matches(id)

    /** Egy levett megbízott nyoma: az azonossága, és mikor vették le (csak a plafon sorrendjéhez). */
    data class PartnerGone(val id: String, val at: Long)

    /** A megbízottak egy eszközön: a FŐ (a legkorábban felvett), a TÁRSAK, és a levettek nyoma. */
    data class PartnerSet(
        val partner: PartnerLock? = null,
        val partnerCo: List<PartnerLock> = emptyList(),
        val partnersGone: List<PartnerGone> = emptyList(),
    )

    /** Az összes élő megbízott: a fő, aztán a társak. */
    fun livePartners(s: PartnerSet): List<PartnerLock> = listOfNotNull(s.partner) + s.partnerCo

    /**
     * A levett megbízottak nyoma tisztán: jó alakú azonosság, egyszer (a később
     * levett időpontjával), a legutóbb levettek elöl, a plafonig — a gép
     * `cleanPartnersGone`-ja.
     */
    fun cleanPartnersGone(raw: List<PartnerGone>): List<PartnerGone> {
        val at = LinkedHashMap<String, Long>()
        for (g in raw) {
            if (!GONE_ID.matches(g.id)) continue
            at[g.id] = maxOf(at[g.id] ?: 0L, maxOf(0L, g.at))
        }
        return at.entries.map { PartnerGone(it.key, it.value) }
            .sortedWith(compareByDescending<PartnerGone> { it.at }.thenBy { it.id })
            .take(MAX_PARTNERS_GONE)
    }

    /**
     * A megbízottak fésülése — AZONOSSÁG szerint, nem jel szerint; a gép
     * `mergePartners`-ének tükre. Élő megbízottat csak a NYOMA visz el (az pedig
     * csak a levétel próbatételéből születik, aminek a végén az ő jelmondata
     * állt); két különböző élő megbízott közül egyik sem esik ki: a legkorábban
     * felvett a fő, a többi TÁRS, és a lazítás végén mindegyik jelmondata kell.
     * Eddig a nagyobb jel nyert — és egy friss eszközön, felhúzott jellel
     * felvett saját megbízott minden eszközön leváltotta a valódit.
     */
    fun mergePartners(a: PartnerSet, b: PartnerSet): PartnerSet {
        val both = a.partnersGone + b.partnersGone
        val allGone = cleanPartnersGone(both)
        // A nyom a plafon ELŐTT öl: ami ebben a fésülésben levett, az nem él.
        val dead = both.filter { GONE_ID.matches(it.id) }.map { it.id }.toHashSet()
        val byId = LinkedHashMap<String, PartnerLock>()
        for (p in livePartners(a) + livePartners(b)) {
            val id = partnerId(p)
            if (id in dead) continue
            val had = byId[id]
            if (had == null || partnerKey(p) < partnerKey(had)) byId[id] = p
        }
        val live = byId.values
            .sortedWith(compareBy<PartnerLock> { it.setAt }.thenBy { partnerId(it) })
            .take(MAX_PARTNERS)
        return PartnerSet(live.firstOrNull(), live.drop(1), allGone)
    }

    /**
     * A megbízottak a levétel után: akiknek a jelmondata ebben a próbatételben
     * elhangzott (`ids`), azok nyomot kapnak és kiesnek; aki közben érkezett,
     * és nem bólintott, marad.
     */
    fun removePartners(s: PartnerSet, ids: List<String>, at: Long): PartnerSet =
        mergePartners(s.copy(partnersGone = s.partnersGone + ids.map { PartnerGone(it, maxOf(0L, at)) }), PartnerSet())

    /**
     * A megbízottak tartalmi kulcsa. Társ és nyom nélkül PONTOSAN a régi
     * (`partnerKey`): a frissítés után a lenyomat nem változik.
     */
    fun partnersKey(s: PartnerSet): String {
        if (s.partnerCo.isEmpty() && s.partnersGone.isEmpty()) return partnerKey(s.partner)
        return (listOf(partnerKey(s.partner)) + s.partnerCo.map { partnerKey(it) }).joinToString(";") +
            "#" + s.partnersGone.joinToString(";") { "${it.id}@${it.at}" }
    }

    /** A jelmondat lenyomata egy adott sóval — base64; ugyanaz az scrypt, mint a fiók kulcsáé. */
    fun hashPhrase(phrase: String, saltB64: String): String {
        val out = Scrypt.scrypt(
            normalizePhrase(phrase).toByteArray(Charsets.UTF_8),
            Base64.getDecoder().decode(saltB64),
            SyncCrypto.SCRYPT_N, SyncCrypto.SCRYPT_R, SyncCrypto.SCRYPT_P, HASH_LEN,
        )
        return Base64.getEncoder().encodeToString(out)
    }

    /** Új megbízott: friss só, a jelmondat lenyomata — a jelmondat maga nem marad meg. */
    fun makeLock(name: String, phrase: String, now: Long): PartnerLock {
        val salt = ByteArray(SALT_LEN).also { random.nextBytes(it) }
        val saltB64 = Base64.getEncoder().encodeToString(salt)
        return PartnerLock(name, saltB64, hashPhrase(phrase, saltB64), now)
    }

    /** Ez-e a jelmondat — állandó idejű összevetéssel. */
    fun verify(lock: PartnerLock, phrase: String): Boolean {
        if (normalizePhrase(phrase).isEmpty()) return false
        val got = runCatching { Base64.getDecoder().decode(hashPhrase(phrase, lock.salt)) }.getOrNull() ?: return false
        val want = runCatching { Base64.getDecoder().decode(lock.hash) }.getOrNull() ?: return false
        return MessageDigest.isEqual(got, want)
    }
}
