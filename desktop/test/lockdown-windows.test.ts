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
  dueLockdownWindow, isLocked, isWindowLockdown, isWindowsLoosening, mergeWindows,
  normalizeWindow, normalizeWindows, sameWindows, weekHasFreeTime, windowLockdown,
  windowLockdownStarted, MAX_LOCKDOWN_WINDOWS, MIN_FREE_MINUTES_PER_WEEK, type LockdownWindow,
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

test('mergeWindows: a nagyobb jel nyer, azonos jelnél a bővebb lista; a jeltelen nem töröl', () => {
  assert.deepEqual(mergeWindows(5, [WORK], 3, []), [WORK], 'a helyi levétel-utáni jel… nem, a helyi jel nagyobb: a helyi lista');
  assert.deepEqual(mergeWindows(3, [WORK], 5, []), [], 'a másik eszköz jeles levétele átjön');
  assert.deepEqual(mergeWindows(5, [WORK], 5, [NIGHT]), [WORK, NIGHT], 'azonos jel: unió');
  assert.deepEqual(mergeWindows(0, [WORK], 0, []), [WORK], 'jel nélkül: unió — az üres nem töröl');
  assert.deepEqual(mergeWindows(3, [WORK], 0, []), [WORK], 'a jeltelen (régi kliens) üres listája nem töröl');
  assert.deepEqual(mergeWindows(5, [WORK], 5, [{ ...WORK, id: 'idegen' }]), [WORK], 'azonos tartalom: a helyi azonosító marad');
  assert.deepEqual(mergeWindows(0, [WORK], 7, []), [], 'kimondott határ: a jeles levétel a jeltelen felvételt is elviszi');
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
  assert.equal(bumpFocusRevision(st, 'gep', SUN(12)), false, 'változatlanul nem léptet');

  st.focusPacks = [{ id: 'p1', name: 'Írás', allowSites: [], allowApps: [], defaultMinutes: 25 }];
  assert.equal(bumpFocusRevision(st, 'gep', SUN(12)), true);
  assert.equal(st.focusRev, 2);
  assert.equal(st.lockdownWindowsRev, 1, 'a csomag szerkesztése nem az ablakok jele');

  referee.setLockdownWindows(st, [WORK, NIGHT], SUN(12));
  assert.equal(bumpFocusRevision(st, 'gep', SUN(12)), true);
  assert.equal(st.lockdownWindowsRev, 3);

  // Egy másik eszközről átvett lista: a lenyomat újraszámolva, nincs léptetés.
  st.lockdownWindows = [NIGHT];
  adoptFocusRevision(st);
  assert.equal(bumpFocusRevision(st, 'gep', SUN(12)), false, 'az átvétel nem szerkesztés');
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
});

test('a fésülésben a jel dönt: a jeles levétel átmegy, a jeltelen üres lista nem töröl', () => {
  const mine = focus({ rev: 3, updatedAt: 10, lockdownWindows: [WORK], lockdownWindowsRev: 3 });
  const removed = focus({ rev: 5, updatedAt: 20, lockdownWindowsRev: 5 });
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
    packs: [{ id: 'p1', name: 'Írás', allowSites: [], allowApps: [], defaultMinutes: 25 }] });
  const afterRemoval = focus({ rev: 4, updatedAt: 14, lockdownWindowsRev: 4 });
  assert.equal(mergeFocus(packEdit, afterRemoval).lockdownWindows, undefined,
    'a levétel jele nagyobb: a csomag-szerkesztés nem támasztja fel');

  // Azonos jel: unió — a szigorúbb irány.
  const a = focus({ rev: 5, lockdownWindows: [WORK], lockdownWindowsRev: 5 });
  const b = focus({ rev: 5, lockdownWindows: [NIGHT], lockdownWindowsRev: 5 });
  assert.deepEqual(mergeFocus(a, b).lockdownWindows, [WORK, NIGHT]);
  assert.equal(sameFocus(a, b), false, 'más ablak: van mit feltölteni');
  assert.equal(sameFocus(a, focus({ rev: 5, lockdownWindows: [{ ...WORK, id: 'x' }], lockdownWindowsRev: 5 })), true,
    'az azonosító nem számít');
});
