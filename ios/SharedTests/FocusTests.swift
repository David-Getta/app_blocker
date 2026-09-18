import Foundation
import XCTest
@testable import BreakerShared

// A munkamenet magja a Swift tükrön — a desktop/test/focus-day-series.test.ts
// és az androidos FocusTest esetei.
final class FocusTests: XCTestCase {

    private func entry(_ startedAt: Double, _ endedAt: Double) -> Focus.LogEntry {
        Focus.LogEntry(packId: "p1", packName: "Nyelvtanulás", startedAt: startedAt, endedAt: endedAt, plannedEndsAt: endedAt, stopped: false)
    }

    private func localTime(_ hour: Int, _ minute: Int) -> Double {
        let d = Calendar.current.date(from: DateComponents(year: 2026, month: 9, day: 5, hour: hour, minute: minute))!
        return d.timeIntervalSince1970 * 1000
    }

    func testTheLastUsedPackFromTheLogWithoutDeletedOnesElseTheFirst() {
        let a = Focus.Pack(id: "pack_a", name: "A", allowSites: ["a.com"], allowApps: [], defaultMinutes: 25)
        let b = Focus.Pack(id: "pack_b", name: "B", allowSites: ["b.com"], allowApps: [], defaultMinutes: 50)
        func e(_ id: String, _ at: Double) -> Focus.LogEntry {
            Focus.LogEntry(packId: id, packName: id, startedAt: at, endedAt: at + 60_000, plannedEndsAt: at + 60_000, stopped: false)
        }
        XCTAssertNil(Focus.lastUsedPack([], log: []), "csomag nélkül nincs mit indítani")
        XCTAssertEqual(Focus.lastUsedPack([a, b], log: [])?.id, "pack_a", "napló nélkül az első")
        XCTAssertEqual(Focus.lastUsedPack([a, b], log: [e("pack_a", 1000), e("pack_b", 2000)])?.id, "pack_b", "a legfrissebb sor")
        XCTAssertEqual(Focus.lastUsedPack([a, b], log: [e("pack_a", 1000), e("pack_x", 2000)])?.id, "pack_a", "a törölt csomag sora nem számít")
    }

    func testKeywordInTheHostnameBlocksButNotInfraOrTheSyncHostAndTheListWins() {
        let kw = ["tiktok", "live"]
        XCTAssertEqual(Focus.verdict("www.TikTok.com.", run: nil, pack: nil, now: 0, blocked: [], syncHost: nil, keywords: kw), .blockedByKeyword)
        XCTAssertEqual(Focus.verdict("example.com", run: nil, pack: nil, now: 0, blocked: [], syncHost: nil, keywords: kw), .allow)
        XCTAssertEqual(Focus.verdict("captive.apple.com", run: nil, pack: nil, now: 0, blocked: [], syncHost: nil, keywords: ["apple"]), .allow, "infrastruktúra: sosem — az iPhone listája az Apple-hosztok")
        XCTAssertEqual(Focus.verdict("live.example.org", run: nil, pack: nil, now: 0, blocked: [], syncHost: "live.example.org", keywords: kw), .allow, "a fiókkiszolgáló: sosem")
        XCTAssertEqual(Focus.verdict("tiktok.com", run: nil, pack: nil, now: 0, blocked: ["tiktok.com"], syncHost: nil, keywords: kw), .blockedByList, "a lista elsőbb")
        XCTAssertEqual(Focus.verdict("tiktok.com", run: nil, pack: nil, now: 0, blocked: [], syncHost: nil, keywords: []), .allow, "kulcsszó nélkül nincs")
        let pack = Focus.Pack(id: "p1", name: "T", allowSites: ["tiktok.com"], allowApps: [], defaultMinutes: 25)
        let run = Focus.Run(packId: "p1", startedAt: 0, endsAt: 10_000)
        XCTAssertEqual(Focus.verdict("m.tiktok.com", run: run, pack: pack, now: 1_000, blocked: [], syncHost: nil, keywords: kw), .blockedByKeyword, "a csomag fehérlistája sem old fel")
    }

    func testWhatWouldHappenWithThisTheProbeSentenceIsTheSameVerdictInWords() {
        let kw = ["tiktok"]
        XCTAssertEqual(Focus.explain("youtube.com", run: nil, pack: nil, now: 0, blocked: ["youtube.com"], syncHost: nil, keywords: kw), "Tiltva: a lista.")
        XCTAssertEqual(Focus.explain("www.tiktok.com", run: nil, pack: nil, now: 0, blocked: [], syncHost: nil, keywords: kw), "Tiltva: kulcsszó a hosztnévben („tiktok”).")
        let pack = Focus.Pack(id: "p1", name: "T", allowSites: ["quizlet.com"], allowApps: [], defaultMinutes: 25)
        let run = Focus.Run(packId: "p1", startedAt: 0, endsAt: 10_000)
        XCTAssertEqual(Focus.explain("reddit.com", run: run, pack: pack, now: 1_000, blocked: [], syncHost: nil, keywords: kw), "Tiltva, amíg a munkamenet tart: nincs a csomagon.")
        XCTAssertEqual(Focus.explain("captive.apple.com", run: run, pack: pack, now: 1_000, blocked: [], syncHost: nil, keywords: kw), "Átmegy: rendszer-infrastruktúra.")
        XCTAssertEqual(Focus.explain("example.com", run: nil, pack: nil, now: 0, blocked: [], syncHost: nil, keywords: kw), "Átmegy.")
        XCTAssertEqual(Focus.explain("  ", run: nil, pack: nil, now: 0, blocked: [], syncHost: nil, keywords: kw), "", "üres név: nincs mondat")
    }

    func testThePreviousWeekFromTheStartOfTheThirteenthDayToTheStartOfTheSixthTheBoundaryIsThisWeeks() {
        let now = localTime(12, 0)
        let start = Calendar.current.startOfDay(for: Date(timeIntervalSince1970: now / 1000)).timeIntervalSince1970 * 1000
        let day = 86_400_000.0
        let log = [
            entry(start - 6 * day, start - 6 * day + 1),   // a mostani hét első pillanata
            entry(start - 7 * day, start - 6 * day - 1),   // az előző hét utolsó pillanata
            entry(start - 13 * day, start - 13 * day),     // az előző hét első pillanata
            entry(start - 14 * day, start - 13 * day - 1), // már nem
        ]
        XCTAssertEqual(Focus.summarizeFocusPrevWeek(log, now: now).sessions, 2, "a 13. nap kezdete és a 6. nap kezdete előtti pillanat benne")
        XCTAssertEqual(Focus.summarizeFocus(log, since: start - 6 * day, now: now).sessions, 1, "a mostani hét a maradék")
        XCTAssertEqual(Focus.summarizeFocusPrevWeek([], now: now).sessions, 0)
    }

    func testDaySeriesCountsASessionOnTheDayItEnded() {
        let day = 86_400_000.0
        let hour = 3_600_000.0
        let now = localTime(20, 0)
        let log = [
            entry(now - 3 * hour, now - 2 * hour),                   // ma, 1 óra
            entry(now - day - hour, now - day),                       // tegnap, 1 óra
            entry(now - day - 30 * 60_000, now - day + 10 * 60_000), // tegnap, 40 perc
            entry(now - 10 * day, now - 10 * day + hour),             // tíz napja: kiesik
            entry(now + hour, now + 2 * hour),                        // a jövő: kiesik
        ]
        let s = Focus.daySeries(log, now: now, count: 7)
        XCTAssertEqual(s.count, 7)
        XCTAssertEqual(s[6].day, UsageStats.dayKey(Date(timeIntervalSince1970: now / 1000)), "az utolsó oszlop a mai nap")
        XCTAssertEqual(s[6].seconds, 3600)
        XCTAssertEqual(s[5].seconds, 6000, "tegnap: egy óra és negyven perc")
        XCTAssertEqual(s.prefix(5).map { $0.seconds }, [0, 0, 0, 0, 0])
    }

    func testASessionAcrossMidnightCountsWhollyOnItsEndDay() {
        let now = localTime(20, 0)
        let midnight = localTime(0, 0)
        let s = Focus.daySeries([entry(midnight - 30 * 60_000, midnight + 30 * 60_000)], now: now, count: 7)
        XCTAssertEqual(s[6].seconds, 3600, "a mai napon egy óra")
        XCTAssertEqual(s[5].seconds, 0, "tegnap semmi")
        XCTAssertEqual(Focus.daySeries([], now: now, count: 3).map { $0.seconds }, [0, 0, 0])
    }
}
