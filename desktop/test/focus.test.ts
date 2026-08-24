// Munkamenetek: „most csak EZ mehet”.
//
// Ez a funkció megfordítja a logikát: a blokklista feketelista, a munkamenet
// fehérlista. A megfordulásnál két hiba lehetséges, és mindkettő csendes:
//
//   1. átenged valamit, amit nem soroltak fel  -> a munkamenet nem ér semmit;
//   2. kizár valamit, amit felsoroltak         -> a munkamenet használhatatlan,
//      és a felhasználó legközelebb el sem indítja.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  formatRemaining, isAppAllowed, isRunning, isSessionLoosening, isSiteAllowed,
  MAX_ALLOW_ENTRIES, MAX_SESSION_MINUTES, normalizeMinutes, normalizePack, remainingMs,
  type FocusPack,
} from '../src/shared/focus';

const NOW = 1_800_000_000_000;

const pack = (extra: Partial<FocusPack> = {}): FocusPack => ({
  id: 'p1', name: 'Nyelvtanulás', allowSites: ['google.com'], allowApps: ['Word'],
  defaultMinutes: 50, ...extra,
});

test('what is on the list gets through, and everything else does not', () => {
  const p = pack({ allowSites: ['google.com', 'quizlet.com'] });
  assert.equal(isSiteAllowed(p, 'google.com'), true);
  assert.equal(isSiteAllowed(p, 'quizlet.com'), true);
  // Aldomain: enélkül minden oldalnál külön ki kellene találni, melyik aldomain
  // kell, és a felhasználó azt látná, hogy a beállítása nem működik.
  assert.equal(isSiteAllowed(p, 'translate.google.com'), true);
  assert.equal(isSiteAllowed(p, 'docs.google.com'), true);
  // Minden más tiltva — ez a lényeg.
  assert.equal(isSiteAllowed(p, 'youtube.com'), false);
  assert.equal(isSiteAllowed(p, 'reddit.com'), false);
  assert.equal(isSiteAllowed(p, ''), false);
});

test('a domain that merely ends similarly is NOT allowed', () => {
  // Ez a leggyakoribb megtévesztés: `notgoogle.com` a `google.com` végére
  // hasonlít. Ha átmenne, a fehérlista bármikor megkerülhető lenne egy
  // megfelelően elnevezett tartománnyal.
  const p = pack();
  assert.equal(isSiteAllowed(p, 'notgoogle.com'), false);
  assert.equal(isSiteAllowed(p, 'google.com.hamis.hu'), false);
  assert.equal(isSiteAllowed(p, 'xgoogle.com'), false);
});

test('app names match loosely, because they differ from machine to machine', () => {
  // Az ablakcímek és folyamatnevek gépenként és nyelvenként mások. Egy pontos
  // egyezésre épülő lista mindenkinél máshogy viselkedne, és senki nem értené.
  const p = pack({ allowApps: ['Word', 'DeepL'] });
  assert.equal(isAppAllowed(p, 'Microsoft Word'), true);
  assert.equal(isAppAllowed(p, 'word'), true);
  assert.equal(isAppAllowed(p, 'DeepL Translate'), true);
  assert.equal(isAppAllowed(p, 'Steam'), false);
  assert.equal(isAppAllowed(p, ''), false);
});

test('a running session knows how much is left', () => {
  const run = { packId: 'p1', startedAt: NOW, endsAt: NOW + 30 * 60_000 };
  assert.equal(isRunning(run, NOW), true);
  assert.equal(remainingMs(run, NOW), 30 * 60_000);
  // Lejárat után nem fut, és nincs hátra semmi — külön takarítás nélkül is.
  assert.equal(isRunning(run, run.endsAt), false);
  assert.equal(remainingMs(run, run.endsAt + 1), 0);
  assert.equal(isRunning(null, NOW), false);
  assert.equal(remainingMs(undefined, NOW), 0);
});

test('extending is free, shortening is not', () => {
  // Ugyanaz a szabály, mint mindenhol: a szigorítás felé szabad az út. Ha a
  // rövidítés ingyen lenne, a munkamenet egy „mégsem” gomb lenne.
  const end = NOW + 60 * 60_000;
  assert.equal(isSessionLoosening(end, end + 60_000), false, 'hosszabbítani szabad');
  assert.equal(isSessionLoosening(end, end), false, 'ugyanaz nem lazítás');
  assert.equal(isSessionLoosening(end, end - 60_000), true, 'rövidíteni nem');
  assert.equal(isSessionLoosening(end, NOW), true, 'azonnali leállítás sem');
});

test('a pack from outside cannot be nonsense', () => {
  // A csomag a szinkronon és az állapotfájlon át is jöhet. Egy név nélküli
  // vagy határtalan csomag a felületet vinné el.
  assert.equal(normalizePack(null), null);
  assert.equal(normalizePack({ id: 'p1' }), null, 'név nélkül nincs csomag');
  assert.equal(normalizePack({ name: 'X' }), null, 'azonosító nélkül sem');

  const many = Array.from({ length: 200 }, (_, i) => `pelda${i}.hu`);
  const p = normalizePack({
    id: 'p1', name: '  Nyelvtanulás  ', allowSites: many,
    allowApps: ['Word', 'Word', '  '], defaultMinutes: 99999,
  });
  assert.ok(p);
  assert.equal(p.name, 'Nyelvtanulás');
  assert.equal(p.allowSites.length, MAX_ALLOW_ENTRIES);
  assert.deepEqual(p.allowApps, ['Word'], 'a duplikátum és az üres kimarad');
  assert.equal(p.defaultMinutes, MAX_SESSION_MINUTES, 'egy napnál hosszabb munkamenet nincs');
});

test('the site list goes through the same normalizer as the blocklist', () => {
  // Ha itt máshogy értenénk egy címet, mint a blokklistán, ugyanaz az oldal
  // egyszerre lenne engedve és tiltva — és semmi nem mondaná meg, melyik nyer.
  const p = normalizePack({
    id: 'p1', name: 'X', allowSites: ['https://www.Google.com/valami', 'google.com'],
  });
  assert.deepEqual(p?.allowSites, ['google.com'], 'ugyanaz a hoszt egyszer szerepel');
});

test('a session length is always usable', () => {
  assert.equal(normalizeMinutes(50), 50);
  assert.equal(normalizeMinutes('50'), 50);
  assert.equal(normalizeMinutes(0), null);
  assert.equal(normalizeMinutes(-5), null);
  assert.equal(normalizeMinutes('abc'), null);
  assert.equal(normalizeMinutes(99999), MAX_SESSION_MINUTES);
});

test('the remaining time reads like a human wrote it', () => {
  assert.equal(formatRemaining(42 * 60_000), '42 perc');
  assert.equal(formatRemaining(60 * 60_000), '1 óra');
  assert.equal(formatRemaining(95 * 60_000), '1 ó 35 p');
  assert.equal(formatRemaining(30_000), 'kevesebb mint egy perc');
  assert.equal(formatRemaining(0), 'kevesebb mint egy perc');
});
