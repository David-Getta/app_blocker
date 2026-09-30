import Foundation
import XCTest
@testable import BreakerShared

// Fedőnév: a LEVÉTEL felfed, az átnevezés nem — egy szabály, a három felületé.
// A desktop/test/alias.test.ts és az androidos AliasTest párja: a szabály a
// magban él, nem három felületen három változatban.
final class AliasTests: XCTestCase {

    func testRemovingTheAliasIsARevealRenamingIsNot() {
        // Volt név, és a következő érték már nem az: ez a levétel.
        XCTAssertTrue(AliasLogic.isRemoval("A videós", ""))
        XCTAssertTrue(AliasLogic.isRemoval("A videós", "   "))
        XCTAssertTrue(AliasLogic.isRemoval("A videós", nil))
        // Átnevezés: név → másik név. Nem fed fel.
        XCTAssertFalse(AliasLogic.isRemoval("A videós", "A másik"))
        XCTAssertFalse(AliasLogic.isRemoval("A videós", "A videós"))
        // Nem volt név: sem a beállítás, sem az üresen hagyás nem levétel.
        XCTAssertFalse(AliasLogic.isRemoval(nil, "A videós"))
        XCTAssertFalse(AliasLogic.isRemoval(nil, ""))
        XCTAssertFalse(AliasLogic.isRemoval("   ", ""), "a csupa szóköz sosem volt név")
    }
}
