import XCTest
@testable import BreakerShared

// Véletlen összefésülések a Swift tükrön — a desktop/test/merge-fuzz.test.ts
// párja, UGYANAZZAL a véletlennel (LCG, azonos képlet, azonos magok), tehát
// ugyanazokat az eseteket járja be, mint a gép.
//
// Nem a szabályokat teszteli, hanem azt, hogy a szabályok EGYÜTT nem hagynak
// olyan sarkot, ahol a végeredmény a push-sorrendtől függ. Egy ilyen sarok
// nem összeomlás, hanem két gép, ami örökké egymást írja felül.

/// Determinisztikus véletlen — bájtra a gépé: `s = s * 1664525 + 1013904223 (mod 2^32)`.
struct Lcg {
    private var s: UInt32
    init(_ seed: UInt32) { s = seed }
    mutating func next() -> Double {
        s = s &* 1664525 &+ 1013904223
        return Double(s) / 4294967296.0
    }
}

private let hosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "yt.be"]
private let devices = ["gep-a", "gep-b", "telefon"]

private func randomSite(_ r: inout Lcg, _ device: String) -> SyncMerge.SyncSite {
    var hostnames: [String] = []
    for (i, h) in hosts.enumerated() {
        if i == 0 || r.next() < 0.5 { hostnames.append(h) }
    }
    var marks: [String: Int] = [:]
    for h in hosts.dropFirst() {
        if r.next() < 0.4 { marks[h] = 1 + Int(r.next() * 5) }
    }
    let pending: Double? = r.next() < 0.15 ? 5_000 + Double(Int(r.next() * 3)) : nil
    let limit: Double? = r.next() < 0.4 ? 600 * Double(1 + Int(r.next() * 3)) : nil
    let alias: String? = r.next() < 0.3 ? "n\(Int(r.next() * 3))" : nil
    let rev = 1 + Int(r.next() * 5)
    let updatedAt = 100 + Double(Int(r.next() * 5))
    return SyncMerge.SyncSite(
        id: "site_1", domain: "youtube.com", hostnames: hostnames, addedAt: 1_000,
        pendingDeleteAt: pending, dailyLimitSeconds: limit, alias: alias,
        rev: rev, updatedAt: updatedAt, updatedBy: device,
        hostnameMarks: marks.isEmpty ? nil : marks
    )
}

/// A NEVEK és a JELEIK — ezek fésülődnek nevenként. A rekord többi mezője a
/// rekord-szintű nyertesé, és ott a törlésre várás továbbvitele egy olyan
/// köztes rekordot ad, ami egyik eszközön sem létezett — ezt itt nem mérjük,
/// ahogy a gép sem.
private func siteKey(_ s: SyncMerge.SyncSite) -> String {
    let marks = (s.hostnameMarks ?? [:]).sorted { $0.key < $1.key }
        .map { "\($0.key)=\($0.value)" }.joined(separator: ",")
    return "\(s.hostnames.sorted().joined(separator: ","))|\(marks)|\(s.rev)"
}

private let packIds = ["p1", "p2", "p3", "p4"]
private let win = ScheduleLogic.Band(days: [1, 2, 3, 4, 5], startMin: 540, endMin: 720)

private func randomFocus(_ r: inout Lcg, _ device: String) -> FocusSync.SyncFocus {
    var kept: [String] = []
    for id in packIds {
        if r.next() < 0.6 { kept.append(id) }
    }
    var packs: [Focus.Pack] = []
    for id in kept {
        let name = "csomag \(id) v\(Int(r.next() * 3))"
        let rec: ScheduleLogic.Band? = r.next() < 0.4 ? win : nil
        packs.append(Focus.Pack(
            id: id, name: name, allowSites: ["quizlet.com"], allowApps: [],
            defaultMinutes: 50, recurrence: rec
        ))
    }
    var marks: [String: Int] = [:]
    for id in packIds {
        if r.next() < 0.4 { marks[id] = 1 + Int(r.next() * 5) }
    }
    // A menet lejárata és kezdése is csak pár értéket vesz fel: legyen sok
    // döntetlen, mert éppen a döntetlen-lánc az, ami sorrendfüggő tud lenni.
    var run: Focus.Run? = nil
    if r.next() < 0.4 && !packs.isEmpty {
        let packId = packs[Int(r.next() * Double(packs.count))].id
        let startedAt = 10 + 60_000 * Double(Int(r.next() * 2))
        let endsAt = 610_000 + 60_000 * Double(Int(r.next() * 2))
        run = Focus.Run(packId: packId, startedAt: startedAt, endsAt: endsAt)
    }
    let rev = Double(1 + Int(r.next() * 5))
    let updatedAt = Double(100 + Int(r.next() * 5))
    return FocusSync.SyncFocus(
        packs: packs, run: run, log: [], rev: rev, updatedAt: updatedAt, updatedBy: device,
        packMarks: marks.isEmpty ? nil : marks
    )
}

private func focusKey(_ f: FocusSync.SyncFocus) -> String {
    let packs = f.packs.sorted { $0.id < $1.id }
        .map { "\($0.id):\($0.name):\(Focus.recurrenceKey($0.recurrence))" }.joined(separator: ",")
    let marks = (f.packMarks ?? [:]).sorted { $0.key < $1.key }
        .map { "\($0.key)=\($0.value)" }.joined(separator: ",")
    let run = f.run.map { "\($0.packId)/\($0.startedAt)/\($0.endsAt)" } ?? "-"
    return "\(packs)|\(marks)|\(run)|\(f.rev)"
}

final class MergeFuzzTests: XCTestCase {

    func testSiteMergeIsSymmetricIdempotentAndOrderIndependent() {
        for seed in 1...300 {
            var r = Lcg(UInt32(seed))
            let a = randomSite(&r, devices[0])
            let b = randomSite(&r, devices[1])
            let c = randomSite(&r, devices[2])
            let ab = SyncMerge.mergeSite(a, b)
            XCTAssertEqual(siteKey(ab), siteKey(SyncMerge.mergeSite(b, a)), "szimmetria, mag \(seed)")
            XCTAssertEqual(siteKey(SyncMerge.mergeSite(ab, ab)), siteKey(ab), "idempotens, mag \(seed)")
            let abc = SyncMerge.mergeSite(ab, c)
            let bca = SyncMerge.mergeSite(SyncMerge.mergeSite(b, c), a)
            let cab = SyncMerge.mergeSite(SyncMerge.mergeSite(c, a), b)
            XCTAssertEqual(siteKey(abc), siteKey(bca), "három eszköz, más sorrend (bca), mag \(seed)")
            XCTAssertEqual(siteKey(abc), siteKey(cab), "három eszköz, más sorrend (cab), mag \(seed)")
            // Lazítás jel nélkül nincs: ami mindkét oldalon benne volt, és
            // egyiknek sincs rá jele, az az eredményben is benne van.
            for h in a.hostnames where b.hostnames.contains(h)
                && (a.hostnameMarks?[h] ?? 0) == 0 && (b.hostnameMarks?[h] ?? 0) == 0 {
                XCTAssertTrue(ab.hostnames.contains(h), "jel nélküli közös név nem tűnhet el: \(h), mag \(seed)")
            }
        }
    }

    func testFocusMergeIsSymmetricIdempotentAndOrderIndependent() {
        for seed in 1...300 {
            var r = Lcg(UInt32(seed))
            let a = randomFocus(&r, devices[0])
            let b = randomFocus(&r, devices[1])
            let c = randomFocus(&r, devices[2])
            let ab = FocusSync.merge(a, b)
            XCTAssertEqual(focusKey(ab), focusKey(FocusSync.merge(b, a)), "szimmetria, mag \(seed)")
            XCTAssertEqual(focusKey(FocusSync.merge(ab, ab)), focusKey(ab), "idempotens, mag \(seed)")
            let abc = FocusSync.merge(ab, c)
            XCTAssertEqual(
                focusKey(abc), focusKey(FocusSync.merge(FocusSync.merge(b, c), a)),
                "három eszköz (bca), mag \(seed)"
            )
            XCTAssertEqual(
                focusKey(abc), focusKey(FocusSync.merge(FocusSync.merge(c, a), b)),
                "három eszköz (cab), mag \(seed)"
            )
            // A jeles csomag a nagyobb jel változatában marad: ha az egyik
            // oldalon ablakos csomag áll a nagyobb jellel, az ablak marad.
            for p in a.packs {
                let ma = a.packMarks?[p.id] ?? 0
                let mb = b.packMarks?[p.id] ?? 0
                if ma > mb && p.recurrence != nil {
                    XCTAssertNotNil(
                        ab.packs.first { $0.id == p.id }?.recurrence,
                        "a nagyobb jel ablaka marad: \(p.id), mag \(seed)"
                    )
                }
            }
        }
    }
}
