// Megfelelőségi fixtúra a NAPI KERETRE: ugyanaz a mérés ugyanazt a keretet,
// ugyanazt a sort és ugyanazt a döntést adja a gépen, az Androidon és az
// iPhone-on.
//
// A keret eszközök között közös: minden eszköz feltölti a mai összegzését, a
// többi lehozza és hozzáadja. Ha a három mag másképp olvassa ugyanazt a
// blobot, a keret az egyik eszközön hamarabb telik be, mint a másikon — és
// semmi nem mondja meg, miért. Eddig így volt: a gép a tömbként érkező
// `seconds`-t is elfogadta, az Android a szövegként írt számot („120”), az
// iPhone az igaz/hamisat (a JSON-olvasó NSNumber-ként adja), és a 200-as
// plafon fölött mindhárom más sorrendben vágott (a gép a beérkezés, az iPhone
// a kulcs szerint, az Android a hash-tábla rendjében).
//
// Öt szekció: a dróton jövő összegzés (parseTodayDigest) a blob szövegéből; a
// keret betelt napjai és a sora — holtversenyben a domain kódegység szerint
// (a gép eddig `localeCompare`-rel rendezett: magyar nyelvi beállításon a
// „cz.hu” a „csak.hu” elé került); a „ma még N perc” sor; a lazítás és a
// hátralévő; és a döntés, hogy kimerült-e a keret a többi eszköz percével.
// A napok helyi időben számolnak: a fixtúra UTC-ben készül, a visszajátszás
// UTC-ben fut (a Swift kimondva kihagy, ha nem tudja beállítani).
//
//   UPDATE_LIMIT_FIXTURE=1 npm test     — a fájl újraírása

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MAX_DIGEST_TARGETS, isLimitExhausted, isLimitLoosening, limitFullDays, limitFullLine, limitRemaining, limitSoonLine,
  parseTodayDigest, type Limitable, type SharedToday, type TodayDigest,
} from '../src/shared/limits';
import { dayKey, siteKey, type UsageState } from '../src/shared/usage';
import { rng } from './merge-random';

process.env.TZ = 'UTC';

const FIXTURE = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'limit-cases.json');
const NOW = Date.UTC(2026, 9, 1, 12, 0);
const DAY = 24 * 3600_000;
const DEVICE = 'dev_masik';
const ch = (code: number): string => String.fromCodePoint(code);

type Pairs = [string, number][];
interface DigestCase { text: string; out: { day: string; seconds: Pairs } | null }
interface UsageDayIn { day: string; seconds: Record<string, number> }
interface FullDaysCase { now: number; days: UsageDayIn[]; limits: [string, number | null][]; full: number; bySite: [string, number][]; line: string }
interface SoonCase { candidates: [string, number | null, number][]; line: string }
interface LooseningCase { cur: number | null; next: number | null; loosening: boolean }
interface RemainingCase { limit: number | null; used: number; remaining: number | null }
interface ExhaustedCase { now: number; limit: number | null; local: number; shared: TodayDigest[]; exhausted: boolean }
interface Fixture {
  note: string; version: number; digests: DigestCase[]; fullDays: FullDaysCase[]; soon: SoonCase[];
  loosening: LooseningCase[]; remaining: RemainingCase[]; exhausted: ExhaustedCase[];
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function pick<T>(r: () => number, arr: T[]): T { return arr[Math.floor(r() * arr.length)]; }
function warm(seed: number): () => number { const r = rng(seed); for (let i = 0; i < 4; i++) r(); return r; }

// ------------------------------------------------------- dróton jövő összegzés

const TODAY = dayKey(NOW);
const ARABIC_DAY = [...TODAY].map((c) => (c >= '0' && c <= '9' ? ch(0x660 + Number(c)) : c)).join('');
const WIDE_DAY = [...TODAY].map((c) => (c >= '0' && c <= '9' ? ch(0xff10 + Number(c)) : c)).join('');

/** Egy szám, ahogy a JSON-ban áll — a szabály szélei. */
const NUMBERS = [
  '600', '1200', '0', '-5', '0.4', '0.49999999999999994', '0.5', '1.5', '2.5', '59.9', '86400', '86400.4', '86400.6',
  '90000', '1e20', '1.2e2', '1E3', '-0', '3600.0', '7e-1',
];
/** Ami nem szám, de a JSON-ban állhat — egyik mag sem veheti számnak. */
const NOT_NUMBERS = ['"120"', 'true', 'false', 'null', '{}', '[]', '[600]', '{"s":600}', '""'];
const KEYS = [
  'site:youtube.com', 'site:reddit.com', 'app:Slack', 'site:' + 'árvíz.hu', 'site:' + ch(0x1f600) + '.hu', '__proto__',
  '123', 'site:a.hu', 'site:A.hu', '',
];

function digestText(day: string | null, entries: [string, string][]): string {
  const dayPart = day === null ? '' : `"day":${day},`;
  return `{${dayPart}"seconds":{${entries.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',')}}}`;
}

function digestCase(text: string): DigestCase {
  const d = parseTodayDigest(text, DEVICE);
  if (!d) return { text, out: null };
  assert.equal(d.deviceId, DEVICE);
  const pairs = Object.entries(d.seconds).sort((a, b) => byCodeUnit(a[0], b[0])) as Pairs;
  return { text, out: { day: d.day, seconds: pairs } };
}

function digestCases(): DigestCase[] {
  const out: DigestCase[] = [];
  const day = JSON.stringify(TODAY);
  // A blob alakja: ami nem objektum, ami nem JSON, a hiányzó és a rossz `seconds`.
  for (const text of [
    '', '{bad', '[]', '5', '"x"', 'null', '{}', `{"day":${day}}`, `{"day":${day},"seconds":null}`,
    `{"day":${day},"seconds":"sok"}`, `{"day":${day},"seconds":[600,1200]}`, `{"day":${day},"seconds":{}}`,
    `{"day":${day},"seconds":{"site:youtube.com":600},"deviceId":"ez-a-gep"}`,
  ]) out.push(digestCase(text));
  // A nap: csak YYYY-MM-DD, ASCII számjeggyel — a formailag jó, de képtelen nap átmegy (a mai napot úgysem éri el).
  for (const d of [
    day, '"2026-1-01"', `" ${TODAY}"`, `"${TODAY} "`, `"${TODAY}\\n"`, '20261001', 'null', JSON.stringify(ARABIC_DAY),
    JSON.stringify(WIDE_DAY), '"tegnap"', '"2026-13-45"', '"0000-00-00"', '"2026/10/01"',
  ]) out.push(digestCase(digestText(d, [['site:youtube.com', '600']])));
  out.push(digestCase(digestText(null, [['site:youtube.com', '600']])));
  // A szám: minden él egy-egy kulccsal, és amit nem szabad számnak venni.
  for (const v of [...NUMBERS, ...NOT_NUMBERS]) out.push(digestCase(digestText(day, [['site:youtube.com', v], ['app:Slack', '60']])));
  // A kulcs: üres, `__proto__`, számszerű, ékezetes, emodzsis, kis- és nagybetű.
  out.push(digestCase(digestText(day, KEYS.map((k, i) => [k, String(60 * (i + 1))]))));

  // Véletlen blobok: vegyes értékek, a kulcsok keverve.
  for (let s = 1; s <= 40; s++) {
    const r = warm(500 + s);
    const n = Math.floor(r() * 12);
    const used = new Set<string>();
    const entries: [string, string][] = [];
    for (let i = 0; i < n; i++) {
      const k = r() < 0.6 ? pick(r, KEYS) : `site:x${Math.floor(r() * 30)}.hu`;
      if (used.has(k)) continue;
      used.add(k);
      entries.push([k, r() < 0.8 ? pick(r, NUMBERS) : pick(r, NOT_NUMBERS)]);
    }
    out.push(digestCase(digestText(r() < 0.9 ? day : pick(r, ['"2026-1-01"', 'null', JSON.stringify(ARABIC_DAY)]), entries)));
  }

  // A plafon: kétszáznál több cél, sok egyforma értékkel a határon — a legnagyobbak maradnak, holtversenyben a kulcs.
  for (let s = 1; s <= 6; s++) {
    const r = warm(900 + s);
    // Az első eset épp a plafon alatt marad (minden érték érvényes), a többi bőven fölötte.
    const n = s === 1 ? MAX_DIGEST_TARGETS - 1 : MAX_DIGEST_TARGETS + 60 + Math.floor(r() * 40);
    const keys = Array.from({ length: n }, (_, i) => `site:x${i}.hu`);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    const values = s === 1 ? ['60', '120', '300'] : ['60', '120', '120', '300', '300', '300', '600', '600', '0', 'true', '"900"'];
    const entries = keys.map((k) => [k, pick(r, values)] as [string, string]);
    out.push(digestCase(digestText(day, entries)));
  }
  return out;
}

// ---------------------------------------------------------- betelt napok

/** A magyar rendezés buktatói: „cs”, „ny”, „sz” külön betű; a kötőjel, a pont, a számjegy. */
const DOMAINS = [
  'youtube.com', 'reddit.com', 'cz.hu', 'csak.hu', 'nz.com', 'nyugat.hu', 'sport.hu', 'szamlazz.hu',
  'a-b.com', 'a.b.com', 'ab.com', '9gag.com', 'index.hu',
];
const LIMITS: (number | null)[] = [null, 0, -60, 60, 300, 600, 1200, 3600, 86400, 90000];
const DAYS_AROUND = Array.from({ length: 11 }, (_, i) => dayKey(NOW - (9 - i) * DAY)); // 9 nappal előtte .. holnap

function asSites(limits: [string, number | null][]): Limitable[] {
  return limits.map(([domain, limit]) => ({
    domain, dailyLimitSeconds: limit ?? undefined, pauseUntil: null, pendingDeleteAt: null,
  }) as unknown as Limitable);
}

function usageOf(days: UsageDayIn[]): UsageState {
  return { days: days.map((d) => ({ day: d.day, seconds: { ...d.seconds } })), labels: {}, enabled: true };
}

function fullDaysCases(): FullDaysCase[] {
  const out: FullDaysCase[] = [];
  for (let s = 1; s <= 50; s++) {
    const r = warm(1200 + s);
    const pool = [...DOMAINS];
    const limits: [string, number | null][] = [];
    const count = 1 + Math.floor(r() * 5);
    for (let i = 0; i < count && pool.length; i++) {
      const d = pool.splice(Math.floor(r() * pool.length), 1)[0];
      limits.push([d, pick(r, LIMITS)]);
    }
    const days: UsageDayIn[] = [];
    for (const day of DAYS_AROUND) {
      if (r() < 0.35) continue;
      const seconds: Record<string, number> = {};
      for (const [d, limit] of limits) {
        if (r() < 0.3) continue;
        const l = limit !== null && limit > 0 ? Math.min(limit, 86400) : 600;
        seconds[siteKey(d)] = pick(r, [l - 1, l, l, l + 1, l * 2, Math.floor(r() * 5000), l - 0.5, 0]);
      }
      if (r() < 0.3) seconds['app:Slack'] = 9999;
      days.push({ day, seconds });
    }
    const usage = usageOf(days);
    const r2 = limitFullDays(usage, asSites(limits), NOW);
    out.push({
      now: NOW, days, limits, full: r2.days, bySite: r2.bySite.map((x) => [x.domain, x.days]),
      line: limitFullLine(r2, (d) => `[${d}]`),
    });
  }
  // A holtverseny kézzel: minden oldal ugyanannyi napon telt be — csak a rendezés dönt.
  const tie: [string, number | null][] = ['nyugat.hu', 'nz.com', 'csak.hu', 'cz.hu', 'szamlazz.hu', 'sport.hu', 'a.b.com', 'a-b.com', 'ab.com', '9gag.com']
    .map((d) => [d, 600]);
  const tieDays = [{ day: TODAY, seconds: Object.fromEntries(tie.map(([d]) => [siteKey(d), 600])) }];
  const rt = limitFullDays(usageOf(tieDays), asSites(tie), NOW);
  out.push({ now: NOW, days: tieDays, limits: tie, full: rt.days, bySite: rt.bySite.map((x) => [x.domain, x.days]), line: limitFullLine(rt, (d) => `[${d}]`) });
  return out;
}

// --------------------------------------------------------------- ma még N perc

const LABELS = ['youtube.com', 'Árvíztűrő', 'reddit', 'h:1', 'Ő'];
const SOON_LIMITS: (number | null)[] = [null, 0, -30, 60, 300, 599, 600, 601, 1200, 1201, 3600, 90000];

function soonCases(): SoonCase[] {
  const out: SoonCase[] = [];
  for (let s = 1; s <= 80; s++) {
    const r = warm(2000 + s);
    const n = 1 + Math.floor(r() * 4);
    const candidates: [string, number | null, number][] = [];
    for (let i = 0; i < n; i++) {
      const limit = pick(r, SOON_LIMITS);
      const base = limit !== null && limit > 0 ? Math.min(limit, 86400) : 600;
      const used = r() < 0.8
        ? Math.max(0, base - pick(r, [0, 1, 0.5, 30.2, 59, 60, 61, 299, 300, 301, 599, 600, 601, -10]))
        : Math.floor(r() * 4000);
      candidates.push([pick(r, LABELS), limit, used]);
    }
    const line = limitSoonLine(candidates.map(([label, dailyLimitSeconds, usedSeconds]) => ({ label, dailyLimitSeconds, usedSeconds })));
    out.push({ candidates, line });
  }
  return out;
}

// ------------------------------------------------------ lazítás és hátralévő

const POOL: (number | null)[] = [null, 0, -60, 60, 600, 601, 3600, 86400, 90000];

function looseningCases(): LooseningCase[] {
  const out: LooseningCase[] = [];
  for (const cur of POOL) for (const next of POOL) out.push({ cur, next, loosening: isLimitLoosening(cur, next) });
  return out;
}

function remainingCases(): RemainingCase[] {
  const out: RemainingCase[] = [];
  for (const limit of POOL) {
    for (const used of [0, 0.5, 59.9, 600, 86400, 100000]) out.push({ limit, used, remaining: limitRemaining(limit, used) });
  }
  return out;
}

// --------------------------------------------- kimerült-e, a többi eszközzel

function exhaustedCases(): ExhaustedCase[] {
  const out: ExhaustedCase[] = [];
  const yesterday = dayKey(NOW - DAY);
  for (const limit of [null, 0, 600, 3600, 86400, 90000]) {
    for (const local of [0, 300, 599.5, 600, 50000]) {
      for (const other of [0, 300, 40000, 36400.5]) {
        const shared: TodayDigest[] = [
          // A saját sorunk és a tegnapi sor kimarad — a nagy szám csak akkor számítana, ha rossz volna a szabály.
          { deviceId: 'dev_self', day: TODAY, seconds: { [siteKey('youtube.com')]: 99999 } },
          { deviceId: 'dev_masik', day: yesterday, seconds: { [siteKey('youtube.com')]: 99999 } },
          { deviceId: 'dev_masik', day: TODAY, seconds: other > 0 ? { [siteKey('youtube.com')]: other, 'app:Slack': 5 } : {} },
          { deviceId: 'dev_harmadik', day: TODAY, seconds: { [siteKey('reddit.com')]: 99999 } },
        ];
        const usage = usageOf([{ day: TODAY, seconds: local > 0 ? { [siteKey('youtube.com')]: local } : {} }]);
        const site = asSites([['youtube.com', limit]])[0];
        const sh: SharedToday = { selfDeviceId: 'dev_self', devices: shared };
        out.push({ now: NOW, limit, local, shared, exhausted: isLimitExhausted(site, usage, NOW, sh) });
      }
    }
  }
  return out;
}

function buildFixture(): Fixture {
  return {
    note: 'Generálja és őrzi: desktop/test/limit-fixture.test.ts (UPDATE_LIMIT_FIXTURE=1 npm test). '
      + 'A dróton jövő napi összegzés a blob szövegéből (parseTodayDigest; deviceId: dev_masik, a kimenet kulcs szerint), '
      + 'a keret betelt napjai és sora ([név] címkével; holtversenyben kódegység), a „ma még N perc” sor, a lazítás, a '
      + 'hátralévő, és hogy kimerült-e a keret a többi eszköz percével (a saját és a tegnapi sor kimarad). UTC-ben. '
      + 'Olvassa: android/jvm-tests LimitFixtureTest, ios/SharedTests LimitFixtureTests. Csupa ASCII.',
    version: 1,
    digests: digestCases(), fullDays: fullDaysCases(), soon: soonCases(),
    loosening: looseningCases(), remaining: remainingCases(), exhausted: exhaustedCases(),
  };
}

/** Minden nem ASCII jel számmal írva. */
function ascii(json: string): string {
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    out += code < 0x7f ? json[i] : '\\u' + code.toString(16).padStart(4, '0');
  }
  return out;
}

function render(f: Fixture): string {
  const rows = (items: unknown[]) => items.map((c) => '  ' + ascii(JSON.stringify(c))).join(',\n');
  return `{\n "note": ${ascii(JSON.stringify(f.note))},\n "version": ${f.version},\n`
    + ` "digests": [\n${rows(f.digests)}\n ],\n`
    + ` "fullDays": [\n${rows(f.fullDays)}\n ],\n`
    + ` "soon": [\n${rows(f.soon)}\n ],\n`
    + ` "loosening": [\n${rows(f.loosening)}\n ],\n`
    + ` "remaining": [\n${rows(f.remaining)}\n ],\n`
    + ` "exhausted": [\n${rows(f.exhausted)}\n ]\n}\n`;
}

test('a dróton jövő összegzés szabálya: csak szám, ASCII nap, a legnagyobbak maradnak', () => {
  const day = JSON.stringify(TODAY);
  const d = parseTodayDigest(`{"day":${day},"seconds":{"a":"120","b":true,"c":null,"d":0.4,"e":0.5,"f":90000,"__proto__":7}}`, DEVICE);
  assert.ok(d);
  assert.deepEqual(Object.entries(d.seconds).sort((x, y) => byCodeUnit(x[0], y[0])), [['__proto__', 7], ['e', 1], ['f', 86400]]);
  assert.equal(parseTodayDigest(`{"day":${day},"seconds":[600]}`, DEVICE)?.seconds && Object.keys(parseTodayDigest(`{"day":${day},"seconds":[600]}`, DEVICE)!.seconds).length, 0, 'a tömb nem objektum');
  assert.equal(parseTodayDigest(`{"day":${JSON.stringify(ARABIC_DAY)},"seconds":{}}`, DEVICE), null, 'nem ASCII számjegy');
  assert.equal(parseTodayDigest('{bad', DEVICE), null, 'a hibás JSON null, nem kivétel');
  const many = Object.fromEntries(Array.from({ length: MAX_DIGEST_TARGETS + 10 }, (_, i) => [`site:x${i}.hu`, i < 10 ? 5 : 60]));
  const big = parseTodayDigest(JSON.stringify({ day: TODAY, seconds: many }), DEVICE)!;
  assert.equal(Object.keys(big.seconds).length, MAX_DIGEST_TARGETS);
  assert.ok(Object.values(big.seconds).every((v) => v === 60), 'a plafon fölött a legnagyobbak maradnak');
});

test('a betelt napok holtversenye kódegység szerint — nem a gép nyelvi beállítása szerint', () => {
  const tie: [string, number | null][] = [['nz.com', 600], ['nyugat.hu', 600], ['csak.hu', 600], ['cz.hu', 600]];
  const days = [{ day: TODAY, seconds: Object.fromEntries(tie.map(([d]) => [siteKey(d), 600])) }];
  const r = limitFullDays(usageOf(days), asSites(tie), NOW);
  assert.deepEqual(r.bySite.map((x) => x.domain), ['csak.hu', 'cz.hu', 'nyugat.hu', 'nz.com']);
});

test('a napi keret fixtúrája friss, és nem elfajult', () => {
  const built = buildFixture();
  assert.ok(built.digests.some((c) => c.out === null) && built.digests.filter((c) => c.out && c.out.seconds.length > 0).length > 20);
  assert.ok(built.digests.some((c) => c.out && c.out.seconds.length === MAX_DIGEST_TARGETS), 'van plafonig érő összegzés');
  assert.ok(built.fullDays.filter((c) => c.full > 0).length > 15 && built.fullDays.some((c) => c.full === 0));
  assert.ok(built.fullDays.some((c) => c.bySite.length > 1 && c.bySite[0][1] === c.bySite[1][1]), 'van holtverseny');
  assert.ok(built.soon.filter((c) => c.line !== '').length > 20 && built.soon.some((c) => c.line === ''));
  assert.ok(built.exhausted.some((c) => c.exhausted) && built.exhausted.some((c) => !c.exhausted));
  const text = render(built);
  if (process.env.UPDATE_LIMIT_FIXTURE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, text);
  }
  assert.ok(fs.existsSync(FIXTURE), `nincs fixture: ${FIXTURE} — UPDATE_LIMIT_FIXTURE=1 npm test`);
  const onDisk = fs.readFileSync(FIXTURE, 'utf8');
  assert.equal(
    onDisk, text,
    'a fixtures/limit-cases.json elavult a gép szabályához képest — UPDATE_LIMIT_FIXTURE=1 npm test, '
      + 'aztán a Kotlin (LimitFixtureTest) és a Swift (LimitFixtureTests) teszt mutatja meg, hol csúszott el a tükör',
  );
  assert.ok(/^[\x00-\x7f]*$/.test(onDisk), 'a fixtúra nem csupa ASCII');
});
