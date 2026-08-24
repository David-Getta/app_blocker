import SwiftUI

/// Fiók és eszközök közti szinkron.
///
/// Amit a kártya KIMOND, mert enélkül félreérthető lenne: a blokkolt oldalak és
/// a mért idők titkosítva mennek fel, és a kijelentkezés egyetlen blokkot sem
/// visz el. Az első nélkül a felhasználó abban a hitben lépne be, hogy a
/// listája valahol olvashatóan fekszik; a második nélkül abban a hitben nem
/// merne kilépni.
struct SyncCard: View {

    // Ugyanaz a minta, mint a többi nézetben: a példányt a BreakerApp adja be,
    // nem itt szedjük elő. Így egy nézet sem tarthat véletlenül másik példányt.
    @EnvironmentObject var store: BreakerStore

    /// UGYANAZ a címke-tölcsér, mint a saját listáé. Ha a lista rejtve van, a
    /// MÁSIK eszköz adata sem nevezheti meg a blokkolt oldalt — enélkül a
    /// rejtés pont ott lyukadna ki, ahol senki nem keresi.
    var siteLabel: (String) -> String = { $0 }

    @State private var server = ""
    @State private var account = ""
    // A jelszó nem kerül @AppStorage-ba és sehova máshova: csak addig él, amíg
    // a képernyő nyitva van.
    @State private var password = ""
    @State private var busy = false
    @State private var localError: String?
    @State private var recoveryCode: String?
    @State private var devices: SyncClient.DevicesResult?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel("Fiók és eszközök")
            if let acc = store.state.sync {
                signedIn(acc)
            } else {
                signedOut
            }
            if let e = localError {
                Text(e).font(.footnote).foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .breakerCard()
        // Szinkron a képernyő megnyitásakor. A telefonon nincs értelme
        // percenként ébresztgetni a hálózatot: az app akkor számít, amikor épp
        // nézed. Viszont AKKOR számítson — aki a gépén felvett egy oldalt, azt
        // itt lássa, ne csak akkor, ha eszébe jut megnyomni egy gombot.
        .task {
            guard store.state.sync != nil else { return }
            // Csendben: offline telefonnál a megnyitás ne hibaüzenettel
            // kezdődjön. A kártyán ott van, mikor volt utoljára szinkron.
            if let r = try? await SyncClient.syncNow(
                store.state, now: Date().timeIntervalSince1970 * 1000
            ) {
                _ = store.mutate { $0 = r.state }
            }
        }
        .alert("Helyreállító kód", isPresented: recoveryAlert, presenting: recoveryCode) { _ in
            Button("Felírtam") { recoveryCode = nil }
        } message: { code in
            Text("Írd fel, és tedd el biztos helyre:\n\n\(code)\n\nHa elfelejted a jelszót, EZ az egyetlen út vissza. A kiszolgáló nem tud segíteni, mert nem látja az adataidat.")
        }
    }

    private var recoveryAlert: Binding<Bool> {
        Binding(get: { recoveryCode != nil }, set: { if !$0 { recoveryCode = nil } })
    }

    private var signedOut: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Ha ugyanabba a fiókba lépsz be a többi eszközödön is, nem kell mindenhol újra felvenned a listát — és látod a többi eszköz statisztikáját. A blokkolt oldalak és a mért idők titkosítva mennek fel: a kiszolgáló nem látja őket.")
                .font(.footnote).foregroundStyle(.secondary)
            TextField("pl. http://192.168.1.10:8787", text: $server)
                .textFieldStyle(.roundedBorder)
                #if os(iOS)
                .autocapitalization(.none)
                .keyboardType(.URL)
                #endif
                .disableAutocorrection(true)
            TextField("fiókazonosító", text: $account)
                .textFieldStyle(.roundedBorder)
                #if os(iOS)
                .autocapitalization(.none)
                #endif
                .disableAutocorrection(true)
            SecureField("jelszó (legalább 10 karakter)", text: $password)
                .textFieldStyle(.roundedBorder)
            HStack {
                Button("Belépés") { run { try await signIn() } }
                    .buttonStyle(.borderedProminent).disabled(busy)
                Button("Új fiók") { run { try await signUp() } }
                    .buttonStyle(.bordered).disabled(busy)
            }
            Text("Kijelentkezni bármikor lehet, és egyetlen blokkot sem visz el — a szinkron nem kibúvó.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func signedIn(_ acc: SyncAccount) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("\(acc.accountId) — ez az eszköz: \(acc.deviceName)")
                .font(.footnote)
            Text(acc.lastSyncAt == nil ? "Még nem volt szinkron." : "Legutóbbi szinkron: \(clock(acc.lastSyncAt!))")
                .font(.footnote).foregroundStyle(.secondary)
            if let res = devices {
                // Elöl az ÖSSZESÍTETT szám: nem az, hogy mennyi ment el a
                // gépen és külön mennyi máshol, hanem hogy mennyi összesen.
                // Egy eszköznél nincs mit összesíteni, ott csak zaj lenne.
                if res.combined.deviceCount > 1 {
                    deviceBlock(
                        title: "Mind a(z) \(res.combined.deviceCount) eszköz együtt",
                        today: res.combined.todaySeconds,
                        week: res.combined.last7Seconds,
                        top: res.combined.top,
                        emphasis: true
                    )
                }
                ForEach(res.devices) { d in
                    deviceBlock(
                        title: d.isSelf ? "\(d.name) (ez az eszköz)" : d.name,
                        today: d.todaySeconds,
                        week: d.last7Seconds,
                        top: d.top,
                        emphasis: false
                    )
                }
                // Az iPhone maga NEM mér, és ezt ki kell mondani: enélkül a
                // nulla óra úgy nézne ki, mint egy hiba. Az Apple nem enged
                // appnak hozzáférni ahhoz, hogy más appokban mennyi idő telik.
                Text("Ez a készülék nem mér időt — az Apple ezt nem engedi appnak. A fenti számokat a géped és az androidos telefonod mérte.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            HStack {
                Button("Szinkronizálás most") { run { try await syncNow() } }
                    .buttonStyle(.borderedProminent).disabled(busy)
                Button("Eszközök és idejük") { run { devices = try await SyncClient.devices(store.state) } }
                    .buttonStyle(.bordered).disabled(busy)
                // Nincs megerősítés: a kijelentkezés nem visz el semmit. Egy
                // „biztos?” azt sugallná, hogy veszélyes.
                Button("Kijelentkezés") {
                    _ = store.mutate { $0 = SyncClient.signOut($0) }
                    devices = nil
                }.disabled(busy)
            }
        }
    }

    /// Egy eszköz (vagy az összes együtt) egy blokkban: mai idő, heti idő, és a
    /// hét három legtöbb időt vivő célpontja.
    private func deviceBlock(
        title: String, today: Double, week: Double,
        top: [UsageStats.Target], emphasis: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title).font(.footnote).fontWeight(emphasis ? .semibold : .regular)
                Spacer()
                Text("ma \(UsageStats.formatDuration(today)) · 7 nap \(UsageStats.formatDuration(week))")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(top, id: \.key) { t in
                HStack {
                    Text(siteLabel(t.label)).font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                    Text(UsageStats.formatDuration(t.seconds))
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.top, 4)
    }

    // MARK: - műveletek

    private func run(_ work: @escaping () async throws -> Void) {
        if busy { return }
        busy = true
        localError = nil
        Task {
            do { try await work() } catch { localError = error.localizedDescription }
            busy = false
        }
    }

    private func signIn() async throws {
        let next = try await SyncClient.signIn(
            state: store.state, serverUrl: server, accountId: account.trimmed(),
            password: password, deviceName: deviceName()
        )
        _ = store.mutate { $0 = next }
        password = ""
        try await syncNow()
    }

    private func signUp() async throws {
        let (next, code) = try await SyncClient.signUp(
            state: store.state, serverUrl: server, accountId: account.trimmed(),
            password: password, deviceName: deviceName()
        )
        _ = store.mutate { $0 = next }
        password = ""
        try await syncNow()
        recoveryCode = code
    }

    private func syncNow() async throws {
        let r = try await SyncClient.syncNow(store.state, now: Date().timeIntervalSince1970 * 1000)
        _ = store.mutate { $0 = r.state }
    }

    private func deviceName() -> String {
        #if os(iOS)
        return UIDevice.current.name
        #else
        return Host.current().localizedName ?? "Mac"
        #endif
    }

    private func clock(_ ms: Double) -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
}

private extension String {
    func trimmed() -> String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
