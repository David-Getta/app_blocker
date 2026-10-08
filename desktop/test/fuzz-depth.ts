// A fuzz-tesztek MÉLYSÉGE.
//
// Alapból a megszokott magszám fut: a CI-ban és helyben is gyorsan. Egy ritka
// sorrendfüggést viszont ennyi mag nem mindig fog meg — az ablakos csomagok
// fésülésének hibáját a 300 magos futás átengedte, egy százezres megfogta.
// `FUZZ_DEPTH=k` mellett minden fuzz a magszám k-szorosát futtatja:
//
//   FUZZ_DEPTH=100 node --test dist-test/test/merge-fuzz.test.js
//
// A magok ugyanazok (1-től felfelé), tehát egy mély futás bukása a magjával
// a rendes futásban is visszajátszható.

/** A fuzz magszáma: az alap, vagy `FUZZ_DEPTH` mellett annak többszöröse. */
export function fuzzSeeds(base: number): number {
  const k = Number(process.env.FUZZ_DEPTH);
  return Number.isFinite(k) && k > 1 ? Math.round(base * k) : base;
}
