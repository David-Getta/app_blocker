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
            s.burstSeconds.map { String($0) } ?? "-",
            s.cooldownSeconds.map { String($0) } ?? "-",
            s.alias ?? "-",
            // RENDEZVE: a sorrend nem jelent semmit, viszont ha beleszámítana,
            // egy átrendeződés fölöslegesen léptetné a számlálót, és minden
            // körben feltöltést indítana.
            s.rules.map { $0.map { r in r.host + r.path }.sorted().joined(separator: ",") } ?? "-",
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
        return bumpFocus(next, deviceId: deviceId, now: now)
    }

    /// A lenyomat formátumának jele.
    ///
    /// Azért van benne, hogy a formátumváltás FELISMERHETŐ legyen. Enélkül egy
    /// régi alakú lenyomat egyszerűen másnak látszana, és a frissítés utáni
    /// első kör mindenkinél léptetne egyet — egy ÜRES telefonon pedig ez azt
    /// jelentené, hogy az üres lista legyőzi a gépen felvett csomagokat.
    static let focusFpV2 = "2|"

    private static func packsPart(_ state: AppState) -> String {
        (state.focusPacks ?? []).sorted { $0.id < $1.id }.map { p in
            ([
                p.id, p.name,
                p.allowSites.sorted().joined(separator: ","),
                p.allowApps.sorted().joined(separator: ","),
                String(p.defaultMinutes),
                // Az ismétlődés is a csomag beállítása: a cseréje döntés, tehát
                // léptet. CSAK HA VAN: egy ablak nélküli csomag lenyomata ugyanaz
                // marad, mint a frissítés előtt — különben minden csomag egyszer
                // fölöslegesen léptetne.
            ] + (p.recurrence.map { [Focus.recurrenceKey($0)] } ?? [])).joined(separator: ";")
        }.joined(separator: "|")
    }

    private static func digestHex(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    /// A RÉGI lenyomat — kizárólag a formátumváltás felismeréséhez.
    ///
    /// Ne épüljön rá semmi új. Az egyetlen dolga, hogy a mentésben talált,
    /// régi alakú lenyomatról el tudjuk dönteni: az azóta VÁLTOZATLAN
    /// állapothoz tartozik-e, vagy közben valódi szerkesztés is történt.
    static func focusFingerprintV1(_ state: AppState) -> String {
        let run = state.focusRun.map { "\($0.packId);\($0.startedAt);\($0.endsAt)" } ?? "-"
        return digestHex("\(packsPart(state))//\(run)")
    }

    /// A munkamenet lenyomata.
    ///
    /// A FUTÓ menet benne van, ellentétben az oldalak szünetével — és ez a
    /// különbség szándékos. A szünet eszközfüggő és fel sem megy a
    /// kiszolgálóra; a munkamenet viszont a fiók egészére szól. Ha a futás
    /// kimaradna, az indítás sosem léptetné a számlálót, és a másik eszköz
    /// sosem tudná meg, hogy fut valami.
    static func focusFingerprint(_ state: AppState) -> String {
        // A futás HOSSZA számít, nem az abszolút időpontjai.
        //
        // Ez zárja be az óra-átállítás rését. Alvásból ébredve az app elnyeli
        // az ugrást: a kezdést és a véget UGYANANNYIVAL tolja el, hogy a menet
        // ne legyen lejárt. Abszolút időpontokkal ez változásnak látszott,
        // tehát léptette a számlálót — és így az alvó eszköz „még fut”
        // állapota legyőzte az ébren lévő eszköz szabályos lezárását. Az
        // elnyelés viszont nem döntés, csak helyi újraértelmezés; a HOSSZ
        // pedig egy egyenletes eltolástól nem változik.
        let run = state.focusRun.map { "\($0.packId);\($0.endsAt - $0.startedAt)" } ?? "-"
        return focusFpV2 + digestHex("\(packsPart(state))//\(run)")
    }

    /// A munkamenet számlálójának léptetése.
    ///
    /// AZ ÜRESSÉG NEM SZERKESZTÉS. Egy telefon, ami még sosem látott
    /// munkamenetet, ne lépjen 1-re pusztán attól, hogy először számolunk neki
    /// lenyomatot — különben az első szinkronnál az ÜRES listája nyerne az
    /// utolsó írót előnyben részesítő szabály szerint, és CSENDBEN letörölné a
    /// gépen felvett összes csomagot. Az oldalaknál ez nem fordulhat elő, mert
    /// ott rekordonként megy a számláló; itt EGY blob utazik.
    static func bumpFocus(_ state: AppState, deviceId: String, now: Double) -> AppState {
        let fp = focusFingerprint(state)
        if state.focusRevFp == fp { return state }
        var next = state
        if state.focusRevFp == nil && (state.focusPacks ?? []).isEmpty && state.focusRun == nil {
            next.focusRevFp = fp
            return next
        }
        // FORMÁTUMVÁLTÁS. A mentésben még a régi alakú lenyomat van; ettől
        // önmagában nem történt semmi. A régi algoritmussal döntjük el, volt-e
        // valódi változás: ha egyezik, csak a formátum változott — átvesszük
        // az újat léptetés nélkül. Ha eltér, akkor VOLT szerkesztés, és az
        // ugyanúgy léptet. Így a váltásnak nincs ablaka: sem szerkesztést nem
        // nyel el, sem fölöslegesen nem léptet egy üres telefonon.
        if let old = state.focusRevFp,
           !old.hasPrefix(focusFpV2),
           old == focusFingerprintV1(state) {
            next.focusRevFp = fp
            return next
        }
        next.focusRev = (state.focusRev ?? 0) + 1
        next.focusUpdatedAt = now
        next.focusUpdatedBy = deviceId
        next.focusRevFp = fp
        return next
    }

    /// Egy távolról átvett munkamenet lenyomatának újraszámolása.
    static func adoptFocus(_ state: AppState) -> AppState {
        var next = state
        next.focusRevFp = focusFingerprint(state)
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
