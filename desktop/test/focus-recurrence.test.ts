// Ismétlődő munkamenet: az ablak az ígéret, a napló az őr.
//
// A csomag heti ablakában a menet magától indul — a gépen és a telefonon is.
// Két dolog nem csúszhat el: (1) minden eszköz UGYANAZT a menetet állítsa elő
// (kanonikus kezdés = az ablak kezdete), különben a szinkron duplázna; (2) a
// próbatétellel leállított menet ne induljon újra egy perc múlva, különben a
// leállítás próbatétele semmit sem érne.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  dueRecurrence, isRecurrenceLoosening, isWindowRun, nextOccurrence, normalizeRecurrence,
  occurrenceAt, RECURRENCE_MIN_REMAINING_MS, type FocusLogEntry, type FocusPack,
} from '../src/shared/focus';
import type { Band, Weekday } from '../src/shared/schedule';
import { defaultState, type HelperState } from '../src/helper/state';
import {
  changeFocus, saveFocusPack, setFocusRecurrence, startFocus, submitAnswer, tick,
} from '../src/helper/referee';
import { bumpFocusRevision } from '../src/helper/revisions';
import { sameFocus, type SyncFocus } from '../src/shared/sync/focus-merge';
import type { Step, MathChainStep, MemoryStep, ReverseStep, TranscribeStep } from '../src/shared/challenges';
import { reverseString } from '../src/shared/challenges';

/** Helyi idő — a mag is helyi időben gondolkodik, mint az oldalak menetrendje. */
const at = (y: number, m: number, d: number, hh: number, mm: number): number =>
  new Date(y, m - 1, d, hh, mm).getTime();

// 2026. szeptember 7. hétfő.
const MON = (hh: number, mm = 0): number => at(2026, 9, 7, hh, mm);
const TUE = (hh: number, mm = 0): number => at(2026, 9, 8, hh, mm);
const SUN = (hh: number, mm = 0): number => at(2026, 9, 6, hh, mm);

const WEEKDAYS: Band = { days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 12 * 60 };
/** hétfő este → kedd hajnal */
const NIGHT: Band = { days: [1], startMin: 22 * 60, endMin: 6 * 60 };

const pack = (over: Partial<FocusPack> = {}): FocusPack => ({
  id: 'p1', name: 'Mély munka', allowSites: ['github.com'], allowApps: [], defaultMinutes: 50,
  recurrence: WEEKDAYS, ...over,
});

const log = (over: Partial<FocusLogEntry> = {}): FocusLogEntry => ({
  packId: 'p1', packName: 'Mély munka', startedAt: MON(9), endedAt: MON(9, 40),
  plannedEndsAt: MON(12), stopped: true, ...over,
});

// ------------------------------------------------------------------ a mag

test('occurrenceAt: az aznapi ablak kezdése és vége, helyi időben', () => {
  assert.deepEqual(occurrenceAt(WEEKDAYS, MON(9, 30)), { startsAt: MON(9), endsAt: MON(12) });
  assert.deepEqual(occurrenceAt(WEEKDAYS, MON(9)), { startsAt: MON(9), endsAt: MON(12) },
    'a kezdés perce benne van');
  assert.equal(occurrenceAt(WEEKDAYS, MON(12)), null, 'a vég perce már nincs');
  assert.equal(occurrenceAt(WEEKDAYS, MON(8, 59)), null);
  assert.equal(occurrenceAt(WEEKDAYS, SUN(10)), null, 'vasárnap nem');
});

test('occurrenceAt: az éjfélen átnyúló ablak a következő hajnalt is fedi', () => {
  assert.deepEqual(occurrenceAt(NIGHT, MON(23)), { startsAt: MON(22), endsAt: TUE(6) });
  assert.deepEqual(occurrenceAt(NIGHT, TUE(1)), { startsAt: MON(22), endsAt: TUE(6) },
    'kedd hajnal — a hétfői ablak');
  assert.equal(occurrenceAt(NIGHT, TUE(23)), null, 'kedd este már nem');
});

test('dueRecurrence: az ablakban indul, az ablak kezdésével és végével', () => {
  const due = dueRecurrence([pack()], null, [], MON(9, 30));
  assert.ok(due);
  assert.equal(due.pack.id, 'p1');
  assert.equal(due.startsAt, MON(9), 'a kezdés az ablaké, nem a mostani perc');
  assert.equal(due.endsAt, MON(12));
  assert.equal(dueRecurrence([pack()], null, [], MON(8)), null, 'ablakon kívül nem');
  assert.equal(dueRecurrence([pack({ recurrence: undefined })], null, [], MON(9, 30)), null,
    'ablak nélkül nem');
});

test('dueRecurrence: futó menet mellett nem indul — egyszerre egy', () => {
  const run = { packId: 'p2', startedAt: MON(9), endsAt: MON(10) };
  assert.equal(dueRecurrence([pack()], run, [], MON(9, 30)), null);
  assert.ok(dueRecurrence([pack()], { ...run, endsAt: MON(9, 20) }, [], MON(9, 30)),
    'a lejárt menet nem számít');
});

test('dueRecurrence: a napló az őr — ami ebben az ablakban indult, nem indul újra', () => {
  assert.equal(dueRecurrence([pack()], null, [log()], MON(9, 41)), null,
    'a leállítás után nem indul újra');
  assert.ok(dueRecurrence([pack()], null, [log({ startedAt: MON(8, 30), endedAt: MON(9, 30), stopped: false })], MON(9, 31)),
    'az ablak ELŐTT kezdett kézi menet nem fogyasztja el az ablakot');
  assert.ok(dueRecurrence([pack()], null, [log({ packId: 'p2' })], MON(9, 41)),
    'másik csomag naplója nem számít');
  assert.ok(dueRecurrence([pack()], null, [log()], TUE(9, 30)), 'másnap újra indul');
});

test('dueRecurrence: egy percnél kevesebb hátralévő idővel nem indul', () => {
  assert.equal(dueRecurrence([pack()], null, [], MON(12) - RECURRENCE_MIN_REMAINING_MS + 1), null);
  assert.ok(dueRecurrence([pack()], null, [], MON(12) - RECURRENCE_MIN_REMAINING_MS));
});

test('dueRecurrence: több esedékes ablak közül determinisztikusan választ', () => {
  const later = pack({ id: 'b-later', recurrence: { days: [1], startMin: 9 * 60 + 30, endMin: 12 * 60 } });
  const earlier = pack({ id: 'a-earlier' });
  assert.equal(dueRecurrence([later, earlier], null, [], MON(10))!.pack.id, 'a-earlier', 'a korábban kezdődő');
  const same = pack({ id: 'zz' });
  assert.equal(dueRecurrence([same, earlier], null, [], MON(10))!.pack.id, 'a-earlier',
    'azonos kezdésnél a kisebb azonosító — minden eszköz ugyanazt választja');
});

test('nextOccurrence: a mostani ablak, különben a legközelebbi kezdés', () => {
  assert.deepEqual(nextOccurrence(WEEKDAYS, MON(10)), { startsAt: MON(9), endsAt: MON(12) }, 'benne vagyunk');
  assert.deepEqual(nextOccurrence(WEEKDAYS, MON(13)), { startsAt: TUE(9), endsAt: TUE(12) }, 'holnap');
  assert.deepEqual(nextOccurrence(WEEKDAYS, at(2026, 9, 11, 13, 0)), { startsAt: at(2026, 9, 14, 9, 0), endsAt: at(2026, 9, 14, 12, 0) },
    'péntek délután → hétfő');
  assert.deepEqual(nextOccurrence(WEEKDAYS, SUN(10)), { startsAt: MON(9), endsAt: MON(12) }, 'vasárnap → hétfő');
  assert.deepEqual(nextOccurrence(NIGHT, TUE(1)), { startsAt: MON(22), endsAt: TUE(6) }, 'a hajnal a hétfői ablak');
  assert.deepEqual(nextOccurrence(NIGHT, TUE(7)), { startsAt: at(2026, 9, 14, 22, 0), endsAt: at(2026, 9, 15, 6, 0) },
    'kedd reggel → jövő hétfő este');
});

test('isWindowRun: az ablak menete igen; a kézi és a meghosszabbított nem', () => {
  const packs = [pack()];
  assert.equal(isWindowRun({ packId: 'p1', startedAt: MON(9), endsAt: MON(12) }, packs), true);
  assert.equal(isWindowRun({ packId: 'p1', startedAt: MON(9), endsAt: MON(12, 30) }, packs), false,
    'meghosszabbítva már a hossz számít');
  assert.equal(isWindowRun({ packId: 'p1', startedAt: MON(9, 5), endsAt: MON(12) }, packs), false,
    'kézi indítás az ablakban');
  assert.equal(isWindowRun({ packId: 'p1', startedAt: MON(9), endsAt: MON(12) },
    [pack({ recurrence: undefined })]), false);
});

test('normalizeRecurrence: érvényes sáv, legfeljebb nyolc óra, rendezett napok', () => {
  assert.deepEqual(normalizeRecurrence({ days: [5, 1, 1], startMin: 540, endMin: 720 }),
    { days: [1, 5], startMin: 540, endMin: 720 });
  assert.equal(normalizeRecurrence({ days: [], startMin: 540, endMin: 720 }), undefined, 'nap nélkül nem');
  assert.equal(normalizeRecurrence({ days: [1], startMin: 0, endMin: 1440 }), undefined,
    'huszonnégy óra nem munkamenet, hanem kikapcsolhatatlan fehérlista');
  assert.deepEqual(normalizeRecurrence({ days: [1], startMin: 22 * 60, endMin: 6 * 60 }),
    { days: [1], startMin: 1320, endMin: 360 }, 'éjfélen át: nyolc óra, fér');
  assert.equal(normalizeRecurrence({ days: [1], startMin: 22 * 60, endMin: 6 * 60 + 1 }), undefined,
    'nyolc óra egy perc már nem');
  assert.equal(normalizeRecurrence(null), undefined);
  assert.equal(normalizeRecurrence({ days: [7], startMin: 1, endMin: 2 }), undefined, 'nyolcadik nap nincs');
});

test('isRecurrenceLoosening: felvenni és bővíteni nem, szűkíteni és levenni igen', () => {
  const now = MON(8);
  assert.equal(isRecurrenceLoosening(undefined, WEEKDAYS, now), false, 'felvétel');
  assert.equal(isRecurrenceLoosening(WEEKDAYS, undefined, now), true, 'levétel');
  assert.equal(isRecurrenceLoosening(WEEKDAYS, { ...WEEKDAYS, endMin: 13 * 60 }, now), false, 'bővítés');
  assert.equal(isRecurrenceLoosening(WEEKDAYS, { ...WEEKDAYS, endMin: 11 * 60 }, now), true, 'szűkítés');
  assert.equal(isRecurrenceLoosening(WEEKDAYS, { ...WEEKDAYS, days: [1, 2, 3, 4] }, now), true,
    'egy nap kivétele');
  assert.equal(isRecurrenceLoosening(WEEKDAYS,
    { days: [1, 2, 3, 4, 5], startMin: 13 * 60, endMin: 16 * 60 }, now), true,
  'eltolás: a reggel szabad lenne');
});

// -------------------------------------------------------------- a referee

const NOW = MON(8);
const BASE: FocusPack = {
  id: 'p1', name: 'Mély munka', allowSites: ['github.com'], allowApps: [], defaultMinutes: 50,
};

function stateWithPack(): HelperState {
  const st = defaultState();
  saveFocusPack(st, BASE, NOW);
  return st;
}

function solveStep(step: Step, now: number): string {
  switch (step.type) {
    case 'TRANSCRIBE': return (step as TranscribeStep).text;
    case 'MATH_CHAIN': {
      const m = step as MathChainStep;
      return String(m.problems[m.pos].a);
    }
    case 'MEMORY': {
      const m = step as MemoryStep;
      m.armedAt = now - m.showMs - m.waitMs - 1000;
      return m.code;
    }
    case 'REVERSE': return reverseString((step as ReverseStep).text);
    case 'DELAY': throw new Error('a várakozást átvenni kell, nem megválaszolni');
  }
}

function solveWholeSession(state: HelperState, now: number): void {
  let guard = 0;
  while (state.session && guard++ < 200) {
    const step = state.session.steps[state.session.stepIndex];
    submitAnswer(state, state.session.id, solveStep(step, now), now);
  }
}

const recurrenceOf = (st: HelperState): Band | undefined => st.focusPacks![0].recurrence;

test('az ablak felvétele és bővítése ingyen, a szűkítése és levétele próbatétel', () => {
  const st = stateWithPack();
  assert.equal(setFocusRecurrence(st, 'p1', WEEKDAYS, NOW).applied, true, 'felvétel');
  assert.deepEqual(recurrenceOf(st), WEEKDAYS);
  assert.equal(setFocusRecurrence(st, 'p1', { ...WEEKDAYS, endMin: 13 * 60 }, NOW).applied, true, 'bővítés');
  const narrow = setFocusRecurrence(st, 'p1', WEEKDAYS, NOW);
  assert.equal(narrow.applied, false, 'szűkítés');
  assert.ok(narrow.session, 'próbatétel indul');
  assert.equal(recurrenceOf(st)!.endMin, 13 * 60, 'amíg a próbatétel tart, az ablak marad');
  assert.throws(() => setFocusRecurrence(st, 'p1', null, NOW), /folyamatban/);
  assert.throws(() => setFocusRecurrence(st, 'nincs', WEEKDAYS, NOW), /Ismeretlen/);
});

test('érvénytelen ablak és a saját maga: hiba, illetve nincs teendő', () => {
  const st = stateWithPack();
  assert.throws(() => setFocusRecurrence(st, 'p1', { days: [], startMin: 540, endMin: 720 }, NOW), /legalább egy nap/);
  setFocusRecurrence(st, 'p1', WEEKDAYS, NOW);
  const same = setFocusRecurrence(st, 'p1', { days: [5, 4, 3, 2, 1], startMin: 540, endMin: 720 }, NOW);
  assert.equal(same.applied, true);
  assert.equal(same.session, null, 'ugyanaz más sorrendben: nem indul próbatétel');
});

test('a levétel próbatétele a teljesítéskor veszi le az ablakot', () => {
  const st = stateWithPack();
  setFocusRecurrence(st, 'p1', WEEKDAYS, NOW);
  const r = setFocusRecurrence(st, 'p1', null, NOW);
  assert.equal(r.applied, false);
  assert.deepEqual(recurrenceOf(st), WEEKDAYS, 'a próbatétel alatt még megvan');
  solveWholeSession(st, NOW);
  assert.equal(st.session, null);
  assert.equal(recurrenceOf(st), undefined, 'a teljesítés veszi le');
});

test('a Mentés ingyenes útján az ablak nem változik — a kapu a setFocusRecurrence', () => {
  const st = stateWithPack();
  setFocusRecurrence(st, 'p1', WEEKDAYS, NOW);
  saveFocusPack(st, { ...BASE, name: 'Átnevezve' }, NOW);
  assert.deepEqual(recurrenceOf(st), WEEKDAYS, 'ablak nélküli mentés nem veszi le');
  saveFocusPack(st, { ...BASE, name: 'Átnevezve', recurrence: { ...WEEKDAYS, endMin: 10 * 60 } }, NOW);
  assert.deepEqual(recurrenceOf(st), WEEKDAYS, 'a mentéssel küldött szűkebb ablak nem érvényesül');
  assert.equal(st.focusPacks![0].name, 'Átnevezve', 'a többi mező viszont menthető');
});

test('a futó csomag ablaka is befagy', () => {
  const st = stateWithPack();
  startFocus(st, 'p1', 50, NOW);
  assert.throws(() => setFocusRecurrence(st, 'p1', WEEKDAYS, NOW), /épp fut/);
});

test('a tick az ablakban magától indítja a menetet, az ablak idejével', () => {
  const st = stateWithPack();
  setFocusRecurrence(st, 'p1', WEEKDAYS, NOW);
  assert.equal(tick(st, MON(8, 59)), false);
  assert.ok(!st.focusRun, 'az ablak előtt semmi');
  assert.equal(tick(st, MON(9, 30)), true, 'változott: menteni és alkalmazni kell');
  assert.deepEqual(st.focusRun, { packId: 'p1', startedAt: MON(9), endsAt: MON(12) });
});

test('a próbatétellel leállított ablak-menet nem indul újra ugyanabban az ablakban', () => {
  const st = stateWithPack();
  setFocusRecurrence(st, 'p1', WEEKDAYS, NOW);
  tick(st, MON(9, 30));
  const stop = changeFocus(st, null, MON(9, 40));
  assert.equal(stop.applied, false, 'a leállítás próbatétel');
  solveWholeSession(st, MON(9, 40));
  assert.equal(st.focusRun, null);
  assert.equal(st.focusLog!.at(-1)!.stopped, true);
  tick(st, MON(9, 45));
  assert.equal(st.focusRun, null, 'a napló az őr');
  tick(st, TUE(9, 30));
  assert.deepEqual(st.focusRun, { packId: 'p1', startedAt: TUE(9), endsAt: TUE(12) }, 'másnap újra');
});

test('a magától lejárt ablak-menet a naplóba kerül, az ablak idejével', () => {
  const st = stateWithPack();
  setFocusRecurrence(st, 'p1', WEEKDAYS, NOW);
  tick(st, MON(9, 30));
  tick(st, MON(12, 0, ));
  assert.equal(st.focusRun, null);
  const row = st.focusLog!.at(-1)!;
  assert.equal(row.startedAt, MON(9));
  assert.equal(row.endedAt, MON(12));
  assert.equal(row.stopped, false);
});

test('az óra-ugrás elnyelése az ablak-menetet nem tolja el, a kézit igen', () => {
  const st = stateWithPack();
  setFocusRecurrence(st, 'p1', WEEKDAYS, NOW);
  tick(st, MON(9, 30));
  // Egy órás lyuk a körök között: alvás vagy átállított óra — a segéd nem
  // tudja, és nem is kell tudnia.
  tick(st, MON(10, 30));
  assert.deepEqual(st.focusRun, { packId: 'p1', startedAt: MON(9), endsAt: MON(12) },
    'az ablak vége az ablak vége');

  const manual = stateWithPack();
  startFocus(manual, 'p1', 50, MON(13));
  tick(manual, MON(13, 1));
  tick(manual, MON(14, 1));
  assert.ok(manual.focusRun!.endsAt > MON(13, 50), 'a kézi menet hossza megmarad: eltolódik');
});

test('az ablak cseréje lépteti a számlálót, és a szinkron látja a különbséget', () => {
  const st = stateWithPack();
  bumpFocusRevision(st, 'gep', NOW);
  const before = st.focusRev;
  setFocusRecurrence(st, 'p1', WEEKDAYS, NOW);
  assert.equal(bumpFocusRevision(st, 'gep', NOW + 1), true, 'döntés történt');
  assert.equal(st.focusRev, (before ?? 0) + 1);

  const a: SyncFocus = { packs: [BASE], run: null, log: [], rev: 1, updatedAt: 1, updatedBy: 'a' };
  const b: SyncFocus = { ...a, packs: [{ ...BASE, recurrence: WEEKDAYS }] };
  assert.equal(sameFocus(a, b), false, 'az ablak is fel kell hogy menjen');
  assert.equal(sameFocus(b, { ...b, packs: [{ ...BASE, recurrence: { ...WEEKDAYS, days: [5, 4, 3, 2, 1] as Weekday[] } }] }), true,
    'a napok sorrendje nem különbség');
});
