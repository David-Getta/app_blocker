// A hosztnevek fésülése: egyenlő revnél egyesülnek, nagyobb revnél a nyertesé.
//
// A hosztnév-lista a tiltás része (ezek mennek a hosts fájlba). Egy név
// levétele lazítás, ami csak próbatétel után, rev-emeléssel mehet át — azt a
// nagyobb rev viszi. Egy versenyhelyzet sosem oldhat fel semmit.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mergeSite, type SyncSite } from '../src/shared/sync/merge';

function site(over: Partial<SyncSite>): SyncSite {
  return {
    id: 'site_1', domain: 'youtube.com', hostnames: ['youtube.com'],
    addedAt: 1_000, pauseUntil: null, pendingDeleteAt: null,
    rev: 3, updatedAt: 100, updatedBy: 'a',
    ...over,
  };
}

test('egyenlő rev: a hosztnevek egyesülnek — a versenyhelyzet nem old fel', () => {
  const a = site({ hostnames: ['youtube.com', 'www.youtube.com'], updatedAt: 100, updatedBy: 'a' });
  const b = site({ hostnames: ['youtube.com', 'music.youtube.com'], updatedAt: 200, updatedBy: 'b' });
  const expected = ['music.youtube.com', 'www.youtube.com', 'youtube.com'];
  assert.deepEqual(mergeSite(a, b).hostnames, expected);
  assert.deepEqual(mergeSite(b, a).hostnames, expected, 'szimmetrikus');
});

test('nagyobb rev: a levétel átmegy — a próbatétel mögötte van', () => {
  const trimmed = site({ hostnames: ['youtube.com'], rev: 4, updatedAt: 300 });
  const old = site({ hostnames: ['youtube.com', 'music.youtube.com'], rev: 3 });
  assert.deepEqual(mergeSite(trimmed, old).hostnames, ['youtube.com']);
  assert.deepEqual(mergeSite(old, trimmed).hostnames, ['youtube.com']);
});

test('egyenlő rev, szigorúbb rekord: a szigorúbb nyer, a nevek attól még egyesülnek', () => {
  const stricter = site({ hostnames: ['youtube.com'], dailyLimitSeconds: 600 });
  const looser = site({ hostnames: ['youtube.com', 'm.youtube.com'], dailyLimitSeconds: 3600, updatedBy: 'b' });
  const m = mergeSite(stricter, looser);
  assert.equal(m.dailyLimitSeconds, 600);
  assert.deepEqual(m.hostnames, ['m.youtube.com', 'youtube.com']);
});
