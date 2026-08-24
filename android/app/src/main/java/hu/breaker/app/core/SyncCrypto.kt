package hu.breaker.app.core

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Végpontok közti titkosítás a szinkronhoz — a
 * `desktop/src/shared/sync/crypto.ts` tükre.
 *
 * Az app ígérete az, hogy amit mér és amit blokkolsz, az a tiéd marad. A
 * szinkron ezt csak úgy tarthatja meg, ha a kiszolgáló NEM TUDJA ELOLVASNI, amit
 * tárol.
 *
 *   jelszó ──scrypt(só = fiókazonosító)──> gyökér
 *                                            ├── HKDF("auth") ─> belépőkulcs ─> a kiszolgálóra megy
 *                                            └── HKDF("kek") ──> kulcsburkoló ─> ezzel van becsomagolva az ADATKULCS
 *
 * Minden bájtnak pontosan egyeznie kell a TypeScript változattal: ha eltér, a
 * telefonon nem lehet belépni abba a fiókba, amit a gépen hoztak létre. A
 * tesztek ezért nem csak „működik-e” kérdésre felelnek, hanem a Node által
 * gyártott valódi burkolatokat bontják ki.
 */
object SyncCrypto {

    const val BLOB_PREFIX = "brk1"

    /** scrypt-paraméterek — ugyanazok, mint a TS oldalon. */
    const val SCRYPT_N = 1 shl 15
    const val SCRYPT_R = 8
    const val SCRYPT_P = 1

    private const val KEY_LEN = 32
    private const val IV_LEN = 12
    private const val TAG_BITS = 128

    private val random = SecureRandom()

    /** A jelszóból származó gyökér. A só a fiókazonosító, hogy két fiók ne essen egybe. */
    fun rootKey(password: String, accountId: String): ByteArray {
        require(password.isNotEmpty()) { "Üres jelszóból nem származtatunk kulcsot." }
        // NFKC: ugyanaz a leütött szöveg ugyanaz a bájtsor legyen minden
        // platformon. Ékezetes jelszónál ez nem elmélet — a macOS és az Android
        // billentyűzete más alakban adhatja ugyanazt a betűt.
        val normalized = java.text.Normalizer.normalize(password, java.text.Normalizer.Form.NFKC)
        return Scrypt.scrypt(
            normalized.toByteArray(Charsets.UTF_8),
            "breaker:$accountId".toByteArray(Charsets.UTF_8),
            SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LEN,
        )
    }

    /** Egy gyökérből több, egymástól független alkulcs (HKDF-SHA256). */
    fun subKey(root: ByteArray, label: String): ByteArray =
        hkdf(root, ByteArray(0), "breaker-$label-v1".toByteArray(Charsets.UTF_8), KEY_LEN)

    /** Amit a kiszolgálónak küldünk. Nem a jelszó, és nem is az adatkulcs. */
    fun authKey(password: String, accountId: String): String =
        b64(subKey(rootKey(password, accountId), "auth"))

    /** Belépőkulcs a helyreállító kódból — külön ág, hogy elfelejtett jelszóval is legyen út. */
    fun recoveryAuthKey(code: String): String =
        b64(subKey(normalizedRecovery(code), "recovery-auth"))

    /** Kulcsburkoló a helyreállító kódból. */
    fun recoveryKey(code: String): ByteArray = subKey(normalizedRecovery(code), "recovery")

    private fun normalizedRecovery(code: String): ByteArray {
        val norm = normalizeRecoveryCode(code)
        require(norm.length >= 16) { "A helyreállító kód túl rövid." }
        return norm.toByteArray(Charsets.UTF_8)
    }

    /** A kód beírásakor a kötőjelek és a kis-nagybetű ne számítson. */
    fun normalizeRecoveryCode(code: String): String =
        code.uppercase().filter { it in '0'..'9' || it in 'A'..'Z' }
            .replace('O', '0').replace('I', '1').replace('L', '1')

    // ------------------------------------------------------------ titkosítás

    /**
     * AES-256-GCM. A kimenet: `brk1.<iv>.<tag>.<titkos>` base64url darabokból.
     *
     * Minden híváshoz FRISS véletlen IV: GCM-nél egy IV újrahasználata ugyanazzal
     * a kulccsal nem „gyengébb titkosítás”, hanem a kulcs eldobása.
     */
    fun encrypt(key: ByteArray, plaintext: String): String {
        val iv = ByteArray(IV_LEN).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
        val out = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        // A JCE a címkét a titkos szöveg VÉGÉRE fűzi; a formátumunk külön tartja,
        // mert a TS oldal is úgy adja.
        val ctLen = out.size - TAG_BITS / 8
        val ct = out.copyOfRange(0, ctLen)
        val tag = out.copyOfRange(ctLen, out.size)
        return listOf(BLOB_PREFIX, b64url(iv), b64url(tag), b64url(ct)).joinToString(".")
    }

    /**
     * Visszafejtés. Hibás kulcsnál, csonka vagy MEGHAMISÍTOTT bloboknál dob.
     *
     * A GCM-címke ellenőrzése nem opcionális: enélkül a kiszolgáló (vagy aki a
     * helyére áll) bitenként babrálhatna a blokklistán úgy, hogy észre se vesszük.
     */
    fun decrypt(key: ByteArray, blob: String): String {
        val parts = blob.split(".")
        require(parts.size == 4 && parts[0] == BLOB_PREFIX) { "Ismeretlen formátumú titkosított adat." }
        val iv = unb64url(parts[1])
        val tag = unb64url(parts[2])
        val ct = unb64url(parts[3])
        require(iv.size == IV_LEN && tag.size == TAG_BITS / 8) { "Sérült titkosított adat." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
        return String(cipher.doFinal(ct + tag), Charsets.UTF_8)
    }

    fun wrapDataKey(kek: ByteArray, dataKey: ByteArray): String = encrypt(kek, b64(dataKey))

    fun unwrapDataKey(kek: ByteArray, wrapped: String): ByteArray {
        val raw = unb64(decrypt(kek, wrapped))
        require(raw.size == KEY_LEN) { "A kicsomagolt kulcs mérete hibás." }
        return raw
    }

    /** Belépés: a kiszolgálótól kapott burkolt kulcs kibontása a jelszóval. */
    fun unlockWithPassword(accountId: String, password: String, wrapped: String): ByteArray =
        unwrapDataKey(subKey(rootKey(password, accountId), "kek"), wrapped)

    /** Belépés helyreállító kóddal, ha a jelszó elveszett. */
    fun unlockWithRecovery(code: String, wrapped: String): ByteArray =
        unwrapDataKey(recoveryKey(code), wrapped)

    // ------------------------------------------------------------------ HKDF

    private fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val prk = hmac(if (salt.isEmpty()) ByteArray(32) else salt, ikm)
        val out = ByteArray(length)
        var t = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            t = hmac(prk, t + info + byteArrayOf(counter.toByte()))
            val take = minOf(t.size, length - offset)
            System.arraycopy(t, 0, out, offset, take)
            offset += take
            counter++
        }
        return out
    }

    /** HMAC-SHA256 kézzel — ugyanaz az ok, mint a Scryptben: az üres kulcs is szabályos. */
    private fun hmac(key: ByteArray, message: ByteArray): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        val blockSize = 64
        var k = if (key.size > blockSize) md.digest(key) else key
        if (k.size < blockSize) k = k.copyOf(blockSize)
        val inner = ByteArray(blockSize) { (k[it].toInt() xor 0x36).toByte() }
        val outer = ByteArray(blockSize) { (k[it].toInt() xor 0x5c).toByte() }
        md.reset(); md.update(inner); md.update(message)
        val innerHash = md.digest()
        md.reset(); md.update(outer); md.update(innerHash)
        return md.digest()
    }

    // -------------------------------------------------------------- base64
    //
    // Kézzel, mert az `android.util.Base64` nem érhető el a JVM-teszteken, a
    // `java.util.Base64` pedig csak API 26-tól van meg — a mag viszont minden
    // támogatott verzión ugyanazt kell adja.

    private const val STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    private const val URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    fun b64(data: ByteArray): String = encodeBase64(data, STD, pad = true)
    fun unb64(text: String): ByteArray = decodeBase64(text)
    private fun b64url(data: ByteArray): String = encodeBase64(data, URL, pad = false)
    private fun unb64url(text: String): ByteArray = decodeBase64(text)

    private fun encodeBase64(data: ByteArray, alphabet: String, pad: Boolean): String {
        val sb = StringBuilder((data.size + 2) / 3 * 4)
        var i = 0
        while (i < data.size) {
            val b0 = data[i].toInt() and 0xff
            val b1 = if (i + 1 < data.size) data[i + 1].toInt() and 0xff else 0
            val b2 = if (i + 2 < data.size) data[i + 2].toInt() and 0xff else 0
            sb.append(alphabet[b0 ushr 2])
            sb.append(alphabet[((b0 and 3) shl 4) or (b1 ushr 4)])
            if (i + 1 < data.size) sb.append(alphabet[((b1 and 15) shl 2) or (b2 ushr 6)])
            else if (pad) sb.append('=')
            if (i + 2 < data.size) sb.append(alphabet[b2 and 63])
            else if (pad) sb.append('=')
            i += 3
        }
        return sb.toString()
    }

    private fun decodeBase64(text: String): ByteArray {
        val clean = text.filter { it != '=' && !it.isWhitespace() }
        val out = java.io.ByteArrayOutputStream(clean.length * 3 / 4 + 3)
        var acc = 0
        var bits = 0
        for (ch in clean) {
            val v = when (ch) {
                in 'A'..'Z' -> ch - 'A'
                in 'a'..'z' -> ch - 'a' + 26
                in '0'..'9' -> ch - '0' + 52
                '+', '-' -> 62
                '/', '_' -> 63
                else -> throw IllegalArgumentException("hibás base64 jel: $ch")
            }
            acc = (acc shl 6) or v
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write((acc ushr bits) and 0xff)
            }
        }
        return out.toByteArray()
    }
}
