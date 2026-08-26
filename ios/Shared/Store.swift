import Foundation
import Combine

struct Site: Codable, Identifiable, Equatable {
    let id: String
    let domain: String
    let hostnames: [String]
    let addedAt: Double
    var pauseUntil: Double?
    var pendingDeleteAt: Double?
    /// optional weekly schedule; nil = always blocked
    var schedule: ScheduleLogic.Schedule?
    /// fedőnév: ha van, a felület ezt írja ki a cím helyett (AliasLogic)
    var alias: String?
    /// Napi keret másodpercben.
    ///
    /// Mérni iPhone-on nem tudunk (nincs ilyen API a `DeviceActivity`
    /// entitlement nélkül), de a keret ettől még ÉRVÉNYESÜL: a gép és az
    /// androidos telefon feltölti, mennyit mért ma, és a `LimitLogic` azt is
    /// beszámítja. Ha a napi húsz perc a gépen elfogyott, itt is zárva van.
    var dailyLimitSeconds: Double?
    /// Részleges szabályok: az oldal egy-egy darabja (pl. `/@valaki`).
    ///
    /// iPHONE-ON EZEKET SEMMI NEM ÉRVÉNYESÍTI — a Safari kiterjesztése külön
    /// alkalmazás, a DNS-motor pedig a hosztnévnél tovább nem lát. Tárolni és
    /// szinkronizálni MÉGIS kell őket, mert enélkül a telefon minden
    /// szinkron-körben LETÖRÖLNÉ a gépen felvett szabályokat: ami átmegy egy
    /// kliensen, ami nem ismeri a mezőt, abból eltűnik.
    ///
    /// A `nil` és a `[]` KÜLÖNBÖZŐ: az első azt jelenti, hogy nem tudunk
    /// szabályokról, a második azt, hogy voltak és levették őket (lásd
    /// `SyncMerge.mergeRules`).
    var rules: [UrlRules.UrlRule]?

    // --- szinkron (lásd SyncRevisions és SyncMerge) ---
    /// hányszor változott érdemben ez a rekord
    var rev: Int?
    /// mikor változott utoljára (ms)
    var updatedAt: Double?
    /// melyik eszközön — a döntetlen eltörésére
    var updatedBy: String?
    /// a szinkron-mezők lenyomata a legutóbbi léptetéskor
    var revFp: String?
}

struct SessionRec: Codable, Equatable, Identifiable {
    let id: String
    let kind: ChallengeEngine.Kind
    let siteId: String
    let minutes: Int?
    var steps: [ChallengeEngine.Step]
    var stepIndex: Int
    /// var, not let: a forward clock jump pushes it, so the jump cannot age the
    /// attempt out (see Referee.absorbClockJump).
    var createdAt: Double
    /// when set, finishing applies this schedule instead of pausing (gated loosening)
    var pendingSchedule: ScheduleLogic.Schedule?
    /// Ha van, a teljesítés a MUNKAMENET végét tolja el — vagy leállítja.
    ///
    /// A -1 azt jelenti: „állítsd le most”. A nulla nem lenne jó jelölés, mert
    /// az érvényes időpont. A munkamenet nem egy OLDALHOZ tartozik, hanem az
    /// egész készülékhez, ezért a teljesítés ezt az ágat az oldal-keresés ELŐTT
    /// nézi. Optional, hogy egy korábbi verzió által írt állapot is dekódolható
    /// maradjon.
    var pendingFocusEnd: Double?
}

/// What an abandoned attempt leaves behind, so restarting cannot re-roll it.
///
/// Kept PER SITE: with a single shared slot, starting and cancelling an attempt
/// on any other site (or the delete flow on the same one) would evict the debt
/// and hand back a fresh draw — the re-roll again, one step removed.
struct AbandonRec: Codable, Equatable {
    let siteId: String
    let kind: ChallengeEngine.Kind
    let comboKey: String
    let at: Double
}

struct AppState: Codable, Equatable {
    var protectionOn: Bool = false
    var sites: [Site] = []
    var unlockLog: [Double] = []
    var lastCombo: String? = nil
    var session: SessionRec? = nil
    /// attempts given up on, per site; see ChallengeEngine.rerollCooldownMs.
    /// Optional so a state file written before this existed still decodes.
    var abandons: [AbandonRec]? = nil
    /// Rejtve induljon-e a blokkolt oldalak listája.
    ///
    /// Beállítás, nem pillanatnyi állapot: a felület minden indításkor rejtve
    /// kezdi, és csak a munkamenetre nyitható meg. Így az app megnyitása
    /// önmagában nem szembesít azzal, mi van blokkolva. Optional, hogy egy
    /// korábbi verzió által írt állapot is dekódolható maradjon.
    var hideSiteList: Bool? = nil
    /// fiók a szinkronhoz; nil = nincs bejelentkezve
    var sync: SyncAccount? = nil
    /// A többi eszköz mai összegzése — ebből lesz a KÖZÖS napi keret.
    ///
    /// Azért van elmentve, és nem csak a memóriában: ha az appot kilövik, vagy
    /// a szinkron épp nem érhető el, a délelőtt a gépen elhasznált keret ne
    /// induljon újra nulláról. Elavulni nem tud, mert minden sor a saját napját
    /// hozza — éjfélkor magától kiürül. Optional, hogy egy korábbi verzió által
    /// írt állapot is dekódolható maradjon.
    var sharedToday: LimitLogic.SharedToday? = nil
    /// Munkamenet-csomagok: „most csak EZ mehet”.
    ///
    /// A blokklista feketelista, ez FEHÉRLISTA. iPhone-on ez ERŐSEBB, mint a
    /// gépen: a csomagalagút minden névfeloldást lát. Optional, hogy egy
    /// korábbi verzió által írt állapot is dekódolható maradjon.
    var focusPacks: [Focus.Pack]? = nil
    /// a FUTÓ munkamenet — a fiók egészére szól, nem eszközönként
    var focusRun: Focus.Run? = nil
    /// A LEZÁRULT menetek naplója — ebből lesz a statisztika.
    ///
    /// Itt ugyanúgy kell, mint a gépen: a menetet MÁR itt is lehet indítani és
    /// leállítani, tehát ha csak a gép naplózna, az itt lefutott menetek nem
    /// léteznének. Optional, hogy egy korábbi verzió állapota is dekódolható
    /// maradjon.
    var focusLog: [Focus.LogEntry]? = nil
    /// a munkamenet szinkron-számlálója; lásd shared/sync/focus-merge.ts
    var focusRev: Double? = nil
    var focusUpdatedAt: Double? = nil
    var focusUpdatedBy: String? = nil
    /// a lenyomat, amiből kiderül, hogy változott-e
    var focusRevFp: String? = nil
    /// Miért nem sikerült a munkamenet szinkronja — vagy nil, ha sikerült.
    ///
    /// Ez a mező a mentésbe is BELEKERÜL, mert az `AppState` `Codable`-ja minden
    /// tulajdonságot elment. Az androidos oldalon nem: ott a mentés kézzel
    /// felsorolt mezőkből épül. A különbség apró, és nem hallgatjuk el: itt
    /// indítás után egy pillanatra még a KORÁBBI hibaüzenet állhat, amíg az
    /// első szinkron-kör le nem fut és ki nem törli.
    ///
    /// Azért `Optional`, és ez nem stílus: a Swift automatikus dekódolása a
    /// hiányzó kulcsra opcionálisnál `nil`-t ad, nem-opcionálisnál viszont
    /// HIBÁT DOB — egy korábbi verzió mentése akkor olvashatatlan lenne.
    var focusSyncError: String? = nil
}

/// Fiók a szinkronhoz.
///
/// A `dataKey` az app saját, védett tárolójában marad. A végpontok közti
/// titkosítás a KISZOLGÁLÓ ellen véd, nem a saját készüléked ellen.
struct SyncAccount: Codable, Equatable {
    var serverUrl: String
    var accountId: String
    var deviceId: String
    var authKey: String
    /// az adatkulcs base64-ben
    var dataKey: String
    var deviceName: String
    var lastSyncAt: Double?
    var lastError: String?
}

/// Shared state persisted to a JSON file in the App Group container, so the
/// SwiftUI app and the Packet Tunnel extension read/write the same source of
/// truth. A file coordinator keeps cross-process writes atomic.
final class BreakerStore: ObservableObject {

    static let appGroup = "group.hu.breaker.app"
    static let shared = BreakerStore()

    @Published private(set) var state = AppState()
    /// The state file exists but could not be decoded. Nothing is written while
    /// this is true, and the UI warns instead of silently doing nothing.
    @Published private(set) var fileUnreadable = false

    private var unreadableFile = false
    private let fileURL: URL
    private let queue = DispatchQueue(label: "hu.breaker.store")
    private var source: DispatchSourceFileSystemObject?

    private init() {
        let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: BreakerStore.appGroup)
            ?? FileManager.default.temporaryDirectory
        fileURL = container.appendingPathComponent("state.json")
        load()
        watch()
    }

    func newId(_ prefix: String) -> String { "\(prefix)_\(UUID().uuidString.prefix(12))" }

    // MARK: - mutate

    @discardableResult
    func mutate(_ fn: (inout AppState) -> Void) -> AppState {
        queue.sync {
            var next = readFromDisk() ?? state
            fn(&next)
            writeToDisk(next)
            DispatchQueue.main.async { self.state = next }
            return next
        }
    }

    func reload() {
        if let disk = readFromDisk() {
            DispatchQueue.main.async { self.state = disk }
        }
    }

    /// hostnames that must be blocked right now (szünet + menetrend + napi keret)
    ///
    /// A napi keret is beleszámít: iPhone-on nem mérünk, de a többi eszköz mai
    /// összegzése ide is megérkezik. Enélkül a gépen beállított keret a
    /// telefonon nem jelentene semmit — és semmi nem jelezné.
    func blockedHostnamesNow(_ now: Double) -> Set<String> {
        var out = Set<String>()
        for site in state.sites {
            if LimitLogic.isBlockedNowWithLimit(site, UsageStats.State(), state.sharedToday, now) {
                out.formUnion(site.hostnames)
            }
        }
        return out
    }

    /// A FUTÓ munkamenet, ha tényleg fut.
    func runningFocus(_ now: Double) -> Focus.Run? {
        guard let run = state.focusRun, Focus.isRunning(run, now: now) else { return nil }
        return run
    }

    /// A futó menet csomagja.
    ///
    /// Ha a csomag nincs meg, nem tippelünk — a fehérlista TARTALMA nem az a
    /// dolog, amit kitalálni szabad. Ilyenkor nil jön vissza, tehát a szűrő úgy
    /// dönt, mintha nem futna semmi: a blokklista marad. Ez a biztonságos
    /// irány — kevesebb kárt okoz, mint mindent eltiltani egy hiányzó rekord
    /// miatt.
    func runningFocusPack(_ now: Double) -> Focus.Pack? {
        guard let run = runningFocus(now) else { return nil }
        return (state.focusPacks ?? []).first { $0.id == run.packId }
    }

    /// A fiókkiszolgáló hosztneve, ha van fiók.
    ///
    /// A szűrőnek azért kell, mert a munkamenet alatt sem tilthatjuk el:
    /// enélkül a telefon nem látná, ha egy MÁSIK eszközön leállítod a menetet.
    func syncHost() -> String? {
        guard let raw = state.sync?.serverUrl, let url = URL(string: raw) else { return nil }
        return url.host
    }

    // MARK: - persistence

    private func load() { if let disk = readFromDisk() { state = disk } }

    /**
     * Reading fails in two very different ways and they must not be treated
     * alike. No file at all is a fresh install. A file that exists but does not
     * decode (written by a newer build, truncated by a battery death) is
     * dangerous: the old code returned nil for both, so mutate() fell back to
     * the empty in-memory state and then WROTE it — every block the user set up
     * disappeared, permanently, without a word. Now the store refuses to write
     * over a file it could not read and says so instead.
     */
    private func readFromDisk() -> AppState? {
        guard let data = try? Data(contentsOf: fileURL) else {
            setUnreadable(false) // nothing there yet is not a failure
            return nil
        }
        guard var decoded = try? JSONDecoder().decode(AppState.self, from: data) else {
            setUnreadable(true)
            return nil
        }
        setUnreadable(false)
        // A session whose stepIndex does not address a real step can only wedge
        // the referee: every operation on it reads steps[stepIndex]. Dropping it
        // costs the unlock attempt in progress, which is friction in the safe
        // direction.
        if let s = decoded.session, s.stepIndex < 0 || s.stepIndex >= s.steps.count {
            decoded.session = nil
        }
        return decoded
    }

    private func setUnreadable(_ value: Bool) {
        unreadableFile = value
        DispatchQueue.main.async { if self.fileUnreadable != value { self.fileUnreadable = value } }
    }

    private func writeToDisk(_ s: AppState) {
        guard !unreadableFile else { return } // never clobber state we failed to read
        guard let data = try? JSONEncoder().encode(s) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    private func watch() {
        // Refresh @Published state when the other process rewrites the file.
        // Atomic writes replace the inode, which kills a plain fd watch after
        // the first event — so on rename/delete we re-open and re-arm.
        if !FileManager.default.fileExists(atPath: fileURL.path) {
            writeToDisk(state)
        }
        armWatch()
    }

    private func armWatch() {
        source?.cancel()
        source = nil
        let fd = open(fileURL.path, O_EVTONLY)
        guard fd >= 0 else {
            // File momentarily missing mid-replace; retry shortly.
            queue.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.armWatch() }
            return
        }
        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: queue)
        src.setEventHandler { [weak self] in
            guard let self = self else { return }
            let events = src.data
            self.reload()
            if events.contains(.rename) || events.contains(.delete) {
                self.armWatch() // inode replaced -> follow the new file
            }
        }
        src.setCancelHandler { close(fd) }
        src.resume()
        source = src
    }
}

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }
