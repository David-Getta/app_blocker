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

    /** C0, DEL és C1 — ugyanaz a tartomány, mint a fedőnévnél. */
    private fun isControl(ch: Char): Boolean = ch.code < 0x20 || (ch.code in 0x7f..0x9f)

    private fun clean(raw: String): String =
        Normalizer.normalize(raw, Normalizer.Form.NFKC)
            .map { if (isControl(it)) ' ' else it }.joinToString("")
            .trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")

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
        val cps = cleaned.codePoints().toArray()
        return if (cps.size <= MAX_PARTNER_NAME) cleaned
        else String(cps, 0, MAX_PARTNER_NAME)
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

    /**
     * Fésülés — a zárlat-ablakok mintája: nagyobb jel nyer; azonos jelnél a
     * BEÁLLÍTOTT (a szigorúbb irány); ha mindkét oldalon van, a korábban
     * felvett — az a régebbi ígéret.
     */
    fun merge(localRev: Int, local: PartnerLock?, incomingRev: Int, incoming: PartnerLock?): PartnerLock? {
        if (incomingRev > localRev) return incoming
        if (localRev > incomingRev) return local
        if (local != null && incoming != null) return if (local.setAt <= incoming.setAt) local else incoming
        return local ?: incoming
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
