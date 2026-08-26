package hu.breaker.app.core

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/**
 * A szinkron kliensoldala Androidon — a `desktop/src/helper/sync-client.ts`
 * tükre.
 *
 * A kör mindig ugyanaz:
 *
 *   1. LEHÚZ a kiszolgálóról (titkosított blob) és visszafejt;
 *   2. ÖSSZEFÉSÜL a helyivel ([SyncMerge]) — ez sosem lazít;
 *   3. FELTÖLT, ha lett változás, arra a verzióra hivatkozva, amit lehúzott.
 *
 * Ha közben más eszköz írt, a kiszolgáló elutasítja és visszaadja az
 * aktuálisat: akkor újra a 2. lépéstől. Így két eszköz párhuzamos írása sosem
 * tünteti el a másikét.
 *
 * Minden hívás BLOKKOL — a hívó dolga háttérszálra tenni. Nincs benne se
 * OkHttp, se Retrofit: `HttpURLConnection` bőven elég ennyihez, és nem növeli
 * a telepítő méretét.
 */
object SyncClient {

    /** Ennél tovább egy kör nem tarthat. */
    const val TIMEOUT_MS = 15_000

    private const val MAX_CONFLICT_RETRIES = 3
    private const val MAX_PAYLOAD_BYTES = 1_000_000
    private const val PROTOCOL = 1

    class SyncException(message: String, val code: String = "SYNC") : Exception(message)

    // ------------------------------------------------------------------ HTTP

    private fun call(serverUrl: String, path: String, body: JSONObject): JSONObject {
        body.put("protocol", PROTOCOL)
        val conn = (URL(serverUrl + path).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            doOutput = true
            setRequestProperty("content-type", "application/json")
        }
        try {
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val status = conn.responseCode
            // A 409 nem hiba, hanem a protokoll része: „közben más írt”.
            val stream = if (status < 400 || status == 409) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            val json = runCatching { JSONObject(text) }.getOrNull()
                ?: throw SyncException("A kiszolgáló nem JSON-t küldött — biztos jó a cím?", "BAD_SERVER")
            if (status >= 400 && status != 409) {
                throw SyncException(
                    json.optString("error", "Hiba a kiszolgálón ($status)."),
                    json.optString("code", "SERVER"),
                )
            }
            return json
        } catch (e: SyncException) {
            throw e
        } catch (e: Exception) {
            throw SyncException("A kiszolgáló nem érhető el: ${e.message}", "OFFLINE")
        } finally {
            conn.disconnect()
        }
    }

    /** A megadott cím ésszerűsége. Csak http/https. */
    fun normalizeServerUrl(raw: String): String {
        val text = raw.trim()
        if (text.isEmpty()) throw SyncException("Ez nem tűnik érvényes kiszolgáló-címnek.", "BAD_URL")
        val scheme = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*)://").find(text)?.groupValues?.get(1)
        if (scheme != null && !scheme.equals("http", true) && !scheme.equals("https", true)) {
            throw SyncException("Csak http vagy https cím adható meg.", "BAD_URL")
        }
        val withScheme = if (scheme != null) text else "https://$text"
        val url = runCatching { URL(withScheme) }.getOrNull()
            ?: throw SyncException("Ez nem tűnik érvényes kiszolgáló-címnek.", "BAD_URL")
        val port = if (url.port == -1) "" else ":${url.port}"
        return "${url.protocol}://${url.host}$port"
    }

    // ------------------------------------------------------------------ fiók

    private fun newDeviceId() = "dev_" + UUID.randomUUID().toString().replace("-", "").take(18)

    /** Regisztráció. A visszakapott helyreállító kódot EGYSZER kell megmutatni. */
    fun signUp(
        state: AppState, serverUrl: String, accountId: String, password: String, deviceName: String,
    ): Pair<AppState, String> {
        val url = normalizeServerUrl(serverUrl)
        if (password.length < SyncCrypto.MIN_PASSWORD_LENGTH) {
            throw SyncException(
                "A jelszó legalább ${SyncCrypto.MIN_PASSWORD_LENGTH} karakter legyen.",
                "WEAK_PASSWORD",
            )
        }
        val root = SyncCrypto.rootKey(password, accountId)
        val dataKey = ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }
        val recoveryCode = newRecoveryCode()
        val authKey = SyncCrypto.b64(SyncCrypto.subKey(root, "auth"))
        call(url, "/v1/signup", JSONObject().apply {
            put("accountId", accountId)
            put("authKey", authKey)
            put("recoveryAuthKey", SyncCrypto.recoveryAuthKey(recoveryCode))
            put("wrappedByPassword", SyncCrypto.wrapDataKey(SyncCrypto.subKey(root, "kek"), dataKey))
            put("wrappedByRecovery", SyncCrypto.wrapDataKey(SyncCrypto.recoveryKey(recoveryCode), dataKey))
        })
        val account = SyncAccount(
            serverUrl = url, accountId = accountId, deviceId = newDeviceId(),
            authKey = authKey, dataKey = SyncCrypto.b64(dataKey), deviceName = deviceName,
        )
        return state.copy(sync = account) to recoveryCode
    }

    fun signIn(
        state: AppState, serverUrl: String, accountId: String, password: String, deviceName: String,
    ): AppState {
        val url = normalizeServerUrl(serverUrl)
        val authKey = SyncCrypto.authKey(password, accountId)
        val deviceId = if (state.sync?.accountId == accountId) state.sync.deviceId else newDeviceId()
        val res = call(url, "/v1/signin", JSONObject().apply {
            put("accountId", accountId); put("authKey", authKey); put("deviceId", deviceId)
        })
        val dataKey = SyncCrypto.unlockWithPassword(accountId, password, res.getString("wrappedByPassword"))
        return state.copy(sync = SyncAccount(
            serverUrl = url, accountId = accountId, deviceId = deviceId, authKey = authKey,
            dataKey = SyncCrypto.b64(dataKey), deviceName = deviceName,
        ))
    }

    /**
     * Kijelentkezés.
     *
     * SEMMIT nem töröl a blokklistából. Ha törölne, a kijelentkezés lenne a
     * világ legegyszerűbb feloldása — pont az ellen szól az egész app.
     */
    fun signOut(state: AppState): AppState = state.copy(sync = null)

    // -------------------------------------------------------------- szinkron

    private fun toSyncSites(sites: List<Site>): List<SyncMerge.SyncSite> = sites.map { s ->
        // A SZÜNET szándékosan kimarad: egy próbatétel egy eszközön nem oldhat
        // fel mindenhol, és egy ÚJ eszköznek nincs saját, szigorúbb rekordja,
        // amivel védekezhetne — ezért fel se megy.
        SyncMerge.SyncSite(
            id = s.id, domain = s.domain, hostnames = s.hostnames, addedAt = s.addedAt,
            pendingDeleteAt = s.pendingDeleteAt, schedule = s.schedule,
            dailyLimitSeconds = s.dailyLimitSeconds, alias = s.alias, rules = s.rules,
            rev = maxOf(s.rev, 1), updatedAt = s.updatedAt, updatedBy = s.updatedBy,
        )
    }

    private fun fromSyncSites(merged: List<SyncMerge.SyncSite>, local: List<Site>): List<Site> {
        val byId = local.associateBy { it.id }
        return merged.map { m ->
            val mine = byId[m.id]
            SyncRevisions.adopt(
                Site(
                    id = m.id, domain = m.domain, hostnames = m.hostnames, addedAt = m.addedAt,
                    // A szünet a HELYI marad: se fel nem megy, se felül nem íródik.
                    pauseUntil = mine?.pauseUntil,
                    pendingDeleteAt = m.pendingDeleteAt,
                    schedule = m.schedule, dailyLimitSeconds = m.dailyLimitSeconds,
                    alias = m.alias, rules = m.rules,
                    rev = m.rev, updatedAt = m.updatedAt, updatedBy = m.updatedBy,
                )
            )
        }
    }

    /**
     * A feltöltött alak.
     *
     * `internal`, hogy tesztelhető legyen: a mezőnevek és a menetrend-módok
     * SZÖVEGESEN egyeznek a TypeScript oldallal, és egy elgépelés itt nem
     * fordítási hiba lenne, hanem csendes félreértés a másik eszközön.
     */
    internal fun sitesToJson(sites: List<SyncMerge.SyncSite>): String {
        val arr = JSONArray()
        for (s in sites) {
            arr.put(JSONObject().apply {
                put("id", s.id); put("domain", s.domain)
                put("hostnames", JSONArray(s.hostnames))
                put("addedAt", s.addedAt)
                put("pauseUntil", JSONObject.NULL)
                put("pendingDeleteAt", s.pendingDeleteAt ?: JSONObject.NULL)
                if (s.schedule != null) put("schedule", JSONObject().apply {
                    put("mode", when (s.schedule.mode) {
                        ScheduleLogic.Mode.ALWAYS -> "always"
                        ScheduleLogic.Mode.SCHEDULED_BLOCK -> "scheduled_block"
                        ScheduleLogic.Mode.SCHEDULED_ALLOW -> "scheduled_allow"
                    })
                    put("bands", JSONArray(s.schedule.bands.map { b ->
                        JSONObject().apply {
                            put("days", JSONArray(b.days.toList()))
                            put("startMin", b.startMin); put("endMin", b.endMin)
                        }
                    }))
                })
                if (s.dailyLimitSeconds != null) put("dailyLimitSeconds", s.dailyLimitSeconds)
                if (s.alias != null) put("alias", s.alias)
                // A kulcs csak akkor kerül bele, ha VAN mit mondani: a hiányzó
                // kulcs azt jelenti, hogy nincs tudomásunk szabályokról, az
                // üres tömb azt, hogy voltak és levették. A kettő nem cserélhető
                // fel (lásd SyncMerge.mergeRules).
                if (s.rules != null) put("rules", JSONArray(s.rules.map { r ->
                    JSONObject().apply { put("host", r.host); put("path", r.path) }
                }))
                put("rev", s.rev); put("updatedAt", s.updatedAt); put("updatedBy", s.updatedBy)
            })
        }
        return arr.toString()
    }

    internal fun sitesFromJson(text: String): List<SyncMerge.SyncSite> {
        val arr = JSONArray(text)
        val out = mutableListOf<SyncMerge.SyncSite>()
        for (i in 0 until arr.length()) {
            // Rekordonként tűrünk: egy sérült sor ne vigye el a többi oldalt.
            runCatching {
                val o = arr.getJSONObject(i)
                val hosts = o.getJSONArray("hostnames")
                out.add(SyncMerge.SyncSite(
                    id = o.getString("id"),
                    domain = o.getString("domain"),
                    hostnames = (0 until hosts.length()).map { hosts.getString(it) },
                    addedAt = o.getLong("addedAt"),
                    pendingDeleteAt = if (o.isNull("pendingDeleteAt")) null else o.getLong("pendingDeleteAt"),
                    schedule = if (o.isNull("schedule")) null else scheduleFromJson(o.getJSONObject("schedule")),
                    dailyLimitSeconds = if (o.isNull("dailyLimitSeconds")) null else o.getLong("dailyLimitSeconds"),
                    alias = AliasLogic.normalize(if (o.isNull("alias")) null else o.optString("alias")),
                    rules = rulesFromJson(o),
                    rev = o.optInt("rev", 1),
                    updatedAt = o.optLong("updatedAt", 0),
                    updatedBy = o.optString("updatedBy", ""),
                ))
            }
        }
        return out
    }

    // ------------------------------------------------------------ munkamenet

    internal fun focusToJson(f: FocusSync.SyncFocus): String = JSONObject().apply {
        put("packs", JSONArray(f.packs.map { p ->
            JSONObject().apply {
                put("id", p.id)
                put("name", p.name)
                put("allowSites", JSONArray(p.allowSites))
                put("allowApps", JSONArray(p.allowApps))
                put("defaultMinutes", p.defaultMinutes)
            }
        }))
        if (f.run == null) put("run", JSONObject.NULL) else put("run", JSONObject().apply {
            put("packId", f.run.packId)
            put("startedAt", f.run.startedAt)
            put("endsAt", f.run.endsAt)
        })
        put("rev", f.rev)
        put("updatedAt", f.updatedAt)
        put("updatedBy", f.updatedBy)
    }.toString()

    /**
     * Kívülről jött blob -> használható állapot.
     *
     * Csomagonként tűrünk: egy sérült sor ne vigye el a többit — és főleg ne
     * vigye el a FUTÓ menetet, mert akkor a felhasználó azt látná, hogy a
     * munkamenet magától kikapcsolt.
     */
    internal fun focusFromJson(text: String, fallbackDevice: String): FocusSync.SyncFocus {
        val o = JSONObject(text)
        val packs = mutableListOf<Focus.FocusPack>()
        val arr = o.optJSONArray("packs")
        for (i in 0 until (arr?.length() ?: 0)) {
            runCatching {
                val p = arr!!.getJSONObject(i)
                val id = p.optString("id")
                val name = p.optString("name").trim().take(Focus.MAX_PACK_NAME)
                if (id.isEmpty() || name.isEmpty()) return@runCatching
                if (packs.any { it.id == id } || packs.size >= FocusSync.MAX_PACKS) return@runCatching
                packs.add(Focus.FocusPack(
                    id = id,
                    name = name,
                    allowSites = stringList(p, "allowSites") { Focus.normalizeAllowSite(it) },
                    allowApps = stringList(p, "allowApps") { Focus.normalizeAllowApp(it) },
                    defaultMinutes = Focus.normalizeMinutes(p.optDouble("defaultMinutes")) ?: 25,
                ))
            }
        }
        val rawRun = if (o.isNull("run")) null else o.optJSONObject("run")?.let {
            Focus.FocusRun(
                packId = it.optString("packId"),
                startedAt = it.optLong("startedAt", 0),
                endsAt = it.optLong("endsAt", 0),
            )
        }
        return FocusSync.SyncFocus(
            packs = packs,
            run = FocusSync.cleanRun(rawRun, packs),
            rev = o.optLong("rev", 0),
            updatedAt = o.optLong("updatedAt", 0),
            updatedBy = o.optString("updatedBy").ifEmpty { fallbackDevice },
        )
    }

    private fun stringList(
        o: JSONObject, key: String, normalize: (String) -> String?,
    ): List<String> {
        val arr = o.optJSONArray(key) ?: return emptyList()
        val out = mutableListOf<String>()
        for (i in 0 until arr.length()) {
            val n = normalize(arr.optString(i)) ?: continue
            if (out.contains(n) || out.size >= Focus.MAX_ALLOW_ENTRIES) continue
            out.add(n)
        }
        return out
    }

    /** A hiányzó kulcs `null`, nem üres lista — a kettő mást jelent. */
    private fun rulesFromJson(o: JSONObject): List<UrlRules.UrlRule>? {
        if (o.isNull("rules")) return null
        val arr = o.optJSONArray("rules") ?: return null
        val out = ArrayList<UrlRules.UrlRule>()
        for (i in 0 until arr.length()) {
            val r = arr.optJSONObject(i) ?: continue
            val norm = UrlRules.normalizeRule(r.optString("host") + r.optString("path")) ?: continue
            if (out.any { UrlRules.sameRule(it, norm) }) continue
            if (out.size >= UrlRules.MAX_RULES_PER_SITE) break
            out.add(norm)
        }
        return out
    }

    private fun scheduleFromJson(o: JSONObject): ScheduleLogic.Schedule {
        val mode = when (o.optString("mode")) {
            "scheduled_block" -> ScheduleLogic.Mode.SCHEDULED_BLOCK
            "scheduled_allow" -> ScheduleLogic.Mode.SCHEDULED_ALLOW
            // Ismeretlen mód -> ALWAYS: a bizonytalanság a TILTÁS felé dől.
            else -> ScheduleLogic.Mode.ALWAYS
        }
        val bandsArr = o.optJSONArray("bands")
        val bands = if (bandsArr == null) emptyList() else (0 until bandsArr.length()).map { i ->
            val b = bandsArr.getJSONObject(i)
            val days = b.getJSONArray("days")
            ScheduleLogic.Band(
                days = (0 until days.length()).map { days.getInt(it) }.toSet(),
                startMin = b.getInt("startMin"), endMin = b.getInt("endMin"),
            )
        }
        return ScheduleLogic.Schedule(mode, bands)
    }

    data class SyncResult(val state: AppState, val changed: Boolean, val devices: Int)

    /**
     * A munkamenet szinkronja: csomagok + a futó menet.
     *
     * Ugyanaz a menet, mint a blokklistánál — húzd le, fésüld össze, told fel.
     * A különbség az összefésülés szabályában van (`FocusSync`): ott a
     * szigorúbb nyer, és lazítani csak nagyobb `rev` tud.
     */
    private fun syncFocusRound(state: AppState, acc: SyncAccount, key: ByteArray): AppState {
        var current = state
        for (attempt in 0..MAX_CONFLICT_RETRIES) {
            val pulled = call(acc.serverUrl, "/v1/pull", JSONObject().apply {
                put("accountId", acc.accountId); put("authKey", acc.authKey); put("collection", "focus")
            })
            val version = pulled.optInt("version", 0)
            // Egy sérült blob ÜRES állapot, nem kivétel: ha itt elhasalnánk, egy
            // elrontott bájt megállítaná az egész szinkront — a blokklistáét is.
            val remote = if (pulled.isNull("payload")) FocusSync.SyncFocus(updatedBy = acc.deviceId)
                else runCatching {
                    focusFromJson(SyncCrypto.decrypt(key, pulled.getString("payload")), acc.deviceId)
                }.getOrElse { FocusSync.SyncFocus(updatedBy = acc.deviceId) }

            val mine = FocusSync.SyncFocus(
                packs = current.focusPacks,
                run = current.focusRun,
                rev = current.focusRev,
                updatedAt = current.focusUpdatedAt,
                updatedBy = current.focusUpdatedBy ?: acc.deviceId,
            )
            val merged = FocusSync.merge(mine, remote)

            if (!FocusSync.same(merged, mine)) {
                current = current.copy(
                    focusPacks = merged.packs,
                    focusRun = merged.run,
                    focusRev = merged.rev,
                    focusUpdatedAt = merged.updatedAt,
                    focusUpdatedBy = merged.updatedBy,
                )
                // A lenyomatot ÚJRASZÁMOLJUK, nem a másik eszközét vesszük át:
                // enélkül a következő mentés fölöslegesen léptetné a számlálót,
                // és a két eszköz örökké írogatná egymást.
                current = SyncRevisions.adoptFocus(current)
            }
            if (FocusSync.same(merged, remote) && version > 0) return current

            val payload = SyncCrypto.encrypt(key, focusToJson(merged))
            if (payload.length > MAX_PAYLOAD_BYTES) {
                throw SyncException("A munkamenet-csomagok túl nagyok a szinkronhoz.", "TOO_BIG")
            }
            val push = call(acc.serverUrl, "/v1/push", JSONObject().apply {
                put("accountId", acc.accountId); put("authKey", acc.authKey)
                put("collection", "focus"); put("deviceId", acc.deviceId)
                put("baseVersion", version); put("payload", payload)
                put("nameBlob", SyncCrypto.encrypt(key, acc.deviceName))
            })
            if (push.optBoolean("ok", false)) return current
            if (attempt == MAX_CONFLICT_RETRIES) {
                throw SyncException("A munkamenet szinkronja nem tudott lezárulni.", "CONFLICT")
            }
        }
        return current
    }

    /**
     * Egy teljes szinkron-kör. BLOKKOL — háttérszálról hívandó.
     */
    fun syncNow(state: AppState, now: Long): SyncResult {
        val acc = state.sync ?: throw SyncException("Nincs bejelentkezve.", "NO_ACCOUNT")
        val key = SyncCrypto.unb64(acc.dataKey)
        var current = SyncRevisions.bump(state, now)
        var changed = current !== state

        for (attempt in 0..MAX_CONFLICT_RETRIES) {
            val pulled = call(acc.serverUrl, "/v1/pull", JSONObject().apply {
                put("accountId", acc.accountId); put("authKey", acc.authKey); put("collection", "sites")
            })
            val version = pulled.optInt("version", 0)
            val remote = if (pulled.isNull("payload")) emptyList()
                else sitesFromJson(SyncCrypto.decrypt(key, pulled.getString("payload")))
            val mine = toSyncSites(current.sites)
            val merged = SyncMerge.mergeLists(mine, remote)

            if (merged != mine) {
                current = current.copy(sites = fromSyncSites(merged, current.sites))
                changed = true
            }
            if (merged == remote && version > 0) break // a kiszolgálón már ez van

            val payload = SyncCrypto.encrypt(key, sitesToJson(merged))
            if (payload.length > MAX_PAYLOAD_BYTES) {
                throw SyncException("A blokklista túl nagy a szinkronhoz.", "TOO_BIG")
            }
            val push = call(acc.serverUrl, "/v1/push", JSONObject().apply {
                put("accountId", acc.accountId); put("authKey", acc.authKey)
                put("collection", "sites"); put("deviceId", acc.deviceId)
                put("baseVersion", version); put("payload", payload)
                put("nameBlob", SyncCrypto.encrypt(key, acc.deviceName))
            })
            if (push.optBoolean("ok", false)) break
            if (attempt == MAX_CONFLICT_RETRIES) {
                throw SyncException("A szinkron nem tudott lezárulni: egy másik eszköz épp ír.", "CONFLICT")
            }
        }

        // A MUNKAMENET. A blokklista után megy, mert az a fontosabb: ha a kör
        // itt hasal el, a tiltás attól már szinkronban van. Külön `runCatching`
        // ugyanezért — egy munkamenet-hiba ne vigye magával az egész kört.
        runCatching {
            val before = current
            current = syncFocusRound(current, acc, key)
            if (current !== before) changed = true
        }

        // A mérés eszközönként külön blob: itt nincs ütközés. Ha ez elhasal, a
        // blokklista attól már szinkronban van — ezért fut külön.
        var devices = 0
        runCatching {
            // Előbb a mai összegzés: ez apró, és ettől függ a KÖZÖS napi keret.
            // Ha a nagy mérés-blob elhasalna, a keret akkor is helyes marad.
            current = syncToday(current, now)
            val usagePayload = SyncCrypto.encrypt(key, usageToJson(current.usage))
            if (usagePayload.length <= MAX_PAYLOAD_BYTES) {
                val cur = call(acc.serverUrl, "/v1/pull", JSONObject().apply {
                    put("accountId", acc.accountId); put("authKey", acc.authKey)
                    put("collection", "usage"); put("deviceId", acc.deviceId)
                })
                call(acc.serverUrl, "/v1/push", JSONObject().apply {
                    put("accountId", acc.accountId); put("authKey", acc.authKey)
                    put("collection", "usage"); put("deviceId", acc.deviceId)
                    put("baseVersion", cur.optInt("version", 0)); put("payload", usagePayload)
                    put("nameBlob", SyncCrypto.encrypt(key, acc.deviceName))
                })
            }
            val all = call(acc.serverUrl, "/v1/usage-all", JSONObject().apply {
                put("accountId", acc.accountId); put("authKey", acc.authKey)
            })
            devices = all.optJSONArray("devices")?.length() ?: 0
        }

        val account = acc.copy(lastSyncAt = now, lastError = null)
        return SyncResult(current.copy(sync = account), changed, devices)
    }

    /** A többi eszköz mérése, visszafejtve — csak akkor kérjük, ha tényleg megnézik. */
    data class TopTarget(val label: String, val seconds: Long)

    data class DeviceUsage(
        val deviceId: String,
        val name: String,
        val self: Boolean,
        val todaySeconds: Long,
        val last7Seconds: Long,
        /**
         * A hét három legtöbb időt vivő célpontja. A címke NYERS: hogy fedőnév
         * kerül-e a helyére, vagy a „rejtett oldal” felirat, azt a felület
         * dönti el — a kliens nem tudhatja, hogy a listát épp rejtik-e.
         */
        val top: List<TopTarget> = emptyList(),
    )

    /**
     * Minden eszköz EGYÜTT.
     *
     * Ez az a szám, ami tényleg számít: nem az, hogy mennyi ment el a gépen és
     * külön mennyi a telefonon, hanem hogy MENNYI ÖSSZESEN. Fejben összeadni
     * senki nem fogja.
     */
    data class CombinedUsage(
        val deviceCount: Int,
        val todaySeconds: Long,
        val last7Seconds: Long,
        val top: List<TopTarget> = emptyList(),
    )

    data class DevicesResult(val combined: CombinedUsage, val devices: List<DeviceUsage>)

    fun pullDevices(state: AppState, now: Long): DevicesResult {
        val acc = state.sync ?: throw SyncException("Nincs bejelentkezve.", "NO_ACCOUNT")
        val key = SyncCrypto.unb64(acc.dataKey)
        val all = call(acc.serverUrl, "/v1/usage-all", JSONObject().apply {
            put("accountId", acc.accountId); put("authKey", acc.authKey)
        })
        val arr = all.optJSONArray("devices")
            ?: return DevicesResult(CombinedUsage(0, 0, 0), emptyList())
        val out = mutableListOf<DeviceUsage>()
        val usages = mutableListOf<UsageLogic.UsageState>()
        for (i in 0 until arr.length()) {
            // Rekordonként tűrünk: egy sérült blob ne vigye el a többi eszközt.
            runCatching {
                val d = arr.getJSONObject(i)
                val id = d.getString("deviceId")
                val nameBlob = d.optString("nameBlob", "")
                val name = if (nameBlob.isEmpty()) id else SyncCrypto.decrypt(key, nameBlob)
                // A SAJÁT sorunk a HELYI mérésből jön, nem a letöltött blobból.
                // A feltöltés percekkel korábbi is lehet, és akkor a fiókkártya
                // más „ma” értéket mutatna, mint a statisztika-képernyő ugyanabban
                // a pillanatban. Az ilyen ellentmondás adathibának néz ki, pedig
                // csak a feltöltés ideje látszik rajta.
                val usage = if (id == acc.deviceId) state.usage
                    else if (d.isNull("payload")) null
                    else usageFromJson(SyncCrypto.decrypt(key, d.getString("payload")))
                if (usage != null) usages.add(usage)
                val sum = usage?.let { UsageLogic.summarize(it, now) }
                out.add(DeviceUsage(
                    deviceId = id, name = name, self = id == acc.deviceId,
                    todaySeconds = sum?.todaySeconds?.toLong() ?: 0,
                    last7Seconds = sum?.last7Seconds?.toLong() ?: 0,
                    top = sum?.let { topOf(it) } ?: emptyList(),
                ))
            }
        }
        // Az összesítés UGYANAZON a `summarize`-on megy át, mint az
        // eszközönkénti — csak előbb egyetlen mérés-állapottá fésüljük a
        // blobokat. Két külön összegző előbb-utóbb más számot mutatna.
        val together = UsageLogic.summarize(UsageLogic.combineUsage(usages), now)
        return DevicesResult(
            CombinedUsage(
                deviceCount = out.size,
                todaySeconds = together.todaySeconds.toLong(),
                last7Seconds = together.last7Seconds.toLong(),
                top = topOf(together),
            ),
            out,
        )
    }

    /** A hét három legtöbb időt vivő célpontja, weboldalak és appok együtt. */
    private fun topOf(sum: UsageLogic.Summary): List<TopTarget> =
        (sum.topWeekSites + sum.topWeekApps)
            .sortedByDescending { it.seconds }
            .take(3)
            .map { TopTarget(it.label, it.seconds.toLong()) }

    /**
     * A mai összegzés oda-vissza: feltöltjük a miénket, lehozzuk a többiét.
     *
     * MIÉRT KÜLÖN a nagy szinkrontól. Ez néhány száz bájt, és a BLOKKOLÁSI
     * DÖNTÉS függ tőle: ha a gépen elment a napi húsz perc, azt a telefonnak is
     * tudnia kell. A teljes mérést (`usage`) viszont pazarlás lenne ilyen sűrűn
     * mozgatni, mert az csak statisztika.
     *
     * Ha ez elhasal, a helyi mérés dönt — vagyis az app pontosan úgy
     * viselkedik, mint a funkció előtt. Nem lazább: a távoli másodpercek csak
     * hozzáadnak.
     */
    fun syncToday(state: AppState, now: Long): AppState {
        val acc = state.sync ?: return state
        val key = SyncCrypto.unb64(acc.dataKey)

        val digest = LimitLogic.makeTodayDigest(state.usage, acc.deviceId, now)
        val payload = SyncCrypto.encrypt(key, digestToJson(digest))
        if (payload.length <= MAX_PAYLOAD_BYTES) {
            val cur = call(acc.serverUrl, "/v1/pull", JSONObject().apply {
                put("accountId", acc.accountId); put("authKey", acc.authKey)
                put("collection", "today"); put("deviceId", acc.deviceId)
            })
            call(acc.serverUrl, "/v1/push", JSONObject().apply {
                put("accountId", acc.accountId); put("authKey", acc.authKey)
                put("collection", "today"); put("deviceId", acc.deviceId)
                put("baseVersion", cur.optInt("version", 0)); put("payload", payload)
                put("nameBlob", SyncCrypto.encrypt(key, acc.deviceName))
            })
        }

        val all = call(acc.serverUrl, "/v1/today-all", JSONObject().apply {
            put("accountId", acc.accountId); put("authKey", acc.authKey)
        })
        val devices = mutableListOf<LimitLogic.TodayDigest>()
        val arr = all.optJSONArray("devices") ?: JSONArray()
        for (i in 0 until arr.length()) {
            val d = arr.optJSONObject(i) ?: continue
            val deviceId = d.optString("deviceId", "")
            // A SAJÁT sorunk kimarad. Enélkül minden percünk kétszer számítana,
            // és a közös keret feleakkora lenne, mint amit beállítottak.
            if (deviceId.isEmpty() || deviceId == acc.deviceId) continue
            val blob = d.optString("payload", "")
            if (blob.isEmpty()) continue
            runCatching {
                val o = JSONObject(SyncCrypto.decrypt(key, blob))
                val secs = o.optJSONObject("seconds") ?: JSONObject()
                val map = secs.keys().asSequence().associateWith { k -> secs.optDouble(k, 0.0) }
                // Az eszközazonosító a KISZOLGÁLÓTÓL jön, nem a blob belsejéből:
                // így egy eszköz nem beszélhet a másik nevében.
                LimitLogic.normalizeTodayDigest(o.optString("day", ""), map, deviceId)
            }.getOrNull()?.let { devices.add(it) }
        }
        return state.copy(sharedToday = LimitLogic.SharedToday(acc.deviceId, devices))
    }

    private fun digestToJson(d: LimitLogic.TodayDigest): String = JSONObject().apply {
        put("deviceId", d.deviceId)
        put("day", d.day)
        put("seconds", JSONObject().apply { for ((k, v) in d.seconds) put(k, v) })
    }.toString()

    // A mérés JSON-alakja ugyanaz, amit a segéd is használ — a `BreakerStore`
    // privát átalakítói nem érhetők el innen, ezért itt van a párja.

    private fun usageToJson(u: UsageLogic.UsageState): String = JSONObject().apply {
        put("enabled", u.enabled)
        put("days", JSONArray(u.days.map { d ->
            JSONObject().apply {
                put("day", d.day)
                put("seconds", JSONObject().apply { for ((k, v) in d.seconds) put(k, v) })
            }
        }))
        put("labels", JSONObject().apply { for ((k, v) in u.labels) put(k, v) })
    }.toString()

    private fun usageFromJson(text: String): UsageLogic.UsageState {
        val o = JSONObject(text)
        val days = mutableListOf<UsageLogic.UsageDay>()
        o.optJSONArray("days")?.let { arr ->
            for (i in 0 until arr.length()) runCatching {
                val d = arr.getJSONObject(i)
                val secs = mutableMapOf<String, Double>()
                val so = d.getJSONObject("seconds")
                for (k in so.keys()) secs[k] = so.getDouble(k)
                days.add(UsageLogic.UsageDay(d.getString("day"), secs))
            }
        }
        val labels = mutableMapOf<String, String>()
        o.optJSONObject("labels")?.let { lo -> for (k in lo.keys()) runCatching { labels[k] = lo.getString(k) } }
        return UsageLogic.UsageState(days, labels, o.optBoolean("enabled", true))
    }

    /** Helyreállító kód: 160 véletlen bit, nyolc négyes csoportban (Crockford base32). */
    private const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    fun newRecoveryCode(): String {
        val bytes = ByteArray(20).also { java.security.SecureRandom().nextBytes(it) }
        var acc = 0
        var bits = 0
        val sb = StringBuilder()
        for (b in bytes) {
            acc = (acc shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                sb.append(CROCKFORD[(acc shr (bits - 5)) and 31])
                bits -= 5
            }
        }
        return sb.chunked(4).joinToString("-")
    }
}
