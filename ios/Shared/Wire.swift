import Foundation

// A DRÓTON JÖTT JSON tűrő olvasása — a gép szabálya szerint.
//
// A Swift `Codable` egy rossz típusú mezőre vagy egy rossz elemre az EGÉSZ
// dekódolást eldobja: egyetlen hibás csomag vagy oldal-rekord az egész listát
// vitte, és a kör üresnek látta a kiszolgálót. A gép és az Android rekordonként
// tűr: a rossz elem kiesik, a rossz típusú mező az alapértékét kapja (csak
// JSON-szám a szám, csak szöveg a szöveg, csak igaz az igaz). Ezek a segédek
// ugyanezt adják; a közös fixtúra (fixtures/wire-cases.json) kimondja.

/// Egy elem, ami nem dekódolható, nil lesz — a lista többi eleme marad.
struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

extension KeyedDecodingContainer {
    /// A mező, ha megvan és jó a típusa; különben nil — a rossz típus hiány, nem hiba.
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        (try? decodeIfPresent(type, forKey: key)) ?? nil
    }

    /// Elem-lista: a nem dekódolható elem kiesik; ha a mező nem lista, üres.
    func lossyArray<T: Decodable>(_ type: T.Type, _ key: Key) -> [T] {
        (lenient([Lossy<T>].self, key) ?? []).compactMap { $0.value }
    }

    /// Szöveg-lista: a nem szöveg elem kiesik; ha a mező nem lista, üres.
    func lossyStrings(_ key: Key) -> [String] {
        lossyArray(String.self, key)
    }

    /// Egész értékű térkép (a jelek): a nem egész érték kiesik, a többi marad;
    /// ha a mező nem objektum, nil.
    func lossyIntMap(_ key: Key) -> [String: Int]? {
        lenient([String: Lossy<Int>].self, key)?.compactMapValues { $0.value }
    }
}
