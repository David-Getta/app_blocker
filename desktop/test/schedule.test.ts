import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  isBlockedBySchedule, inAnyBand, isLoosening, nextCloseAt, nextOpenAt, normalizeSchedule, ALWAYS,
  type Schedule, type Band,
} from '../src/shared/schedule';

// Build a local-time instant for a given weekday + HH:MM. We pick a known
// Sunday (2024-01-07 is a Sunday) and add days, using local time so the
// schedule's local-clock logic is exercised as it will run on device.
function at(weekday: number, hh: number, mm: number): number {
  const base = new Date(2024, 0, 7, 0, 0, 0, 0); // Sun Jan 7 2024, local
  const d = new Date(base);
  d.setDate(base.getDate() + weekday);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

const workHours: Schedule = {
  mode: 'scheduled_block',
  bands: [{ days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60 }],
};

test('always mode always blocks', () => {
  assert.equal(isBlockedBySchedule(ALWAYS, at(1, 3, 0)), true);
  assert.equal(isBlockedBySchedule(ALWAYS, at(6, 23, 59)), true);
});

test('scheduled_block: inside band blocks, outside is free', () => {
  assert.equal(isBlockedBySchedule(workHours, at(1, 10, 0)), true);  // Monday 10:00
  assert.equal(isBlockedBySchedule(workHours, at(1, 8, 59)), false); // just before
  assert.equal(isBlockedBySchedule(workHours, at(1, 17, 0)), false); // end is exclusive
  assert.equal(isBlockedBySchedule(workHours, at(0, 10, 0)), false); // Sunday not in days
  assert.equal(isBlockedBySchedule(workHours, at(6, 10, 0)), false); // Saturday
});

test('scheduled_allow is the inverse of the band', () => {
  const allow: Schedule = { mode: 'scheduled_allow', bands: workHours.bands };
  assert.equal(isBlockedBySchedule(allow, at(1, 10, 0)), false); // allowed during work hours
  assert.equal(isBlockedBySchedule(allow, at(1, 20, 0)), true);  // blocked outside
  assert.equal(isBlockedBySchedule(allow, at(0, 10, 0)), true);  // blocked on Sunday
});

test('midnight-wrapping band (22:00–06:00)', () => {
  const night: Schedule = {
    mode: 'scheduled_block',
    bands: [{ days: [1], startMin: 22 * 60, endMin: 6 * 60 }], // Monday 22:00 -> Tuesday 06:00
  };
  assert.equal(isBlockedBySchedule(night, at(1, 23, 0)), true);  // Mon 23:00
  assert.equal(isBlockedBySchedule(night, at(2, 5, 0)), true);   // Tue 05:00 (wrap)
  assert.equal(isBlockedBySchedule(night, at(2, 6, 0)), false);  // Tue 06:00 end exclusive
  assert.equal(isBlockedBySchedule(night, at(1, 21, 0)), false); // Mon 21:00 before
  assert.equal(isBlockedBySchedule(night, at(2, 23, 0)), false); // Tue night not in days
});

test('inAnyBand matches isBlockedBySchedule for block mode', () => {
  assert.equal(inAnyBand(workHours.bands, at(3, 12, 0)), true);
  assert.equal(inAnyBand(workHours.bands, at(3, 18, 0)), false);
});

test('normalizeSchedule: empty/invalid collapses to always', () => {
  assert.equal(normalizeSchedule(undefined).mode, 'always');
  assert.equal(normalizeSchedule({ mode: 'scheduled_block', bands: [] }).mode, 'always');
  const badBand = { days: [9 as unknown as 0], startMin: -5, endMin: 99999 } as Band;
  assert.equal(normalizeSchedule({ mode: 'scheduled_block', bands: [badBand] }).mode, 'always');
});

test('isLoosening: tightening is free, loosening is gated', () => {
  const now = at(0, 0, 0); // start of the sampled week (Sunday 00:00)
  // always -> workHours block: frees up nights/weekends => loosening
  assert.equal(isLoosening(ALWAYS, workHours, now), true);
  // workHours -> always: never frees anything => not loosening
  assert.equal(isLoosening(workHours, ALWAYS, now), false);
  // identical schedule => not loosening
  assert.equal(isLoosening(workHours, workHours, now), false);
  // block -> allow (same bands) frees the complement => loosening
  const allow: Schedule = { mode: 'scheduled_allow', bands: workHours.bands };
  assert.equal(isLoosening(workHours, allow, now), true);
  // widening a block band (more blocked time) is tightening => not loosening
  const wider: Schedule = {
    mode: 'scheduled_block',
    bands: [{ days: [1, 2, 3, 4, 5], startMin: 8 * 60, endMin: 18 * 60 }],
  };
  assert.equal(isLoosening(workHours, wider, now), false);
  // narrowing a block band frees time => loosening
  assert.equal(isLoosening(wider, workHours, now), true);
});

test('nextOpenAt: a következő nyitás percre pontos, a sosem nyíló nulla', () => {
  // Hétköznap 9–17 tiltva (workHours). Hétfő 10:00-kor zárva → 17:00-kor nyit.
  assert.equal(nextOpenAt(workHours, at(1, 10, 0)), at(1, 17, 0));
  // Nyitott pillanatra maga a pillanat jön vissza — a hívó csak zártan kérdezi.
  const openNow = at(1, 8, 0);
  assert.equal(nextOpenAt(workHours, openNow), openNow);
  // Éjfélen átforduló sáv: szerda 22:00-tól másnap 02:00-ig tilt.
  const late: Schedule = {
    mode: 'scheduled_block',
    bands: [{ days: [3], startMin: 22 * 60, endMin: 2 * 60 }],
  };
  assert.equal(nextOpenAt(late, at(3, 23, 30)), at(4, 2, 0));
  // Fordított irány: csak vasárnap hajnal szabad — szerdától vasárnapig várat.
  const sundayOnly: Schedule = {
    mode: 'scheduled_allow',
    bands: [{ days: [0], startMin: 0, endMin: 60 }],
  };
  assert.equal(nextOpenAt(sundayOnly, at(3, 15, 0)), at(7, 0, 0));
  // A sosem nyíló menetrendnek nincs következő nyitása — se a sima tiltásnak,
  // se egy hézag nélküli sávozásnak.
  assert.equal(nextOpenAt(ALWAYS, at(1, 10, 0)), 0);
  const solid: Schedule = {
    mode: 'scheduled_block',
    bands: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }],
  };
  assert.equal(nextOpenAt(solid, at(1, 10, 0)), 0);
});

test('nextOpenAt fuzz: amit mond, az tényleg nyitás — és nem késik', () => {
  // Véletlen menetrendek százára három állítás:
  //   1. a visszaadott pillanat tényleg nyitott;
  //   2. az előtte lévő perchatár még zárt (nem késik feleslegesen);
  //   3. nulla csak akkor jön, ha a rákövetkező nyolc nap perchatárain
  //      tényleg nincs nyitás.
  // A magot kérdezzük, nem másoljuk — a fuzz pont a kézi sáv-számtan ellen véd.
  let seed = 0x5eed;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let i = 0; i < 120; i++) {
    const bands: Band[] = Array.from({ length: 1 + rnd(3) }, () => ({
      days: Array.from({ length: 1 + rnd(7) }, () => rnd(7) as 0|1|2|3|4|5|6),
      startMin: rnd(1440),
      endMin: 1 + rnd(1440),
    }));
    const s: Schedule = { mode: rnd(2) === 0 ? 'scheduled_block' : 'scheduled_allow', bands };
    const now = at(rnd(7), rnd(24), rnd(60));
    if (!isBlockedBySchedule(s, now)) continue; // csak zártan kérdezzük
    const open = nextOpenAt(s, now);
    if (open === 0) {
      for (let m = 1; m <= 8 * 24 * 60; m += 60) {
        assert.equal(isBlockedBySchedule(s, now + m * 60_000), true,
          `#${i}: nullát mondott, pedig ${m} perc múlva nyitna`);
      }
      continue;
    }
    assert.ok(open > now, `#${i}: a nyitás előttünk kell legyen`);
    assert.equal(isBlockedBySchedule(s, open), false, `#${i}: a mondott pillanat zárt`);
    // Az előtte lévő perchatár még zárt — kivéve, ha a nyitás egy percen belül van.
    if (open - now > 60_000) {
      assert.equal(isBlockedBySchedule(s, open - 60_000), true,
        `#${i}: egy perccel korábban már nyitva volt — késve szól`);
    }
  }
});

test('nextCloseAt: a nextOpenAt tükre — a szabad sáv vége percre pontos, a sosem záró nulla', () => {
  // Hétköznap 9–17 tiltva: hétfő 8:00-kor szabad → 9:00-kor zár.
  assert.equal(nextCloseAt(workHours, at(1, 8, 0)), at(1, 9, 0));
  // Péntek este szabad → a hétvégén át hétfő 9:00-ig nem zár.
  assert.equal(nextCloseAt(workHours, at(5, 18, 0)), at(8, 9, 0));
  // Zárt pillanatra maga a pillanat jön vissza; a mindig tiltó most is zár.
  const closedNow = at(1, 10, 0);
  assert.equal(nextCloseAt(workHours, closedNow), closedNow);
  assert.equal(nextCloseAt(ALWAYS, closedNow), closedNow);
  // A másodperc nem számít: a perc határán vált, ugyanott, mint a tiltás.
  assert.equal(nextCloseAt(workHours, at(1, 8, 59) + 59_000), at(1, 9, 0));
  // Egész héten szabad: sosem zár — a sor ilyenkor nem mond időpontot.
  const open: Schedule = {
    mode: 'scheduled_allow',
    bands: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }],
  };
  assert.equal(nextCloseAt(open, at(1, 10, 0)), 0);
});

test('nextCloseAt fuzz: amit mond, az tényleg zárás — és nem késik', () => {
  let seed = 0xc105e;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let checked = 0;
  for (let i = 0; i < 160; i++) {
    const bands: Band[] = Array.from({ length: 1 + rnd(3) }, () => ({
      days: Array.from({ length: 1 + rnd(7) }, () => rnd(7) as 0|1|2|3|4|5|6),
      startMin: rnd(1440),
      endMin: 1 + rnd(1440),
    }));
    const s: Schedule = { mode: rnd(2) === 0 ? 'scheduled_block' : 'scheduled_allow', bands };
    const now = at(rnd(7), rnd(24), rnd(60));
    if (isBlockedBySchedule(s, now)) continue; // csak szabadon kérdezzük
    checked++;
    const close = nextCloseAt(s, now);
    if (close === 0) {
      for (let m = 1; m <= 8 * 24 * 60; m += 60) {
        assert.equal(isBlockedBySchedule(s, now + m * 60_000), false,
          `#${i}: nullát mondott, pedig ${m} perc múlva zárna`);
      }
      continue;
    }
    assert.ok(close > now, `#${i}: a zárás előttünk kell legyen`);
    assert.equal(isBlockedBySchedule(s, close), true, `#${i}: a mondott pillanat szabad`);
    if (close - now > 60_000) {
      assert.equal(isBlockedBySchedule(s, close - 60_000), false,
        `#${i}: egy perccel korábban már zárt — késve szól`);
    }
  }
  assert.ok(checked > 20, 'kevés szabad eset — a fuzz nem mér semmit');
});

test('a dróton jött rosszul formált menetrend nem dönti le a döntést — mindig tiltva', () => {
  // A szinkron nyers objektumot ad; eddig a `bands: "x"` és a `null` sáv
  // kivételt dobott (a `filter` nem függvény, a `null.days`), és a döntés meg a
  // fésülés is elhasalt rajta. Most a bizonytalanság a tiltás felé dől.
  const now = Date.UTC(2026, 8, 7, 12, 0);
  const junk: unknown[] = [
    { mode: 'scheduled_allow', bands: 'x' },
    { mode: 'scheduled_allow', bands: [null] },
    { mode: 'scheduled_allow', bands: [5, 'x', []] },
    { mode: 'scheduled_allow' },
    'x', 5, [],
  ];
  for (const s of junk) {
    assert.deepEqual(normalizeSchedule(s as Schedule), ALWAYS, JSON.stringify(s));
    assert.equal(isBlockedBySchedule(s as Schedule, now), true, JSON.stringify(s));
  }
});
