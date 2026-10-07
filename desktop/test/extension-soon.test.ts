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
  closingSoonFor: (link: unknown, host: unknown, now?: number) => { kind: string; leftMs: number; id: string } | null;
  focusStartingSoonFor: (link: unknown, host: unknown, now?: number) =>
    { kind: string; leftMs: number; name: string; id: string } | null;
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
    pick(/export function effectiveFocus\(link[\s\S]*?\n\}/, 'effectiveFocus'),
    pick(/export function focusStartingSoonFor\(link, host[\s\S]*?\n\}/, 'focusStartingSoonFor'),
  ];
  // eslint-disable-next-line no-new-func
  return new Function(
    `${parts.join('\n')}\nreturn { MAX_SOON, SOON_BANNER_MS, FOCUS_FRESH_MS, cleanSoon, closingSoonFor, focusStartingSoonFor };`,
  )() as ReturnType<typeof loadSoon>;
}

const { MAX_SOON, SOON_BANNER_MS, FOCUS_FRESH_MS, cleanSoon, closingSoonFor, focusStartingSoonFor } = loadSoon();
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
  assert.deepEqual(closingSoonFor(l, 'youtube.com', NOW), { kind: 'limit', leftMs: 55_000, id: 'limit' });
  assert.deepEqual(closingSoonFor(l, 'YOUTUBE.COM.', NOW), { kind: 'limit', leftMs: 55_000, id: 'limit' });
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

test('a heti ablakos menet indulása előtt szól — ha az oldal nincs a csomagban', () => {
  const win = (startsAt: number, allowSites = ['example.org'], name = 'Nyelvtanulás') =>
    ({ packId: 'p', name, allowSites, startsAt, endsAt: startsAt + 3_600_000 });
  const linkWith = (windows: unknown[], running = false) => ({
    fetchedAt: NOW - 5_000,
    focus: { running, endsAt: running ? NOW + 600_000 : 0, allowSites: [], windows },
  });
  const l = linkWith([win(NOW + 90_000)]);
  assert.deepEqual(focusStartingSoonFor(l, 'youtube.com', NOW),
    { kind: 'focus', leftMs: 90_000, name: 'Nyelvtanulás', id: `focus@p@${NOW + 90_000}` });
  // A csomag oldala (és az aldomainje) nyitva marad: arról nincs mit mondani.
  assert.equal(focusStartingSoonFor(l, 'example.org', NOW), null);
  assert.equal(focusStartingSoonFor(l, 'docs.example.org', NOW), null);
  // Messzebb, mint két perc: csend; már elindult: csend.
  assert.equal(focusStartingSoonFor(linkWith([win(NOW + 5 * 60_000)]), 'youtube.com', NOW), null);
  assert.equal(focusStartingSoonFor(linkWith([win(NOW - 1)]), 'youtube.com', NOW), null);
  // Ha már fut menet, és ez a lap nincs benne, a lap már zárva — nincs mit előre mondani.
  assert.equal(focusStartingSoonFor(linkWith([win(NOW + 60_000)], true), 'youtube.com', NOW), null);
  // A legközelebbi nyer.
  const two = linkWith([win(NOW + 100_000, [], 'Késő'), win(NOW + 30_000, [], 'Korai')]);
  assert.equal(focusStartingSoonFor(two, 'youtube.com', NOW)?.name, 'Korai');
  assert.equal(focusStartingSoonFor({}, 'youtube.com', NOW), null);
});

test('futó menet mellett is szól, ha a lapot az most engedi — az ablak kezdetén a segéd lezárja', () => {
  // Kézi „Munka” menet (docs.google.com) fut 10:30-ig; a „Nyelv” ablaka
  // (duolingo.com) 10:00-kor indul. A docs.google.com most megy, de az ablak
  // kezdetén zárul: erről szólni kell.
  const linkWith = (allowNow: string[], windows: unknown[]) => ({
    fetchedAt: NOW - 5_000,
    focus: { running: true, name: 'Munka', endsAt: NOW + 30 * 60_000, allowSites: allowNow, windows },
  });
  const nyelv = { packId: 'p_nyelv', name: 'Nyelv', allowSites: ['duolingo.com'], startsAt: NOW + 90_000, endsAt: NOW + 3_600_000 };
  const l = linkWith(['docs.google.com'], [nyelv]);
  assert.deepEqual(focusStartingSoonFor(l, 'docs.google.com', NOW),
    { kind: 'focus', leftMs: 90_000, name: 'Nyelv', id: `focus@p_nyelv@${NOW + 90_000}` });
  // Amit az ablak is enged, az nyitva marad.
  assert.equal(focusStartingSoonFor(l, 'duolingo.com', NOW), null);
  // Amit a futó menet sem enged, az már most zárva.
  assert.equal(focusStartingSoonFor(l, 'youtube.com', NOW), null);
  // A csomag SAJÁT menete mellett az ablak nem indít újat — a két lista ugyanaz, tehát csend.
  const own = linkWith(['duolingo.com'], [nyelv]);
  assert.equal(focusStartingSoonFor(own, 'duolingo.com', NOW), null);
});

test('a zárás azonosítója: fajta és időpont — a meghosszabbított szünet már másik zárás', () => {
  const a = closingSoonFor(link([{ host: 'youtube.com', kind: 'pause', at: NOW + 90_000 }]), 'youtube.com', NOW);
  const b = closingSoonFor(link([{ host: 'youtube.com', kind: 'pause', at: NOW + 100_000 }]), 'youtube.com', NOW);
  const c = closingSoonFor(link([{ host: 'youtube.com', kind: 'schedule', at: NOW + 90_000 }]), 'youtube.com', NOW);
  assert.equal(a?.id, `pause@${NOW + 90_000}`);
  assert.notEqual(a?.id, b?.id, 'más vég, más zárás');
  assert.notEqual(a?.id, c?.id, 'más fajta, más zárás');
  // A keretnek nincs időpontja (aktív idő): az azonosítója a fajta.
  assert.equal(closingSoonFor(link([{ host: 'youtube.com', kind: 'limit', left: 60 }]), 'youtube.com', NOW)?.id, 'limit');
});
