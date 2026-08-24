// A napi keret eszközök között KÖZÖS.
//
// Enélkül a „napi 20 perc YouTube” két eszközön negyven percet jelentett, és a
// keret nem keret volt, hanem javaslat. Ezek a tesztek arra a két kimenetelre
// mennek, amitől a funkció rosszabb lenne, mint a hiánya:
//
//   1. a saját időnk kétszer számít (a keret feleakkora lesz, mint beállított),
//   2. egy másik eszköz régi vagy szemét adata megeszi a mai keretet.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  isBlockedNowWithLimit, isLimitExhausted, makeTodayDigest, normalizeTodayDigest,
  sharedTodaySeconds, usedTodayEverywhere, type SharedToday,
} from '../src/shared/limits';
import { dayKey, emptyUsage, siteKey, type UsageState } from '../src/shared/usage';

const NOW = new Date(2026, 4, 20, 15, 0).getTime();
const YESTERDAY = NOW - 24 * 3600_000;

function usageWith(domain: string, seconds: number, at = NOW): UsageState {
  const u = emptyUsage();
  u.days.push({ day: dayKey(at), seconds: { [siteKey(domain)]: seconds } });
  return u;
}

const site = (extra: Record<string, unknown> = {}) => ({
  domain: 'youtube.com', pauseUntil: null, pendingDeleteAt: null, ...extra,
} as Parameters<typeof isBlockedNowWithLimit>[0]);

const shared = (devices: { deviceId: string; day?: string; seconds: Record<string, number> }[]):
SharedToday => ({
  selfDeviceId: 'ez-a-gep',
  devices: devices.map((d) => ({ day: dayKey(NOW), ...d })),
});

test('the budget is one budget, not one per device', () => {
  // Ez a funkció lényege. Tizenkét perc itt, tíz perc a telefonon: a húsz
  // perces keret elfogyott, pedig egyik eszközön sem érte el egyedül.
  const s = site({ dailyLimitSeconds: 1200 });
  const here = usageWith('youtube.com', 720);
  const phone = shared([{ deviceId: 'telefon', seconds: { [siteKey('youtube.com')]: 600 } }]);

  assert.equal(isLimitExhausted(s, here, NOW), false, 'egyedül a gépen még nem');
  assert.equal(isLimitExhausted(s, here, NOW, phone), true, 'együtt viszont igen');
  assert.equal(isBlockedNowWithLimit(s, here, NOW, phone), true, 'és emiatt blokkol is');
  assert.equal(usedTodayEverywhere(here, phone, 'youtube.com', NOW), 1320);
});

test('our own row never counts twice', () => {
  // A kiszolgáló a MI összegzésünket is visszaadja. Ha az bekerülne, minden
  // percünk kétszer számítana: a húsz perces keret tíz perc után fogyna el, és
  // a felhasználó jogosan gondolná, hogy az app hibás.
  const here = usageWith('youtube.com', 600);
  const withSelf: SharedToday = {
    selfDeviceId: 'ez-a-gep',
    devices: [{ deviceId: 'ez-a-gep', day: dayKey(NOW), seconds: { [siteKey('youtube.com')]: 600 } }],
  };
  assert.equal(sharedTodaySeconds(withSelf, 'youtube.com', NOW), 0);
  assert.equal(usedTodayEverywhere(here, withSelf, 'youtube.com', NOW), 600, 'nem 1200');
});

test('another device\'s yesterday is not our today', () => {
  // A másik eszköz a SAJÁT naptári napját írja. Ha nem néznénk, egy másik
  // időzónában lévő telefon tegnapi órái ma azonnal elégetnék a keretet.
  const s = site({ dailyLimitSeconds: 600 });
  const stale = shared([
    { deviceId: 'telefon', day: dayKey(YESTERDAY), seconds: { [siteKey('youtube.com')]: 99999 } },
  ]);
  assert.equal(sharedTodaySeconds(stale, 'youtube.com', NOW), 0);
  assert.equal(isLimitExhausted(s, emptyUsage(), NOW, stale), false);
});

test('without sync the app behaves exactly as before', () => {
  // Ha a szinkron áll, nem lehet sem lazább, sem szigorúbb: a helyi mérés dönt.
  const s = site({ dailyLimitSeconds: 1200 });
  const here = usageWith('youtube.com', 1300);
  for (const none of [null, undefined, { selfDeviceId: 'ez-a-gep', devices: [] }]) {
    assert.equal(isLimitExhausted(s, here, NOW, none), true);
    assert.equal(isLimitExhausted(s, usageWith('youtube.com', 10), NOW, none), false);
  }
});

test('a remote digest can only tighten, never loosen', () => {
  // A távoli szám csak HOZZÁAD. Ezért nem baj, hogy nem tudjuk ellenőrizni,
  // honnan jött: a legrosszabb, amit tehet, hogy hamarabb blokkol.
  const s = site({ dailyLimitSeconds: 1200 });
  const here = usageWith('youtube.com', 1300);          // helyben már elfogyott
  const zero = shared([{ deviceId: 'telefon', seconds: {} }]);
  assert.equal(isLimitExhausted(s, here, NOW, zero), true, 'üres távoli sor nem old fel');

  // És a kiérdemelt feloldás továbbra is erősebb mindennél.
  const paused = site({ dailyLimitSeconds: 1200, pauseUntil: NOW + 60_000 });
  const phone = shared([{ deviceId: 'telefon', seconds: { [siteKey('youtube.com')]: 9999 } }]);
  assert.equal(isBlockedNowWithLimit(paused, here, NOW, phone), false);
});

test('only this site\'s seconds are taken from the other device', () => {
  const other = shared([{ deviceId: 'telefon', seconds: { [siteKey('reddit.com')]: 5000 } }]);
  assert.equal(sharedTodaySeconds(other, 'youtube.com', NOW), 0);
  assert.equal(sharedTodaySeconds(other, 'reddit.com', NOW), 5000);
});

test('the digest we upload is today only, and small', () => {
  const u = emptyUsage();
  u.days.push({ day: dayKey(YESTERDAY), seconds: { [siteKey('youtube.com')]: 5000 } });
  u.days.push({ day: dayKey(NOW), seconds: { [siteKey('youtube.com')]: 120.6 } });
  const d = makeTodayDigest(u, 'ez-a-gep', NOW);
  assert.equal(d.day, dayKey(NOW));
  assert.equal(d.deviceId, 'ez-a-gep');
  assert.deepEqual(d.seconds, { [siteKey('youtube.com')]: 121 }, 'a tegnapi nem megy fel');

  // Sok célnál a legnagyobbak maradnak: a keret szempontjából a hosszú tételek
  // számítanak, és az összegzésnek kicsinek kell maradnia.
  const many = emptyUsage();
  const seconds: Record<string, number> = {};
  for (let i = 0; i < 500; i++) seconds[`site:x${i}.hu`] = i + 1;
  many.days.push({ day: dayKey(NOW), seconds });
  const big = makeTodayDigest(many, 'ez-a-gep', NOW);
  assert.equal(Object.keys(big.seconds).length, 200);
  assert.equal(big.seconds['site:x499.hu'], 500, 'a legnagyobb tétel biztosan bent van');
  assert.equal(big.seconds['site:x0.hu'], undefined);
});

test('a nonsense digest cannot eat the budget', () => {
  // Ez kívülről jött adat. Ha egy sor „egy hónapnyi” másodpercet állítana, a
  // keret azonnal elfogyna minden oldalon — a felhasználó pedig csak annyit
  // látna, hogy az app indok nélkül tilt.
  const d = normalizeTodayDigest({
    day: dayKey(NOW),
    seconds: {
      [siteKey('youtube.com')]: 30 * 24 * 3600,
      [siteKey('reddit.com')]: -5,
      [siteKey('index.hu')]: 'sok',
      '': 10,
    },
  }, 'telefon');
  assert.ok(d);
  assert.equal(d.deviceId, 'telefon');
  assert.equal(d.seconds[siteKey('youtube.com')], 24 * 3600, 'egy nap a felső korlát');
  assert.equal(d.seconds[siteKey('reddit.com')], undefined);
  assert.equal(d.seconds[siteKey('index.hu')], undefined);
  assert.equal(d.seconds[''], undefined);

  for (const bad of [null, undefined, 'szöveg', {}, { day: 'tegnap', seconds: {} }, { day: 5 }]) {
    assert.equal(normalizeTodayDigest(bad, 'telefon'), null, JSON.stringify(bad));
  }
});

test('the device id comes from the server, not from the blob', () => {
  // Enélkül egy eszköz a MÁSIK nevében beszélhetne — például a miénkében, és
  // akkor a saját sorunk kiszűrése nem érne semmit.
  const d = normalizeTodayDigest(
    { deviceId: 'ez-a-gep', day: dayKey(NOW), seconds: { [siteKey('youtube.com')]: 600 } },
    'telefon',
  );
  assert.equal(d?.deviceId, 'telefon');
});
