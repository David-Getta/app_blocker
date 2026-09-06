import Foundation

/// A szinkron kliensoldala iPhone-on és macOS-en — a
/// `desktop/src/helper/sync-client.ts` tükre.
///
/// A kör mindig ugyanaz:
///
///   1. LEHÚZ a kiszolgálóról (titkosított blob) és visszafejt;
///   2. ÖSSZEFÉSÜL a helyivel ([SyncMerge]) — ez sosem lazít;
///   3. FELTÖLT, ha lett változás, arra a verzióra hivatkozva, amit lehúzott.
///
/// Ha közben más eszköz írt, a kiszolgáló elutasítja és visszaadja az
/// aktuálisat: akkor újra a 2. lépéstől. Így két eszköz párhuzamos írása sosem
/// tünteti el a másikét.
enum SyncClient {

    static let timeout: TimeInterval = 15
    private static let maxConflictRetries = 3
    private static let maxPayloadBytes = 1_000_000
    private static let protocolVersion = 1

    struct SyncError: LocalizedError {
        let message: String
        let code: String
        var errorDescription: String? { message }
        init(_ message: String, _ code: String = "SYNC") {
            self.message = message
            self.code = code
        }
    }

    // MARK: - HTTP

    private static func call(_ serverUrl: String, _ path: String, _ body: [String: Any]) async throws -> [String: Any] {
        guard let url = URL(string: serverUrl + path) else {
            throw SyncError("Hibás kiszolgáló-cím.", "BAD_URL")
        }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        var payload = body
        payload["protocol"] = protocolVersion
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw SyncError("A kiszolgáló nem érhető el: \(error.localizedDescription)", "OFFLINE")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SyncError("A kiszolgáló nem JSON-t küldött — biztos jó a cím?", "BAD_SERVER")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        // A 409 nem hiba, hanem a protokoll része: „közben más írt”.
        if status >= 400 && status != 409 {
            throw SyncError(
                json["error"] as? String ?? "Hiba a kiszolgálón (\(status)).",
                json["code"] as? String ?? "SERVER"
            )
        }
        return json
    }

    /// A megadott cím ésszerűsége. Csak http/https.
    static func normalizeServerUrl(_ raw: String) throws -> String {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { throw SyncError("Ez nem tűnik érvényes kiszolgáló-címnek.", "BAD_URL") }
        var scheme: String?
        if let range = text.range(of: "^[a-zA-Z][a-zA-Z0-9+.-]*://", options: .regularExpression) {
            scheme = String(text[range]).replacingOccurrences(of: "://", with: "").lowercased()
        }
        if let s = scheme, s != "http", s != "https" {
            throw SyncError("Csak http vagy https cím adható meg.", "BAD_URL")
        }
        let withScheme = scheme == nil ? "https://\(text)" : text
        guard let u = URL(string: withScheme), let host = u.host else {
            throw SyncError("Ez nem tűnik érvényes kiszolgáló-címnek.", "BAD_URL")
        }
        let port = u.port.map { ":\($0)" } ?? ""
        return "\(u.scheme ?? "https")://\(host)\(port)"
    }

    // MARK: - fiók

    private static func newDeviceId() -> String {
        "dev_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(18)
    }

    /// Regisztráció. A visszakapott helyreállító kódot EGYSZER kell megmutatni.
    static func signUp(
        state: AppState, serverUrl: String, accountId: String, password: String, deviceName: String
    ) async throws -> (AppState, String) {
        let url = try normalizeServerUrl(serverUrl)
        if password.count < SyncCrypto.minPasswordLength {
            throw SyncError(
                "A jelszó legalább \(SyncCrypto.minPasswordLength) karakter legyen.", "WEAK_PASSWORD"
            )
        }
        let root = try SyncCrypto.rootKey(password: password, accountId: accountId)
        let dataKey = SyncCrypto.newDataKey()
        let recoveryCode = SyncCrypto.newRecoveryCode()
        let authKey = Data(SyncCrypto.subKey(root, "auth")).base64EncodedString()
        _ = try await call(url, "/v1/signup", [
            "accountId": accountId,
            "authKey": authKey,
            "recoveryAuthKey": try SyncCrypto.recoveryAuthKey(recoveryCode),
            "wrappedByPassword": try SyncCrypto.wrapDataKey(SyncCrypto.subKey(root, "kek"), dataKey),
            "wrappedByRecovery": try SyncCrypto.wrapDataKey(try SyncCrypto.recoveryKey(recoveryCode), dataKey),
        ])
        var next = state
        next.sync = SyncAccount(
            serverUrl: url, accountId: accountId, deviceId: newDeviceId(), authKey: authKey,
            dataKey: Data(dataKey).base64EncodedString(), deviceName: deviceName
        )
        return (next, recoveryCode)
    }

    static func signIn(
        state: AppState, serverUrl: String, accountId: String, password: String, deviceName: String
    ) async throws -> AppState {
        let url = try normalizeServerUrl(serverUrl)
        let authKey = try SyncCrypto.authKey(password: password, accountId: accountId)
        let deviceId = state.sync?.accountId == accountId ? state.sync!.deviceId : newDeviceId()
        let res = try await call(url, "/v1/signin", [
            "accountId": accountId, "authKey": authKey, "deviceId": deviceId,
        ])
        guard let wrapped = res["wrappedByPassword"] as? String else {
            throw SyncError("A kiszolgáló nem adta vissza a kulcsot.", "BAD_SERVER")
        }
        let dataKey = try SyncCrypto.unlockWithPassword(
            accountId: accountId, password: password, wrapped: wrapped
        )
        var next = state
        next.sync = SyncAccount(
            serverUrl: url, accountId: accountId, deviceId: deviceId, authKey: authKey,
            dataKey: Data(dataKey).base64EncodedString(), deviceName: deviceName
        )
        return next
    }

    /// Kijelentkezés. SEMMIT nem töröl a blokklistából — különben ez lenne a
    /// világ legegyszerűbb feloldása.
    static func signOut(_ state: AppState) -> AppState {
        var next = state
        next.sync = nil
        return next
    }

    // MARK: - szinkron

    private static func toSyncSites(_ sites: [Site]) -> [SyncMerge.SyncSite] {
        // A SZÜNET szándékosan kimarad: egy próbatétel egy eszközön nem oldhat
        // fel mindenhol, és egy ÚJ eszköznek nincs saját, szigorúbb rekordja,
        // amivel védekezhetne — ezért fel se megy.
        sites.map { s in
            SyncMerge.SyncSite(
                id: s.id, domain: s.domain, hostnames: s.hostnames, addedAt: s.addedAt,
                pendingDeleteAt: s.pendingDeleteAt, schedule: s.schedule,
                // A napi keret iPhone-on nem érvényesül, de HORDOZZUK: ha a
                // gépen beállítottak egyet, a telefon szinkronja nem törölheti
                // le. Enélkül elég lenne egyszer megnyitni a telefont ahhoz,
                // hogy a keret eltűnjön a gépről is.
                dailyLimitSeconds: s.dailyLimitSeconds,
                // Az adag-szabály ugyanígy hordozott: itt nem érvényesül, de
                // ha kimaradna, egy iPhone-os szerkesztés (nagyobb rev-vel)
                // letörölné a gépeken beállított szabályt.
                burstSeconds: s.burstSeconds, cooldownSeconds: s.cooldownSeconds,
                alias: s.alias,
                // Ugyanez a hordozás a részleges szabályokra: itt sem
                // érvényesülnek, de a telefon nem törölheti le őket a gépről.
                rules: s.rules,
                rev: max(s.rev ?? 1, 1), updatedAt: s.updatedAt ?? s.addedAt,
                updatedBy: s.updatedBy ?? "",
                // A jelek is hordozottak: a gépen kifizetett levétel nyoma.
                hostnameMarks: s.hostnameMarks
            )
        }
    }

    private static func fromSyncSites(_ merged: [SyncMerge.SyncSite], _ local: [Site]) -> [Site] {
        var byId: [String: Site] = [:]
        for s in local { byId[s.id] = s }
        return merged.map { m in
            var out = Site(
                id: m.id, domain: m.domain, hostnames: m.hostnames, addedAt: m.addedAt,
                // A szünet a HELYI marad: se fel nem megy, se felül nem íródik.
                pauseUntil: byId[m.id]?.pauseUntil,
                pendingDeleteAt: m.pendingDeleteAt,
                schedule: m.schedule, alias: m.alias,
                dailyLimitSeconds: m.dailyLimitSeconds,
                burstSeconds: m.burstSeconds, cooldownSeconds: m.cooldownSeconds,
                rules: m.rules
            )
            out.rev = m.rev
            out.updatedAt = m.updatedAt
            out.updatedBy = m.updatedBy
            out.hostnameMarks = m.hostnameMarks
            out.revFp = SyncRevisions.fingerprint(out)
            return out
        }
    }

    struct SyncResult {
        let state: AppState
        let changed: Bool
        let devices: Int
    }

    /// Egy teljes szinkron-kör.
    /// A munkamenet szinkronja: csomagok + a futó menet.
    ///
    /// Ugyanaz a menet, mint a blokklistánál — húzd le, fésüld össze, told fel.
    /// A különbség az összefésülés szabályában van (`FocusSync`): ott a
    /// szigorúbb nyer, és lazítani csak nagyobb `rev` tud.
    private static func syncFocusRound(
        _ state: AppState, _ acc: SyncAccount, _ key: [UInt8]
    ) async throws -> AppState {
        var current = state
        for attempt in 0...maxConflictRetries {
            let pulled = try await call(acc.serverUrl, "/v1/pull", [
                "accountId": acc.accountId, "authKey": acc.authKey, "collection": "focus",
            ])
            let version = pulled["version"] as? Int ?? 0
            // Egy sérült blob ÜRES állapot, nem kivétel: ha itt elhasalnánk, egy
            // elrontott bájt megállítaná az egész szinkront — a blokklistáét is.
            var remote = FocusSync.SyncFocus(updatedBy: acc.deviceId)
            if let blob = pulled["payload"] as? String,
               let text = try? SyncCrypto.decrypt(key, blob),
               let decoded = try? JSONDecoder().decode(
                   FocusSync.SyncFocus.self, from: Data(text.utf8)) {
                remote = FocusSync.normalize(decoded, fallbackDevice: acc.deviceId)
            }

            let mine = FocusSync.SyncFocus(
                packs: current.focusPacks ?? [],
                run: current.focusRun,
                log: current.focusLog ?? [],
                rev: current.focusRev ?? 0,
                updatedAt: current.focusUpdatedAt ?? 0,
                updatedBy: current.focusUpdatedBy ?? acc.deviceId,
                packMarks: current.focusPackMarks
            )
            let merged = FocusSync.merge(mine, remote)

            if !FocusSync.same(merged, mine) {
                current.focusPacks = merged.packs
                current.focusRun = merged.run
                // A jelek az összefésülés eredményéből: az iPhone hordozza őket.
                current.focusPackMarks = merged.packMarks
                // A NAPLÓ a többi eszköztől is megjön — ettől lesz a
                // statisztika a fiók egészéről szóló szám. Egyesítés, tehát a
                // helyi sorok nem vesznek el.
                current.focusLog = FocusSync.mergeLog(merged.log, current.focusLog ?? [])
                current.focusRev = merged.rev
                current.focusUpdatedAt = merged.updatedAt
                current.focusUpdatedBy = merged.updatedBy
                // A lenyomatot ÚJRASZÁMOLJUK, nem a másik eszközét vesszük át:
                // enélkül a következő mentés fölöslegesen léptetné a számlálót,
                // és a két eszköz örökké írogatná egymást.
                current = SyncRevisions.adoptFocus(current)
            }
            if FocusSync.same(merged, remote) && version > 0 { return current }

            let encoded = try JSONEncoder().encode(merged)
            let payload = try SyncCrypto.encrypt(key, String(decoding: encoded, as: UTF8.self))
            if payload.utf8.count > maxPayloadBytes {
                throw SyncError("A munkamenet adatai túl nagyok a szinkronhoz — a csomagok vagy a napló. "
                    + "A menet ettől még fut, csak a többi eszközre nem ér át.", "TOO_BIG")
            }
            let push = try await call(acc.serverUrl, "/v1/push", [
                "accountId": acc.accountId, "authKey": acc.authKey, "collection": "focus",
                "deviceId": acc.deviceId, "baseVersion": version, "payload": payload,
                "nameBlob": try SyncCrypto.encrypt(key, acc.deviceName),
            ])
            if push["ok"] as? Bool == true { return current }
            if attempt == maxConflictRetries {
                throw SyncError("A munkamenet szinkronja nem tudott lezárulni.", "CONFLICT")
            }
        }
        return current
    }

    static func syncNow(_ state: AppState, now: Double) async throws -> SyncResult {
        guard let acc = state.sync else { throw SyncError("Nincs bejelentkezve.", "NO_ACCOUNT") }
        guard let keyData = Data(base64Encoded: acc.dataKey) else {
            throw SyncError("Sérült helyi kulcs — jelentkezz be újra.", "BAD_KEY")
        }
        let key = Array(keyData)
        var current = SyncRevisions.bump(state, now: now)
        var changed = current.sites != state.sites

        for attempt in 0...maxConflictRetries {
            let pulled = try await call(acc.serverUrl, "/v1/pull", [
                "accountId": acc.accountId, "authKey": acc.authKey, "collection": "sites",
            ])
            let version = pulled["version"] as? Int ?? 0
            var remote: [SyncMerge.SyncSite] = []
            if let blob = pulled["payload"] as? String {
                let text = try SyncCrypto.decrypt(key, blob)
                remote = (try? JSONDecoder().decode([SyncMerge.SyncSite].self, from: Data(text.utf8))) ?? []
            }
            let mine = toSyncSites(current.sites)
            let merged = SyncMerge.mergeLists(mine, remote)

            if merged != mine {
                current.sites = fromSyncSites(merged, current.sites)
                changed = true
            }
            if merged == remote && version > 0 { break } // a kiszolgálón már ez van

            let encoded = try JSONEncoder().encode(merged)
            let payload = try SyncCrypto.encrypt(key, String(decoding: encoded, as: UTF8.self))
            if payload.utf8.count > maxPayloadBytes {
                throw SyncError("A blokklista túl nagy a szinkronhoz.", "TOO_BIG")
            }
            let push = try await call(acc.serverUrl, "/v1/push", [
                "accountId": acc.accountId, "authKey": acc.authKey, "collection": "sites",
                "deviceId": acc.deviceId, "baseVersion": version, "payload": payload,
                "nameBlob": try SyncCrypto.encrypt(key, acc.deviceName),
            ])
            if push["ok"] as? Bool == true { break }
            if attempt == maxConflictRetries {
                throw SyncError("A szinkron nem tudott lezárulni: egy másik eszköz épp ír.", "CONFLICT")
            }
        }

        // A MUNKAMENET. A blokklista után megy, mert az a fontosabb: ha a kör
        // itt hasal el, a tiltás attól már szinkronban van.
        // NEM NÉMÁN. Egy RÉGI fiókkiszolgáló nem ismeri a `focus` gyűjteményt,
        // és 400-zal felel — a munkamenet ilyenkor sosem ér át, és a
        // felhasználó ezt semmiből nem tudná meg. Azt hinné, a funkció rossz.
        //
        // A kört ettől még nem állítjuk meg: a blokklista fontosabb, és az már
        // szinkronban van. Csak megjegyezzük, hogy a felület kiírhassa.
        do {
            var after = try await syncFocusRound(current, acc, key)
            if after != current { changed = true }
            if after.focusSyncError != nil {
                after.focusSyncError = nil
                changed = true
            }
            current = after
        } catch {
            let code = (error as? SyncError)?.code
            let msg: String
            if code == "BAD_REQUEST" || code == "SERVER" {
                msg = "A fiókkiszolgálód nem ismeri a munkamenetet — valószínűleg "
                    + "régebbi verzió. Amíg nem frissül, a munkamenet csak ezen "
                    + "az eszközön él."
            } else {
                msg = (error as? SyncError)?.message ?? "A munkamenet szinkronja nem sikerült."
            }
            if current.focusSyncError != msg {
                current.focusSyncError = msg
                changed = true
            }
        }

        // A mai összegzés a többi eszközről — ebből lesz a KÖZÖS napi keret.
        //
        // iPhone-on nem MÉRÜNK, tehát nincs mit feltölteni; csak lehozunk. Ha ez
        // elhasal, a keret ugyanúgy viselkedik, mint korábban (vagyis itt nem
        // tilt) — nem lazább annál, mint ami eddig is volt.
        if let shared = try? await pullSharedToday(acc, key) {
            current.sharedToday = shared
            changed = true
        }

        var devices = 0
        // A többi eszköz száma nem kritikus: ha ez elhasal, a blokklista attól
        // már szinkronban van.
        if let all = try? await call(acc.serverUrl, "/v1/usage-all", [
            "accountId": acc.accountId, "authKey": acc.authKey,
        ]) {
            devices = (all["devices"] as? [[String: Any]])?.count ?? 0
        }

        var account = acc
        account.lastSyncAt = now
        account.lastError = nil
        current.sync = account
        return SyncResult(state: current, changed: changed, devices: devices)
    }

    /// A többi eszköz mai összegzése, visszafejtve.
    ///
    /// A `deviceId` a KISZOLGÁLÓTÓL jön, nem a blob belsejéből: így egy eszköz
    /// nem beszélhet a másik nevében — például a miénkében, amivel a saját
    /// sorunk kihagyását kerülné meg.
    private static func pullSharedToday(
        _ acc: SyncAccount, _ key: [UInt8]
    ) async throws -> LimitLogic.SharedToday {
        let all = try await call(acc.serverUrl, "/v1/today-all", [
            "accountId": acc.accountId, "authKey": acc.authKey,
        ])
        var devices: [LimitLogic.TodayDigest] = []
        for row in (all["devices"] as? [[String: Any]]) ?? [] {
            guard let deviceId = row["deviceId"] as? String, !deviceId.isEmpty,
                  deviceId != acc.deviceId,
                  let blob = row["payload"] as? String, !blob.isEmpty else { continue }
            // Rekordonként tűrünk: egy sérült sor ne vigye el a többi eszközét.
            guard let text = try? SyncCrypto.decrypt(key, blob),
                  let obj = (try? JSONSerialization.jsonObject(with: Data(text.utf8)))
                      as? [String: Any] else { continue }
            let seconds = (obj["seconds"] as? [String: Any])?.compactMapValues { $0 as? Double }
            if let d = LimitLogic.normalizeTodayDigest(
                day: obj["day"] as? String, seconds: seconds, deviceId: deviceId
            ) {
                devices.append(d)
            }
        }
        return LimitLogic.SharedToday(selfDeviceId: acc.deviceId, devices: devices)
    }

    struct DeviceInfo: Identifiable {
        let id: String
        let name: String
        let isSelf: Bool
        let todaySeconds: Double
        let last7Seconds: Double
        /// A hét három legtöbb időt vivő célpontja azon az eszközön.
        ///
        /// A címke NYERS. Hogy fedőnév kerül-e a helyére, vagy a
        /// „rejtett oldal” felirat, azt a felület dönti el: a kliens nem
        /// tudhatja, hogy a listát épp rejtik-e.
        let top: [UsageStats.Target]
    }

    /// Minden eszköz EGYÜTT.
    ///
    /// Ez az a szám, ami tényleg számít: nem az, hogy mennyi ment el a gépen és
    /// külön mennyi az androidos telefonon, hanem hogy MENNYI ÖSSZESEN.
    struct CombinedInfo {
        let deviceCount: Int
        let todaySeconds: Double
        let last7Seconds: Double
        let top: [UsageStats.Target]
        /// A MAI nap toplistája, minden eszköz méréséből együtt. A címke itt
        /// is NYERS — a fedőnév és a rejtés a felület dolga.
        let topToday: [UsageStats.Target]
    }

    struct DevicesResult {
        let combined: CombinedInfo
        let devices: [DeviceInfo]
    }

    /// A fiókhoz tartozó eszközök és a mérésük — a nevük is titkosítva jön.
    ///
    /// iPhone-on ez a statisztika EGYETLEN forrása: az Apple nem enged mérni
    /// más appokban töltött időt, a gép és az androidos telefon viszont mér, és
    /// azt a fiókon át ide is elhozza.
    static func devices(_ state: AppState, now: Date = Date()) async throws -> DevicesResult {
        guard let acc = state.sync, let keyData = Data(base64Encoded: acc.dataKey) else {
            throw SyncError("Nincs bejelentkezve.", "NO_ACCOUNT")
        }
        let key = Array(keyData)
        let all = try await call(acc.serverUrl, "/v1/usage-all", [
            "accountId": acc.accountId, "authKey": acc.authKey,
        ])
        let list = all["devices"] as? [[String: Any]] ?? []
        var usages: [UsageStats.State] = []
        let infos: [DeviceInfo] = list.compactMap { d in
            guard let id = d["deviceId"] as? String else { return nil }
            let blob = d["nameBlob"] as? String ?? ""
            // Rekordonként tűrünk: egy sérült név vagy mérés ne vigye el a
            // többi eszközt.
            let name = blob.isEmpty ? id : ((try? SyncCrypto.decrypt(key, blob)) ?? id)
            var summary: UsageStats.Summary?
            if let payload = d["payload"] as? String,
               let text = try? SyncCrypto.decrypt(key, payload),
               let usage = UsageStats.parse(text) {
                usages.append(usage)
                summary = UsageStats.summarize(usage, now: now)
            }
            return DeviceInfo(
                id: id, name: name, isSelf: id == acc.deviceId,
                todaySeconds: summary?.todaySeconds ?? 0,
                last7Seconds: summary?.last7Seconds ?? 0,
                top: summary?.top ?? []
            )
        }
        // Az összesítés UGYANAZON a `summarize`-on megy át, mint az
        // eszközönkénti — csak előbb egyetlen állapottá fésüljük a blobokat.
        let together = UsageStats.summarize(UsageStats.combine(usages), now: now)
        return DevicesResult(
            combined: CombinedInfo(
                deviceCount: infos.count,
                todaySeconds: together.todaySeconds,
                last7Seconds: together.last7Seconds,
                top: together.top,
                topToday: together.topToday
            ),
            devices: infos
        )
    }
}
