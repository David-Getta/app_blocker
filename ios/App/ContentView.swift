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
    /// A munkamenet-indítás hossza percben; üresen a csomag szokásos hossza.
    @State private var focusMinutes = ""
    /// Hosszabbítás percben, futó menet alatt.
    @State private var focusExtra = ""

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
                    focusSyncErrorBanner
                    focusRunningSection
                    focusPacksSection
                    addSection
                    if let ses = store.state.session { resumeBanner(ses) }
                    listSection
                    StatsView(now: now)
                    SyncCard(siteLabel: siteLabel)
                    tierLine
                }
                .padding()
            }
            .navigationTitle("Breaker")
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
        .padding().background(Color.red.opacity(0.11), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    /// A futó munkamenet.
    ///
    /// iPhone-on a munkamenet FEHÉRLISTA, és az alagút tényleg érvényesíti: ami
    /// nincs a csomagon, arra NXDOMAIN a válasz. Ez erősebb, mint amit a gép
    /// tud — és pont ezért kell kimondani, mi történik. Enélkül a felhasználó
    /// azt látná, hogy „nem jön be semmi”, és hálózati hibát keresne.
    @ViewBuilder
    private var focusRunningSection: some View {
        // A `now` a másodpercenként frissülő óra: enélkül a hátralévő idő csak
        // akkor mozdulna, ha az ÁLLAPOT változik — vagyis állna.
        if let run = store.state.focusRun, Focus.isRunning(run, now: now),
           let pack = (store.state.focusPacks ?? []).first(where: { $0.id == run.packId }) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Munkamenet fut").font(.caption).foregroundStyle(.secondary)
                Text(pack.name).font(.headline)
                // Az ablak szerint indult menetnél ezt kimondjuk: aki nem maga
                // indította, tudja meg, miért fut — és hogy a vége az ablak vége.
                Text("Még \(Focus.formatRemaining(run.endsAt - now)) — eddig: \(clockText(run.endsAt))"
                     + (Focus.isWindowRun(run, packs: store.state.focusPacks ?? []) ? " · a heti ablak szerint indult" : ""))
                    .font(.subheadline)
                Text(pack.allowSites.isEmpty
                     ? "Ebben a csomagban nincs engedélyezett oldal — minden más tiltva."
                     : "Most csak ez mehet: \(pack.allowSites.joined(separator: ", ")). Minden más tiltva.")
                    .font(.footnote)
                // A kivétellista LÉTEZÉSÉT kimondjuk. Egy titkos kivétel
                // rosszabb lenne, mint egy nyílt: a felhasználó előbb-utóbb
                // észreveszi, hogy valami mégis átment, és onnantól semmiben
                // nem hisz.
                Text("Az értesítések, a kapcsolat-ellenőrzés és az óra átmennek — enélkül a telefon nem korlátozott lenne, hanem elromlott. Böngészni egyiken sem lehet.")
                    .font(.caption).foregroundStyle(.secondary)
                // HOSSZABBÍTANI ingyen van — ez a szigorítás iránya.
                HStack {
                    ForEach([15, 30, 60], id: \.self) { min in
                        Button("+\(min) p") {
                            try? Referee.changeFocus(
                                nextEndsAt: run.endsAt + Double(min) * 60_000,
                                now: Date().timeIntervalSince1970 * 1000
                            )
                        }
                        .buttonStyle(.bordered)
                    }
                }
                // Percre pontos hosszabbítás — ugyanaz, mint Androidon és a
                // gépen. A gyorsgombok a gyakori eseteket fedik; ez az, amikor
                // tudod, hogy pontosan mennyi kell még.
                HStack {
                    TextField("perc", text: $focusExtra)
                        .keyboardType(.numberPad)
                        .textFieldStyle(.roundedBorder)
                    Button("Hozzáad") {
                        guard let mins = Int(focusExtra), mins >= 1 else {
                            flowError = "Írd be percben, mennyivel hosszabbítanád."
                            return
                        }
                        try? Referee.changeFocus(
                            nextEndsAt: run.endsAt
                                + Double(min(mins, Focus.maxSessionMinutes)) * 60_000,
                            now: Date().timeIntervalSince1970 * 1000
                        )
                        focusExtra = ""
                    }
                    .buttonStyle(.bordered)
                }
                // LEÁLLÍTANI próbatétel — ugyanaz, mint egy feloldásnál. A gomb
                // csak elindítja; a menet addig ÉRVÉNYES marad, különben a
                // puszta kérés feloldás lenne.
                Button("Leállítás…") {
                    do {
                        try Referee.changeFocus(
                            nextEndsAt: nil, now: Date().timeIntervalSince1970 * 1000
                        )
                    } catch {
                        flowError = (error as? Referee.RefereeError)?.message ?? "Nem sikerült."
                    }
                }
                Text("A leállítás próbatétel — ahogy egy feloldás is. A munkamenet a saját idejéig magától lejár.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding().background(Color.accentColor.opacity(0.11), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }

    /// A csomagok listája — innen indul egy munkamenet.
    ///
    /// INDÍTANI ingyen van (ez a szigorítás iránya), LEÁLLÍTANI próbatétel. A
    /// kettő EGYSZERRE került be: ha a telefon tudna indítani, de leállítani
    /// nem, egy nyolcórás menetből ott nem lenne kiút.
    ///
    /// HA A MUNKAMENET SZINKRONJA ELHASALT, azt ki kell írni.
    ///
    /// A leggyakoribb ok egy régi fiókkiszolgáló, ami nem ismeri a `focus`
    /// gyűjteményt: a gépen elindított menet ilyenkor SOSEM ér ide, és a
    /// felhasználó semmiből nem tudná meg, miért. Azt hinné, a funkció rossz.
    @ViewBuilder
    private var focusSyncErrorBanner: some View {
        if let msg = store.state.focusSyncError {
            Text(msg)
                .font(.footnote)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
                .background(BreakerStyle.surfaceNested)
                .cornerRadius(10)
        }
    }

    /// A csomagokat a GÉPEN állítod össze — ott látszik a teljes lista, és ott
    /// kényelmes gépelni. A telefon indítja és betartatja őket.
    @ViewBuilder
    private var focusPacksSection: some View {
        let packs = store.state.focusPacks ?? []
        if !packs.isEmpty, !Focus.isRunning(store.state.focusRun, now: now) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Munkamenet indítása").font(.caption).foregroundStyle(.secondary)
                Text("Amíg tart, csak a csomagban felsoroltak jönnek be. Minden más tiltva.")
                    .font(.footnote).foregroundStyle(.secondary)
                // A menetet a DNS-szűrő tartatja be. Ha az alagút nem fut, az
                // indítás CSENDBEN nem csinálna semmit: a felhasználó azt hinné,
                // hogy fókuszban van, közben minden nyitva.
                if tunnel.status != .connected {
                    Text("A védelem most nincs bekapcsolva — a munkamenetet a DNS-szűrő tartatja be, tehát addig nem tiltana semmit. Kapcsold be fent.")
                        .font(.footnote).foregroundStyle(.red)
                }
                TextField("Hossz percben (üresen a csomag szokásos hossza)", text: $focusMinutes)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                ForEach(packs, id: \.id) { pack in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(pack.name).font(.subheadline)
                            Text(pack.allowSites.isEmpty
                                 ? "nincs engedélyezett oldal"
                                 : pack.allowSites.joined(separator: ", "))
                                .font(.caption).foregroundStyle(.secondary)
                            // A heti ablak a telefonon is látszik: egy csomag, ami
                            // reggel magától indul, ne legyen meglepetés.
                            if let band = pack.recurrence {
                                Text("magától indul: \(recurrenceLabel(band))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Button("Indítás") {
                            // Üres mező = a csomag szokásos hossza. Így az
                            // indítás egy koppintás marad annak, aki nem akar
                            // számolni.
                            let mins = Int(focusMinutes) ?? pack.defaultMinutes
                            do {
                                try Referee.startFocus(
                                    packId: pack.id, minutes: mins,
                                    now: Date().timeIntervalSince1970 * 1000
                                )
                                focusMinutes = ""
                            } catch {
                                flowError = (error as? Referee.RefereeError)?.message
                                    ?? "Nem sikerült elindítani."
                            }
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding().background(Color.secondary.opacity(0.09), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }

    private func clockText(_ ms: Double) -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
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
                .padding().background(Color.orange.opacity(0.11), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
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

    /// A címke-tölcsér, amit a szinkron-kártya is használ.
    ///
    /// A másik eszköz mérése NYERS címkékkel érkezik: a kliens nem tudhatja,
    /// hogy a felületen épp rejtve van-e a lista. A döntés itt van, ahol az
    /// információ — enélkül a rejtés pont ott lyukadna ki, ahol senki nem
    /// keresi.
    private func siteLabel(_ raw: String) -> String {
        guard let idx = store.state.sites.firstIndex(where: { $0.domain == raw }) else { return raw }
        let site = store.state.sites[idx]
        if listHidden { return AliasLogic.maskedLabel(site, index: idx) }
        return AliasLogic.displayName(site)
    }

    private var addSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel("Oldal blokkolása")
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
        .breakerCard()
    }

    private var listSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                SectionLabel("Blokkolt oldalak")
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
                .breakerCard()
            } else {
                if store.state.sites.isEmpty {
                    Text("Még nincs blokkolt oldal.").font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(store.state.sites) { site in siteCard(site) }
            }
        }
    }

    /// A napi keret állapota — annyi, amennyit iPhone-on igazul ki lehet írni.
    ///
    /// Mérni itt nem tudunk, tehát ez a szám TELJES EGÉSZÉBEN a gépről és az
    /// androidos telefonról jön. Ezt ki is mondjuk: enélkül úgy tűnne, mintha a
    /// telefon mérne, és a felhasználó a saját telefonos idejét keresné benne.
    @ViewBuilder
    private func limitLine(_ site: Site) -> some View {
        if let limit = LimitLogic.normalizeLimit(site.dailyLimitSeconds) {
            let now = nowMs()
            let used = LimitLogic.sharedTodaySeconds(store.state.sharedToday, site.domain, now)
            let whole = UsageStats.formatDuration(limit)
            if used >= limit {
                Text("Napi keret elfogyott (\(whole)) — holnap újraindul")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Napi keret: \(UsageStats.formatDuration(used)) / \(whole) — másik eszközökön mérve")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    /// Az adag-szabály — kijelzés, nem érvényesítés.
    ///
    /// iPhone-on nincs előtér-mérés, amiből az adag gyűlne, tehát a szabály
    /// itt nem érvényesül — a gépen és az androidos telefonon igen. Ezt ki
    /// kell mondani: egy némán ott ülő beállítás azt sugallná, hogy itt is véd.
    @ViewBuilder
    private func burstLine(_ site: Site) -> some View {
        if let burst = site.burstSeconds, let cool = site.cooldownSeconds, burst > 0, cool > 0 {
            Text("Adag: \(UsageStats.formatDuration(burst)) használat után "
                + "\(UsageStats.formatDuration(cool)) szünet — a gépen és Androidon "
                + "érvényesül, ezen a telefonon nem (itt nincs mérés)")
                .font(.caption).foregroundStyle(.secondary)
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
                let blockedNow = LimitLogic.isBlockedNowWithLimit(
                    site, UsageStats.State(), store.state.sharedToday, now
                )
                if scheduled {
                    Text(blockedNow ? "Most blokkolva (menetrend)" : "Most szabad (menetrend szerint)")
                        .foregroundStyle(blockedNow ? .green : .orange)
                } else {
                    Text("Blokkolva").foregroundStyle(.green)
                }
                limitLine(site)
                burstLine(site)
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
        .breakerCard()
    }

    private var tierLine: some View {
        let tier = ChallengeEngine.computeTier(store.state.unlockLog, now: now)
        let names = ["alap", "emelt", "magas", "maximális"]
        // Az utolsó feloldás napokban — a „feloldás nélkül” ugyanúgy kimondható
        // tény, mint a nehézségi szint.
        let streak: String
        switch ChallengeEngine.daysSinceUnlock(store.state.unlockLog, now: now) {
        case nil: streak = "feloldás még nem volt"
        case 0?: streak = "utolsó feloldás: ma"
        case 1?: streak = "utolsó feloldás: tegnap"
        case let d?: streak = "utolsó feloldás: \(d) napja"
        }
        return Text("Próbatétel-nehézség: \(names[tier]) (\(tier + 1)/4) · \(streak) — minél többször oldasz fel, annál nehezebb.")
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

/// „H–P 09:00–12:00”, „minden nap 22:00–06:00”, „H, Sze, P 18:00–20:00” — mint a gépen.
private func recurrenceLabel(_ b: ScheduleLogic.Band) -> String {
    let names = ["V", "H", "K", "Sze", "Cs", "P", "Szo"]
    let set = Set(b.days)
    let days: String
    if set.count == 7 { days = "minden nap" }
    else if set == Set([1, 2, 3, 4, 5]) { days = "H–P" }
    else if set == Set([0, 6]) { days = "Szo–V" }
    else { days = [1, 2, 3, 4, 5, 6, 0].filter { set.contains($0) }.map { names[$0] }.joined(separator: ", ") }
    func hm(_ min: Int) -> String { String(format: "%02d:%02d", (min % 1440) / 60, min % 60) }
    return "\(days) \(hm(b.startMin))–\(hm(b.endMin))"
}
