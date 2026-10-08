import XCTest
@testable import BreakerShared

// Véletlen összefésülések a Swift tükrön — a desktop/test/merge-fuzz.test.ts
// párja, UGYANAZZAL a véletlennel (LCG, azonos képlet, azonos magok), tehát
// ugyanazokat az eseteket járja be, mint a gép.
//
// Nem a szabályokat teszteli, hanem azt, hogy a szabályok EGYÜTT nem hagynak
// olyan sarkot, ahol a végeredmény a push-sorrendtől függ. Egy ilyen sarok
// nem összeomlás, hanem két gép, ami örökké egymást írja felül.

/// Determinisztikus véletlen — bájtra a gépé: `s = s * 1664525 + 1013904223 (mod 2^32)`.
struct Lcg {
    private var s: UInt32
    init(_ seed: UInt32) { s = seed }
    mutating func next() -> Double {
        s = s &* 1664525 &+ 1013904223
        return Double(s) / 4294967296.0
    }
}

private let hosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "yt.be"]
private let devices = ["gep-a", "gep-b", "telefon"]

/// Menetrendek, adag-szabályok és részleges szabályok készlete — a gép merge-random.ts párja.
private let schedulePool: [ScheduleLogic.Schedule] = [
    ScheduleLogic.Schedule(mode: .block, bands: [ScheduleLogic.Band(days: [1, 2, 3, 4, 5], startMin: 540, endMin: 1020)]),
    ScheduleLogic.Schedule(mode: .allow, bands: [ScheduleLogic.Band(days: [0, 6], startMin: 600, endMin: 720)]),
    ScheduleLogic.Schedule(mode: .block, bands: [ScheduleLogic.Band(days: [0, 1, 2, 3, 4, 5, 6], startMin: 1320, endMin: 360)]),
]
private let burstPool: [(Double, Double)] = [(600, 300), (1200, 900)]
private let rulePool: [UrlRules.UrlRule] = [
    UrlRules.UrlRule(host: "youtube.com", path: "/@valaki"), UrlRules.UrlRule(host: "youtube.com", path: "/shorts"),
]

private func randomSite(_ r: inout Lcg, _ device: String) -> SyncMerge.SyncSite {
    var hostnames: [String] = []
    for (i, h) in hosts.enumerated() {
        if i == 0 || r.next() < 0.5 { hostnames.append(h) }
    }
    var marks: [String: Int] = [:]
    for h in hosts.dropFirst() {
        if r.next() < 0.4 { marks[h] = 1 + Int(r.next() * 5) }
    }
    let pending: Double? = r.next() < 0.15 ? 5_000 + Double(Int(r.next() * 3)) : nil
    let limit: Double? = r.next() < 0.4 ? 600 * Double(1 + Int(r.next() * 3)) : nil
    let alias: String? = r.next() < 0.3 ? "n\(Int(r.next() * 3))" : nil
    let reason: String? = r.next() < 0.2 ? "r\(Int(r.next() * 2))" : nil
    let rev = 1 + Int(r.next() * 5)
    let updatedAt = 100 + Double(Int(r.next() * 5))
    // A jel sosem nagyobb a rekord rev-jénél — a bemenet is így tisztít.
    for h in marks.keys { marks[h] = min(marks[h]!, rev) }
    // MENETREND, ADAG, RÉSZLEGES SZABÁLYOK — hat húzás, mind feltétel nélkül,
    // ugyanebben a sorrendben a három nyelvben (desktop/test/merge-random.ts).
    let schedDraw = r.next()
    let schedPick = Int(r.next() * 3)
    let burstDraw = r.next()
    let burstPick = Int(r.next() * 2)
    let rulesDraw = r.next()
    let rulesPick = Int(r.next() * 3)
    let schedule: ScheduleLogic.Schedule? = schedDraw < 0.4 ? schedulePool[schedPick] : nil
    let burst: (Double, Double)? = burstDraw < 0.3 ? burstPool[burstPick] : nil
    var rules: [UrlRules.UrlRule]? = nil
    if rulesDraw >= 0.45 {
        rules = rulesPick == 2 ? [rulePool[0], rulePool[1]] : [rulePool[rulesPick]]
    } else if rulesDraw >= 0.25 {
        rules = []
    }
    // A SZABÁLYLISTA JELE — két húzás, feltétel nélkül, mint a gépen.
    let rulesMarkDraw = r.next()
    let rulesMarkValue = min(1 + Int(r.next() * 5), rev)
    let rulesRev: Int? = (rules != nil && rulesMarkDraw < 0.6) ? rulesMarkValue : nil
    return SyncMerge.SyncSite(
        id: "site_1", domain: "youtube.com", hostnames: hostnames, addedAt: 1_000,
        pendingDeleteAt: pending, schedule: schedule, dailyLimitSeconds: limit,
        burstSeconds: burst?.0, cooldownSeconds: burst?.1,
        alias: alias, reason: reason, rules: rules,
        rev: rev, updatedAt: updatedAt, updatedBy: device,
        hostnameMarks: marks.isEmpty ? nil : marks,
        rulesRev: rulesRev
    )
}

/// A NEVEK és a JELEIK — ezek fésülődnek nevenként. A rekord többi mezője a
/// rekord-szintű nyertesé, és ott a törlésre várás továbbvitele egy olyan
/// köztes rekordot ad, ami egyik eszközön sem létezett — ezt itt nem mérjük,
/// ahogy a gép sem.
private func siteKey(_ s: SyncMerge.SyncSite) -> String {
    let marks = (s.hostnameMarks ?? [:]).sorted { $0.key < $1.key }
        .map { "\($0.key)=\($0.value)" }.joined(separator: ",")
    return "\(s.hostnames.sorted().joined(separator: ","))|\(marks)|\(s.rev)"
}

private let packIds = ["p1", "p2", "p3", "p4"]
private let win = ScheduleLogic.Band(days: [1, 2, 3, 4, 5], startMin: 540, endMin: 720)
/// Az ablakok készlete — a gép merge-random.ts WINDOWS párja.
private let windowPool: [ScheduleLogic.Band] = [
    ScheduleLogic.Band(days: [1, 2, 3, 4, 5], startMin: 540, endMin: 1020),
    ScheduleLogic.Band(days: [1], startMin: 1320, endMin: 360),
    ScheduleLogic.Band(days: [0, 6], startMin: 0, endMin: 1440),
]

/// Kulcsszó-készletek és két rögzített megbízott-zár — a gép merge-random.ts-ének párja.
private let keywordSets: [[String]] = [["shorts"], ["reels"], ["shorts", "reels"]]
private let partners: [PartnerLogic.PartnerLock] = [
    PartnerLogic.PartnerLock(name: "Anna", salt: "QUFBQUFBQUFBQUFBQUFBQQ==", hash: "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=", setAt: 5),
    PartnerLogic.PartnerLock(name: "Bela", salt: "Q0NDQ0NDQ0NDQ0NDQ0NDQw==", hash: "REREREREREREREREREREREREREREREREREREREREREQ=", setAt: 3),
    PartnerLogic.PartnerLock(name: "Cili", salt: "RUVFRUVFRUVFRUVFRUVFRQ==", hash: "RkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkY=", setAt: 4),
]

/// Naplósorok készlete és részhalmazai — a gép merge-random.ts LOGS / LOG_SETS párja.
private let logPool: [Focus.LogEntry] = [
    Focus.LogEntry(packId: "p1", packName: "csomag p1", startedAt: 1_000, endedAt: 2_000, plannedEndsAt: 2_000, stopped: false, window: nil),
    Focus.LogEntry(packId: "p1", packName: "csomag p1", startedAt: 1_000, endedAt: 1_500, plannedEndsAt: 2_000, stopped: true, window: nil),
    Focus.LogEntry(packId: "p2", packName: "csomag p2", startedAt: 3_000, endedAt: 4_000, plannedEndsAt: 4_000, stopped: false, window: true),
    Focus.LogEntry(packId: "p3", packName: "csomag p3", startedAt: 500, endedAt: 4_000, plannedEndsAt: 4_500, stopped: false, window: nil),
    Focus.LogEntry(packId: "p1", packName: "csomag p1", startedAt: 1_000, endedAt: 2_000, plannedEndsAt: 2_600, stopped: false, window: nil),
]
private let logSets: [[Int]] = [[0], [1], [0, 2], [1, 2, 3], [4, 3]]

/// A fésülés „most”-ja — a gép merge-random.ts `FOCUS_MERGE_NOW` párja.
private let focusMergeNow: Double = 500_000

/// Sírkövek: a generált menetekre hivatkozó naplósorok — a gép `TOMBS` párja.
private let tombs: [Focus.LogEntry] = [
    Focus.LogEntry(packId: "p1", packName: "csomag p1", startedAt: 10, endedAt: 300_000, plannedEndsAt: 610_000, stopped: true),
    Focus.LogEntry(packId: "p2", packName: "csomag p2", startedAt: 10, endedAt: 610_000, plannedEndsAt: 610_000, stopped: false),
    Focus.LogEntry(packId: "p3", packName: "csomag p3", startedAt: 60_010, endedAt: 400_000, plannedEndsAt: 610_000, stopped: true, cuts: 1),
    Focus.LogEntry(packId: "p1", packName: "csomag p1", startedAt: 60_010, endedAt: 450_000, plannedEndsAt: 670_000, stopped: true, origin: 5),
    Focus.LogEntry(packId: "p4", packName: "csomag p4", startedAt: 10, endedAt: 900_000, plannedEndsAt: 900_000, stopped: false),
]

private func randomFocus(_ r: inout Lcg, _ device: String) -> FocusSync.SyncFocus {
    var kept: [String] = []
    for id in packIds {
        if r.next() < 0.6 { kept.append(id) }
    }
    var packs: [Focus.Pack] = []
    for id in kept {
        let name = "csomag \(id) v\(Int(r.next() * 3))"
        let rec: ScheduleLogic.Band? = r.next() < 0.4 ? win : nil
        packs.append(Focus.Pack(
            id: id, name: name, allowSites: ["quizlet.com"], allowApps: [],
            defaultMinutes: 50, recurrence: rec
        ))
    }
    var marks: [String: Int] = [:]
    for id in packIds {
        if r.next() < 0.4 { marks[id] = 1 + Int(r.next() * 5) }
    }
    let revInt = 1 + Int(r.next() * 5)
    // A jel sosem nagyobb a blob rev-jénél (a bemenet is így tisztít): a
    // csomag nélküli menet lehetetlensége erre épül.
    for id in marks.keys { marks[id] = min(marks[id]!, revInt) }
    // A menet lejárata és kezdése is csak pár értéket vesz fel: legyen sok
    // döntetlen, mert éppen a döntetlen-lánc az, ami sorrendfüggő tud lenni.
    var run: Focus.Run? = nil
    if r.next() < 0.4 && !packs.isEmpty {
        let packId = packs[Int(r.next() * Double(packs.count))].id
        let startedAt = 10 + 60_000 * Double(Int(r.next() * 2))
        let endsAt = 610_000 + 60_000 * Double(Int(r.next() * 2))
        run = Focus.Run(packId: packId, startedAt: startedAt, endsAt: endsAt)
    }
    let rev = Double(revInt)
    let updatedAt = Double(100 + Int(r.next() * 5))
    // A ZÁRLAT ÉS AZ ABLAKOK A JELÜKKEL — kilenc húzás, mind feltétel nélkül,
    // ugyanebben a sorrendben, mint a gép merge-random.ts-e.
    let lockDraw = r.next()
    let lockStart = Double(100 + Int(r.next() * 3))
    let lockEnd = Double(1_000 + 500 * Int(r.next() * 3))
    let lockdown: LockdownLogic.Lockdown? = lockDraw < 0.3
        ? LockdownLogic.Lockdown(startedAt: lockStart, until: lockEnd) : nil
    let hasWindows = r.next() < 0.5
    var drawn: [ScheduleLogic.Band] = []
    for w in windowPool {
        if r.next() < 0.5 { drawn.append(w) }
    }
    var windows: [LockdownLogic.LockdownWindow] = []
    if hasWindows {
        for (i, w) in drawn.enumerated() {
            windows.append(LockdownLogic.LockdownWindow(id: "w\(i + 1)@\(device)", days: w.days,
                                                        startMin: w.startMin, endMin: w.endMin))
        }
    }
    let markDraw = r.next()
    let markValue = min(1 + Int(r.next() * 5), revInt)
    let windowsRev: Int? = (!windows.isEmpty || markDraw < 0.3) ? markValue : nil
    // A REJTÉS A JELÉVEL — három húzás, mind feltétel nélkül, ugyanebben a
    // sorrendben a három nyelvben (desktop/test/merge-random.ts).
    let hideDraw = r.next()
    let hideMarkDraw = r.next()
    let hideMarkValue = min(1 + Int(r.next() * 5), revInt)
    let hide = hideDraw < 0.3
    let hideRev: Int? = (hide || hideMarkDraw < 0.2) ? hideMarkValue : nil
    // KULCSSZAVAK ÉS MEGBÍZOTT A JELÜKKEL — nyolc húzás, mind feltétel nélkül,
    // ugyanebben a sorrendben a három nyelvben (desktop/test/merge-random.ts).
    let kwDraw = r.next()
    let kwPick = Int(r.next() * 3)
    let kwMarkDraw = r.next()
    let kwMarkValue = min(1 + Int(r.next() * 5), revInt)
    let keywords: [String] = kwDraw < 0.4 ? keywordSets[kwPick] : []
    let keywordsRev: Int? = (!keywords.isEmpty || kwMarkDraw < 0.2) ? kwMarkValue : nil
    let pDraw = r.next()
    let pPick = Int(r.next() * 2)
    let pMarkDraw = r.next()
    let pMarkValue = min(1 + Int(r.next() * 5), revInt)
    let partner: PartnerLogic.PartnerLock? = pDraw < 0.3 ? partners[pPick] : nil
    let partnerRev: Int? = (partner != nil || pMarkDraw < 0.2) ? pMarkValue : nil
    // TÁRS-MEGBÍZOTT ÉS A LEVETTEK NYOMA — öt húzás, feltétel nélkül, mint a gépen.
    let coDraw = r.next()
    let coPick = Int(r.next() * 3)
    let goneDraw = r.next()
    let gonePick = Int(r.next() * 3)
    let goneAt = Double(1 + Int(r.next() * 3))
    let partnerCo: [PartnerLogic.PartnerLock] = coDraw < 0.25 ? [partners[coPick]] : []
    let partnersGone: [PartnerLogic.PartnerGone] = goneDraw < 0.2
        ? [PartnerLogic.PartnerGone(id: PartnerLogic.partnerId(partners[gonePick]), at: goneAt)] : []
    // A NAPLÓ — két húzás, feltétel nélkül, mint a gépen.
    let logDraw = r.next()
    let logPick = Int(r.next() * 5)
    let rows: [Focus.LogEntry] = logDraw < 0.5 ? logSets[logPick].map { logPool[$0] } : []
    // A MENET JELEI ÉS A SÍRKŐ — négy húzás, feltétel nélkül, mint a gépen:
    // rövidítette-e, eltolta-e az óra (eredeti kezdés 5), van-e sírkő, melyik.
    let cutsDraw = r.next()
    let originDraw = r.next()
    let tombDraw = r.next()
    let tombPick = Int(r.next() * Double(tombs.count))
    let marked = run.map {
        Focus.Run(
            packId: $0.packId, startedAt: $0.startedAt, endsAt: $0.endsAt,
            cuts: cutsDraw < 0.25 ? 1 : nil, origin: originDraw < 0.2 ? 5 : nil
        )
    }
    let log = tombDraw < 0.3 ? rows + [tombs[tombPick]] : rows
    return FocusSync.SyncFocus(
        packs: packs, run: marked, log: log, rev: rev, updatedAt: updatedAt, updatedBy: device,
        packMarks: marks.isEmpty ? nil : marks, lockdown: lockdown,
        lockdownWindows: windows.isEmpty ? nil : windows, lockdownWindowsRev: windowsRev,
        partner: partner, partnerRev: partnerRev,
        partnerCo: partnerCo.isEmpty ? nil : partnerCo, partnersGone: partnersGone.isEmpty ? nil : partnersGone,
        keywords: keywords.isEmpty ? nil : keywords, keywordsRev: keywordsRev,
        hideSiteList: hide ? true : nil, hideSiteListRev: hideRev
    )
}

/// A csomagok halmaza, a jelek, a rev, a napló és a többi jeles mező — és a
/// csomagok VÁLTOZATA is, kivéve azét, amin valamelyik bemenet menete fut. A
/// futó menet és a csomagja külön kérdés (a gép merge-fuzz.test.ts-e kimondja):
/// egy leváltott menetet a sírköve más sorrendben más ponton ér el. A
/// `withRun` nélküli kulcs ezeket kihagyja; a menetet a `runSafety` és a sírkő
/// nélküli esetek mérik.
private func focusKey(_ f: FocusSync.SyncFocus, runIds: Set<String>, withRun: Bool = true) -> String {
    let packs = f.packs.filter { withRun || !runIds.contains($0.id) }.sorted { $0.id < $1.id }
        .map { p -> String in
            runIds.contains(p.id)
                ? p.id
                : "\(p.id):\(p.name):\(p.allowSites.sorted()):\(p.allowApps.sorted()):\(p.defaultMinutes):\(Focus.recurrenceKey(p.recurrence))"
        }.joined(separator: ",")
    let marks = (f.packMarks ?? [:]).sorted { $0.key < $1.key }
        .map { "\($0.key)=\($0.value)" }.joined(separator: ",")
    let run = !withRun ? "*" : f.run.map { "\($0.packId)/\($0.startedAt)/\($0.endsAt)/\($0.cutCount)/\(String(describing: $0.origin))" } ?? "-"
    let lock = f.lockdown.map { "\($0.startedAt)/\($0.until)" } ?? "-"
    let windows = (f.lockdownWindows ?? []).map { LockdownLogic.windowKey($0.band) }.sorted().joined(separator: ";")
    return "\(packs)|\(marks)|\(run)|\(f.rev)|\(lock)|\(windows)|\(f.lockdownWindowsRev ?? 0)"
        + "|\((f.hideSiteList ?? false) ? 1 : 0)|\(f.hideSiteListRev ?? 0)"
        + "|\(KeywordLogic.keywordsKey(f.keywords ?? []))|\(f.keywordsRev ?? 0)"
        + "|\(PartnerLogic.partnerKey(f.partner))|\(f.partnerRev ?? 0)"
        + "|" + (f.partnerCo ?? []).map { PartnerLogic.partnerKey($0) }.joined(separator: ";")
        + "|" + (f.partnersGone ?? []).map { "\($0.id)@\(Int($0.at))" }.joined(separator: ";")
        + "|" + f.log.map { e -> String in
            "\(e.packId)/\(Int(e.startedAt))/\(Int(e.endedAt))/\(Int(e.plannedEndsAt))/\(e.stopped ? 1 : 0)/\((e.window ?? false) ? 1 : 0)"
                + "/\(e.cutCount)/\(String(describing: e.origin))"
        }.joined(separator: ";")
}

/// A fésült menet biztonsága: egy bemeneté, a csomagja a listán, a fésült napló nem zárja le.
private func runSafety(_ m: FocusSync.SyncFocus, _ inputs: [FocusSync.SyncFocus], _ seed: Int) {
    guard let run = m.run else { return }
    XCTAssertTrue(inputs.contains { $0.run == run }, "a menet egy bemeneté, mag \(seed)")
    XCTAssertTrue(m.packs.contains { $0.id == run.packId }, "a menet csomagja a listán van, mag \(seed)")
    var bare = m
    bare.run = nil
    XCTAssertEqual(FocusSync.merge(m, bare, now: focusMergeNow).run, run, "a fésült napló nem zárja le, mag \(seed)")
}

/// Sorrendtől független-e a menet: nincs rövidítés, eltolás, és a menetre szóló sírkő.
private func plainRuns(_ fs: [FocusSync.SyncFocus]) -> Bool {
    fs.allSatisfy { f in f.run.map { $0.cutCount == 0 && $0.origin == nil } ?? true }
        && !fs.contains { f in f.log.contains { e in fs.contains { g in g.run.map { Focus.sameRun(e, $0) } ?? false } } }
}

final class MergeFuzzTests: XCTestCase {

    func testSiteMergeIsSymmetricIdempotentAndOrderIndependent() {
        for seed in 1...300 {
            var r = Lcg(UInt32(seed))
            let a = randomSite(&r, devices[0])
            let b = randomSite(&r, devices[1])
            let c = randomSite(&r, devices[2])
            let ab = SyncMerge.mergeSite(a, b)
            XCTAssertEqual(siteKey(ab), siteKey(SyncMerge.mergeSite(b, a)), "szimmetria, mag \(seed)")
            XCTAssertEqual(siteKey(SyncMerge.mergeSite(ab, ab)), siteKey(ab), "idempotens, mag \(seed)")
            let abc = SyncMerge.mergeSite(ab, c)
            let bca = SyncMerge.mergeSite(SyncMerge.mergeSite(b, c), a)
            let cab = SyncMerge.mergeSite(SyncMerge.mergeSite(c, a), b)
            XCTAssertEqual(siteKey(abc), siteKey(bca), "három eszköz, más sorrend (bca), mag \(seed)")
            XCTAssertEqual(siteKey(abc), siteKey(cab), "három eszköz, más sorrend (cab), mag \(seed)")
            // Lazítás jel nélkül nincs: ami mindkét oldalon benne volt, és
            // egyiknek sincs rá jele, az az eredményben is benne van.
            for h in a.hostnames where b.hostnames.contains(h)
                && (a.hostnameMarks?[h] ?? 0) == 0 && (b.hostnameMarks?[h] ?? 0) == 0 {
                XCTAssertTrue(ab.hostnames.contains(h), "jel nélküli közös név nem tűnhet el: \(h), mag \(seed)")
            }
        }
    }

    func testFocusMergeIsSymmetricIdempotentAndOrderIndependent() {
        for seed in 1...300 {
            var r = Lcg(UInt32(seed))
            let a = randomFocus(&r, devices[0])
            let b = randomFocus(&r, devices[1])
            let c = randomFocus(&r, devices[2])
            let runIds = Set([a, b, c].compactMap { $0.run?.packId })
            let full = { (f: FocusSync.SyncFocus) in focusKey(f, runIds: runIds) }
            let noRun = { (f: FocusSync.SyncFocus) in focusKey(f, runIds: runIds, withRun: false) }
            let now = focusMergeNow
            let ab = FocusSync.merge(a, b, now: now)
            XCTAssertEqual(full(ab), full(FocusSync.merge(b, a, now: now)), "szimmetria, mag \(seed)")
            XCTAssertEqual(full(FocusSync.merge(ab, ab, now: now)), full(ab), "idempotens, mag \(seed)")
            let abc = FocusSync.merge(ab, c, now: now)
            let bca = FocusSync.merge(FocusSync.merge(b, c, now: now), a, now: now)
            let cab = FocusSync.merge(FocusSync.merge(c, a, now: now), b, now: now)
            XCTAssertEqual(noRun(abc), noRun(bca), "három eszköz (bca), mag \(seed)")
            XCTAssertEqual(noRun(abc), noRun(cab), "három eszköz (cab), mag \(seed)")
            // Sírkő, rövidítés és eltolás nélkül a menet is sorrendtől független.
            if plainRuns([a, b, c]) {
                XCTAssertEqual(abc.run, bca.run, "három eszköz, a menet (bca), mag \(seed)")
                XCTAssertEqual(abc.run, cab.run, "három eszköz, a menet (cab), mag \(seed)")
            }
            // A jeles csomag a nagyobb jel változatában marad: ha az egyik
            // oldalon ablakos csomag áll a nagyobb jellel, az ablak marad — a
            // futó menet csomagjánál is (csak a fehérlistája metszet).
            for p in a.packs {
                let ma = a.packMarks?[p.id] ?? 0
                let mb = b.packMarks?[p.id] ?? 0
                if ma > mb && p.recurrence != nil {
                    XCTAssertNotNil(
                        ab.packs.first { $0.id == p.id }?.recurrence,
                        "a nagyobb jel ablaka marad: \(p.id), mag \(seed)"
                    )
                }
            }
            for m in [ab, abc, bca, cab] { runSafety(m, [a, b, c], seed) }
        }
    }
}
