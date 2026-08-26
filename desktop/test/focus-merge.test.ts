// A munkamenet összefésülése két eszköz között.
//
// Ez a szinkron kockázatos fele: itt dől el, hogy egy MÁSIK eszköz szinkronja
// ki tudja-e kapcsolni azt a munkamenetet, amit a felhasználó épp fut. Ha
// igen, a leállítás próbatétele megkerülhető: elég két eszköz és egy jól
// időzített kör.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyFocus, mergeFocus, normalizeSyncFocus, sameFocus, type SyncFocus,
} from '../src/shared/sync/focus-merge';
import type { FocusPack } from '../src/shared/focus';

const pack = (id: string, sites: string[] = ['quizlet.com']): FocusPack => ({
  id, name: `csomag ${id}`, allowSites: sites, allowApps: ['Word'], defaultMinutes: 50,
});

const focus = (over: Partial<SyncFocus>): SyncFocus => ({
  ...emptyFocus('eszkoz-a'), ...over,
});

test('a futó munkamenetet egy „nem fut” állapot nem kapcsolja ki azonos rev-en', () => {
  // A kibúvó, amit ez a szabály zár: a telefonon marad egy állapot, ami szerint
  // nem fut semmi. Feltölti, és a gépen próbatétel nélkül eltűnik a munkamenet.
  //
  // A „nem fut” oldal itt SZÁNDÉKOSAN az újabb — későbbi idő ÉS később rendezett
  // eszközazonosító. Az „utolsó író nyer” szabály tehát ŐT választaná; a
  // szigorítás-szabálynak felül kell írnia. Ha a teszt fordítva állítaná be,
  // akkor egy elrontott összefésülés mellett is átmenne — és pont azt nem venné
  // észre, ami ellen készült.
  const running = focus({
    packs: [pack('p1')],
    run: { packId: 'p1', startedAt: 0, endsAt: 10_000 },
    rev: 4, updatedAt: 100, updatedBy: 'eszkoz-a',
  });
  const stale = focus({
    packs: [pack('p1')], run: null, rev: 4, updatedAt: 500, updatedBy: 'eszkoz-z',
  });
  assert.deepEqual(mergeFocus(running, stale).run, running.run);
  assert.deepEqual(mergeFocus(stale, running).run, running.run);
});

test('a leállítás NAGYOBB rev-vel átmegy — az a próbatétel jele', () => {
  const running = focus({
    packs: [pack('p1')],
    run: { packId: 'p1', startedAt: 0, endsAt: 10_000 },
    rev: 4, updatedAt: 100, updatedBy: 'eszkoz-a',
  });
  const stopped = focus({
    packs: [pack('p1')], run: null, rev: 5, updatedAt: 110, updatedBy: 'eszkoz-b',
  });
  assert.equal(mergeFocus(running, stopped).run, null);
  assert.equal(mergeFocus(stopped, running).run, null);
});

test('a hosszabbítás azonos rev mellett is nyer, a rövidítés nem', () => {
  // A RÖVIDEBB az újabb (későbbi idő és később rendezett azonosító): az
  // „utolsó író nyer” őt választaná. A hosszabbnak mégis nyernie kell.
  const shorter = focus({
    packs: [pack('p1')], rev: 2, updatedAt: 500,
    run: { packId: 'p1', startedAt: 0, endsAt: 5_000 }, updatedBy: 'eszkoz-z',
  });
  const longer = focus({
    packs: [pack('p1')], rev: 2, updatedAt: 100,
    run: { packId: 'p1', startedAt: 0, endsAt: 9_000 }, updatedBy: 'eszkoz-a',
  });
  assert.equal(mergeFocus(shorter, longer).run?.endsAt, 9_000);
  assert.equal(mergeFocus(longer, shorter).run?.endsAt, 9_000);
});

test('az indítás azonos rev mellett is nyer a nem futóval szemben', () => {
  // Ez a szigorítás iránya: aki elindít egy munkamenetet a telefonon, azt a gép
  // következő szinkronja ne törölje le csak azért, mert nála épp nem futott.
  // A NEM FUTÓ oldal itt az újabb, tehát az „utolsó író nyer” szabály őt
  // választaná — az indításnak mégis nyernie kell.
  const idle = focus({
    packs: [pack('p1')], run: null, rev: 1, updatedAt: 500, updatedBy: 'eszkoz-z',
  });
  const started = focus({
    packs: [pack('p1')],
    run: { packId: 'p1', startedAt: 0, endsAt: 9_000 },
    rev: 1, updatedAt: 100, updatedBy: 'eszkoz-a',
  });
  assert.equal(mergeFocus(idle, started).run?.endsAt, 9_000);
  assert.equal(mergeFocus(started, idle).run?.endsAt, 9_000);
});

test('az összefésülés determinisztikus és idempotens', () => {
  // Enélkül két eszköz örökké oda-vissza írná egymást, és mindkettő azt látná,
  // hogy „a másik elrontja”.
  const a = focus({
    packs: [pack('p1')], run: null, rev: 3, updatedAt: 100, updatedBy: 'eszkoz-a',
  });
  const b = focus({
    packs: [pack('p2', ['github.com'])], run: null, rev: 3, updatedAt: 100, updatedBy: 'eszkoz-b',
  });
  const once = mergeFocus(a, b);
  assert.ok(sameFocus(mergeFocus(a, b), mergeFocus(b, a)), 'a sorrend nem számíthat');
  assert.ok(sameFocus(mergeFocus(once, b), once), 'másodszorra nem változhat');
});

test('a futás kiesik, ha a csomagja nincs meg', () => {
  // Nem tippelünk: a fehérlista TARTALMA nem az a dolog, amit kitalálni szabad.
  // Egy futás ismeretlen csomaggal azt jelentené, hogy tiltunk mindent, és nem
  // tudjuk megmondani, mi az a valami, ami mehet.
  const parsed = normalizeSyncFocus({
    packs: [{ id: 'p1', name: 'Egy', allowSites: [], allowApps: [], defaultMinutes: 50 }],
    run: { packId: 'nincs-ilyen', startedAt: 0, endsAt: 9_000 },
    rev: 1, updatedAt: 1, updatedBy: 'a',
  }, 'a');
  assert.equal(parsed.run, null);
  assert.equal(parsed.packs.length, 1);
});

test('egy rossz csomag nem viszi magával az egész blobot', () => {
  // Ha a normalizálás elhasalna az első hibás soron, egy elrontott csomag a
  // FUTÓ munkamenetet is eltüntetné — a felhasználó pedig azt látná, hogy a
  // munkamenet magától kikapcsolt.
  const parsed = normalizeSyncFocus({
    packs: [
      null,
      { id: '', name: 'névtelen' },
      { id: 'p1', name: 'Jó', allowSites: ['quizlet.com'], allowApps: [], defaultMinutes: 50 },
    ],
    run: { packId: 'p1', startedAt: 0, endsAt: 9_000 },
    rev: 2, updatedAt: 5, updatedBy: 'a',
  }, 'a');
  assert.equal(parsed.packs.length, 1);
  assert.equal(parsed.run?.packId, 'p1');
});

test('a szemét blob üres állapot lesz, nem kivétel', () => {
  for (const junk of [null, undefined, 42, 'szoveg', []]) {
    const parsed = normalizeSyncFocus(junk, 'eszkoz-a');
    assert.deepEqual(parsed.packs, []);
    assert.equal(parsed.run, null);
    assert.equal(parsed.updatedBy, 'eszkoz-a');
  }
});
