package hu.breaker.app.core

import java.security.MessageDigest

/**
 * scrypt (RFC 7914) — tiszta Kotlinban.
 *
 * Miért nem könyvtárból: a JDK-ban és az Android platform API-jában NINCS
 * scrypt. Ami elérhető volna, az vagy egy külső natív függőség (a telepítő
 * méretét és a build bonyolultságát növelné), vagy a platform rejtett
 * Bouncy Castle példánya, ami nem publikus API — egy Android-frissítés bármikor
 * kihúzhatja alóla a talajt.
 *
 * A jelszóból származó kulcsnak viszont PONTOSAN ugyanannak kell kijönnie
 * telefonon és gépen: ha eltér, a másik eszközön nem lehet belépni ugyanabba a
 * fiókba. Ezért van itt saját, az RFC vektoraival ÉS a Node kimenetével is
 * összevetett megvalósítás.
 *
 * A memóriakötöttség a lényeg: a `V` tömb N * 128 * r bájt (a mi
 * paramétereinkkel 32 MB). Ez teszi drágává a jelszó tömeges kitalálását annak,
 * aki a kiszolgálóra betört — pont ezért nem cseréljük valami olcsóbbra.
 */
object Scrypt {

    /**
     * @param password a jelszó bájtjai
     * @param salt a só
     * @param n CPU/memória költség; kettőhatvány
     * @param r blokkméret-tényező
     * @param p párhuzamosság
     * @param dkLen a kért kulcs hossza bájtban
     */
    fun scrypt(password: ByteArray, salt: ByteArray, n: Int, r: Int, p: Int, dkLen: Int): ByteArray {
        require(n > 1 && (n and (n - 1)) == 0) { "N kettőhatvány és 1-nél nagyobb kell legyen" }
        require(r >= 1 && p >= 1) { "r és p legalább 1" }
        require(dkLen > 0) { "a kért kulcshossz pozitív" }

        val blockLen = 128 * r
        val b = pbkdf2Sha256(password, salt, 1, p * blockLen)
        val v = IntArray(n * 32 * r)
        val xy = IntArray(64 * r)
        val words = IntArray(32 * r)

        for (i in 0 until p) {
            bytesToWords(b, i * blockLen, words, 32 * r)
            roMix(words, v, xy, n, r)
            wordsToBytes(words, b, i * blockLen, 32 * r)
        }
        return pbkdf2Sha256(password, b, 1, dkLen)
    }

    // ------------------------------------------------------------- ROMix

    private fun roMix(x: IntArray, v: IntArray, xy: IntArray, n: Int, r: Int) {
        val len = 32 * r
        for (i in 0 until n) {
            System.arraycopy(x, 0, v, i * len, len)
            blockMix(x, xy, r)
        }
        for (i in 0 until n) {
            // Integerify: az UTOLSÓ 64 bájtos blokk első szava, little-endian.
            val j = (x[len - 16] and (n - 1))
            for (k in 0 until len) x[k] = x[k] xor v[j * len + k]
            blockMix(x, xy, r)
        }
    }

    private fun blockMix(b: IntArray, y: IntArray, r: Int) {
        val x = IntArray(16)
        System.arraycopy(b, (2 * r - 1) * 16, x, 0, 16)
        for (i in 0 until 2 * r) {
            for (k in 0 until 16) x[k] = x[k] xor b[i * 16 + k]
            salsa20_8(x)
            System.arraycopy(x, 0, y, i * 16, 16)
        }
        // Az eredmény sorrendje: Y0, Y2, …, Y1, Y3, …
        for (i in 0 until r) {
            System.arraycopy(y, (i * 2) * 16, b, i * 16, 16)
            System.arraycopy(y, (i * 2 + 1) * 16, b, (i + r) * 16, 16)
        }
    }

    private fun salsa20_8(block: IntArray) {
        val x = IntArray(16)
        System.arraycopy(block, 0, x, 0, 16)
        var i = 0
        while (i < 8) {
            // oszlopkör
            x[4] = x[4] xor rotl(x[0] + x[12], 7)
            x[8] = x[8] xor rotl(x[4] + x[0], 9)
            x[12] = x[12] xor rotl(x[8] + x[4], 13)
            x[0] = x[0] xor rotl(x[12] + x[8], 18)
            x[9] = x[9] xor rotl(x[5] + x[1], 7)
            x[13] = x[13] xor rotl(x[9] + x[5], 9)
            x[1] = x[1] xor rotl(x[13] + x[9], 13)
            x[5] = x[5] xor rotl(x[1] + x[13], 18)
            x[14] = x[14] xor rotl(x[10] + x[6], 7)
            x[2] = x[2] xor rotl(x[14] + x[10], 9)
            x[6] = x[6] xor rotl(x[2] + x[14], 13)
            x[10] = x[10] xor rotl(x[6] + x[2], 18)
            x[3] = x[3] xor rotl(x[15] + x[11], 7)
            x[7] = x[7] xor rotl(x[3] + x[15], 9)
            x[11] = x[11] xor rotl(x[7] + x[3], 13)
            x[15] = x[15] xor rotl(x[11] + x[7], 18)
            // sorkör
            x[1] = x[1] xor rotl(x[0] + x[3], 7)
            x[2] = x[2] xor rotl(x[1] + x[0], 9)
            x[3] = x[3] xor rotl(x[2] + x[1], 13)
            x[0] = x[0] xor rotl(x[3] + x[2], 18)
            x[6] = x[6] xor rotl(x[5] + x[4], 7)
            x[7] = x[7] xor rotl(x[6] + x[5], 9)
            x[4] = x[4] xor rotl(x[7] + x[6], 13)
            x[5] = x[5] xor rotl(x[4] + x[7], 18)
            x[11] = x[11] xor rotl(x[10] + x[9], 7)
            x[8] = x[8] xor rotl(x[11] + x[10], 9)
            x[9] = x[9] xor rotl(x[8] + x[11], 13)
            x[10] = x[10] xor rotl(x[9] + x[8], 18)
            x[12] = x[12] xor rotl(x[15] + x[14], 7)
            x[13] = x[13] xor rotl(x[12] + x[15], 9)
            x[14] = x[14] xor rotl(x[13] + x[12], 13)
            x[15] = x[15] xor rotl(x[14] + x[13], 18)
            i += 2
        }
        for (k in 0 until 16) block[k] += x[k]
    }

    private fun rotl(v: Int, n: Int): Int = (v shl n) or (v ushr (32 - n))

    // ------------------------------------------------------------ PBKDF2
    //
    // Kézzel, mert a platform `SecretKeyFactory`-ja a jelszót char-tömbként
    // kéri, és a saját szabályai szerint kódolja bájtokra. Nekünk NYERS bájtok
    // kellenek: a második hívásban a „jelszó” helyén a scrypt köztes állapota
    // áll, ami nem szöveg.

    private fun pbkdf2Sha256(password: ByteArray, salt: ByteArray, iterations: Int, dkLen: Int): ByteArray {
        val hLen = 32
        val out = ByteArray(dkLen)
        val blocks = (dkLen + hLen - 1) / hLen
        var offset = 0
        for (i in 1..blocks) {
            val idx = byteArrayOf(
                (i ushr 24).toByte(), (i ushr 16).toByte(), (i ushr 8).toByte(), i.toByte(),
            )
            var u = hmacSha256(password, salt + idx)
            val t = u.copyOf()
            for (j in 1 until iterations) {
                u = hmacSha256(password, u)
                for (k in t.indices) t[k] = (t[k].toInt() xor u[k].toInt()).toByte()
            }
            val take = minOf(hLen, dkLen - offset)
            System.arraycopy(t, 0, out, offset, take)
            offset += take
        }
        return out
    }

    /**
     * HMAC-SHA256 kézzel.
     *
     * Miért nem a `Mac` + `SecretKeySpec`: az ÜRES kulcsot kivétellel utasítja
     * el („Empty key”), holott a HMAC-nál az szabályos (nullákkal a blokkméretre
     * párnázva) — és az RFC 7914 első vektora pont ilyen. Ha a saját tesztünket
     * nem tudjuk lefuttatni, nincs mi bizonyítsa, hogy ez tényleg scrypt.
     */
    private fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        val blockSize = 64
        var k = if (key.size > blockSize) md.digest(key) else key
        if (k.size < blockSize) k = k.copyOf(blockSize)
        val inner = ByteArray(blockSize) { (k[it].toInt() xor 0x36).toByte() }
        val outer = ByteArray(blockSize) { (k[it].toInt() xor 0x5c).toByte() }
        md.reset()
        md.update(inner)
        md.update(message)
        val innerHash = md.digest()
        md.reset()
        md.update(outer)
        md.update(innerHash)
        return md.digest()
    }

    // ------------------------------------------------------------ bájt/szó

    private fun bytesToWords(src: ByteArray, srcOff: Int, dst: IntArray, count: Int) {
        for (i in 0 until count) {
            val o = srcOff + i * 4
            dst[i] = (src[o].toInt() and 0xff) or
                ((src[o + 1].toInt() and 0xff) shl 8) or
                ((src[o + 2].toInt() and 0xff) shl 16) or
                ((src[o + 3].toInt() and 0xff) shl 24)
        }
    }

    private fun wordsToBytes(src: IntArray, dst: ByteArray, dstOff: Int, count: Int) {
        for (i in 0 until count) {
            val v = src[i]
            val o = dstOff + i * 4
            dst[o] = v.toByte()
            dst[o + 1] = (v ushr 8).toByte()
            dst[o + 2] = (v ushr 16).toByte()
            dst[o + 3] = (v ushr 24).toByte()
        }
    }
}
