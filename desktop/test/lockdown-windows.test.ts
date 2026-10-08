// Zárlat-ablak: heti ablak, amiben a zárlat magától él.
//
// Két dolog nem csúszhat el. (1) Az ablak ugyanazt a zárlatot állítja elő,
// amit kézzel is lehet indítani — kapu, kör, óra-ugrás, szinkron, egyik sem
// külön eset. (2) Az ablak nem csapda és nem kikapcsoló: az egész hét nem
// zárható le, a felvétel ingyen van, a levétel próbatétel — és csak az
// ablakon kívül, mert bent zárlat van.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  cleanWindowMarks, dueLockdownWindow, freeMinutesPerWeek, isLocked, isWindowKey, isWindowLockdown,
  isWindowsLoosening, markWindowChanges, mergeWindowSets, normalizeWindow, normalizeWindows, sameWindows,
  weekHasFreeTime, windowKey, windowLockdown, windowLockdownStarted, MAX_LOCKDOWN_WINDOWS,
  MIN_FREE_MINUTES_PER_WEEK, type LockdownWindow,
} from '../src/shared/lockdown';
import { defaultState, newId, type HelperState } from '../src/helper/state';
import * as referee from '../src/helper/referee';
import { adoptFocusRevision, bumpFocusRevision } from '../src/helper/revisions';
import { mergeFocus, normalizeSyncFocus, sameFocus, type SyncFocus } from '../src/shared/sync/focus-merge';
import type { Step, MathChainStep, MemoryStep, ReverseStep, TranscribeStep } from '../src/shared/challenges';
import { reverseString } from '../src/shared/challenges';

/** Helyi idő — az ablak is helyi időben él, mint a menetrend. */
const at = (y: number, m: number, d: number, hh: number, mm: number): number =>
  new Date(y, m - 1, d, hh, mm).getTime();

// 2026. szeptember 7. hétfő.
const MON = (hh: number, mm = 0): number => at(2026, 9, 7, hh, mm);
const TUE = (hh: number, mm = 0): number => at(2026, 9, 8, hh, mm);
const SAT = (hh: number, mm = 0): number => at(2026, 9, 12, hh, mm);
/** a hétfő ELŐTTI vasárnap — a hét eleje előtt állítjuk be az ablakot */
const SUN = (hh: number, mm = 0): number => at(2026, 9, 6, hh, mm);
const HOUR = 3600_000;

const WORK: LockdownWindow = { id: 'w1', days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60 };
/** hétfő este → kedd hajnal */
const NIGHT: LockdownWindow = { id: 'w2', days: [1], startMin: 22 * 60, endMin: 6 * 60 };
const allDay = (id: string, days: number[]): LockdownWindow =>
  ({ id, days: days as LockdownWindow['days'], startMin: 0, endMin: 1440 });
/** Egy ablak-literál a típusnak megfelelően — a többlet-mező ellenőrzés miatt. */
const win = (over: Partial<LockdownWindow> & { days: number[] }): LockdownWindow =>
  ({ id: 'w', startMin: 0, endMin: 60, ...over, days: over.days as LockdownWindow['days'] });

// ------------------------------------------------------------------ a mag

test('normalizeWindow: csak az érvényes, azonosítóval — a szemét nincs', () => {
  for (const bad of [null, 42, 'x', {}, { ...WORK, id: '' }, { ...WORK, id: 'x'.repeat(41) },
    { ...WORK, days: [] }, { ...WORK, startMin: 1440 }, { ...WORK, endMin: 0 }, { ...WORK, endMin: 'dél' }]) {
    assert.equal(normalizeWindow(bad), undefined, `${JSON.stringify(bad)} nem ablak`);
  }
  assert.deepEqual(normalizeWindow(WORK), WORK);
  // A napok rendezve és egyszer: a tartalmi kulcs ne függjön a sorrendtől.
  assert.deepEqual(normalizeWindow({ ...WORK, days: [5, 1, 1, 3, 'kedd', 9] })!.days, [1, 3, 5]);
});

test('normalizeWindows: azonosító és tartalom szerint egyszer, a plafonig', () => {
  assert.deepEqual(normalizeWindows('nem lista'), []);
  assert.deepEqual(normalizeWindows([WORK, { ...WORK, endMin: 18 * 60 }]).length, 1, 'azonos azonosító: az első');
  assert.deepEqual(normalizeWindows([WORK, { ...WORK, id: 'masik' }]), [WORK], 'azonos tartalom: az első');
  const many = Array.from({ length: MAX_LOCKDOWN_WINDOWS + 2 }, (_, i) =>
    ({ id: `w${i}`, days: [i % 7] as LockdownWindow['days'], startMin: i, endMin: i + 1 }));
  assert.equal(normalizeWindows(many).length, MAX_LOCKDOWN_WINDOWS);
  assert.equal(sameWindows([WORK], [win({ ...WORK, id: 'x' })]), true, 'a tartalom dönt, nem az azonosító');
  assert.equal(sameWindows([WORK], [NIGHT]), false);
});

test('weekHasFreeTime: az egész hét nem zárható le — legalább egy szabad óra kell', () => {
  assert.equal(weekHasFreeTime([], MON(10)), true);
  assert.equal(weekHasFreeTime([WORK, NIGHT], MON(10)), true);
  assert.equal(weekHasFreeTime([allDay('a', [0, 1, 2, 3, 4, 5, 6])], MON(10)), false, 'minden nap egész nap');
  assert.equal(weekHasFreeTime([allDay('a', [1, 2, 3, 4, 5, 6])], MON(10)), true, 'a vasárnap szabad');
  // A határ: a hét minden napján ugyanannyi szabad perc — összesen kell hatvan.
  const perDay = Math.ceil(MIN_FREE_MINUTES_PER_WEEK / 7);
  const nearlyAll = (endMin: number): LockdownWindow => win({ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin });
  assert.equal(weekHasFreeTime([nearlyAll(1440 - perDay)], MON(10)), true);
  assert.equal(weekHasFreeTime([nearlyAll(1440 - perDay + 1)], MON(10)), false);
});

test('isWindowsLoosening: a felvétel és a bővítés nem, a levétel és a szűkítés igen', () => {
  assert.equal(isWindowsLoosening([], [WORK], SUN(12)), false, 'felvétel');
  assert.equal(isWindowsLoosening([WORK], [], SUN(12)), true, 'levétel');
  assert.equal(isWindowsLoosening([WORK], [WORK, NIGHT], SUN(12)), false, 'második ablak');
  assert.equal(isWindowsLoosening([WORK], [{ ...WORK, startMin: 8 * 60 }], SUN(12)), false, 'bővítés');
  assert.equal(isWindowsLoosening([WORK], [{ ...WORK, endMin: 12 * 60 }], SUN(12)), true, 'szűkítés');
  assert.equal(isWindowsLoosening([WORK], [{ ...WORK, days: [1, 2, 3, 4] }], SUN(12)), true, 'egy nap kevesebb');
  assert.equal(isWindowsLoosening([WORK], [win({ ...WORK, id: 'uj' })], SUN(12)), false, 'ugyanaz más azonosítóval');
  assert.equal(isWindowsLoosening([WORK, NIGHT], [WORK], SUN(12)), true, 'az egyik levétele');
});

test('dueLockdownWindow: az élő ablak előfordulása, több közül a legkésőbb végződő', () => {
  assert.deepEqual(dueLockdownWindow([WORK], MON(10)), { startsAt: MON(9), endsAt: MON(17) });
  assert.equal(dueLockdownWindow([WORK], MON(8, 59)), null);
  assert.equal(dueLockdownWindow([WORK], MON(17)), null, 'a vég perce már nincs');
  assert.equal(dueLockdownWindow([WORK], SAT(10)), null);
  assert.deepEqual(dueLockdownWindow([WORK, NIGHT], MON(23)), { startsAt: MON(22), endsAt: TUE(6) });
  assert.deepEqual(dueLockdownWindow([WORK, NIGHT], TUE(1)), { startsAt: MON(22), endsAt: TUE(6) }, 'kedd hajnal — a hétfői ablak');
  const late: LockdownWindow = { id: 'w3', days: [1], startMin: 16 * 60, endMin: 18 * 60 };
  assert.deepEqual(dueLockdownWindow([WORK, late], MON(16, 30)), { startsAt: MON(16), endsAt: MON(18) },
    'két élő ablakból a később végződő');
  assert.equal(dueLockdownWindow([{ ...WORK, days: [] }], MON(10)), null, 'az érvénytelen ablak nem él');
});

test('windowLockdown: az ablak végéig szóló zárlat — a kezdés az ablaké, futó zárlatnál a futóé', () => {
  assert.deepEqual(windowLockdown(undefined, [WORK], MON(10)), { startedAt: MON(9), until: MON(17) });
  assert.equal(windowLockdown(undefined, [WORK], MON(8)), null, 'ablakon kívül nincs mit írni');
  // Futó kézi zárlat, ami az ablak vége előtt érne véget: a vége kitolódik, a kezdése marad.
  assert.deepEqual(windowLockdown({ startedAt: MON(8), until: MON(10, 30) }, [WORK], MON(10)),
    { startedAt: MON(8), until: MON(17) });
  // Futó kézi zárlat, ami tovább tart: nincs mit írni — a zárlat sosem rövidül.
  assert.equal(windowLockdown({ startedAt: MON(8), until: MON(18) }, [WORK], MON(10)), null);
  assert.equal(windowLockdown({ startedAt: MON(8), until: MON(17) }, [WORK], MON(10)), null, 'pont az ablak végéig: elég');
  // A lejárt zárlat nem futó: a kezdés az ablaké.
  assert.deepEqual(windowLockdown({ startedAt: SUN(1), until: SUN(2) }, [WORK], MON(10)),
    { startedAt: MON(9), until: MON(17) });
});

test('isWindowLockdown: a vég dönt — az ablak vége az ablak vége, a kézi vég nem', () => {
  assert.equal(isWindowLockdown({ startedAt: MON(9), until: MON(17) }, [WORK]), true);
  assert.equal(isWindowLockdown({ startedAt: MON(8), until: MON(17) }, [WORK]), true,
    'az ablak által kitolt kézi zárlat is az ablaké');
  assert.equal(isWindowLockdown({ startedAt: MON(9), until: MON(17, 30) }, [WORK]), false, 'meghosszabbítva már nem');
  assert.equal(isWindowLockdown({ startedAt: MON(9), until: MON(17) }, []), false, 'levett ablak: nincs mi tartsa');
  assert.equal(isWindowLockdown({ startedAt: MON(22), until: TUE(6) }, [NIGHT]), true, 'éjfélen át');
  assert.equal(isWindowLockdown({ startedAt: MON(0), until: TUE(0) }, [allDay('a', [1])]), true, 'egész napos, 24:00-ig');
  assert.equal(isWindowLockdown({ startedAt: MON(9), until: MON(17) }, [{ ...WORK, days: [] }]), false, 'az érvénytelen ablak nem');
});

test('windowLockdownStarted: az ablak zárlata egyszer szól, a kézi és a lejárt nem', () => {
  const win = { startedAt: MON(9), until: MON(17) };
  assert.deepEqual(windowLockdownStarted(null, win, [WORK], MON(9, 30)), win,
    'először feltűnik — akkor is, ha az app később nyílt');
  assert.equal(windowLockdownStarted(win, win, [WORK], MON(10)), null, 'ugyanaz kétszer nem');
  assert.equal(windowLockdownStarted(null, { startedAt: MON(9), until: MON(11) }, [WORK], MON(10)), null,
    'a kézi nem — azt a felhasználó indította');
  assert.equal(windowLockdownStarted(null, win, [WORK], MON(18)), null, 'a lejárt nem');
  assert.equal(windowLockdownStarted(null, null, [WORK], MON(10)), null);
  // A kézi zárlat, amit az ablak kitolt: onnantól az ablak tartja — szól.
  const manual = { startedAt: MON(8), until: MON(10, 30) };
  assert.deepEqual(windowLockdownStarted(manual, { startedAt: MON(8), until: MON(17) }, [WORK], MON(9, 30)),
    { startedAt: MON(8), until: MON(17) });
});

const wset = (windows: LockdownWindow[], marks?: Record<string, number>) =>
  ({ lockdownWindows: windows, ...(marks ? { lockdownWindowMarks: marks } : {}) });
const K = windowKey;

test('az ablakok TARTALMANKÉNT fésülődnek: a nagyobb jel dönt, egyenlőnél és jel nélkül az unió', () => {
  assert.deepEqual(mergeWindowSets(wset([WORK], { [K(WORK)]: 3 }), wset([], { [K(WORK)]: 5 })),
    { lockdownWindows: [], lockdownWindowMarks: { [K(WORK)]: 5 } }, 'a jeles levétel átmegy');
  assert.deepEqual(mergeWindowSets(wset([WORK], { [K(WORK)]: 6 }), wset([], { [K(WORK)]: 5 })).lockdownWindows, [WORK],
    'a későbbi felvétel nyer');
  assert.deepEqual(mergeWindowSets(wset([WORK]), wset([NIGHT])).lockdownWindows.map(K), [K(NIGHT), K(WORK)],
    'jel nélkül unió — a kisebb ablak elöl');
  assert.deepEqual(mergeWindowSets(wset([WORK]), wset([])).lockdownWindows, [WORK], 'a jeltelen üres lista nem töröl');
  // A TRÜKK: egy elavult eszközön egy ingyenes felvétel felhúzza a jelet — a régi listája nem töröl.
  const account = wset([WORK], { [K(WORK)]: 3 });
  const stale = wset([NIGHT], { [K(NIGHT)]: 40 });
  for (const m of [mergeWindowSets(account, stale), mergeWindowSets(stale, account)]) {
    assert.deepEqual(m.lockdownWindows.map(K), [K(WORK), K(NIGHT)], 'a WORK megmarad, a NIGHT mellé kerül');
  }
  // Azonos tartalom, más azonosító: a kisebb marad. Azonos azonosító, más tartalom: a későbbi a kulcsát kapja.
  assert.deepEqual(mergeWindowSets(wset([WORK]), wset([{ ...WORK, id: 'a0' }])).lockdownWindows, [{ ...WORK, id: 'a0' }]);
  const grown = { ...WORK, endMin: 18 * 60 };
  const both = mergeWindowSets(wset([WORK], { [K(WORK)]: 2 }), wset([grown], { [K(grown)]: 2 })).lockdownWindows;
  assert.deepEqual(both.map((w) => w.id), ['w1', K(grown)], 'két tartalom ugyanazzal az azonosítóval: a második átkeresztelve');
});

test('a plafon és a szabad óra a legfrissebbet ejti ki — az uniós sem zárhatja le az egész hetet', () => {
  // Két eszköz, egymástól függetlenül: együtt az egész hét zárlat lenne.
  const mostly = win({ id: 'a1', days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 23 * 60 });
  const rest = win({ id: 'b1', days: [0, 1, 2, 3, 4, 5, 6], startMin: 23 * 60, endMin: 1440 });
  assert.ok(freeMinutesPerWeek([mostly]) >= MIN_FREE_MINUTES_PER_WEEK);
  assert.equal(freeMinutesPerWeek([mostly, rest]), 0);
  for (const m of [
    mergeWindowSets(wset([mostly], { [K(mostly)]: 2 }), wset([rest], { [K(rest)]: 5 })),
    mergeWindowSets(wset([rest], { [K(rest)]: 5 }), wset([mostly], { [K(mostly)]: 2 })),
  ]) {
    assert.deepEqual(m.lockdownWindows, [mostly], 'a régebbi ígéret marad, a frissebb kiesik');
    assert.equal(m.lockdownWindowMarks?.[K(rest)], 5, 'a kiesett ablak jele marad');
  }
  // A hetes plafon: a nyolcadik — a legfrissebb — esik ki.
  const eight: LockdownWindow[] = Array.from({ length: MAX_LOCKDOWN_WINDOWS + 1 }, (_, i) =>
    ({ id: `x${i}`, days: [(i % 7) as LockdownWindow['days'][number]], startMin: 60 * i, endMin: 60 * i + 30 }));
  const marks = Object.fromEntries(eight.map((w, i) => [K(w), i + 1]));
  const capped = mergeWindowSets(wset(eight.slice(0, 4), marks), wset(eight.slice(4), marks)).lockdownWindows;
  assert.equal(capped.length, MAX_LOCKDOWN_WINDOWS);
  assert.ok(!capped.some((w) => w.id === 'x7'), 'a legfrissebb esett ki');
});

test('az ablak-jelek tisztán: kanonikus tartalmi kulcs, pozitív egész, legfeljebb a rev', () => {
  assert.ok(isWindowKey('1,2,3,4,5/540/1020'));
  assert.ok(!isWindowKey('2,1/540/1020'), 'a napok sorrendje kötött');
  assert.ok(!isWindowKey('1,1/540/1020'), 'dupla nap nincs');
  assert.ok(!isWindowKey('1/0540/1020'), 'vezető nulla nincs');
  assert.ok(!isWindowKey('7/0/60') && !isWindowKey('1/1440/60') && !isWindowKey('1/0/0') && !isWindowKey('x'));
  assert.ok(!isWindowKey('1/\u06610/60'), 'csak ASCII számjegy');
  assert.deepEqual(
    cleanWindowMarks({ [K(WORK)]: 2, [K(NIGHT)]: 9, '2,1/0/60': 1, 'x': 1, [K(allDay('d', [0]))]: 1.5 }, [WORK], 3),
    { [K(WORK)]: 2 },
  );
  assert.equal(cleanWindowMarks('x', [], 3), undefined);
  const grown = { ...WORK, endMin: 18 * 60 };
  assert.deepEqual(markWindowChanges({ [K(NIGHT)]: 1 }, [K(WORK), K(NIGHT)], [grown, NIGHT], 4),
    { [K(NIGHT)]: 1, [K(grown)]: 4, [K(WORK)]: 4 }, 'a módosítás: a régi tartalom levétele, az új felvétele');
});

// ------------------------------------------------------------ a bíró

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
    case 'PARTNER': throw new Error('a megbízott lépése a jelmondat — ezek a tesztek megbízott nélkül futnak');
  }
}

function solveWholeSession(state: HelperState, now: number): void {
  let guard = 0;
  while (state.session && guard++ < 200) {
    const step = state.session.steps[state.session.stepIndex];
    if (step.type === 'DELAY') {
      step.claimableAt = now - 1;
      referee.claimDelay(state, state.session.id, now);
      continue;
    }
    referee.submitAnswer(state, state.session.id, solveStep(step, now), now);
  }
}

function withSite(): { state: HelperState; siteId: string } {
  const state = defaultState();
  const siteId = newId('site');
  state.sites.push({
    id: siteId, domain: 'youtube.com', hostnames: ['youtube.com'],
    addedAt: SUN(1), pauseUntil: null, pendingDeleteAt: null,
  });
  return { state, siteId };
}

const windowsOf = (st: HelperState): LockdownWindow[] => st.lockdownWindows ?? [];

test('felvenni és bővíteni ingyen, a meglévő ablak azonosítója marad', () => {
  const st = defaultState();
  assert.equal(referee.setLockdownWindows(st, [WORK], SUN(12)).applied, true, 'felvétel');
  assert.deepEqual(windowsOf(st), [WORK]);
  assert.equal(referee.setLockdownWindows(st, [WORK, NIGHT], SUN(12)).applied, true, 'második ablak');
  assert.deepEqual(windowsOf(st).map((w) => w.id), ['w1', 'w2']);
  // Ugyanaz a tartalom más azonosítóval: nincs teendő, és nem kereszteli át.
  assert.equal(referee.setLockdownWindows(st, [{ ...WORK, id: 'zzz' }, NIGHT], SUN(12)).applied, true);
  assert.deepEqual(windowsOf(st).map((w) => w.id), ['w1', 'w2']);
  // Bővítés: a régi ablak helyett a bővebb — az azonosító a felületé.
  const wider = { ...WORK, id: 'w1b', startMin: 8 * 60 };
  assert.equal(referee.setLockdownWindows(st, [wider, NIGHT], SUN(12)).applied, true, 'bővítés');
  assert.deepEqual(windowsOf(st), [wider, NIGHT]);
  assert.equal(st.session, null, 'egyik sem indított próbatételt');
});

test('az érvénytelen, a túl sok és az egész hetet lezáró lista hiba', () => {
  const st = defaultState();
  assert.throws(() => referee.setLockdownWindows(st, [{ ...WORK, days: [] }], SUN(12)), /legalább egy nap/);
  assert.equal(referee.setLockdownWindows(st, 'nem lista', SUN(12)).applied, true, 'a nem-lista üres lista: nincs teendő');
  const many = Array.from({ length: MAX_LOCKDOWN_WINDOWS + 1 }, (_, i) =>
    ({ id: `w${i}`, days: [i % 7] as LockdownWindow['days'], startMin: i, endMin: i + 1 }));
  assert.throws(() => referee.setLockdownWindows(st, many, SUN(12)), /Legfeljebb/);
  assert.throws(() => referee.setLockdownWindows(st, [allDay('a', [0, 1, 2, 3, 4, 5, 6])], SUN(12)),
    (e: referee.RefereeError) => e.code === 'NO_FREE_TIME' && /egész hét/.test(e.message));
  assert.deepEqual(windowsOf(st), [], 'egyik sem került be');
});

test('a levétel és a szűkítés próbatétel; az ablak addig marad, és a teljesítés cseréli', () => {
  const st = defaultState();
  referee.setLockdownWindows(st, [WORK, NIGHT], SUN(12));
  const r = referee.setLockdownWindows(st, [WORK], SUN(12));
  assert.equal(r.applied, false, 'levétel: próbatétel');
  assert.ok(r.session);
  assert.equal(r.session!.siteId, 'lockdown:windows');
  assert.equal(r.session!.windows, true, 'a felület tudja, mi ez');
  assert.deepEqual(st.session!.pendingLockdownWindows, [WORK]);
  assert.deepEqual(windowsOf(st), [WORK, NIGHT], 'amíg a próbatétel tart, az ablak marad');
  assert.throws(() => referee.setLockdownWindows(st, [], SUN(12)), /folyamatban/);

  solveWholeSession(st, SUN(12));
  assert.equal(st.session, null);
  assert.deepEqual(windowsOf(st), [WORK], 'a teljesítés után a levett ablak nincs');
  assert.equal(st.unlockLog.length, 1, 'a próbatétel a feloldások közé számít');

  const narrow = referee.setLockdownWindows(st, [{ ...WORK, endMin: 12 * 60 }], SUN(12));
  assert.equal(narrow.applied, false, 'szűkítés: próbatétel');
  solveWholeSession(st, SUN(12));
  assert.equal(windowsOf(st)[0].endMin, 12 * 60);

  assert.equal(referee.setLockdownWindows(st, [], SUN(12)).applied, false, 'az utolsó levétele is');
  solveWholeSession(st, SUN(12));
  assert.equal(st.lockdownWindows, undefined, 'üresen nincs mező');
});

test('az ablakban a kör zárlatot ír — az ablak végéig, az ablak kezdésével', () => {
  const st = defaultState();
  referee.setLockdownWindows(st, [WORK], SUN(12));
  referee.tick(st, SUN(12));
  assert.equal(st.lockdown, undefined, 'ablakon kívül nincs zárlat');
  // A kapu a kör ELŐTT is látja: az ablak kezdése és az első kör közt nincs rés.
  assert.deepEqual(referee.currentLockdown(st, MON(9, 0)), { startedAt: MON(9), until: MON(17) });
  assert.equal(referee.tick(st, MON(9, 0)), true, 'a kör változást jelent');
  assert.deepEqual(st.lockdown, { startedAt: MON(9), until: MON(17) });
  assert.equal(referee.tick(st, MON(10)), false, 'a következő kör már nem ír újat');
  assert.equal(isLocked(st.lockdown, MON(16, 59)), true);
  assert.equal(isLocked(st.lockdown, MON(17)), false, 'ötkor vége');
  // Kedden újra — friss kezdéssel.
  referee.tick(st, TUE(9, 30));
  assert.deepEqual(st.lockdown, { startedAt: TUE(9), until: TUE(17) });
});

test('az ablak zárlata ugyanaz a zárlat: bent semmilyen lazítás nem indul, a levétel sem', () => {
  const { state: st, siteId } = withSite();
  referee.setLockdownWindows(st, [WORK], SUN(12));
  // Még nem járt a kör: a kapu az ablakból tudja.
  assert.throws(() => referee.startSession(st, 'pause', siteId, 15, MON(10)),
    (e: referee.RefereeError) => e.code === 'LOCKDOWN' && /Zárlat/.test(e.message));
  assert.throws(() => referee.setLockdownWindows(st, [], MON(10)),
    (e: referee.RefereeError) => e.code === 'LOCKDOWN', 'a levétel bent el sem indul');
  assert.equal(st.session, null);
  // Felvenni és bővíteni bent is ingyen — a szigorítás iránya.
  assert.equal(referee.setLockdownWindows(st, [WORK, NIGHT], MON(10)).applied, true);
  // Ablakon kívül a levétel próbatétellel megy.
  referee.tick(st, MON(17, 5));
  assert.equal(isLocked(st.lockdown, MON(17, 5)), false, 'az ablak után a zárlat lejárt');
  assert.equal(referee.setLockdownWindows(st, [WORK], MON(17, 5)).applied, false, 'levétel: próbatétel');
});

test('a kézi zárlat és az ablak: a hosszabb nyer, a zárlat sosem rövidül', () => {
  const st = defaultState();
  referee.setLockdownWindows(st, [WORK], SUN(12));
  referee.startLockdownNow(st, 2 * HOUR, MON(8));
  assert.deepEqual(st.lockdown, { startedAt: MON(8), until: MON(10) });
  referee.tick(st, MON(9, 30));
  assert.deepEqual(st.lockdown, { startedAt: MON(8), until: MON(17) }, 'az ablak kitolja a végét, a kezdés marad');
  // Kézzel az ablak zárlata is hosszabbítható. (A körök sűrűn járnak: két
  // percnél nagyobb rés óra-ugrásnak számítana, és a kézi zárlat tolódna.)
  referee.tick(st, MON(12));
  referee.startLockdownNow(st, 24 * HOUR, MON(12));
  assert.deepEqual(st.lockdown, { startedAt: MON(8), until: TUE(12) });
  referee.tick(st, MON(12, 1));
  assert.deepEqual(st.lockdown, { startedAt: MON(8), until: TUE(12) }, 'az ablak nem rövidíti a hosszabbat');
});

test('a beérő ablak a folyamatban lévő levételi kísérletet is elviszi', () => {
  const st = defaultState();
  referee.setLockdownWindows(st, [WORK], SUN(12));
  assert.equal(referee.setLockdownWindows(st, [], MON(8, 50)).applied, false);
  assert.ok(st.session);
  referee.tick(st, MON(9, 0));
  assert.equal(st.session, null, 'bent nincs próbatétel — a félbehagyott is elszáll');
  assert.deepEqual(windowsOf(st), [WORK], 'az ablak maradt');
  assert.ok((st.abandons ?? []).some((a) => a.siteId === 'lockdown:windows'), 'feladott kísérletként számít');
});

test('az óra-ugrás az ablak zárlatát nem tolja el — a kézit igen', () => {
  const st = defaultState();
  referee.setLockdownWindows(st, [WORK], SUN(12));
  referee.tick(st, MON(10));
  assert.deepEqual(st.lockdown, { startedAt: MON(9), until: MON(17) });
  // Három órát aludt a gép az ablakon belül.
  referee.tick(st, MON(13));
  assert.deepEqual(st.lockdown, { startedAt: MON(9), until: MON(17) }, 'az ablak vége az ablak vége');
  // Az ablak VÉGE UTÁN ébred: a zárlat lejárt, nem tolódott át estére.
  referee.tick(st, MON(19));
  assert.equal(isLocked(st.lockdown, MON(19)), false);

  // A kézi zárlat viszont tolódik — ugyanannyival, amennyit az óra ugrott.
  const manual = defaultState();
  referee.tick(manual, MON(10));
  referee.startLockdownNow(manual, 2 * HOUR, MON(10));
  referee.tick(manual, MON(13));
  assert.ok(manual.lockdown!.until > MON(14, 55), `a kézi vég tolódott (${manual.lockdown!.until - MON(12)} ms)`);
});

// --------------------------------------------------------- a lenyomat

test('az ablak-lista cseréje léptet és jelet kap; a csomag-szerkesztés a jelet nem bántja', () => {
  const st = defaultState();
  assert.equal(bumpFocusRevision(st, 'gep', SUN(12)), false, 'az üresség nem szerkesztés');
  referee.setLockdownWindows(st, [WORK], SUN(12));
  assert.equal(bumpFocusRevision(st, 'gep', SUN(12)), true, 'a felvétel léptet');
  assert.equal(st.focusRev, 1);
  assert.equal(st.lockdownWindowsRev, 1, 'az első jel is jel');
  assert.deepEqual(st.lockdownWindowMarks, { [K(WORK)]: 1 }, 'a felvett tartalom a saját jelét kapja');
  assert.equal(bumpFocusRevision(st, 'gep', SUN(12)), false, 'változatlanul nem léptet');

  st.focusPacks = [{ id: 'p1', name: 'Írás', allowSites: [], allowApps: [], defaultMinutes: 25 }];
  assert.equal(bumpFocusRevision(st, 'gep', SUN(12)), true);
  assert.equal(st.focusRev, 2);
  assert.equal(st.lockdownWindowsRev, 1, 'a csomag szerkesztése nem az ablakok jele');

  referee.setLockdownWindows(st, [WORK, NIGHT], SUN(12));
  assert.equal(bumpFocusRevision(st, 'gep', SUN(12)), true);
  assert.equal(st.lockdownWindowsRev, 3);
  assert.deepEqual(st.lockdownWindowMarks, { [K(WORK)]: 1, [K(NIGHT)]: 3 }, 'a régi ablak jele nem változik');

  // Egy másik eszközről átvett lista: a lenyomat újraszámolva, nincs léptetés.
  st.lockdownWindows = [NIGHT];
  adoptFocusRevision(st);
  assert.equal(bumpFocusRevision(st, 'gep', SUN(12)), false, 'az átvétel nem szerkesztés');
  st.focusPacks = [];
  assert.equal(bumpFocusRevision(st, 'gep', SUN(12)), true);
  assert.deepEqual(st.lockdownWindowMarks, { [K(WORK)]: 1, [K(NIGHT)]: 3 }, 'az átvett lista nem saját levétel');
});

// ----------------------------------------------------------- a fésülés

const focus = (over: Partial<SyncFocus>): SyncFocus =>
  ({ packs: [], run: null, log: [], rev: 0, updatedAt: 0, updatedBy: 'x', ...over });

test('a blob hordozza az ablakokat és a jelüket; a szemét és a túl nagy jel kiesik', () => {
  const n = normalizeSyncFocus({
    lockdownWindows: [WORK, 'szemét', { ...WORK, id: 'dup' }, { ...NIGHT, days: [] }],
    lockdownWindowsRev: 2, rev: 3,
  }, 'y');
  assert.deepEqual(n.lockdownWindows, [WORK]);
  assert.equal(n.lockdownWindowsRev, 2);
  assert.equal(normalizeSyncFocus({ lockdownWindowsRev: 9, rev: 3 }, 'y').lockdownWindowsRev, undefined,
    'a jel legfeljebb a blob rev-je');
  assert.equal(normalizeSyncFocus({ lockdownWindows: [], rev: 3 }, 'y').lockdownWindows, undefined,
    'üresen nincs mező');
  assert.equal(normalizeSyncFocus({ lockdownWindowsRev: 1.5, rev: 3 }, 'y').lockdownWindowsRev, undefined);
  assert.deepEqual(
    normalizeSyncFocus({ lockdownWindows: [WORK], lockdownWindowMarks: { [K(WORK)]: 2, [K(NIGHT)]: 3, '2,1/0/60': 1, x: 1 }, rev: 3 }, 'y')
      .lockdownWindowMarks,
    { [K(WORK)]: 2, [K(NIGHT)]: 3 }, 'a levétel jele is utazik; a nem kanonikus kulcs kiesik',
  );
});

test('a fésülésben a tartalom jele dönt: a jeles levétel átmegy, a jeltelen üres lista nem töröl', () => {
  const mine = focus({ rev: 3, updatedAt: 10, lockdownWindows: [WORK], lockdownWindowsRev: 3, lockdownWindowMarks: { [K(WORK)]: 3 } });
  const removed = focus({ rev: 5, updatedAt: 20, lockdownWindowsRev: 5, lockdownWindowMarks: { [K(WORK)]: 5 } });
  assert.equal(mergeFocus(mine, removed).lockdownWindows, undefined, 'a levétel átjön');
  assert.equal(mergeFocus(removed, mine).lockdownWindows, undefined, 'sorrendtől függetlenül');
  assert.equal(mergeFocus(mine, removed).lockdownWindowsRev, 5);

  // Régi kliens: magasabb rev, se ablak, se jel — nem törölhet.
  const old = focus({ rev: 9, updatedAt: 30 });
  assert.deepEqual(mergeFocus(mine, old).lockdownWindows, [WORK], 'a jeltelen blob nem viszi el');
  assert.deepEqual(mergeFocus(old, mine).lockdownWindows, [WORK]);
  assert.equal(mergeFocus(old, mine).lockdownWindowsRev, 3);

  // Egy csomag-szerkesztés a másik eszközön (nagyobb rev, régi jel) sem.
  const packEdit = focus({ rev: 4, updatedAt: 15, lockdownWindows: [WORK], lockdownWindowsRev: 3,
    lockdownWindowMarks: { [K(WORK)]: 3 },
    packs: [{ id: 'p1', name: 'Írás', allowSites: [], allowApps: [], defaultMinutes: 25 }] });
  const afterRemoval = focus({ rev: 4, updatedAt: 14, lockdownWindowsRev: 4, lockdownWindowMarks: { [K(WORK)]: 4 } });
  assert.equal(mergeFocus(packEdit, afterRemoval).lockdownWindows, undefined,
    'a levétel jele nagyobb: a csomag-szerkesztés nem támasztja fel');

  // A TRÜKK: egy elavult eszköz ingyenes felvétellel felhúzza a lista jelét — a WORK-öt nem viszi el.
  const stale = focus({ rev: 40, updatedAt: 40, lockdownWindows: [NIGHT], lockdownWindowsRev: 40, lockdownWindowMarks: { [K(NIGHT)]: 40 } });
  for (const m of [mergeFocus(mine, stale), mergeFocus(stale, mine)]) {
    assert.deepEqual((m.lockdownWindows ?? []).map(K), [K(WORK), K(NIGHT)], 'a WORK megmarad');
    assert.equal(m.lockdownWindowsRev, 40, 'a lista jele a régi klienseknek utazik tovább');
  }
  // A régi kliens jel nélküli levétele nem tartja meg magát — a szigorúbb irány.
  const oldRemoval = focus({ rev: 6, updatedAt: 60, lockdownWindowsRev: 6 });
  assert.deepEqual(mergeFocus(mine, oldRemoval).lockdownWindows, [WORK]);

  // Azonos jel: unió — a szigorúbb irány; a kisebb ablak elöl.
  const a = focus({ rev: 5, lockdownWindows: [WORK], lockdownWindowsRev: 5, lockdownWindowMarks: { [K(WORK)]: 5 } });
  const b = focus({ rev: 5, lockdownWindows: [NIGHT], lockdownWindowsRev: 5, lockdownWindowMarks: { [K(NIGHT)]: 5 } });
  assert.deepEqual(mergeFocus(a, b).lockdownWindows, [NIGHT, WORK]);
  assert.equal(sameFocus(a, b), false, 'más ablak: van mit feltölteni');
  assert.equal(sameFocus(a, focus({ rev: 5, lockdownWindows: [{ ...WORK, id: 'x' }], lockdownWindowsRev: 5,
    lockdownWindowMarks: { [K(WORK)]: 5 } })), true, 'az azonosító nem számít');
  assert.equal(sameFocus(a, focus({ ...a, lockdownWindowMarks: { [K(WORK)]: 4 } })), false, 'a jel cseréje különbség');
});
