import Foundation
import XCTest
@testable import BreakerShared

// A szűrő megakadásai a Swift-tükrön — az androidos FilterHitsTest esetei:
// hosztonként két percen belül egyszer; a könyv naponként, harminc napig; az
// elmúlt hét; a mondat; a mentés.
final class FilterHitsTests: XCTestCase {

    private var now: Double {
        let d = Calendar.current.date(from: DateComponents(year: 2026, month: 9, day: 18, hour: 12))!
        return d.timeIntervalSince1970 * 1000
    }
    private var today: String { FilterHitLogic.dayKey(now) }

    func testOnePerHostWithinTwoMinutes() {
        var seen: [String: Double] = [:]
        XCTAssertTrue(FilterHitLogic.shouldCount(&seen, "youtube.com", now: now))
        XCTAssertFalse(FilterHitLogic.shouldCount(&seen, "YouTube.com.", now: now + 1000), "ugyanaz a hoszt, egy percen belül")
        XCTAssertTrue(FilterHitLogic.shouldCount(&seen, "reddit.com", now: now + 1000), "másik hoszt: másik megakadás")
        XCTAssertFalse(FilterHitLogic.shouldCount(&seen, "youtube.com", now: now + FilterHitLogic.dedupeMs - 1))
        XCTAssertTrue(FilterHitLogic.shouldCount(&seen, "youtube.com", now: now + FilterHitLogic.dedupeMs), "két perc után újra")
        XCTAssertFalse(FilterHitLogic.shouldCount(&seen, "  ", now: now), "üres név nem hoszt")
        for i in 0..<600 { _ = FilterHitLogic.shouldCount(&seen, "h\(i).example", now: now + 2 * FilterHitLogic.dedupeMs) }
        XCTAssertLessThanOrEqual(seen.count, 600)
    }

    func testTheBookIsPerDaySweptCappedAndTheFutureIsNotADay() {
        var days = FilterHitLogic.record([:], day: today)
        days = FilterHitLogic.record(days, day: today)
        days = FilterHitLogic.record(days, day: "nem nap")
        XCTAssertEqual(days, [today: 2])
        for i in 1...40 { days = FilterHitLogic.record(days, day: FilterHitLogic.dayKey(now - Double(i) * 86_400_000)) }
        XCTAssertEqual(FilterHitLogic.sweep(days, today: today).count, FilterHitLogic.retentionDays)
        let future = FilterHitLogic.record(days, day: "2099-01-01")
        XCTAssertNil(FilterHitLogic.sweep(future, today: today)["2099-01-01"], "a jövő elállított óra")
        let full = [today: FilterHitLogic.maxPerDay]
        XCTAssertEqual(FilterHitLogic.record(full, day: today), full, "a napi plafon fölött nem nő")
        XCTAssertEqual(FilterHitLogic.clean([today: 3, "x": 5, "2026-09-17": 0, "2026-09-16": -1]), [today: 3])
    }

    func testTheLastSevenDaysAndToday() {
        let days = [
            today: 2,
            FilterHitLogic.dayKey(now - 6 * 86_400_000): 3,
            FilterHitLogic.dayKey(now - 7 * 86_400_000): 9,
        ]
        XCTAssertEqual(FilterHitLogic.hits7d(days, now: now), 5, "a hetedik nap benne, a nyolcadik nem")
        XCTAssertEqual(FilterHitLogic.hitsToday(days, now: now), 2)
        XCTAssertEqual(FilterHitLogic.hits7d([:], now: now), 0)
    }

    func testTheShapeOfTheWeek() {
        let days = [today: 2, FilterHitLogic.dayKey(now - 6 * 86_400_000): 3, FilterHitLogic.dayKey(now - 7 * 86_400_000): 9]
        let series = FilterHitLogic.daySeries(days, now: now, count: 7)
        XCTAssertEqual(series.count, 7)
        XCTAssertEqual(series.first?.day, FilterHitLogic.dayKey(now - 6 * 86_400_000))
        XCTAssertEqual(series.last?.day, today)
        XCTAssertEqual(series.map { $0.seconds }, [3, 0, 0, 0, 0, 0, 2], "a nyolcadik nap már nem a hété")
    }

    func testHourlyThePeakOfTheWeekAndTheSave() throws {
        var hours = FilterHitLogic.recordHour([:], day: today, hour: 21)
        hours = FilterHitLogic.recordHour(hours, day: today, hour: 21)
        let yesterday = FilterHitLogic.dayKey(now - 86_400_000)
        hours = FilterHitLogic.recordHour(hours, day: yesterday, hour: 9)
        hours = FilterHitLogic.recordHour(hours, day: yesterday, hour: 9)
        hours = FilterHitLogic.recordHour(hours, day: FilterHitLogic.dayKey(now - 8 * 86_400_000), hour: 9) // nem a hété
        hours = FilterHitLogic.recordHour(hours, day: today, hour: 99) // rossz óra: változatlan
        XCTAssertEqual(hours[today]?[21], 2)
        let peak = FilterHitLogic.peakHour(hours, now: now)
        XCTAssertEqual(peak?.hour, 9, "holtverseny: a korábbi óra")
        XCTAssertEqual(peak?.count, 2)
        XCTAssertNil(FilterHitLogic.peakHour([:], now: now))
        XCTAssertEqual(FilterHitLogic.hourLabel(23), "23–0 óra")
        XCTAssertEqual(FilterHitLogic.cleanHours([today: hours[today]!, "x": Array(repeating: 1, count: 24), "2026-09-17": [1, 2]]),
                       [today: hours[today]!])
        XCTAssertEqual(FilterHitLogic.hourOf(now), 12)
        var st = AppState()
        st.filterHitHours = [today: hours[today]!]
        let data = try JSONEncoder().encode(st)
        XCTAssertEqual(try JSONDecoder().decode(AppState.self, from: data).filterHitHours, [today: hours[today]!], "a mentés hordozza az órákat")
        let summary = Focus.Summary(sessions: 0, totalMs: 0, stoppedEarly: 0, topPack: nil)
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: summary, unlocks7d: 0, filterHits7d: 12,
                                                          filterHitsPeak: (hour: 21, count: 7)), labelOf: { $0 }),
                       "Elmúlt 7 nap: 12 megakadás a szűrőben, a csúcs 21–22 óra.")
    }

    func testTheNthHitTheStepAndTheSentence() {
        XCTAssertEqual(FilterHitLogic.nudgeStep(4), 0, "négynél még nem szól")
        XCTAssertEqual(FilterHitLogic.nudgeStep(5), 5)
        XCTAssertEqual(FilterHitLogic.nudgeStep(9), 5, "a következő lépcsőig ugyanaz")
        XCTAssertEqual(FilterHitLogic.nudgeStep(12), 10)
        XCTAssertEqual(FilterHitLogic.nudgeStep(250), 20, "a legfelső lépcső fölött is a legfelső")
        XCTAssertEqual(FilterHitLogic.nudgeSteps, [5, 10, 20])
        XCTAssertEqual(FilterHitLogic.nudgeText(5),
                       "Ma már 5 megakadás a szűrőben. Egy munkamenet vagy egy rövid zárlat most segítene — te döntesz.")
    }

    func testTheSentenceAndTheSave() throws {
        let summary = Focus.Summary(sessions: 0, totalMs: 0, stoppedEarly: 0, topPack: nil)
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: summary, unlocks7d: 1, filterHits7d: 12), labelOf: { $0 }),
                       "Elmúlt 7 nap: 1 feloldás. 12 megakadás a szűrőben.")
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: summary, unlocks7d: 0, filterHits7d: 3), labelOf: { $0 }),
                       "Elmúlt 7 nap: 3 megakadás a szűrőben.", "megakadás feloldás nélkül is mondat")
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: summary, unlocks7d: 1), labelOf: { $0 }),
                       "Elmúlt 7 nap: 1 feloldás.")

        var st = AppState()
        st.filterHits = [today: 3]
        let data = try JSONEncoder().encode(st)
        XCTAssertEqual(try JSONDecoder().decode(AppState.self, from: data).filterHits, [today: 3], "a mentés hordozza")
        // Egy korábbi verzió mentése: a mező nincs benne — a dekódolás nem dob, a könyv üres.
        let older = try JSONDecoder().decode(AppState.self, from: try JSONEncoder().encode(AppState()))
        XCTAssertNil(older.filterHits, "régi mentés: könyv nélkül")
    }
}
