// A felugró lap döntései — a KISZÁLLÍTOTT bájtokon.
//
// A `popup-core.js` szándékosan import nélküli, tiszta modul: itt a forrását
// olvassuk be, az `export` kulcsszavakat levesszük, és úgy futtatjuk — ami a
// zipbe kerül, azt teszteljük, nem egy másolatot.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

function extensionDir(): string {
  const here = path.resolve(__dirname);
  const candidates = [
    path.join(here, '..', '..', 'extension'),
    path.join(here, '..', '..', '..', 'extension'),
  ];
  const found = candidates.find((c) => fs.existsSync(path.join(c, 'popup-core.js')));
  if (!found) throw new Error(`nincs meg az extension mappa: ${candidates.join(', ')}`);
  return found;
}

interface Popup {
  describePopup: (link: unknown, now: number, freshMs: number) => {
    state: { kind: string; text: string };
    fresh: boolean;
    focus: { name: string; left: string; allowed: number; window: boolean } | null;
    closed: { host: string; reason: string; left: string | null }[];
    closedMore: number;
    rules: number;
    channels: number;
  };
  spanText: (ms: number) => string;
  agoText: (ms: number) => string;
  CLOSED_SHOWN: number;
}

function load(): Popup {
  const src = fs.readFileSync(path.join(extensionDir(), 'popup-core.js'), 'utf8').replace(/^export /gm, '');
  return new Function(`${src}\nreturn { describePopup, spanText, agoText, CLOSED_SHOWN };`)() as Popup;
}

const NOW = 1_800_000_000_000;
const FRESH = 60_000;

function link(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: 'JOKOD', port: 8788, rules: [], channels: [], closed: [],
    focus: { running: false, name: '', endsAt: 0, allowSites: [] },
    fetchedAt: NOW - 5_000, attemptedAt: NOW - 5_000, error: null,
    ...extra,
  };
}

test('összekötetlen: kimondja, és zárva-listát sem mutat', () => {
  const d = load().describePopup(link({ token: null, closed: [{ host: 'a.example', reason: 'always', until: 0 }] }), NOW, FRESH);
  assert.equal(d.state.kind, 'unlinked');
  assert.equal(d.fresh, false);
  assert.deepEqual(d.closed, []);
});

test('friss lista: a lejárt zárás kimarad, a futó hűtés a hátralévő idővel áll', () => {
  const d = load().describePopup(link({
    closed: [
      { host: 'youtube.com', reason: 'always', until: 0 },
      { host: 'gemini.google.com', reason: 'cooldown', until: NOW + 9 * 60_000 },
      { host: 'lejart.example', reason: 'limit', until: NOW - 1 },
      { host: 'youtube.com', reason: 'always', until: 0 }, // ismétlés
    ],
  }), NOW, FRESH);
  assert.equal(d.state.kind, 'fresh');
  assert.ok(d.state.text.includes('az imént'));
  assert.deepEqual(d.closed, [
    { host: 'youtube.com', reason: 'tiltva', left: null },
    { host: 'gemini.google.com', reason: 'adag-szünet', left: '9 p' },
  ]);
});

test('elavult lista: a zárva-sor hallgat, az állapot megmondja, mióta', () => {
  const d = load().describePopup(link({
    fetchedAt: NOW - 7 * 60_000,
    closed: [{ host: 'youtube.com', reason: 'always', until: 0 }],
  }), NOW, FRESH);
  assert.equal(d.state.kind, 'stale');
  assert.ok(d.state.text.includes('7 perce'));
  assert.equal(d.fresh, false);
  assert.deepEqual(d.closed, []);
});

test('sosem érte el az appot: a hibát mondja, ha van', () => {
  const p = load();
  assert.equal(p.describePopup(link({ fetchedAt: 0, error: 'ECONNREFUSED' }), NOW, FRESH).state.text,
    'Nem érem el az appot: ECONNREFUSED');
  assert.equal(p.describePopup(link({ fetchedAt: 0, error: null }), NOW, FRESH).state.kind, 'never');
});

test('a munkamenet csak amíg tart — a lejáratot helyben nézzük', () => {
  const p = load();
  const running = p.describePopup(link({
    focus: { running: true, name: 'Nyelvtanulás', endsAt: NOW + 42 * 60_000, allowSites: ['duolingo.com', 'deepl.com'] },
  }), NOW, FRESH);
  assert.deepEqual(running.focus, { name: 'Nyelvtanulás', left: '42 p', allowed: 2, window: false });
  const ended = p.describePopup(link({
    focus: { running: true, name: 'Nyelvtanulás', endsAt: NOW - 1, allowSites: [] },
  }), NOW, FRESH);
  assert.equal(ended.focus, null);
});

test('a heti ablak menete: a jel átjön, és csak a valódi igaz számít', () => {
  // Aki nem maga indította, a felugró lapon is tudja meg, miért fut — de egy
  // „yes” vagy egy 1 a hídról nem ablak: a jel csak boolean igazként él.
  const p = load();
  const windowed = p.describePopup(link({
    focus: { running: true, name: 'Mély munka', endsAt: NOW + 60 * 60_000, allowSites: ['github.com'], window: true },
  }), NOW, FRESH);
  assert.equal(windowed.focus?.window, true);
  for (const bad of ['yes', 1, undefined, null]) {
    const d = p.describePopup(link({
      focus: { running: true, name: 'Mély munka', endsAt: NOW + 60 * 60_000, allowSites: [], window: bad },
    }), NOW, FRESH);
    assert.equal(d.focus?.window, false, `window=${String(bad)}`);
  }
});

test('sok zárva név: plafon és összegző szám', () => {
  const p = load();
  const closed = Array.from({ length: p.CLOSED_SHOWN + 4 }, (_, i) => ({ host: `h${i}.example`, reason: 'always', until: 0 }));
  const d = p.describePopup(link({ closed }), NOW, FRESH);
  assert.equal(d.closed.length, p.CLOSED_SHOWN);
  assert.equal(d.closedMore, 4);
});

test('számok: szabályok és csatorna-szűrők', () => {
  const d = load().describePopup(link({
    rules: [{ host: 'a', path: '/x' }, { host: 'b', path: '/y' }],
    channels: [{ host: 'youtube.com', allow: ['@x'] }],
  }), NOW, FRESH);
  assert.equal(d.rules, 2);
  assert.equal(d.channels, 1);
});

test('idő-szövegek: perc alatt „az imént”, óra fölött kerekítve', () => {
  const p = load();
  assert.equal(p.agoText(30_000), 'az imént');
  assert.equal(p.agoText(3 * 60_000), '3 perce');
  assert.equal(p.spanText(1), '1 p');
  assert.equal(p.spanText(89 * 60_000), '89 p');
  assert.equal(p.spanText(150 * 60_000), 'kb. 3 ó');
});
