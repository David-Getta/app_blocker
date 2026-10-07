// A böngésző jele a mérőnek: melyik oldal van elöl.
//
// A tét: ha a gép nem tudja kiolvasni a böngésző címét (macOS-en a frissítés
// után visszavont engedély, Windowson egy címsor, amit a szonda nem lát), a
// böngészőben töltött idő APPKÉNT könyvelődik — és az oldalra szabott napi
// keret meg adag nem fogy. A bővítmény jele ezt pótolja. A határok: a szonda
// saját szeme elsőbb, a jel sosem nevez át egy nem-böngészőt oldalnak, és csak
// a friss, fókuszos jel számít.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  decideSample, HINT_APP_ID, TAB_HINT_FRESH_MS, withTabHint, type Foreground, type TabHint,
} from '../src/shared/usage';
import { answer, TOKEN_HEADER } from '../src/main/rules-bridge';

const NOW = 1_800_000_000_000;
const hint = (extra: Partial<TabHint> = {}): TabHint => ({ focused: true, host: 'youtube.com', at: NOW - 5_000, ...extra });
const chromeBlind: Foreground = { appId: 'com.google.Chrome', appName: 'Google Chrome', browser: true };

test('a vak böngésző a jelből kapja az oldalt — és a minta az oldalra megy, nem az appra', () => {
  const fg = withTabHint(chromeBlind, hint(), NOW);
  assert.deepEqual(fg, { ...chromeBlind, seen: true, domain: 'youtube.com' });
  const s = decideSample({ lastAt: NOW - 5_000, now: NOW, idleSeconds: 0, fg });
  assert.equal(s?.label, 'youtube.com', 'a keret az oldalé — enélkül „Google Chrome” lenne');
  // Nem weboldal (új lap, tiltó lap): tudjuk, mi van benne, de oldal nincs.
  assert.deepEqual(withTabHint(chromeBlind, hint({ host: null }), NOW), { ...chromeBlind, seen: true });
});

test('a jel határai: a szonda szeme elsőbb, nem-böngészőt nem nevez át, régi vagy fókusz nélküli jel nem számít', () => {
  // A szonda látta a címet: az övé a szó.
  const seen: Foreground = { ...chromeBlind, seen: true, domain: 'docs.google.com' };
  assert.equal(withTabHint(seen, hint(), NOW), seen);
  // Egy szövegszerkesztő perce sosem lesz oldal-perc.
  const word: Foreground = { appId: 'com.microsoft.Word', appName: 'Microsoft Word' };
  assert.equal(withTabHint(word, hint(), NOW), word);
  // Régi jel, jövőbeli jel (elállított óra), fókusz nélküli jel: semmi.
  assert.equal(withTabHint(chromeBlind, hint({ at: NOW - TAB_HINT_FRESH_MS - 1 }), NOW), chromeBlind);
  assert.equal(withTabHint(chromeBlind, hint({ at: NOW + TAB_HINT_FRESH_MS + 1 }), NOW), chromeBlind);
  assert.equal(withTabHint(chromeBlind, hint({ focused: false }), NOW), chromeBlind);
  assert.equal(withTabHint(chromeBlind, null, NOW), chromeBlind);
});

test('ha a szonda semmit nem látott, a fókuszos böngésző oldala akkor is mérődik', () => {
  // macOS-en a „System Events” engedélye is hiányzik: a szonda null. A
  // böngésző maga mondja, hogy elöl van, és mi van benne.
  assert.deepEqual(withTabHint(null, hint(), NOW),
    { appId: HINT_APP_ID, appName: 'Böngésző', browser: true, seen: true, domain: 'youtube.com' });
  // Oldal nélkül (új lap) nincs mit könyvelni, fókusz nélkül nincs miről.
  assert.equal(withTabHint(null, hint({ host: null }), NOW), null);
  assert.equal(withTabHint(null, hint({ focused: false }), NOW), null);
  assert.equal(withTabHint(null, hint({ at: NOW - TAB_HINT_FRESH_MS - 1 }), NOW), null);
});

test('a híd: kóddal, alakkal, és a hoszt ugyanúgy tisztítva, mint a szonda által olvasott cím', async () => {
  const got: { focused: boolean; host: string | null }[] = [];
  const d = { token: 'ABCD-EFGH', getRules: async () => [], noteTab: (h: { focused: boolean; host: string | null }) => { got.push(h); } };
  const post = (b: unknown, token = 'ABCD-EFGH') => answer(d, 'POST', '/tab', { [TOKEN_HEADER]: token }, b);
  assert.equal((await post({ focused: true, host: 'www.YouTube.com' })).status, 200);
  assert.equal((await post({ focused: true, host: null })).status, 200);
  assert.equal((await post({ focused: false, host: null })).status, 200);
  assert.equal((await post({ focused: true, host: 'localhost' })).status, 200);
  assert.deepEqual(got, [
    { focused: true, host: 'youtube.com' },
    { focused: true, host: null },
    { focused: false, host: null },
    { focused: true, host: null },
  ]);
  for (const bad of [{}, { focused: 'igen', host: null }, { focused: true }, { focused: true, host: 5 }, null]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await post({ focused: true, host: 'x.com' }, 'ROSSZ')).status, 401, 'kód nélkül nincs jel');
  assert.equal(got.length, 4, 'a rossz kérés nem jut el a mérőig');
});

/** Egy forrásfájl a tesztek mellől — forrásból és fordított kimenetből is. */
function source(rel: string): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
    dir = path.dirname(dir);
  }
  throw new Error(`nem találom: ${rel}`);
}

test('a bekötés: a mérő a szonda egészsége UTÁN alkalmazza a jelet, a fő folyamat adja, a bővítmény küldi', () => {
  const tracker = source('src/main/tracker.ts');
  const health = tracker.indexOf('this.health.record(probed !== null);');
  const apply = tracker.indexOf('const fg = withTabHint(probed, this.deps.tabHint?.() ?? null, Date.now());');
  assert.ok(health > 0 && apply > health, 'a hiányzó engedély a felületen látszik — a jel nem takarja el');
  assert.ok(tracker.includes('if (url !== null) {\n    fg.seen = true;'), 'macOS: a kiolvasott cím látvány');
  const main = source('src/main/main.ts');
  assert.ok(main.includes('tabHint: () => extensionTabHint(),'));
  const bg = source('extension/background.js');
  assert.ok(bg.includes('chrome.windows.onFocusChanged.addListener(() => { void sendTabHint(); });'));
  assert.ok(bg.includes('chrome.tabs.onActivated.addListener(() => { void sendTabHint(); });'));
  assert.ok(bg.includes('if (isTopFrame(details)) void sendTabHint();'));
});
