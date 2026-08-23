import SwiftUI
import NetworkExtension

private func fmtRemain(_ ms: Double) -> String {
    let total = Int(max(0, ceil(ms / 1000)))
    let h = total / 3600, m = (total % 3600) / 60, s = total % 60
    if h > 0 { return "\(h) ó \(String(format: "%02d", m)) p" }
    return "\(m):\(String(format: "%02d", s))"
}

struct ContentView: View {
    @EnvironmentObject var store: LakatStore
    @EnvironmentObject var tunnel: TunnelController

    @State private var addInput = ""
    @State private var usePreset = true
    @State private var addError: String?
    @State private var pauseSite: Site?
    @State private var deleteSite: Site?
    @State private var scheduleSite: Site?
    @State private var flowError: String?
    @State private var successMsg: String?
    @State private var now = nowMs()

    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()
    private let presets = ["youtube.com", "facebook.com", "instagram.com", "tiktok.com", "x.com", "reddit.com"]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if store.fileUnreadable { unreadableBanner }
                    protectionSection
                    addSection
                    if let ses = store.state.session { resumeBanner(ses) }
                    listSection
                    StatsView(now: now)
                    tierLine
                }
                .padding()
            }
            .navigationTitle("🔒 Lakat")
            .sheet(item: $pauseSite) { site in pauseSheet(site) }
            .sheet(item: $scheduleSite) { site in
                ScheduleEditor(site: site) { result in
                    scheduleSite = nil
                    switch result {
                    case .applied: break
                    case .challenge(let id): openSessionId = id
                    case .error(let msg): flowError = msg
                    }
                }
            }
            .sheet(item: sessionBinding) { ses in ChallengeView(session: ses) { msg in
                successMsg = msg
            } }
            .alert("Végleges törlés?", isPresented: deleteAlertBinding, presenting: deleteSite) { site in
                Button("Indítom a próbákat", role: .destructive) { startDelete(site) }
                Button("Mégse", role: .cancel) { deleteSite = nil }
            } message: { site in
                Text("A(z) \(site.domain) törléséhez a legnehezebb próbák tartoznak, és a törlés csak 24 órával a teljesítésük UTÁN válik véglegessé. Addig visszavonhatod.")
            }
            .alert("Hoppá", isPresented: errorAlertBinding) {
                Button("OK") { flowError = nil }
            } message: { Text(flowError ?? "") }
            .alert("Siker", isPresented: successAlertBinding) {
                Button("OK") { successMsg = nil }
            } message: { Text(successMsg ?? "") }
        }
        .onReceive(timer) { _ in
            now = nowMs()
            Referee.tick(now: now)
            if !store.state.sites.isEmpty { tunnel.ensureRunning() }
        }
    }

    // MARK: - sections

    /// Shown when the state file exists but cannot be decoded. The store then
    /// writes nothing at all — so say why, instead of letting every action look
    /// like it silently did nothing.
    private var unreadableBanner: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("A mentett lista nem olvasható").font(.headline)
            Text("A Lakat nem tudja értelmezni a mentett állapotot, ezért nem is ír fölé — így a beállításaid nem vesznek el. Ez általában akkor fordul elő, ha egy újabb verzió után régebbit telepítettél vissza. Frissíts a legfrissebb verzióra, és a lista magától újra előjön. Addig a már beállított blokkolások érvényben maradnak.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding().background(Color.red.opacity(0.12)).cornerRadius(12)
    }

    private var protectionSection: some View {
        Group {
            if tunnel.status != .connected && tunnel.status != .connecting {
                VStack(alignment: .leading, spacing: 8) {
                    Text("A DNS-szűrő nem fut").font(.headline)
                    Text("A blokkolás egy helyi VPN-en keresztül működik: minden névfeloldás átmegy rajta, így a tiltás minden böngészőben él, privát módban is. A forgalmad nem hagyja el a készüléket.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("Védelem bekapcsolása") { startProtection() }
                        .buttonStyle(.borderedProminent)
                    Text("Egyszer kell engedélyezned. Utána a rendszer automatikusan bekapcsolja induláskor — nem kér újra engedélyt.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding().background(Color.orange.opacity(0.12)).cornerRadius(12)
            } else if store.state.sites.isEmpty {
                Button("Védelem kikapcsolása") { Task { await tunnel.stop() } }
            } else {
                Text("Védelem aktív. Amíg van blokkolt oldal, az appból nem kapcsolható ki.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    private var addSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Oldal blokkolása").font(.headline)
            HStack {
                TextField("pl. www.youtube.com", text: $addInput)
                    .textFieldStyle(.roundedBorder)
                    #if os(iOS)
                    .autocapitalization(.none)
                    .keyboardType(.URL)
                    #endif
                    .disableAutocorrection(true)
                Button("Blokk") { addSite(addInput) }.buttonStyle(.borderedProminent)
            }
            Toggle("Társoldalak blokkolása is (pl. youtu.be, m.youtube.com)", isOn: $usePreset)
                .font(.footnote)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(presets, id: \.self) { p in
                        Button(p) { addSite(p) }.buttonStyle(.bordered).font(.caption)
                    }
                }
            }
            if let e = addError { Text(e).foregroundStyle(.red).font(.footnote) }
            Text("Oldalt felvenni mindig egy kattintás. Levenni — az szándékosan nem az.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func resumeBanner(_ ses: SessionRec) -> some View {
        let site = store.state.sites.first { $0.id == ses.siteId }
        return HStack {
            Text("Folyamatban: \(ses.kind == .delete ? "törlés" : "feloldás") — \(site?.domain ?? "")")
                .font(.footnote)
            Spacer()
            Button("Folytatás") { openSessionId = ses.id }
        }
        .padding().background(Color.accentColor.opacity(0.12)).cornerRadius(10)
    }

    private var listSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Blokkolt oldalak").font(.headline)
            if store.state.sites.isEmpty {
                Text("Még nincs blokkolt oldal.").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(store.state.sites) { site in siteCard(site) }
        }
    }

    private func siteCard(_ site: Site) -> some View {
        let paused = (site.pauseUntil ?? 0) > now
        let deleting = site.pendingDeleteAt != nil
        return VStack(alignment: .leading, spacing: 6) {
            Text(site.domain).font(.headline)
            Text("\(site.hostnames.count) hosztnév").font(.caption).foregroundStyle(.secondary)
            if paused {
                Text("Szünetel még \(fmtRemain((site.pauseUntil ?? 0) - now))").foregroundStyle(.orange)
                Button("Blokkolás visszakapcsolása most") { relock(site) }.buttonStyle(.bordered)
            } else if deleting {
                Text("Törlés \(fmtRemain((site.pendingDeleteAt ?? 0) - now)) múlva").foregroundStyle(.red)
                Button("Törlés visszavonása") { cancelDelete(site) }.buttonStyle(.bordered)
            } else {
                let scheduled = site.schedule != nil && site.schedule?.mode != .always
                let blockedNow = ScheduleLogic.isBlockedNow(pauseUntil: site.pauseUntil,
                                                            pendingDeleteAt: site.pendingDeleteAt,
                                                            schedule: site.schedule, now: now)
                if scheduled {
                    Text(blockedNow ? "Most blokkolva (menetrend)" : "Most szabad (menetrend szerint)")
                        .foregroundStyle(blockedNow ? .green : .orange)
                } else {
                    Text("Blokkolva").foregroundStyle(.green)
                }
                if store.state.session == nil {
                    HStack {
                        Button("Feloldás időre…") { pauseSite = site }.buttonStyle(.bordered)
                        Button("Menetrend…") { scheduleSite = site }.buttonStyle(.bordered)
                        Button("Törlés…") { deleteSite = site }.buttonStyle(.bordered)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding().background(Color.gray.opacity(0.12)).cornerRadius(10)
    }

    private var tierLine: some View {
        let tier = ChallengeEngine.computeTier(store.state.unlockLog, now: now)
        let names = ["alap", "emelt", "magas", "maximális"]
        return Text("Próbatétel-nehézség: \(names[tier]) (\(tier + 1)/4) — minél többször oldasz fel, annál nehezebb.")
            .font(.caption).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .center)
    }

    private func pauseSheet(_ site: Site) -> some View {
        VStack(spacing: 16) {
            Text("Mennyi időre oldanád fel?").font(.headline)
            Text("A feloldás előtt próbatételeket kell teljesíteni. A megadott idő után a blokkolás magától visszakapcsol.")
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            HStack {
                ForEach(ChallengeEngine.pauseChoicesMin, id: \.self) { m in
                    Button("\(m) p") { startPause(site, m) }.buttonStyle(.borderedProminent)
                }
            }
            Button("Mégse") { pauseSite = nil }
        }.padding()
    }

    // MARK: - actions

    @State private var openSessionId: String?

    private var sessionBinding: Binding<SessionRec?> {
        Binding(
            get: { store.state.session?.id == openSessionId ? store.state.session : nil },
            set: { if $0 == nil { openSessionId = nil } }
        )
    }
    private var deleteAlertBinding: Binding<Bool> {
        Binding(get: { deleteSite != nil }, set: { if !$0 { deleteSite = nil } })
    }
    private var errorAlertBinding: Binding<Bool> {
        Binding(get: { flowError != nil }, set: { if !$0 { flowError = nil } })
    }
    private var successAlertBinding: Binding<Bool> {
        Binding(get: { successMsg != nil }, set: { if !$0 { successMsg = nil } })
    }

    private func startProtection() {
        Task {
            do { try await tunnel.installAndStart() }
            catch { flowError = "A védelem bekapcsolása nem sikerült: \(error.localizedDescription)" }
        }
    }

    private func addSite(_ raw: String) {
        addError = nil
        guard let domain = Blocklist.normalizeDomain(raw) else {
            addError = "Ez nem tűnik érvényes címnek."; return
        }
        if store.state.sites.contains(where: { $0.domain == domain }) {
            addError = "Ez az oldal már a listán van."; return
        }
        store.mutate { s in
            s.sites.append(Site(id: store.newId("site"), domain: domain,
                                hostnames: Blocklist.expandHostnames(domain, usePreset: usePreset),
                                addedAt: nowMs(), pauseUntil: nil, pendingDeleteAt: nil,
                                schedule: nil))
        }
        addInput = ""
        if tunnel.status != .connected { startProtection() }
    }

    private func startPause(_ site: Site, _ minutes: Int) {
        pauseSite = nil
        do {
            let ses = try Referee.startSession(kind: .pause, siteId: site.id, minutes: minutes, now: nowMs())
            openSessionId = ses.id
        } catch let e as Referee.RefereeError { flowError = e.message } catch { flowError = "\(error)" }
    }

    private func startDelete(_ site: Site) {
        deleteSite = nil
        do {
            let ses = try Referee.startSession(kind: .delete, siteId: site.id, minutes: nil, now: nowMs())
            openSessionId = ses.id
        } catch let e as Referee.RefereeError { flowError = e.message } catch { flowError = "\(error)" }
    }

    private func relock(_ site: Site) {
        store.mutate { s in
            if let i = s.sites.firstIndex(where: { $0.id == site.id }) { s.sites[i].pauseUntil = nil }
        }
    }
    private func cancelDelete(_ site: Site) {
        store.mutate { s in
            if let i = s.sites.firstIndex(where: { $0.id == site.id }) { s.sites[i].pendingDeleteAt = nil }
        }
    }
}
