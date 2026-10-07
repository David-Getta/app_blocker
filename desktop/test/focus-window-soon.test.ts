// A heti ablak menete előtt tíz perccel az app szól.
//
// A zárlat-ablak beérése előtt eddig is szólt; a heti ablak menete szó nélkül
// indult — pedig az is lezár mindent, ami nincs a csomagban, és ami épp
// nyitva van, félbemarad. A döntés a magé (`windowRunStartingSoon`), a
// fixtúra a három nyelv egyezését őrzi; itt a szabályok, kimondva.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  WINDOW_SOON_MS, WINDOW_SOON_TITLE, windowRunStartingSoon, windowSoonText,
  type FocusLogEntry, type FocusPack, type FocusRun,
} from '../src/shared/focus';
import { WINDOW_PRE_WARN_MS } from '../src/shared/lockdown';
import type { Band } from '../src/shared/schedule';

/** Helyi idő — a mag is helyi időben gondolkodik. */
const at = (y: number, m: number, d: number, hh: number, mm: number): number =>
  new Date(y, m - 1, d, hh, mm).getTime();
// 2026. szeptember 7. hétfő.
const MON = (hh: number, mm = 0): number => at(2026, 9, 7, hh, mm);
const MIN = 60_000;

const EVENING: Band = { days: [1, 3], startMin: 18 * 60, endMin: 18 * 60 + 50 };

const pack = (over: Partial<FocusPack> = {}): FocusPack => ({
  id: 'p1', name: 'Nyelvtanulás', allowSites: ['quizlet.com'], allowApps: [], defaultMinutes: 50,
  recurrence: EVENING, ...over,
});

test('tíz perccel előtte szól — ugyanannyival, mint a zárlat-ablak előtt', () => {
  assert.equal(WINDOW_SOON_MS, WINDOW_PRE_WARN_MS);
  const soon = windowRunStartingSoon([pack()], null, [], MON(17, 50));
  assert.ok(soon);
  assert.equal(soon.pack.id, 'p1');
  assert.equal(soon.startsAt, MON(18));
  assert.equal(soon.endsAt, MON(18, 50));
  assert.equal(windowRunStartingSoon([pack()], null, [], MON(17, 50) - 1), null, 'egy ezredmásodperccel korábban még nem');
  assert.ok(windowRunStartingSoon([pack()], null, [], MON(17, 59)), 'az utolsó percben még igen');
});

test('ami már tart, arról nem szól — azt a kör indítja, onnan a menet beszél', () => {
  assert.equal(windowRunStartingSoon([pack()], null, [], MON(18)), null);
  assert.equal(windowRunStartingSoon([pack()], null, [], MON(18, 30)), null);
});

test('a csomag saját futó menete mellett hallgat; egy másik csomagé mellett nem', () => {
  const own: FocusRun = { packId: 'p1', startedAt: MON(17, 30), endsAt: MON(18, 10) };
  assert.equal(windowRunStartingSoon([pack()], own, [], MON(17, 55)), null);
  // Ha a saját menete a kezdés előtt lejár, utána még szól: újra indul.
  const ended: FocusRun = { packId: 'p1', startedAt: MON(17, 20), endsAt: MON(17, 52) };
  assert.ok(windowRunStartingSoon([pack()], ended, [], MON(17, 55)));
  // Egy másik csomag kézi menetét az ablak kezdetén a kör lezárja — erről szólni kell.
  const other: FocusRun = { packId: 'p2', startedAt: MON(17, 30), endsAt: MON(19) };
  assert.ok(windowRunStartingSoon([pack()], other, [], MON(17, 55)));
});

test('az elköltött előfordulásról hallgat (a saját menete a naplóban)', () => {
  const spent: FocusLogEntry = {
    packId: 'p1', packName: 'Nyelvtanulás', startedAt: MON(18), endedAt: MON(18, 20), plannedEndsAt: MON(18, 50), stopped: true,
  };
  assert.equal(windowRunStartingSoon([pack()], null, [spent], MON(17, 55)), null);
  // Egy másik csomag sora nem költi el.
  assert.ok(windowRunStartingSoon([pack()], null, [{ ...spent, packId: 'p2' }], MON(17, 55)));
});

test('több közül a korábban induló; azonos kezdésnél a kisebb azonosító, kódegység szerint', () => {
  const early = pack({ id: 'p_b', recurrence: { days: [1], startMin: 17 * 60 + 58, endMin: 19 * 60 } });
  assert.equal(windowRunStartingSoon([pack(), early], null, [], MON(17, 55))?.pack.id, 'p_b');
  const twin = pack({ id: 'P2' });
  assert.equal(windowRunStartingSoon([pack(), twin], null, [], MON(17, 55))?.pack.id, 'P2', 'a nagybetű előbb van');
});

test('ablak nélküli vagy érvénytelen sávú csomagról nem szól', () => {
  assert.equal(windowRunStartingSoon([pack({ recurrence: undefined })], null, [], MON(17, 55)), null);
  assert.equal(windowRunStartingSoon([pack({ recurrence: { days: [], startMin: 1080, endMin: 1130 } })], null, [], MON(17, 55)), null);
});

test('az értesítés szövege: tény, a perc felfelé kerekít, legalább egy', () => {
  assert.equal(WINDOW_SOON_TITLE, 'Breaker — mindjárt indul a munkamenet');
  assert.equal(
    windowSoonText('Nyelvtanulás', 10 * MIN, '18:50'),
    'Nyelvtanulás: 10 perc múlva indul a heti ablak szerint, 18:50-ig. '
      + 'Amíg tart, csak a csomagban felsoroltak mehetnek — ami nyitva van, mentsd el.',
  );
  assert.match(windowSoonText('A', 9 * MIN + 1, '18:50'), /: 10 perc múlva/);
  assert.match(windowSoonText('A', 1, '18:50'), /: 1 perc múlva/);
  assert.match(windowSoonText('A', -5, '18:50'), /: 1 perc múlva/);
});
