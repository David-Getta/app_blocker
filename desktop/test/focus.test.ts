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
  closeRun, formatRemaining, isAppAllowed, isRunning, isSessionLoosening, isSiteAllowed,
  lastUsedPack, MAX_ALLOW_ENTRIES, MAX_SESSION_MINUTES, normalizeMinutes, normalizePack, remainingMs,
  normalizeRecurrence, peakWindowBand, summarizeFocus, summarizeFocusPrevWeek, type FocusLogEntry, type FocusPack,
  bandCoversHour, packCoveringHour, closeIfEnded, type FocusRun, windowRunsByPack, peakWindowPick,
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

test('the session warns about an app that is not on the list', async () => {
  const { shouldWarnAboutApp, warnDue, APP_WARN_COOLDOWN_MS } = await import('../src/shared/focus');
  const p = pack({ allowApps: ['Word', 'DeepL'] });
  assert.equal(shouldWarnAboutApp(p, 'com.valve.steam', 'Steam'), true);
  assert.equal(shouldWarnAboutApp(p, 'com.microsoft.Word', 'Microsoft Word'), false);
  // Az azonosító is számít, nem csak a név: Windowson a folyamatnév jön.
  assert.equal(shouldWarnAboutApp(p, 'WINWORD.EXE', ''), false);
  // A SAJÁT appunk sosem: különben a réteg önmagát hívná elő, és a képernyő
  // használhatatlan lenne.
  assert.equal(shouldWarnAboutApp(p, 'hu.breaker.app', 'Breaker'), false);
  assert.equal(shouldWarnAboutApp(p, '', ''), false);

  // Türelmi idő: egy réteg, ami minden öt másodpercben felugrik, nem
  // figyelmeztetés, hanem büntetés — és a munkamenetet fogják kikapcsolni.
  assert.equal(warnDue(null, NOW), true);
  assert.equal(warnDue(NOW, NOW + 1000), false);
  assert.equal(warnDue(NOW, NOW + APP_WARN_COOLDOWN_MS), true);
});

// ---------------------------------------------------------------------------
// A lezárult munkamenetek naplója
// ---------------------------------------------------------------------------
//
// Az app eddig azt mérte, MIRE megy el az idő. Ez a másik oldal: hányszor ültél
// le dolgozni, és hányat vittél végig.

test('az összegzés csak az ablakba eső meneteket számolja', () => {
  const log = [
    entry({ endedAt: 500 }),                     // az ablak ELŐTT
    entry({ startedAt: 1_000, endedAt: 2_000 }),
    entry({ startedAt: 2_000, endedAt: 3_000 }),
    entry({ endedAt: 9_999 }),                   // az ablak UTÁN
  ];
  const sum = summarizeFocus(log, 1_000, 5_000);
  assert.equal(sum.sessions, 2);
  assert.equal(sum.totalMs, 2_000);
});

test('a korán véget ért menet akkor is annak számít, ha nem „leállítás” volt', () => {
  // A próbatétel utáni RÖVIDÍTÉS is korai vég: a menet nem addig tartott,
  // ameddig terveztük. Ha csak a `stopped` jelzőt néznénk, a rövidítés
  // láthatatlan maradna — pedig pont ugyanaz a döntés.
  const log = [
    entry({ startedAt: 0, endedAt: 400, plannedEndsAt: 1_000, stopped: false }),
    entry({ startedAt: 0, endedAt: 1_000, plannedEndsAt: 1_000, stopped: false }),
  ];
  const sum = summarizeFocus(log, 0, 5_000);
  assert.equal(sum.stoppedEarly, 1);
});

test('a leggyakoribb csomag neve jön vissza', () => {
  const log = [
    entry({ packName: 'Nyelvtanulás' }),
    entry({ packName: 'Nyelvtanulás' }),
    entry({ packName: 'Mély munka' }),
  ];
  assert.equal(summarizeFocus(log, 0, 5_000).topPack, 'Nyelvtanulás');
});

test('üres napló üres összegzés, nem kivétel', () => {
  for (const empty of [undefined, []]) {
    const sum = summarizeFocus(empty, 0, 1_000);
    assert.deepEqual(sum, { sessions: 0, totalMs: 0, stoppedEarly: 0, windowRuns: 0, topPack: null });
  }
});

test('a naplósor megőrzi a csomag AKKORI nevét', () => {
  // A csomag azóta átnevezhető vagy törölhető. Egy statisztika, ami ismeretlen
  // csomagot ír ki a múlt hétre, semmit nem ér.
  const row = closeRun(
    { packId: 'p1', startedAt: 100, endsAt: 1_100 }, 'Nyelvtanulás', 900, true,
  );
  assert.equal(row.packName, 'Nyelvtanulás');
  assert.equal(row.plannedEndsAt, 1_100);
  assert.equal(row.endedAt, 900);
  assert.equal(row.stopped, true);
});

function entry(over: Partial<FocusLogEntry> = {}): FocusLogEntry {
  return {
    packId: 'p1', packName: 'Nyelvtanulás',
    startedAt: 1_000, endedAt: 2_000, plannedEndsAt: 2_000, stopped: false,
    ...over,
  };
}

test('a naplósor tudja, hogy az ablakból indult — a lezárás írja, az összegzés számolja', () => {
  const p = pack({ id: 'w', name: 'Ablakos', recurrence: peakWindowBand(21) });
  const start = new Date(2026, 8, 18, 21, 0).getTime();
  const run: FocusRun = { packId: 'w', startedAt: start, endsAt: start + 3_600_000 };
  const closed = closeIfEnded(run, [p], [], start + 3_600_001);
  assert.equal(closed?.log[0].window, true, 'az ablak előfordulása: ablakból indult');
  const manual: FocusRun = { packId: 'w', startedAt: start + 5 * 60_000, endsAt: start + 3_600_000 };
  assert.equal(closeIfEnded(manual, [p], [], start + 3_600_001)?.log[0].window, undefined, 'a kézi menet nem ablak');
  assert.equal(closeRun(run, 'Ablakos', start + 3_600_000, false).window, undefined, 'jel nélkül nincs mező');
  assert.equal(closeRun(run, 'Ablakos', start + 3_600_000, false, true).window, true);
  const log = [entry({ window: true }), entry({ startedAt: 2_000, endedAt: 3_000 }), entry({ startedAt: 3_000, endedAt: 4_000, window: true })];
  assert.equal(summarizeFocus(log, 0, 5_000).windowRuns, 2);
  assert.equal(summarizeFocus([], 0, 5_000).windowRuns, 0);
  // Csomagonként: a csomag sora ebből mondja, hányszor indult magától a héten.
  const perPack = [entry({ packId: 'a', window: true }), entry({ packId: 'b', startedAt: 2_000, endedAt: 3_000 }),
    entry({ packId: 'a', startedAt: 3_000, endedAt: 4_000, window: true }), entry({ packId: 'c', startedAt: 8_000, endedAt: 9_000, window: true })];
  assert.deepEqual(windowRunsByPack(perPack, 0, 5_000), { a: 2 }, 'csak az ablakos sorok, csak az ablakban');
  assert.deepEqual(windowRunsByPack(undefined, 0, 5_000), {});
});

test('a legutóbb használt csomag: a napló szerint, törölt csomag nélkül, különben az első', () => {
  const a = pack({ id: 'pack_a', name: 'A' });
  const b = pack({ id: 'pack_b', name: 'B' });
  const entry = (packId: string, at: number): FocusLogEntry => ({
    packId, packName: packId, startedAt: at, endedAt: at + 60_000, plannedEndsAt: at + 60_000, stopped: false,
  });
  assert.equal(lastUsedPack([], []), null, 'csomag nélkül nincs mit indítani');
  assert.equal(lastUsedPack([a, b], [])?.id, 'pack_a', 'napló nélkül az első');
  assert.equal(lastUsedPack([a, b], [entry('pack_a', 1000), entry('pack_b', 2000)])?.id, 'pack_b', 'a legfrissebb sor');
  assert.equal(lastUsedPack([a, b], [entry('pack_a', 1000), entry('pack_x', 2000)])?.id, 'pack_a', 'a törölt csomag sora nem számít');
});

test('az előző hét: a mai nap kezdete előtti 13. naptól a 6. nap kezdetéig — a határ a mostani hété', () => {
  const now = new Date(2026, 8, 18, 12).getTime();
  const start = new Date(2026, 8, 18).getTime();
  const day = 86_400_000;
  const log = [
    entry({ startedAt: start - 6 * day, endedAt: start - 6 * day + 1 }),   // a mostani hét első pillanata
    entry({ startedAt: start - 7 * day, endedAt: start - 6 * day - 1 }),   // az előző hét utolsó pillanata
    entry({ startedAt: start - 13 * day, endedAt: start - 13 * day }),     // az előző hét első pillanata
    entry({ startedAt: start - 14 * day, endedAt: start - 13 * day - 1 }), // már nem
  ];
  assert.equal(summarizeFocusPrevWeek(log, now).sessions, 2, 'a 13. nap kezdete és a 6. nap kezdete előtti pillanat benne');
  assert.equal(summarizeFocus(log, start - 6 * day, now).sessions, 1, 'a mostani hét a maradék');
  assert.equal(summarizeFocusPrevWeek([], now).sessions, 0);
});

test('le van-e fedve az óra: a sáv egy napon az óra egy részét is átfogja; a fedő csomag az első', () => {
  const band = { days: [1, 2, 3, 4, 5] as const, startMin: 21 * 60, endMin: 22 * 60 };
  assert.equal(bandCoversHour({ ...band, days: [...band.days] }, 21), true);
  assert.equal(bandCoversHour({ ...band, days: [...band.days] }, 22), false, 'az ablak vége nem fedi a következő órát');
  assert.equal(bandCoversHour({ ...band, days: [...band.days] }, 20), false);
  assert.equal(bandCoversHour({ days: [0], startMin: 21 * 60 + 30, endMin: 23 * 60 }, 21), true, 'a fél óra is fedés');
  assert.equal(bandCoversHour({ days: [], startMin: 0, endMin: 1440 }, 5), false, 'nap nélkül nem ablak');
  const a = pack({ id: 'a', name: 'A' });
  const b = pack({ id: 'b', name: 'B', recurrence: peakWindowBand(21) });
  assert.equal(packCoveringHour([a, b], 21)?.id, 'b');
  assert.equal(packCoveringHour([a, b], 9), null);
  assert.equal(packCoveringHour([], 21), null);
});

test('ablak a csúcs-órára: minden nap, a csúcs egy órája — a 23 óra vége a nap vége; érvényes ablak', () => {
  assert.deepEqual(peakWindowBand(21), { days: [0, 1, 2, 3, 4, 5, 6], startMin: 21 * 60, endMin: 22 * 60 });
  assert.equal(peakWindowBand(23).endMin, 1440, 'a nap vége, nem nulla — különben átfordulna');
  assert.equal(peakWindowBand(0).startMin, 0);
  assert.equal(peakWindowBand(99).startMin, 23 * 60, 'rossz óra: a nap utolsó órája');
  for (const h of [0, 7, 23]) assert.ok(normalizeRecurrence(peakWindowBand(h)), `a ${h} óra ablaka érvényes`);
});

test('a csúcs-óra ablakának jelöltje: van csúcs, nincs fedés, nem fut menet, és a csomagnak nincs még ablaka — a telefonok tükre', () => {
  const p = pack({ id: 'p1', name: 'Nyelvtanulás' });
  assert.deepEqual(peakWindowPick([p], [], null, 21, NOW), { pack: p, band: peakWindowBand(21) });
  assert.equal(peakWindowPick([p], [], null, null, NOW), null, 'csúcs nélkül nincs');
  assert.equal(peakWindowPick([], [], null, 21, NOW), null, 'csomag nélkül nincs');
  const covered = pack({ id: 'p1', recurrence: { days: [1], startMin: 21 * 60 + 30, endMin: 23 * 60 } });
  assert.equal(peakWindowPick([covered], [], null, 21, NOW), null, 'fedett csúcs-órára nincs');
  const windowed = pack({ id: 'p1', recurrence: { days: [1, 2], startMin: 9 * 60, endMin: 10 * 60 } });
  assert.equal(peakWindowPick([windowed], [], null, 21, NOW), null, 'ablakos csomagot nem cserél');
  const run: FocusRun = { packId: 'p1', startedAt: NOW - 60_000, endsAt: NOW + 60_000 };
  assert.equal(peakWindowPick([p], [], run, 21, NOW), null, 'futó menet mellett nincs');
  assert.deepEqual(peakWindowPick([p], [], run, 21, NOW + 120_000)?.pack.id, 'p1', 'lejárt menet után van');
});
