import Foundation

/// A fuzz-tesztek MÉLYSÉGE — a gép desktop/test/fuzz-depth.ts párja. Alapból a
/// megszokott magszám fut; `FUZZ_DEPTH=k` mellett a k-szorosa (a magok
/// ugyanazok, 1-től felfelé — egy mély futás bukása visszajátszható).
func fuzzSeeds(_ base: Int) -> Int {
    guard let raw = ProcessInfo.processInfo.environment["FUZZ_DEPTH"], let k = Double(raw), k.isFinite, k > 1 else {
        return base
    }
    return Int((Double(base) * k).rounded())
}
