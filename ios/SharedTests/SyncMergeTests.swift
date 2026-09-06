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
        let keep = site(id: "site_old", hostnames: ["youtube.com"], addedAt: 1_000, rev: 5, hostnameMarks: ["music.youtube.com": 5])
        let drop = site(id: "site_new", hostnames: ["m.youtube.com", "music.youtube.com", "youtube.com"], addedAt: 2_000, rev: 1, updatedBy: "b")
        let merged = SyncMerge.mergeLists([keep], [drop])
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged.first?.id, "site_old")
        XCTAssertEqual(merged.first?.hostnames, ["m.youtube.com", "youtube.com"], "a jel nélküli m. bekerül, a jeles music. nem jön vissza")
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
