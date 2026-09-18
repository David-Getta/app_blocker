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
        // Az előző hét: a 13.–7. nap — a hetedik és a tizenharmadik benne, a tizennegyedik nem.
        var two = days
        two[FilterHitLogic.dayKey(now - 13 * 86_400_000)] = 4
        two[FilterHitLogic.dayKey(now - 14 * 86_400_000)] = 100
        XCTAssertEqual(FilterHitLogic.hitsPrev7d(two, now: now), 13)
        XCTAssertEqual(FilterHitLogic.hitsPrev7d([:], now: now), 0)
        XCTAssertEqual(FilterHitLogic.trendText(12, prev: 18), "A héten 12 megakadás, az előző héten 18.")
        XCTAssertEqual(FilterHitLogic.trendText(0, prev: 18), "A héten 0 megakadás, az előző héten 18.", "a nulla hét is mondat, ha volt mihez mérni")
        XCTAssertEqual(FilterHitLogic.trendText(12, prev: 0), "", "előző hét nélkül nincs összehasonlítás")
    }

    func testTheShapeOfTheWeek() {
        let days = [today: 2, FilterHitLogic.dayKey(now - 6 * 86_400_000): 3, FilterHitLogic.dayKey(now - 7 * 86_400_000): 9]
        let series = FilterHitLogic.daySeries(days, now: now, count: 7)
        XCTAssertEqual(series.count, 7)
        XCTAssertEqual(series.first?.day, FilterHitLogic.dayKey(now - 6 * 86_400_000))
        XCTAssertEqual(series.last?.day, today)
        XCTAssertEqual(series.map { $0.seconds }, [3, 0, 0, 0, 0, 0, 2], "a nyolcadik nap már nem a hété")
        // A HÓNAP rajza csak akkor mond többet a hétnél, ha a hét előtt is volt.
        let month = FilterHitLogic.daySeries(days, now: now, count: 30)
        XCTAssertEqual(month.count, 30)
        XCTAssertTrue(FilterHitLogic.monthHasOlderHits(month), "a nyolc napos a hónapé: áll")
        XCTAssertFalse(FilterHitLogic.monthHasOlderHits(Array(month.suffix(7))), "csak a hét: nem áll")
        XCTAssertFalse(FilterHitLogic.monthHasOlderHits([]))
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
        let by = FilterHitLogic.byHour(hours, now: now)
        XCTAssertEqual(by.count, 24, "az órák sávja huszonnégy rekesz")
        XCTAssertEqual(by[9], 2, "a rekesz a hét összege — a nyolcadik nap nélkül")
        XCTAssertEqual(by[21], 2)
        XCTAssertEqual(by.reduce(0, +), 4)
        XCTAssertEqual(FilterHitLogic.byHour([:], now: now), Array(repeating: 0, count: 24), "üresen csupa nulla")
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
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: summary, unlocks7d: 0, filterHits7d: 12,
                                                          filterHitsPeak: (hour: 21, count: 7), filterHitsPeakPack: "Nyelvtanulás"), labelOf: { $0 }),
                       "Elmúlt 7 nap: 12 megakadás a szűrőben, a csúcs 21–22 óra (magától indul: Nyelvtanulás).",
                       "a lefedett csúcs-óra a csúcs mellett")
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: summary, unlocks7d: 0, filterHits7d: 12,
                                                          filterHitsPeak: nil, filterHitsPeakPack: "Nyelvtanulás"), labelOf: { $0 }),
                       "Elmúlt 7 nap: 12 megakadás a szűrőben.", "csúcs nélkül a csomag sem szerepel")
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

    func testTheWarningBeforeThePeakHour() {
        let peak = (hour: 21, count: 7)
        func at2(_ hh: Int, _ mm: Int, _ d: Int = 18) -> Double {
            Calendar.current.date(from: DateComponents(year: 2026, month: 9, day: d, hour: hh, minute: mm))!.timeIntervalSince1970 * 1000
        }
        XCTAssertEqual(FilterHitLogic.peakWarnLeadMs, 10 * 60_000)
        XCTAssertEqual(FilterHitLogic.peakWarnMinCount, 3)
        XCTAssertNil(FilterHitLogic.peakWarnKey(peak, now: at2(20, 49)), "tizenegy perccel előtte még nem")
        XCTAssertEqual(FilterHitLogic.peakWarnKey(peak, now: at2(20, 50)), "2026-09-18:21")
        XCTAssertEqual(FilterHitLogic.peakWarnKey(peak, now: at2(20, 59)), "2026-09-18:21")
        XCTAssertNil(FilterHitLogic.peakWarnKey(peak, now: at2(21, 0)), "az órában már nem előjelzés")
        XCTAssertNil(FilterHitLogic.peakWarnKey((hour: 21, count: 2), now: at2(20, 55)), "kettő nem csúcs")
        XCTAssertNil(FilterHitLogic.peakWarnKey(nil, now: at2(20, 55)))
        XCTAssertEqual(FilterHitLogic.peakWarnKey((hour: 0, count: 3), now: at2(23, 55)), "2026-09-19:0", "a nulla óra ablaka az előző este")
        XCTAssertNil(FilterHitLogic.peakWarnKey((hour: 0, count: 3), now: at2(0, 5, 19)))
        XCTAssertEqual(FilterHitLogic.peakWarnText(peak),
                       "Mindjárt 21 óra — a héten ilyenkor akadt meg a kéz a legtöbbször (7×). Egy munkamenet most segítene — te döntesz.")
        XCTAssertTrue(FilterHitLogic.isPeakNow(peak, now: at2(21, 0)), "az óra elején már most van")
        XCTAssertTrue(FilterHitLogic.isPeakNow(peak, now: at2(21, 59)))
        XCTAssertFalse(FilterHitLogic.isPeakNow(peak, now: at2(20, 59)), "előtte még nem")
        XCTAssertFalse(FilterHitLogic.isPeakNow(peak, now: at2(22, 0)), "utána már nem")
        XCTAssertFalse(FilterHitLogic.isPeakNow(nil, now: at2(21, 0)))
        XCTAssertEqual(FilterHitLogic.peakNowText(peak),
                       "Most a hét csúcs-órája van (21–22 óra, 7 megakadás a héten) — ilyenkor jár a kéz magától.")
    }

    func testPerReasonTheReasonFromTheVerdictTheWeekByReasonTheLineAndTheSave() throws {
        XCTAssertEqual(FilterHitLogic.reasonOf(.blockedByList), "list")
        XCTAssertEqual(FilterHitLogic.reasonOf(.blockedByKeyword), "keyword")
        XCTAssertNil(FilterHitLogic.reasonOf(.blockedByFocus), "a munkamenet fehérlistáján kívül nem megakadás")
        XCTAssertNil(FilterHitLogic.reasonOf(.allow))
        var reasons = FilterHitLogic.recordSite([:], day: today, site: "list")
        reasons = FilterHitLogic.recordSite(reasons, day: today, site: "keyword")
        reasons = FilterHitLogic.recordSite(reasons, day: today, site: "keyword")
        reasons = FilterHitLogic.recordSite(reasons, day: FilterHitLogic.dayKey(now - 8 * 86_400_000), site: "list") // nem a hété
        let rows = FilterHitLogic.byReason(reasons, now: now)
        XCTAssertEqual(rows.map { $0.reason }, ["keyword", "list"], "a legnagyobb elöl")
        XCTAssertEqual(rows.map { $0.count }, [2, 1])
        XCTAssertEqual(FilterHitLogic.byReason([today: ["keyword": 1, "list": 1]], now: now).map { $0.reason }, ["list", "keyword"], "holtverseny: a rögzített sorrend")
        XCTAssertTrue(FilterHitLogic.byReason([:], now: now).isEmpty)
        XCTAssertEqual(FilterHitLogic.reasonLine(rows), "2 kulcsszó · 1 lista")
        XCTAssertEqual(FilterHitLogic.reasonLine([]), "")
        var st = AppState()
        st.filterHitReasons = reasons
        XCTAssertEqual(try JSONDecoder().decode(AppState.self, from: try JSONEncoder().encode(st)).filterHitReasons, reasons, "a mentés hordozza az okokat")
    }

    func testPerKeywordTheWeekRowLargestFirstTheLineAndTheSave() throws {
        var book = FilterHitLogic.recordSite([:], day: today, site: "shorts")
        book = FilterHitLogic.recordSite(book, day: today, site: "shorts")
        book = FilterHitLogic.recordSite(book, day: today, site: "reels")
        book = FilterHitLogic.recordSite(book, day: FilterHitLogic.dayKey(now - 8 * 86_400_000), site: "live") // nem a hété
        let rows = FilterHitLogic.keywordsWeek(book, now: now)
        XCTAssertEqual(rows.map { $0.keyword }, ["shorts", "reels"], "a legnagyobb elöl")
        XCTAssertEqual(rows.map { $0.count }, [2, 1])
        XCTAssertEqual(FilterHitLogic.keywordsWeek([today: ["b": 1, "a": 1]], now: now).map { $0.keyword }, ["a", "b"], "holtverseny: az ábécé")
        XCTAssertTrue(FilterHitLogic.keywordsWeek([:], now: now).isEmpty)
        XCTAssertEqual(FilterHitLogic.keywordLine(rows), "shorts 2 · reels 1")
        XCTAssertEqual(FilterHitLogic.keywordLine([]), "")
        // Ami nem fogott: a lista szavai a hét sorai nélkül — csak ha volt kulcsszó-megakadás.
        XCTAssertEqual(FilterHitLogic.idleKeywords(["Shorts", "live", " stream ", ""], rows: rows), ["live", "stream"], "kisbetűsen, üres nélkül")
        XCTAssertEqual(FilterHitLogic.idleKeywords(["live"], rows: []), [], "kulcsszó-megakadás nélkül a hiány nem tény")
        var st = AppState()
        st.filterHitKeywords = book
        XCTAssertEqual(try JSONDecoder().decode(AppState.self, from: try JSONEncoder().encode(st)).filterHitKeywords, book, "a mentés hordozza a szavakat")
    }

    func testPerSiteTheNameToTheSiteTheBookThePeakSiteTheSaveAndTheSentence() throws {
        let sites = [(domain: "youtube.com", hostnames: ["youtube.com", "www.youtube.com"])]
        XCTAssertEqual(FilterHitLogic.siteOf("M.YouTube.com.", sites: sites), "youtube.com", "aldomain és nagybetű: az oldal")
        XCTAssertEqual(FilterHitLogic.siteOf("notyoutube.com", sites: sites), "notyoutube.com", "a hasonló név nem az oldal")
        var hosts = FilterHitLogic.recordSite([:], day: today, site: "youtube.com")
        hosts = FilterHitLogic.recordSite(hosts, day: today, site: "youtube.com")
        hosts = FilterHitLogic.recordSite(hosts, day: today, site: "reddit.com")
        hosts = FilterHitLogic.recordSite(hosts, day: FilterHitLogic.dayKey(now - 8 * 86_400_000), site: "old.com") // nem a hété
        hosts = FilterHitLogic.recordSite(hosts, day: "szemét", site: "youtube.com")
        hosts = FilterHitLogic.recordSite(hosts, day: today, site: "")
        XCTAssertEqual(hosts[today], ["youtube.com": 2, "reddit.com": 1])
        XCTAssertEqual(FilterHitLogic.topSite(hosts, now: now)?.site, "youtube.com")
        XCTAssertEqual(FilterHitLogic.topSite(hosts, now: now)?.count, 2)
        XCTAssertNil(FilterHitLogic.topSite([:], now: now))
        XCTAssertEqual(FilterHitLogic.topSite([today: ["b.com": 1, "a.com": 1]], now: now)?.site, "a.com", "holtverseny: az ábécé")
        XCTAssertEqual(FilterHitLogic.cleanSites([today: ["youtube.com": 2, "": 3, "z.com": 0], "x": ["a": 1]]), [today: ["youtube.com": 2]])
        var st = AppState()
        st.filterHitHosts = hosts
        XCTAssertEqual(try JSONDecoder().decode(AppState.self, from: try JSONEncoder().encode(st)).filterHitHosts, hosts, "a mentés hordozza az oldalakat")
        let summary = Focus.Summary(sessions: 0, totalMs: 0, stoppedEarly: 0, topPack: nil)
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: summary, unlocks7d: 0, filterHits7d: 12,
                                                          filterHitsPeak: (hour: 21, count: 7), filterHitsTop: (label: "youtube.com", count: 5)),
                                        labelOf: { $0 == "youtube.com" ? "A videós" : $0 }),
                       "Elmúlt 7 nap: 12 megakadás a szűrőben, a csúcs 21–22 óra, a legtöbbször: A videós (5×).")
    }

    func testTheSentenceAndTheSave() throws {
        let summary = Focus.Summary(sessions: 0, totalMs: 0, stoppedEarly: 0, topPack: nil)
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: summary, unlocks7d: 1, filterHits7d: 12), labelOf: { $0 }),
                       "Elmúlt 7 nap: 1 feloldás. 12 megakadás a szűrőben.")
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: summary, unlocks7d: 0, filterHits7d: 3), labelOf: { $0 }),
                       "Elmúlt 7 nap: 3 megakadás a szűrőben.", "megakadás feloldás nélkül is mondat")
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: summary, unlocks7d: 1), labelOf: { $0 }),
                       "Elmúlt 7 nap: 1 feloldás.")
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: summary, unlocks7d: 0, filterHits7d: 12,
                                                          filterHitsPeak: (hour: 21, count: 7), filterHitsPrev7d: 18), labelOf: { $0 }),
                       "Elmúlt 7 nap: 12 megakadás a szűrőben (az előző héten 18), a csúcs 21–22 óra.",
                       "az előző hét a szám mellett, a csúcs utána")
        XCTAssertEqual(DigestLogic.text(DigestLogic.Input(focusWeek: summary, unlocks7d: 0, filterHits7d: 0, filterHitsPrev7d: 18), labelOf: { $0 }),
                       "Elmúlt 7 nap: Megakadás nélkül a szűrőben (az előző héten 18).", "a nulla hét is mondat, ha volt mihez mérni")

        var st = AppState()
        st.filterHits = [today: 3]
        let data = try JSONEncoder().encode(st)
        XCTAssertEqual(try JSONDecoder().decode(AppState.self, from: data).filterHits, [today: 3], "a mentés hordozza")
        // Egy korábbi verzió mentése: a mező nincs benne — a dekódolás nem dob, a könyv üres.
        let older = try JSONDecoder().decode(AppState.self, from: try JSONEncoder().encode(AppState()))
        XCTAssertNil(older.filterHits, "régi mentés: könyv nélkül")
        // Ha nem kéred, csendben marad — a beállítás a mentésben; a régi mentésben nincs: szól.
        var quiet = AppState()
        quiet.quietSuggestions = true
        XCTAssertEqual(try JSONDecoder().decode(AppState.self, from: try JSONEncoder().encode(quiet)).quietSuggestions, true, "a mentés hordozza a csendet")
        XCTAssertNil(older.quietSuggestions, "régi mentés: szól")
    }

    func testThePeakWeekdayFromFourWeeksTiesGoToTheEarlierDay() {
        // 2026-09-18 péntek. Három péntek a négy hétben, a 28 nappal ezelőtti már nincs benne.
        var comps = DateComponents()
        comps.year = 2026; comps.month = 9; comps.day = 18; comps.hour = 12
        let now = Calendar.current.date(from: comps)!.timeIntervalSince1970 * 1000
        let day: Double = 86_400_000
        func k(_ back: Int) -> String { FilterHitLogic.dayKey(now - Double(back) * day) }
        let days = [k(0): 2, k(7): 3, k(14): 1, k(1): 5, k(28): 100]
        let by = FilterHitLogic.byWeekday(days, now: now)
        XCTAssertEqual(by.count, 7)
        XCTAssertEqual(by[5], 6, "péntek: három péntek összege, a huszonnyolc napos nélkül")
        XCTAssertEqual(by[4], 5, "csütörtök")
        let peak = FilterHitLogic.peakWeekday(by)
        XCTAssertEqual(peak?.day, 5)
        XCTAssertEqual(peak?.count, 6)
        let tie = FilterHitLogic.peakWeekday([0, 0, 0, 0, 6, 6, 0])
        XCTAssertEqual(tie?.day, 4, "holtverseny: a hét elejéhez közelebbi")
        XCTAssertEqual(FilterHitLogic.peakWeekday([3, 0, 0, 0, 0, 0, 3])?.day, 6, "a vasárnap a hét vége: a szombat előbb jön")
        XCTAssertNil(FilterHitLogic.peakWeekday([0, 0, 0, 0, 0, 0, 0]))
        XCTAssertEqual(FilterHitLogic.byWeekday([:], now: now), [0, 0, 0, 0, 0, 0, 0])
        XCTAssertEqual(FilterHitLogic.peakWeekdayText((day: 0, count: 14)), "A négy hét csúcs-napja: vasárnap (14 megakadás).")
    }
}
