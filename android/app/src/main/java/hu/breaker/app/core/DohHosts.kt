package hu.breaker.app.core

/**
 * ISMERT TITKOSÍTOTT-DNS-KISZOLGÁLÓK (DoH/DoT) NEVEI — a megkerülés NYOMA.
 *
 * Aki a böngészőben (vagy egy appban) kézzel ad meg titkosított DNS-t, annál
 * a névfeloldás a szűrő mellett megy, és a tiltás ott nem érvényesül. Amit a
 * szűrő ebből lát: indulás előtt az app a saját DNS-kiszolgálója NEVÉT a
 * rendszer DNS-én — vagyis a szűrőn — kérdezi meg. Ezt a kérdést a telefon
 * feljegyzi, és a kártya kimondja (tiltás nélkül: egy elrontott DNS-beállítás
 * a teljes internetet vinné el, és a döntés a felhasználóé).
 *
 * Őszinte korlát: csak a listán lévő neveket ismeri fel, és csak akkor, ha az
 * app tényleg a rendszeren át kérdez (egy beépített címmel induló app nem
 * látszik). A hiány tehát nem bizonyíték. A tükör: ios/Shared/DohHosts.swift.
 *
 * Forrás: a Chromium szolgáltatólistája (net/dns/public/doh_provider_entry.cc —
 * a DoH-sablonok és a DoT-nevek), kiegészítve a gyakori szolgáltatókkal
 * (NextDNS, AdGuard, Mullvad, Control D, dns0.eu, a Firefox Cloudflare-címe).
 */
object DohHosts {
    val KNOWN: Set<String> = setOf(
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
        "protective.joindns4.eu", "public.dns.iij.jp", "doh.xfinity.com", "doh.cox.net",
    )

    /** Profilonkénti nevek (pl. abc123.dns.nextdns.io): a végződés is elég. */
    private val SUFFIXES = listOf(".dns.nextdns.io", ".dns.controld.com")

    /** Ennyi időnként jegyzi fel újra ugyanazt a nevet — egy app percenként többször is kérdezheti. */
    const val NOTE_EVERY_MS = 10 * 60_000L

    /** A kártya ennyi ideig mondja a legutóbbit: utána a régi nyom már nem hír. */
    const val SHOW_FOR_MS = 24 * 3_600_000L

    /** A név tiszta alakja (kisbetű, gyökérpont nélkül), ha ismert kiszolgáló — különben null. */
    fun hostOf(name: String): String? {
        val h = name.trimEnd('.').lowercase(java.util.Locale.ROOT)
        return h.takeIf { it in KNOWN || SUFFIXES.any { s -> it.endsWith(s) } }
    }

    fun matches(name: String): Boolean = hostOf(name) != null

    /** Kell-e új feljegyzés: más név, vagy régebbi a ritkításnál (vagy az óra visszaugrott). */
    fun shouldNote(prevHost: String?, prevAt: Long?, host: String, now: Long): Boolean =
        prevHost != host || prevAt == null || now - prevAt >= NOTE_EVERY_MS || now < prevAt

    /**
     * A kártya szövege — null, ha nincs friss nyom, vagy a felhasználó erre a
     * névre már azt mondta: értem (akkor csak egy MÁSIK név hozza vissza).
     */
    fun cardText(host: String?, at: Long?, dismissedHost: String?, now: Long, android: Boolean): String? {
        if (host == null || at == null || host == dismissedHost) return null
        if (now - at > SHOW_FOR_MS || at - now > 60_000L) return null
        val ago = agoText(now - at)
        val device = if (android) "a telefonon" else "az eszközön"
        val where = if (android) {
            "Ha ez a böngésző, a tiltás benne nem érvényesül. Chrome-ban: Beállítások › Adatvédelem " +
                "és biztonság › Biztonságos DNS használata — kikapcsolva, vagy a jelenlegi " +
                "szolgáltatóval újra a szűrőn át kérdez."
        } else {
            "Ha ez egy böngésző, egy app vagy egy telepített DNS-profil, a tiltás ott nem érvényesül."
        }
        return "Valami $device titkosított " +
            "DNS-kiszolgálót keresett ($host, $ago). $where " +
            "A Breaker csak a nevet látja, azt nem, ki kérdezte."
    }

    /** „épp most”, „12 perce”, „3 órája” — a kártya szóhasználata. */
    fun agoText(ms: Long): String {
        val min = maxOf(0L, ms) / 60_000L
        return when {
            min < 2 -> "épp most"
            min < 60 -> "$min perce"
            else -> "${min / 60} órája"
        }
    }
}
