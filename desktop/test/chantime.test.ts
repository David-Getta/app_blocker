import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A csatorna-idő magja csak a bővítményben él (az app nem látja ezt az
 * adatot), de a logikáját itt teszteljük — a KISZÁLLÍTOTT bájtokon, mint a
 * csatorna-szűrő magját: amit a böngészőbe adunk, azt futtatjuk, nem egy
 * másolatot.
 */

function extensionDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'extension');
    if (fs.existsSync(path.join(candidate, 'chantime.js'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('nem talalom az extension/ mappat');
}

interface ChanTime {
  RETENTION_DAYS: number;
  MAX_KEYS_PER_DAY: number;
  dayKey(now?: Date): string;
  entryKey(host: string, channel: string): string;
  addSeconds(state: unknown, day: string, host: string, channel: string, sec: number): {
    days: Record<string, Record<string, number>>;
  };
  sweepDays(state: unknown, today: string): { days: Record<string, Record<string, number>> };
  lastDays(today: string, count: number): string[];
  topChannels(state: unknown, days: string[], limit?: number): {
    host: string; channel: string; seconds: number;
  }[];
  formatSeconds(sec: number): string;
}

function loadChanTime(): ChanTime {
  const src = fs.readFileSync(path.join(extensionDir(), 'chantime.js'), 'utf8');
  const names: string[] = [];
  const body = src.replace(/^export (const|function) (\w+)/gm, (_m, kind, name) => {
    names.push(name as string);
    return `${kind} ${name}`;
  });
  if (names.length < 6) throw new Error('a csatorna-idő magja nem exportál eleget');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn { ${names.join(', ')} };`)() as ChanTime;
}

const ct = loadChanTime();

test('a másodpercek gyűlnek, a szemét nem', () => {
  let s = ct.addSeconds({}, '2026-08-28', 'youtube.com', '@jo', 10);
  s = ct.addSeconds(s, '2026-08-28', 'youtube.com', '@jo', 5);
  s = ct.addSeconds(s, '2026-08-28', 'youtube.com', '@masik', 3);
  assert.equal(s.days['2026-08-28']['youtube.com|@jo'], 15);
  assert.equal(s.days['2026-08-28']['youtube.com|@masik'], 3);
  s = ct.addSeconds(s, '2026-08-28', 'youtube.com', '@jo', 0);
  s = ct.addSeconds(s, '2026-08-28', 'youtube.com', '@jo', NaN);
  s = ct.addSeconds(s, '2026-08-28', 'youtube.com', '@jo', -4);
  assert.equal(s.days['2026-08-28']['youtube.com|@jo'], 15, 'a nem-idő nem idő');
});

test('a napi sor-korlát az ÚJ kulcsot fogja meg, a meglévőt nem', () => {
  let s: ReturnType<ChanTime['addSeconds']> = { days: {} };
  for (let i = 0; i < ct.MAX_KEYS_PER_DAY; i++) {
    s = ct.addSeconds(s, '2026-08-28', 'youtube.com', `@cs${i}`, 1);
  }
  s = ct.addSeconds(s, '2026-08-28', 'youtube.com', '@tulcsordulo', 1);
  assert.equal(s.days['2026-08-28']['youtube.com|@tulcsordulo'], undefined,
    'a korlát fölött új sor nem születik');
  s = ct.addSeconds(s, '2026-08-28', 'youtube.com', '@cs0', 9);
  assert.equal(s.days['2026-08-28']['youtube.com|@cs0'], 10,
    'a meglévő sor a korlát mellett is gyűlik tovább');
});

test('a takarítás a régi ÉS a jövőbeli napokat is eldobja', () => {
  const s: { days: Record<string, Record<string, number>> } = { days: {} };
  // 40 nap a múltból — csak az utolsó RETENTION_DAYS maradhat.
  const days = ct.lastDays('2026-08-28', 40);
  for (const d of days) s.days[d] = { 'youtube.com|@jo': 1 };
  s.days['2027-01-01'] = { 'youtube.com|@jovo': 1 }; // elállított óra
  const out = ct.sweepDays(s, '2026-08-28');
  const kept = Object.keys(out.days).sort();
  assert.equal(kept.length, ct.RETENTION_DAYS);
  assert.equal(kept[kept.length - 1], '2026-08-28');
  assert.ok(!kept.includes('2027-01-01'), 'a jövőbeli nap nem mérés');
  assert.ok(!kept.includes(days[0]), 'a legrégebbi nap kiesett');
});

test('a napok listája hónaphatáron át is jó', () => {
  assert.deepEqual(ct.lastDays('2026-03-02', 4),
    ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  assert.deepEqual(ct.lastDays('2026-08-28', 1), ['2026-08-28']);
});

test('az élen a legtöbb idő áll, és a napok összeadódnak', () => {
  let s: ReturnType<ChanTime['addSeconds']> = { days: {} };
  s = ct.addSeconds(s, '2026-08-27', 'youtube.com', '@sok', 100);
  s = ct.addSeconds(s, '2026-08-28', 'youtube.com', '@sok', 50);
  s = ct.addSeconds(s, '2026-08-28', 'youtube.com', '@keves', 30);
  s = ct.addSeconds(s, '2026-08-28', 'tiktok.com', '@mashol', 70);
  const top = ct.topChannels(s, ['2026-08-27', '2026-08-28']);
  assert.deepEqual(top.map((x) => `${x.host} ${x.channel} ${x.seconds}`), [
    'youtube.com @sok 150',
    'tiktok.com @mashol 70',
    'youtube.com @keves 30',
  ]);
  const todayOnly = ct.topChannels(s, ['2026-08-28'], 2);
  assert.deepEqual(todayOnly.map((x) => x.channel), ['@mashol', '@sok'],
    'a keret (limit) és a napszűkítés is érvényesül');
});

test('az idő olvashatóan íródik ki', () => {
  assert.equal(ct.formatSeconds(30), '30 mp');
  assert.equal(ct.formatSeconds(90), '2 p');
  assert.equal(ct.formatSeconds(48 * 60), '48 p');
  assert.equal(ct.formatSeconds(3600), '1 ó');
  assert.equal(ct.formatSeconds(8100), '2 ó 15 p');
});

test('a nap kulcsa helyi idő szerint áll össze', () => {
  assert.equal(ct.dayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(ct.dayKey(new Date(2026, 11, 31, 0, 0)), '2026-12-31');
});
