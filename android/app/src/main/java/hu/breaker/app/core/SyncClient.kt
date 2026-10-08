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
        if (SyncCrypto.passwordLength(password) < SyncCrypto.MIN_PASSWORD_LENGTH) {
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
            dailyLimitSeconds = s.dailyLimitSeconds,
            burstSeconds = s.burstSeconds, cooldownSeconds = s.cooldownSeconds,
            alias = s.alias, reason = s.reason, rules = s.rules,
            rev = maxOf(s.rev, 1), updatedAt = s.updatedAt, updatedBy = s.updatedBy,
            hostnameMarks = s.hostnameMarks,
            // A szabálylista jele is hordozott: a gépen kifizetett levétel nyoma.
            rulesRev = s.rulesRev,
            // A szabályok jelei: szabályonként ezekből dől el, ki mondta az újabbat.
            ruleMarks = s.ruleMarks,
            // A kifizetett lazítások mezőnként — a fésülés ezekből dönt.
            deleteLoosens = s.deleteLoosens, scheduleLoosens = s.scheduleLoosens,
            limitLoosens = s.limitLoosens, burstLoosens = s.burstLoosens,
            // A végigment törlés jele: a sírkövön, és a fésülés hozta, itt még nem esedékes rekordon.
            goneLoosens = s.goneLoosens,
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
                    burstSeconds = m.burstSeconds, cooldownSeconds = m.cooldownSeconds,
                    alias = m.alias, reason = m.reason, rules = m.rules,
                    rev = m.rev, updatedAt = m.updatedAt, updatedBy = m.updatedBy,
                    hostnameMarks = m.hostnameMarks,
                    rulesRev = m.rulesRev,
                    ruleMarks = m.ruleMarks,
                    deleteLoosens = m.deleteLoosens, scheduleLoosens = m.scheduleLoosens,
                    limitLoosens = m.limitLoosens, burstLoosens = m.burstLoosens,
                    goneLoosens = m.goneLoosens,
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
                if (s.burstSeconds != null) put("burstSeconds", s.burstSeconds)
                if (s.cooldownSeconds != null) put("cooldownSeconds", s.cooldownSeconds)
                if (s.alias != null) put("alias", s.alias)
                if (s.reason != null) put("reason", s.reason)
                // A kulcs csak akkor kerül bele, ha VAN mit mondani: a hiányzó
                // kulcs azt jelenti, hogy nincs tudomásunk szabályokról, az
                // üres tömb azt, hogy voltak és levették. A kettő nem cserélhető
                // fel (lásd SyncMerge.mergeRules).
                if (s.rules != null) put("rules", JSONArray(s.rules.map { r ->
                    JSONObject().apply { put("host", r.host); put("path", r.path) }
                }))
                put("rev", s.rev); put("updatedAt", s.updatedAt); put("updatedBy", s.updatedBy)
                // A jelek csak akkor, ha vannak: a hiányzó és az üres itt ugyanaz.
                if (s.hostnameMarks != null) put("hostnameMarks", JSONObject(s.hostnameMarks))
                // A szabálylista jele csak lista mellett: mező nélkül nincs jel.
                if (s.rules != null && s.rulesRev != null) put("rulesRev", s.rulesRev)
                // A szabályok jelei is csak lista mellett.
                if (s.rules != null && s.ruleMarks != null) put("ruleMarks", JSONObject(s.ruleMarks))
                // A kifizetett lazítások — nullánál nincs mező.
                if (s.deleteLoosens != null) put("deleteLoosens", s.deleteLoosens)
                if (s.scheduleLoosens != null) put("scheduleLoosens", s.scheduleLoosens)
                if (s.limitLoosens != null) put("limitLoosens", s.limitLoosens)
                if (s.burstLoosens != null) put("burstLoosens", s.burstLoosens)
                // A végigment törlés jele — a sírkövön.
                if (s.goneLoosens != null) put("goneLoosens", s.goneLoosens)
            })
        }
        return arr.toString()
    }

    /**
     * Jelek kiegyenesítése egy kulcs alól: csak név → pozitív egész, legfeljebb
     * [maxRev] (egy jó rekordban a jel sosem nagyobb a rekord rev-jénél — a
     * nagyobb csak a kulccsal írt szemét lehet); ami más, kimarad; üresen
     * null. Legfeljebb 64 — a kiszolgáló nem hizlalhatja a rekordot. A Store
     * is ezzel olvas.
     */
    // ---- a dróton jött mezők típusa — a gép szabálya szerint ----
    //
    // Az org.json `optLong`/`optInt`/`optString`-je KÉNYSZERÍT: a „5” szövegből
    // számot, a 5 számból szöveget, az 1.5-ből 1-et csinál. A gép (`typeof v
    // === 'number'`, `Number.isInteger`) és az iPhone dekódolója nem — ugyanaz
    // a hibás rekord eszközönként mást jelentett volna. Közös fixtúra:
    // fixtures/wire-cases.json.

    /** Csak JSON-szám, véges. */
    internal fun numberOf(o: JSONObject, key: String): Double? =
        (o.opt(key) as? Number)?.toDouble()?.takeIf { it.isFinite() }

    /** Csak egész JSON-szám, Int-tartományban — a gép `Number.isInteger`-e. */
    internal fun intOf(o: JSONObject, key: String): Int? = intValue(o.opt(key))

    /** Ugyanez egy értékre (tömb eleme). */
    internal fun intValue(v: Any?): Int? {
        val d = (v as? Number)?.toDouble()?.takeIf { it.isFinite() } ?: return null
        if (d != Math.floor(d) || d < Int.MIN_VALUE || d > Int.MAX_VALUE) return null
        return d.toInt()
    }

    /** Csak JSON-szöveg — a szám nem szöveg. */
    internal fun stringOf(o: JSONObject, key: String): String? = o.opt(key) as? String

    internal fun marksFromJson(
        o: JSONObject, key: String = "hostnameMarks", maxRev: Int = Int.MAX_VALUE, min: Int = 1,
    ): Map<String, Int>? {
        val m = o.optJSONObject(key) ?: return null
        val out = LinkedHashMap<String, Int>()
        val keys = m.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            if (k.isEmpty()) continue
            val v = intOf(m, k) ?: continue
            if (v >= min && v <= maxRev) out[k] = v
            // A VALÓDI plafon a hívóé (`capHostnameMarks` / `capPackMarks`):
            // az tudja, mely nevek vannak jelen, és azok jele marad. Itt csak
            // a szemét ellen van korlát, hogy egy óriás objektum ne egyen memóriát.
            if (out.size >= 1024) break
        }
        return if (out.isEmpty()) null else out
    }

    internal fun sitesFromJson(text: String): List<SyncMerge.SyncSite> {
        val arr = JSONArray(text)
        val out = mutableListOf<SyncMerge.SyncSite>()
        for (i in 0 until arr.length()) {
            // Rekordonként tűrünk: egy sérült sor ne vigye el a többi oldalt.
            runCatching {
                val o = arr.getJSONObject(i)
                // A rekord csak az azonosító és a domain hibájára esik ki; minden
                // más mező rossz típusa az alapértékét kapja — mint a gépen.
                val id = stringOf(o, "id")
                require(!id.isNullOrEmpty()) { "nincs azonosító" }
                // A DOMAIN és a HOSZTNEVEK ugyanazon a szűrőn, mint a helyben
                // felvett oldal. A blob titkosított, de a jelszó a saját lista
                // lazítására jogosít, nem szemét bejuttatására — a gépen ezek a
                // nevek a root-tulajdonú hosts fájlba mennek. Ami nem
                // hosztnév-alakú, az nem oldal: a rekord kimarad.
                val domain = stringOf(o, "domain")
                require(domain != null && Blocklist.isCanonicalHostname(domain)) { "nem hosztnév: $domain" }
                val hostsArr = o.optJSONArray("hostnames")
                val hostnames = (0 until (hostsArr?.length() ?: 0))
                    .mapNotNull { hostsArr!!.opt(it) as? String }
                    .filter { Blocklist.isCanonicalHostname(it) }.distinct()
                // Csak egész rev; a jelek felső határa is ez (a gépen is).
                val rev = intOf(o, "rev") ?: 1
                val rules = rulesFromJson(o)
                val deleteLoosens = intOf(o, "deleteLoosens")?.takeIf { it > 0 && it <= rev }
                out.add(SyncMerge.SyncSite(
                    id = id!!,
                    domain = domain!!,
                    hostnames = hostnames,
                    addedAt = numberOf(o, "addedAt")?.toLong() ?: 0,
                    pendingDeleteAt = numberOf(o, "pendingDeleteAt")?.toLong(),
                    // Ami nem objektum, az nincs (mint a hiányzó: mindig tiltva) —
                    // eddig az egész oldalt vitte.
                    schedule = o.optJSONObject("schedule")?.let { scheduleFromJson(it) },
                    dailyLimitSeconds = numberOf(o, "dailyLimitSeconds")?.toLong(),
                    burstSeconds = numberOf(o, "burstSeconds")?.toLong(),
                    cooldownSeconds = numberOf(o, "cooldownSeconds")?.toLong(),
                    alias = AliasLogic.normalize(stringOf(o, "alias")),
                    reason = AliasLogic.normalizeReason(stringOf(o, "reason")),
                    rules = rules,
                    rev = rev,
                    updatedAt = numberOf(o, "updatedAt")?.toLong() ?: 0,
                    updatedBy = stringOf(o, "updatedBy") ?: "",
                    hostnameMarks = marksFromJson(o, "hostnameMarks", rev)?.let {
                        SyncMerge.capHostnameMarks(it, hostnames)
                    },
                    // A szabálylista jele: pozitív egész, legfeljebb a rekord rev-je —
                    // és csak lista mellett; mező nélkül nincs jel.
                    rulesRev = if (o.isNull("rules")) null
                        else intOf(o, "rulesRev")?.takeIf { it > 0 && it <= rev },
                    // A kifizetett lazítások: pozitív egész, legfeljebb a rekord
                    // rev-je (csak léptetés írhatja); ami más, az nincs.
                    deleteLoosens = deleteLoosens,
                    scheduleLoosens = intOf(o, "scheduleLoosens")?.takeIf { it > 0 && it <= rev },
                    limitLoosens = intOf(o, "limitLoosens")?.takeIf { it > 0 && it <= rev },
                    burstLoosens = intOf(o, "burstLoosens")?.takeIf { it > 0 && it <= rev },
                    ruleMarks = ruleMarksFromJson(o, rules, rev),
                    // A végigment törlés jele legfeljebb a törlés számlálója:
                    // nagyobbat a fésülés sosem ír.
                    goneLoosens = intOf(o, "goneLoosens")?.takeIf { it > 0 && it <= (deleteLoosens ?: 0) },
                ))
            }
        }
        return out
    }

    /**
     * A szabályok jelei a dróton és a tárolt állapotban: csak KANONIKUS
     * szabály-kulcs (ahogy a kézzel beírt szabály is lenne) → pozitív egész,
     * legfeljebb a rekord rev-je; és csak szabálylista mellett — mező nélkül
     * nincs jel. A plafon a fésülésé. A gép `cleanRuleMarks`-a.
     */
    internal fun ruleMarksFromJson(o: JSONObject, rules: List<UrlRules.UrlRule>?, rev: Int): Map<String, Int>? {
        if (rules == null) return null
        val obj = o.opt("ruleMarks") as? JSONObject ?: return null
        val out = HashMap<String, Int>()
        for (k in obj.keys()) {
            val v = intValue(obj.opt(k)) ?: continue
            if (v <= 0 || v > rev) continue
            val norm = UrlRules.normalizeRule(k) ?: continue
            if (SyncMerge.ruleKey(norm) != k) continue
            out[k] = v
        }
        return SyncMerge.capHostnameMarks(out, rules.map { SyncMerge.ruleKey(it) })
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
                // A heti ablak is felmegy: enélkül a telefon feltöltése (utolsó
                // író nyer) letörölné a gépen beállított ismétlődést.
                put("recurrence", p.recurrence?.let { bandToJson(it) } ?: JSONObject.NULL)
            }
        }))
        if (f.run == null) put("run", JSONObject.NULL) else put("run", JSONObject().apply {
            put("packId", f.run.packId)
            put("startedAt", f.run.startedAt)
            put("endsAt", f.run.endsAt)
            // A rövidítés száma és az eredeti kezdés csak ha van — a fésülés
            // ezekből dönt (a gép `FocusRun`-jának két mezője).
            if (f.run.cuts > 0) put("cuts", f.run.cuts)
            f.run.origin?.let { put("origin", it) }
        })
        // A NAPLÓ IS FELMEGY. Enélkül a telefonon lezárult menetek sosem
        // kerülnének be a statisztikába — aki a telefonján dolgozik, azt
        // látná, hogy a héten le sem ült.
        put("log", JSONArray(f.log.map { e ->
            JSONObject().apply {
                put("packId", e.packId)
                put("packName", e.packName)
                put("startedAt", e.startedAt)
                put("endedAt", e.endedAt)
                put("plannedEndsAt", e.plannedEndsAt)
                put("stopped", e.stopped)
                // Az ablak jele csak ha igaz — a régi kliens sora mezőtlen, és az nem ablak.
                if (e.window) put("window", true)
                // A sor a menet sírköve is: a tudása (rövidítés, eredeti kezdés) is felmegy.
                if (e.cuts > 0) put("cuts", e.cuts)
                e.origin?.let { put("origin", it) }
            }
        }))
        put("rev", f.rev)
        put("updatedAt", f.updatedAt)
        put("updatedBy", f.updatedBy)
        // A csomag-jelek csak akkor, ha vannak: a hiányzó és az üres ugyanaz.
        if (f.packMarks != null) put("packMarks", JSONObject(f.packMarks))
        // A kifizetett ablak-lazítások és a saját jelek is, csak ha vannak.
        if (f.packLoosens != null) put("packLoosens", JSONObject(f.packLoosens))
        if (f.packOwnMarks != null) put("packOwnMarks", JSONObject(f.packOwnMarks))
        // A ZÁRLAT IS FELMEGY. Enélkül a telefon feltöltése LETÖRÖLNÉ a gépen
        // indított zárlatot a többi eszközről — és pont az lenne a kibúvó.
        if (f.lockdown != null) put("lockdown", JSONObject().apply {
            put("startedAt", f.lockdown.startedAt)
            put("until", f.lockdown.until)
        })
        // AZ ABLAKOK IS, a jelükkel — enélkül a telefon feltöltése LETÖRÖLNÉ a
        // gépen felvett ablakot a többi eszközről. Üresen nincs mező.
        if (f.lockdownWindows.isNotEmpty()) put("lockdownWindows", windowsToJson(f.lockdownWindows))
        if (f.lockdownWindowsRev != null) put("lockdownWindowsRev", f.lockdownWindowsRev)
        // A tartalmankénti ablak-jelek — üresen nincs mező.
        if (!f.lockdownWindowMarks.isNullOrEmpty()) put("lockdownWindowMarks", JSONObject(f.lockdownWindowMarks))
        // A MEGBÍZOTT IS, a jelével: a lenyomat utazik, a jelmondat sehol nincs.
        if (f.partner != null) put("partner", partnerToJson(f.partner))
        if (f.partnerRev != null) put("partnerRev", f.partnerRev)
        // A TÁRSAK és a levettek NYOMA is — üresen nincs mező.
        if (f.partnerCo.isNotEmpty()) put("partnerCo", JSONArray(f.partnerCo.map { partnerToJson(it) }))
        if (f.partnersGone.isNotEmpty()) put("partnersGone", JSONArray(f.partnersGone.map { goneToJson(it) }))
        // A REJTÉS IS, a jelével — csak igazként, üresen nincs mező.
        if (f.hideSiteList) put("hideSiteList", true)
        if (f.hideSiteListRev != null) put("hideSiteListRev", f.hideSiteListRev)
        // A KULCSSZAVAK IS, a jelükkel — üresen nincs mező.
        if (f.keywords.isNotEmpty()) put("keywords", JSONArray(f.keywords))
        if (f.keywordsRev != null) put("keywordsRev", f.keywordsRev)
        // A kulcsszavankénti jelek — üresen nincs mező.
        if (!f.keywordMarks.isNullOrEmpty()) put("keywordMarks", JSONObject(f.keywordMarks))
    }.toString()

    /** Egy JSON-tömb szövegei — ami nem szöveg, az kimarad. */
    internal fun stringsFromJson(arr: JSONArray?): List<String> {
        if (arr == null) return emptyList()
        // Csak szöveg: az `optString` a 12345-öt is kulcsszóvá tette volna.
        return (0 until arr.length()).mapNotNull { i -> arr.opt(i) as? String }
    }

    /** A megbízott drót-alakja: név, só, lenyomat, dátum — a jelmondat nincs benne. */
    internal fun partnerToJson(p: PartnerLogic.PartnerLock): JSONObject = JSONObject().apply {
        put("name", p.name); put("salt", p.salt); put("hash", p.hash); put("setAt", p.setAt)
    }

    /** A levett megbízott nyomának drót-alakja: azonosság és időpont. */
    internal fun goneToJson(g: PartnerLogic.PartnerGone): JSONObject = JSONObject().apply {
        put("id", g.id); put("at", g.at)
    }

    /**
     * A beolvasott megbízottak: a fő, a társak és a nyomok — a gép
     * `partnersIn`-je: a rossz alakú kiesik, a fővel egyező társ is, a nyom
     * időpontja csak nemnegatív, biztonságos egész JSON-szám (különben 0), és
     * a fésülés szabálya rendezi (a nyommal levett nem él).
     */
    internal fun partnersFromJson(o: JSONObject): PartnerLogic.PartnerSet {
        val main = partnerFromJson(o.optJSONObject("partner"))
        val coArr = o.optJSONArray("partnerCo")
        val co = if (coArr == null) emptyList() else (0 until coArr.length())
            .mapNotNull { partnerFromJson(coArr.opt(it) as? JSONObject) }
            .filter { main == null || PartnerLogic.partnerId(it) != PartnerLogic.partnerId(main) }
        val goneArr = o.optJSONArray("partnersGone")
        val gone = if (goneArr == null) emptyList() else (0 until goneArr.length()).mapNotNull { i ->
            val g = goneArr.opt(i) as? JSONObject ?: return@mapNotNull null
            val id = stringOf(g, "id") ?: return@mapNotNull null
            val at = numberOf(g, "at")
                ?.takeIf { it >= 0 && it == Math.floor(it) && it <= 9_007_199_254_740_991.0 }?.toLong() ?: 0L
            PartnerLogic.PartnerGone(id, at)
        }
        return PartnerLogic.mergePartners(
            PartnerLogic.PartnerSet(main, co, PartnerLogic.cleanPartnersGone(gone)), PartnerLogic.PartnerSet(),
        )
    }

    /** Kívülről jött adat: csak a jó alakú marad. */
    internal fun partnerFromJson(o: JSONObject?): PartnerLogic.PartnerLock? {
        if (o == null) return null
        // Csak szöveg és csak JSON-szám — a gép `normalizePartnerLock`-ja szerint.
        return PartnerLogic.normalizeLock(
            stringOf(o, "name"),
            stringOf(o, "salt"),
            stringOf(o, "hash"),
            numberOf(o, "setAt")?.toLong(),
        )
    }

    /** Az ablak-lista drót-alakja: azonosító, napok (rendezve), kezdés, vég. */
    internal fun windowsToJson(windows: List<LockdownLogic.LockdownWindow>): JSONArray =
        JSONArray(windows.map { w ->
            JSONObject().apply {
                put("id", w.id)
                put("days", JSONArray(w.days.sorted()))
                put("startMin", w.startMin)
                put("endMin", w.endMin)
            }
        })

    /** Kívülről jött ablak-lista: ablakonként tűrünk, a szemét kiesik, a lista tiszta. */
    internal fun windowsFromJson(arr: JSONArray?): List<LockdownLogic.LockdownWindow> {
        if (arr == null) return emptyList()
        val raw = (0 until arr.length()).mapNotNull { i ->
            // A gép `normalizeWindow`-ja: szöveg-azonosító, a napok közül csak
            // az egész 0–6 marad (a többi kiesik, nem az egész ablak), a perc
            // csak egész JSON-szám. Az ellenőrzés a `cleanWindow`-é.
            val w = arr.opt(i) as? JSONObject ?: return@mapNotNull null
            val id = stringOf(w, "id") ?: return@mapNotNull null
            val daysArr = w.optJSONArray("days")
            val days = (0 until (daysArr?.length() ?: 0)).mapNotNull { intValue(daysArr!!.opt(it)) }
                .filter { it in 0..6 }.toSet()
            LockdownLogic.LockdownWindow(
                id = id, days = days,
                startMin = intOf(w, "startMin") ?: -1, endMin = intOf(w, "endMin") ?: -1,
            )
        }
        return LockdownLogic.cleanWindows(raw)
    }

    /**
     * Kívülről jött blob -> használható állapot.
     *
     * Csomagonként tűrünk: egy sérült sor ne vigye el a többit — és főleg ne
     * vigye el a FUTÓ menetet, mert akkor a felhasználó azt látná, hogy a
     * munkamenet magától kikapcsolt.
     */
    /**
     * @param now ha meg van adva, a LEJÁRT zárlat nem kerül be — a szinkron
     *   határán ez a helyes (lásd LockdownLogic.live).
     */
    internal fun focusFromJson(
        text: String, fallbackDevice: String, now: Long? = null,
    ): FocusSync.SyncFocus {
        val o = JSONObject(text)
        val partners = partnersFromJson(o)
        val keywords = KeywordLogic.cleanKeywords(stringsFromJson(o.optJSONArray("keywords")))
        val windows = windowsFromJson(o.optJSONArray("lockdownWindows"))
        val packs = mutableListOf<Focus.FocusPack>()
        val seenIds = mutableListOf<String>()
        val arr = o.optJSONArray("packs")
        for (i in 0 until (arr?.length() ?: 0)) {
            runCatching {
                val p = arr!!.getJSONObject(i)
                // Csak szöveg-azonosító „látott” — a gépen is; a számot az
                // `optString` szöveggé tenné, és egy idegen jel kiesne miatta.
                val id = stringOf(p, "id").orEmpty()
                if (id.isNotEmpty()) seenIds.add(id)
                // Csak valódi szöveg: az `optString` egy számot is szöveggé tenne,
                // a gép (és az iPhone) az ilyen csomagot eldobja.
                val name = (p.opt("name") as? String)?.let { Focus.normalizePackName(it) }
                if (id.isEmpty() || name == null) return@runCatching
                if (packs.any { it.id == id } || packs.size >= FocusSync.MAX_PACKS) return@runCatching
                packs.add(Focus.FocusPack(
                    id = id,
                    name = name,
                    allowSites = stringList(p, "allowSites") { Focus.normalizeAllowSite(it) },
                    allowApps = stringList(p, "allowApps") { Focus.normalizeAllowApp(it) },
                    defaultMinutes = Focus.normalizeMinutes(numberOf(p, "defaultMinutes")) ?: 25,
                    recurrence = Focus.cleanRecurrence(p.optJSONObject("recurrence")?.let { bandFromJson(it) }),
                ))
            }
        }
        // A gép `normalizeRun`-ja: szöveg-azonosító, csak JSON-szám idők.
        val rawRun = o.optJSONObject("run")?.let {
            val startedAt = numberOf(it, "startedAt")?.toLong() ?: 0
            Focus.FocusRun(
                packId = stringOf(it, "packId").orEmpty(),
                startedAt = startedAt,
                endsAt = numberOf(it, "endsAt")?.toLong() ?: 0,
                // A gép `cleanCuts` / `cleanOrigin` szabálya: csak az értelmes marad.
                cuts = Focus.cleanCuts(numberOf(it, "cuts")),
                origin = Focus.cleanOrigin(numberOf(it, "origin"), startedAt),
            )
        }
        // Nemnegatív egész, mint a gépen és az iPhone-on: csak JSON-szám, lefelé
        // kerekítve (az `optLong` a „5” szöveget is 5-nek venné).
        val rev = Math.floor(numberOf(o, "rev") ?: 0.0).toLong().coerceAtLeast(0)
        // A jel legfeljebb a blob rev-je; a plafonnál a jelen lévő csomagok
        // jele marad. A KIESETT csomag jele is kiesik: ami a listán volt, de
        // itt nem értelmezhető (vagy a plafon fölött van), az nem törölt
        // csomag — a jele meg a hiánya együtt sírkőnek látszana, és a csomag
        // mindenhol törlődne. A valódi törlés jele (nincs ilyen csomag) marad.
        val presentIds = packs.map { it.id }
        // Előbb a plafon, aztán a kiesett csomagok jelének dobása — ebben a
        // sorrendben, mint a gép és az iPhone, hogy a plafon fölött is ugyanaz
        // a halmaz maradjon.
        val marks = marksFromJson(o, "packMarks", rev.coerceIn(0, Int.MAX_VALUE.toLong()).toInt())
            ?.let { FocusSync.capPackMarks(it, presentIds) }
            ?.filterKeys { it !in seenIds || it in presentIds }
            ?.takeIf { it.isNotEmpty() }
        // A kifizetett ablak-lazítások ugyanígy: pozitív egész, legfeljebb a
        // rev, a plafonnal; a kiesett csomagé kiesik.
        val loosens = marksFromJson(o, "packLoosens", rev.coerceIn(0, Int.MAX_VALUE.toLong()).toInt())
            ?.let { FocusSync.capPackMarks(it, presentIds) }
            ?.filterKeys { it !in seenIds || it in presentIds }
            ?.takeIf { it.isNotEmpty() }
        // A saját jel a megmaradt közös jelekhez igazodik: nemnegatív, kisebb nála.
        val owns = FocusSync.cleanOwnMarks(marksFromJson(o, "packOwnMarks", Int.MAX_VALUE, 0), marks)
        return FocusSync.SyncFocus(
            packs = packs,
            run = FocusSync.cleanRun(rawRun, packs),
            // A naplót NEM kötjük a csomagokhoz: egy menet sora akkor is igaz
            // marad, ha a csomagot azóta törölték. Épp ezért van benne a NÉV
            // is, nem csak az azonosító.
            log = focusLogFromJson(o),
            rev = rev,
            updatedAt = numberOf(o, "updatedAt")?.toLong() ?: 0,
            updatedBy = stringOf(o, "updatedBy").orEmpty().ifEmpty { fallbackDevice },
            packMarks = marks,
            packLoosens = loosens,
            packOwnMarks = owns,
            // Kívülről jött adat: ami nem értelmes, az nincs — és `now` mellett
            // a lejárt sem.
            lockdown = o.optJSONObject("lockdown")?.let { l ->
                // Csak JSON-szám (az `optDouble` a „9000” szöveget is elfogadta).
                LockdownLogic.parse(numberOf(l, "until") ?: 0.0, numberOf(l, "startedAt"))
            }?.let { if (now == null) it else LockdownLogic.live(it, now) },
            // Az ablakok kívülről jött adat, mint minden más; a jel pozitív
            // egész, legfeljebb a blob rev-je — mint a csomag-jelek.
            lockdownWindows = windows,
            lockdownWindowsRev = (intOf(o, "lockdownWindowsRev") ?: 0)
                .takeIf { it > 0 && it <= rev.coerceIn(0, Int.MAX_VALUE.toLong()) },
            // Az ablak-jelek is: kanonikus tartalmi kulcs, pozitív egész, legfeljebb a rev.
            lockdownWindowMarks = LockdownLogic.cleanWindowMarks(
                marksFromJson(o, "lockdownWindowMarks"), windows, rev.coerceIn(0, Int.MAX_VALUE.toLong()).toInt(),
            ),
            // A megbízott is kívülről jött adat: csak a jó alakú, a jele mint a
            // többié; a társak és a nyomok a fésülés szabálya szerint.
            partner = partners.partner,
            partnerRev = (intOf(o, "partnerRev") ?: 0)
                .takeIf { it > 0 && it <= rev.coerceIn(0, Int.MAX_VALUE.toLong()) },
            partnerCo = partners.partnerCo,
            partnersGone = partners.partnersGone,
            // A rejtés is kívülről jött adat: csak igazként, a jele mint a többié.
            hideSiteList = o.opt("hideSiteList") == true,
            hideSiteListRev = (intOf(o, "hideSiteListRev") ?: 0)
                .takeIf { it > 0 && it <= rev.coerceIn(0, Int.MAX_VALUE.toLong()) },
            // A kulcsszavak is kívülről jött adat: csak az érvényes, egyszer, a plafonig.
            keywords = keywords,
            keywordsRev = (intOf(o, "keywordsRev") ?: 0)
                .takeIf { it > 0 && it <= rev.coerceIn(0, Int.MAX_VALUE.toLong()) },
            // A kulcsszó-jelek is: kanonikus kulcsszó, pozitív egész, legfeljebb a rev.
            keywordMarks = KeywordLogic.cleanKeywordMarks(
                marksFromJson(o, "keywordMarks"), keywords, rev.coerceIn(0, Int.MAX_VALUE.toLong()).toInt(),
            ),
        )
    }

    /**
     * Naplósorok egy kívülről jött blobból.
     *
     * Soronként tűrünk: egy rossz sor miatt elveszíteni a többit ugyanaz a
     * hiba lenne, mint egy rossz csomag miatt eldobni a futó menetet.
     */
    private fun focusLogFromJson(o: JSONObject): List<Focus.FocusLogEntry> {
        val arr = o.optJSONArray("log") ?: return emptyList()
        val out = mutableListOf<Focus.FocusLogEntry>()
        for (i in 0 until arr.length()) {
            runCatching {
                val e = arr.getJSONObject(i)
                // A gép `normalizeLogEntry`-je: csak szöveg-azonosító, csak
                // JSON-szám, és csak a valódi `true` igaz (a „true” szöveg nem).
                val packId = stringOf(e, "packId").orEmpty()
                val endedAt = numberOf(e, "endedAt")?.toLong() ?: 0
                if (packId.isEmpty() || endedAt <= 0) return@runCatching
                val startedAt = numberOf(e, "startedAt")?.toLong() ?: 0
                out.add(Focus.FocusLogEntry(
                    packId = packId,
                    packName = Focus.logPackName(stringOf(e, "packName").orEmpty()),
                    startedAt = startedAt,
                    endedAt = endedAt,
                    plannedEndsAt = numberOf(e, "plannedEndsAt")?.toLong() ?: endedAt,
                    stopped = e.opt("stopped") == true,
                    window = e.opt("window") == true,
                    cuts = Focus.cleanCuts(numberOf(e, "cuts")),
                    origin = Focus.cleanOrigin(numberOf(e, "origin"), startedAt),
                ))
            }
        }
        return FocusSync.capLog(out)
    }

    private fun stringList(
        o: JSONObject, key: String, normalize: (String) -> String?,
    ): List<String> {
        val arr = o.optJSONArray(key) ?: return emptyList()
        val out = mutableListOf<String>()
        for (i in 0 until arr.length()) {
            // Csak szöveg: a szám (`optString`-gel „5”) a gépen kiesik.
            val n = (arr.opt(i) as? String)?.let(normalize) ?: continue
            if (out.contains(n) || out.size >= Focus.MAX_ALLOW_ENTRIES) continue
            out.add(n)
        }
        return out
    }

    /** A hiányzó kulcs `null`, nem üres lista — a kettő mást jelent. */
    private fun rulesFromJson(o: JSONObject): List<UrlRules.UrlRule>? {
        if (o.isNull("rules")) return null
        val arr = o.optJSONArray("rules") ?: return null
        // Csak a KANONIKUS alak megy át, átírás nélkül — a gép `cleanRules`-a
        // szerint: hoszt-alakú hoszt, `/`-rel kezdődő, szóköz nélküli út. A
        // magok kanonikus alakban írnak; amit a normalizálás átírna (eddig a
        // „X.COM” is átment kisbetűsítve), az nem a másik mag írása, hanem
        // szemét — és a gépen kiesett volna, itt nem.
        val out = ArrayList<UrlRules.UrlRule>()
        for (i in 0 until arr.length()) {
            val r = arr.optJSONObject(i) ?: continue
            val host = stringOf(r, "host") ?: continue
            val path = stringOf(r, "path") ?: continue
            if (!Blocklist.isCanonicalHostname(host)) continue
            if (!path.startsWith("/") || path.length > 512 || path.any { TextLogic.isSpace(it) }) continue
            out.add(UrlRules.UrlRule(host, path))
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
        // SÁVONKÉNT tűrve, a gép `scheduleIn`-je szerint: a rosszul formált sáv
        // (nem objektum, a nap nem egész számok tömbje, a perc nem egész) kiesik,
        // a többi marad. Eddig egyetlen ilyen sáv az egész oldalt vitte, a
        // `getInt` pedig a „540” szöveget is percnek vette. A tartalmi szűrés
        // (napok 0–6, percek a napon belül) a döntésé (`ScheduleLogic.normalize`).
        val bandsArr = o.optJSONArray("bands")
        val bands = mutableListOf<ScheduleLogic.Band>()
        for (i in 0 until (bandsArr?.length() ?: 0)) {
            val b = bandsArr!!.opt(i) as? JSONObject ?: continue
            val daysArr = b.opt("days") as? JSONArray ?: continue
            val days = (0 until daysArr.length()).map { intValue(daysArr.opt(it)) }
            if (days.any { it == null }) continue
            val start = intOf(b, "startMin") ?: continue
            val end = intOf(b, "endMin") ?: continue
            bands.add(ScheduleLogic.Band(days = days.filterNotNull().toSet(), startMin = start, endMin = end))
        }
        return ScheduleLogic.Schedule(mode, bands)
    }

    /** Egy sáv a drótra — ugyanaz az alak, mint a menetrend sávjaié. */
    private fun bandToJson(b: ScheduleLogic.Band): JSONObject = JSONObject().apply {
        put("days", JSONArray(b.days.toList()))
        put("startMin", b.startMin); put("endMin", b.endMin)
    }

    /** Egy sáv a drótról, vagy null, ha nem értelmezhető — a hívó tisztítja. */
    private fun bandFromJson(b: JSONObject): ScheduleLogic.Band? = runCatching {
        val days = b.getJSONArray("days")
        ScheduleLogic.Band(
            days = (0 until days.length()).map { days.getInt(it) }.toSet(),
            startMin = b.getInt("startMin"), endMin = b.getInt("endMin"),
        )
    }.getOrNull()

    data class SyncResult(val state: AppState, val changed: Boolean, val devices: Int)

    /**
     * A munkamenet szinkronja: csomagok + a futó menet.
     *
     * Ugyanaz a menet, mint a blokklistánál — húzd le, fésüld össze, told fel.
     * A különbség az összefésülés szabályában van (`FocusSync`): ott a
     * szigorúbb nyer, és lazítani csak a nyomával lehet — a rövidítés
     * számlálójával, a leállítás naplósorával.
     */
    private fun syncFocusRound(
        state: AppState, acc: SyncAccount, key: ByteArray, now: Long,
    ): AppState {
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
                    focusFromJson(SyncCrypto.decrypt(key, pulled.getString("payload")), acc.deviceId, now)
                }.getOrElse { FocusSync.SyncFocus(updatedBy = acc.deviceId) }

            val mine = FocusSync.SyncFocus(
                packs = current.focusPacks,
                run = current.focusRun,
                log = current.focusLog,
                rev = current.focusRev,
                updatedAt = current.focusUpdatedAt,
                updatedBy = current.focusUpdatedBy ?: acc.deviceId,
                packMarks = current.focusPackMarks,
                // A kifizetett ablak-lazítások és a saját jelek — a fésülés ezekből dönt.
                packLoosens = current.focusPackLoosens,
                packOwnMarks = current.focusPackOwnMarks,
                // Csak az ÉLŐ zárlat megy fel; a lejártat nincs értelme vinni — és
                // a lejövő oldalon is csak az élő számít (focusFromJson + now).
                lockdown = LockdownLogic.live(current.lockdown, now),
                // Az ablakok a jelükkel — a fésülés ebből tudja, kié az újabb szó.
                lockdownWindows = current.lockdownWindows,
                lockdownWindowsRev = current.lockdownWindowsRev,
                lockdownWindowMarks = current.lockdownWindowMarks,
                // A megbízott a jelével — a fésülés ebből tudja, kié az újabb szó.
                partner = current.partner,
                partnerRev = current.partnerRev,
                partnerCo = current.partnerCo,
                partnersGone = current.partnersGone,
                // A rejtés a jelével — a fésülés ebből tudja, kié az újabb szó.
                hideSiteList = current.hideSiteList,
                hideSiteListRev = current.hideSiteListRev,
                // A kulcsszavak a jelükkel — mint az ablakok.
                keywords = current.keywords,
                keywordsRev = current.keywordsRev,
                keywordMarks = current.keywordMarks,
            )
            val merged = FocusSync.merge(mine, remote, now)

            if (!FocusSync.same(merged, mine)) {
                current = current.copy(
                    focusPacks = merged.packs,
                    focusRun = merged.run,
                    // A jelek az összefésülés eredményéből: a telefon hordozza őket.
                    focusPackMarks = merged.packMarks,
                    focusPackLoosens = merged.packLoosens,
                    focusPackOwnMarks = merged.packOwnMarks,
                    // A NAPLÓ a többi eszköztől is megjön — ettől lesz a
                    // statisztika a fiók egészéről szóló szám. Egyesítés, tehát
                    // a helyi sorok nem vesznek el.
                    focusLog = FocusSync.mergeLog(merged.log, current.focusLog),
                    focusRev = merged.rev,
                    focusUpdatedAt = merged.updatedAt,
                    focusUpdatedBy = merged.updatedBy,
                    // A MÁSIK ESZKÖZÖN INDÍTOTT ZÁRLAT itt lép életbe. A
                    // fésülés magasvízjel, tehát ez sosem rövidít.
                    lockdown = merged.lockdown,
                    // AZ ABLAKOK IS: a fésülés a jelük szerint döntött, és a kör
                    // a következő fordulóban már ezek szerint ír zárlatot.
                    lockdownWindows = merged.lockdownWindows,
                    lockdownWindowsRev = merged.lockdownWindowsRev,
                    lockdownWindowMarks = merged.lockdownWindowMarks,
                    // A MEGBÍZOTT IS — azonosság szerint: a másik eszközön
                    // felvett innentől itt is az utolsó szó (társként, ha itt
                    // is van); a levétel csak a nyomával érkezik.
                    partner = merged.partner,
                    partnerRev = merged.partnerRev,
                    partnerCo = merged.partnerCo,
                    partnersGone = merged.partnersGone,
                    // A REJTÉS IS a jele szerint: a gépen bekapcsolt rejtés innentől
                    // itt is áll; a kikapcsolás (azonosítás után) csak nagyobb jellel.
                    hideSiteList = merged.hideSiteList,
                    hideSiteListRev = merged.hideSiteListRev,
                    // A KULCSSZAVAK IS a jelük szerint — a gép bővítménye a
                    // következő lehúzáskor már ezt a listát kapja.
                    keywords = merged.keywords,
                    keywordsRev = merged.keywordsRev,
                    keywordMarks = merged.keywordMarks,
                )
                // A lenyomatot ÚJRASZÁMOLJUK, nem a másik eszközét vesszük át:
                // enélkül a következő mentés fölöslegesen léptetné a számlálót,
                // és a két eszköz örökké írogatná egymást.
                current = SyncRevisions.adoptFocus(current)
            }
            if (FocusSync.same(merged, remote) && version > 0) return current

            val payload = SyncCrypto.encrypt(key, focusToJson(merged))
            if (payload.length > MAX_PAYLOAD_BYTES) {
                throw SyncException("A munkamenet adatai túl nagyok a szinkronhoz — a csomagok vagy a napló. " +
                        "A menet ettől még fut, csak a többi eszközre nem ér át.", "TOO_BIG")
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
            // A SÍRKÖVEK is a fésülésbe mennek (SyncMerge.isGone): a végigment
            // törlés így nem jön vissza, se a fiókból, se egy régi eszközről. Ami
            // nincs a helyi listán, és itt már esedékes, az a fésülés előtt
            // sírkő lesz; utána a fésült lista szétoszlik — a gép tükre.
            val localIds = current.sites.map { it.id }.toSet()
            val mine = toSyncSites(current.sites + current.goneSites)
            val incoming = SyncMerge.settleIncoming(remote, localIds, now)
            val merged = SyncMerge.mergeLists(mine, incoming)
            val split = SyncMerge.splitMerged(merged, localIds, now)

            if (split.sites != toSyncSites(current.sites) || split.gone != toSyncSites(current.goneSites)) {
                current = current.copy(
                    sites = fromSyncSites(split.sites, current.sites),
                    goneSites = fromSyncSites(split.gone, current.goneSites),
                )
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
        // NEM NÉMÁN. Egy RÉGI fiókkiszolgáló nem ismeri a `focus` gyűjteményt,
        // és 400-zal felel — a munkamenet ilyenkor sosem ér át, és a
        // felhasználó ezt semmiből nem tudná meg. Azt hinné, a funkció rossz.
        //
        // A kört ettől még nem állítjuk meg: a blokklista fontosabb, és az már
        // szinkronban van. Csak megjegyezzük, hogy a felület kiírhassa —
        // ugyanúgy, ahogy a gépen.
        runCatching {
            val before = current
            current = syncFocusRound(current, acc, key, now)
            if (current !== before) changed = true
            if (current.focusSyncError != null) {
                current = current.copy(focusSyncError = null)
                changed = true
            }
        }.onFailure { e ->
            val code = (e as? SyncException)?.code
            val msg = if (code == "BAD_REQUEST" || code == "SERVER") {
                "A fiókkiszolgálód nem ismeri a munkamenetet — valószínűleg " +
                    "régebbi verzió. Amíg nem frissül, a munkamenet csak ezen " +
                    "az eszközön él."
            } else {
                e.message ?: "A munkamenet szinkronja nem sikerült."
            }
            if (current.focusSyncError != msg) {
                current = current.copy(focusSyncError = msg)
                changed = true
            }
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
                // Az eszközazonosító a KISZOLGÁLÓTÓL jön, nem a blob belsejéből:
                // így egy eszköz nem beszélhet a másik nevében.
                LimitLogic.parseTodayDigest(SyncCrypto.decrypt(key, blob), deviceId)
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

    /** `internal`, hogy a megfelelőségi fixtúra a dróton át olvashassa (MergeFixtureTest). */
    internal fun usageFromJson(text: String): UsageLogic.UsageState {
        // A gép `combineUsage`-a szerint: csak szöveg a nap és a címke, csak
        // objektum a másodpercek, csak pozitív JSON-szám a másodperc — egy rossz
        // érték csak magát viszi (eddig a `getDouble` az egész napot vitte, a
        // „600” szöveget pedig számnak vette) —, és a kapcsoló csak a valódi
        // `true`-ra igaz (eddig a hiánya is igaz volt).
        val o = JSONObject(text)
        val days = mutableListOf<UsageLogic.UsageDay>()
        val arr = o.optJSONArray("days")
        for (i in 0 until (arr?.length() ?: 0)) {
            val d = arr!!.opt(i) as? JSONObject ?: continue
            val day = stringOf(d, "day") ?: continue
            val so = d.opt("seconds") as? JSONObject ?: continue
            val secs = mutableMapOf<String, Double>()
            for (k in so.keys()) {
                val v = numberOf(so, k) ?: continue
                if (v > 0) secs[k] = v
            }
            days.add(UsageLogic.UsageDay(day, secs))
        }
        val labels = mutableMapOf<String, String>()
        o.optJSONObject("labels")?.let { lo -> for (k in lo.keys()) stringOf(lo, k)?.let { labels[k] = it } }
        return UsageLogic.UsageState(days, labels, o.opt("enabled") == true)
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
