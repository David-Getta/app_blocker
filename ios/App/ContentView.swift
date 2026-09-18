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
    @State private var reasonSite: Site?
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
    @State private var lockdownSheet = false
    @State private var lockdownWindowSheet = false
    /// A módosításra megnyitott ablak — a lap ugyanaz, kitöltve; nil = felvétel.
    @State private var lockdownWindowEdit: LockdownLogic.LockdownWindow? = nil
    /// Amelyik listához a heti emlékeztetők utoljára igazodtak; nil = még sosem.
    @State private var remindedWindows: [LockdownLogic.LockdownWindow]? = nil
    /// Párban zárolás: a megbízott neve a felvételhez, és a jelmondat egyszeri lapja.
    @State private var partnerName = ""
    @State private var keywordInput = ""
    @State private var partnerPhrase: Referee.PartnerSetup? = nil

    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()
    private let presets = ["youtube.com", "facebook.com", "instagram.com", "tiktok.com", "x.com", "reddit.com"]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if store.fileUnreadable { unreadableBanner }
                    lockdownBanner
                    protectionSection
                    focusSyncErrorBanner
                    focusRunningSection
                    focusPacksSection
                    addSection
                    if let ses = store.state.session { resumeBanner(ses) }
                    listSection
                    StatsView(now: now, siteLabel: siteLabel)
                    lockdownSection
                    SyncCard(siteLabel: siteLabel)
                    tierLine
                }
                .padding()
            }
            .navigationTitle("Breaker")
            .sheet(item: $pauseSite) { site in pauseSheet(site) }
            .sheet(isPresented: $lockdownSheet) {
                LockdownSheet(current: store.state.lockdown, now: now) { minutes in
                    lockdownSheet = false
                    do {
                        try Referee.startLockdown(ms: Double(minutes) * 60_000, now: nowMs())
                    } catch let e as Referee.RefereeError {
                        flowError = e.message
                    } catch {
                        flowError = "\(error)"
                    }
                }
            }
            .sheet(isPresented: $lockdownWindowSheet, onDismiss: { lockdownWindowEdit = nil }) {
                LockdownWindowSheet(current: store.state.lockdownWindows ?? [], editing: lockdownWindowEdit) { result in
                    lockdownWindowSheet = false
                    switch result {
                    case .applied: break
                    case .challenge(let id): openSessionId = id
                    case .error(let msg): flowError = msg
                    }
                }
            }
            .sheet(item: $aliasSite) { site in aliasSheet(site) }
            .sheet(item: $reasonSite) { site in reasonSheet(site) }
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
            .sheet(item: sessionBinding) { ses in
                ChallengeView(session: ses, onSuccess: { successMsg = $0 }, onDropped: { flowError = $0 })
            }
            // A jelmondat EGYSZER látszik: itt. Át kell adni — a felhasználónál
            // ne maradjon. Lehúzni nem lehet, csak kimondva bezárni.
            .sheet(isPresented: partnerPhraseBinding) {
                if let p = partnerPhrase {
                    PartnerPhraseSheet(setup: p) { partnerPhrase = nil }
                        .interactiveDismissDisabled()
                }
            }
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
            // A heti emlékeztetők az ablakok listáját követik — a szinkronból
            // jött változást is, amíg az app nyitva van.
            let windows = store.state.lockdownWindows ?? []
            if remindedWindows != windows {
                remindedWindows = windows
                WindowReminders.reschedule(windows)
            }
            // A heti napló sora. Értesítés itt nincs (a bővítmény nem adhat, az
            // app nem fut a háttérben); a sor akkor íródik, amikor az app azon
            // a héten először nyitva van hétfő reggel hét után — a felület
            // címkézésével, mint a statisztika. Az üres hét nem sor.
            if let key = DigestLogic.due(store.state.digestWeekKey, now: now) {
                let text = DigestLogic.text(DigestLogic.inputFor(store.state, now: now), labelOf: siteLabel)
                _ = store.mutate {
                    $0.digestWeekKey = key
                    $0.digestLog = DigestLogic.record($0.digestLog ?? [], week: key, text: text)
                }
            }
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
                // Egy csomag heti ablaka félbeszakítja a MÁSIK csomag kézi menetét
                // (az ablak az ígéret) — mondjuk ki előre, ne a kilences óra legyen
                // a meglepetés. A következő nyolc órán belüli legkorábbi ablak.
                if let cut = nextWindowCut(packs) {
                    Text("A(z) \(cut.name) heti ablaka \(cut.clock)-kor indul: egy másik csomag menete ott véget ér, és az ablak menete indul.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
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

    /// A ZÁRLAT SÁVJA. Legfelül, mert amíg tart, minden lazító gomb elhasal, és
    /// annak az OKÁT kell először látni. Gomb nincs rajta: visszaútja nincs,
    /// tehát nincs mit kattintani.
    private var lockdownBanner: some View {
        Group {
            if LockdownLogic.isLocked(store.state.lockdown, now) {
                let left = LockdownLogic.formatRemaining(store.state.lockdown!.until - now)
                // Az ablak zárlata ugyanaz a zárlat — de a sáv mondja ki, hogy az
                // ablak tartja: aki reggel a telefonhoz nyúl, tudja meg, miért.
                let byWindow = LockdownLogic.isWindowLockdown(
                    store.state.lockdown!, (store.state.lockdownWindows ?? []).map { $0.band })
                VStack(alignment: .leading, spacing: 6) {
                    Text((byWindow ? "Zárlat a heti ablak szerint: " : "Zárlat: ") + "\(left) van hátra")
                        .font(.headline)
                    Text("Amíg tart, semmilyen feloldás, keret-emelés vagy szabály-levétel nem indítható — próbatétellel sem. Szigorítani viszont bármikor lehet.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
                .background(Color.red.opacity(0.11), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        }
    }

    /// A zárlat kártyája. A többitől az különbözteti meg, hogy ennek nincs
    /// ellentéte: nincs feloldó gomb, és nem is lesz — pont attól ér valamit.
    private var lockdownSection: some View {
        let live = LockdownLogic.isLocked(store.state.lockdown, now)
        return VStack(alignment: .leading, spacing: 8) {
            SectionLabel("Zárlat")
            Text(live
                 ? "A futó zárlat nem rövidíthető és nem vonható vissza. Hosszabbítani viszont bármikor lehet — a szigorítás mindig ingyen van."
                 : "Egy időszak, ami alatt a lazítás nem drágább, hanem NEM LÉTEZIK: sem feloldás, sem keret-emelés, sem szabály-levétel nem indítható, próbatétellel sem. Blokkolni és szigorítani közben is lehet. Nincs visszaút: ha elindítod, ki kell várni. Ez nem készülékzár — az app letörölhető, és ezt nem is titkoljuk; az impulzus ellen véd.")
                .font(.footnote).foregroundStyle(.secondary)
            Button(live ? "Zárlat hosszabbítása" : "Zárlat indítása") { lockdownSheet = true }
                .buttonStyle(.bordered)
            // A HETI ABLAKOK: ebben a sávban a zárlat magától él. Felvenni ingyen;
            // levenni próbatétel, és csak az ablakon kívül — a bíró dönt. A lista
            // itt áll, a zárlat alatt, mert ugyanaz a zárlat.
            let windows = store.state.lockdownWindows ?? []
            ForEach(windows, id: \.id) { w in
                HStack {
                    Text("Heti ablak: \(recurrenceLabel(w.band))\(windowNextLabel(w.band, now: nowMs()))")
                        .font(.footnote).foregroundStyle(.secondary)
                    Spacer()
                    // Bővíteni ingyen, szűkíteni próbatétel — a bíró dönti el, melyik.
                    Button("Módosítás…") { lockdownWindowEdit = w; lockdownWindowSheet = true }
                        .buttonStyle(.borderless).font(.footnote)
                    Button("Levétel…") { removeLockdownWindow(w) }
                        .buttonStyle(.borderless).font(.footnote)
                }
            }
            Text(windows.isEmpty
                 ? "Heti ablak: egy sáv (például hétköznap 9-től 17-ig), amiben a zárlat magától él — minden héten, a gépen is. Felvenni egy koppintás; levenni próbatétel, és csak az ablakon kívül."
                 : "Ezekben a sávokban a zárlat magától él. Levenni próbatétel, és csak az ablakon kívül — bent zárlat van.")
                .font(.footnote).foregroundStyle(.secondary)
            if windows.count < LockdownLogic.maxLockdownWindows {
                Button("Heti ablak felvétele") { lockdownWindowSheet = true }
                    .buttonStyle(.bordered)
            }
            keywordsBlock
            partnerBlock
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// KULCSSZÓ-SZABÁLYOK: a gépi böngésző érvényesíti; az iPhone szerkeszti
    /// és hordozza — felvenni ingyen, levenni próbatétel —, és kimondja, hogy
    /// itt nem érvényesül.
    private var keywordsBlock: some View {
        let words = store.state.keywords ?? []
        return VStack(alignment: .leading, spacing: 8) {
            Divider()
            Text("Kulcsszavak a böngészőben").font(.headline)
            Text("Bármely oldal, aminek a webcímében ez a szó szerepel — shorts, reels, egy játék neve —, a gépi böngészőben tiltva. Itt szerkeszthető, és a fiókon át a gépekre átér; az iPhone-on nem tilt: a szűrő a címet nem látja. Felvenni ingyen, levenni próbatétel.")
                .font(.footnote).foregroundStyle(.secondary)
            ForEach(words, id: \.self) { w in
                HStack {
                    Text(w).font(.subheadline)
                    Spacer()
                    Button("Levétel…") { removeKeyword(w) }.buttonStyle(.borderless).font(.footnote)
                }
            }
            if words.count < KeywordLogic.maxKeywords {
                HStack {
                    TextField("új kulcsszó, pl. shorts", text: $keywordInput)
                        .textFieldStyle(.roundedBorder)
                    Button("Felvétel") { addKeyword() }.buttonStyle(.bordered)
                }
            }
        }
    }

    /// Egy kulcsszó levétele: a bíró próbatételt indít — a szó addig marad.
    private func removeKeyword(_ w: String) {
        let rest = (store.state.keywords ?? []).filter { $0 != w }
        do {
            let r = try Referee.setKeywords(rest, now: nowMs())
            if !r.applied { openSessionId = r.session?.id }
        } catch let e as Referee.RefereeError { flowError = e.message } catch { flowError = "\(error)" }
    }

    /// Új kulcsszó: ingyen — a mag szabálya már a beküldés előtt, a bíró ugyanezt mondaná.
    private func addKeyword() {
        let current = store.state.keywords ?? []
        guard let word = KeywordLogic.normalizeKeyword(keywordInput) else {
            flowError = "A kulcsszó \(KeywordLogic.minKeywordLength)–\(KeywordLogic.maxKeywordLength) karakter, szóköz nélkül."
            return
        }
        if current.contains(word) { flowError = "A „\(word)” már fent van."; return }
        do {
            try Referee.setKeywords(current + [word], now: nowMs())
            keywordInput = ""
        } catch let e as Referee.RefereeError { flowError = e.message } catch { flowError = "\(error)" }
    }

    /// PÁRBAN ZÁROLÁS: a lazítás végén a megbízott jelmondata is kell — nem
    /// drágább, hanem más ember döntése is. Felvenni ingyen; levenni
    /// próbatétel, a végén az ő jelmondatával. A zárlat kártyáján áll, mert
    /// ugyanarról szól: a lazítás útjáról.
    private var partnerBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            Text("Párban zárolás").font(.headline)
            if let partner = store.state.partner {
                Text("Megbízott: \(partner.name). Minden lazító próbatétel utolsó lépése az ő jelmondata — a levételé is. A jelmondat nincs meg a telefonon, csak a lenyomata; a többi eszközödre is átér.")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("Levétel…") { removePartner() }.buttonStyle(.bordered)
            } else {
                Text("Egy megbízott — társ, barát, szülő —, aki egy jelmondatot kap: minden lazítás végén ő írja be. Nem helyetted csinálja végig, csak az utolsó szót ő mondja ki. Felvenni ingyen; levenni próbatétel, a végén az ő jelmondatával. Nem gépzár: az impulzus ellen véd, nem a szándék ellen.")
                    .font(.footnote).foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    TextField("a megbízott neve, pl. Anna", text: $partnerName)
                        .textFieldStyle(.roundedBorder)
                    Button("Felvétel") { setPartner() }.buttonStyle(.bordered)
                }
            }
        }
    }

    private func setPartner() {
        do {
            let r = try Referee.setPartner(name: partnerName, now: nowMs())
            partnerName = ""
            partnerPhrase = r
        } catch let e as Referee.RefereeError { flowError = e.message } catch { flowError = "\(error)" }
    }

    /// A megbízott levétele: a bíró próbatételt indít — a végén az ő jelmondatával.
    private func removePartner() {
        do {
            let r = try Referee.startPartnerRemoval(now: nowMs())
            if !r.applied { openSessionId = r.session?.id }
        } catch let e as Referee.RefereeError { flowError = e.message } catch { flowError = "\(error)" }
    }

    /// Egy ablak levétele: a bíró próbatételt indít (ablakon kívül), vagy
    /// megmondja, miért nem — bent zárlat van.
    private func removeLockdownWindow(_ w: LockdownLogic.LockdownWindow) {
        let rest = (store.state.lockdownWindows ?? []).filter { $0.id != w.id }
        do {
            let r = try Referee.setLockdownWindows(rest, now: nowMs())
            if !r.applied { openSessionId = r.session?.id }
        } catch let e as Referee.RefereeError {
            flowError = e.message
        } catch {
            flowError = "\(error)"
        }
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
            // Kategória-csomagok: egy kattintással több oldal. Ami már fent van,
            // nem számít bele; a teljes csomag gombja nem aktív.
            if !listHidden {
                let have = Set(store.state.sites.map { $0.domain })
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(Blocklist.categoryPacks, id: \.key) { p in
                            let missing = p.domains.filter { !have.contains($0) }.count
                            Button(missing > 0 ? "\(p.label) (\(missing) oldal)" : "\(p.label) — mind fent") { addPack(p) }
                                .buttonStyle(.bordered).font(.caption).disabled(missing == 0)
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
                // ne látszódjon, nem az, hogy hány. Ugyanaz a szám, mint a
                // sorokban: ami MOST zár, az blokkolt; a szünetelő vagy menetrend
                // szerint nyitott oldal „most szabad”.
                let open = store.state.sites.filter {
                    !LimitLogic.isBlockedNowWithLimit($0, UsageStats.State(), store.state.sharedToday, now)
                }.count
                let count = open == 0
                    ? "\(store.state.sites.count) oldal van blokkolva."
                    : "\(store.state.sites.count) oldal van a listán, ebből \(open) most szabad."
                HStack(alignment: .top) {
                    Text(store.state.sites.isEmpty
                         ? "A lista el van rejtve. Még nincs benne egyetlen oldal sem."
                         : "\(count) A lista el van rejtve, hogy a puszta megnyitás se emlékeztessen rájuk. Megnyitva csak eddig a bezárásig marad.")
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
            // Az indok: amiért te magad tiltottad le — a név alatt, hogy a
            // feloldás gombja mellett a szándék is ott legyen.
            if let reason = site.reason {
                Text("„\(reason)”").font(.footnote).italic().foregroundStyle(.secondary)
            }
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
                        .foregroundStyle(blockedNow ? Color.green : Color.orange)
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
                        Button("Indok…") { reasonSite = site }.buttonStyle(.bordered)
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
        // …és a szűrő megakadásai: hányszor állította meg a telefont a héten.
        let hits = FilterHitLogic.hits7d(store.state.filterHits ?? [:], now: now)
        let hitsPart = hits > 0 ? " · \(hits) megakadás a szűrőben" : ""
        return Text("Próbatétel-nehézség: \(names[tier]) (\(tier + 1)/4) · \(streak)\(hitsPart) — minél többször oldasz fel, annál nehezebb.")
            .font(.caption).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .center)
    }

    private func pauseSheet(_ site: Site) -> some View {
        VStack(spacing: 16) {
            Text("Mennyi időre oldanád fel?").font(.headline)
            Text("A feloldás előtt próbatételeket kell teljesíteni — hogy hányat, azt nem mondjuk meg előre. A megadott idő után a blokkolás magától visszakapcsol.")
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

    private func reasonSheet(_ site: Site) -> some View {
        ReasonSheet(site: site) { text in
            // Se nem lazítás, se nem szigorítás: az oldal ugyanúgy blokkolva
            // marad, ezért nincs próbatétel, és levenni is egy koppintás.
            store.mutate { s in
                if let i = s.sites.firstIndex(where: { $0.id == site.id }) {
                    s.sites[i].reason = AliasLogic.normalizeReason(text)
                }
            }
            reasonSite = nil
        } onCancel: {
            reasonSite = nil
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
    private var partnerPhraseBinding: Binding<Bool> {
        Binding(get: { partnerPhrase != nil }, set: { if !$0 { partnerPhrase = nil } })
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

    /// Egy egész csomag: a még nem listázott oldalak egyszerre; a védelem egyszer indul.
    private func addPack(_ pack: Blocklist.CategoryPack) {
        addError = nil
        let have = Set(store.state.sites.map { $0.domain })
        let fresh = pack.domains.filter { !have.contains($0) }
        if fresh.isEmpty { return }
        store.mutate { s in
            for domain in fresh {
                s.sites.append(Site(id: store.newId("site"), domain: domain,
                                    hostnames: Blocklist.expandHostnames(domain, usePreset: usePreset),
                                    addedAt: nowMs(), pauseUntil: nil, pendingDeleteAt: nil,
                                    schedule: nil))
            }
        }
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
/// Heti zárlat-ablak felvétele — a menetrend előre gyártott sávjaiból, mint a
/// menetrend-szerkesztő. A már meglévő sávok nem választhatók újra. A teljes
/// listát a bíró kapja: a felvétel szigorítás, azonnal megy.
///
/// Meglévő ablakkal (`editing`) ugyanez a lap MÓDOSÍT: csak a saját sáv
/// látszik, az ablak mezőivel kitöltve, és a mentés az ablak helyére írja az
/// újat — ugyanazzal az azonosítóval. Bővíteni ingyen van, szűkíteni
/// próbatétel; ezt is a bíró dönti el, a lap csak a listát adja át.
private struct LockdownWindowSheet: View {
    let current: [LockdownLogic.LockdownWindow]
    let editing: LockdownLogic.LockdownWindow?
    let onResult: (Result) -> Void

    enum Result { case applied, challenge(String), error(String) }

    @Environment(\.dismiss) private var dismiss
    @State private var selected = Set<String>()
    // SAJÁT SÁV: napok és két időpont — mint a gépen. Az előre gyártott sávok
    // a gyakori esetek; aki 8:30-tól 16-ig akar, itt állítja be.
    @State private var customDays: Set<Int>
    @State private var customStart: Date
    @State private var customEnd: Date
    private let dayNames = ["V", "H", "K", "Sze", "Cs", "P", "Szo"]

    init(current: [LockdownLogic.LockdownWindow], editing: LockdownLogic.LockdownWindow? = nil,
         onResult: @escaping (Result) -> Void) {
        self.current = current
        self.editing = editing
        self.onResult = onResult
        _customDays = State(initialValue: Set(editing?.days ?? []))
        _customStart = State(initialValue: Self.clock(editing?.startMin ?? 9 * 60))
        _customEnd = State(initialValue: Self.clock(editing?.endMin ?? 17 * 60))
    }

    /// Perc-a-napban → a választó dátuma; az 1440 (éjfél mint vég) 00:00.
    private static func clock(_ min: Int) -> Date {
        Calendar.current.date(from: DateComponents(hour: (min % 1440) / 60, minute: min % 60)) ?? Date()
    }

    private static let presets: [(label: String, key: String, band: ScheduleLogic.Band)] = [
        ("Munkaidő (H–P 9–17)", "workHours", .init(days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60)),
        ("Esti lekapcsolás (22–06)", "evening", .init(days: [0, 1, 2, 3, 4, 5, 6], startMin: 22 * 60, endMin: 6 * 60)),
        ("Hétvége (Szo–V egész nap)", "weekend", .init(days: [0, 6], startMin: 0, endMin: 1440)),
    ]

    private var have: Set<String> { Set(current.map { LockdownLogic.windowKey($0.band) }) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(editing == nil
                         ? "Az ablakban a zárlat magától él, az ablak végéig — a gépen is. Felvenni ingyen van; levenni próbatétel, és csak az ablakon kívül. Az egész hét nem zárható le: legalább egy szabad óra marad."
                         : "Bővíteni (több nap, hosszabb sáv) ingyen van, azonnal él. Szűkíteni próbatétel, és csak az ablakon kívül — bent zárlat van.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if editing == nil { Section("Sávok") {
                    ForEach(Self.presets, id: \.key) { p in
                        let already = have.contains(LockdownLogic.windowKey(p.band))
                        Toggle(already ? "\(p.label) — már felvéve" : p.label, isOn: Binding(
                            get: { already || selected.contains(p.key) },
                            set: { on in if on { selected.insert(p.key) } else { selected.remove(p.key) } }
                        )).disabled(already)
                    }
                } }
                Section(editing == nil ? "Vagy saját sáv" : "Napok, kezdés, vég") {
                    HStack(spacing: 6) {
                        ForEach([1, 2, 3, 4, 5, 6, 0], id: \.self) { d in
                            Button(dayNames[d]) {
                                if customDays.contains(d) { customDays.remove(d) } else { customDays.insert(d) }
                            }
                            .buttonStyle(.bordered)
                            .tint(customDays.contains(d) ? Color.accentColor : Color.secondary)
                        }
                    }
                    DatePicker("Kezdés", selection: $customStart, displayedComponents: .hourAndMinute)
                    DatePicker("Vég", selection: $customEnd, displayedComponents: .hourAndMinute)
                    Text(editing == nil
                         ? "A nap kijelölése nélkül a saját sáv nem számít."
                         : "Levenni az ablakot a Levétel… gombbal lehet, nem a napok kiürítésével.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle(editing == nil ? "Heti ablak felvétele" : "Heti ablak módosítása")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Mégse") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(editing == nil ? "Felvétel" : "Mentés") { apply() } }
            }
        }
    }

    private func minutes(_ date: Date) -> Int {
        let c = Calendar.current.dateComponents([.hour, .minute], from: date)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }

    /// A saját sáv ablakként — a „00:00” végként az éjfél: a sáv 1440-nel írja le, nem nullával.
    private func customWindow(id: String) -> LockdownLogic.LockdownWindow {
        let end = minutes(customEnd)
        return LockdownLogic.LockdownWindow(
            id: id, days: customDays.sorted(), startMin: minutes(customStart), endMin: end == 0 ? 1440 : end)
    }

    private func apply() {
        if let editing {
            // Módosításnál az ablak a HELYÉRE kerül, ugyanazzal az azonosítóval:
            // a bíró a tartalmat hasonlítja, és ő mondja meg, lazítás-e.
            if customDays.isEmpty {
                onResult(.error("Jelölj ki legalább egy napot — levenni a Levétel… gombbal lehet.")); return
            }
            let replaced = customWindow(id: editing.id)
            submit(current.map { $0.id == editing.id ? replaced : $0 })
            return
        }
        var added = Self.presets.filter { selected.contains($0.key) }.map {
            LockdownLogic.LockdownWindow(id: "", days: $0.band.days, startMin: $0.band.startMin, endMin: $0.band.endMin)
        }
        if !customDays.isEmpty { added.append(customWindow(id: "")) }
        if added.isEmpty { onResult(.error("Válassz legalább egy sávot, vagy adj meg sajátot.")); return }
        submit(current + added)
    }

    private func submit(_ next: [LockdownLogic.LockdownWindow]) {
        do {
            let r = try Referee.setLockdownWindows(next, now: nowMs())
            onResult(r.applied ? .applied : .challenge(r.session?.id ?? ""))
        } catch let e as Referee.RefereeError {
            onResult(.error(e.message))
        } catch {
            onResult(.error("\(error)"))
        }
    }
}

/// Zárlat indítása vagy hosszabbítása.
///
/// A KIÍRANDÓ SZÓ nem biztonsági elem — aki idáig eljutott, az kiírja —, hanem
/// a félrekattintás ellen: ennek a gombnak nincs visszavonása.
private struct LockdownSheet: View {
    let current: LockdownLogic.Lockdown?
    let now: Double
    let onStart: (Int) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var picked = LockdownLogic.lockdownChoicesMin[0]
    @State private var typed = ""

    private var live: Bool { LockdownLogic.isLocked(current, now) }
    /// Ékezet nélkül és kisbetűvel is jó: a szándékot kérdezzük, nem a
    /// billentyűzetkiosztást.
    private var confirmed: Bool {
        typed.trimmingCharacters(in: .whitespaces).lowercased()
            .replacingOccurrences(of: "á", with: "a") == "zarlat"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(live ? extendText : startText)
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Meddig") {
                    Picker("Hossz", selection: $picked) {
                        ForEach(LockdownLogic.lockdownChoicesMin, id: \.self) { min in
                            Text(LockdownLogic.formatRemaining(Double(min) * 60_000)).tag(min)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
                Section("A megerősítéshez írd be: ZÁRLAT") {
                    TextField("ZÁRLAT", text: $typed)
                        .disableAutocorrection(true)
                        #if os(iOS)
                        .textInputAutocapitalization(.characters)
                        #endif
                }
            }
            .navigationTitle(live ? "Zárlat hosszabbítása" : "Zárlat indítása")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Mégse") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(live ? "Hosszabbítás" : "Indítás") { onStart(picked) }
                        .disabled(!confirmed)
                }
            }
        }
    }

    private var extendText: String {
        let left = LockdownLogic.formatRemaining((current?.until ?? now) - now)
        return "Most \(left) van hátra. A megadott idő MOSTTÓL számít; ha rövidebb a hátralévőnél, nem történik semmi — rövidíteni nem lehet."
    }

    private var startText: String {
        "Amíg tart, egyetlen oldal sem oldható fel, a napi keret nem emelhető, az adag-szabály és a menetrend nem lazítható, és a futó munkamenet nem állítható le. Próbatétel sincs: nincs mit teljesíteni. A folyamatban lévő feloldások és törlések visszavonódnak."
    }
}

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

/// A következő nyolc órában induló legkorábbi heti ablak — a kézi menetet az
/// szakítja félbe. Nil, ha nincs ilyen.
private func nextWindowCut(_ packs: [Focus.Pack]) -> (name: String, clock: String)? {
    let now = Date().timeIntervalSince1970 * 1000
    var best: (name: String, startsAt: Double)?
    for p in packs {
        guard let band = p.recurrence, let occ = Focus.nextOccurrence(band, now: now) else { continue }
        guard occ.startsAt > now, occ.startsAt - now <= Double(Focus.maxSessionMinutes) * 60_000 else { continue }
        if best == nil || occ.startsAt < best!.startsAt { best = (p.name, occ.startsAt) }
    }
    guard let cut = best else { return nil }
    let f = DateFormatter()
    f.dateFormat = "HH:mm"
    return (cut.name, f.string(from: Date(timeIntervalSince1970: cut.startsAt / 1000)))
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

/// „ · az ablak most él (17:00-ig)” vagy „ · legközelebb holnap 09:00” — mint a
/// gépen. Egy ablak, amiről nem tudni, mikor jön, nem megnyugtató, hanem meglepetés.
private func windowNextLabel(_ b: ScheduleLogic.Band, now: Double) -> String {
    guard let occ = Focus.nextOccurrence(b, now: now) else { return "" }
    let clock = DateFormatter()
    clock.dateFormat = "HH:mm"
    if occ.startsAt <= now {
        return " · az ablak most él (\(clock.string(from: Date(timeIntervalSince1970: occ.endsAt / 1000)))-ig)"
    }
    let cal = Calendar.current
    let start = Date(timeIntervalSince1970: occ.startsAt / 1000)
    let today = cal.startOfDay(for: Date(timeIntervalSince1970: now / 1000))
    let dayDiff = cal.dateComponents([.day], from: today, to: cal.startOfDay(for: start)).day ?? 0
    let names = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"]
    let day = dayDiff == 0 ? "ma" : dayDiff == 1 ? "holnap" : names[cal.component(.weekday, from: start) - 1]
    return " · legközelebb \(day) \(clock.string(from: start))"
}

/// Az indok lapja: miért tiltottad. A soron, a próbatétel-lapon és a gépen a
/// böngésző tiltó lapján ez a mondat emlékeztet a kísértés pillanatában. Nem
/// tiltás és nem feloldás: bármikor átírható vagy levehető, próbatétel nélkül.
private struct ReasonSheet: View {
    let site: Site
    let onSave: (String) -> Void
    let onCancel: () -> Void

    @State private var text: String

    init(site: Site, onSave: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
        self.site = site
        self.onSave = onSave
        self.onCancel = onCancel
        _text = State(initialValue: site.reason ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Indok").font(.headline)
            Text("Egy mondat arról, miért tiltottad le. A soron és a feloldás lapján ez áll majd — a gépen a böngésző tiltó lapján is —, pont akkor, amikor a legjobban kellene. Nem tiltás és nem feloldás: bármikor átírható vagy levehető.")
                .font(.footnote).foregroundStyle(.secondary)
            TextField("pl. Mert este nem alszom tőle", text: Binding(
                get: { text },
                set: { text = String($0.prefix(AliasLogic.maxReasonLength)) }
            ))
                .textFieldStyle(.roundedBorder)
            HStack {
                if site.reason != nil {
                    Button("Indok levétele") { onSave("") }.buttonStyle(.bordered)
                }
                Spacer()
                Button("Mégse") { onCancel() }
                Button("Mentés") { onSave(text) }.buttonStyle(.borderedProminent)
            }
        }
        .padding()
    }
}

/// A megbízott jelmondata — EGYSZER, itt. A telefon a lenyomatát tartja meg, a
/// szöveget nem: aki bezárja, az átadta. Kijelölhető, hogy át lehessen küldeni.
private struct PartnerPhraseSheet: View {
    let setup: Referee.PartnerSetup
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Ez a jelmondat CSAK MOST látszik: a telefon a lenyomatát tartja meg, a szöveget nem. Add át a megbízottadnak, és ne tartsd meg magadnak — pont az a lényeg, hogy nálad ne legyen. Minden lazító próbatétel végén ezt kéri majd az app; ötször rossz jelmondat után a kísérlet elölről kezdődik.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Text(setup.phrase)
                        .font(.title2.weight(.semibold))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(BreakerStyle.surfaceNested, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    Text("Ha a jelmondat elvész, a megbízottat nem lehet levenni — se próbatétellel. Ez szándékos, különben a jelmondat nem érne semmit; de ki kell mondani: a jelmondatot a megbízott őrizze.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .padding()
            }
            .navigationTitle("\(setup.name) jelmondata")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Átadtam, bezárás") { onClose() }
                }
            }
        }
    }
}
