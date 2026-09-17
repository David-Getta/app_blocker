// Zárlat: amíg tart, a lazítás nem drága — NINCS.
//
// Ennek a fájlnak két dolga van. Az egyik a mag számtana (a zárlat sosem
// rövidül, a fésülés a későbbi véget hozza). A másik a fontosabb: hogy a
// bíró MINDEN lazító belépési pontja tényleg a kapun megy be. Az utolsó
// teszt ezért magát a forrást olvassa el — ha valaki felvesz egy tizenegyedik
// utat, és kikerüli a kaput, itt hasal el, nem a felhasználónál.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  formatLockdownRemaining, isLocked, lockdownRemainingMs, mergeLockdown, parseLockdown,
  startLockdown, LOCKDOWN_CHOICES_MIN, MAX_LOCKDOWN_MS,
} from '../src/shared/lockdown';
import * as referee from '../src/helper/referee';
import { defaultState, newId, type HelperState } from '../src/helper/state';

const T0 = Date.UTC(2025, 0, 6, 10, 0, 0);
const HOUR = 3600_000;

// --------------------------------------------------------------------- mag

test('a zárlat SOSEM rövidül: a rövidebb kérés nem ér el semmit', () => {
  const long = startLockdown(null, 8 * HOUR, T0);
  assert.ok(long);
  const shorter = startLockdown(long, HOUR, T0 + 60_000);
  assert.equal(shorter!.until, long!.until, 'a rövidebb kérés nem vihette le');
  assert.equal(shorter!.startedAt, long!.startedAt, 'a kezdés is marad');
});

test('hosszabbítani viszont lehet, és a kezdés marad a réginek', () => {
  const first = startLockdown(null, HOUR, T0)!;
  const longer = startLockdown(first, 24 * HOUR, T0 + 30 * 60_000)!;
  assert.equal(longer.until, T0 + 30 * 60_000 + 24 * HOUR);
  assert.equal(longer.startedAt, T0, 'a hosszabbítás nem nulláz vissza');
});

test('a lejárt zárlat után az új zárlat tiszta lappal indul', () => {
  const old = startLockdown(null, HOUR, T0)!;
  const after = T0 + 3 * HOUR;
  assert.equal(isLocked(old, after), false);
  const fresh = startLockdown(old, HOUR, after)!;
  assert.equal(fresh.startedAt, after);
  assert.equal(fresh.until, after + HOUR);
});

test('a hossz felső határa harminc nap', () => {
  const l = startLockdown(null, 400 * 24 * HOUR, T0)!;
  assert.equal(l.until, T0 + MAX_LOCKDOWN_MS);
});

test('az értelmetlen hossz nem indít zárlatot', () => {
  for (const bad of [0, -5, NaN, Infinity]) {
    assert.equal(startLockdown(null, bad, T0), null, `${bad} nem indíthat zárlatot`);
  }
  const live = startLockdown(null, HOUR, T0)!;
  assert.equal(startLockdown(live, -1, T0), live, 'a futót sem bántja');
});

test('fésüléskor a KÉSŐBBI vég nyer, akkor is, ha a másik eszköz régebbi', () => {
  const a = { startedAt: T0, until: T0 + HOUR };
  const b = { startedAt: T0 - HOUR, until: T0 + 5 * HOUR };
  assert.equal(mergeLockdown(a, b)!.until, b.until);
  assert.equal(mergeLockdown(b, a)!.until, b.until);
  assert.equal(mergeLockdown(null, a)!.until, a.until);
  assert.equal(mergeLockdown(a, null)!.until, a.until);
  assert.equal(mergeLockdown(null, null), null);
});

test('azonos végnél a korábbi kezdés marad — az mutatja a teljes hosszt', () => {
  const a = { startedAt: T0, until: T0 + HOUR };
  const b = { startedAt: T0 - HOUR, until: T0 + HOUR };
  assert.equal(mergeLockdown(a, b)!.startedAt, T0 - HOUR);
});

test('a dróton érkezett szemét nem indít zárlatot', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { until: 0 }, { until: -1 }, { until: 'x' }]) {
    assert.equal(parseLockdown(bad), null, `${JSON.stringify(bad)} nem zárlat`);
  }
  const ok = parseLockdown({ until: T0 + HOUR, startedAt: T0 })!;
  assert.equal(ok.until, T0 + HOUR);
  // Kezdés nélkül a vég a kezdés is: inkább rövidnek látszik, mint hosszabbnak.
  assert.equal(parseLockdown({ until: T0 + HOUR })!.startedAt, T0 + HOUR);
  // A végénél KÉSŐBBI kezdés hazugság; a vég vágja vissza.
  assert.equal(parseLockdown({ until: T0, startedAt: T0 + HOUR })!.startedAt, T0);
});

test('a hátralévő idő olvasható magyarul, és nem ír nulla percet', () => {
  assert.equal(formatLockdownRemaining(6 * 24 * HOUR + 3 * HOUR), '6 nap 3 óra');
  assert.equal(formatLockdownRemaining(2 * 24 * HOUR), '2 nap');
  assert.equal(formatLockdownRemaining(2 * HOUR + 15 * 60_000), '2 ó 15 p');
  assert.equal(formatLockdownRemaining(4 * 60_000), '4 perc');
  assert.equal(formatLockdownRemaining(3000), '1 perc', 'a maradék sosem nulla perc');
  assert.equal(lockdownRemainingMs(null, T0), 0);
});

// ------------------------------------------------------- a bíró kapuja

function lockedState(): { state: HelperState; siteId: string; packId: string } {
  const state = defaultState();
  const siteId = newId('site');
  state.sites.push({
    id: siteId, domain: 'youtube.com',
    hostnames: ['youtube.com', 'www.youtube.com', 'music.youtube.com'],
    addedAt: T0 - HOUR, pauseUntil: null, pendingDeleteAt: null,
    schedule: { mode: 'scheduled_block', bands: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }] },
    dailyLimitSeconds: 600,
    burstSeconds: 120, cooldownSeconds: 600,
    rules: [{ host: 'youtube.com', path: '/shorts' }],
  });
  const packId = newId('pack');
  state.focusPacks = [{
    id: packId, name: 'Nyelvtanulás', allowSites: ['duolingo.com'], allowApps: [],
    defaultMinutes: 50, recurrence: { days: [1], startMin: 540, endMin: 720 },
  }, {
    // Külön csomag a heti ablakhoz: a FUTÓ csomag amúgy sem szerkeszthető, és
    // akkor nem a zárlat állítaná meg a kísérletet, hanem az.
    id: newId('pack'), name: 'Írás', allowSites: ['docs.example.com'], allowApps: [],
    defaultMinutes: 25, recurrence: { days: [2], startMin: 600, endMin: 780 },
  }];
  state.channelFilters = [{
    id: newId('chf'), host: 'youtube.com', allow: ['@valaki'], enabled: true,
  }];
  return { state, siteId, packId };
}

/**
 * MINDEN lazító belépési pont, egy táblában.
 *
 * Az első elem a BÍRÓ FÜGGVÉNYÉNEK NEVE. Nem dísz: a fájl utolsó tesztje ebből
 * állítja össze, mit fed le a tábla, és veti össze azzal, amit a forrás
 * tényleg tartalmaz — így a tábla nem maradhat le a kódtól.
 */
function looseningEntries(state: HelperState, siteId: string, packId: string, now: number) {
  const filterId = state.channelFilters![0].id;
  return [
    ['startSession', 'feloldás', () => referee.startSession(state, 'pause', siteId, 15, now)],
    ['startSession', 'végleges törlés', () => referee.startSession(state, 'delete', siteId, undefined, now)],
    ['startScheduleChange', 'menetrend lazítása', () => referee.startScheduleChange(
      // a napi huszonnégy óra helyett hétfő 9-10: sokkal kevesebb tiltott idő
      state, siteId, { mode: 'scheduled_block', bands: [{ days: [1], startMin: 540, endMin: 600 }] }, now)],
    ['startLimitChange', 'keret emelése', () => referee.startLimitChange(state, siteId, 7200, now)],
    ['startBurstChange', 'adag lazítása', () => referee.startBurstChange(state, siteId, 3600, 60, now)],
    ['startChannelFilterSave', 'csatorna-szűrő kikapcsolása', () => referee.startChannelFilterSave(
      state, { id: filterId, host: 'youtube.com', allow: ['@valaki'], enabled: false }, now)],
    ['startChannelFilterDelete', 'csatorna-szűrő törlése',
      () => referee.startChannelFilterDelete(state, filterId, now)],
    ['startRuleChange', 'részleges szabály levétele', () => referee.startRuleChange(
      state, siteId, { host: 'youtube.com', path: '/shorts' }, true, now)],
    ['startHostnameChange', 'hosztnév levétele',
      () => referee.startHostnameChange(state, siteId, 'music.youtube.com', true, now)],
    ['changeFocus', 'munkamenet leállítása', () => referee.changeFocus(state, null, now)],
    ['setFocusRecurrence', 'heti ablak levétele',
      () => referee.setFocusRecurrence(state, state.focusPacks![1].id, null, now)],
  ] as const;
}

test('zárlat alatt EGYETLEN lazító út sem indít próbatételt', () => {
  const probe = lockedState();
  const count = looseningEntries(probe.state, probe.siteId, probe.packId, T0).length;
  for (let i = 0; i < count; i++) {
    // Minden úthoz friss állapot: a félbehagyott kísérletek könyvelése
    // egyébként átszivárogna a következő sorra.
    const { state, siteId, packId } = lockedState();
    referee.startFocus(state, packId, 50, T0);
    referee.startLockdownNow(state, 24 * HOUR, T0);
    const [, label, run] = looseningEntries(state, siteId, packId, T0 + 1000)[i];
    assert.throws(run, (e: unknown) => {
      const err = e as referee.RefereeError;
      assert.equal(err.code, 'LOCKDOWN', `${label}: nem a zárlat állította meg`);
      assert.match(err.message, /Zárlat/, `${label}: a hibaüzenet nem mondja ki`);
      return true;
    }, `${label}: zárlat alatt is elindult`);
    assert.equal(state.session, null, `${label}: próbatétel keletkezett zárlat alatt`);
  }
});

test('zárlat alatt a SZIGORÍTÁS ugyanúgy ingyen van', () => {
  const { state, siteId, packId } = lockedState();
  referee.startLockdownNow(state, 24 * HOUR, T0);
  const now = T0 + 1000;
  // keret csökkentése
  assert.equal(referee.startLimitChange(state, siteId, 60, now).applied, true);
  // adag szigorítása: kisebb adag, hosszabb szünet
  assert.equal(referee.startBurstChange(state, siteId, 60, 1800, now).applied, true);
  // hosztnév FELVÉTELE
  assert.equal(referee.startHostnameChange(state, siteId, 'shorts.youtube.com', false, now).applied, true);
  // részleges szabály felvétele
  assert.equal(referee.startRuleChange(
    state, siteId, { host: 'youtube.com', path: '/feed' }, false, now).applied, true);
  // munkamenet INDÍTÁSA (fehérlista: maga is szigorítás)
  assert.equal(referee.startFocus(state, packId, 50, now).run.packId, packId);
  // …és a hosszabbítása
  const run = state.focusRun!;
  assert.equal(referee.changeFocus(state, run.endsAt + 10 * 60_000, now).applied, true);
  assert.equal(state.session, null, 'egyik szigorítás sem indított próbatételt');
});

test('a zárlat indítása visszavesz mindent, ami félig kint volt', () => {
  const { state, siteId, packId } = lockedState();
  // egy feloldott oldal, egy folyamatban lévő törlés és egy futó kísérlet
  referee.startSession(state, 'pause', siteId, 15, T0);
  assert.ok(state.session, 'a kísérlet elindult a zárlat előtt');
  state.sites[0].pauseUntil = T0 + 30 * 60_000;
  state.sites[0].pendingDeleteAt = T0 + 20 * HOUR;

  referee.startLockdownNow(state, 24 * HOUR, T0 + 1000);

  assert.equal(state.session, null, 'a futó kísérlet elszállt');
  assert.equal(state.sites[0].pauseUntil, null, 'a feloldott oldal visszazárt');
  assert.equal(state.sites[0].pendingDeleteAt, null, 'a törlés visszavonódott');
  assert.ok(state.sites.some((s) => s.id === siteId), 'az oldal megvan');
  assert.equal(isLocked(state.lockdown, T0 + HOUR), true);
  assert.ok(packId);
});

test('máshol indított zárlat a körben is érvényesül (szinkronról érkezve)', () => {
  const { state, siteId } = lockedState();
  referee.startSession(state, 'pause', siteId, 15, T0);
  state.sites[0].pauseUntil = T0 + 30 * 60_000;
  state.sites[0].pendingDeleteAt = T0 + 20 * HOUR;
  // A szinkron beteszi a másik eszköz zárlatát — a bíró kapuja ezt nem látta.
  state.lockdown = { startedAt: T0, until: T0 + 6 * HOUR };

  referee.tick(state, T0 + 2000);

  assert.equal(state.session, null, 'a futó kísérlet itt is elszállt');
  assert.equal(state.sites[0].pauseUntil, null, 'a feloldás itt is véget ért');
  assert.equal(state.sites[0].pendingDeleteAt, null, 'a törlés itt is visszavonódott');
});

test('az óra előreállítása nem fejezi be a zárlatot', () => {
  const { state } = lockedState();
  referee.tick(state, T0);
  referee.startLockdownNow(state, 7 * 24 * HOUR, T0);
  const left = lockdownRemainingMs(state.lockdown, T0);

  // három nappal előre ugrik az óra (vagy ennyit aludt a gép)
  const jumped = T0 + 3 * 24 * HOUR;
  referee.tick(state, jumped);

  assert.equal(isLocked(state.lockdown, jumped), true, 'az ugrás nem oldhatta fel');
  const leftAfter = lockdownRemainingMs(state.lockdown, jumped);
  // Az ugrásból a szokásos kör-ütem (pár perc) nem számít ugrásnak — ennyi
  // tényleg eltelhetett. A három napból viszont egy perc sem megy le.
  assert.ok(left - leftAfter < 5 * 60_000 && leftAfter <= left,
    `amennyi hátra volt, annyi van hátra (${left} -> ${leftAfter})`);
});

test('a gyorsgombok mind érvényes hosszak, és egyik sem lépi túl a határt', () => {
  assert.ok(LOCKDOWN_CHOICES_MIN.length >= 4);
  for (const min of LOCKDOWN_CHOICES_MIN) {
    assert.ok(Number.isInteger(min) && min > 0, `${min} nem érvényes perc`);
    assert.ok(min * 60_000 <= MAX_LOCKDOWN_MS, `${min} perc túllépi a határt`);
  }
});

test('a bíró minden próbatétel-terve a zárlat kapuján megy ki', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  // A tesztek a fordított fájlból futnak, a forrás a projekt gyökeréből
  // nézve van meg — a futtató munkakönyvtára a `desktop/`.
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'helper', 'referee.ts'), 'utf8');
  // Egyetlen hely hívhatja a tervezőt közvetlenül: maga a kapu.
  assert.equal((src.match(/generatePlan\(/g) ?? []).length, 1,
    'a generatePlan-t CSAK a planLoosening hívhatja — különben a zárlat megkerülhető');

  // Melyik exportált függvény indít próbatételt a forrás szerint…
  const inSource = new Set<string>();
  const blocks = src.split(/\nexport function /).slice(1);
  for (const b of blocks) {
    const name = b.slice(0, b.indexOf('('));
    if (b.split('\nexport ')[0].includes('planLoosening(state,')) inSource.add(name);
  }
  // …és melyiket futtatja a fenti tábla.
  const { state, siteId, packId } = lockedState();
  const covered = new Set<string>(looseningEntries(state, siteId, packId, T0).map(([fn]) => fn));

  const missing = [...inSource].filter((n) => !covered.has(n));
  assert.deepEqual(missing, [],
    `a tábla nem fedi le ezeket a lazító belépési pontokat: ${missing.join(', ')}`);
  const stale = [...covered].filter((n) => !inSource.has(n));
  assert.deepEqual(stale, [], `a tábla olyan függvényt sorol, ami már nem indít próbatételt: ${stale.join(', ')}`);
});
