import CoreFoundation
import Foundation
import XCTest
@testable import BreakerShared

// Megfelelőség a géppel: a `fixtures/merge-cases.json` a gép által kiszámolt
// bemeneteket és eredmény-kulcsokat tartja (desktop/test/merge-fixture.test.ts
// írja és őrzi). Itt ugyanazok a bemenetek a DRÓTON át jönnek (a Swift
// dekódolóján), a Swift fésülés számol, és a kulcsnak bájtra egyeznie kell.
// Ha a tükör egy szabályban elcsúszik, itt bukik — a mag számával.
//
// A kulcs formátuma a merge-random.ts `siteConformanceKey` /
// `focusConformanceKey` párja; a Kotlin tükör (MergeFixtureTest) ugyanezt.

private struct SiteCase: Decodable {
    let seed: Int
    let a: SyncMerge.SyncSite
    let b: SyncMerge.SyncSite
    let c: SyncMerge.SyncSite
    let ab: String
    let abc: String
    /// Egy mező cseréje az `a`-n, a fajtája, és a fésülés mindkét sorrendben.
    let flip: SyncMerge.SyncSite
    let what: String
    let af: String
    let fa: String
}

private struct FocusCase: Decodable {
    let seed: Int
    /// A kézzel írt eset neve (a menet egy-egy ága), a véletleneknél nincs.
    let scenario: String?
    /// A fésülés időpontja: a jövőben véget ért naplósor nem zár le menetet.
    let now: Double
    let a: FocusSync.SyncFocus
    let b: FocusSync.SyncFocus
    let c: FocusSync.SyncFocus
    let ab: String
    let abc: String
    /// Egy mező cseréje az `a`-n, a fajtája, és hogy a gép különbségnek tartja-e.
    let flip: FocusSync.SyncFocus
    let what: String
    let same: Bool
}

private struct Fixture: Decodable {
    let sites: [SiteCase]
    let focus: [FocusCase]
}

final class MergeFixtureTests: XCTestCase {

    /// ios/SharedTests/MergeFixtureTests.swift → a tároló gyökere.
    private func loadFixture() throws -> Fixture {
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("merge-cases.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    /// Egész szám, ahogy a gép írja: a Double „150.0”-ja nem egyezne.
    private func int(_ d: Double) -> String { String(Int(d)) }

    private func opt(_ v: Double?) -> String { v.map { int($0) } ?? "-" }

    private func siteKey(_ s: SyncMerge.SyncSite) -> String {
        let marks = (s.hostnameMarks ?? [:]).sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }.joined(separator: ",")
        // A menetrend a módjával és a sávjaival (tartalom szerint rendezve), az adag
        // a párjával, a szabályok rendezve — és a „nincs mező” (-) más, mint az üres ([]).
        let sched: String = s.schedule.map { sc in
            sc.mode.rawValue + ":" + sc.bands.map { LockdownLogic.windowKey($0) }.sorted().joined(separator: ";")
        } ?? "-"
        let burst: String
        if let b = s.burstSeconds, let c = s.cooldownSeconds { burst = "\(int(b))/\(int(c))" } else { burst = "-" }
        let rules: String = s.rules.map { list in
            "[" + list.map { $0.host + $0.path }.sorted().joined(separator: ",") + "]"
        } ?? "-"
        return "hosts=[\(s.hostnames.sorted().joined(separator: ","))] marks=[\(marks)] rev=\(s.rev)"
            + " pending=\(opt(s.pendingDeleteAt)) limit=\(opt(s.dailyLimitSeconds)) alias=\(s.alias ?? "-")"
            + " reason=\(s.reason ?? "-")"
            + " at=\(int(s.updatedAt)) by=\(s.updatedBy)"
            + " sched=\(sched) burst=\(burst) rules=\(rules) rmark=\(s.rulesRev ?? 0)"
    }

    private func focusKey(_ f: FocusSync.SyncFocus) -> String {
        let packParts: [String] = f.packs.sorted { $0.id < $1.id }.map { p -> String in
            var rec = "-"
            if let b = p.recurrence {
                let days: [String] = b.days.sorted().map { String($0) }
                rec = "\(days.joined(separator: ","))/\(b.startMin)/\(b.endMin)"
            }
            let fields: [String] = [
                p.id, p.name, p.allowSites.sorted().joined(separator: ","), p.allowApps.sorted().joined(separator: ","),
                String(p.defaultMinutes), rec,
            ]
            return fields.joined(separator: "|")
        }
        let packs: String = packParts.joined(separator: ";")
        let marks = (f.packMarks ?? [:]).sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }.joined(separator: ",")
        let run = f.run.map { "\($0.packId)/\(int($0.startedAt))/\(int($0.endsAt))/\($0.cutCount)/\($0.origin.map { int($0) } ?? "-")" } ?? "-"
        let lock = f.lockdown.map { "\(int($0.startedAt))/\(int($0.until))" } ?? "-"
        // Az ablakok TARTALOM szerint, rendezve: az azonosító és a sorrend nem jelentés.
        let windows = (f.lockdownWindows ?? []).map { LockdownLogic.windowKey($0.band) }.sorted().joined(separator: ";")
        return "packs=[\(packs)] run=\(run) marks=[\(marks)] rev=\(int(f.rev)) at=\(int(f.updatedAt)) by=\(f.updatedBy)"
            + " lock=\(lock) windows=[\(windows)] wmark=\(f.lockdownWindowsRev ?? 0)"
            + " hide=\((f.hideSiteList ?? false) ? 1 : 0) hmark=\(f.hideSiteListRev ?? 0)"
            + " kw=[\(KeywordLogic.keywordsKey(f.keywords ?? []))] kmark=\(f.keywordsRev ?? 0)"
            + " kwm=[\(KeywordLogic.keywordMarksKey(f.keywordMarks))]"
            + " wm=[\(LockdownLogic.windowMarksKey(f.lockdownWindowMarks))]"
            + " partner=[\(PartnerLogic.partnerKey(f.partner))] pmark=\(f.partnerRev ?? 0)"
            + " co=[\((f.partnerCo ?? []).map { PartnerLogic.partnerKey($0) }.joined(separator: ";"))]"
            + " gone=[\((f.partnersGone ?? []).map { "\($0.id)@\(int($0.at))" }.joined(separator: ";"))]"
            + " log=[" + f.log.map { e -> String in
                "\(e.packId)/\(int(e.startedAt))/\(int(e.endedAt))/\(int(e.plannedEndsAt))/\(e.stopped ? 1 : 0)/\((e.window ?? false) ? 1 : 0)"
                    + "/\(e.cutCount)/\(e.origin.map { int($0) } ?? "-")"
            }.joined(separator: ";") + "]"
    }

    func testSitesMergeTheSameAsTheDesktop() throws {
        let fixture = try loadFixture()
        XCTAssertGreaterThanOrEqual(fixture.sites.count, 50, "a fixture-ben van elég eset")
        for c in fixture.sites {
            let ab = SyncMerge.mergeSite(c.a, c.b)
            XCTAssertEqual(siteKey(ab), c.ab, "oldal, két eszköz, mag \(c.seed)")
            XCTAssertEqual(siteKey(SyncMerge.mergeSite(ab, c.c)), c.abc, "oldal, három eszköz, mag \(c.seed)")
            // KÖZELI REKORDOK: az a és egy egy mezőben más párja, mindkét sorrendben —
            // a szigorúság-lánc és a döntetlen-törés éles esetei.
            XCTAssertEqual(siteKey(SyncMerge.mergeSite(c.a, c.flip)), c.af, "közeli, mag \(c.seed): \(c.what)")
            XCTAssertEqual(siteKey(SyncMerge.mergeSite(c.flip, c.a)), c.fa, "közeli fordítva, mag \(c.seed): \(c.what)")
        }
    }

    /// A használati statisztika kulcsa: a napok az egyesített sorrendben, a célok és a címkék rendezve.
    private func usageKey(_ u: UsageStats.State) -> String {
        let days = u.days.map { d -> String in
            d.day + ":{" + d.seconds.sorted { $0.key < $1.key }.map { "\($0.key)=\(Int($0.value))" }.joined(separator: ",") + "}"
        }.joined(separator: ";")
        let labels = u.labels.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ",")
        return "enabled=\(u.enabled ? 1 : 0) days=[\(days)] labels=[\(labels)]"
    }

    func testTheBlockDecisionIsTheSameAsTheDesktop() throws {
        // A napkulcs helyi időben számolódik: a fixtúra UTC-ben készül, dél UTC-s
        // időponttal — délben a nap −12…+11 órás eltolásnál is ugyanaz (a CI UTC-ben jár).
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("merge-cases.json")
        let top = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        let cases = top?["decisions"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 50, "a fixture-ben van elég eset")
        for c in cases {
            let seed = c["seed"] as? Int ?? -1
            let now = (c["now"] as? NSNumber)?.doubleValue ?? 0
            let s = c["site"] as? [String: Any] ?? [:]
            let domain = s["domain"] as? String ?? ""
            // A menetrend a dróton: a mód szövege és a sávok.
            var schedule: ScheduleLogic.Schedule? = nil
            if let sc = s["schedule"] as? [String: Any] {
                let mode = ScheduleLogic.Mode(rawValue: sc["mode"] as? String ?? "") ?? .always
                let bands = (sc["bands"] as? [[String: Any]] ?? []).map { b in
                    ScheduleLogic.Band(days: b["days"] as? [Int] ?? [], startMin: b["startMin"] as? Int ?? 0, endMin: b["endMin"] as? Int ?? 0)
                }
                schedule = ScheduleLogic.Schedule(mode: mode, bands: bands)
            }
            let site = Site(
                id: "s", domain: domain, hostnames: [domain], addedAt: 0,
                pauseUntil: (s["pauseUntil"] as? NSNumber)?.doubleValue,
                pendingDeleteAt: (s["pendingDeleteAt"] as? NSNumber)?.doubleValue,
                schedule: schedule, alias: nil, reason: nil,
                dailyLimitSeconds: (s["dailyLimitSeconds"] as? NSNumber)?.doubleValue,
                burstSeconds: nil, cooldownSeconds: nil, rules: nil
            )
            let usageData = try JSONSerialization.data(withJSONObject: c["usage"] as? [String: Any] ?? [:])
            guard let usage = UsageStats.parse(String(decoding: usageData, as: UTF8.self)) else {
                XCTFail("a mérés nem olvasható, mag \(seed)")
                return
            }
            var shared: LimitLogic.SharedToday? = nil
            if let sh = c["shared"] as? [String: Any] {
                let devices = (sh["devices"] as? [[String: Any]] ?? []).map { d -> LimitLogic.TodayDigest in
                    var secs: [String: Double] = [:]
                    for (k, v) in d["seconds"] as? [String: Any] ?? [:] {
                        if let n = (v as? NSNumber)?.doubleValue { secs[k] = n }
                    }
                    return LimitLogic.TodayDigest(deviceId: d["deviceId"] as? String ?? "", day: d["day"] as? String ?? "", seconds: secs)
                }
                shared = LimitLogic.SharedToday(selfDeviceId: sh["selfDeviceId"] as? String ?? "", devices: devices)
            }
            XCTAssertEqual(LimitLogic.isBlockedNowWithLimit(site, usage, shared, now), c["blocked"] as? Bool ?? false, "döntés, mag \(seed)")
            // Zárul-e a szünet végén (szünet nélkül null) — a szünet vége előtti szó ebből dönt.
            if let after = c["afterPause"] as? Bool {
                XCTAssertEqual(LimitLogic.closesAfterPause(site, usage, shared), after, "a szünet vége, mag \(seed)")
            }
        }
    }

    func testTheFocusVerdictIsTheSameAsTheReference() throws {
        // A tunnel döntése: lista, kulcsszó a hosztnévben, csomag, saját
        // fiókkiszolgáló. A rendszer-infrastruktúra kivétele szándékosan nincs a
        // fixtúrában (a két telefon listája különbözik; a check-infra-allow őrzi).
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("merge-cases.json")
        let top = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        let cases = top?["verdicts"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 50, "a fixture-ben van elég eset")
        for c in cases {
            let seed = c["seed"] as? Int ?? -1
            var pack: Focus.Pack? = nil
            if let p = c["pack"] as? [String: Any] {
                pack = Focus.Pack(
                    id: p["id"] as? String ?? "", name: p["name"] as? String ?? "",
                    allowSites: p["allowSites"] as? [String] ?? [], allowApps: p["allowApps"] as? [String] ?? [],
                    defaultMinutes: p["defaultMinutes"] as? Int ?? 25, recurrence: nil
                )
            }
            var run: Focus.Run? = nil
            if let r = c["run"] as? [String: Any] {
                run = Focus.Run(packId: r["packId"] as? String ?? "",
                                startedAt: (r["startedAt"] as? NSNumber)?.doubleValue ?? 0,
                                endsAt: (r["endsAt"] as? NSNumber)?.doubleValue ?? 0)
            }
            let verdict = Focus.verdict(
                c["host"] as? String ?? "", run: run, pack: pack,
                now: (c["now"] as? NSNumber)?.doubleValue ?? 0,
                blocked: Set(c["blocked"] as? [String] ?? []),
                syncHost: c["syncHost"] as? String, keywords: c["keywords"] as? [String] ?? []
            )
            let label: String
            switch verdict {
            case .allow: label = "allow"
            case .blockedByList: label = "list"
            case .blockedByKeyword: label = "keyword"
            case .blockedByFocus: label = "focus"
            }
            XCTAssertEqual(label, c["verdict"] as? String ?? "", "munkamenet-döntés, mag \(seed): \(c["host"] as? String ?? "")")
        }
    }

    func testUsageCombinesTheSameAsTheDesktop() throws {
        setenv("TZ", "UTC", 1)
        CFTimeZoneResetSystem()
        let utc = TimeZone.current.secondsFromGMT() == 0
        var summaries = 0
        // A mérés a dróton SZÖVEGKÉNT jön (`UsageStats.parse`), ezért a
        // fixtúrából is így: a három állapotot visszaírjuk JSON-ná, és a
        // saját olvasónk veszi — ugyanaz az út, mint az éles körben.
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("merge-cases.json")
        let top = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        let cases = top?["usage"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 50, "a fixture-ben van elég eset")
        for c in cases {
            let seed = c["seed"] as? Int ?? -1
            var states: [UsageStats.State] = []
            for dev in ["a", "b", "c"] {
                let obj = c[dev] as? [String: Any] ?? [:]
                let data = try JSONSerialization.data(withJSONObject: obj)
                guard let parsed = UsageStats.parse(String(decoding: data, as: UTF8.self)) else {
                    XCTFail("a mérés nem olvasható, mag \(seed), eszköz \(dev)")
                    return
                }
                states.append(parsed)
            }
            let combined = UsageStats.combine(states)
            XCTAssertEqual(usageKey(combined), c["abc"] as? String ?? "", "használat, három eszköz, mag \(seed)")
            // AZ ÖSSZEGZŐ: az iPhone kevesebbet mond (ma, hét, a mai és a heti vegyes
            // toplista), de amit mond, az a gépé kell legyen. A napkulcs helyi
            // időben jár; a fixtúra UTC-ben készült — csak UTC-ben hasonlítunk.
            if utc, let want = c["summary"] as? [String: Any] {
                let now = (c["now"] as? NSNumber)?.doubleValue ?? 0
                let s = UsageStats.summarize(combined, now: Date(timeIntervalSince1970: now / 1000), topLimit: 8)
                let tops = { (rows: [UsageStats.Target]) -> String in
                    rows.map { "\($0.key)=\($0.label)=\(Int($0.seconds))" }.joined(separator: ",")
                }
                XCTAssertEqual(Int(s.todaySeconds), (want["today"] as? NSNumber)?.intValue, "összegző ma, mag \(seed)")
                XCTAssertEqual(Int(s.last7Seconds), (want["w7"] as? NSNumber)?.intValue, "összegző hét, mag \(seed)")
                XCTAssertEqual(tops(s.topToday), want["topToday"] as? String, "összegző mai toplista, mag \(seed)")
                XCTAssertEqual(tops(s.top), want["weekMixed"] as? String, "összegző heti vegyes toplista, mag \(seed)")
                summaries += 1
            }
        }
        if utc { XCTAssertGreaterThan(summaries, 50, "az összegző egy esetre sem futott") }
    }

    func testFocusMergesTheSameAsTheDesktop() throws {
        let fixture = try loadFixture()
        XCTAssertGreaterThanOrEqual(fixture.focus.count, 50, "a fixture-ben van elég eset")
        for c in fixture.focus {
            // Ugyanaz az út, mint az éles körben: dekódolás, aztán normalizálás.
            let a = FocusSync.normalize(c.a, fallbackDevice: "x")
            let b = FocusSync.normalize(c.b, fallbackDevice: "x")
            let cc = FocusSync.normalize(c.c, fallbackDevice: "x")
            // A „MOST” is az eset része: a jövőben véget ért naplósor nem zár le menetet.
            let name = c.scenario ?? "mag \(c.seed)"
            let ab = FocusSync.merge(a, b, now: c.now)
            XCTAssertEqual(focusKey(ab), c.ab, "munkamenet, két eszköz, \(name)")
            XCTAssertEqual(focusKey(FocusSync.merge(ab, cc, now: c.now)), c.abc, "munkamenet, három eszköz, \(name)")
            // EGY MEZŐ CSERÉJE: ugyanazt tartja-e különbségnek a Swift, mint a gép —
            // és ami nem jelentés (időbélyeg, eszköznév, ablak-azonosító, a
            // csomagok sorrendje), azt nem. A v0.4.170-ben pont a Swift kulcsából
            // maradt ki a rejtés, és a fésülés fixtúrája nem látta; ez látja.
            let flip = FocusSync.normalize(c.flip, fallbackDevice: "x")
            XCTAssertEqual(FocusSync.same(a, flip), c.same, "különbség, mag \(c.seed): \(c.what)")
        }
    }

    private func schedule(_ o: [String: Any]) -> ScheduleLogic.Schedule {
        let mode = ScheduleLogic.Mode(rawValue: o["mode"] as? String ?? "") ?? .always
        let bands = (o["bands"] as? [[String: Any]] ?? []).map { b in
            ScheduleLogic.Band(days: b["days"] as? [Int] ?? [], startMin: b["startMin"] as? Int ?? 0, endMin: b["endMin"] as? Int ?? 0)
        }
        return ScheduleLogic.Schedule(mode: mode, bands: bands)
    }

    func testTheScheduleDecisionIsTheSameAsTheDesktopInUTC() throws {
        // A sávok helyi időben értékelődnek ki; a fixtúra UTC-ben készült. A
        // futtató gép óráját UTC-re kérjük (TZ, majd a rendszer-zóna újraolvasása);
        // ha nem sikerül, kimondva kihagyunk — egy más zónában futó összevetés nem
        // a tükörről szólna, hanem az óráról. Ez dönt a gépen és a telefonon
        // EGYSZERRE ugyanarról az oldalról.
        setenv("TZ", "UTC", 1)
        CFTimeZoneResetSystem()
        guard TimeZone.current.secondsFromGMT() == 0 else {
            throw XCTSkip("a menetrend-fixtúra csak UTC-ben játszható vissza; ez a gép: \(TimeZone.current.identifier)")
        }
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("merge-cases.json")
        let top = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        let cases = top?["schedules"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 60, "a fixture-ben van elég eset")
        for c in cases {
            let seed = c["seed"] as? Int ?? -1
            let s = schedule(c["schedule"] as? [String: Any] ?? [:])
            let other = schedule(c["other"] as? [String: Any] ?? [:])
            let now = (c["now"] as? NSNumber)?.doubleValue ?? 0
            XCTAssertEqual(ScheduleLogic.isBlockedBySchedule(s, now), c["blocked"] as? Bool ?? false, "menetrend tilt-e, mag \(seed)")
            XCTAssertEqual(ScheduleLogic.isLoosening(s, other, now), c["loosening"] as? Bool ?? false, "menetrend lazítás-e, mag \(seed)")
            // A következő váltás: a sor ebből mondja, mikor nyit és mikor zár.
            XCTAssertEqual(ScheduleLogic.nextOpenAt(s, now), (c["nextOpen"] as? NSNumber)?.doubleValue ?? -1, "menetrend következő nyitása, mag \(seed)")
            XCTAssertEqual(ScheduleLogic.nextCloseAt(s, now), (c["nextClose"] as? NSNumber)?.doubleValue ?? -1, "menetrend következő zárása, mag \(seed)")
        }
    }

    private func bands(_ arr: [[String: Any]]) -> [ScheduleLogic.Band] {
        arr.map { w in
            ScheduleLogic.Band(days: w["days"] as? [Int] ?? [], startMin: w["startMin"] as? Int ?? 0, endMin: w["endMin"] as? Int ?? 0)
        }
    }

    private func occKey(_ o: Focus.Occurrence?) -> String? { o.map { "\(Int64($0.startsAt))/\(Int64($0.endsAt))" } }

    private func lockKey(_ l: LockdownLogic.Lockdown?) -> String? { l.map { "\(Int64($0.startedAt))/\(Int64($0.until))" } }

    func testTheLockdownWindowsDecideTheSameAsTheDesktopInUTC() throws {
        // A heti ablak minden eszközön UGYANAKKOR zár és ugyanakkor enged; az
        // előfordulás-számtan helyi időben jár, a fixtúra UTC-ben készült.
        setenv("TZ", "UTC", 1)
        CFTimeZoneResetSystem()
        guard TimeZone.current.secondsFromGMT() == 0 else {
            throw XCTSkip("az ablak-fixtúra csak UTC-ben játszható vissza; ez a gép: \(TimeZone.current.identifier)")
        }
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("merge-cases.json")
        let top = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        let cases = top?["windows"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 60, "a fixture-ben van elég eset")
        for c in cases {
            let seed = c["seed"] as? Int ?? -1
            let windows = bands(c["windows"] as? [[String: Any]] ?? [])
            let next = bands(c["next"] as? [[String: Any]] ?? [])
            var cur: LockdownLogic.Lockdown? = nil
            if let cu = c["cur"] as? [String: Any] {
                cur = LockdownLogic.Lockdown(startedAt: (cu["startedAt"] as? NSNumber)?.doubleValue ?? 0,
                                             until: (cu["until"] as? NSNumber)?.doubleValue ?? 0)
            }
            let now = (c["now"] as? NSNumber)?.doubleValue ?? 0
            let within = (c["within"] as? NSNumber)?.doubleValue ?? 0
            XCTAssertEqual(LockdownLogic.weekHasFreeTime(windows, now), c["free"] as? Bool ?? false, "szabad idő, mag \(seed)")
            XCTAssertEqual(LockdownLogic.isWindowsLoosening(windows, next, now), c["loosening"] as? Bool ?? false, "lazítás, mag \(seed)")
            XCTAssertEqual(occKey(LockdownLogic.dueWindow(windows, now)), c["due"] as? String, "élő ablak, mag \(seed)")
            let lock = LockdownLogic.windowLockdown(cur, windows, now)
            XCTAssertEqual(lockKey(lock), c["lock"] as? String, "megkövetelt zárlat, mag \(seed)")
            let probe = lock ?? cur
            let isWin: Bool? = probe.map { LockdownLogic.isWindowLockdown($0, windows) }
            XCTAssertEqual(isWin, c["isWin"] as? Bool, "ablak-zárlat-e, mag \(seed)")
            XCTAssertEqual(occKey(LockdownLogic.windowStartingSoon(cur, windows, now, within: within)), c["soon"] as? String,
                           "közelgő ablak, mag \(seed)")
            var nextOcc: String? = nil
            if let first = windows.first, ScheduleLogic.isValidBand(first) { nextOcc = occKey(Focus.nextOccurrence(first, now: now)) }
            XCTAssertEqual(nextOcc, c["nextOcc"] as? String, "következő előfordulás, mag \(seed)")
        }
    }

    private func logEntries(_ arr: [[String: Any]]) -> [Focus.LogEntry] {
        arr.map { e in
            Focus.LogEntry(
                packId: e["packId"] as? String ?? "", packName: e["packName"] as? String ?? "",
                startedAt: (e["startedAt"] as? NSNumber)?.doubleValue ?? 0, endedAt: (e["endedAt"] as? NSNumber)?.doubleValue ?? 0,
                plannedEndsAt: (e["plannedEndsAt"] as? NSNumber)?.doubleValue ?? 0, stopped: e["stopped"] as? Bool ?? false,
                window: e["window"] as? Bool
            )
        }
    }

    private func summaryKey(_ s: Focus.Summary) -> String {
        "\(s.sessions)/\(Int64(s.totalMs))/\(s.stoppedEarly)/\(s.windowRuns)/\(s.topPack ?? "-")"
    }

    func testTheFocusLogSummariesAreTheSameAsTheDesktopInUTC() throws {
        // A napló a szinkronon utazik; a statisztika és a heti mondat belőle számol.
        // A napkulcs helyi időben jár; a fixtúra UTC-ben készült.
        setenv("TZ", "UTC", 1)
        CFTimeZoneResetSystem()
        guard TimeZone.current.secondsFromGMT() == 0 else {
            throw XCTSkip("a napló-fixtúra csak UTC-ben játszható vissza; ez a gép: \(TimeZone.current.identifier)")
        }
        let here = URL(fileURLWithPath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("fixtures").appendingPathComponent("merge-cases.json")
        let top = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        let cases = top?["focusLogs"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(cases.count, 50, "a fixture-ben van elég eset")
        for c in cases {
            let seed = c["seed"] as? Int ?? -1
            let log = logEntries(c["log"] as? [[String: Any]] ?? [])
            let now = (c["now"] as? NSNumber)?.doubleValue ?? 0
            let weekAgo = now - 7 * 86_400_000
            XCTAssertEqual(summaryKey(Focus.summarizeFocus(log, since: weekAgo, now: now)), c["week"] as? String, "a hét összegzője, mag \(seed)")
            XCTAssertEqual(summaryKey(Focus.summarizeFocusPrevWeek(log, now: now)), c["prev"] as? String, "az előző hét összegzője, mag \(seed)")
            XCTAssertEqual(Focus.byWeekday(log, now: now).map(String.init).joined(separator: ","), c["byWeekday"] as? String, "menet-napok, mag \(seed)")
            XCTAssertEqual(Focus.byHour(log, now: now).map(String.init).joined(separator: ","), c["byHour"] as? String, "menet-órák, mag \(seed)")
            XCTAssertEqual(Focus.dayStreak(log, now: now), c["streak"] as? Int, "sorozat, mag \(seed)")
            XCTAssertEqual(Focus.longestStreak(log, now: now), c["longest"] as? Int, "leghosszabb sorozat, mag \(seed)")
            let runs = Focus.windowRunsByPack(log, since: weekAgo, now: now).sorted { $0.key < $1.key }
                .map { "\($0.key)=\($0.value)" }.joined(separator: ",")
            XCTAssertEqual(runs, c["runs"] as? String, "ablakból indult menetek, mag \(seed)")
            let series = Focus.daySeries(log, now: now, count: 7).map { "\($0.day):\(Int64($0.seconds))" }.joined(separator: ",")
            XCTAssertEqual(series, c["series"] as? String, "napi rajz, mag \(seed)")
        }
    }
}
