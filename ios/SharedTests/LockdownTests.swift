import Foundation
import XCTest
@testable import BreakerShared

// Zárlat: amíg tart, a lazítás nem drága — NINCS.
//
// A desktop/test/lockdown.test.ts és az androidos LockdownTest párja. Itt a
// MAG számtana fut: a bíró kapuját (`Referee`) a csomag-teszt nem éri el, mert
// az a megosztott tárolóhoz nyúl — de a kapu döntése ebből a négy szabályból
// áll, és ezek itt is ugyanazok.
final class LockdownTests: XCTestCase {

    private let t0: Double = 1_736_160_000_000 // 2025-01-06 10:00 UTC
    private let hour: Double = 3_600_000

    func testNeverShortens() {
        let long = LockdownLogic.start(nil, 8 * hour, t0)!
        let shorter = LockdownLogic.start(long, hour, t0 + 60_000)!
        XCTAssertEqual(shorter.until, long.until, "a rövidebb kérés nem vihette le")
        XCTAssertEqual(shorter.startedAt, long.startedAt)
    }

    func testExtendsAndKeepsStart() {
        let first = LockdownLogic.start(nil, hour, t0)!
        let longer = LockdownLogic.start(first, 24 * hour, t0 + 30 * 60_000)!
        XCTAssertEqual(longer.until, t0 + 30 * 60_000 + 24 * hour)
        XCTAssertEqual(longer.startedAt, t0, "a hosszabbítás nem nulláz vissza")
    }

    func testExpiredLockdownStartsClean() {
        let old = LockdownLogic.start(nil, hour, t0)!
        let after = t0 + 3 * hour
        XCTAssertFalse(LockdownLogic.isLocked(old, after))
        let fresh = LockdownLogic.start(old, hour, after)!
        XCTAssertEqual(fresh.startedAt, after)
        XCTAssertEqual(fresh.until, after + hour)
    }

    func testCappedAtThirtyDays() {
        let l = LockdownLogic.start(nil, 400 * 24 * hour, t0)!
        XCTAssertEqual(l.until, t0 + LockdownLogic.maxLockdownMs)
    }

    func testNonsenseLengthStartsNothing() {
        for bad in [0, -5, Double.nan, Double.infinity] {
            XCTAssertNil(LockdownLogic.start(nil, bad, t0), "\(bad) nem indíthat zárlatot")
        }
        let live = LockdownLogic.start(nil, hour, t0)!
        XCTAssertEqual(LockdownLogic.start(live, -1, t0)?.until, live.until, "a futót sem bántja")
    }

    func testMergeTakesTheLaterEnd() {
        let a = LockdownLogic.Lockdown(startedAt: t0, until: t0 + hour)
        let b = LockdownLogic.Lockdown(startedAt: t0 - hour, until: t0 + 5 * hour)
        XCTAssertEqual(LockdownLogic.merge(a, b)?.until, b.until)
        XCTAssertEqual(LockdownLogic.merge(b, a)?.until, b.until)
        XCTAssertEqual(LockdownLogic.merge(a, nil)?.until, a.until)
        XCTAssertEqual(LockdownLogic.merge(nil, a)?.until, a.until)
        XCTAssertNil(LockdownLogic.merge(nil, nil))
        // Azonos végnél a korábbi kezdés marad — az mutatja a teljes hosszt.
        let c = LockdownLogic.Lockdown(startedAt: t0 - hour, until: t0 + hour)
        XCTAssertEqual(LockdownLogic.merge(a, c)?.startedAt, t0 - hour)
    }

    func testParseRejectsJunk() {
        XCTAssertNil(LockdownLogic.parse(nil))
        XCTAssertNil(LockdownLogic.parse(42))
        XCTAssertNil(LockdownLogic.parse(["until": 0]))
        XCTAssertNil(LockdownLogic.parse(["until": -1]))
        XCTAssertEqual(LockdownLogic.parse(["until": t0 + hour, "startedAt": t0])?.until, t0 + hour)
        // Kezdés nélkül a vég a kezdés is: inkább rövidnek látsszon, mint hosszabbnak.
        XCTAssertEqual(LockdownLogic.parse(["until": t0 + hour])?.startedAt, t0 + hour)
        // A végénél KÉSŐBBI kezdés hazugság; a vég vágja vissza.
        XCTAssertEqual(LockdownLogic.parse(["until": t0, "startedAt": t0 + hour])?.startedAt, t0)
    }

    func testReadableRemaining() {
        XCTAssertEqual(LockdownLogic.formatRemaining(6 * 24 * hour + 3 * hour), "6 nap 3 óra")
        XCTAssertEqual(LockdownLogic.formatRemaining(2 * 24 * hour), "2 nap")
        XCTAssertEqual(LockdownLogic.formatRemaining(2 * hour + 15 * 60_000), "2 ó 15 p")
        XCTAssertEqual(LockdownLogic.formatRemaining(4 * 60_000), "4 perc")
        XCTAssertEqual(LockdownLogic.formatRemaining(3000), "1 perc", "a maradék sosem nulla perc")
        XCTAssertEqual(LockdownLogic.remainingMs(nil, t0), 0)
    }

    /// A SZINKRON MAGASVÍZJELE: a fésülés a munkamenet-blobon is a későbbi
    /// véget hozza, `rev`-re való tekintet nélkül. Enélkül egy hálózat nélkül
    /// maradt eszköz a régi állapotát feltolva feloldana.
    func testSyncBlobCarriesTheLaterLockdown() {
        let mine = FocusSync.SyncFocus(
            rev: 9, updatedAt: t0, updatedBy: "gep",
            lockdown: LockdownLogic.Lockdown(startedAt: t0, until: t0 + hour))
        let stale = FocusSync.SyncFocus(
            rev: 1, updatedAt: t0 - hour, updatedBy: "telefon",
            lockdown: LockdownLogic.Lockdown(startedAt: t0 - hour, until: t0 + 5 * hour))
        XCTAssertEqual(FocusSync.merge(mine, stale).lockdown?.until, t0 + 5 * hour,
                       "a kisebb rev is hozhat hosszabb zárlatot")
        // …és fordítva sem veszik el: a nélküle érkező blob nem törli.
        let none = FocusSync.SyncFocus(rev: 12, updatedAt: t0 + hour, updatedBy: "telefon")
        XCTAssertEqual(FocusSync.merge(mine, none).lockdown?.until, t0 + hour,
                       "a zárlatot nem ismerő blob nem viheti el")
        // A blob KÜLÖNBÖZŐNEK látszik, ha csak a zárlat változott — enélkül
        // sosem menne fel a kiszolgálóra.
        XCTAssertFalse(FocusSync.same(mine, none))
    }
}
