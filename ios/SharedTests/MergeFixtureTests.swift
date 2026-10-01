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
        let run = f.run.map { "\($0.packId)/\(int($0.startedAt))/\(int($0.endsAt))" } ?? "-"
        let lock = f.lockdown.map { "\(int($0.startedAt))/\(int($0.until))" } ?? "-"
        // Az ablakok TARTALOM szerint, rendezve: az azonosító és a sorrend nem jelentés.
        let windows = (f.lockdownWindows ?? []).map { LockdownLogic.windowKey($0.band) }.sorted().joined(separator: ";")
        return "packs=[\(packs)] run=\(run) marks=[\(marks)] rev=\(int(f.rev)) at=\(int(f.updatedAt)) by=\(f.updatedBy)"
            + " lock=\(lock) windows=[\(windows)] wmark=\(f.lockdownWindowsRev ?? 0)"
            + " hide=\((f.hideSiteList ?? false) ? 1 : 0) hmark=\(f.hideSiteListRev ?? 0)"
            + " kw=[\(KeywordLogic.keywordsKey(f.keywords ?? []))] kmark=\(f.keywordsRev ?? 0)"
            + " partner=[\(PartnerLogic.partnerKey(f.partner))] pmark=\(f.partnerRev ?? 0)"
            + " log=[" + f.log.map { "\($0.packId)/\(int($0.startedAt))/\(int($0.endedAt))/\(int($0.plannedEndsAt))/\($0.stopped ? 1 : 0)/\(($0.window ?? false) ? 1 : 0)" }.joined(separator: ";") + "]"
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
            XCTAssertEqual(usageKey(UsageStats.combine(states)), c["abc"] as? String ?? "", "használat, három eszköz, mag \(seed)")
        }
    }

    func testFocusMergesTheSameAsTheDesktop() throws {
        let fixture = try loadFixture()
        XCTAssertGreaterThanOrEqual(fixture.focus.count, 50, "a fixture-ben van elég eset")
        for c in fixture.focus {
            // Ugyanaz az út, mint az éles körben: dekódolás, aztán normalizálás.
            let a = FocusSync.normalize(c.a, fallbackDevice: "x")
            let b = FocusSync.normalize(c.b, fallbackDevice: "x")
            let cc = FocusSync.normalize(c.c, fallbackDevice: "x")
            let ab = FocusSync.merge(a, b)
            XCTAssertEqual(focusKey(ab), c.ab, "munkamenet, két eszköz, mag \(c.seed)")
            XCTAssertEqual(focusKey(FocusSync.merge(ab, cc)), c.abc, "munkamenet, három eszköz, mag \(c.seed)")
            // EGY MEZŐ CSERÉJE: ugyanazt tartja-e különbségnek a Swift, mint a gép —
            // és ami nem jelentés (időbélyeg, eszköznév, ablak-azonosító, a
            // csomagok sorrendje), azt nem. A v0.4.170-ben pont a Swift kulcsából
            // maradt ki a rejtés, és a fésülés fixtúrája nem látta; ez látja.
            let flip = FocusSync.normalize(c.flip, fallbackDevice: "x")
            XCTAssertEqual(FocusSync.same(a, flip), c.same, "különbség, mag \(c.seed): \(c.what)")
        }
    }
}
