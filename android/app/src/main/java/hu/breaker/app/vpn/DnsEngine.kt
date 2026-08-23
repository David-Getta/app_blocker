package hu.breaker.app.vpn

/**
 * Minimal DNS-over-TUN packet handling.
 *
 * The VPN routes ONLY the two virtual DNS server addresses into the TUN, so
 * every packet arriving here is (in practice) a UDP DNS query. We parse it,
 * answer NXDOMAIN for blocked names, and relay everything else upstream.
 *
 * Scope (v1): UDP only, single-question queries, no IPv6 extension headers.
 * DNS-over-TCP is not routed (system resolvers use UDP first); large answers
 * that need TCP simply fail for blocked domains, which is fine.
 */
object DnsEngine {

    const val VIRTUAL_DNS4 = "10.90.0.1"
    const val VIRTUAL_DNS6 = "fd66:6c61:6b61::1"
    const val TUN_ADDR4 = "10.90.0.2"
    const val TUN_ADDR6 = "fd66:6c61:6b61::2"

    data class UdpQuery(
        val ipVersion: Int,
        val srcAddr: ByteArray,
        val dstAddr: ByteArray,
        val srcPort: Int,
        val dstPort: Int,
        val dnsPayload: ByteArray,
    )

    /** Parses an IPv4/IPv6 UDP packet from the TUN; null when not UDP/53. */
    fun parseUdp(buf: ByteArray, len: Int): UdpQuery? {
        if (len < 28) return null
        val version = (buf[0].toInt() ushr 4) and 0x0F
        if (version == 4) {
            val ihl = (buf[0].toInt() and 0x0F) * 4
            if (ihl < 20 || len < ihl + 8) return null
            if ((buf[9].toInt() and 0xFF) != 17) return null
            val fragOffset = (((buf[6].toInt() and 0x1F) shl 8) or (buf[7].toInt() and 0xFF))
            if (fragOffset != 0) return null
            val srcPort = readU16(buf, ihl)
            val dstPort = readU16(buf, ihl + 2)
            if (dstPort != 53) return null
            val udpLen = readU16(buf, ihl + 4)
            val payloadLen = minOf(udpLen - 8, len - ihl - 8)
            if (payloadLen < 12) return null
            return UdpQuery(
                4,
                buf.copyOfRange(12, 16), buf.copyOfRange(16, 20),
                srcPort, dstPort,
                buf.copyOfRange(ihl + 8, ihl + 8 + payloadLen),
            )
        }
        if (version == 6) {
            if (len < 48) return null
            if ((buf[6].toInt() and 0xFF) != 17) return null // no ext headers in v1
            val srcPort = readU16(buf, 40)
            val dstPort = readU16(buf, 42)
            if (dstPort != 53) return null
            val udpLen = readU16(buf, 44)
            val payloadLen = minOf(udpLen - 8, len - 48)
            if (payloadLen < 12) return null
            return UdpQuery(
                6,
                buf.copyOfRange(8, 24), buf.copyOfRange(24, 40),
                srcPort, dstPort,
                buf.copyOfRange(48, 48 + payloadLen),
            )
        }
        return null
    }

    /** Extracts the (lowercased) query name; null when unparsable / QDCOUNT != 1. */
    fun queryName(dns: ByteArray): String? {
        if (dns.size < 12) return null
        val qdCount = readU16(dns, 4)
        if (qdCount != 1) return null
        val sb = StringBuilder()
        var i = 12
        while (i < dns.size) {
            val lenByte = dns[i].toInt() and 0xFF
            if (lenByte == 0) return if (sb.isEmpty()) null else sb.toString()
            if (lenByte >= 0xC0) return null // compression not expected in questions
            if (i + 1 + lenByte > dns.size) return null
            if (sb.isNotEmpty()) sb.append('.')
            for (j in 1..lenByte) {
                val c = dns[i + j].toInt() and 0xFF
                sb.append(Char(c).lowercaseChar())
            }
            i += 1 + lenByte
        }
        return null
    }

    /** Builds an NXDOMAIN response DNS message (header + question only). */
    fun buildNxdomain(query: ByteArray): ByteArray? {
        if (query.size < 12) return null
        // find end of question section
        var i = 12
        while (i < query.size) {
            val lenByte = query[i].toInt() and 0xFF
            if (lenByte == 0) { i += 1; break }
            if (lenByte >= 0xC0) return null
            i += 1 + lenByte
        }
        if (i + 4 > query.size) return null
        val qEnd = i + 4
        val out = ByteArray(qEnd)
        System.arraycopy(query, 0, out, 0, qEnd)
        // QR=1, keep opcode+RD, clear AA/TC
        out[2] = ((0x80 or (query[2].toInt() and 0x79))).toByte()
        // RA=1, RCODE=3 (NXDOMAIN)
        out[3] = 0x83.toByte()
        writeU16(out, 4, 1)  // QDCOUNT
        writeU16(out, 6, 0)  // ANCOUNT
        writeU16(out, 8, 0)  // NSCOUNT
        writeU16(out, 10, 0) // ARCOUNT
        return out
    }

    /** Wraps a DNS payload into a UDP/IP packet going back to the client. */
    fun wrapResponse(q: UdpQuery, payload: ByteArray): ByteArray {
        return if (q.ipVersion == 4) wrap4(q, payload) else wrap6(q, payload)
    }

    private fun wrap4(q: UdpQuery, payload: ByteArray): ByteArray {
        val total = 20 + 8 + payload.size
        val out = ByteArray(total)
        out[0] = 0x45; out[1] = 0
        writeU16(out, 2, total)
        writeU16(out, 4, 0)          // identification
        out[6] = 0x40; out[7] = 0    // DF
        out[8] = 64                  // TTL
        out[9] = 17                  // UDP
        // src = original dst (the virtual DNS), dst = original src
        System.arraycopy(q.dstAddr, 0, out, 12, 4)
        System.arraycopy(q.srcAddr, 0, out, 16, 4)
        val hdrSum = checksum(out, 0, 20, 0)
        writeU16(out, 10, hdrSum)
        // UDP
        writeU16(out, 20, 53)        // src port
        writeU16(out, 22, q.srcPort) // dst port
        writeU16(out, 24, 8 + payload.size)
        System.arraycopy(payload, 0, out, 28, payload.size)
        var pseudo = sumBytes(out, 12, 8)         // src+dst addr
        pseudo += 17 + (8 + payload.size)
        val udpSum = checksum(out, 20, 8 + payload.size, pseudo)
        writeU16(out, 26, if (udpSum == 0) 0xFFFF else udpSum)
        return out
    }

    private fun wrap6(q: UdpQuery, payload: ByteArray): ByteArray {
        val udpLen = 8 + payload.size
        val out = ByteArray(40 + udpLen)
        out[0] = 0x60
        writeU16(out, 4, udpLen)
        out[6] = 17  // next header UDP
        out[7] = 64  // hop limit
        System.arraycopy(q.dstAddr, 0, out, 8, 16)
        System.arraycopy(q.srcAddr, 0, out, 24, 16)
        writeU16(out, 40, 53)
        writeU16(out, 42, q.srcPort)
        writeU16(out, 44, udpLen)
        System.arraycopy(payload, 0, out, 48, payload.size)
        var pseudo = sumBytes(out, 8, 32) // src+dst addr
        pseudo += udpLen + 17
        val udpSum = checksum(out, 40, udpLen, pseudo)
        writeU16(out, 46, if (udpSum == 0) 0xFFFF else udpSum)
        return out
    }

    // ------------------------------------------------------------ utilities

    private fun readU16(buf: ByteArray, off: Int): Int =
        ((buf[off].toInt() and 0xFF) shl 8) or (buf[off + 1].toInt() and 0xFF)

    private fun writeU16(buf: ByteArray, off: Int, v: Int) {
        buf[off] = ((v ushr 8) and 0xFF).toByte()
        buf[off + 1] = (v and 0xFF).toByte()
    }

    private fun sumBytes(buf: ByteArray, off: Int, len: Int): Long {
        var sum = 0L
        var i = off
        val end = off + len
        while (i + 1 < end) {
            sum += (((buf[i].toInt() and 0xFF) shl 8) or (buf[i + 1].toInt() and 0xFF)).toLong()
            i += 2
        }
        if (i < end) sum += ((buf[i].toInt() and 0xFF) shl 8).toLong()
        return sum
    }

    /** ones' complement 16-bit checksum over [off,off+len) plus [extra] pseudo-sum */
    private fun checksum(buf: ByteArray, off: Int, len: Int, extra: Long): Int {
        var sum = sumBytes(buf, off, len) + extra
        while (sum > 0xFFFF) sum = (sum and 0xFFFF) + (sum ushr 16)
        return sum.toInt().inv() and 0xFFFF
    }
}
