// Véletlen-teszt a zárlat-ablak magjára.
//
// Az ablak ígérete három mondat: a zárlat tőle SOSEM rövidül; amit egyszer
// kiírt, azt másodszor már nem írja (a kör minden percben fut); és két eszköz
// ugyanabból a listából ugyanazt a zárlatot állítja elő, akkor is, ha más
// pillanatban néznek rá. A többi teszt egy-egy esetet néz; ez több ezer
// véletlen listát, időpontot és futó zárlatot dob a magra, és MINDEN lépés
// után ellenőrzi a három mondatot. A fésülés és a lazítás szabályát is.
//
// A generátor magja rögzített, tehát egy elhasalás visszajátszható: a hiba a
// magot is kiírja.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  dueLockdownWindow, isWindowLockdown, isWindowsLoosening, mergeWindows, normalizeWindows,
  windowKey, windowLockdown, MAX_LOCKDOWN_WINDOWS, type Lockdown, type LockdownWindow,
} from '../src/shared/lockdown';
import { inAnyBand, type Band, type Weekday } from '../src/shared/schedule';

/** Determinisztikus generátor (mulberry32), hogy a hiba visszajátszható legyen. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Egy hétfő éjfél helyi időben; a véletlen pillanatok három hétig innen. */
const BASE = new Date(2026, 8, 7, 0, 0, 0).getTime();

function pick<T>(r: () => number, items: T[]): T {
  return items[Math.floor(r() * items.length)];
}

/** Egy érvényes ablak: véletlen napok, kezdés, vég — néha egész napos, néha éjfélen átnyúló. */
function randomWindow(r: () => number, id: string): LockdownWindow {
  let days = ([0, 1, 2, 3, 4, 5, 6] as Weekday[]).filter(() => r() < 0.4);
  if (days.length === 0) days = [Math.floor(r() * 7) as Weekday];
  if (r() < 0.1) return { id, days, startMin: 0, endMin: 1440 };
  // Kerek órák gyakran, hogy a sávok tényleg találkozzanak és egymásba érjenek.
  const startMin = r() < 0.6 ? 60 * Math.floor(r() * 24) : Math.floor(r() * 1440);
  const endMin = r() < 0.6 ? 60 * (1 + Math.floor(r() * 24)) : 1 + Math.floor(r() * 1440);
  return { id, days, startMin, endMin };
}

function randomWindows(r: () => number, device: string, min = 0): LockdownWindow[] {
  const n = r() < 0.1 ? min : Math.max(min, Math.floor(r() * (MAX_LOCKDOWN_WINDOWS + 1)));
  const raw: LockdownWindow[] = [];
  for (let i = 0; i < n; i++) raw.push(randomWindow(r, `w${i}@${device}`));
  return normalizeWindows(raw);
}

/** Nincs / lejárt / futó zárlat — a futó akár napokig, hogy az ablakot át is fedje. */
function randomLockdown(r: () => number, now: number): Lockdown | null {
  const roll = r();
  if (roll < 0.4) return null;
  if (roll < 0.6) return { startedAt: now - 5 * HOUR, until: now - 1 - Math.floor(r() * 2 * HOUR) };
  return { startedAt: now - Math.floor(r() * 3 * DAY), until: now + 1 + Math.floor(r() * 3 * DAY) };
}

function keys(list: Band[]): string[] {
  return list.map(windowKey).sort();
}

test('az ablak-zárlat sosem rövidít, egyszer ír, és két eszközön ugyanaz', () => {
  for (let seed = 1; seed <= 4000; seed++) {
    const r = rng(seed);
    const ctx = `mag ${seed}`;
    const windows = randomWindows(r, 'a');
    const now = BASE + Math.floor(r() * 21 * DAY);
    const cur = randomLockdown(r, now);
    const occ = dueLockdownWindow(windows, now);
    const fw = windowLockdown(cur, windows, now);

    if (occ) {
      assert.ok(occ.startsAt <= now && now < occ.endsAt, `${ctx}: az esedékes előfordulás él`);
      // A legkésőbb végződő élő előfordulás — ablakonként nézve egyik sem ér tovább.
      for (const w of windows) {
        const one = dueLockdownWindow([w], now);
        assert.ok(!one || one.endsAt <= occ.endsAt, `${ctx}: van tovább érő ablak`);
      }
    }

    if (!fw) {
      // Semmi írnivaló: nincs élő ablak, vagy a futó zárlat már az ablak végéig ér.
      if (occ) assert.ok(cur !== null && cur.until > now && cur.until >= occ.endsAt, `${ctx}: élő ablak zárlat nélkül`);
      continue;
    }
    assert.ok(occ, `${ctx}: ablak-zárlat élő ablak nélkül`);
    assert.equal(fw.until, occ!.endsAt, `${ctx}: a vég az ablak vége`);
    assert.ok(fw.until > now, `${ctx}: a kiírt zárlat él`);
    // Sosem rövidít: a kiírt vég minden korábbi végnél későbbi.
    assert.ok(fw.until > (cur ? cur.until : -Infinity), `${ctx}: rövidített`);
    if (cur && cur.until > now) assert.equal(fw.startedAt, cur.startedAt, `${ctx}: a futó zárlat kezdése marad`);
    else assert.equal(fw.startedAt, occ!.startsAt, `${ctx}: a kezdés az ablak kezdése`);
    assert.ok(fw.startedAt <= now, `${ctx}: jövőbeli kezdés`);
    assert.ok(isWindowLockdown(fw, windows), `${ctx}: a kiírt zárlat nem ablaké`);
    // Egyszer ír: a kiírt zárlattal a kör már nem ír újat.
    assert.equal(windowLockdown(fw, windows, now), null, `${ctx}: másodszor is írt`);

    // Két eszköz: a másik később nézi meg, zárlat nélkül — ugyanazt kapja, vagy
    // egy közben beért, tovább érő ablakét (ami ezt is ugyanígy kitolná).
    const later = now + Math.floor(r() * (fw.until - now));
    const other = windowLockdown(null, windows, later);
    assert.ok(other, `${ctx}: a másik eszköz nem lát zárlatot`);
    assert.ok(other!.until >= fw.until, `${ctx}: a másik eszköz rövidebbet lát`);
    if (other!.until === fw.until) assert.equal(other!.startedAt, occ!.startsAt, `${ctx}: más kezdés`);
    const mine = windowLockdown(fw, windows, later);
    assert.ok(mine === null || (mine.startedAt === fw.startedAt && mine.until > fw.until), `${ctx}: a saját kör rövidített`);

    // Előre az időben: a lánc (kézi zárlat, ablak, következő ablak) csak nő.
    let l: Lockdown | null = fw;
    let t = now;
    for (let k = 0; k < 6; k++) {
      t += Math.floor(r() * 8 * HOUR);
      const n = windowLockdown(l, windows, t);
      if (!n) continue;
      assert.ok(n.until > l!.until, `${ctx}: a lánc rövidült`);
      if (l!.until > t) assert.equal(n.startedAt, l!.startedAt, `${ctx}: a lánc kezdése elmozdult`);
      assert.ok(isWindowLockdown(n, windows), `${ctx}: a lánc tagja nem ablaké`);
      l = n;
    }
  }
});

test('a fésülés: nagyobb jel nyer, azonos jelnél a bővebb lista, a helyi azonosítók maradnak', () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const r = rng(seed);
    const ctx = `mag ${seed}`;
    // Néha közös azonosító-séma: két eszköz ugyanazzal az azonosítóval más tartalmat is hozhat.
    const shared = r() < 0.3;
    const a = randomWindows(r, shared ? 'x' : 'a');
    const b = randomWindows(r, shared ? 'x' : 'b');
    const ma = Math.floor(r() * 4);
    const mb = Math.floor(r() * 4);
    const m = mergeWindows(ma, a, mb, b);

    assert.ok(m.length <= MAX_LOCKDOWN_WINDOWS, `${ctx}: túl sok ablak`);
    assert.equal(new Set(m.map(windowKey)).size, m.length, `${ctx}: dupla tartalom`);
    assert.equal(new Set(m.map((w) => w.id)).size, m.length, `${ctx}: dupla azonosító`);
    assert.deepEqual(mergeWindows(ma, m, ma, m), m, `${ctx}: a fésülés nem idempotens`);

    if (ma > mb) { assert.deepEqual(m, a, `${ctx}: a nagyobb helyi jel nem nyert`); continue; }
    if (mb > ma) { assert.deepEqual(m, b, `${ctx}: a nagyobb beérkező jel nem nyert`); continue; }

    const union = new Set([...keys(a), ...keys(b)]);
    for (const k of keys(a)) assert.ok(m.some((w) => windowKey(w) === k), `${ctx}: helyi ablak elveszett`);
    for (const w of m) assert.ok(union.has(windowKey(w)), `${ctx}: ablak a semmiből`);
    for (const w of a) {
      const kept = m.find((x) => windowKey(x) === windowKey(w));
      assert.equal(kept?.id, w.id, `${ctx}: a helyi azonosító nem maradt`);
    }
    if (!shared && union.size <= MAX_LOCKDOWN_WINDOWS) {
      assert.deepEqual(keys(m), [...union].sort(), `${ctx}: azonos jelnél nem az unió`);
      assert.deepEqual(keys(mergeWindows(mb, b, ma, a)), keys(m), `${ctx}: a fésülés nem szimmetrikus`);
    }
    for (const w of b) {
      if (m.some((x) => windowKey(x) === windowKey(w))) continue;
      // Ami a beérkezőből kimaradt, annak oka van: tele a lista, vagy az azonosítója már foglalt.
      const idTaken = a.some((x) => x.id === w.id);
      assert.ok(union.size > MAX_LOCKDOWN_WINDOWS || idTaken, `${ctx}: beérkező ablak ok nélkül veszett el`);
    }
  }
});

test('a lazítás: bővítés sosem lazítás, az utolsó ablak levétele mindig az', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const r = rng(seed);
    const ctx = `mag ${seed}`;
    const a = randomWindows(r, 'a', 1);
    const now = BASE + Math.floor(r() * 21 * DAY);
    assert.equal(isWindowsLoosening(a, a, now), false, `${ctx}: ugyanaz a lista lazítás`);
    assert.equal(isWindowsLoosening(a, [], now), true, `${ctx}: minden ablak levétele nem lazítás`);
    assert.equal(isWindowsLoosening([], a, now), false, `${ctx}: az első ablak felvétele lazítás`);
    const extra = randomWindow(r, 'extra');
    assert.equal(isWindowsLoosening(a, [...a, extra], now), false, `${ctx}: a bővítés lazítás`);
    // Egy ablak levétele akkor lazítás, ha van olyan perc a héten, amit csak ő zárt.
    const rest = a.slice(1);
    let uncovered = false;
    for (let i = 0; i < 7 * 24 * 60 && !uncovered; i++) {
      const t = now + i * 60_000;
      if (inAnyBand(a, t) && !inAnyBand(rest, t)) uncovered = true;
    }
    assert.equal(isWindowsLoosening(a, rest, now), uncovered, `${ctx}: a levétel lazítás-ítélete`);
  }
});
