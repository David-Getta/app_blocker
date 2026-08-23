import Foundation

/// Minimal DNS-over-TUN packet handling — mirrors android .../vpn/DnsEngine.kt.
///
/// The tunnel routes only the virtual DNS addresses, so packets arriving here
/// are UDP DNS queries. We answer NXDOMAIN for blocked names and relay the rest.
/// Scope (v1): UDP only, single-question queries, no IPv6 extension headers.
enum DnsEngine {

    static let virtualDNS4 = "10.90.0.1"
    static let virtualDNS6 = "fd66:6c61:6b61::1"
    static let tunAddr4 = "10.90.0.2"
    static let tunAddr6 = "fd66:6c61:6b61::2"

    struct UdpQuery {
        let ipVersion: Int
        let srcAddr: [UInt8]
        let dstAddr: [UInt8]
        let srcPort: Int
        let dstPort: Int
        let dnsPayload: [UInt8]
    }

    private static func u16(_ b: [UInt8], _ o: Int) -> Int { Int(b[o]) << 8 | Int(b[o + 1]) }
    private static func putU16(_ b: inout [UInt8], _ o: Int, _ v: Int) {
        b[o] = UInt8((v >> 8) & 0xFF); b[o + 1] = UInt8(v & 0xFF)
    }

    static func parseUdp(_ buf: [UInt8]) -> UdpQuery? {
        let len = buf.count
        if len < 28 { return nil }
        let version = Int(buf[0]) >> 4
        if version == 4 {
            let ihl = Int(buf[0] & 0x0F) * 4
            if ihl < 20 || len < ihl + 8 { return nil }
            if buf[9] != 17 { return nil }
            let frag = (Int(buf[6] & 0x1F) << 8) | Int(buf[7])
            if frag != 0 { return nil }
            let srcPort = u16(buf, ihl), dstPort = u16(buf, ihl + 2)
            if dstPort != 53 { return nil }
            let udpLen = u16(buf, ihl + 4)
            let payloadLen = min(udpLen - 8, len - ihl - 8)
            if payloadLen < 12 { return nil }
            return UdpQuery(ipVersion: 4,
                            srcAddr: Array(buf[12..<16]), dstAddr: Array(buf[16..<20]),
                            srcPort: srcPort, dstPort: dstPort,
                            dnsPayload: Array(buf[(ihl + 8)..<(ihl + 8 + payloadLen)]))
        }
        if version == 6 {
            if len < 48 { return nil }
            if buf[6] != 17 { return nil }
            let srcPort = u16(buf, 40), dstPort = u16(buf, 42)
            if dstPort != 53 { return nil }
            let udpLen = u16(buf, 44)
            let payloadLen = min(udpLen - 8, len - 48)
            if payloadLen < 12 { return nil }
            return UdpQuery(ipVersion: 6,
                            srcAddr: Array(buf[8..<24]), dstAddr: Array(buf[24..<40]),
                            srcPort: srcPort, dstPort: dstPort,
                            dnsPayload: Array(buf[48..<(48 + payloadLen)]))
        }
        return nil
    }

    static func queryName(_ dns: [UInt8]) -> String? {
        if dns.count < 12 { return nil }
        if u16(dns, 4) != 1 { return nil } // QDCOUNT
        var parts: [String] = []
        var i = 12
        while i < dns.count {
            let lenByte = Int(dns[i])
            if lenByte == 0 { return parts.isEmpty ? nil : parts.joined(separator: ".") }
            if lenByte >= 0xC0 { return nil }
            if i + 1 + lenByte > dns.count { return nil }
            let label = String(bytes: dns[(i + 1)...(i + lenByte)], encoding: .utf8) ?? ""
            parts.append(label.lowercased())
            i += 1 + lenByte
        }
        return nil
    }

    static func buildNxdomain(_ query: [UInt8]) -> [UInt8]? {
        if query.count < 12 { return nil }
        var i = 12
        while i < query.count {
            let lenByte = Int(query[i])
            if lenByte == 0 { i += 1; break }
            if lenByte >= 0xC0 { return nil }
            i += 1 + lenByte
        }
        if i + 4 > query.count { return nil }
        let qEnd = i + 4
        var out = Array(query[0..<qEnd])
        out[2] = 0x80 | (query[2] & 0x79)
        out[3] = 0x83                       // RA=1, RCODE=3 (NXDOMAIN)
        putU16(&out, 4, 1)                  // QDCOUNT
        putU16(&out, 6, 0)                  // ANCOUNT
        putU16(&out, 8, 0)                  // NSCOUNT
        putU16(&out, 10, 0)                 // ARCOUNT
        return out
    }

    static func wrapResponse(_ q: UdpQuery, _ payload: [UInt8]) -> [UInt8] {
        q.ipVersion == 4 ? wrap4(q, payload) : wrap6(q, payload)
    }

    private static func wrap4(_ q: UdpQuery, _ payload: [UInt8]) -> [UInt8] {
        let total = 20 + 8 + payload.count
        var out = [UInt8](repeating: 0, count: total)
        out[0] = 0x45
        putU16(&out, 2, total)
        out[6] = 0x40                       // DF
        out[8] = 64                         // TTL
        out[9] = 17                         // UDP
        for k in 0..<4 { out[12 + k] = q.dstAddr[k] }  // src = original dst
        for k in 0..<4 { out[16 + k] = q.srcAddr[k] }  // dst = original src
        putU16(&out, 10, checksum(out, 0, 20, 0))
        putU16(&out, 20, 53)
        putU16(&out, 22, q.srcPort)
        putU16(&out, 24, 8 + payload.count)
        for k in 0..<payload.count { out[28 + k] = payload[k] }
        var pseudo = sumBytes(out, 12, 8)
        pseudo += 17 + (8 + payload.count)
        let udpSum = checksum(out, 20, 8 + payload.count, pseudo)
        putU16(&out, 26, udpSum == 0 ? 0xFFFF : udpSum)
        return out
    }

    private static func wrap6(_ q: UdpQuery, _ payload: [UInt8]) -> [UInt8] {
        let udpLen = 8 + payload.count
        var out = [UInt8](repeating: 0, count: 40 + udpLen)
        out[0] = 0x60
        putU16(&out, 4, udpLen)
        out[6] = 17
        out[7] = 64
        for k in 0..<16 { out[8 + k] = q.dstAddr[k] }
        for k in 0..<16 { out[24 + k] = q.srcAddr[k] }
        putU16(&out, 40, 53)
        putU16(&out, 42, q.srcPort)
        putU16(&out, 44, udpLen)
        for k in 0..<payload.count { out[48 + k] = payload[k] }
        var pseudo = sumBytes(out, 8, 32)
        pseudo += udpLen + 17
        let udpSum = checksum(out, 40, udpLen, pseudo)
        putU16(&out, 46, udpSum == 0 ? 0xFFFF : udpSum)
        return out
    }

    private static func sumBytes(_ buf: [UInt8], _ off: Int, _ len: Int) -> Int {
        var sum = 0, i = off
        let end = off + len
        while i + 1 < end { sum += (Int(buf[i]) << 8) | Int(buf[i + 1]); i += 2 }
        if i < end { sum += Int(buf[i]) << 8 }
        return sum
    }

    private static func checksum(_ buf: [UInt8], _ off: Int, _ len: Int, _ extra: Int) -> Int {
        var sum = sumBytes(buf, off, len) + extra
        while sum > 0xFFFF { sum = (sum & 0xFFFF) + (sum >> 16) }
        return ~sum & 0xFFFF
    }
}
