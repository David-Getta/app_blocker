import Foundation
import XCTest
@testable import BreakerShared

// A hosztnevek fésülése a Swift tükrön — desktop/test/merge-hostnames.test.ts
// és az androidos SyncMergeHostnamesTest esetei.
//
// A hosztnév-lista a tiltás része. Egy név levétele lazítás, ami csak
// próbatétel után, jellel mehet át; egy versenyhelyzet sosem oldhat fel semmit.
final class SyncMergeTests: XCTestCase {

    private func site(
        id: String = "site_1", hostnames: [String] = ["youtube.com"], addedAt: Double = 1_000,
        dailyLimitSeconds: Double? = nil, alias: String? = nil,
        rev: Int = 3, updatedAt: Double = 100, updatedBy: String = "a",
        hostnameMarks: [String: Int]? = nil
    ) -> SyncMerge.SyncSite {
        SyncMerge.SyncSite(
            id: id, domain: "youtube.com", hostnames: hostnames, addedAt: addedAt,
            dailyLimitSeconds: dailyLimitSeconds, alias: alias,
            rev: rev, updatedAt: updatedAt, updatedBy: updatedBy, hostnameMarks: hostnameMarks
        )
    }

    func testEqualRevNamesUniteARaceNeverLoosens() {
        let a = site(hostnames: ["youtube.com", "www.youtube.com"], updatedAt: 100, updatedBy: "a")
        let b = site(hostnames: ["youtube.com", "music.youtube.com"], updatedAt: 200, updatedBy: "b")
        let expected = ["music.youtube.com", "www.youtube.com", "youtube.com"]
        XCTAssertEqual(SyncMerge.mergeSite(a, b).hostnames, expected)
        XCTAssertEqual(SyncMerge.mergeSite(b, a).hostnames, expected, "szimmetrikus")
    }

    func testHigherRevRemovalPasses() {
        let trimmed = site(hostnames: ["youtube.com"], rev: 4, updatedAt: 300)
        let old = site(hostnames: ["youtube.com", "music.youtube.com"], rev: 3)
        XCTAssertEqual(SyncMerge.mergeSite(trimmed, old).hostnames, ["youtube.com"])
        XCTAssertEqual(SyncMerge.mergeSite(old, trimmed).hostnames, ["youtube.com"])
    }

    func testEqualRevMarkedRemovalStaysAndTheOtherEditSurvives() {
        let removed = site(hostnames: ["youtube.com"], updatedAt: 100, hostnameMarks: ["music.youtube.com": 3])
        let other = site(hostnames: ["music.youtube.com", "youtube.com"], alias: "tube", updatedAt: 200, updatedBy: "b")
        for (x, y) in [(removed, other), (other, removed)] {
            let m = SyncMerge.mergeSite(x, y)
            XCTAssertEqual(m.hostnames, ["youtube.com"], "a kifizetett levétel áll")
            XCTAssertEqual(m.alias, "tube", "a másik szerkesztés nem veszett el")
            XCTAssertEqual(m.hostnameMarks, ["music.youtube.com": 3], "a jel utazik tovább")
        }
    }

    func testHigherRevWithOldNameTheMarkStillDecides() {
        let removed = site(hostnames: ["youtube.com"], rev: 3, hostnameMarks: ["music.youtube.com": 3])
        let twice = site(hostnames: ["music.youtube.com", "youtube.com"], alias: "tube", rev: 5, updatedBy: "b")
        let m = SyncMerge.mergeSite(twice, removed)
        XCTAssertEqual(m.hostnames, ["youtube.com"])
        XCTAssertEqual(m.alias, "tube", "a nagyobb rev a többi mezőt viszi")
    }

    func testReaddedWithHigherMarkBeatsTheOldRemoval() {
        let removed = site(hostnames: ["youtube.com"], rev: 3, hostnameMarks: ["music.youtube.com": 3])
        let readded = site(hostnames: ["music.youtube.com", "youtube.com"], rev: 6, hostnameMarks: ["music.youtube.com": 6])
        for (x, y) in [(removed, readded), (readded, removed)] {
            let m = SyncMerge.mergeSite(x, y)
            XCTAssertEqual(m.hostnames, ["music.youtube.com", "youtube.com"])
            XCTAssertEqual(m.hostnameMarks, ["music.youtube.com": 6])
        }
    }

    func testOlderRecordsFreeAdditionSurvivesBehindHigherRev() {
        let newer = site(hostnames: ["youtube.com"], rev: 5)
        let older = site(hostnames: ["m.youtube.com", "youtube.com"], rev: 4, updatedBy: "b", hostnameMarks: ["m.youtube.com": 4])
        XCTAssertEqual(SyncMerge.mergeSite(newer, older).hostnames, ["m.youtube.com", "youtube.com"])
    }

    func testEqualOrNoMarkTheBroaderWins() {
        let a = site(hostnames: ["youtube.com"], hostnameMarks: ["music.youtube.com": 4])
        let b = site(hostnames: ["music.youtube.com", "youtube.com"], updatedBy: "b", hostnameMarks: ["music.youtube.com": 4])
        XCTAssertEqual(SyncMerge.mergeSite(a, b).hostnames, ["music.youtube.com", "youtube.com"], "döntetlen: bent marad")
        // Egyenlő POZITÍV jelnél a jelenlét akkor is nyer, ha a rev eltér.
        var a9 = a
        a9.rev = 9
        XCTAssertEqual(SyncMerge.mergeSite(a9, b).hostnames, ["music.youtube.com", "youtube.com"])
        XCTAssertEqual(SyncMerge.mergeSite(b, a9).hostnames, ["music.youtube.com", "youtube.com"])
        let plain = site(hostnames: ["youtube.com"])
        let legacy = site(hostnames: ["m.youtube.com", "youtube.com"], updatedBy: "b")
        let m = SyncMerge.mergeSite(plain, legacy)
        XCTAssertEqual(m.hostnames, ["m.youtube.com", "youtube.com"])
        XCTAssertNil(m.hostnameMarks, "jel nélkül nem keletkezik jel")
    }

    func testEqualRevStricterRecordWinsNamesStillUnite() {
        let stricter = site(hostnames: ["youtube.com"], dailyLimitSeconds: 600)
        let looser = site(hostnames: ["youtube.com", "m.youtube.com"], dailyLimitSeconds: 3_600, updatedBy: "b")
        let m = SyncMerge.mergeSite(stricter, looser)
        XCTAssertEqual(m.dailyLimitSeconds, 600)
        XCTAssertEqual(m.hostnames, ["m.youtube.com", "youtube.com"])
    }

    func testMarkCapIsOneRulePresentNamesStayNewestOfTheGoneFit() {
        var marks: [String: Int] = ["www.youtube.com": 3]
        for i in 0..<70 { marks[String(format: "h%02d.youtube.com", i)] = 100 + (i % 7) }
        let capped = SyncMerge.capHostnameMarks(marks, ["www.youtube.com", "youtube.com"])!
        XCTAssertEqual(capped.count, SyncMerge.maxHostnameMarks)
        XCTAssertEqual(capped["www.youtube.com"], 3, "a jelen lévő név jele bent marad, pedig a legkisebb")
        let goneValues = capped.filter { $0.key != "www.youtube.com" }.map { $0.value }
        XCTAssertEqual(goneValues.count, 63)
        XCTAssertEqual(goneValues.filter { $0 > 100 }.count, 60, "minden 101-es és fölötti jel megmaradt")
        XCTAssertEqual(goneValues.filter { $0 == 100 }.count, 3, "a legrégebbi (100-as) jelekből estek ki")
        XCTAssertNil(SyncMerge.capHostnameMarks([:], []))
        // A fésülés is ezzel a plafonnal ad vissza: két 64-es nem lesz 128.
        let keys = marks.keys.sorted()
        var first: [String: Int] = [:]
        for k in keys.prefix(64) { first[k] = marks[k] }
        var second: [String: Int] = [:]
        for k in keys.dropFirst(7).prefix(64) { second[k] = marks[k] }
        let a = site(hostnames: ["youtube.com"], rev: 5, hostnameMarks: first)
        let b = site(hostnames: ["youtube.com"], rev: 5, updatedBy: "b", hostnameMarks: second)
        XCTAssertLessThanOrEqual(SyncMerge.mergeSite(a, b).hostnameMarks?.count ?? 0, SyncMerge.maxHostnameMarks)
    }

    func testSameDomainTwoIdsUnionOnlyUnmarkedNames() {
        let old = site(id: "site_old", hostnames: ["youtube.com"], addedAt: 1_000, rev: 5, hostnameMarks: ["music.youtube.com": 5])
        let fresh = site(id: "site_new", hostnames: ["m.youtube.com", "music.youtube.com", "youtube.com"], addedAt: 2_000, rev: 1, updatedBy: "b")
        let merged = SyncMerge.mergeLists([old], [fresh])
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged.first?.id, "site_new", "az újabban felvett azonosító marad")
        XCTAssertEqual(merged.first?.addedAt, 2_000, "a felvétel ideje is az övé")
        XCTAssertEqual(merged.first?.hostnames, ["m.youtube.com", "youtube.com"], "a jel nélküli m. bekerül, a jeles music. nem jön vissza")
    }

    func testPerRuleTheMarkDecidesAndAFreeAdditionDoesNotTakeTheOtherDevicesRule() {
        func rec(_ rev: Int, _ rules: [UrlRules.UrlRule]?, _ marks: [String: Int]?, _ by: String, listMark: Int? = nil)
            -> SyncMerge.SyncSite {
            SyncMerge.SyncSite(
                id: "site_1", domain: "youtube.com", hostnames: ["youtube.com"], addedAt: 1_000,
                rules: rules, rev: rev, updatedAt: 100, updatedBy: by, rulesRev: listMark, ruleMarks: marks
            )
        }
        let r1 = UrlRules.UrlRule(host: "youtube.com", path: "/@egy")
        let rs = UrlRules.UrlRule(host: "youtube.com", path: "/@s")
        let rt = UrlRules.UrlRule(host: "youtube.com", path: "/@t")
        // A RÉGI HIBA: az ingyenes felvétel nagyobb lista-jellel egészében vitte a
        // listáját. Szabályonként mindkét felvett szabály megmarad.
        let a = rec(10, [r1, rt], ["youtube.com/@t": 10], "a", listMark: 10)
        let b = rec(4, [r1, rs], ["youtube.com/@s": 4], "b", listMark: 4)
        for m in [SyncMerge.mergeSite(a, b), SyncMerge.mergeSite(b, a)] {
            XCTAssertEqual(m.rules, [r1, rs, rt])
            XCTAssertEqual(m.ruleMarks, ["youtube.com/@s": 4, "youtube.com/@t": 10])
            XCTAssertEqual(m.rulesRev, 10, "a lista-jelből a nagyobb megy tovább")
        }
        // A kifizetett levétel sírköve a nagyobb rev-ű, régi listát is legyőzi.
        let kept = rec(6, [r1], ["youtube.com/@egy": 2], "a")
        let removed = rec(4, [], ["youtube.com/@egy": 4], "b")
        XCTAssertEqual(SyncMerge.mergeSite(kept, removed).rules, [])
        XCTAssertEqual(SyncMerge.mergeSite(removed, kept).rules, [])
        // Egyenlő jelnél a jelenlét; a később újra felvett nyer a levétel ellen.
        XCTAssertEqual(SyncMerge.mergeSite(removed, rec(4, [r1], ["youtube.com/@egy": 4], "c")).rules, [r1])
        XCTAssertEqual(SyncMerge.mergeSite(removed, rec(8, [r1], ["youtube.com/@egy": 8], "c")).rules, [r1])
        // Sírkő nélkül az üres lista nem vesz le semmit.
        XCTAssertEqual(SyncMerge.mergeSite(kept, rec(9, [], nil, "d")).rules, [r1])
        // Régi kliens (nincs mező) a másik oldal listáját és jeleit viszi; a sorrend nem számít.
        let old = rec(9, nil, nil, "telefon")
        let viaKept = SyncMerge.mergeSite(SyncMerge.mergeSite(old, kept), removed)
        let viaRemoved = SyncMerge.mergeSite(SyncMerge.mergeSite(old, removed), kept)
        XCTAssertEqual(viaKept.rules, [])
        XCTAssertEqual(viaRemoved.rules, [])
        XCTAssertEqual(viaKept.ruleMarks, ["youtube.com/@egy": 4])
        XCTAssertEqual(viaRemoved.ruleMarks, ["youtube.com/@egy": 4])
    }

    func testTheRuleMarksTravelOnlyWithAListWithCanonicalKeysUpToTheRev() throws {
        let json = #"""
        [{"id":"s1","domain":"a.com","hostnames":["a.com"],"rev":4,"rules":[{"host":"a.com","path":"/x"}],
          "ruleMarks":{"a.com/x":3,"a.com/y":4,"a.com/z":5,"www.a.com/q":1,"a.com/w":1.5,"a.com/v":"1"}},
         {"id":"s2","domain":"b.com","hostnames":["b.com"],"rev":4,"ruleMarks":{"b.com/x":1}}]
        """#
        let sites = try JSONDecoder().decode([SyncMerge.SyncSite].self, from: Data(json.utf8))
        XCTAssertEqual(sites[0].ruleMarks, ["a.com/x": 3, "a.com/y": 4], "a sírkő is jel; a rev fölötti és a nem kanonikus nem")
        XCTAssertNil(sites[1].ruleMarks, "lista nélkül nincs jel")
        let back = try JSONDecoder().decode([SyncMerge.SyncSite].self, from: JSONEncoder().encode(sites))
        XCTAssertEqual(back[0].ruleMarks, ["a.com/x": 3, "a.com/y": 4])
    }

    // MARK: - mezőnként: a kifizetett számláló, egyenlőnél a szigorúbb alak
    //
    // A desktop/test/sync-merge.test.ts és az androidos SyncMergeTest esetei.

    private let work = ScheduleLogic.Schedule(
        mode: .block, bands: [ScheduleLogic.Band(days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60)]
    )
    private let evening = ScheduleLogic.Schedule(
        mode: .block, bands: [ScheduleLogic.Band(days: [0, 1, 2, 3, 4, 5, 6], startMin: 22 * 60, endMin: 6 * 60)]
    )

    private func rec(
        rev: Int = 1, schedule: ScheduleLogic.Schedule? = nil, limit: Double? = nil,
        burst: Double? = nil, cooldown: Double? = nil, pendingDeleteAt: Double? = nil,
        alias: String? = nil, updatedAt: Double = 5_000, by: String = "gep-a",
        deleteLoosens: Int? = nil, scheduleLoosens: Int? = nil, limitLoosens: Int? = nil
    ) -> SyncMerge.SyncSite {
        SyncMerge.SyncSite(
            id: "site_1", domain: "youtube.com", hostnames: ["youtube.com"], addedAt: 1_000,
            pendingDeleteAt: pendingDeleteAt, schedule: schedule, dailyLimitSeconds: limit,
            burstSeconds: burst, cooldownSeconds: cooldown, alias: alias,
            rev: rev, updatedAt: updatedAt, updatedBy: by,
            deleteLoosens: deleteLoosens, scheduleLoosens: scheduleLoosens, limitLoosens: limitLoosens
        )
    }

    /// Tilt-e a menetrend egy napon, egy percben — a sávok szerkezete szerint.
    private func blocked(_ s: ScheduleLogic.Schedule, _ day: Int, _ minute: Int) -> Bool {
        s.bands.contains { $0.days.contains(day) && minute >= $0.startMin && minute < $0.endMin } == (s.mode == .block)
    }

    func testTheStricterFormOfTwoSchedulesIsTheirUnionByStructure() {
        guard let both = SyncMerge.joinSchedule(work, evening) else { return XCTFail("az unió nem a mindig") }
        XCTAssertEqual(both.mode, .block)
        XCTAssertTrue(blocked(both, 1, 10 * 60), "hétfő délelőtt: a munkaidő tilt")
        XCTAssertTrue(blocked(both, 3, 23 * 60), "szerda este: az esti sáv tilt")
        XCTAssertFalse(blocked(both, 6, 12 * 60), "szombat délben egyik sem")
        XCTAssertEqual(SyncMerge.joinSchedule(evening, work), both, "a sorrend nem számít")
        XCTAssertNil(SyncMerge.joinSchedule(work, nil), "a menetrend nélküli (mindig tilt) lefed mindent")
        XCTAssertEqual(SyncMerge.joinSchedule(work, work), work)
        let wider = ScheduleLogic.Schedule(
            mode: .block, bands: [ScheduleLogic.Band(days: [1, 2, 3, 4, 5], startMin: 8 * 60, endMin: 18 * 60)]
        )
        XCTAssertEqual(SyncMerge.joinSchedule(work, wider), wider, "ha az egyik lefedi a másikat, az marad")
        let allow = ScheduleLogic.Schedule(mode: .allow, bands: work.bands)
        XCTAssertEqual(SyncMerge.joinSchedule(allow, work), ScheduleLogic.Schedule(mode: .always, bands: []),
                       "a munkaidőn kívül tilt + munkaidőben tilt = mindig")
    }

    func testAtEqualCountersEachFieldTakesItsStricterForm() {
        let a = rec(rev: 4, schedule: work, limit: 3600)
        let b = rec(rev: 4, schedule: evening, limit: 600, by: "gep-b")
        for m in [SyncMerge.mergeSite(a, b), SyncMerge.mergeSite(b, a)] {
            XCTAssertEqual(m.dailyLimitSeconds, 600, "a kisebb keret")
            XCTAssertEqual(m.schedule, SyncMerge.joinSchedule(work, evening), "a két menetrend uniója")
        }
        let burst = SyncMerge.mergeSite(rec(burst: 300, cooldown: 600), rec(burst: 600, cooldown: 1200, by: "gep-b"))
        XCTAssertEqual(burst.burstSeconds, 300, "a kisebb adag")
        XCTAssertEqual(burst.cooldownSeconds, 1200, "és a hosszabb szünet")
    }

    func testALooseningOnlyLandsWithThePaidCounter() {
        let strict = rec(rev: 4, limit: 600)
        let earned = rec(rev: 5, limit: 3600, by: "gep-b", limitLoosens: 1)
        XCTAssertEqual(SyncMerge.mergeSite(strict, earned).dailyLimitSeconds, 3600, "a próbatétel megvolt")
        XCTAssertEqual(SyncMerge.mergeSite(earned, strict).dailyLimitSeconds, 3600)
        // A TRÜKK: egy elavult eszköz ingyenes szerkesztésekkel felhúzza a rev-et.
        let stale = rec(rev: 99, limit: 7200, updatedAt: 99_999, by: "gep-b")
        XCTAssertEqual(SyncMerge.mergeSite(strict, stale).dailyLimitSeconds, 600, "régi, lazább rekord nem lazít")
        XCTAssertEqual(SyncMerge.mergeSite(stale, strict).dailyLimitSeconds, 600)
        // A számláló mezőnként: a keret lazítása nem viszi el a máshol felvett menetrendet.
        let scheduled = rec(rev: 6, schedule: work, limit: 600)
        let earnedEvening = rec(rev: 5, schedule: evening, limit: 3600, by: "gep-b", limitLoosens: 1)
        let m = SyncMerge.mergeSite(scheduled, earnedEvening)
        XCTAssertEqual(m.dailyLimitSeconds, 3600)
        XCTAssertEqual(m.schedule, SyncMerge.joinSchedule(work, evening), "a menetrend a saját számlálója szerint dől el")
        XCTAssertEqual(m.limitLoosens, 1, "a számláló a fésültben is ott van")
    }

    func testAPendingDeletionDoesNotVanishSilentlyOnlyOneWhoSawItCanCancel() {
        let deleting = rec(rev: 3, pendingDeleteAt: 9_000_000, deleteLoosens: 1)
        let unaware = rec(rev: 9, alias: "A videós", by: "gep-b")
        let m = SyncMerge.mergeSite(deleting, unaware)
        XCTAssertEqual(m.alias, "A videós", "a frissebb rekord fedőneve jön")
        XCTAssertEqual(m.pendingDeleteAt, 9_000_000, "a kifizetett kérés megmarad")
        let cancelled = rec(rev: 4, by: "gep-b", deleteLoosens: 1)
        XCTAssertNil(SyncMerge.mergeSite(deleting, cancelled).pendingDeleteAt)
        XCTAssertNil(SyncMerge.mergeSite(cancelled, deleting).pendingDeleteAt)
        // Két független kérés egyenlő számlálóval: a későbbi határidő; az újra kért nyer.
        let other = rec(rev: 4, pendingDeleteAt: 8_000_000, by: "gep-b", deleteLoosens: 1)
        XCTAssertEqual(SyncMerge.mergeSite(deleting, other).pendingDeleteAt, 9_000_000)
        XCTAssertEqual(SyncMerge.mergeSite(other, deleting).pendingDeleteAt, 9_000_000)
        let again = rec(rev: 6, pendingDeleteAt: 7_000_000, deleteLoosens: 2)
        XCTAssertEqual(SyncMerge.mergeSite(deleting, again).pendingDeleteAt, 7_000_000)
    }

    func testTheStricterFormOfABudgetAndOfABurstRule() {
        XCTAssertEqual(SyncMerge.joinLimit(600, 3600), 600)
        XCTAssertEqual(SyncMerge.joinLimit(nil, 3600), 3600, "a keret nélküli a leglazább")
        XCTAssertNil(SyncMerge.joinLimit(nil, nil))
        let kept = SyncMerge.joinBurst((burst: 300, cooldown: 900), (burst: nil, cooldown: nil))
        XCTAssertEqual(kept.burst, 300)
        XCTAssertEqual(kept.cooldown, 900)
        let both = SyncMerge.joinBurst((burst: 300, cooldown: 600), (burst: 200, cooldown: 900))
        XCTAssertEqual(both.burst, 200, "mindkettő szigorúbbja")
        XCTAssertEqual(both.cooldown, 900)
    }

    func testAMissingRecordNeverMeansDeletion() {
        let mine = site(id: "site_a")
        var theirs = site(id: "site_b", addedAt: 2_000)
        theirs.domain = "reddit.com"
        theirs.hostnames = ["reddit.com"]
        XCTAssertEqual(SyncMerge.mergeLists([mine], []).count, 1, "üres fiókkal belépve nem tűnik el a lista")
        XCTAssertEqual(SyncMerge.mergeLists([mine], [theirs]).map { $0.id }, ["site_a", "site_b"])
    }
}
