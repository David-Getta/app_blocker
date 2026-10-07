// A bővítmény zárás előtti sávja: mikor szólalhat meg.
//
// Magyarázat, nem érvényesítés, mint a zárva-lista: a hiba iránya itt is a
// hallgatás. Régi jelre nem szól (a szünetet azóta visszakapcsolhatta), csak
// pontos hosztnévre, és csak az utolsó két percben. A keretnél az idő nem óra,
// hanem aktív idő: a lehúzás óta eltelt időt levonjuk — inkább korábban.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

function extensionDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'extension');
    if (fs.existsSync(path.join(candidate, 'app-link.js'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('nem talalom az extension/ mappat');
}

/** A KISZÁLLÍTOTT kód: a két állandó, a tisztítás, a frissesség és a döntés. */
function loadSoon(): {
  MAX_SOON: number;
  SOON_BANNER_MS: number;
  FOCUS_FRESH_MS: number;
  cleanSoon: (list: unknown) => { host: string; kind: string; at?: number; left?: number }[];
  closingSoonFor: (link: unknown, host: unknown, now?: number) => { kind: string; leftMs: number } | null;
} {
  const src = fs.readFileSync(path.join(extensionDir(), 'app-link.js'), 'utf8');
  const pick = (re: RegExp, what: string): string => {
    const m = src.match(re);
    if (!m) throw new Error(`a bővítményben nincs ${what}`);
    return m[0].replace(/^export /, '');
  };
  const parts = [
    pick(/export const MAX_SOON = [^;]+;/, 'MAX_SOON'),
    pick(/export const SOON_BANNER_MS = [^;]+;/, 'SOON_BANNER_MS'),
    pick(/export const FOCUS_FRESH_MS = [^;]+;/, 'FOCUS_FRESH_MS'),
    pick(/export function appFresh\(link[\s\S]*?\n\}/, 'appFresh'),
    pick(/export function cleanSoon\(list\) \{[\s\S]*?\n\}/, 'cleanSoon'),
    pick(/export function closingSoonFor\(link, host[\s\S]*?\n\}/, 'closingSoonFor'),
  ];
  // eslint-disable-next-line no-new-func
  return new Function(
    `${parts.join('\n')}\nreturn { MAX_SOON, SOON_BANNER_MS, FOCUS_FRESH_MS, cleanSoon, closingSoonFor };`,
  )() as ReturnType<typeof loadSoon>;
}

const { MAX_SOON, SOON_BANNER_MS, FOCUS_FRESH_MS, cleanSoon, closingSoonFor } = loadSoon();
const NOW = 1_800_000_000_000;

const link = (soon: unknown[], fetchedAt = NOW - 5_000) => ({ fetchedAt, soon: cleanSoon(soon) });

test('a tisztítás csak az ismert alakot engedi át, és plafonnal', () => {
  const got = cleanSoon([
    { host: 'YouTube.com', kind: 'pause', at: NOW + 60_000 },
    { host: 'reddit.com', kind: 'schedule', at: NOW + 90_000 },
    { host: 'x.com', kind: 'limit', left: 30 },
    { host: 'a.com', kind: 'limit', at: NOW },          // keretnél `left` kell
    { host: 'b.com', kind: 'pause', left: 30 },         // szünetnél `at` kell
    { host: 'c.com', kind: 'cooldown', at: NOW + 1 },   // ismeretlen fajta
    { host: '', kind: 'pause', at: NOW + 1 },
    null, 'x', { host: 'd.com', kind: 'limit', left: 0 },
  ]);
  assert.deepEqual(got, [
    { host: 'youtube.com', kind: 'pause', at: NOW + 60_000 },
    { host: 'reddit.com', kind: 'schedule', at: NOW + 90_000 },
    { host: 'x.com', kind: 'limit', left: 30 },
  ]);
  assert.deepEqual(cleanSoon(undefined), []);
  const many = Array.from({ length: MAX_SOON + 10 }, (_, i) => ({ host: `h${i}.com`, kind: 'pause', at: NOW + 1 }));
  assert.equal(cleanSoon(many).length, MAX_SOON);
});

test('az utolsó két percben szól, pontos hosztnévre, a legközelebbi nyer', () => {
  const l = link([
    { host: 'youtube.com', kind: 'pause', at: NOW + 90_000 },
    { host: 'youtube.com', kind: 'limit', left: 60 },
    { host: 'reddit.com', kind: 'schedule', at: NOW + 5 * 60_000 },
  ]);
  // A keret: 60 mp a lehúzáskor, azóta 5 mp telt el → 55 mp; a szünet 90 mp.
  assert.deepEqual(closingSoonFor(l, 'youtube.com', NOW), { kind: 'limit', leftMs: 55_000 });
  assert.deepEqual(closingSoonFor(l, 'YOUTUBE.COM.', NOW), { kind: 'limit', leftMs: 55_000 });
  // Öt perc még messze van: csend.
  assert.equal(closingSoonFor(l, 'reddit.com', NOW), null);
  assert.equal(closingSoonFor(l, 'reddit.com', NOW + 3 * 60_000 + 1)?.kind, undefined); // a lehúzás azóta elavult
  // Utótag nem számít — a hosts-fájl is pontosan zár.
  assert.equal(closingSoonFor(l, 'm.youtube.com', NOW), null);
});

test('régi jelre és lejártra hallgat', () => {
  const stale = link([{ host: 'youtube.com', kind: 'pause', at: NOW + 60_000 }], NOW - FOCUS_FRESH_MS - 1);
  assert.equal(closingSoonFor(stale, 'youtube.com', NOW), null);
  const past = link([{ host: 'youtube.com', kind: 'pause', at: NOW - 1 }]);
  assert.equal(closingSoonFor(past, 'youtube.com', NOW), null);
  // A keret is „lejár”: ha a lehúzás óta több telt el, mint ami hátra volt.
  const spent = link([{ host: 'youtube.com', kind: 'limit', left: 4 }]);
  assert.equal(closingSoonFor(spent, 'youtube.com', NOW), null);
  assert.equal(closingSoonFor({}, 'youtube.com', NOW), null);
  assert.ok(SOON_BANNER_MS === 2 * 60_000);
});
