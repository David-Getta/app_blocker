import Foundation
import XCTest
@testable import BreakerShared

// A heti visszatekintés magja a Swift tükrön — a desktop/test/digest.test.ts
// és az androidos DigestTest esetei: a három mag ugyanazt a mondatot adja.
final class DigestTests: XCTestCase {

    private func at(_ y: Int, _ mo: Int, _ d: Int, _ h: Int, _ mi: Int = 0) -> Double {
        let date = Calendar.current.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi))!
        return date.timeIntervalSince1970 * 1000
    }

    /// 2026. szeptember 7. hétfő.
    private let monday = "2026-09-07"

    func testWeekKeyIsTheMondayAndSundayStillBelongsToThePreviousWeek() {
        XCTAssertEqual(DigestLogic.weekKey(at(2026, 9, 7, 0)), monday, "hétfő hajnal")
        XCTAssertEqual(DigestLogic.weekKey(at(2026, 9, 10, 15)), monday, "csütörtök")
        XCTAssertEqual(DigestLogic.weekKey(at(2026, 9, 13, 23, 59)), monday, "vasárnap este")
        XCTAssertEqual(DigestLogic.weekKey(at(2026, 9, 6, 12)), "2026-08-31", "vasárnap: az előző hét")
        XCTAssertEqual(DigestLogic.weekKey(at(2026, 9, 14, 0)), "2026-09-14", "a következő hétfő")
    }

    func testDueFromMondayMorningOncePerWeek() {
        let h = DigestLogic.digestHour
        XCTAssertNil(DigestLogic.due(nil, now: at(2026, 9, 7, h - 1, 59)), "hétfő 6:59: még nem")
        XCTAssertEqual(DigestLogic.due(nil, now: at(2026, 9, 7, h)), monday, "hétfő 7:00: igen")
        XCTAssertEqual(DigestLogic.due("2026-08-31", now: at(2026, 9, 9, 10)), monday, "szerdán is, ha hétfőn nem volt nyitva")
        XCTAssertNil(DigestLogic.due(monday, now: at(2026, 9, 9, 10)), "ezen a héten már volt")
        XCTAssertEqual(DigestLogic.due(monday, now: at(2026, 9, 14, 8)), "2026-09-14", "a következő hétfőn újra")
        XCTAssertNil(DigestLogic.due(monday, now: at(2026, 9, 14, 3)), "de csak reggel héttől")
    }

    func testHmLikeTheTiles() {
        XCTAssertEqual(DigestLogic.hm(58 * 60), "58 p")
        XCTAssertEqual(DigestLogic.hm(3600 + 28 * 60), "1 ó 28 p")
        XCTAssertEqual(DigestLogic.hm(7 * 3600 + 20 * 60), "7 ó 20 p")
        XCTAssertEqual(DigestLogic.hm(0), "0 p")
    }

    private var full: DigestLogic.Input {
        DigestLogic.Input(
            last7Seconds: 7 * 3600 + 20 * 60,
            topWeekSites: [.init(label: "youtube.com", seconds: 2 * 3600 + 40 * 60)],
            weekOverWeek: [.init(label: "youtube.com", deltaPct: -33)],
            focusWeek: Focus.Summary(sessions: 9, totalMs: 7 * 3_600_000, stoppedEarly: 2, topPack: "Nyelvtanulás"),
            unlocks7d: 3,
            daysTracked: 12
        )
    }

    func testWindowRunsAreInTheSentenceZeroIsNotASentence() {
        var w = full
        w.focusWeek = Focus.Summary(sessions: 9, totalMs: 7 * 3_600_000, stoppedEarly: 2, topPack: "Nyelvtanulás", windowRuns: 3)
        XCTAssertEqual(
            DigestLogic.text(w) { $0 },
            "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). "
                + "9 menet (7 ó 0 p, 2 korán leállítva, 3 ablakból). 3 feloldás."
        )
    }

    func testDroppedAttemptsAreInTheSentenceBesideOrInsteadOfUnlocks() {
        var withDropped = full
        withDropped.dropped7d = 2
        XCTAssertEqual(
            DigestLogic.text(withDropped) { $0 },
            "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). "
                + "9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás, 2 félbemaradt kísérlet."
        )
        var none = full
        none.unlocks7d = 0
        none.dropped7d = 1
        none.weekOverWeek = []
        let noneText = DigestLogic.text(none) { $0 } ?? ""
        XCTAssertTrue(noneText.hasSuffix("Feloldás nélkül, 1 félbemaradt kísérlet."), noneText)
        // Csak félbemaradt kísérlet: az is történés — mondat, még mérés és menet nélkül is.
        let only = DigestLogic.Input(
            focusWeek: Focus.Summary(sessions: 0, totalMs: 0, stoppedEarly: 0, topPack: nil), unlocks7d: 0, dropped7d: 3
        )
        XCTAssertEqual(DigestLogic.text(only) { $0 }, "Elmúlt 7 nap: Feloldás nélkül, 3 félbemaradt kísérlet.")
        XCTAssertEqual(DigestLogic.text(full) { $0 }, DigestLogic.text(withDropped.withDropped(0)) { $0 }, "nulla: mint eddig")
    }

    func testTheDaysTheBudgetFilledAreInTheSentenceAndZeroIsNot() {
        var withLimit = full
        withLimit.limitFullDays = 3
        XCTAssertEqual(
            DigestLogic.text(withLimit) { $0 },
            "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). "
                + "9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás. A napi keret 3 napon betelt."
        )
        var zero = full
        zero.limitFullDays = 0
        XCTAssertEqual(DigestLogic.text(zero) { $0 }, DigestLogic.text(full) { $0 }, "nulla nap nem mondat")
        var withBurst = full
        withBurst.burstTripsWeek = 7
        XCTAssertEqual(
            DigestLogic.text(withBurst) { $0 },
            "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). "
                + "9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás. Az adag a héten 7× telt be."
        )
    }

    func testTheFullSentence() {
        XCTAssertEqual(
            DigestLogic.text(full) { $0 },
            "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). "
                + "9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás."
        )
    }

    func testTheAppIsNamedTooBecauseItIsInTheMeasuredTime() {
        var withApp = full
        withApp.topWeekApps = [.init(label: "Slack", seconds: 3 * 3600 + 10 * 60), .init(label: "Terminal", seconds: 3600)]
        withApp.weekOverWeek.append(.init(label: "Slack", deltaPct: 41.6))
        XCTAssertEqual(
            DigestLogic.text(withApp) { $0 },
            "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest); "
                + "appban a legtöbb: Slack 3 ó 10 p (▲ +42% az előző héthez képest). "
                + "9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás."
        )
    }

    func testTheLabelBelongsToTheUI() {
        let text = DigestLogic.text(full) { $0 == "youtube.com" ? "A videós" : $0 }!
        XCTAssertTrue(text.contains("a legtöbb: A videós"), text)
        XCTAssertFalse(text.contains("youtube.com"), "a valódi cím sehol")
    }

    func testWithoutUnlocksAndWithoutMeasurement() {
        var noUnlock = full
        noUnlock.unlocks7d = 0
        noUnlock.focusWeek = Focus.Summary(sessions: 4, totalMs: 3_600_000, stoppedEarly: 0, topPack: nil)
        noUnlock.weekOverWeek = [.init(label: "youtube.com", deltaPct: 3)]
        XCTAssertEqual(
            DigestLogic.text(noUnlock) { $0 },
            "Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p. 4 menet (1 ó 0 p, mind végigvive). Feloldás nélkül."
        )
        // Mérés nélkül — ez az iPhone esete — a menetek és a feloldások még mondat.
        var noUsage = full
        noUsage.last7Seconds = 0; noUsage.topWeekSites = []; noUsage.weekOverWeek = []; noUsage.daysTracked = 0
        XCTAssertEqual(DigestLogic.text(noUsage) { $0 }, "Elmúlt 7 nap: 9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás.")
        var nothing = noUsage
        nothing.unlocks7d = 0
        nothing.focusWeek = Focus.Summary(sessions: 0, totalMs: 0, stoppedEarly: 0, topPack: nil)
        XCTAssertNil(DigestLogic.text(nothing) { $0 }, "egy üres sor zaj lenne")
        // Mérés nélkül a javaslat sem ül rá az üres hétre.
        nothing.unblockedTop = [.init(label: "x.com", seconds: 9000)]
        XCTAssertNil(DigestLogic.text(nothing) { $0 })
    }

    func testTheUnblockedTopIsNamedOnlyTheBiggest() {
        var withOpen = full
        withOpen.unblockedTop = [.init(label: "news.ycombinator.com", seconds: 2 * 3600 + 120), .init(label: "github.com", seconds: 1800)]
        let text = DigestLogic.text(withOpen) { $0 }!
        XCTAssertTrue(text.hasSuffix("Nincs tiltva, de sokat vitt: news.ycombinator.com 2 ó 2 p."), text)
        XCTAssertFalse(text.contains("github.com"))
    }

    func testInputFromStateUsesTheRollingWeek() {
        let now = at(2026, 9, 7, 8)
        let day = 86_400_000.0
        var st = AppState()
        st.unlockLog = [now - 2 * day, now - 20 * day]
        // A félbemaradt kísérletek ugyanezzel az ablakkal: a húsz napos nem az elmúlt hété.
        st.droppedAttempts = [now - 3 * day, now - 20 * day]
        st.focusLog = [
            Focus.LogEntry(packId: "p", packName: "Nyelvtanulás", startedAt: now - 3 * day, endedAt: now - 3 * day + 3_600_000, plannedEndsAt: now - 3 * day + 3_600_000, stopped: false),
            Focus.LogEntry(packId: "p", packName: "Nyelvtanulás", startedAt: now - 30 * day, endedAt: now - 30 * day + 3_600_000, plannedEndsAt: now - 30 * day + 3_600_000, stopped: false),
        ]
        let input = DigestLogic.inputFor(st, now: now)
        XCTAssertEqual(input.unlocks7d, 1, "a húsz napos feloldás nem az elmúlt hété")
        XCTAssertEqual(input.focusWeek.sessions, 1, "a harminc napos menet nem az elmúlt hété")
        XCTAssertEqual(input.dropped7d, 1, "a húsz napos félbemaradt kísérlet sem az elmúlt hété")
        XCTAssertEqual(DigestLogic.text(input) { $0 },
                       "Elmúlt 7 nap: 1 menet (1 ó 0 p, mind végigvive). 1 feloldás, 1 félbemaradt kísérlet.")
    }

    func testJournalOneRowPerWeekNewestFirstHalfAYearCap() {
        var log: [DigestLogic.Entry] = []
        log = DigestLogic.record(log, week: "2026-08-31", text: "Elmúlt 7 nap: 5 ó 0 p mért idő.")
        log = DigestLogic.record(log, week: "2026-09-07", text: "Elmúlt 7 nap: 7 ó 20 p mért idő.")
        XCTAssertEqual(log.map(\.week), ["2026-09-07", "2026-08-31"], "a legfrissebb elöl")
        log = DigestLogic.record(log, week: "2026-09-07", text: "Elmúlt 7 nap: 8 ó 0 p mért idő.")
        XCTAssertEqual(log.count, 2)
        XCTAssertEqual(log[0].text, "Elmúlt 7 nap: 8 ó 0 p mért idő.")
        log = DigestLogic.record(log, week: "2026-09-07", text: nil)
        XCTAssertEqual(log.map(\.week), ["2026-08-31"], "az üres hét a régi sort is elviszi")
        for i in 0..<(DigestLogic.maxDigestLog + 5) {
            log = DigestLogic.record(log, week: DigestLogic.weekKey(at(2027, 1, 4 + 7 * i, 12)), text: "hét \(i)")
        }
        XCTAssertEqual(log.count, DigestLogic.maxDigestLog)
        XCTAssertEqual(log[0].text, "hét \(DigestLogic.maxDigestLog + 4)")
        XCTAssertFalse(log.contains { $0.week == "2026-08-31" })
    }

    func testJournalFromStorageIsCleaned() {
        let junk = [
            DigestLogic.Entry(week: "2026-9-7", text: "rossz kulcs"), .init(week: "2026-09-07", text: "   "),
            .init(week: "2026-09-07", text: "első"), .init(week: "2026-09-07", text: "utolsó"),
            .init(week: "2026-08-31", text: String(repeating: "x", count: 900)),
        ]
        let log = DigestLogic.clean(junk)
        XCTAssertEqual(log.map(\.week), ["2026-09-07", "2026-08-31"])
        XCTAssertEqual(log[0].text, "utolsó")
        XCTAssertEqual(log[1].text.count, 500)
        XCTAssertEqual(DigestLogic.weekLabel("2026-09-07"), "2026. 09. 07.")
    }

    func testRelabelAppliesTodaysLabelsToOldRows() {
        let text = "Elmúlt 7 nap: 7 ó mért idő; a legtöbb: youtube.com 2 ó 40 p. Nincs tiltva, de sokat vitt: m.youtube.com 1 ó; youtu.be 5 p; notyoutube.com 3 p; github.com 2 p."
        let sites: [(domain: String, hostnames: [String])] = [
            (domain: "youtube.com", hostnames: ["youtube.com", "m.youtube.com", "youtu.be"]),
            (domain: "github.com", hostnames: ["github.com"]),
        ]
        XCTAssertEqual(
            DigestLogic.relabel(text, sites: sites) { $0 == "youtube.com" ? "A videós" : $0 },
            "Elmúlt 7 nap: 7 ó mért idő; a legtöbb: A videós 2 ó 40 p. Nincs tiltva, de sokat vitt: A videós 1 ó; A videós 5 p; notyoutube.com 3 p; github.com 2 p."
        )
        // A „notyoutube.com” nem a youtube.com aloldala — az marad; a listázottak sorszámot kapnak.
        let hidden = DigestLogic.relabel(text, sites: sites) { d in
            "\(sites.firstIndex(where: { $0.domain == d })! + 1). rejtett oldal"
        }
        XCTAssertEqual(
            hidden,
            "Elmúlt 7 nap: 7 ó mért idő; a legtöbb: 1. rejtett oldal 2 ó 40 p. Nincs tiltva, de sokat vitt: 1. rejtett oldal 1 ó; 1. rejtett oldal 5 p; notyoutube.com 3 p; 2. rejtett oldal 2 p."
        )
        XCTAssertEqual(DigestLogic.relabel(text, sites: sites) { $0 }, text, "címke nélkül a sor változatlan")
    }
}

private extension DigestLogic.Input {
    func withDropped(_ n: Int) -> DigestLogic.Input {
        var copy = self
        copy.dropped7d = n
        return copy
    }

    func testThePreviousWeekBesideTheSessionsDirectionNotJudgementAnEmptyPreviousWeekIsNoLine() {
        let week = Focus.Summary(sessions: 9, totalMs: 7 * 3_600_000, stoppedEarly: 2, topPack: "Nyelvtanulás")
        let none = Focus.Summary(sessions: 0, totalMs: 0, stoppedEarly: 0, topPack: nil)
        let prev = Focus.Summary(sessions: 5, totalMs: 3 * 3_600_000 + 10 * 60_000, stoppedEarly: 1, topPack: nil)
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: week, unlocks7d: 3, focusPrevWeek: prev), labelOf: { $0 }),
                       "Elmúlt 7 nap: 9 menet (7 ó 0 p, 2 korán leállítva), az előző héten 5 (3 ó 10 p). 3 feloldás.")
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: none, unlocks7d: 3, focusPrevWeek: prev), labelOf: { $0 }),
                       "Elmúlt 7 nap: Menet nélkül, az előző héten 5 (3 ó 10 p). 3 feloldás.")
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: week, unlocks7d: 3, focusPrevWeek: none), labelOf: { $0 }),
                       DigestLogic.text(DigestLogic.Input(focusWeek: week, unlocks7d: 3), labelOf: { $0 }), "üres előző hét: a régi mondat")
    }

    func testThePreviousWeeksUnlocksBesideTheNumberDirectionNotJudgementAndNoUnlockIsStillALineIfThereWasSomethingToMeasureAgainst() {
        let week = Focus.Summary(sessions: 9, totalMs: 7 * 3_600_000, stoppedEarly: 2, topPack: "Nyelvtanulás")
        let none = Focus.Summary(sessions: 0, totalMs: 0, stoppedEarly: 0, topPack: nil)
        let head = "Elmúlt 7 nap: 9 menet (7 ó 0 p, 2 korán leállítva). "
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: week, unlocks7d: 3, unlocksPrev7d: 5), labelOf: { $0 }),
                       "\(head)3 feloldás (az előző héten 5).")
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: week, unlocks7d: 3, dropped7d: 2, unlocksPrev7d: 5), labelOf: { $0 }),
                       "\(head)3 feloldás (az előző héten 5), 2 félbemaradt kísérlet.")
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: week, unlocks7d: 0, unlocksPrev7d: 5), labelOf: { $0 }),
                       "\(head)Feloldás nélkül (az előző héten 5).")
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: week, unlocks7d: 0, dropped7d: 1, unlocksPrev7d: 5), labelOf: { $0 }),
                       "\(head)Feloldás nélkül (az előző héten 5), 1 félbemaradt kísérlet.")
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: week, unlocks7d: 3, unlocksPrev7d: 0), labelOf: { $0 }),
                       DigestLogic.text(DigestLogic.Input(focusWeek: week, unlocks7d: 3), labelOf: { $0 }), "üres előző hét: a régi mondat")
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: none, unlocks7d: 0, unlocksPrev7d: 2), labelOf: { $0 }),
                       "Elmúlt 7 nap: Feloldás nélkül (az előző héten 2).", "mérés és menet nélkül is mondat, ha az előző héten volt feloldás")
        XCTAssertNil(DigestLogic.text(DigestLogic.Input(focusWeek: none, unlocks7d: 0), labelOf: { $0 }))
    }
}
