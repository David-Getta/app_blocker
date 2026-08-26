import NetworkExtension
import Foundation

/// DNS sinkhole tunnel. Only the virtual DNS addresses are routed in, so normal
/// traffic is untouched; blocked names get NXDOMAIN in every app and browser,
/// including private/incognito windows. Traffic never leaves the device except
/// the upstream DNS relays.
class PacketTunnelProvider: NEPacketTunnelProvider {

    private let upstreams = ["1.1.1.1", "8.8.8.8"]
    private let resolveQueue = DispatchQueue(label: "hu.breaker.resolve", attributes: .concurrent)

    override func startTunnel(options: [String: NSObject]?,
                              completionHandler: @escaping (Error?) -> Void) {
        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "127.0.0.1")

        let ipv4 = NEIPv4Settings(addresses: [DnsEngine.tunAddr4], subnetMasks: ["255.255.255.0"])
        ipv4.includedRoutes = [NEIPv4Route(destinationAddress: DnsEngine.virtualDNS4,
                                           subnetMask: "255.255.255.255")]
        settings.ipv4Settings = ipv4

        let ipv6 = NEIPv6Settings(addresses: [DnsEngine.tunAddr6], networkPrefixLengths: [64])
        ipv6.includedRoutes = [NEIPv6Route(destinationAddress: DnsEngine.virtualDNS6,
                                           networkPrefixLength: 128)]
        settings.ipv6Settings = ipv6

        let dns = NEDNSSettings(servers: [DnsEngine.virtualDNS4, DnsEngine.virtualDNS6])
        dns.matchDomains = [""] // catch every lookup
        settings.dnsSettings = dns
        settings.mtu = 1500

        setTunnelNetworkSettings(settings) { [weak self] error in
            if let error = error { completionHandler(error); return }
            BreakerStore.shared.mutate { $0.protectionOn = true }
            self?.readLoop()
            completionHandler(nil)
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason,
                             completionHandler: @escaping () -> Void) {
        BreakerStore.shared.mutate { $0.protectionOn = false }
        completionHandler()
    }

    private func readLoop() {
        packetFlow.readPackets { [weak self] packets, protocols in
            guard let self = self else { return }
            Referee.tick(now: nowMs())
            let blocked = BreakerStore.shared.blockedHostnamesNow(nowMs())
            for (idx, packet) in packets.enumerated() {
                let family = protocols[idx].int32Value
                self.handle(packet: [UInt8](packet), family: family, blocked: blocked)
            }
            self.readLoop()
        }
    }

    private func handle(packet: [UInt8], family: Int32, blocked: Set<String>) {
        guard let q = DnsEngine.parseUdp(packet) else { return }
        let name = DnsEngine.queryName(q.dnsPayload)
        // A döntés MAGA a `Focus.verdict` — a sorrendje ott van leírva, és a
        // legfontosabb pontja, hogy a BLOKKLISTA MINDIG NYER. A munkamenet
        // sosem old fel semmit, csak hozzátesz; enélkül egy csomagba felvett
        // `youtube.com` próbatétel nélkül feloldaná a tiltott YouTube-ot.
        let now = nowMs()
        let store = BreakerStore.shared
        let isBlocked: Bool
        if let name {
            isBlocked = Focus.verdict(
                name,
                run: store.runningFocus(now),
                pack: store.runningFocusPack(now),
                now: now,
                blocked: blocked,
                syncHost: store.syncHost()
            ) != .allow
        } else {
            isBlocked = false
        }

        if isBlocked {
            guard let nx = DnsEngine.buildNxdomain(q.dnsPayload) else { return }
            let resp = DnsEngine.wrapResponse(q, nx)
            writeBack(resp, family: family)
            return
        }
        // Relay upstream, then write the response back into the tunnel.
        resolveQueue.async { [weak self] in
            guard let self = self, let answer = self.forwardUpstream(q.dnsPayload) else { return }
            let resp = DnsEngine.wrapResponse(q, answer)
            self.writeBack(resp, family: family)
        }
    }

    private func writeBack(_ bytes: [UInt8], family: Int32) {
        packetFlow.writePackets([Data(bytes)], withProtocols: [NSNumber(value: family)])
    }

    private func forwardUpstream(_ payload: [UInt8]) -> [UInt8]? {
        for upstream in upstreams {
            if let answer = queryUdp(server: upstream, payload: payload) { return answer }
        }
        return nil
    }

    /// Blocking UDP query to an upstream resolver. The tunnel excludes these
    /// destinations from its own routes, so this socket egresses normally.
    private func queryUdp(server: String, payload: [UInt8]) -> [UInt8]? {
        let fd = socket(AF_INET, SOCK_DGRAM, 0)
        if fd < 0 { return nil }
        defer { close(fd) }
        var tv = timeval(tv_sec: 4, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(53).bigEndian
        inet_pton(AF_INET, server, &addr.sin_addr)

        let sent = payload.withUnsafeBytes { raw in
            withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                    sendto(fd, raw.baseAddress, payload.count, 0, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
        }
        if sent < 0 { return nil }

        var buf = [UInt8](repeating: 0, count: 4096)
        let n = recv(fd, &buf, buf.count, 0)
        if n <= 0 { return nil }
        return Array(buf[0..<n])
    }
}
