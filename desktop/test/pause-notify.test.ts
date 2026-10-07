import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { PAUSE_END_WARN_MS, pauseEndText, stepPauseNotices } from '../src/shared/pause-notify';

const T = 1_800_000_000_000;
const site = (pauseUntil: number | null, id = 's1', label = 'youtube.com', closes = true) =>
  ({ id, label, pauseUntil, closes });

test('a hosszú szünet élesít, és a figyelmeztetés idején egyszer szól', () => {
  let r = stepPauseNotices({}, [site(T + 10 * 60_000)], T);
  assert.deepEqual(r.notices, []);
  assert.equal(r.watches.s1, T + 10 * 60_000);
  // Még kívül az ablakon: csend, a figyelés marad.
  r = stepPauseNotices(r.watches, [site(T + 10 * 60_000)], T + 7 * 60_000);
  assert.deepEqual(r.notices, []);
  // Beért: egyszer szól, a figyelés megszűnik.
  r = stepPauseNotices(r.watches, [site(T + 10 * 60_000)], T + 8 * 60_000 + 1);
  assert.deepEqual(r.notices, [{ label: 'youtube.com', until: T + 10 * 60_000 }]);
  assert.equal(r.watches.s1, undefined);
  // A következő körben nem ismétli.
  r = stepPauseNotices(r.watches, [site(T + 10 * 60_000)], T + 9 * 60_000);
  assert.deepEqual(r.notices, []);
});

test('a frissen indított rövid szünetre hallgat — épp most állította be', () => {
  const r = stepPauseNotices({}, [site(T + 60_000)], T);
  assert.deepEqual(r.notices, []);
  assert.deepEqual(r.watches, {});
});

test('új vég új figyelés; a visszakapcsolt és a lejárt szünetre hallgat', () => {
  let r = stepPauseNotices({}, [site(T + 10 * 60_000)], T);
  // Közben új feloldás: a vég kitolódott — a régi figyelés nem szól rá.
  r = stepPauseNotices(r.watches, [site(T + 30 * 60_000)], T + 8 * 60_000 + 1);
  assert.deepEqual(r.notices, []);
  assert.equal(r.watches.s1, T + 30 * 60_000);
  // Visszakapcsolta: nincs szünet, nincs szó.
  r = stepPauseNotices(r.watches, [site(null)], T + 9 * 60_000);
  assert.deepEqual(r.notices, []);
  assert.deepEqual(r.watches, {});
  // Ami már lejárt, arra sem.
  r = stepPauseNotices({ s1: T }, [site(T)], T + 1);
  assert.deepEqual(r.notices, []);
});

test('a frissebb névvel szól (fedőnév), és oldalanként külön figyel', () => {
  let r = stepPauseNotices({}, [site(T + 10 * 60_000), site(T + 20 * 60_000, 's2', 'reddit.com')], T);
  r = stepPauseNotices(r.watches,
    [site(T + 10 * 60_000, 's1', 'Munka'), site(T + 20 * 60_000, 's2', 'reddit.com')], T + 8 * 60_000 + 5);
  assert.deepEqual(r.notices, [{ label: 'Munka', until: T + 10 * 60_000 }]);
  assert.equal(r.watches.s2, T + 20 * 60_000);
});

test('a szöveg: a hátralévő perc felfelé kerekít, és legalább egy', () => {
  assert.equal(pauseEndText('youtube.com', PAUSE_END_WARN_MS), 'youtube.com 2 perc múlva újra zárva — a szünet véget ér.');
  assert.equal(pauseEndText('youtube.com', 61_000), 'youtube.com 2 perc múlva újra zárva — a szünet véget ér.');
  assert.equal(pauseEndText('youtube.com', 60_000), 'youtube.com 1 perc múlva újra zárva — a szünet véget ér.');
  assert.equal(pauseEndText('youtube.com', 5_000), 'youtube.com 1 perc múlva újra zárva — a szünet véget ér.');
});

test('ha az oldal a szünet végén nem zárul, nem szól — a „mindjárt újra zárva” hamis volna', () => {
  // Hétköznap 9–17 tiltás, 16:30-kor egy órára feloldva: 17:30-kor a menetrend
  // már nyitva hagyja. A hívó a mag döntéséből tölti ki (`closesAfterPause`).
  let r = stepPauseNotices({}, [site(T + 10 * 60_000, 's1', 'youtube.com', false)], T);
  assert.deepEqual(r.watches, {}, 'nem is élesít');
  r = stepPauseNotices(r.watches, [site(T + 10 * 60_000, 's1', 'youtube.com', false)], T + 8 * 60_000 + 1);
  assert.deepEqual(r.notices, []);
  // Ha közben zárulóvá válik (a keret közben elfogyott) — és még van idő —, élesít, és szól.
  r = stepPauseNotices(r.watches, [site(T + 20 * 60_000, 's1', 'youtube.com', false)], T + 9 * 60_000);
  r = stepPauseNotices(r.watches, [site(T + 20 * 60_000)], T + 10 * 60_000);
  assert.equal(r.watches.s1, T + 20 * 60_000);
  r = stepPauseNotices(r.watches, [site(T + 20 * 60_000)], T + 18 * 60_000 + 1);
  assert.equal(r.notices.length, 1);
});
