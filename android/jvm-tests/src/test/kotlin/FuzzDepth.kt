/**
 * A fuzz-tesztek MÉLYSÉGE — a gép desktop/test/fuzz-depth.ts párja. Alapból a
 * megszokott magszám fut; `FUZZ_DEPTH=k` mellett a k-szorosa (a magok
 * ugyanazok, 1-től felfelé — egy mély futás bukása visszajátszható):
 *
 *   FUZZ_DEPTH=100 gradle test --tests MergeFuzzTest
 */
internal fun fuzzSeeds(base: Int): Int {
    val k = System.getenv("FUZZ_DEPTH")?.toDoubleOrNull() ?: return base
    return if (k.isFinite() && k > 1) Math.round(base * k).toInt() else base
}
