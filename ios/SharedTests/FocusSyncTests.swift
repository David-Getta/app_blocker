import Foundation
import XCTest
@testable import BreakerShared

// A munkamenet összefésülése két eszköz között — a Swift tükrön.
//
// Ez a szinkron kockázatos fele: itt dől el, hogy egy MÁSIK eszköz köre ki
// tudja-e kapcsolni azt a munkamenetet, amit épp futtatsz. A tesztek
// SZÁNDÉKOSAN úgy állítják be a döntetlen-eltörést, hogy az „utolsó író nyer”
// a ROSSZ oldalt választaná — enélkül egy elrontott összefésülés mellett is
// átmennének. Ugyanazok az esetek, mint desktop/test/focus-merge.test.ts és
// focus-pack-marks.test.ts, valamint az androidos FocusSyncTest.
final class FocusSyncTests: XCTestCase {

    private let win = ScheduleLogic.Band(days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 12 * 60)

    private func pack(_ id: String = "p1", name: String? = nil, recurrence: ScheduleLogic.Band? = nil) -> Focus.Pack {
        Focus.Pack(
            id: id, name: name ?? "csomag \(id)", allowSites: ["quizlet.com"], allowApps: ["Word"],
            defaultMinutes: 50, recurrence: recurrence
        )
    }

    private func focus(
        packs: [Focus.Pack], run: Focus.Run? = nil, log: [Focus.LogEntry] = [],
        rev: Double, updatedAt: Double, updatedBy: String = "eszkoz-a", packMarks: [String: Int]? = nil
    ) -> FocusSync.SyncFocus {
        FocusSync.SyncFocus(
            packs: packs, run: run, log: log, rev: rev, updatedAt: updatedAt,
            updatedBy: updatedBy, packMarks: packMarks
        )
    }

    // MARK: - a futó menet

    func testRunningIsNotStoppedByIdleStateAtSameRev() {
        let running = focus(packs: [pack()], run: Focus.Run(packId: "p1", startedAt: 0, endsAt: 10_000), rev: 4, updatedAt: 100)
        // Az újabb ÉS a később rendezett azonosító az üres oldalé.
        let stale = focus(packs: [pack()], run: nil, rev: 4, updatedAt: 500, updatedBy: "eszkoz-z")
        XCTAssertEqual(FocusSync.merge(running, stale).run, running.run)
        XCTAssertEqual(FocusSync.merge(stale, running).run, running.run)
    }

    /// A menet lezárásának naplósora — a sírköve a szinkronban.
    private func ended(
        startedAt: Double = 0, endedAt: Double = 5_000, plannedEndsAt: Double = 10_000,
        stopped: Bool = true, cuts: Int? = nil, origin: Double? = nil, packId: String = "p1"
    ) -> Focus.LogEntry {
        Focus.LogEntry(
            packId: packId, packName: "csomag", startedAt: startedAt, endedAt: endedAt,
            plannedEndsAt: plannedEndsAt, stopped: stopped, cuts: cuts, origin: origin
        )
    }

    func testStopPassesWithItsLogRow() {
        let running = focus(packs: [pack()], run: Focus.Run(packId: "p1", startedAt: 0, endsAt: 10_000), rev: 4, updatedAt: 100)
        let stopped = focus(packs: [pack()], run: nil, log: [ended()], rev: 5, updatedAt: 110, updatedBy: "eszkoz-b")
        XCTAssertNil(FocusSync.merge(running, stopped).run)
        XCTAssertNil(FocusSync.merge(stopped, running).run)
    }

    func testAnInflatedRevWithoutTheRowDoesNotStopTheRun() {
        // A független átnézés kiskapuja: átnevezésekkel bármekkora rev elérhető,
        // ingyen. A menetről nem tud, sort sem írhat róla.
        let running = focus(packs: [pack()], run: Focus.Run(packId: "p1", startedAt: 0, endsAt: 10_000), rev: 4, updatedAt: 100)
        let inflated = focus(packs: [pack()], run: nil, rev: 40, updatedAt: 900, updatedBy: "eszkoz-z")
        XCTAssertEqual(FocusSync.merge(running, inflated, now: 2_000).run, running.run)
        XCTAssertEqual(FocusSync.merge(inflated, running, now: 2_000).run, running.run)
        let otherRows = focus(packs: [pack()], run: nil, log: [ended(startedAt: 1), ended(packId: "p2")], rev: 40, updatedAt: 900)
        XCTAssertEqual(FocusSync.merge(running, otherRows, now: 2_000).run, running.run, "más menet sora nem jó")
    }

    func testAPaidCutBeatsTheOlderLongerVariant() {
        let cut = focus(packs: [pack()], run: Focus.Run(packId: "p1", startedAt: 0, endsAt: 5_000, cuts: 1), rev: 2, updatedAt: 100)
        let stale = focus(packs: [pack()], run: Focus.Run(packId: "p1", startedAt: 0, endsAt: 10_000), rev: 9, updatedAt: 900, updatedBy: "eszkoz-z")
        XCTAssertEqual(FocusSync.merge(cut, stale).run, cut.run)
        XCTAssertEqual(FocusSync.merge(stale, cut).run, cut.run)
        // A leállítás után a rövidítés előtti változat nem támad fel.
        let stopped = focus(packs: [pack()], run: nil, log: [ended(endedAt: 3_000, plannedEndsAt: 5_000, cuts: 1)], rev: 3, updatedAt: 100)
        XCTAssertNil(FocusSync.merge(stale, stopped, now: 4_000).run)
        XCTAssertNil(FocusSync.merge(stopped, stale, now: 4_000).run)
    }

    func testAnExtensionTheCloserDidNotKnowSurvivesTheClose() {
        let extended = focus(packs: [pack()], run: Focus.Run(packId: "p1", startedAt: 0, endsAt: 20_000), rev: 3, updatedAt: 100)
        let lapsed = focus(packs: [pack()], run: nil, log: [ended(endedAt: 10_000, plannedEndsAt: 10_000, stopped: false)], rev: 8, updatedAt: 100)
        XCTAssertEqual(FocusSync.merge(extended, lapsed, now: 12_000).run?.endsAt, 20_000)
        XCTAssertEqual(FocusSync.merge(lapsed, extended, now: 12_000).run?.endsAt, 20_000)
        let stopped = focus(packs: [pack()], run: nil, log: [ended(endedAt: 15_000, plannedEndsAt: 20_000)], rev: 8, updatedAt: 100)
        XCTAssertNil(FocusSync.merge(extended, stopped, now: 16_000).run)
    }

    func testARowEndingInTheFutureDoesNotCloseTheRun() {
        let running = focus(packs: [pack()], run: Focus.Run(packId: "p1", startedAt: 0, endsAt: 3_600_000), rev: 2, updatedAt: 100)
        let future = focus(packs: [pack()], run: nil, log: [ended(endedAt: 3_600_000, plannedEndsAt: 3_600_000, stopped: false)], rev: 7, updatedAt: 100)
        XCTAssertEqual(FocusSync.merge(running, future, now: 600_000).run, running.run)
        XCTAssertEqual(FocusSync.merge(future, running, now: 600_000).run, running.run)
        XCTAssertNil(FocusSync.merge(running, future, now: 3_600_000 - Focus.futureLogToleranceMs).run)
    }

    func testAShiftedRunIsTheSameRun() {
        let shift: Double = 8 * 3_600_000
        let woke = focus(packs: [pack()], run: Focus.Run(packId: "p1", startedAt: 1_000 + shift, endsAt: 3_001_000 + shift, origin: 1_000), rev: 2, updatedAt: 100)
        let phone = focus(packs: [pack()], run: nil, log: [ended(startedAt: 1_000, endedAt: 3_001_000, plannedEndsAt: 3_001_000, stopped: false)], rev: 3, updatedAt: 100)
        XCTAssertNil(FocusSync.merge(woke, phone, now: 1_000 + shift).run)
        XCTAssertNil(FocusSync.merge(phone, woke, now: 1_000 + shift).run)
        let still = focus(packs: [pack()], run: Focus.Run(packId: "p1", startedAt: 1_000, endsAt: 3_001_000), rev: 3, updatedAt: 100)
        XCTAssertEqual(FocusSync.merge(woke, still).run, woke.run)
        XCTAssertEqual(FocusSync.merge(still, woke).run, woke.run)
    }

    func testAnInflatedDeleteOrWideningDoesNotReachTheRunningPack() {
        let running = focus(
            packs: [Focus.Pack(id: "p1", name: "csomag p1", allowSites: ["quizlet.com", "docs.google.com"], allowApps: ["Word"], defaultMinutes: 50, recurrence: nil)],
            run: Focus.Run(packId: "p1", startedAt: 150, endsAt: 150 + 3_000_000), rev: 3, updatedAt: 100, updatedBy: "gep"
        )
        let deleted = focus(packs: [], rev: 40, updatedAt: 900, updatedBy: "telefon", packMarks: ["p1": 40])
        for (x, y) in [(running, deleted), (deleted, running)] {
            let m = FocusSync.merge(x, y)
            XCTAssertEqual(m.run, running.run)
            XCTAssertEqual(m.packs.map { $0.id }, ["p1"], "a csomagja megvan")
            XCTAssertEqual(m.packMarks, ["p1": 40], "a csomag a törlés jelével él tovább")
        }
        let wider = focus(
            packs: [Focus.Pack(id: "p1", name: "átnevezve", allowSites: ["quizlet.com", "docs.google.com", "youtube.com"], allowApps: ["Word", "Steam"], defaultMinutes: 50, recurrence: nil)],
            rev: 40, updatedAt: 900, updatedBy: "telefon", packMarks: ["p1": 40]
        )
        for (x, y) in [(running, wider), (wider, running)] {
            let m = FocusSync.merge(x, y)
            XCTAssertEqual(m.packs.first?.allowSites, ["quizlet.com", "docs.google.com"], "a youtube nem nyílik meg")
            XCTAssertEqual(m.packs.first?.allowApps, ["Word"], "a Steam sem")
            XCTAssertEqual(m.packs.first?.name, "átnevezve")
        }
    }

    func testExtensionWinsAtSameRevShorteningDoesNot() {
        // A RÖVIDEBB az újabb: az „utolsó író nyer” őt választaná.
        let shorter = focus(packs: [pack()], run: Focus.Run(packId: "p1", startedAt: 0, endsAt: 5_000), rev: 2, updatedAt: 500, updatedBy: "eszkoz-z")
        let longer = focus(packs: [pack()], run: Focus.Run(packId: "p1", startedAt: 0, endsAt: 9_000), rev: 2, updatedAt: 100)
        XCTAssertEqual(FocusSync.merge(shorter, longer).run?.endsAt, 9_000)
        XCTAssertEqual(FocusSync.merge(longer, shorter).run?.endsAt, 9_000)
    }

    func testSameEndTheEarlierStartWinsNotTheFirstToArrive() {
        // A régi „>=” az ELSŐ argumentumot tartotta meg: aki előbb ért a
        // kiszolgálóra, az nyert, és két gép örökké egymást írta felül.
        let early = focus(packs: [pack("p1"), pack("p2")], run: Focus.Run(packId: "p2", startedAt: 0, endsAt: 9_000), rev: 2, updatedAt: 100)
        let late = focus(packs: [pack("p1"), pack("p2")], run: Focus.Run(packId: "p1", startedAt: 1_000, endsAt: 9_000), rev: 2, updatedAt: 500, updatedBy: "eszkoz-z")
        XCTAssertEqual(FocusSync.merge(early, late).run?.packId, "p2")
        XCTAssertEqual(FocusSync.merge(late, early).run?.packId, "p2")

        // Ha a kezdés is egyezik, a kisebb csomagazonosítójú — mindkét sorrendben.
        var sameA = early
        sameA.run = Focus.Run(packId: "p2", startedAt: 0, endsAt: 9_000)
        var sameB = late
        sameB.run = Focus.Run(packId: "p1", startedAt: 0, endsAt: 9_000)
        XCTAssertEqual(FocusSync.merge(sameA, sameB).run?.packId, "p1")
        XCTAssertEqual(FocusSync.merge(sameB, sameA).run?.packId, "p1")
    }

    func testRunIsDroppedWhenItsPackIsGone() {
        let raw = focus(packs: [pack("p1")], run: Focus.Run(packId: "nincs-ilyen", startedAt: 0, endsAt: 9_000), rev: 1, updatedAt: 1)
        XCTAssertNil(FocusSync.normalize(raw, fallbackDevice: "x").run)
        XCTAssertNil(FocusSync.cleanRun(Focus.Run(packId: "p1", startedAt: 0, endsAt: 0), packs: [pack("p1")]), "a nulla lejárat nem menet")
    }

    // MARK: - a csomagok jelei

    func testDesktopWindowSurvivesPhoneStartingARunAtTheSameTime() {
        // A telefon blobja SZÁNDÉKOSAN az újabb (azonos rev, frissebb idő,
        // később rendezett azonosító): az „utolsó író nyer” őt választaná.
        let desktop = focus(packs: [pack("p1", recurrence: win)], rev: 6, updatedAt: 100, updatedBy: "gep", packMarks: ["p1": 6])
        let phone = focus(packs: [pack("p1")], run: Focus.Run(packId: "p1", startedAt: 150, endsAt: 150 + 3_000_000), rev: 6, updatedAt: 200, updatedBy: "telefon")
        for (x, y) in [(desktop, phone), (phone, desktop)] {
            let m = FocusSync.merge(x, y)
            XCTAssertEqual(m.packs.map { $0.id }, ["p1"])
            XCTAssertEqual(m.packs.first?.recurrence, win, "az ablak marad")
            XCTAssertNotNil(m.run, "a telefon menete is marad")
            XCTAssertEqual(m.packMarks, ["p1": 6])
        }
    }

    func testDeletionMarkBeatsOlderListWithoutMarksNewerBlobDecides() {
        let deleted = focus(packs: [pack("p2")], rev: 7, updatedAt: 100, packMarks: ["p1": 7])
        let stale = focus(packs: [pack("p1"), pack("p2")], rev: 6, updatedAt: 50, updatedBy: "telefon")
        XCTAssertEqual(FocusSync.merge(stale, deleted).packs.map { $0.id }, ["p2"])
        XCTAssertEqual(FocusSync.merge(deleted, stale).packMarks, ["p1": 7], "a sírkő utazik tovább")

        let newer = focus(packs: [pack("p2")], rev: 7, updatedAt: 100)
        let older = focus(packs: [pack("p1"), pack("p2")], rev: 6, updatedAt: 50, updatedBy: "telefon")
        let m = FocusSync.merge(older, newer)
        XCTAssertEqual(m.packs.map { $0.id }, ["p2"], "jel nélkül az újabb blob listája")
        XCTAssertNil(m.packMarks, "jel nélkül nem keletkezik jel")
    }

    func testReaddedWithHigherMarkBeatsTombstoneOlderOnlyPackGoesLast() {
        let readded = focus(packs: [pack("p1", name: "új")], rev: 9, updatedAt: 300, packMarks: ["p1": 9])
        let tomb = focus(packs: [pack("p3")], rev: 8, updatedAt: 200, updatedBy: "telefon", packMarks: ["p1": 7, "p3": 8])
        let m = FocusSync.merge(tomb, readded)
        XCTAssertEqual(m.packs.map { $0.id }, ["p1", "p3"])
        XCTAssertEqual(m.packs.first?.name, "új")
        XCTAssertEqual(m.packMarks, ["p1": 9, "p3": 8])
    }

    func testEqualMarksPresenceWinsAndBothPresentContentDecides() {
        // Egyenlő pozitív jel: a jelenlét nyer, sorrendtől függetlenül — és ha
        // mindkét oldalon megvan, az ablakos változat.
        let with = focus(packs: [pack("p1", recurrence: win)], rev: 5, updatedAt: 100, packMarks: ["p1": 5])
        let without = focus(packs: [], rev: 5, updatedAt: 200, updatedBy: "telefon", packMarks: ["p1": 5])
        XCTAssertEqual(FocusSync.merge(with, without).packs.map { $0.id }, ["p1"])
        XCTAssertEqual(FocusSync.merge(without, with).packs.map { $0.id }, ["p1"])

        let plain = focus(packs: [pack("p1")], rev: 5, updatedAt: 300, updatedBy: "telefon", packMarks: ["p1": 5])
        XCTAssertNotNil(FocusSync.merge(plain, with).packs.first?.recurrence)
        XCTAssertNotNil(FocusSync.merge(with, plain).packs.first?.recurrence)
    }

    func testDeletionMarkLeavesNoRunWithoutItsPack() {
        // A gép törölte a csomagot (jellel), a telefon ugyanabban a körben
        // menetet indított rá. A menet a szigorúbb: a csomagja marad, a törlés
        // jele is. Csomag nélküli menet nem születik.
        let deleted = focus(packs: [pack("p2")], rev: 7, updatedAt: 100, updatedBy: "gep", packMarks: ["p1": 7])
        let running = focus(packs: [pack("p1"), pack("p2")], run: Focus.Run(packId: "p1", startedAt: 150, endsAt: 150 + 3_000_000), rev: 7, updatedAt: 200, updatedBy: "telefon")
        for (x, y) in [(deleted, running), (running, deleted)] {
            let m = FocusSync.merge(x, y)
            XCTAssertEqual(m.packs.map { $0.id }.sorted(), ["p1", "p2"])
            XCTAssertEqual(m.run?.packId, "p1")
            XCTAssertEqual(m.packMarks?["p1"], 7)
        }
        // A menet LEÁLLÍTÁSA után jött törlés (a leállítás naplósorával): a
        // menet is elveszett, és vele a csomag — nincs csomag nélküli menet.
        var stopped = deleted
        stopped.rev = 8
        stopped.packMarks = ["p1": 8]
        stopped.log = [ended(startedAt: 150, endedAt: 160, plannedEndsAt: 150 + 3_000_000)]
        let m = FocusSync.merge(running, stopped)
        XCTAssertNil(m.run)
        XCTAssertEqual(m.packs.map { $0.id }, ["p2"])
    }

    func testMarkCapIsOneRulePresentPacksKeepTheirMark() {
        var marks: [String: Int] = ["p-jelen": 3]
        for i in 0..<300 { marks[String(format: "t%03d", i)] = 100 + (i % 7) }
        let capped = FocusSync.capPackMarks(marks, ["p-jelen"])!
        XCTAssertEqual(capped.count, FocusSync.maxPackMarks)
        XCTAssertEqual(capped["p-jelen"], 3, "a jelen lévő csomag jele bent marad, pedig a legkisebb")
        let gone = capped.filter { $0.key != "p-jelen" }.map { $0.value }
        XCTAssertEqual(gone.count, FocusSync.maxPackMarks - 1)
        XCTAssertTrue(gone.allSatisfy { $0 > 100 }, "a legrégebbi (100-as) jelekből estek ki")
        XCTAssertNil(FocusSync.capPackMarks([:], []))
        // A bemenet is ezzel a plafonnal tisztít, és a rev fölötti jelet eldobja.
        let raw = focus(packs: [pack("p-jelen")], rev: 150, updatedAt: 1, packMarks: marks)
        let n = FocusSync.normalize(raw, fallbackDevice: "x")
        XCTAssertEqual(n.packMarks?["p-jelen"], 3)
        XCTAssertLessThanOrEqual(n.packMarks?.count ?? 0, FocusSync.maxPackMarks)
        let tooHigh = focus(packs: [pack("p1")], rev: 3, updatedAt: 1, packMarks: ["p1": 9, "p2": 2])
        XCTAssertEqual(FocusSync.normalize(tooHigh, fallbackDevice: "x").packMarks, ["p2": 2], "a rev fölötti jel kiesik")
    }

    func testRealMarkBeatsARunStartTheDesktopEditSurvives() {
        // A gép rev 6-on bővítette az ablakot (jel 6); a telefon ugyanabban a
        // körben — a régi változattal — menetet indított. A VÁLTOZAT a jelé (az
        // ablak felvétele szigorítás, a menet alatt is átmegy). A menet is marad.
        let wide = ScheduleLogic.Band(days: [1, 2, 3, 4, 5], startMin: 540, endMin: 780)
        let desktop = focus(packs: [pack("p1", recurrence: wide)], rev: 6, updatedAt: 100, updatedBy: "gep", packMarks: ["p1": 6])
        let phone = focus(packs: [pack("p1", recurrence: win)], run: Focus.Run(packId: "p1", startedAt: 150, endsAt: 150 + 3_000_000), rev: 6, updatedAt: 200, updatedBy: "telefon")
        for (x, y) in [(desktop, phone), (phone, desktop)] {
            let m = FocusSync.merge(x, y)
            XCTAssertEqual(m.packs.first?.recurrence, wide, "a gép bővített ablaka marad")
            XCTAssertEqual(m.run?.packId, "p1", "a telefon menete is marad")
            XCTAssertEqual(m.packMarks, ["p1": 6])
        }
    }

    func testThePackCapKeepsTheRunsPackAndMarkedPacks() {
        let full = (0..<30).map { pack(String(format: "f%02d", $0)) }
        let newer = focus(packs: full, rev: 6, updatedAt: 200, updatedBy: "telefon")
        let older = focus(packs: Array(full.prefix(29)) + [pack("q")], run: Focus.Run(packId: "q", startedAt: 10, endsAt: 600_010), rev: 6, updatedAt: 100, updatedBy: "gep")
        for (x, y) in [(newer, older), (older, newer)] {
            let m = FocusSync.merge(x, y)
            XCTAssertEqual(m.packs.count, 30)
            XCTAssertEqual(m.run?.packId, "q")
            XCTAssertTrue(m.packs.contains { $0.id == "q" }, "a menet csomagja a listán van")
        }
        let marked = focus(packs: Array(full.prefix(29)) + [pack("w", recurrence: win)], rev: 7, updatedAt: 300, updatedBy: "gep", packMarks: ["w": 7])
        let stale = focus(packs: full, rev: 6, updatedAt: 100, updatedBy: "telefon")
        XCTAssertTrue(FocusSync.merge(stale, marked).packs.contains { $0.id == "w" }, "a jeles ablak marad")
    }

    func testIdenticalKeyDifferentContentTheContentDecidesInBothOrders() {
        let x = focus(packs: [pack("p1", name: "X")], rev: 3, updatedAt: 100, updatedBy: "gep")
        let y = focus(packs: [pack("p1", name: "Y")], rev: 3, updatedAt: 100, updatedBy: "gep")
        XCTAssertEqual(FocusSync.merge(x, y).packs.first?.name, FocusSync.merge(y, x).packs.first?.name)
        XCTAssertTrue(FocusSync.same(FocusSync.merge(x, y), FocusSync.merge(y, x)))
    }

    func testNormalizeDropsTheMarkOfAPackThatFellOutButKeepsRealTombstones() {
        // Egy üres nevű csomag kiesik a normalizálásban — a jele is, különben
        // a jel meg a hiánya együtt sírkő lenne, és a csomag mindenhol
        // törlődne. A valódi törlés jele (nincs ilyen csomag a listán) marad.
        let raw = focus(packs: [pack("p1", name: "   "), pack("p2")], rev: 5, updatedAt: 1, packMarks: ["p1": 3, "p3": 2])
        let n = FocusSync.normalize(raw, fallbackDevice: "x")
        XCTAssertEqual(n.packs.map { $0.id }, ["p2"])
        XCTAssertEqual(n.packMarks, ["p3": 2])
    }

    func testNormalizeKeepsOnlyRealMarksAndSameSeesThem() {
        let raw = focus(packs: [pack("p1")], rev: 3, updatedAt: 1, updatedBy: "gep", packMarks: ["p1": 3, "": 2, "p9": -1])
        let n = FocusSync.normalize(raw, fallbackDevice: "x")
        XCTAssertEqual(n.packMarks, ["p1": 3])
        var empty = raw
        empty.packMarks = [:]
        XCTAssertNil(FocusSync.normalize(empty, fallbackDevice: "x").packMarks)
        var unmarked = n
        unmarked.packMarks = nil
        XCTAssertFalse(FocusSync.same(n, unmarked), "a jelek különbsége feltöltést ér")
    }

    // MARK: - a napló

    private func entry(_ packId: String, startedAt: Double, endedAt: Double, planned: Double, stopped: Bool) -> Focus.LogEntry {
        Focus.LogEntry(packId: packId, packName: "csomag \(packId)", startedAt: startedAt, endedAt: endedAt, plannedEndsAt: planned, stopped: stopped)
    }

    func testLogIsUnitedNoRowIsLost() {
        let a = focus(packs: [pack()], log: [entry("p1", startedAt: 0, endedAt: 1_000, planned: 1_000, stopped: false)], rev: 3, updatedAt: 100)
        let b = focus(packs: [pack()], log: [entry("p1", startedAt: 5_000, endedAt: 6_000, planned: 6_000, stopped: false)], rev: 3, updatedAt: 200, updatedBy: "b")
        XCTAssertEqual(FocusSync.merge(a, b).log.count, 2)
        XCTAssertEqual(FocusSync.merge(b, a).log.map { $0.startedAt }, [0, 5_000], "idősorrend, sorrendtől függetlenül")
    }

    func testSameSessionClosedTwiceIsOneRowWithTheEarlierEnd() {
        let phone = focus(packs: [pack()], log: [entry("p1", startedAt: 0, endedAt: 1_000, planned: 3_000, stopped: true)], rev: 3, updatedAt: 100)
        let desktop = focus(packs: [pack()], log: [entry("p1", startedAt: 0, endedAt: 3_000, planned: 3_000, stopped: false)], rev: 3, updatedAt: 200, updatedBy: "b")
        for (x, y) in [(phone, desktop), (desktop, phone)] {
            let log = FocusSync.merge(x, y).log
            XCTAssertEqual(log.count, 1)
            XCTAssertEqual(log.first?.endedAt, 1_000)
            XCTAssertEqual(log.first?.stopped, true)
        }
    }

    func testLogCannotStopARunningSession() {
        // EZ A LÉNYEG. Ha a napló a `rev`-hez lenne kötve, egy statisztika-sor
        // léptetné a számlálót, a nagyobb `rev` pedig azt jelentené, hogy annak
        // az eszköznek a „nem fut” állapota nyer — vagyis egy naplósorral ki
        // lehetne kapcsolni a másik gépen futó menetet, próbatétel nélkül. (A
        // menet SAJÁT leállítás-sora más: az a leállítás nyoma, az leállítja —
        // lásd fent.)
        let running = focus(packs: [pack()], run: Focus.Run(packId: "p1", startedAt: 0, endsAt: 10_000), rev: 4, updatedAt: 100)
        let manyRows = focus(
            packs: [pack()],
            log: (0..<20).map { i in entry("p1", startedAt: Double(i * 100), endedAt: Double(i * 100 + 50), planned: 4_000, stopped: false) },
            rev: 4, updatedAt: 900, updatedBy: "b"
        )
        XCTAssertNotNil(FocusSync.merge(running, manyRows).run, "a napló nem engedély")
        XCTAssertNotNil(FocusSync.merge(manyRows, running).run, "sorrendtől függetlenül")
    }

    func testLogCapDropsTheOldestRows() {
        var rows: [Focus.LogEntry] = []
        for i in 0..<(Focus.maxFocusLog + 20) {
            rows.append(entry("p1", startedAt: Double(i * 10), endedAt: Double(i * 10 + 5), planned: Double(i * 10 + 5), stopped: false))
        }
        let capped = FocusSync.capLog(rows)
        XCTAssertEqual(capped.count, Focus.maxFocusLog)
        XCTAssertEqual(capped.first?.startedAt, 200, "a legrégebbi húsz esett ki")
    }

    func testMergeIsDeterministicAndIdempotent() {
        let a = focus(packs: [pack("p1")], rev: 3, updatedAt: 100, updatedBy: "a")
        let b = focus(packs: [pack("p2")], rev: 3, updatedAt: 100, updatedBy: "b")
        XCTAssertTrue(FocusSync.same(FocusSync.merge(a, b), FocusSync.merge(b, a)))
        let once = FocusSync.merge(a, b)
        XCTAssertTrue(FocusSync.same(FocusSync.merge(once, b), once))
    }
}
