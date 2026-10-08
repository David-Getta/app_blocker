import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  MAX_CHANNEL_FILTERS, type ChannelFilter,
} from '../src/shared/channels';
import {
  emptyChannels, markChannelChanges, mergeChannels, normalizeSyncChannels, sameChannels, type SyncChannels,
} from '../src/shared/sync/channels-merge';
import { bumpChannelsRevision, adoptChannelsRevision } from '../src/helper/revisions';
import { defaultState, type HelperState } from '../src/helper/state';

/**
 * A csatorna-szűrők összefésülése GAZDAGÉPENKÉNT: a több kifizetett lazítás
 * nyer, egyenlőnél a szigorúbb. A döntésnek DETERMINISZTIKUSNAK is kell
 * lennie — különben két eszköz örökké oda-vissza írná egymást, és a szinkron
 * sosem konvergálna.
 */

function chans(over: Partial<SyncChannels> = {}): SyncChannels {
  return {
    filters: [{ id: 'chf_1', host: 'youtube.com', allow: ['@jo'], enabled: true }],
    rev: 1, updatedAt: 1000, updatedBy: 'gep',
    ...over,
  };
}

const yt = (allow: string[], enabled = true, id = 'chf_1') => ({ id, host: 'youtube.com', allow, enabled });

test('a kifizetett lazítás átmegy — a kikapcsolás számlálója a nagyobb', () => {
  const local = chans({ rev: 2, filters: [yt(['@jo'], false)], marks: { 'youtube.com': 2 }, loosens: { 'youtube.com': 1 } });
  const remote = chans({ rev: 1 });
  for (const m of [mergeChannels(local, remote), mergeChannels(remote, local)]) {
    assert.equal(m.filters[0].enabled, false, 'a kikapcsolás próbatétellel történt — átér');
    assert.equal(m.loosens?.['youtube.com'], 1);
  }
});

test('ingyenes szerkesztéssel felhúzott rev nem lazít: a kikapcsolás jel nélkül nem ér át', () => {
  // A régi szabály szerint a nagyobb rev egészében nyert. Most a kikapcsolás
  // csak a kifizetett lazítás számlálójával megy át — egy rev önmagában semmit.
  const local = chans({ rev: 9, filters: [yt(['@jo'], false)] });
  const remote = chans({ rev: 1 });
  assert.equal(mergeChannels(local, remote).filters[0].enabled, true, 'bekapcsolva, ha bárhol be van');
});

test('A TRÜKK: friss telepítés sok ingyenes szerkesztéssel sem törli a fiók szűrőit', () => {
  const account = chans({
    rev: 10,
    filters: [yt(['@jo']), { id: 'chf_2', host: 'tiktok.com', allow: ['@t'], enabled: true }],
    marks: { 'youtube.com': 3, 'tiktok.com': 7 },
  });
  // Az új gépen tizenöt ingyenes szerkesztés: egy saját szűrő, újra meg újra szűkítve.
  const fresh = chans({
    rev: 15, updatedBy: 'uj-gep',
    filters: [{ id: 'chf_9', host: 'twitch.tv', allow: ['@a'], enabled: true }],
    marks: { 'twitch.tv': 15 },
  });
  for (const m of [mergeChannels(account, fresh), mergeChannels(fresh, account)]) {
    assert.deepEqual(m.filters.map((f) => f.host), ['youtube.com', 'tiktok.com', 'twitch.tv'],
      'a fiók szűrői megmaradnak, az új mellé kerül');
  }
});

test('elavult gép: a máshol levett csatornát nem hozza vissza — egyenlő számlálónál a metszet', () => {
  const account = chans({ rev: 8, filters: [yt(['@a'])], marks: { 'youtube.com': 8 } });
  const stale = chans({ rev: 12, filters: [yt(['@a', '@b', '@c'])], marks: { 'youtube.com': 2 } });
  for (const m of [mergeChannels(account, stale), mergeChannels(stale, account)]) {
    assert.deepEqual(m.filters[0].allow, ['@a']);
  }
});

test('a kifizetett törlés (bekapcsolt szűrőn) átmegy; az ingyenes nem viszi el a bekapcsoltat', () => {
  const paid = chans({ rev: 5, filters: [], marks: { 'youtube.com': 5 }, loosens: { 'youtube.com': 1 } });
  const other = chans({ rev: 3, marks: { 'youtube.com': 1 } });
  assert.deepEqual(mergeChannels(other, paid).filters, [], 'a levétel nyoma a nagyobb számlálóval nyer');
  assert.deepEqual(mergeChannels(paid, other).filters, []);
  // Ingyenes levétel: a levevő példánya kikapcsolt volt — a másik gépen bekapcsolt.
  const free = chans({ rev: 5, filters: [], marks: { 'youtube.com': 5 } });
  assert.equal(mergeChannels(other, free).filters.length, 1, 'a bekapcsolt szűrő marad');
  assert.equal(mergeChannels(free, other).filters.length, 1);
  // Kikapcsolt szűrőnél a frissebb jel dönt — nem tilt semmit egyik sem.
  const off = chans({ rev: 3, filters: [yt(['@jo'], false)], marks: { 'youtube.com': 1 } });
  assert.deepEqual(mergeChannels(off, free).filters, [], 'a frissebb levétel nyer');
  const reAdded = chans({ rev: 9, filters: [yt(['@jo'], false)], marks: { 'youtube.com': 9 } });
  assert.equal(mergeChannels(free, reAdded).filters.length, 1, 'az újra felvett, frissebb szűrő marad');
});

test('egyenlő számlálónál: bekapcsolva, ha bárhol be van; a bekapcsolt listáját a kikapcsolt nem bővítheti', () => {
  // A kikapcsolt szűrőn a lista ingyen bővíthető — de egy bekapcsolt szűrőn ez nem nyithat meg semmit.
  const on = chans({ filters: [yt(['@a', '@b'])], marks: { 'youtube.com': 2 } });
  const offWider = chans({ filters: [yt(['@a', '@b', '@x'], false)], marks: { 'youtube.com': 6 } });
  assert.deepEqual(mergeChannels(on, offWider).filters[0], yt(['@a', '@b']));
  const offDisjoint = chans({ filters: [yt(['@x'], false)], marks: { 'youtube.com': 6 } });
  assert.deepEqual(mergeChannels(offDisjoint, on).filters[0], yt(['@a', '@b']), 'üres metszetnél a bekapcsolté');
  // Két bekapcsolt, diszjunkt lista: a rövidebb (kimondott határ — üres lista nem lehet).
  const onA = chans({ filters: [yt(['@a', '@b'])] });
  const onX = chans({ filters: [yt(['@x'], true, 'chf_0')] });
  for (const m of [mergeChannels(onA, onX), mergeChannels(onX, onA)]) {
    assert.deepEqual(m.filters[0], yt(['@x'], true, 'chf_0'));
  }
});

test('a döntetlen-eltörés determinisztikus: mindkét irányból ugyanaz az eredmény', () => {
  const a = chans({ rev: 2, updatedAt: 5000, updatedBy: 'aaa', filters: [{ id: 'chf_a', host: 'a.com', allow: ['@x'], enabled: true }] });
  const b = chans({ rev: 2, updatedAt: 5000, updatedBy: 'bbb', filters: [{ id: 'chf_b', host: 'b.com', allow: ['@y'], enabled: true }] });
  const ab = mergeChannels(a, b);
  const ba = mergeChannels(b, a);
  assert.deepEqual(ab, ba, 'a hívási sorrend nem dönthet');
  assert.deepEqual(ab.filters.map((f) => f.id), ['chf_a', 'chf_b'], 'két különböző oldal: mindkettő marad');
});

test('a régi kliens miatt: ha a fésült eltér a nagyobb rev-ű bejövőtől, eggyel nagyobb rev-et kap', () => {
  // A régi kliens a nagyobb rev-ű blobot veszi át egészében; egyenlő rev mellett
  // a sajátját tartaná meg, és a kettő körönként egymást írná felül.
  const old = chans({ rev: 7, filters: [yt(['@jo']), { id: 'chf_2', host: 'tiktok.com', allow: ['@t'], enabled: true }] });
  const mine = chans({ rev: 4, filters: [yt(['@jo'])], marks: { 'tiktok.com': 4 }, loosens: { 'tiktok.com': 1 } });
  const m = mergeChannels(mine, old);
  assert.deepEqual(m.filters.map((f) => f.host), ['youtube.com'], 'a kifizetett levétel nyer');
  assert.equal(m.rev, 8, 'a régi kliens ezt veszi át');
  // Ha a fésült tartalma a bejövőé, nincs mit feltölteni — nincs új rev.
  const same = mergeChannels(chans({ rev: 3 }), chans({ rev: 7 }));
  assert.equal(same.rev, 7);
});

test('azonos oldal: a kisebb azonosító marad; egy azonosító két oldalon: a későbbi #2-t kap', () => {
  const a = chans({ filters: [yt(['@jo'], true, 'chf_b')] });
  const b = chans({ filters: [yt(['@jo'], true, 'chf_a')] });
  assert.equal(mergeChannels(a, b).filters[0].id, 'chf_a');
  const c = chans({ filters: [{ id: 'chf_1', host: 'tiktok.com', allow: ['@t'], enabled: true }], marks: { 'tiktok.com': 5 } });
  const m = mergeChannels(chans({ marks: { 'youtube.com': 2 } }), c);
  assert.deepEqual(m.filters.map((f) => [f.host, f.id]), [['youtube.com', 'chf_1'], ['tiktok.com', 'chf_1#2']]);
});

test('a plafon: előbb a kikapcsoltak esnek ki, aztán a legfrissebbek — a jelük marad', () => {
  const many = (from: number, n: number, enabled: boolean, mark: number) => Array.from({ length: n }, (_, i) => ({
    id: `chf_${from + i}`, host: `o${from + i}.com`, allow: ['@a'], enabled,
  })).map((f) => ({ f, mark }));
  const a = many(0, 12, true, 3).concat(many(100, 4, false, 1));
  const b = many(200, 8, true, 9);
  const blob = (xs: { f: ChannelFilter; mark: number }[]) => chans({
    filters: xs.map((x) => x.f), marks: Object.fromEntries(xs.map((x) => [x.f.host, x.mark])),
  });
  const m = mergeChannels(blob(a), blob(b));
  assert.equal(m.filters.length, MAX_CHANNEL_FILTERS);
  assert.ok(m.filters.every((f) => f.enabled), 'a kikapcsoltak estek ki elsőnek');
  assert.equal(m.marks?.['o100.com'], 1, 'a kiesett jele marad');
});

test('a jelek és a számlálók a dróton tisztán jönnek', () => {
  const n = normalizeSyncChannels({
    filters: [yt(['@jo'])], rev: 5, updatedAt: 1, updatedBy: 'gep',
    marks: { 'youtube.com': 3, 'tiktok.com': 4, 'WWW.x.com': 1, 'nagy.com': 9, 'tort.com': 1.5, 'nulla.com': 0 },
    loosens: { 'youtube.com': 1, 'tiktok.com': 2, 'idegen.com': 1, 'sok.com': 99 },
  }, 'gep');
  assert.deepEqual(n.marks, { 'youtube.com': 3, 'tiktok.com': 4 });
  assert.deepEqual(n.loosens, { 'youtube.com': 1, 'tiktok.com': 2 }, 'számláló csak szűrős vagy jeles oldalé');
  const dup = normalizeSyncChannels({
    filters: [yt(['@jo']), { id: 'chf_2', host: 'www.youtube.com', allow: ['@x'], enabled: true }], rev: 1,
  }, 'gep');
  assert.equal(dup.filters.length, 1, 'oldalanként egy szűrő');
});

test('a léptetés csak jelet ír — a kifizetett lazítás számlálója a bíróé', () => {
  const prev = [yt(['@a', '@b']), { id: 'chf_2', host: 'tiktok.com', allow: ['@t'], enabled: false }];
  const free = markChannelChanges(undefined, undefined, prev,
    [yt(['@a']), { id: 'chf_2', host: 'tiktok.com', allow: ['@t', '@u'], enabled: true }], 4);
  assert.deepEqual(free, { marks: { 'youtube.com': 4, 'tiktok.com': 4 } }, 'szűkítés és kikapcsoltan bővítés: jel');
  // Egy lazító változás (új csatorna bekapcsoltan) is csak jelet kap itt: ha
  // nem a bíró írta a számlálót, a változás nem kifizetett — egy kapun kívüli
  // lazítás (hiba, kézzel átírt állapot) így nem megy át a többi gépre.
  const loosened = markChannelChanges({ 'youtube.com': 2 }, { 'youtube.com': 1 }, prev, [yt(['@a', '@b', '@c'])], 5);
  assert.deepEqual(loosened, { marks: { 'youtube.com': 5, 'tiktok.com': 5 }, loosens: { 'youtube.com': 1 } },
    'a meglévő számláló marad, nem nő');
  const renamed = markChannelChanges(undefined, undefined, prev, [yt(['@b', '@a'], true, 'chf_x'), prev[1]], 6);
  assert.deepEqual(renamed, {}, 'az azonosító és a sorrend nem változás');
  const hostChange = markChannelChanges(undefined, undefined, [yt(['@a'])],
    [{ id: 'chf_1', host: 'twitch.tv', allow: ['@a'], enabled: true }], 7);
  assert.deepEqual(hostChange, { marks: { 'youtube.com': 7, 'twitch.tv': 7 } }, 'gazdagép-csere: két jel');
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

test('a léptetés jelöl: az első kör után már oldalanként, az átvett tartalmat nem', () => {
  const s = stateWith([{ id: 'chf_1', host: 'youtube.com', allow: ['@jo'], enabled: true }]);
  // Frissítés utáni első léptetés: még nincs pillanatkép — jel nélkül megy.
  assert.equal(bumpChannelsRevision(s, 'gep', 1000), true);
  assert.equal(s.channelMarks, undefined);
  s.channelFilters = [...s.channelFilters!, { id: 'chf_2', host: 'tiktok.com', allow: ['@t'], enabled: true }];
  bumpChannelsRevision(s, 'gep', 2000);
  assert.deepEqual(s.channelMarks, { 'tiktok.com': 2 }, 'az új oldal a saját jelét kapja');
  assert.equal(s.channelLoosens, undefined, 'a felvétel ingyen van');
  // Átvétel: a pillanatkép frissül, a következő léptetés nem könyveli a miénknek.
  s.channelFilters = [{ id: 'chf_9', host: 'twitch.tv', allow: ['@a'], enabled: true }];
  adoptChannelsRevision(s);
  s.channelFilters = [...s.channelFilters, { id: 'chf_3', host: 'kick.com', allow: ['@k'], enabled: false }];
  bumpChannelsRevision(s, 'gep', 3000);
  assert.deepEqual(s.channelMarks, { 'tiktok.com': 2, 'kick.com': 3 }, 'csak a saját felvétel kap jelet');
});
