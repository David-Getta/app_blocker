import SwiftUI
import NetworkExtension

private func fmtRemain(_ ms: Double) -> String {
    let total = Int(max(0, ceil(ms / 1000)))
    let h = total / 3600, m = (total % 3600) / 60, s = total % 60
    if h > 0 { return "\(h) ó \(String(format: "%02d", m)) p" }
    return "\(m):\(String(format: "%02d", s))"
}

struct ContentView: View {
    @EnvironmentObject var store: BreakerStore
    @EnvironmentObject var tunnel: TunnelController

    @State private var addInput = ""
    @State private var usePreset = true
    @State private var addError: String?
    @State private var pauseSite: Site?
    @State private var deleteSite: Site?
    @State private var scheduleSite: Site?
    @State private var aliasSite: Site?
    @State private var flowError: String?

    /// Ideiglenes felfedés oldalanként: meddig látszik a valódi cím.
    /// Szándékosan nem mentjük — az app újranyitása után megint a fedőnév áll ott.
    @State private var revealedUntil: [String: Double] = [:]

    /// A lista MOST nyitva van-e, ha egyébként rejtettre van állítva. Ez sem
    /// mentett: a beállítás azt mondja, hogy rejtve INDULJON, a megnyitás pedig
    /// csak erre a munkamenetre szól.
    @State private var listOpenThisSession = false
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
                    SyncCard()
                    tierLine
                }
                .padding()
            }
            .navigationTitle("🔒 Breaker")
            .sheet(item: $pauseSite) { site in pauseSheet(site) }
            .sheet(item: $aliasSite) { site in aliasSheet(site) }
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
                Text("A(z) \(AliasLogic.displayName(site)) törléséhez a legnehezebb próbák tartoznak, és a törlés csak 24 órával a teljesítésük UTÁN válik véglegessé. Addig visszavonhatod.")
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
            Text("A Breaker nem tudja értelmezni a mentett állapotot, ezért nem is ír fölé — így a beállításaid nem vesznek el. Ez általában akkor fordul elő, ha egy újabb verzió után régebbit telepítettél vissza. Frissíts a legfrissebb verzióra, és a lista magától újra előjön. Addig a már beállított blokkolások érvényben maradnak.")
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

    /// Rejtve van-e MOST a blokkolt oldalak listája.
    ///
    /// Ezt az egy kérdést a felület több pontja is felteszi — a lista és a
    /// felvevő kártya is. Ha bármelyik kimaradna, a rejtés annyit érne, mint egy
    /// lyukas zsák: elég egyetlen hely, ahol ott a cím.
    private var listHidden: Bool {
        store.state.hideSiteList == true && !listOpenThisSession
    }

    private var addSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Oldal blokkolása").font(.headline)
            HStack {
                TextField(listHidden ? "a cím, amit blokkolni akarsz" : "pl. www.youtube.com",
                          text: $addInput)
                    .textFieldStyle(.roundedBorder)
                    #if os(iOS)
                    .autocapitalization(.none)
                    .keyboardType(.URL)
                    #endif
                    .disableAutocorrection(true)
                Button("Blokk") { addSite(addInput) }.buttonStyle(.borderedProminent)
            }
            Toggle(listHidden
                   ? "Társoldalak blokkolása is (a mobilos és a rövidített címek)"
                   : "Társoldalak blokkolása is (pl. youtu.be, m.youtube.com)",
                   isOn: $usePreset)
                .font(.footnote)
            // Rejtett listánál a gyorsgombok is elmaradnak: PONT azok a címek
            // állnak rajtuk, amiket az ember tipikusan blokkol. Hiába rejtenénk
            // a listát, ha eggyel feljebb ott sorakozik ugyanaz hat gombon.
            if !listHidden {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(presets, id: \.self) { p in
                            Button(p) { addSite(p) }.buttonStyle(.bordered).font(.caption)
                        }
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
            Text("Folyamatban: \(ses.kind == .delete ? "törlés" : "feloldás") — "
                 + (site.map { AliasLogic.displayName($0) } ?? ""))
                .font(.footnote)
            Spacer()
            Button("Folytatás") { openSessionId = ses.id }
        }
        .padding().background(Color.accentColor.opacity(0.12)).cornerRadius(10)
    }

    private var listSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Blokkolt oldalak").font(.headline)
                Spacer()
                // A gomb a BEÁLLÍTÁST kapcsolja, nem a pillanatnyi láthatóságot:
                // ha rejtettre van állítva, de most nyitva van, akkor a rejtést
                // kapcsolja KI. Enélkül nem lenne mód visszavonni.
                if !listHidden && (!store.state.sites.isEmpty || store.state.hideSiteList == true) {
                    Button(store.state.hideSiteList == true ? "Ne rejtse ezután" : "Lista elrejtése") {
                        let turningOn = store.state.hideSiteList != true
                        listOpenThisSession = !turningOn
                        store.mutate { $0.hideSiteList = turningOn }
                    }
                    .font(.caption)
                }
            }
            if listHidden {
                // A darabszám marad: a kérés az volt, hogy MIK vannak blokkolva
                // ne látszódjon, nem az, hogy hány.
                HStack(alignment: .top) {
                    Text(store.state.sites.isEmpty
                         ? "A lista el van rejtve. Még nincs benne egyetlen oldal sem."
                         : "\(store.state.sites.count) oldal van blokkolva. A lista el van rejtve, hogy a puszta megnyitás se emlékeztessen rájuk. Megnyitva csak eddig a bezárásig marad.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Spacer()
                    Button("Megnyitás") { listOpenThisSession = true }.buttonStyle(.bordered)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding().background(Color.gray.opacity(0.12)).cornerRadius(10)
            } else {
                if store.state.sites.isEmpty {
                    Text("Még nincs blokkolt oldal.").font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(store.state.sites) { site in siteCard(site) }
            }
        }
    }

    private func siteCard(_ site: Site) -> some View {
        let paused = (site.pauseUntil ?? 0) > now
        let deleting = site.pendingDeleteAt != nil
        let aliased = AliasLogic.isAliased(site)
        let revealing = (revealedUntil[site.id] ?? 0) > now
        return VStack(alignment: .leading, spacing: 6) {
            Text(AliasLogic.displayNameNow(site, now: now, revealedUntil: revealedUntil[site.id]))
                .font(.headline)
            HStack(spacing: 8) {
                Text(aliased && !revealing ? "fedőnév alatt" : "\(site.hostnames.count) hosztnév")
                    .font(.caption).foregroundStyle(.secondary)
                // A valódi cím nem tűnik el, csak nem ül ott: néha tényleg tudni
                // kell, melyik sor melyik.
                if aliased && !revealing {
                    Button("Mutasd") { revealedUntil[site.id] = nowMs() + AliasLogic.revealMs }
                        .font(.caption).buttonStyle(.borderless)
                }
            }
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
                        Button("Fedőnév…") { aliasSite = site }.buttonStyle(.bordered)
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

    /// Fedőnév beállítása.
    ///
    /// Nincs próbatétel: a fedőnév a blokkolást egy hajszálnyit sem gyengíti —
    /// az oldal ugyanúgy tiltva marad, az alagút ugyanazt a hosztnevet dobja el.
    /// A súrlódás ott van, ahol a védelem gyengülne.
    private func aliasSheet(_ site: Site) -> some View {
        AliasSheet(site: site) { text in
            store.mutate { s in
                if let i = s.sites.firstIndex(where: { $0.id == site.id }) {
                    s.sites[i].alias = AliasLogic.normalize(text)
                }
            }
            // Új fedőnév után a felfedés nem élhet tovább: különben a beállítás
            // pillanatában is a valódi cím maradna ott.
            revealedUntil[site.id] = nil
            aliasSite = nil
        } onCancel: {
            aliasSite = nil
        }
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

/// A fedőnév-lap tartalma.
///
/// Külön nézet, mert a beírt szöveg SAJÁT állapot: ha a szülőben élne, minden
/// karakter újrarajzolná az egész főképernyőt, és a lap `item:` bindingje
/// közben újra is építené a lapot.
private struct AliasSheet: View {
    let site: Site
    let onSave: (String) -> Void
    let onCancel: () -> Void

    @State private var text: String

    init(site: Site, onSave: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
        self.site = site
        self.onSave = onSave
        self.onCancel = onCancel
        _text = State(initialValue: site.alias ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Fedőnév").font(.headline)
            Text("Ha adsz nevet, a felület ezt írja ki a cím helyett — a listán, a párbeszédek címében és a próbatétel-ablakban is. A valódi cím egy gombbal, hat másodpercre előhívható.")
                .font(.footnote).foregroundStyle(.secondary)
            // Vágó binding, nem .onChange: annak az egyparaméteres alakja
            // iOS 17-től elavult, a kétparaméteres meg régebbin nincs meg. Így
            // egyik SDK-n sem kell verziót figyelni.
            TextField("pl. A videós", text: Binding(
                get: { text },
                set: { text = String($0.prefix(AliasLogic.maxAliasLength)) }
            ))
                .textFieldStyle(.roundedBorder)
                #if os(iOS)
                .autocapitalization(.none)
                #endif
                .disableAutocorrection(true)
            Text("Ez nem titkosítás: a blokk maga a készüléken ott van, a fedőnév csak annyit tesz, hogy ne emlékeztessen.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                if site.alias != nil {
                    Button("Fedőnév levétele") { onSave("") }.buttonStyle(.bordered)
                }
                Spacer()
                Button("Mégse") { onCancel() }
                Button("Mentés") { onSave(text) }.buttonStyle(.borderedProminent)
            }
        }
        .padding()
    }
}
