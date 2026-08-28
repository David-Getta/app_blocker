import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  emptyChannels, mergeChannels, normalizeSyncChannels, sameChannels, type SyncChannels,
} from '../src/shared/sync/channels-merge';
import { bumpChannelsRevision, adoptChannelsRevision } from '../src/helper/revisions';
import { defaultState, type HelperState } from '../src/helper/state';

/**
 * A csatorna-szűrők összefésülése: a frissebb oldal listája nyer, és a
 * döntésnek DETERMINISZTIKUSNAK kell lennie — különben két eszköz örökké
 * oda-vissza írná egymást, és a szinkron sosem konvergálna.
 */

function chans(over: Partial<SyncChannels> = {}): SyncChannels {
  return {
    filters: [{ id: 'chf_1', host: 'youtube.com', allow: ['@jo'], enabled: true }],
    rev: 1, updatedAt: 1000, updatedBy: 'gep',
    ...over,
  };
}

test('a nagyobb rev nyer — a lazítás mögött ott a munka', () => {
  const local = chans({ rev: 2, filters: [{ id: 'chf_1', host: 'youtube.com', allow: ['@jo'], enabled: false }] });
  const remote = chans({ rev: 1 });
  const m = mergeChannels(local, remote);
  assert.equal(m.filters[0].enabled, false, 'a kikapcsolás próbatétellel történt — átér');
  assert.equal(m.rev, 2);
});

test('egy régi, üres állapot visszajátszása nem töröl semmit', () => {
  const local = chans({ rev: 3 });
  const stale = emptyChannels('telefon'); // rev 0, üres
  const m = mergeChannels(local, stale);
  assert.equal(m.filters.length, 1, 'az üres lista nem nyerhet kisebb rev-vel');
});

test('a döntetlen-eltörés determinisztikus: mindkét irányból ugyanaz az eredmény', () => {
  const a = chans({ rev: 2, updatedAt: 5000, updatedBy: 'aaa', filters: [{ id: 'chf_a', host: 'a.com', allow: ['@x'], enabled: true }] });
  const b = chans({ rev: 2, updatedAt: 5000, updatedBy: 'bbb', filters: [{ id: 'chf_b', host: 'b.com', allow: ['@y'], enabled: true }] });
  const ab = mergeChannels(a, b);
  const ba = mergeChannels(b, a);
  assert.deepEqual(ab, ba, 'a hívási sorrend nem dönthet');
  assert.equal(ab.filters[0].id, 'chf_b', 'azonos rev és idő mellett a nagyobb eszközazonosító');
});

test('a kívülről jött blobot ugyanaz a tisztító nézi át, mint a helyi mentést', () => {
  const raw = {
    filters: [
      { id: 'chf_1', host: 'https://www.YouTube.com/', allow: ['@Jo', '  ', 'két szó'], enabled: true },
      { id: 'chf_1', host: 'tiktok.com', allow: ['@masodik'], enabled: true }, // kettőzött id
      { id: '', host: 'tiktok.com', allow: ['@x'], enabled: true },            // nincs id
      { id: 'chf_2', host: 'nem jó hoszt', allow: ['@x'], enabled: true },     // rossz hoszt
      { id: 'chf_3', host: 'tiktok.com', allow: ['  '], enabled: true },       // üres fehérlista
    ],
    rev: 'nem szám', updatedAt: 7, updatedBy: '',
  };
  const n = normalizeSyncChannels(raw, 'gep');
  assert.equal(n.filters.length, 1);
  assert.deepEqual(n.filters[0], { id: 'chf_1', host: 'youtube.com', allow: ['@jo'], enabled: true });
  assert.equal(n.rev, 0, 'a szemét rev nullává szelídül');
  assert.equal(n.updatedBy, 'gep');
});

test('sameChannels: az engedélylista sorrendje nem különbség', () => {
  const a = chans({ filters: [{ id: 'chf_1', host: 'youtube.com', allow: ['@a', '@b'], enabled: true }] });
  const b = chans({ filters: [{ id: 'chf_1', host: 'youtube.com', allow: ['@b', '@a'], enabled: true }] });
  assert.ok(sameChannels(a, b), 'átrendeződéstől nem indulhat feltöltés');
});

// ------------------------------------------------------------ rev-vezetés

function stateWith(filters: HelperState['channelFilters']): HelperState {
  const s = defaultState();
  s.channelFilters = filters;
  return s;
}

test('az üresség nem szerkesztés: új eszköz nem kap számlálót', () => {
  const s = stateWith([]);
  assert.equal(bumpChannelsRevision(s, 'uj-gep', 1000), false);
  assert.equal(s.channelsRev ?? 0, 0,
    'különben az üres lista frissebb idővel letörölné a másik gép szűrőit');
});

test('a változás léptet, az átvétel nem', () => {
  const s = stateWith([{ id: 'chf_1', host: 'youtube.com', allow: ['@jo'], enabled: true }]);
  assert.equal(bumpChannelsRevision(s, 'gep', 1000), true);
  assert.equal(s.channelsRev, 1);
  assert.equal(bumpChannelsRevision(s, 'gep', 2000), false, 'változatlan állapot nem léptet');
  s.channelFilters![0].allow = ['@jo', '@uj'];
  assert.equal(bumpChannelsRevision(s, 'gep', 3000), true);
  assert.equal(s.channelsRev, 2);
  // Átvétel a másik eszköztől: a lenyomat frissül, a számláló nem.
  s.channelFilters = [{ id: 'chf_x', host: 'tiktok.com', allow: ['@m'], enabled: false }];
  adoptChannelsRevision(s);
  assert.equal(bumpChannelsRevision(s, 'gep', 4000), false,
    'az átvett tartalom nem a mi szerkesztésünk — nem léptethet');
});

test('az engedélylista átrendeződése nem léptet', () => {
  const s = stateWith([{ id: 'chf_1', host: 'youtube.com', allow: ['@a', '@b'], enabled: true }]);
  bumpChannelsRevision(s, 'gep', 1000);
  s.channelFilters![0].allow = ['@b', '@a'];
  assert.equal(bumpChannelsRevision(s, 'gep', 2000), false);
});
