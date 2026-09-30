import Foundation
import XCTest
@testable import BreakerShared

// A LISTA REJTÉSE a fiók egészére szól — a desktop/test/hide-sync.test.ts és az
// androidos HideSyncTest párja: a fésülés (a jel dönt, azonos jelnél a rejtett,
// a régi kliens semleges), a drót (a jel legfeljebb a blob rev-je, a rejtés csak
// igazként utazik — és a NORMALIZÁLÁS is átviszi, mert az újraépíti a rekordot)
// és a jel (a be- és kikapcsolás lépteti a blobot, az átvett jel marad). A három
// nyelv fésülését a fixtúra (merge-cases.json) is összeveti.
final class HideSyncTests: XCTestCase {

    private let now: Double = 1_700_000_000_000

    private func doc(_ dev: String, _ rev: Double, _ hide: Bool, _ mark: Int? = nil) -> FocusSync.SyncFocus {
        FocusSync.SyncFocus(rev: rev, updatedAt: 100, updatedBy: dev, hideSiteList: hide ? true : nil, hideSiteListRev: mark)
    }

    func testMergeByMarkHiddenOnTieAndTheOldClientIsNeutral() {
        // A nagyobb jelű, kifizetett kikapcsolás átmegy — a rejtés nem támad fel egy régi blobból.
        XCTAssertNil(FocusSync.merge(doc("a", 5, false, 5), doc("b", 3, true, 3)).hideSiteList)
        XCTAssertNil(FocusSync.merge(doc("a", 3, true, 3), doc("b", 5, false, 5)).hideSiteList)
        // A nagyobb jelű rejtés átmegy.
        XCTAssertEqual(FocusSync.merge(doc("a", 5, true, 5), doc("b", 3, false, 3)).hideSiteList, true)
        // Azonos jelnél a rejtett — a szigorúbb irány.
        XCTAssertEqual(FocusSync.merge(doc("a", 4, true, 4), doc("b", 4, false, 4)).hideSiteList, true)
        XCTAssertEqual(FocusSync.merge(doc("a", 4, false, 4), doc("b", 4, true, 4)).hideSiteList, true)
        // A régi kliens (jel nélkül) nem tud kikapcsolni: a jeles rejtés marad.
        XCTAssertEqual(FocusSync.merge(doc("a", 9, false), doc("b", 2, true, 2)).hideSiteList, true)
        // A jel a nagyobb; rejtés nélkül nincs mező.
        XCTAssertEqual(FocusSync.merge(doc("a", 5, true, 5), doc("b", 3, false, 3)).hideSiteListRev, 5)
        XCTAssertNil(FocusSync.merge(doc("a", 1, false), doc("b", 1, false)).hideSiteListRev)
        // Sorrendfüggetlen.
        let x = doc("a", 6, true, 6)
        let y = doc("b", 6, false, 2)
        XCTAssertEqual(FocusSync.merge(x, y).hideSiteList, FocusSync.merge(y, x).hideSiteList)
        // A tiszta szabály is.
        XCTAssertTrue(FocusSync.mergeHide(0, true, 0, false), "jel nélkül a rejtett nyer")
        XCTAssertFalse(FocusSync.mergeHide(2, false, 1, true), "a nagyobb jelű kikapcsolás nyer")
        // A rejtés cseréje különbség: azonos rev mellett is fel kell mennie.
        XCTAssertFalse(FocusSync.same(doc("a", 3, true, 3), doc("a", 3, false)), "a rejtés cseréje különbség")
        XCTAssertTrue(FocusSync.same(doc("a", 3, true, 3), doc("a", 3, true, 3)))
    }

    func testTheWireCarriesTheFlagAndTheMarkThroughDecodingAndNormalizing() throws {
        // A fixtúra-visszajátszás és az éles kör útja: dekódolás, aztán
        // normalizálás. A normalizálás ÚJRAÉPÍTI a rekordot — ha egy mezőt nem
        // visz át, az a dróton veszett el, és itt bukik.
        let json = """
        {"packs":[],"rev":3,"updatedAt":100,"updatedBy":"a","hideSiteList":true,"hideSiteListRev":3}
        """
        let decoded = try JSONDecoder().decode(FocusSync.SyncFocus.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.hideSiteList, true)
        XCTAssertEqual(decoded.hideSiteListRev, 3)
        let n = FocusSync.normalize(decoded, fallbackDevice: "a")
        XCTAssertEqual(n.hideSiteList, true, "a normalizálás átviszi a rejtést")
        XCTAssertEqual(n.hideSiteListRev, 3, "a normalizálás átviszi a jelét")
        let over = FocusSync.normalize(doc("a", 3, true, 9), fallbackDevice: "a")
        XCTAssertEqual(over.hideSiteList, true)
        XCTAssertNil(over.hideSiteListRev, "a rev fölötti jel eldobva")
        let offJson = """
        {"packs":[],"rev":3,"hideSiteList":false}
        """
        let off = try JSONDecoder().decode(FocusSync.SyncFocus.self, from: Data(offJson.utf8))
        XCTAssertNil(off.hideSiteList, "a hamis nem mező")
        XCTAssertNil(FocusSync.normalize(off, fallbackDevice: "a").hideSiteList)
        let text = String(decoding: try JSONEncoder().encode(doc("a", 3, true, 3)), as: UTF8.self)
        XCTAssertTrue(text.contains("\"hideSiteList\":true"))
        XCTAssertTrue(text.contains("\"hideSiteListRev\":3"))
        let bare = String(decoding: try JSONEncoder().encode(doc("a", 1, false)), as: UTF8.self)
        XCTAssertFalse(bare.contains("hideSiteList"), "rejtés nélkül nincs mező")
    }

    func testTurningItOnOrOffBumpsTheBlobAndTheAdoptedMarkStays() {
        var st = AppState()
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now)
        XCTAssertEqual(st.focusRev ?? 0, 0, "üres: nincs léptetés")
        st.hideSiteList = true
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now + 1)
        XCTAssertEqual(st.focusRev, 1, "a bekapcsolás döntés")
        XCTAssertEqual(st.hideSiteListRev, 1)
        XCTAssertEqual(SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now + 2), st, "változatlanul nem léptet")
        st.hideSiteList = nil
        st = SyncRevisions.bumpFocus(st, deviceId: "iphone", now: now + 3)
        XCTAssertEqual(st.focusRev, 2, "a kikapcsolás is döntés")
        XCTAssertEqual(st.hideSiteListRev, 2)
        // Másik eszközről átvett rejtés: nincs léptetés, és egy későbbi saját, más
        // szerkesztés sem bélyegzi át a jelét (azzal a másik eszköz döntését írná felül).
        st.hideSiteList = true
        st.hideSiteListRev = 7
        let adopted = SyncRevisions.adoptFocus(st)
        XCTAssertEqual(SyncRevisions.bumpFocus(adopted, deviceId: "iphone", now: now + 4).focusRev, 2, "az átvétel nem szerkesztés")
        var edited = adopted
        edited.focusPacks = [Focus.Pack(id: "p1", name: "Írás", allowSites: [], allowApps: [], defaultMinutes: 25, recurrence: nil)]
        edited = SyncRevisions.bumpFocus(edited, deviceId: "iphone", now: now + 5)
        XCTAssertEqual(edited.focusRev, 3)
        XCTAssertEqual(edited.hideSiteListRev, 7, "az átvett rejtés jele marad")
    }
}
