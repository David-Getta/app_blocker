import Foundation

/// ISMERT TITKOSÍTOTT-DNS-KISZOLGÁLÓK (DoH/DoT) NEVEI — a megkerülés NYOMA.
///
/// Aki a böngészőben (vagy egy appban) kézzel ad meg titkosított DNS-t, annál
/// a névfeloldás a szűrő mellett megy, és a tiltás ott nem érvényesül. Amit a
/// szűrő ebből lát: indulás előtt az app a saját DNS-kiszolgálója NEVÉT a
/// rendszer DNS-én — vagyis a szűrőn — kérdezi meg. Ezt a kérdést a telefon
/// feljegyzi, és a kártya kimondja (tiltás nélkül: egy elrontott DNS-beállítás
/// a teljes internetet vinné el, és a döntés a felhasználóé).
///
/// Őszinte korlát: csak a listán lévő neveket ismeri fel, és csak akkor, ha az
/// app tényleg a rendszeren át kérdez. A hiány tehát nem bizonyíték. A tükör:
/// android/.../core/DohHosts.kt — a lista és a szövegek egyezését a
/// check-core-sync őr nézi.
public enum DohHosts {
    public static let known: Set<String> = [
        // Google
        "dns.google", "dns.google.com", "8888.google", "dns64.dns.google",
        // Cloudflare
        "cloudflare-dns.com", "one.one.one.one", "1dot1dot1dot1.cloudflare-dns.com",
        "chrome.cloudflare-dns.com", "mozilla.cloudflare-dns.com",
        "security.cloudflare-dns.com", "family.cloudflare-dns.com",
        // Quad9
        "dns.quad9.net", "dns9.quad9.net", "dns10.quad9.net", "dns11.quad9.net",
        // OpenDNS / Cisco
        "doh.opendns.com", "doh.familyshield.opendns.com",
        // CleanBrowsing
        "doh.cleanbrowsing.org", "adult-filter-dns.cleanbrowsing.org",
        "family-filter-dns.cleanbrowsing.org", "security-filter-dns.cleanbrowsing.org",
        // NextDNS
        "dns.nextdns.io", "chromium.dns.nextdns.io",
        // AdGuard
        "dns.adguard-dns.com", "unfiltered.adguard-dns.com", "family.adguard-dns.com", "dns.adguard.com",
        // Mullvad
        "dns.mullvad.net", "doh.mullvad.net", "base.dns.mullvad.net", "adblock.dns.mullvad.net",
        // Control D
        "dns.controld.com", "freedns.controld.com",
        // Egyéb a Chromium listájáról és gyakoriak
        "dns0.eu", "doh.dns.sb", "dns.sb", "odvr.nic.cz", "dns.levonet.sk",
        "protective.joindns4.eu", "public.dns.iij.jp", "doh.xfinity.com", "dot.xfinity.com",
        "doh.cox.net", "dot.cox.net", "doh.quickline.ch", "dot.quickline.ch",
        "doh-01.spectrum.com", "doh-02.spectrum.com",
    ]

    /// Profilonkénti nevek (pl. abc123.dns.nextdns.io): a végződés is elég.
    static let suffixes = [".dns.nextdns.io", ".dns.controld.com"]

    /// Ennyi időnként jegyzi fel újra ugyanazt a nevet.
    public static let noteEveryMs: Double = 10 * 60_000

    /// A kártya ennyi ideig mondja a legutóbbit.
    public static let showForMs: Double = 24 * 3_600_000

    /// A név tiszta alakja (kisbetű, gyökérpont nélkül), ha ismert kiszolgáló — különben nil.
    public static func hostOf(_ name: String) -> String? {
        var h = name.lowercased()
        while h.hasSuffix(".") { h.removeLast() }
        return known.contains(h) || suffixes.contains(where: { h.hasSuffix($0) }) ? h : nil
    }

    public static func matches(_ name: String) -> Bool { hostOf(name) != nil }

    /// Ennyi nevet jegyez meg az „Értem” — a legrégebbi esik ki, ha betelt.
    public static let maxDismissed = 32

    /// Kell-e új feljegyzés: más név, vagy régebbi a ritkításnál (vagy az óra
    /// visszaugrott). Amire a felhasználó már azt mondta: értem, az nem kerül a
    /// helyre — különben egy némított név újabb kérdése kitúrná a még nem
    /// látott, MÁSIK nyomot, és a kártya aszerint villogna, ki kérdezett utoljára.
    public static func shouldNote(prevHost: String?, prevAt: Double?, host: String, now: Double, dismissed: [String]) -> Bool {
        if dismissed.contains(host) { return false }
        guard prevHost == host, let prevAt else { return true }
        return now - prevAt >= noteEveryMs || now < prevAt
    }

    /// A kártya szövege — nil, ha nincs friss nyom, vagy a felhasználó erre a
    /// névre már azt mondta: értem (akkor csak egy MÁSIK név hozza vissza).
    public static func cardText(host: String?, at: Double?, dismissed: [String], now: Double, android: Bool) -> String? {
        guard let host, let at, !dismissed.contains(host) else { return nil }
        if now - at > showForMs || at - now > 60_000 { return nil }
        let ago = agoText(now - at)
        let device = android ? "a telefonon" : "az eszközön"
        let place = android
            ? "Ha ez a böngésző, a tiltás benne nem érvényesül. Chrome-ban: Beállítások › Adatvédelem "
                + "és biztonság › Biztonságos DNS használata — kikapcsolva, vagy a jelenlegi "
                + "szolgáltatóval újra a szűrőn át kérdez."
            : "Ha ez egy böngésző, egy app vagy egy telepített DNS-profil, a tiltás ott nem érvényesül."
        return "Valami \(device) titkosított "
            + "DNS-kiszolgálót keresett (\(host), \(ago)). \(place) "
            + "A Breaker csak a nevet látja, azt nem, ki kérdezte."
    }

    /// Az „Értem”: a név a némítottak végére; ha betelt, a legrégebbi kiesik.
    public static func dismiss(_ dismissed: [String], _ host: String?) -> [String] {
        guard let host, !dismissed.contains(host) else { return dismissed }
        return Array((dismissed + [host]).suffix(maxDismissed))
    }

    /// „épp most”, „12 perce”, „3 órája” — a kártya szóhasználata.
    public static func agoText(_ ms: Double) -> String {
        let min = Int(Swift.max(0, ms) / 60_000)
        if min < 2 { return "épp most" }
        if min < 60 { return "\(min) perce" }
        return "\(min / 60) órája"
    }
}
