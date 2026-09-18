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
        var bands = "-"
        if let sch = s.schedule {
            let bandParts: [String] = sch.bands.map { b -> String in
                let days: [String] = b.days.sorted().map { String($0) }
                return "\(days.joined(separator: "+")):\(b.startMin)-\(b.endMin)"
            }
            bands = sch.mode.rawValue + bandParts.joined(separator: ";")
        }
        // Darabokban, kimondott típussal: egy tömbliteral csupa `??`-lal és
        // `map`-pel a fordítónak túl sok (unable to type-check in reasonable
        // time) — és ezt a CI napokig elnyelte.
        let pending: String = s.pendingDeleteAt.map { String($0) } ?? "-"
        let limit: String = s.dailyLimitSeconds.map { String($0) } ?? "-"
        let burst: String = s.burstSeconds.map { String($0) } ?? "-"
        let cooldown: String = s.cooldownSeconds.map { String($0) } ?? "-"
        // RENDEZVE: a sorrend nem jelent semmit, viszont ha beleszámítana,
        // egy átrendeződés fölöslegesen léptetné a számlálót, és minden
        // körben feltöltést indítana.
        let rules: String = s.rules.map { list -> String in
            list.map { r in r.host + r.path }.sorted().joined(separator: ",")
        } ?? "-"
        let parts: [String] = [
            s.domain,
            s.hostnames.sorted().joined(separator: ","),
            pending,
            bands,
            limit,
            burst,
            cooldown,
            s.alias ?? "-",
            s.reason ?? "-",
            rules,
        ]
        return parts.joined(separator: " ")
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

    /// Egy csomag kulcsa a lenyomathoz: ami a beállítása.
    private static func packKey(_ p: Focus.Pack) -> String {
        var fields: [String] = [
            p.id, p.name,
            p.allowSites.sorted().joined(separator: ","),
            p.allowApps.sorted().joined(separator: ","),
            String(p.defaultMinutes),
        ]
        // Az ismétlődés is a csomag beállítása: a cseréje döntés, tehát
        // léptet. CSAK HA VAN: egy ablak nélküli csomag lenyomata ugyanaz
        // marad, mint a frissítés előtt — különben minden csomag egyszer
        // fölöslegesen léptetne.
        if let rec = p.recurrence { fields.append(Focus.recurrenceKey(rec)) }
        return fields.joined(separator: ";")
    }

    private static func packsPart(_ state: AppState) -> String {
        (state.focusPacks ?? []).sorted { $0.id < $1.id }.map { packKey($0) }.joined(separator: "|")
    }

    /// A csomagok lenyomata a JELEKHEZ: azonosító → a beállítás kivonata. Helyi,
    /// nem drót: csak a saját előző léptetéssel vetjük össze. A gépi
    /// `packFingerprints` tükre (helper/revisions.ts).
    static func packFingerprints(_ state: AppState) -> [String: String] {
        var out: [String: String] = [:]
        for p in state.focusPacks ?? [] { out[p.id] = digestHex(packKey(p)) }
        return out
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
        // A ZÁRLAT-ABLAKOK IS: a lista cseréje döntés, tehát léptet. CSAK HA
        // VAN: az ablak nélküli állapot lenyomata ugyanaz marad, mint a
        // frissítés előtt — különben minden iPhone egyszer fölöslegesen léptetne.
        let windows = windowsKey(state)
        // A MEGBÍZOTT IS: a felvétele és a levétele döntés, tehát léptet. Csak
        // ha van, címkével — a nélküle lévő állapot lenyomata változatlan.
        let partner = PartnerLogic.partnerKey(state.partner)
        // A KULCSSZAVAK IS: a lista cseréje döntés, tehát léptet — csak ha van, címkével.
        let keywords = keywordsKey(state)
        return focusFpV2 + digestHex(
            "\(packsPart(state))//\(run)" + (windows.isEmpty ? "" : "//\(windows)")
                + (partner.isEmpty ? "" : "//partner//\(partner)")
                + (keywords.isEmpty ? "" : "//keywords//\(keywords)")
        )
    }

    /// A kulcsszó-lista tartalmi kulcsa — üres listára üres szöveg.
    static func keywordsKey(_ state: AppState) -> String {
        KeywordLogic.keywordsKey(state.keywords ?? [])
    }

    /// Az ablak-lista tartalmi kulcsa — üres listára üres szöveg.
    static func windowsKey(_ state: AppState) -> String {
        (state.lockdownWindows ?? []).map { LockdownLogic.windowKey($0.band) }.sorted().joined(separator: "|")
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
        if state.focusRevFp == nil && (state.focusPacks ?? []).isEmpty && state.focusRun == nil
            && (state.lockdownWindows ?? []).isEmpty && state.partner == nil
            && (state.keywords ?? []).isEmpty {
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
        let newRev = (state.focusRev ?? 0) + 1
        next.focusRev = newRev
        next.focusUpdatedAt = now
        next.focusUpdatedBy = deviceId
        next.focusRevFp = fp
        // Az ablak-lista JELE: ha a lista az előző léptetés óta változott, a
        // jele ez a blob-rev. Az iPhone nem szerkeszt ablakot, de a jel
        // könyvelése ugyanaz, mint a gépen.
        let windows = windowsKey(state)
        if windows != (state.focusRevWindows ?? "") { next.lockdownWindowsRev = Int(newRev) }
        next.focusRevWindows = windows
        // A megbízott jele ugyanígy: ha az előző léptetés óta változott, a
        // jele ez a blob-rev — a fésülés ebből tudja, kié az újabb szó.
        let partner = PartnerLogic.partnerKey(state.partner)
        if partner != (state.focusRevPartner ?? "") { next.partnerRev = Int(newRev) }
        next.focusRevPartner = partner
        // A kulcsszavak jele ugyanígy.
        let keywords = keywordsKey(state)
        if keywords != (state.focusRevKeywords ?? "") { next.keywordsRev = Int(newRev) }
        next.focusRevKeywords = keywords
        // A CSOMAGOK JELEI: ami az előző léptetés óta bekerült, változott vagy
        // kikerült, az ezt a blob-revet kapja — csomagonként, mint a gépen
        // (helper/revisions.ts `markPacks`). Az első léptetés (nincs még eltett
        // lenyomat) jel nélkül megy — a régi kliens szabálya áll rá. Amíg az
        // iPhone nem szerkeszt csomagot, egy jel sem változik; az ablak a
        // csúcs-órára az első ilyen szerkesztés — jel nélkül a gép egy ugyanabban
        // a körben tett szerkesztése a fésülésben csendben letörölné.
        let packFps = packFingerprints(state)
        if let prevFps = state.focusRevPacks {
            var marks = state.focusPackMarks ?? [:]
            for (id, f) in packFps where prevFps[id] != f { marks[id] = Int(newRev) }
            for id in prevFps.keys where packFps[id] == nil { marks[id] = Int(newRev) }
            next.focusPackMarks = FocusSync.capPackMarks(marks, Array(packFps.keys))
        }
        next.focusRevPacks = packFps
        return next
    }

    /// Egy távolról átvett munkamenet lenyomatának újraszámolása.
    static func adoptFocus(_ state: AppState) -> AppState {
        var next = state
        next.focusRevFp = focusFingerprint(state)
        next.focusRevWindows = windowsKey(state)
        // A megbízott kulcsa is: az átvett megbízott nem a miénk — a következő
        // saját szerkesztés ne bélyegezze át a jelét, mert azzal egy másik
        // eszköz levételét lehetne felülírni.
        next.focusRevPartner = PartnerLogic.partnerKey(state.partner)
        next.focusRevKeywords = keywordsKey(state)
        // A csomagok lenyomata is: az átvett lista nem a miénk — a következő
        // saját léptetés ne bélyegezze át a jelét.
        next.focusRevPacks = packFingerprints(state)
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
