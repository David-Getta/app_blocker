import Foundation

/// Részleges tiltás: nem az egész oldal, csak egy darabja —
/// a `desktop/src/shared/urlrules.ts` tükre.
///
/// „A YouTube maradjon, de EZ a csatorna ne.” Ez más kérdés, mint az eddigi
/// tiltás, és fontos tudni, MIÉRT:
///
/// A blokkolás DNS-szinten megy, mert az az egyetlen pont, amit minden böngésző
/// és minden app lát — így él inkognitóban és vendég módban is. A DNS viszont
/// CSAK A HOSZTNEVET látja: `youtube.com`. Az utat (`/@valaki`) nem, mert az már
/// a titkosított HTTPS-kérésen belül van. Egy csatorna tiltása tehát a
/// DNS-motorral fizikailag lehetetlen — nem hiányzó munka, hanem a mechanizmus
/// határa.
///
/// A teljes URL-t a böngésző látja, ezért a részleges tiltást böngésző-bővítmény
/// érvényesíti. iPHONE-ON EZ MA NEM FUT: a Safarinak van bővítmény-rendszere,
/// de az külön alkalmazás-kiterjesztés, és a Chrome-nak iOS-en egyáltalán nincs.
/// A szabályokat MÉGIS itt tartjuk és szinkronizáljuk, mert:
///
///   - a felhasználó a telefonján veszi fel őket (onnan másolja a linket), és a
///     gépén akarja érvényesnek látni;
///   - a szinkron sosem dobhat el olyan mezőt, amit nem ért — különben a telefon
///     minden körben LETÖRÖLNÉ a gépen felvett szabályokat, csendben.
///
/// Ha valaha lesz Safari-bővítmény, a döntést hozó két függvény
/// (`matchesRule`, `anyRuleMatches`) készen áll.
enum UrlRules {

    /// Legfeljebb ennyi szabály tartozhat egy oldalhoz.
    static let maxRulesPerSite = 50

    /// Az út hossza felülről kötve — a felületen is ki kell férnie.
    static let maxRulePathLength = 200

    struct UrlRule: Codable, Equatable, Hashable {
        /// a hoszt, amire vonatkozik: `youtube.com`
        let host: String
        /// Út-előtag, `/`-rel kezdve, záró `/` nélkül: `/@valaki`.
        ///
        /// SOSEM üres. Az üres út az egész oldalt jelentené, arra viszont ott a
        /// DNS-szintű tiltás.
        let path: String
    }

    /// A mobil aldomain ugyanaz az oldal.
    ///
    /// Aki a telefonjáról másolja ki a linket, `m.youtube.com/@valaki`-t illeszt
    /// be. Ha ezt szó szerint vennénk, a szabály CSAK a mobil hoszton fogna — a
    /// gépen megnyitott ugyanolyan csatorna átmenne rajta, és semmi nem árulná
    /// el, miért. Telefonos appban ez a leggyakoribb eset, nem a kivétel.
    private static let aliasPrefixes = ["m.", "mobile."]

    private static func stripAliasPrefix(_ host: String) -> String {
        for prefix in aliasPrefixes where host.hasPrefix(prefix) {
            let rest = String(host.dropFirst(prefix.count))
            // Legalább két címke maradjon: `m.hu`-ból nem csinálunk `hu`-t.
            if rest.split(separator: ".", omittingEmptySubsequences: false).count >= 2 { return rest }
        }
        return host
    }

    private static func dropScheme(_ text: String) -> String {
        var s = text.replacingOccurrences(
            of: "^[a-zA-Z][a-zA-Z0-9+.-]*://", with: "", options: .regularExpression
        )
        s = s.replacingOccurrences(of: "^[^/@]*@", with: "", options: .regularExpression)
        return s
    }

    private static func collapseSlashes(_ path: String) -> String {
        path.replacingOccurrences(of: "/{2,}", with: "/", options: .regularExpression)
    }

    private static func firstCut(_ s: String) -> String.Index? {
        s.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" })
    }

    /// Amit az ember tényleg beír.
    ///
    /// Szándékosan bőkezű, mert a valóságban ezek kerülnek a vágólapra:
    ///
    ///     https://www.youtube.com/@valaki/videos?x=1  ->  youtube.com  /@valaki/videos
    ///     youtube.com/@valaki                          ->  youtube.com  /@valaki
    ///
    /// Amit NEM fogadunk el: hoszt út nélkül (az az egész oldal, arra a sima
    /// tiltás van), és út hoszt nélkül (nem tudnánk, mihez tartozik).
    static func normalizeRule(_ input: String) -> UrlRule? {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return nil }
        guard let host = Blocklist.normalizeDomain(raw) else { return nil }

        // A hoszt UTÁNI rész. A normalizeDomain már levágta a sémát és a
        // `www.`-t, ezért itt az EREDETIBŐL kell kikeresni az első `/`-t.
        let afterScheme = dropScheme(raw)
        guard let cut = firstCut(afterScheme) else { return nil } // csak hoszt
        var path = String(afterScheme[cut...])

        // A lekérdezés és a horgony nem része a szabálynak. A `?v=…` egy
        // KONKRÉT videó, nem egy csatorna; ha ezt beengednénk, a szabály
        // egyetlen linkre vonatkozna, és a felhasználó azt hinné, a csatornát
        // tiltotta le.
        path = String(path.prefix(while: { $0 != "?" && $0 != "#" }))
        while path.hasSuffix("/") { path.removeLast() }
        if path.isEmpty || path == "/" { return nil }
        if !path.hasPrefix("/") { return nil }

        path = collapseSlashes(path)
        if path.count > maxRulePathLength { return nil }
        // Vezérlőkarakter és szóköz nem való egy útba; a felületen se lenne
        // látható, mit tiltott le az ember.
        if path.unicodeScalars.contains(where: { $0.value <= 0x20 }) { return nil }

        return UrlRule(host: stripAliasPrefix(host), path: path.lowercased())
    }

    /// Ugyanaz a szabály-e (a duplikátumot nem vesszük fel kétszer).
    static func sameRule(_ a: UrlRule, _ b: UrlRule) -> Bool {
        a.host == b.host && a.path == b.path
    }

    /// Ráillik-e a szabály erre az URL-re?
    ///
    /// A hoszt akkor jó, ha EGYEZIK vagy ALDOMAINJE a szabály hosztjának, mert a
    /// `m.youtube.com/@valaki` ugyanaz a csatorna.
    ///
    /// Az út SZEGMENSHATÁRON illeszkedik, nem sztring-előtagként. Ez nem
    /// szőrözés: előtagként a `/@ab` ráillene a `/@abc`-re is, vagyis egy
    /// csatorna tiltása csendben letiltana egy másikat, akinek hasonlóan
    /// kezdődik a neve.
    static func matchesRule(_ rule: UrlRule, _ url: String) -> Bool {
        guard let parsed = splitUrl(url) else { return false }
        guard hostMatches(rule.host, parsed.host) else { return false }
        return parsed.path == rule.path || parsed.path.hasPrefix(rule.path + "/")
    }

    /// Illik-e BÁRMELYIK szabály az URL-re.
    static func anyRuleMatches(_ rules: [UrlRule], _ url: String) -> Bool {
        rules.contains { matchesRule($0, url) }
    }

    private static func hostMatches(_ ruleHost: String, _ host: String) -> Bool {
        host == ruleHost || host.hasSuffix("." + ruleHost)
    }

    /// URL -> (hoszt, út), beépített `URL` NÉLKÜL.
    ///
    /// Kézzel, mert ugyanennek a magnak három nyelven kell futnia, és mindegyik
    /// URL-elemzője máshol tér el. Ha a beépítettre támaszkodnánk, a három
    /// platform apró különbségeken csúszna szét — pont azon, hogy melyik URL
    /// számít tiltottnak.
    private static func splitUrl(_ url: String) -> (host: String, path: String)? {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        let s = dropScheme(trimmed)
        let cut = firstCut(s)
        var host = cut == nil ? s : String(s[s.startIndex..<cut!])
        var path = cut == nil ? "/" : String(s[cut!...])
        if let colon = host.firstIndex(of: ":") { host = String(host[host.startIndex..<colon]) }
        host = host.lowercased()
        while host.hasSuffix(".") { host.removeLast() }
        if host.isEmpty { return nil }
        if path.hasPrefix("?") || path.hasPrefix("#") { path = "/" }
        path = String(path.prefix(while: { $0 != "?" && $0 != "#" }))
        path = collapseSlashes(path)
        while path.hasSuffix("/") { path.removeLast() }
        if path.isEmpty { path = "/" }
        return (host, path.lowercased())
    }

    /// Ahogy a felületen látszik: `youtube.com/@valaki`.
    static func ruleLabel(_ rule: UrlRule) -> String { "\(rule.host)\(rule.path)" }
}
