package hu.breaker.app.core

/**
 * Részleges tiltás: nem az egész oldal, csak egy darabja —
 * a `desktop/src/shared/urlrules.ts` tükre.
 *
 * „A YouTube maradjon, de EZ a csatorna ne.” Ez más kérdés, mint az eddigi
 * tiltás, és fontos tudni, MIÉRT:
 *
 * A blokkolás DNS-szinten megy, mert az az egyetlen pont, amit minden böngésző
 * és minden app lát — így él inkognitóban és vendég módban is. A DNS viszont
 * CSAK A HOSZTNEVET látja: `youtube.com`. Az utat (`/@valaki`) nem, mert az már
 * a titkosított HTTPS-kérésen belül van. Egy csatorna tiltása tehát a
 * DNS-motorral fizikailag lehetetlen — nem hiányzó munka, hanem a mechanizmus
 * határa.
 *
 * A teljes URL-t a böngésző látja, ezért a részleges tiltást böngésző-bővítmény
 * érvényesíti. ANDROIDON EZ MA NEM FUT: a Chrome-nak nincs bővítmény-támogatása
 * telefonon. A szabályokat MÉGIS itt tartjuk és szinkronizáljuk, mert:
 *
 *   - a felhasználó a telefonján veszi fel őket (onnan másolja a linket), és a
 *     gépén akarja érvényesnek látni;
 *   - a szinkron sosem dobhat el olyan mezőt, amit nem ért — különben a telefon
 *     minden körben LETÖRÖLNÉ a gépen felvett szabályokat, csendben.
 *
 * Ha valaha lesz androidos böngésző-integráció, a döntést hozó két függvény
 * (`matchesRule`, `anyRuleMatches`) készen áll.
 */
object UrlRules {

    /** Legfeljebb ennyi szabály tartozhat egy oldalhoz. */
    const val MAX_RULES_PER_SITE = 50

    /** Az út hossza felülről kötve — a felületen is ki kell férnie. */
    const val MAX_RULE_PATH_LENGTH = 200

    data class UrlRule(
        /** a hoszt, amire vonatkozik: `youtube.com` */
        val host: String,
        /**
         * Út-előtag, `/`-rel kezdve, záró `/` nélkül: `/@valaki`.
         *
         * SOSEM üres. Az üres út az egész oldalt jelentené, arra viszont ott a
         * DNS-szintű tiltás.
         */
        val path: String,
    )

    /**
     * A mobil aldomain ugyanaz az oldal.
     *
     * Aki a telefonjáról másolja ki a linket, `m.youtube.com/@valaki`-t illeszt
     * be. Ha ezt szó szerint vennénk, a szabály CSAK a mobil hoszton fogna — a
     * gépen megnyitott ugyanolyan csatorna átmenne rajta, és semmi nem árulná
     * el, miért. Telefonos appban ez a leggyakoribb eset, nem a kivétel.
     */
    private val ALIAS_PREFIXES = listOf("m.", "mobile.")

    private fun stripAliasPrefix(host: String): String {
        for (prefix in ALIAS_PREFIXES) {
            if (host.startsWith(prefix)) {
                val rest = host.substring(prefix.length)
                // Legalább két címke maradjon: `m.hu`-ból nem csinálunk `hu`-t.
                if (rest.split(".").size >= 2) return rest
            }
        }
        return host
    }

    /**
     * Amit az ember tényleg beír.
     *
     * Szándékosan bőkezű, mert a valóságban ezek kerülnek a vágólapra:
     *
     *   https://www.youtube.com/@valaki/videos?x=1  ->  youtube.com  /@valaki/videos
     *   youtube.com/@valaki                          ->  youtube.com  /@valaki
     *
     * Amit NEM fogadunk el: hoszt út nélkül (az az egész oldal, arra a sima
     * tiltás van), és út hoszt nélkül (nem tudnánk, mihez tartozik).
     */
    fun normalizeRule(input: String): UrlRule? {
        val raw = input.trim()
        if (raw.isEmpty()) return null

        val host = Blocklist.normalizeDomain(raw) ?: return null

        // A hoszt UTÁNI rész. A normalizeDomain már levágta a sémát és a
        // `www.`-t, ezért itt az EREDETIBŐL kell kikeresni az első `/`-t.
        var afterScheme = raw.replace(Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://"), "")
        afterScheme = afterScheme.replace(Regex("^[^/@]*@"), "")
        val slash = afterScheme.indexOfFirst { it == '/' || it == '?' || it == '#' }
        if (slash < 0) return null // csak hoszt: ez az egész oldal
        var path = afterScheme.substring(slash)

        // A lekérdezés és a horgony nem része a szabálynak. A `?v=…` egy
        // KONKRÉT videó, nem egy csatorna; ha ezt beengednénk, a szabály
        // egyetlen linkre vonatkozna, és a felhasználó azt hinné, a csatornát
        // tiltotta le.
        path = path.split('?', '#')[0]
        path = path.trimEnd('/')
        if (path.isEmpty() || path == "/") return null
        if (!path.startsWith("/")) return null

        path = path.replace(Regex("/{2,}"), "/")
        if (path.length > MAX_RULE_PATH_LENGTH) return null
        // Vezérlőkarakter és szóköz nem való egy útba; a felületen se lenne
        // látható, mit tiltott le az ember.
        if (path.any { it.code <= 0x20 }) return null

        return UrlRule(stripAliasPrefix(host), path.lowercase())
    }

    /** Ugyanaz a szabály-e (a duplikátumot nem vesszük fel kétszer). */
    fun sameRule(a: UrlRule, b: UrlRule): Boolean = a.host == b.host && a.path == b.path

    /**
     * Ráillik-e a szabály erre az URL-re?
     *
     * A hoszt akkor jó, ha EGYEZIK vagy ALDOMAINJE a szabály hosztjának, mert a
     * `m.youtube.com/@valaki` ugyanaz a csatorna.
     *
     * Az út SZEGMENSHATÁRON illeszkedik, nem sztring-előtagként. Ez nem
     * szőrözés: előtagként a `/@ab` ráillene a `/@abc`-re is, vagyis egy
     * csatorna tiltása csendben letiltana egy másikat, akinek hasonlóan
     * kezdődik a neve.
     */
    fun matchesRule(rule: UrlRule, url: String): Boolean {
        val parsed = splitUrl(url) ?: return false
        if (!hostMatches(rule.host, parsed.first)) return false
        val path = parsed.second
        return path == rule.path || path.startsWith(rule.path + "/")
    }

    /** Illik-e BÁRMELYIK szabály az URL-re. */
    fun anyRuleMatches(rules: List<UrlRule>, url: String): Boolean =
        rules.any { matchesRule(it, url) }

    private fun hostMatches(ruleHost: String, host: String): Boolean =
        host == ruleHost || host.endsWith(".$ruleHost")

    /**
     * URL -> (hoszt, út), beépített URL-elemző NÉLKÜL.
     *
     * Kézzel, mert ugyanennek a magnak három nyelven kell futnia, és mindegyik
     * URL-elemzője máshol tér el. Ha a beépítettre támaszkodnánk, a három
     * platform apró különbségeken csúszna szét — pont azon, hogy melyik URL
     * számít tiltottnak.
     */
    private fun splitUrl(url: String): Pair<String, String>? {
        var s = url.trim()
        if (s.isEmpty()) return null
        s = s.replace(Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://"), "")
        s = s.replace(Regex("^[^/@]*@"), "")
        val cut = s.indexOfFirst { it == '/' || it == '?' || it == '#' }
        var host = if (cut < 0) s else s.substring(0, cut)
        var path = if (cut < 0) "/" else s.substring(cut)
        val colon = host.indexOf(':')
        if (colon >= 0) host = host.substring(0, colon)
        host = host.lowercase().trimEnd('.')
        if (host.isEmpty()) return null
        if (path.startsWith("?") || path.startsWith("#")) path = "/"
        path = path.split('?', '#')[0]
        path = path.replace(Regex("/{2,}"), "/").trimEnd('/')
        if (path.isEmpty()) path = "/"
        return Pair(host, path.lowercase())
    }

    /** Ahogy a felületen látszik: `youtube.com/@valaki`. */
    fun ruleLabel(rule: UrlRule): String = "${rule.host}${rule.path}"
}
