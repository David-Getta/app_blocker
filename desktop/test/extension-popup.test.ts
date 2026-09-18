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
    lockdown: { left: string; byWindow: boolean } | null;
    partner: string | null;
    focus: { name: string; left: string; allowed: number; window: boolean } | null;
    closed: { host: string; reason: string; left: string | null }[];
    closedMore: number;
    rules: number;
    channels: number;
    keywords: number;
  };
  spanText: (ms: number) => string;
  agoText: (ms: number) => string;
  CLOSED_SHOWN: number;
  suggestButton: (link: unknown, now: number, freshMs: number) => { packId: string; minutes: number; text: string } | null;
  windowButton: (link: unknown, now: number, freshMs: number) => { packId: string; hour: number; text: string } | null;
  focusHourWindowButton: (link: unknown, now: number, freshMs: number) => { packId: string; hour: number; text: string } | null;
  focusHourCoverText: (link: unknown, now: number, freshMs: number) => string;
  sameHourText: (link: unknown, now: number, freshMs: number) => string;
  hourSpan: (h: number) => string;
  peakCoverText: (link: unknown, now: number, freshMs: number) => string;
  focusDayText: (link: unknown, now: number, freshMs: number) => string;
  focusHourNowText: (link: unknown, now: number, freshMs: number) => string;
}

function load(): Popup {
  const src = fs.readFileSync(path.join(extensionDir(), 'popup-core.js'), 'utf8').replace(/^export /gm, '');
  return new Function(`${src}\nreturn { describePopup, spanText, agoText, CLOSED_SHOWN, suggestButton, windowButton, focusHourWindowButton, hourSpan, peakCoverText, sameHourText, focusHourCoverText, focusDayText, focusHourNowText };`)() as Popup;
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

test('számok: szabályok, csatorna-szűrők és kulcsszavak', () => {
  const d = load().describePopup(link({
    rules: [{ host: 'a', path: '/x' }, { host: 'b', path: '/y' }],
    channels: [{ host: 'youtube.com', allow: ['@x'] }],
    keywords: ['shorts', 'reels', 'live'],
  }), NOW, FRESH);
  assert.equal(d.rules, 2);
  assert.equal(d.channels, 1);
  assert.equal(d.keywords, 3);
  assert.equal(load().describePopup(link({}), NOW, FRESH).keywords, 0, 'régi tár: kulcsszó nélkül nulla');
});

test('idő-szövegek: perc alatt „az imént”, óra fölött kerekítve', () => {
  const p = load();
  assert.equal(p.agoText(30_000), 'az imént');
  assert.equal(p.agoText(3 * 60_000), '3 perce');
  assert.equal(p.spanText(1), '1 p');
  assert.equal(p.spanText(89 * 60_000), '89 p');
  assert.equal(p.spanText(150 * 60_000), 'kb. 3 ó');
});

test('a megbízott: összekötve a sor beszél; összekötetlenül hallgat; frissesség nélkül is', () => {
  const { describePopup } = load();
  assert.equal(describePopup(link({ partner: { name: 'Anna' } }), NOW, FRESH).partner, 'Anna');
  assert.equal(describePopup(link({}), NOW, FRESH).partner, null, 'megbízott nélkül nincs sor');
  assert.equal(describePopup(link({ partner: { name: '' } }), NOW, FRESH).partner, null);
  assert.equal(describePopup(link({ token: '', partner: { name: 'Anna' } }), NOW, FRESH).partner, null,
    'összekötetlenül nem beszélünk az app állapotáról');
  assert.equal(describePopup(link({ partner: { name: 'Anna' }, fetchedAt: NOW - 3600_000 }), NOW, FRESH).partner,
    'Anna', 'a megbízott a lenyomattal él, nem a lehúzással');
});

test('zárlat: összekötve és tart — a sor beszél; lejárt vagy összekötetlen — hallgat', () => {
  const { describePopup } = load();
  const live = describePopup(link({ lockdown: { until: NOW + 3 * 3600_000 } }), NOW, FRESH);
  assert.deepEqual(live.lockdown, { left: 'kb. 3 ó', byWindow: false });
  // A heti ablak jele is átmegy a sorba: a lap kimondja, hogy az ablak tartja.
  const win = describePopup(link({ lockdown: { until: NOW + 3 * 3600_000, byWindow: true } }), NOW, FRESH);
  assert.deepEqual(win.lockdown, { left: 'kb. 3 ó', byWindow: true });

  // Frissesség NÉLKÜL is: a zárlat csak hosszabbodhat, egy régi lehúzás vége
  // is igaz alsó becslés. (A zárva-lista ebben más — az elavul.)
  const stale = describePopup(
    link({ lockdown: { until: NOW + 3 * 3600_000 }, fetchedAt: NOW - 10 * 60_000 }), NOW, FRESH,
  );
  assert.deepEqual(stale.lockdown, { left: 'kb. 3 ó', byWindow: false }, 'elavult listánál is szól');

  const over = describePopup(link({ lockdown: { until: NOW - 1 } }), NOW, FRESH);
  assert.equal(over.lockdown, null, 'a lejárt zárlat nem zárlat');

  const unlinked = describePopup(link({ token: '', lockdown: { until: NOW + 3600_000 } }), NOW, FRESH);
  assert.equal(unlinked.lockdown, null, 'összekötetlenül nem beszélünk az app állapotáról');
});

test('a menet gombja: friss válasz, javaslat és futó menet nélkül — a szöveg az appé', () => {
  const { suggestButton } = load();
  const s = { packId: 'pack_1', name: 'Nyelvtanulás', minutes: 25 };
  assert.deepEqual(suggestButton(link({ suggest: s }), NOW, FRESH),
    { packId: 'pack_1', minutes: 25, text: 'Munkamenet: Nyelvtanulás, 25 perc' });
  assert.equal(suggestButton(link({}), NOW, FRESH), null, 'javaslat nélkül nincs gomb');
  assert.equal(suggestButton(link({ suggest: s, fetchedAt: NOW - 10 * 60_000 }), NOW, FRESH), null, 'elavult válasz mellett nincs');
  assert.equal(suggestButton(link({ suggest: s, focus: { running: true, name: 'X', endsAt: NOW + 60_000, allowSites: [] } }), NOW, FRESH),
    null, 'futó menet mellett nincs: egyszerre egy menet fut');
  assert.equal(suggestButton(link({ suggest: { packId: 'p', name: 'N', minutes: 0 } }), NOW, FRESH), null, 'nulla perc nem menet');
  assert.equal(suggestButton(link({ suggest: s, token: null }), NOW, FRESH), null, 'összekötetlenül nincs gomb');
});

test('a csúcs-óra ablakának gombja: a menet kapui, és az app csúcs-órája', () => {
  const { windowButton, hourSpan } = load();
  const s = { packId: 'pack_1', name: 'Nyelvtanulás', minutes: 25, peakHour: 21 };
  assert.deepEqual(windowButton(link({ suggest: s }), NOW, FRESH),
    { packId: 'pack_1', hour: 21, text: 'Heti ablak a csúcs-órára: Nyelvtanulás, minden nap 21:00–22:00' });
  assert.equal(windowButton(link({ suggest: { ...s, peakHour: null } }), NOW, FRESH), null, 'csúcs-óra nélkül nincs gomb');
  assert.equal(windowButton(link({ suggest: { ...s, peakHour: 24 } }), NOW, FRESH), null, 'rossz óra: nincs gomb');
  assert.equal(windowButton(link({ suggest: s, fetchedAt: NOW - 10 * 60_000 }), NOW, FRESH), null, 'elavult válasz mellett nincs');
  assert.equal(windowButton(link({ suggest: s, focus: { running: true, name: 'X', endsAt: NOW + 60_000, allowSites: [] } }), NOW, FRESH),
    null, 'futó menet mellett nincs');
  assert.equal(windowButton(link({ suggest: s, token: null }), NOW, FRESH), null, 'összekötetlenül nincs gomb');
  assert.equal(hourSpan(23), '23:00–00:00', 'a nap vége — mint az app ablak-címkéjén');
  assert.equal(hourSpan(0), '00:00–01:00');
});

test('a menet-óra ablakának gombja: a csúcs-óra gombjának tükre — a menet kapui, és az app menet-órája', () => {
  const { focusHourWindowButton } = load();
  const s = { packId: 'pack_1', name: 'Nyelvtanulás', minutes: 25, peakHour: 21, focusHour: 9 };
  assert.deepEqual(focusHourWindowButton(link({ suggest: s }), NOW, FRESH),
    { packId: 'pack_1', hour: 9, text: 'Heti ablak a menet-órára: Nyelvtanulás, minden nap 09:00–10:00' });
  assert.equal(focusHourWindowButton(link({ suggest: { ...s, focusHour: null } }), NOW, FRESH), null, 'menet-óra nélkül (vagy a csúcs-órán) nincs gomb');
  assert.equal(focusHourWindowButton(link({ suggest: { ...s, focusHour: 24 } }), NOW, FRESH), null, 'rossz óra: nincs gomb');
  assert.equal(focusHourWindowButton(link({ suggest: s, fetchedAt: NOW - 10 * 60_000 }), NOW, FRESH), null, 'elavult válasz mellett nincs');
  assert.equal(focusHourWindowButton(link({ suggest: s, focus: { running: true, name: 'X', endsAt: NOW + 60_000, allowSites: [] } }), NOW, FRESH),
    null, 'futó menet mellett nincs');
  assert.equal(focusHourWindowButton(link({ suggest: s, token: null }), NOW, FRESH), null, 'összekötetlenül nincs gomb');
});

test('a felugró lap kimondja, ha a csúcs-órát ablak fedi — az app szava, frissen, összekötve', () => {
  const { peakCoverText } = load();
  const s = { packId: 'pack_1', name: 'Nyelvtanulás', minutes: 25, peakHour: null, peakPack: 'Nyelvtanulás' };
  assert.equal(peakCoverText(link({ suggest: s }), NOW, FRESH), ' A csúcs-órában magától indul: Nyelvtanulás.');
  assert.equal(peakCoverText(link({ suggest: { ...s, peakPack: null } }), NOW, FRESH), '', 'fedés nélkül nincs mondat');
  assert.equal(peakCoverText(link({}), NOW, FRESH), '', 'javaslat nélkül nincs');
  assert.equal(peakCoverText(link({ suggest: s, fetchedAt: NOW - 10 * 60_000 }), NOW, FRESH), '', 'elavult válasz mellett nincs');
  assert.equal(peakCoverText(link({ suggest: s, token: null }), NOW, FRESH), '', 'összekötetlenül nincs');
});

test('a felugró lap kimondja, ha a csúcs-óra a menet-óra — az app szava, frissen, összekötve, csak a szó szerinti igaz', () => {
  const { sameHourText } = load();
  const s = { packId: 'pack_1', name: 'Nyelvtanulás', minutes: 25, peakHour: null, peakPack: null, sameHour: true };
  assert.equal(sameHourText(link({ suggest: s }), NOW, FRESH), ' Ez a menet-órád is: a kéz akkor jár, amikor le szoktál ülni.');
  assert.equal(sameHourText(link({ suggest: { ...s, sameHour: false } }), NOW, FRESH), '', 'más órán nincs mondat');
  assert.equal(sameHourText(link({ suggest: { ...s, sameHour: 'igen' } }), NOW, FRESH), '', 'csak a szó szerinti igaz');
  assert.equal(sameHourText(link({}), NOW, FRESH), '', 'javaslat nélkül nincs');
  assert.equal(sameHourText(link({ suggest: s, fetchedAt: NOW - 10 * 60_000 }), NOW, FRESH), '', 'elavult válasz mellett nincs');
  assert.equal(sameHourText(link({ suggest: s, token: null }), NOW, FRESH), '', 'összekötetlenül nincs');
});

test('a lap kimondja, ha a menet-órát ablak fedi — az app szava, frissen, összekötve', () => {
  const { focusHourCoverText } = load();
  const s = { packId: 'pack_1', name: 'Nyelvtanulás', minutes: 25, peakHour: null, peakPack: null, focusHourPack: 'Nyelvtanulás' };
  assert.equal(focusHourCoverText(link({ suggest: s }), NOW, FRESH), ' A menet-órában magától indul: Nyelvtanulás.');
  assert.equal(focusHourCoverText(link({ suggest: { ...s, focusHourPack: null } }), NOW, FRESH), '', 'fedés nélkül nincs mondat');
  assert.equal(focusHourCoverText(link({}), NOW, FRESH), '', 'javaslat nélkül nincs');
  assert.equal(focusHourCoverText(link({ suggest: s, fetchedAt: NOW - 10 * 60_000 }), NOW, FRESH), '', 'elavult válasz mellett nincs');
  assert.equal(focusHourCoverText(link({ suggest: s, token: null }), NOW, FRESH), '', 'összekötetlenül nincs');
});

test('a menet-nap a gomb mellett: az app szava, frissen, összekötve — csak a szó szerinti igaz', () => {
  const { focusDayText } = load();
  const s = { packId: 'pack_1', name: 'Nyelvtanulás', minutes: 25, peakHour: null, peakPack: null, focusDay: true };
  assert.equal(focusDayText(link({ suggest: s }), NOW, FRESH), ' Ma a menet-napod van — ilyenkor szoktál leülni.');
  assert.equal(focusDayText(link({ suggest: { ...s, focusDay: false } }), NOW, FRESH), '', 'más napon nincs mondat');
  assert.equal(focusDayText(link({ suggest: { ...s, focusDay: 'igen' } }), NOW, FRESH), '', 'csak a szó szerinti igaz');
  assert.equal(focusDayText(link({}), NOW, FRESH), '', 'javaslat nélkül nincs');
  assert.equal(focusDayText(link({ suggest: s, fetchedAt: NOW - 10 * 60_000 }), NOW, FRESH), '', 'elavult válasz mellett nincs');
  assert.equal(focusDayText(link({ suggest: s, token: null }), NOW, FRESH), '', 'összekötetlenül nincs');
});

test('a menet-óra a gomb mellett: az app szava, frissen, összekötve — csak a szó szerinti igaz', () => {
  const { focusHourNowText } = load();
  const s = { packId: 'pack_1', name: 'Nyelvtanulás', minutes: 25, peakHour: null, peakPack: null, focusDay: false, focusHourNow: true };
  assert.equal(focusHourNowText(link({ suggest: s }), NOW, FRESH), ' Most a menet-órád van.');
  assert.equal(focusHourNowText(link({ suggest: { ...s, focusHourNow: false } }), NOW, FRESH), '', 'más órában nincs mondat');
  assert.equal(focusHourNowText(link({ suggest: { ...s, focusHourNow: 1 } }), NOW, FRESH), '', 'csak a szó szerinti igaz');
  assert.equal(focusHourNowText(link({ suggest: s, fetchedAt: NOW - 10 * 60_000 }), NOW, FRESH), '', 'elavult válasz mellett nincs');
  assert.equal(focusHourNowText(link({ suggest: s, token: null }), NOW, FRESH), '', 'összekötetlenül nincs');
});

test('idő-szöveg napokban: a hetes zárlat nem „kb. 168 ó”', () => {
  const { spanText } = load();
  assert.equal(spanText(7 * 24 * 3600_000), 'kb. 7 nap');
  assert.equal(spanText(47 * 3600_000), 'kb. 47 ó', 'két nap alatt marad az óra');
});
