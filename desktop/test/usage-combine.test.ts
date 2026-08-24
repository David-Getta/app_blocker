// Több eszköz mérése együtt.
//
// A kérdés, ami tényleg számít, nem az eszközönkénti bontás: nem az, hogy
// mennyi ment el YouTube-ra a gépen, hanem hogy MENNYI MENT EL ÖSSZESEN. Ha ez
// a szám hibás, az app pont arról hazudik, amiért létezik.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  combineUsage, dayKey, dayKeysBack, rank, summarize, totalsForDays,
  type UsageState,
} from '../src/shared/usage';

function st(days: Record<string, Record<string, number>>,
            labels: Record<string, string> = {}, enabled = true): UsageState {
  return {
    days: Object.entries(days).map(([day, seconds]) => ({ day, seconds })),
    labels, enabled,
  };
}

const NOW = Date.UTC(2026, 7, 24, 10, 0, 0);
const TODAY = dayKey(NOW);
const YESTERDAY = dayKeysBack(NOW, 2)[0];

test('the same site on two devices adds up', () => {
  const combined = combineUsage([
    st({ [TODAY]: { 'site:youtube.com': 1200 } }),
    st({ [TODAY]: { 'site:youtube.com': 900 } }),
  ]);
  assert.equal(totalsForDays(combined, [TODAY])['site:youtube.com'], 2100);
});

test('the summary of the combined state is the sum of the devices', () => {
  // Ugyanaz a `summarize` fut rajta, mint a helyi nézeten — szándékosan. Egy
  // második összegző implementáció előbb-utóbb más számot mutatna ugyanarra a
  // kérdésre.
  const a = st({ [TODAY]: { 'site:youtube.com': 600 }, [YESTERDAY]: { 'site:reddit.com': 300 } });
  const b = st({ [TODAY]: { 'site:reddit.com': 400 } });
  const sum = summarize(combineUsage([a, b]), NOW);
  assert.equal(sum.todaySeconds, 1000);
  assert.equal(sum.last7Seconds, 1300);
  assert.equal(summarize(a, NOW).todaySeconds + summarize(b, NOW).todaySeconds, sum.todaySeconds);
});

test('two apps stay two rows, one site becomes one row', () => {
  // A `site:` kulcs minden platformon azonos, tehát a weboldal tényleg
  // összeadódik. A telefonos és a gépes böngésző viszont KÉT app — az, hogy
  // nem olvadnak össze, helyes: nem ugyanaz a program.
  const combined = combineUsage([
    st({ [TODAY]: { 'site:youtube.com': 100, 'app:com.google.Chrome': 500 } },
        { 'app:com.google.Chrome': 'Google Chrome' }),
    st({ [TODAY]: { 'site:youtube.com': 100, 'app:com.android.chrome': 700 } },
        { 'app:com.android.chrome': 'Chrome' }),
  ]);
  const rows = rank(combined, totalsForDays(combined, [TODAY]));
  assert.deepEqual(rows.map((r) => [r.key, r.seconds]), [
    ['app:com.android.chrome', 700],
    ['app:com.google.Chrome', 500],
    ['site:youtube.com', 200],
  ]);
});

test('the label comes from where the target was actually used, not from call order', () => {
  // Ha a sorrend döntene, ugyanaz a nézet más címkét mutatna attól függően,
  // melyik eszköz válaszolt előbb a hálózaton.
  const little = st({ [TODAY]: { 'app:x': 10 } }, { 'app:x': 'kevés' });
  const much = st({ [TODAY]: { 'app:x': 9000 } }, { 'app:x': 'sok' });
  assert.equal(combineUsage([little, much]).labels['app:x'], 'sok');
  assert.equal(combineUsage([much, little]).labels['app:x'], 'sok');
});

test('a device that is not measuring does not zero out the others', () => {
  // Ha a helyi kapcsoló ki van kapcsolva, az összesített szám attól még valódi:
  // a telefon mérte, és a felhasználó ideje elment.
  const off = st({}, {}, false);
  const on = st({ [TODAY]: { 'site:youtube.com': 60 } }, {}, true);
  assert.equal(combineUsage([off, on]).enabled, true);
  assert.equal(combineUsage([off, off]).enabled, false);
  assert.equal(summarize(combineUsage([off, on]), NOW).todaySeconds, 60);
});

test('junk from another device does not corrupt the total', () => {
  // A blobok egy MÁSIK eszközről, egy kiszolgálón át érkeznek. Egyetlen hibás
  // rekord nem viheti el az egész összesítést.
  const broken = {
    days: [
      null,
      { day: TODAY, seconds: { 'site:a.com': 'sok' } },
      { day: 12345, seconds: { 'site:a.com': 5 } },
      { day: TODAY, seconds: { 'site:a.com': -100, 'site:b.com': NaN, 'site:c.com': 7 } },
    ],
    labels: null,
  } as unknown as UsageState;
  const combined = combineUsage([broken, st({ [TODAY]: { 'site:a.com': 30 } })]);
  const totals = totalsForDays(combined, [TODAY]);
  assert.equal(totals['site:a.com'], 30, 'a szemét kiesik, a valódi megmarad');
  assert.equal(totals['site:c.com'], 7);
  assert.equal(totals['site:b.com'], undefined);
  assert.equal(combineUsage([]).days.length, 0);
  assert.equal(combineUsage([undefined as unknown as UsageState]).days.length, 0);
});

test('the days come back in order, because the charts assume it', () => {
  const combined = combineUsage([
    st({ '2026-08-20': { 'site:a.com': 1 }, '2026-08-24': { 'site:a.com': 1 } }),
    st({ '2026-08-22': { 'site:a.com': 1 } }),
  ]);
  assert.deepEqual(combined.days.map((d) => d.day), ['2026-08-20', '2026-08-22', '2026-08-24']);
});
