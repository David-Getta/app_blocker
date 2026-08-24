package hu.breaker.app.core

/**
 * Párosító kód — a `desktop/src/shared/sync/pairing.ts` tükre.
 *
 * MIÉRT LÉTEZIK. A szinkronhoz eddig be kellett gépelni egy címet, például
 * `http://192.168.1.10:8787`. Papíron egy sor, a gyakorlatban viszont az a
 * pont, ahol a funkció meghal: aki idáig eljut, ott feladja. Egy
 * önkontroll-app legfontosabb tulajdonsága, hogy tényleg használják — egy
 * technikailag tökéletes szinkron, amit senki nem kapcsol be, nulla értékű.
 *
 *   http://192.168.1.10:8787   ->   K2M4Q      (öt karakter)
 *
 * A rövidség nem trükk: a valóságban a címek nem véletlenszerűek. Otthoni
 * hálózaton szinte mindig 192.168.x.y vagy 10.x.y.z, a port pedig a miénk.
 * Ezt a néhány esetet külön jelöljük, és csak a ténylegesen változó biteket
 * írjuk le.
 *
 * Minden bitnek egyeznie kell a TypeScript változattal: ha eltér, a gépen
 * kiírt kód a telefonon nem nyílik ki — vagy ami rosszabb, MÁS címet ad.
 */
object Pairing {

    /**
     * Crockford base32: nincs benne I, L, O és U.
     *
     * Az I/1 és az O/0 kézzel másolva összekeverhető; a beolvasásnál ezek egy
     * helyre esnek, tehát az elgépelés nem hibaüzenet, hanem jó eredmény.
     */
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    /** A kiszolgáló alapértelmezett portja. Ha ez van, nem kerül a kódba. */
    const val DEFAULT_SYNC_PORT = 8787

    private const val MAX_CODE_CHARS = 12

    private fun push(bits: MutableList<Int>, value: Int, width: Int) {
        for (i in width - 1 downTo 0) bits.add((value ushr i) and 1)
    }

    private fun read(bits: List<Int>, at: Int, width: Int): Int {
        var out = 0
        for (i in 0 until width) out = out * 2 + (bits.getOrNull(at + i) ?: 0)
        return out
    }

    /**
     * Ötbites ellenőrző összeg (FNV-1a).
     *
     * Enélkül egy elgépelt karakterből MÁSIK, létező cím lenne, és a
     * felhasználó annyit látna, hogy „a kiszolgáló nem érhető el” — miközben a
     * hiba az, hogy egy betűt rontott el.
     */
    private fun checksum(bits: List<Int>): Int {
        var h = -0x7ee3623b // 0x811c9dc5
        for (b in bits) {
            h = h xor b
            h *= 0x01000193
        }
        return h and 31
    }

    private fun parseIPv4(host: String): List<Int>? {
        val parts = host.split(".")
        if (parts.size != 4) return null
        val out = ArrayList<Int>(4)
        for (p in parts) {
            if (p.isEmpty() || p.length > 3 || !p.all { it.isDigit() }) return null
            val n = p.toInt()
            if (n > 255) return null
            out.add(n)
        }
        return out
    }

    /** Cím -> párosító kód, vagy null (tartománynév és HTTPS nem kódolható). */
    fun encode(url: String): String? {
        val m = Regex("""^http://([0-9.]+)(?::(\d+))?/?$""", RegexOption.IGNORE_CASE)
            .find(url.trim()) ?: return null
        val ip = parseIPv4(m.groupValues[1]) ?: return null
        val portText = m.groupValues[2]
        val port = if (portText.isEmpty()) DEFAULT_SYNC_PORT else portText.toIntOrNull() ?: return null
        if (port < 1 || port > 65535) return null

        val bits = mutableListOf<Int>()
        val tag = when {
            ip[0] == 192 && ip[1] == 168 -> 0
            ip[0] == 10 -> 1
            ip[0] == 172 && ip[1] in 16..31 -> 2
            else -> 3
        }
        push(bits, tag, 2)
        push(bits, if (port == DEFAULT_SYNC_PORT) 0 else 1, 1)
        if (port != DEFAULT_SYNC_PORT) push(bits, port, 16)

        when (tag) {
            0 -> { push(bits, ip[2], 8); push(bits, ip[3], 8) }
            1 -> { push(bits, ip[1], 8); push(bits, ip[2], 8); push(bits, ip[3], 8) }
            2 -> { push(bits, ip[1] - 16, 4); push(bits, ip[2], 8); push(bits, ip[3], 8) }
            else -> for (n in ip) push(bits, n, 8)
        }

        push(bits, checksum(bits.toList()), 5)
        while (bits.size % 5 != 0) bits.add(0)

        val sb = StringBuilder()
        var i = 0
        while (i < bits.size) { sb.append(ALPHABET[read(bits, i, 5)]); i += 5 }
        return sb.toString()
    }

    /** Beírt szöveg -> kiszolgáló-cím, vagy null. */
    fun decode(input: String): String? {
        val clean = input.uppercase().filter { it in '0'..'9' || it in 'A'..'Z' }
            .replace('O', '0').replace('I', '1').replace('L', '1')
        if (clean.isEmpty() || clean.length > MAX_CODE_CHARS) return null

        val bits = mutableListOf<Int>()
        for (ch in clean) {
            val v = ALPHABET.indexOf(ch)
            if (v < 0) return null
            for (i in 4 downTo 0) bits.add((v ushr i) and 1)
        }
        if (bits.size < 8) return null

        val tag = read(bits, 0, 2)
        val explicitPort = bits[2] == 1
        var at = 3
        var port = DEFAULT_SYNC_PORT
        if (explicitPort) {
            if (bits.size < at + 16) return null
            port = read(bits, at, 16)
            at += 16
            if (port < 1) return null
        }

        val payloadWidth = when (tag) { 0 -> 16; 1 -> 24; 2 -> 20; else -> 32 }
        if (bits.size < at + payloadWidth + 5) return null

        val ip = when (tag) {
            0 -> listOf(192, 168, read(bits, at, 8), read(bits, at + 8, 8))
            1 -> listOf(10, read(bits, at, 8), read(bits, at + 8, 8), read(bits, at + 16, 8))
            2 -> listOf(172, 16 + read(bits, at, 4), read(bits, at + 4, 8), read(bits, at + 12, 8))
            else -> (0 until 4).map { read(bits, at + it * 8, 8) }
        }
        at += payloadWidth

        if (read(bits, at, 5) != checksum(bits.subList(0, at))) return null
        at += 5

        // A maradék CSAK nulla lehet, és legfeljebb négy bit — különben a kód
        // hosszabb, mint amennyi információt hordoz, tehát nem tőlünk származik.
        if (bits.size - at > 4) return null
        for (i in at until bits.size) if (bits[i] != 0) return null

        val host = ip.joinToString(".")
        return "http://$host:$port"
    }

    /**
     * Amit a felhasználó a mezőbe írt -> használható cím.
     *
     * Egy mező, kétféle bemenet. Külön mező a kódnak és a címnek azt jelentené,
     * hogy előbb el kell dönteni, melyikbe kell írni — pont az a fajta apró
     * döntés, amitől abbahagyják.
     */
    fun resolveServerInput(input: String): String? {
        val raw = input.trim()
        if (raw.isEmpty()) return null
        if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(raw)) return raw
        decode(raw)?.let { return it }
        if (Regex("""^[A-Za-z0-9.-]+(?::\d+)?$""").matches(raw)) return "http://$raw"
        return null
    }

    /** Ahogy a felületen áll: négyes csoportokban, olvashatóan. */
    fun format(code: String): String =
        code.chunked(4).joinToString("-")
}
