// Megfelelőségi fixture: a három nyelv UGYANAZT fésüli össze ugyanabból.
//
// A fuzz-tesztek nyelvenként azt nézik, hogy a saját szabályaik sorrendtől
// függetlenek. Ez a fájl azt, hogy a Kotlin- és a Swift-tükör ugyanazt az
// eredményt adja, mint a gép: a `fixtures/merge-cases.json` a gép által
// kiszámolt bemeneteket és eredmény-kulcsokat tartja, a Kotlin
// (MergeFixtureTest) és a Swift (MergeFixtureTests) teszt ugyanezt a fájlt
// olvassa, a saját összefésülésével számol, és a kulcsot hasonlítja.
//
// A fixture-t EZ a teszt írja, és ez őrzi: ha a szabály itt változik, a fájl
// elavul, és a teszt megmondja, hogyan kell frissíteni. Ha a fájl frissül, a
// másik két nyelv tesztje mutatja meg, hol csúszott el a tükör.
//
//   UPDATE_MERGE_FIXTURE=1 npm test     — a fájl újraírása

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergeSite } from '../src/shared/sync/merge';
import { mergeFocus } from '../src/shared/sync/focus-merge';
import {
  DEVICES, focusConformanceKey, randomFocus, randomSite, rng, siteConformanceKey,
} from './merge-random';

/** dist-test/test/… → a tároló gyökere. */
const FIXTURE = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'merge-cases.json');
const SEEDS = 80;

function buildFixture(): { note: string; version: number; sites: unknown[]; focus: unknown[] } {
  const sites: unknown[] = [];
  const focus: unknown[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const [a, b, c] = DEVICES.map((d) => randomSite(r, d));
    const ab = mergeSite(a, b);
    sites.push({ seed, a, b, c, ab: siteConformanceKey(ab), abc: siteConformanceKey(mergeSite(ab, c)) });
  }
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const [a, b, c] = DEVICES.map((d) => randomFocus(r, d));
    const ab = mergeFocus(a, b);
    focus.push({ seed, a, b, c, ab: focusConformanceKey(ab), abc: focusConformanceKey(mergeFocus(ab, c)) });
  }
  return {
    note: 'Generálja és őrzi: desktop/test/merge-fixture.test.ts (UPDATE_MERGE_FIXTURE=1 npm test). '
      + 'Olvassa: android/jvm-tests MergeFixtureTest, ios/SharedTests MergeFixtureTests.',
    version: 1,
    sites,
    focus,
  };
}

/** Esetenként egy sor: olvasható diff, mégis kompakt fájl. */
function render(f: { note: string; version: number; sites: unknown[]; focus: unknown[] }): string {
  const rows = (items: unknown[]) => items.map((x) => ' ' + JSON.stringify(x)).join(',\n');
  return `{\n"note": ${JSON.stringify(f.note)},\n"version": ${f.version},\n`
    + `"sites": [\n${rows(f.sites)}\n],\n"focus": [\n${rows(f.focus)}\n]\n}\n`;
}

test('a megfelelőségi fixture a gép szabályaival egyezik (a Kotlin és a Swift ebből dolgozik)', () => {
  const built = render(buildFixture());
  if (process.env.UPDATE_MERGE_FIXTURE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, built);
    return;
  }
  assert.ok(fs.existsSync(FIXTURE), `nincs fixture: ${FIXTURE} — UPDATE_MERGE_FIXTURE=1 npm test`);
  const onDisk = fs.readFileSync(FIXTURE, 'utf8');
  assert.equal(
    onDisk, built,
    'a fixtures/merge-cases.json elavult a gép szabályaihoz képest — UPDATE_MERGE_FIXTURE=1 npm test, '
    + 'aztán a Kotlin- és Swift-teszt mutatja meg, követi-e a tükör',
  );
});
