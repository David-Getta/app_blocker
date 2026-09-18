// A bővítmény zárva-magyarázata: mikor szólalhat meg egyáltalán.
//
// A tiltást a DNS tartja; a bővítmény tiltó-lapja csak MAGYARÁZ. Ezért itt a
// hiba iránya a szokásos fordítottja: a `closedFor` kétes esetben inkább
// hallgat, mint hogy zárva-t mondjon egy már kinyílt oldalra — mert a hosts-
// fájl felett nem ő dönt, és egy elavult „zárva” lap a megváltott feloldást
// is letagadná. Ez a teszt pont a hallgatás határait szögezi le.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/** A bővítmény mappája — a `__dirname`-től felfelé keresve (l. extension-focus). */
function extensionDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'extension');
    if (fs.existsSync(path.join(candidate, 'app-link.js'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('nem talalom az extension/ mappat');
}

/**
 * A KISZÁLLÍTOTT kód betöltése: a konstans, a szűrő és a döntés együtt.
 *
 * Forrás-kivágás, mint a fókusz-tesztben — a teszt azokat a bájtokat hajtja
 * végre, amik a felhasználó böngészőjébe kerülnek, nem egy másolatot.
 */
function loadClosed(): {
  CLOSED_FRESH_MS: number;
  cleanClosed: (list: unknown) => { host: string; reason: string; until: number }[];
  closedFor: (link: unknown, host: unknown, now?: number) =>
    { host: string; reason: string; until: number } | null;
  cleanLockdown: (raw: unknown) => { until: number } | null;
  lockdownUntil: (link: unknown, now?: number) => number;
} {
  const src = fs.readFileSync(path.join(extensionDir(), 'app-link.js'), 'utf8');
  const pick = (re: RegExp, what: string): string => {
    const m = src.match(re);
    if (!m) throw new Error(`a bővítményben nincs ${what}`);
    return m[0].replace(/^export /, '');
  };
  const constSrc = pick(/export const CLOSED_FRESH_MS = [^;]+;/, 'CLOSED_FRESH_MS');
  const cleanSrc = pick(/function cleanClosed\(list\) \{[\s\S]*?\n\}/, 'cleanClosed');
  const forSrc = pick(/export function closedFor\(link, host[\s\S]*?\n\}/, 'closedFor');
  // A zárlat két függvénye ugyanebből a modulból, ugyanígy kivágva.
  const lockCleanSrc = pick(/function cleanLockdown\(raw\) \{[\s\S]*?\n\}/, 'cleanLockdown');
  const lockUntilSrc = pick(/export function lockdownUntil\(link[\s\S]*?\n\}/, 'lockdownUntil');
  // eslint-disable-next-line no-new-func
  return new Function(
    `${constSrc}\n${cleanSrc}\n${forSrc}\n${lockCleanSrc}\n${lockUntilSrc}\n`
    + 'return { CLOSED_FRESH_MS, cleanClosed, closedFor, cleanLockdown, lockdownUntil };',
  )() as ReturnType<typeof loadClosed>;
}

const { CLOSED_FRESH_MS, cleanClosed, closedFor, cleanLockdown, lockdownUntil } = loadClosed();
const NOW = 1_800_000_000_000;

const link = (over: Record<string, unknown> = {}) => ({
  fetchedAt: NOW - 5_000,
  closed: [
    { host: 'gemini.google.com', reason: 'cooldown', until: NOW + 300_000 },
    { host: 'youtube.com', reason: 'always', until: 0 },
  ],
  ...over,
});

test('friss listából, pontos hosztnévre megszólal — okostul', () => {
  const hit = closedFor(link(), 'gemini.google.com', NOW);
  assert.deepEqual(hit, { host: 'gemini.google.com', reason: 'cooldown', until: NOW + 300_000 });
  // A kézzel írt cím alakja nem dönthet: nagybetű és záró pont belefér.
  assert.ok(closedFor(link(), 'GEMINI.GOOGLE.COM.', NOW));
  // Lejárat nélküli zárás (sima tiltás) frissen szintén szól.
  assert.equal(closedFor(link(), 'youtube.com', NOW)?.reason, 'always');
});

test('csak PONTOS hosztnév számít — a hosts-fájl is így zár', () => {
  // Ha itt utótag-egyezés lenne, a lap olyan címre mondana zárva-t, amit a
  // DNS át is enged — a magyarázó réteg többet tiltana, mint a tiltás maga.
  assert.equal(closedFor(link(), 'www.gemini.google.com', NOW), null);
  assert.equal(closedFor(link(), 'google.com', NOW), null);
  assert.equal(closedFor(link(), 'notyoutube.com', NOW), null);
});

test('a lejáratos bejegyzés a saját idejével lejár', () => {
  // A hűtés véget ért, a hosts-fájl kinyitott — a lapnak is el kell hallgatnia,
  // FRISS lista mellett is: a lejárat nem a frissességen múlik, hanem magán a
  // bejegyzés idején. (Az elavultság külön tengely, külön teszttel.)
  const before = NOW + 299_999;
  assert.ok(closedFor(link({ fetchedAt: before - 5_000 }), 'gemini.google.com', before));
  const at = NOW + 300_000;
  assert.equal(closedFor(link({ fetchedAt: at - 5_000 }), 'gemini.google.com', at), null);
});

test('az elavult lista egészében néma — a lejárat nélküli zárás is', () => {
  // Az app nélkül a lista nem frissül, közben az appban bármi történhetett:
  // megváltott feloldás, levett tiltás, éjféli keret-újraindulás. Három
  // lehúzásnyi csend után a magyarázat elhallgat; a DNS úgyis tartja, amit kell.
  const stale = link({ fetchedAt: NOW - CLOSED_FRESH_MS - 1 });
  assert.equal(closedFor(stale, 'youtube.com', NOW), null);
  assert.equal(closedFor(stale, 'gemini.google.com', NOW), null);
  // A határon belül viszont él.
  assert.ok(closedFor(link({ fetchedAt: NOW - CLOSED_FRESH_MS + 1000 }), 'youtube.com', NOW));
});

test('szemétre nem szólal meg', () => {
  assert.equal(closedFor(link(), null, NOW), null, 'nem-web cím (chrome://) hosztja');
  assert.equal(closedFor(link(), '', NOW), null);
  assert.equal(closedFor(link({ closed: [] }), 'youtube.com', NOW), null);
  assert.equal(closedFor(link({ closed: undefined }), 'youtube.com', NOW), null);
  assert.equal(closedFor(null, 'youtube.com', NOW), null);
});

test('a tárból jövő lista szűrve van: csak az ismert alak megy át', () => {
  // A tárban bármi lehet (régi verzió, sérült írás). Egy rossz bejegyzés ne
  // vigye el a többit — és ismeretlen ok ne jusson el a lapig, mert ott
  // ismeretlen szöveg lenne belőle.
  const raw = [
    { host: 'GEMINI.google.com', reason: 'cooldown', until: NOW + 1000 },
    { host: 'youtube.com', reason: 'valami-uj', until: 0 },
    { host: '', reason: 'always', until: 0 },
    { host: 'x.com', reason: 'always', until: Number.NaN },
    'nem-objektum',
    null,
  ];
  assert.deepEqual(cleanClosed(raw), [
    { host: 'gemini.google.com', reason: 'cooldown', until: NOW + 1000 },
    { host: 'x.com', reason: 'always', until: 0 },
  ]);
  assert.deepEqual(cleanClosed(undefined), [], 'régi app válasza: nincs mező');
});

// ------------------------------------------------------------------ zárlat
//
// A zárlatnál a frissesség-szabály SZÁNDÉKOSAN más, mint a zárva-listánál: a
// zárlat csak hosszabbodhat, rövidülni nem, tehát egy régebbi lehúzás vége is
// igaz alsó becslés. A zárva-lista elavul; a zárlat vége nem.

test('zárlat a tárban: csak a vég, és csak ha szám', () => {
  assert.deepEqual(cleanLockdown({ until: NOW + 5 }), { until: NOW + 5 });
  assert.deepEqual(cleanLockdown({ until: '1800000000005', startedAt: 1 }), { until: 1_800_000_000_005 });
  // A heti ablak jele csak a szó szerinti igaz — a szemét nem jel.
  assert.deepEqual(cleanLockdown({ until: NOW + 5, byWindow: true }), { until: NOW + 5, byWindow: true });
  assert.deepEqual(cleanLockdown({ until: NOW + 5, byWindow: 'igen' }), { until: NOW + 5 });
  for (const junk of [null, undefined, 42, 'x', {}, { until: 0 }, { until: -1 }, { until: 'holnap' }]) {
    assert.equal(cleanLockdown(junk), null, `${JSON.stringify(junk)} nem zárlat`);
  }
});

test('zárlatot csak a még tartó vég mond — frissességtől függetlenül', () => {
  assert.equal(lockdownUntil({ lockdown: { until: NOW + 60_000 } }, NOW), NOW + 60_000);
  assert.equal(lockdownUntil({ lockdown: { until: NOW - 1 } }, NOW), 0, 'a lejárt nem zárlat');
  assert.equal(lockdownUntil({}, NOW), 0);
  assert.equal(lockdownUntil(null, NOW), 0);
  // Egy órája nem értük el az appot: a zárlat vége attól még igaz alsó becslés.
  assert.equal(lockdownUntil({ lockdown: { until: NOW + 60_000 }, fetchedAt: NOW - 3600_000 }, NOW),
    NOW + 60_000, 'elavult kapcsolatnál is szól');
});
