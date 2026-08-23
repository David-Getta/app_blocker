import Foundation
import NetworkExtension
import Combine

/// Installs and controls the Packet Tunnel via NETunnelProviderManager.
///
/// Key to "no re-approval every launch": once the user grants the VPN config
/// ONCE, we set `isOnDemandEnabled = true` with a connect-always rule. The OS
/// then brings the tunnel up automatically at boot/login and keeps it up — the
/// app does not need to run and the user is not prompted again.
@MainActor
final class TunnelController: ObservableObject {

    @Published var status: NEVPNStatus = .invalid
    @Published var installed = false

    private var manager: NETunnelProviderManager?
    private var observer: NSObjectProtocol?

    init() {
        observer = NotificationCenter.default.addObserver(
            forName: .NEVPNStatusDidChange, object: nil, queue: .main
        ) { [weak self] note in
            if let conn = note.object as? NEVPNConnection { self?.status = conn.status }
        }
        Task { await load() }
    }

    func load() async {
        let managers = (try? await NETunnelProviderManager.loadAllFromPreferences()) ?? []
        manager = managers.first
        installed = manager != nil
        status = manager?.connection.status ?? .invalid
    }

    /// First-time install: one system prompt to allow the VPN configuration.
    func installAndStart() async throws {
        let mgr = manager ?? NETunnelProviderManager()
        let proto = NETunnelProviderProtocol()
        proto.providerBundleIdentifier = "hu.lakat.app.tunnel"
        proto.serverAddress = "Lakat (helyi DNS-szűrő)"
        mgr.protocolConfiguration = proto
        mgr.localizedDescription = "Lakat védelem"
        mgr.isEnabled = true

        // Always-on: reconnect on demand so the OS keeps it up without the app.
        let rule = NEOnDemandRuleConnect()
        rule.interfaceTypeMatch = .any
        mgr.onDemandRules = [rule]
        mgr.isOnDemandEnabled = true

        try await mgr.saveToPreferences()
        try await mgr.loadFromPreferences() // pick up the assigned identifier
        manager = mgr
        installed = true
        try mgr.connection.startVPNTunnel()
    }

    /// Turning protection fully off is only allowed when there are no blocked
    /// sites; while the block list is non-empty the UI hides this path.
    func stop() async {
        guard let mgr = manager else { return }
        mgr.isOnDemandEnabled = false
        try? await mgr.saveToPreferences()
        mgr.connection.stopVPNTunnel()
    }

    func ensureRunning() {
        guard let mgr = manager else { return }
        if mgr.connection.status != .connected && mgr.connection.status != .connecting {
            try? mgr.connection.startVPNTunnel()
        }
    }
}
