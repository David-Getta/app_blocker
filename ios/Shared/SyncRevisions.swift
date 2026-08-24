import Foundation
import CryptoKit

/// Verziószám-vezetés a szinkronhoz — a `desktop/src/helper/revisions.ts` tükre.
///
/// Az összefésülés azon áll, hogy minden oldal-rekordnak van egy `rev`
/// számlálója, ami MINDEN érdemi változásnál nő. Ez dönti el, mikor mehet át egy
/// lazítás a másik eszközre: a nagyobb `rev` mögött ott a munka.
///
/// A lenyomat a MENTETT állapotban van, nem a memóriában, tehát az app
/// újraindítása nem hajtja fel a számlálót a semmiért.
enum SyncRevisions {

    /// Amit a szinkron lát egy rekordból.
    ///
    /// A SZÜNET kimarad: eszközfüggő és rövid életű, fel se megy a kiszolgálóra.
    /// A napi keret viszont BENNE van, pedig iPhone-on nem érvényesül — mert
    /// hordozzuk, és ha a gépen megváltoztatják, azt látnunk kell.
    private static func syncFields(_ s: Site) -> String {
        let bands = s.schedule.map { sch in
            sch.mode.rawValue + sch.bands.map { b in
                "\(b.days.sorted().map(String.init).joined(separator: "+")):\(b.startMin)-\(b.endMin)"
            }.joined(separator: ";")
        } ?? "-"
        return [
            s.domain,
            s.hostnames.sorted().joined(separator: ","),
            s.pendingDeleteAt.map { String($0) } ?? "-",
            bands,
            s.dailyLimitSeconds.map { String($0) } ?? "-",
            s.alias ?? "-",
        ].joined(separator: " ")
    }

    static func fingerprint(_ s: Site) -> String {
        let digest = SHA256.hash(data: Data(syncFields(s).utf8))
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    /// A megváltozott rekordok számlálójának léptetése.
    static func bump(_ state: AppState, now: Double) -> AppState {
        let deviceId = state.sync?.deviceId ?? "local"
        var next = state
        next.sites = state.sites.map { site in
            let fp = fingerprint(site)
            if site.revFp == fp { return site }
            var out = site
            out.rev = (site.rev ?? 0) + 1
            out.updatedAt = now
            out.updatedBy = deviceId
            out.revFp = fp
            return out
        }
        return next
    }

    /// Egy távolról érkezett rekord átvétele — a lenyomatot ÚJRASZÁMOLJUK, hogy
    /// ne induljon be egy végtelen oda-vissza írás.
    static func adopt(_ site: Site) -> Site {
        var out = site
        out.revFp = fingerprint(site)
        return out
    }
}
