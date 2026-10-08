import Foundation

/// A FIREFOX KANÁRIJA: `use-application-dns.net`. Ha a rendszer DNS-e erre
/// NXDOMAIN-t ad, az ALAPBÓL bekapcsolt titkosított DNS-t (DoH) a Firefox
/// kikapcsolja, és a rendszer DNS-ét — vagyis a szűrőt — használja. Enélkül egy
/// alapbeállítású Firefox a szűrő mellett oldaná fel a neveket, és a tiltás
/// benne nem érvényesülne.
///
/// Őszinte korlát: aki KÉZZEL kapcsolta be a böngésző titkosított DNS-ét, annál
/// a kanári nem hat (így írja a Mozilla is), és a Chrome nem kérdezi. A tükör:
/// android/.../core/DohCanary.kt.
/// Forrás: https://support.mozilla.org/kb/canary-domain-use-application-dnsnet
public enum DohCanary {
    public static let name = "use-application-dns.net"

    /// A lekérdezett név a kanári-e (a DNS-motor kisbetűs, pont nélküli nevet ad).
    public static func matches(_ host: String) -> Bool {
        var h = host.lowercased()
        while h.hasSuffix(".") { h.removeLast() }
        return h == name
    }
}
