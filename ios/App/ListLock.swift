import Foundation
import LocalAuthentication

/// A LISTA ZÁRJA: a rejtett blokklista felfedése a készülék azonosítását kéri —
/// Face ID, Touch ID vagy a készülék kódja. A rejtés eddig csak nem
/// emlékeztetett; ettől VÉD is: aki a kezébe veszi a telefont, nem koppint rá
/// egy gombra, hogy lássa, mi ellen küzdesz.
///
/// Az azonosítás a rendszeré (LocalAuthentication): mi nem látunk se arcot, se
/// kódot, csak egy igen/nem választ. Ahol nincs kód beállítva, nincs mit kérni —
/// ezt kimondjuk, nem tettetjük.
///
/// A rejtés egy koppintás (szigorítás), a felfedés nem az: a híd befelé csak
/// szigorít, a lazítás munkába kerül — itt a munka a saját arcod, ujjad vagy kódod.
enum ListLock {
    enum Outcome {
        case granted
        /// nincs mivel azonosítani (nincs kód beállítva): a lista kérésre megnyílik, és kimondjuk
        case unavailable
        /// elutasítva, hiba vagy megszakítás — az ok szövegével, vagy üresen, ha csak bezárta
        case denied(String)
    }

    static let unavailableNote = "Ezen a készüléken nincs kód beállítva, így nincs mivel azonosítani — a lista kérésre megnyílik. Ha kódot állítasz be, ezt fogja kérni."
    static let deniedNote = "Nem sikerült az azonosítás — a lista rejtve marad."
    /// Ugyanaz a zár a fedőnév mögé bújt valódi cím előtt.
    static let aliasUnavailableNote = "Ezen a készüléken nincs kód beállítva, így nincs mivel azonosítani — a valódi cím kérésre előjön. Ha kódot állítasz be, ezt fogja kérni."
    static let aliasDeniedNote = "Nem sikerült az azonosítás — a valódi cím rejtve marad."

    /// Van-e MIVEL azonosítani: biometria vagy készülékkód.
    static func canAuthenticate() -> Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    /// A rendszer azonosító párbeszéde; a válasz mindig a fő szálon jön.
    static func prompt(reason: String, completion: @escaping (Outcome) -> Void) {
        let ctx = LAContext()
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else {
            completion(.unavailable)
            return
        }
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, err in
            DispatchQueue.main.async {
                if ok { completion(.granted); return }
                let code = (err as? LAError)?.code
                let cancelled = code == .userCancel || code == .appCancel || code == .systemCancel
                completion(.denied(cancelled ? "" : (err?.localizedDescription ?? "")))
            }
        }
    }
}
