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
                dailyLimitSeconds: s.dailyLimitSeconds, alias: s.alias,
                rev: max(s.rev ?? 1, 1), updatedAt: s.updatedAt ?? s.addedAt,
                updatedBy: s.updatedBy ?? ""
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
                dailyLimitSeconds: m.dailyLimitSeconds
            )
            out.rev = m.rev
            out.updatedAt = m.updatedAt
            out.updatedBy = m.updatedBy
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

    struct DeviceInfo: Identifiable {
        let id: String
        let name: String
        let isSelf: Bool
    }

    /// A fiókhoz tartozó eszközök — a nevük is titkosítva jön.
    static func devices(_ state: AppState) async throws -> [DeviceInfo] {
        guard let acc = state.sync, let keyData = Data(base64Encoded: acc.dataKey) else {
            throw SyncError("Nincs bejelentkezve.", "NO_ACCOUNT")
        }
        let key = Array(keyData)
        let all = try await call(acc.serverUrl, "/v1/usage-all", [
            "accountId": acc.accountId, "authKey": acc.authKey,
        ])
        let list = all["devices"] as? [[String: Any]] ?? []
        return list.compactMap { d in
            guard let id = d["deviceId"] as? String else { return nil }
            let blob = d["nameBlob"] as? String ?? ""
            // Rekordonként tűrünk: egy sérült név ne vigye el a többi eszközt.
            let name = blob.isEmpty ? id : ((try? SyncCrypto.decrypt(key, blob)) ?? id)
            return DeviceInfo(id: id, name: name, isSelf: id == acc.deviceId)
        }
    }
}
