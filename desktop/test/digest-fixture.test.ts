// Megfelelőségi fixtúra a HETI VISSZATEKINTÉS mondatára: a három mag ugyanazt
// a mondatot írja ugyanabból a hétből.
//
// A visszatekintés a statisztika hangja egy hétfő reggeli mondatban — tükör,
// nem ítélet. Mindhárom platform maga írja a saját mondatát; a számok a
// szinkronon utaznak. Ha a három generátor eltér (egy kerekítés, egy
// vesszőhiba, egy kimaradt tagmondat), a felhasználó ugyanarról a hétről
// három mondatot kap, és nem tudja, melyik az igaz.
//
// EGY szándékos eltérés van, és kimondva: a megakadás szava a platformé — a
// gépen a böngésző-bővítmény akaszt meg („a böngészőben”), a telefonon a
// DNS-szűrő („a szűrőben”). A két visszajátszó ezt az egy szót a gépére írja
// át a hasonlítás előtt; minden más résznek bájtra egyeznie kell.
//
// A címkézés a felületé: itt mindhárom teszt ugyanazt a jelölő címkézést
// használja ([név]), hogy látsszon, HOL hívja a mondat.
//
//   UPDATE_DIGEST_FIXTURE=1 npm test     — a fájl újraírása

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { digestText, type DigestInput } from '../src/shared/digest';
import type { FocusSummary } from '../src/shared/focus';
import { rng } from './merge-random';

const FIXTURE = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'digest-cases.json');
const SEEDS = 80;

interface DigestCase { seed: number; input: DigestInput; text: string | null }
interface Fixture { note: string; version: number; cases: DigestCase[] }

const LABELS = ['youtube.com', 'reddit.com', 'tiktok.com', 'Slack', 'Instagram', 'h:1'];
const labelOf = (l: string) => `[${l}]`;

const EMPTY: FocusSummary = { sessions: 0, totalMs: 0, stoppedEarly: 0, windowRuns: 0, topPack: null };

/** Kézzel válogatott hetek: az üres (null), a csak-feloldás, a csak-előző-hét, a teljes. */
const CURATED: DigestInput[] = [
  { last7Seconds: 0, topWeekSites: [], weekOverWeek: [], focusWeek: EMPTY, unlocks7d: 0, daysTracked: 0 },
  { last7Seconds: 0, topWeekSites: [], weekOverWeek: [], focusWeek: EMPTY, unlocks7d: 2, daysTracked: 0 },
  { last7Seconds: 0, topWeekSites: [], weekOverWeek: [], focusWeek: EMPTY, unlocks7d: 0, daysTracked: 0, unlocksPrev7d: 3 },
  { last7Seconds: 0, topWeekSites: [], weekOverWeek: [], focusWeek: EMPTY, unlocks7d: 0, daysTracked: 0, dropped7d: 1 },
  { last7Seconds: 0, topWeekSites: [], weekOverWeek: [], focusWeek: EMPTY, unlocks7d: 0, daysTracked: 0, browserHitsPrev7d: 4 },
  { last7Seconds: 0, topWeekSites: [], weekOverWeek: [], focusWeek: EMPTY, focusPrevWeek: { ...EMPTY, sessions: 2, totalMs: 3_000_000 }, unlocks7d: 0, daysTracked: 0 },
  { last7Seconds: 59, topWeekSites: [{ label: 'youtube.com', seconds: 59 }], weekOverWeek: [], focusWeek: EMPTY, unlocks7d: 0, daysTracked: 1 },
  {
    last7Seconds: 25_200, topWeekSites: [{ label: 'youtube.com', seconds: 9_000 }], topWeekApps: [{ label: 'Slack', seconds: 12_000 }],
    weekOverWeek: [{ label: 'youtube.com', thisWeek: 9_000, deltaPct: 12.5 }, { label: 'Slack', thisWeek: 12_000, deltaPct: -5 }],
    focusWeek: { sessions: 4, totalMs: 6_000_000, stoppedEarly: 1, windowRuns: 2, topPack: 'Tanulás' },
    focusPrevWeek: { sessions: 3, totalMs: 4_500_000, stoppedEarly: 0, windowRuns: 0, topPack: null },
    unlocks7d: 2, unlocksPrev7d: 1, dropped7d: 1, limitFullDays: 2, burstTripsWeek: 3,
    browserHits7d: 7, browserHitsPrev7d: 9, browserHitsPeak: { hour: 22, count: 3 }, browserHitsPeakPack: 'Esti',
    browserHitsWeekday: { day: 2, count: 4 }, focusWeekday: { day: 2, count: 5 }, usageWeekday: { day: 6, count: 36_000 },
    focusHour: { hour: 22, count: 3 }, focusStreak: 4, focusLongestStreak: 9, focusHourPack: null, focusHourWindowOffer: true,
    browserHitsTop: { label: 'reddit.com', count: 5 }, daysTracked: 7, unblockedTop: [{ label: 'Instagram', seconds: 4_000 }],
  },
  {
    last7Seconds: 3_600, topWeekSites: [{ label: 'h:1', seconds: 3_600 }], weekOverWeek: [{ label: 'h:1', thisWeek: 3_600, deltaPct: -40.4 }],
    focusWeek: EMPTY, unlocks7d: 0, daysTracked: 3, browserHits7d: 1, browserHitsPeak: { hour: 0, count: 1 }, peakWindowOffer: true,
  },
];

/** Egy véletlen hét: minden mező a maga esélyével — hiányzó (régi hívó), null, nulla, kicsi, nagy. */
function randomInput(r: () => number): DigestInput {
  for (let i = 0; i < 4; i++) r();
  const pick = <T>(arr: T[]): T => arr[Math.floor(r() * arr.length)];
  const n = (max: number): number => Math.floor(r() * (max + 1));
  const maybe = <T>(p: number, f: () => T): T | undefined => (r() < p ? f() : undefined);
  const daysTracked = n(7);
  const last7Seconds = daysTracked === 0 ? 0 : pick([0, 59, 60, 61, 1800, 3600, 5400, 86_400, 144_000]) + n(120);
  const tops = (max: number, pool: number[]) =>
    Array.from({ length: n(max) }, () => ({ label: pick(LABELS), seconds: pick(pool) + n(60) }));
  const summary = (): FocusSummary => {
    const sessions = n(6);
    return {
      sessions, totalMs: sessions === 0 ? 0 : (n(300) + 5) * 60_000, stoppedEarly: n(sessions), windowRuns: n(sessions),
      topPack: r() < 0.5 ? 'Tanulás' : null,
    };
  };
  const hourCount = () => ({ hour: n(23), count: 1 + n(9) });
  const dayCount = () => ({ day: n(6), count: 1 + n(9) });
  const peak = maybe(0.7, () => (r() < 0.7 ? hourCount() : null));
  const peakDay = maybe(0.7, () => (r() < 0.7 ? dayCount() : null));
  // A tükör két fele néha egy pontra mutat: a menet-óra a csúcs-óra, a menet-nap a csúcs-nap.
  const focusHour = maybe(0.7, () => (peak && r() < 0.3 ? { ...peak } : r() < 0.7 ? hourCount() : null));
  const focusWeekday = maybe(0.7, () => (peakDay && r() < 0.3 ? { ...peakDay } : r() < 0.7 ? dayCount() : null));
  const focusStreak = n(9);
  return {
    last7Seconds,
    topWeekSites: tops(3, [0, 30, 600, 3599, 3600, 7200]),
    topWeekApps: maybe(0.6, () => tops(2, [0, 900, 4000])),
    weekOverWeek: LABELS.filter(() => r() < 0.5).map((label) => ({
      label, thisWeek: n(5000), deltaPct: r() < 0.3 ? null : pick([-80, -12.5, -5, -4.4, 0, 4.9, 5, 5.1, 12.5, 40, 250]),
    })),
    focusWeek: summary(),
    focusPrevWeek: maybe(0.6, summary),
    unlocks7d: n(5),
    unlocksPrev7d: maybe(0.7, () => n(4)),
    dropped7d: maybe(0.7, () => n(3)),
    limitFullDays: maybe(0.6, () => n(4)),
    burstTripsWeek: maybe(0.6, () => n(5)),
    browserHits7d: maybe(0.8, () => n(20)),
    browserHitsPrev7d: maybe(0.7, () => n(15)),
    browserHitsPeak: peak,
    browserHitsPeakPack: maybe(0.6, () => (r() < 0.4 ? 'Tanulás' : null)),
    peakWindowOffer: maybe(0.6, () => r() < 0.5),
    browserHitsWeekday: peakDay,
    focusWeekday,
    usageWeekday: maybe(0.7, () => (r() < 0.7 ? { day: n(6), count: 600 * (1 + n(40)) } : null)),
    focusHour,
    focusStreak: maybe(0.8, () => focusStreak),
    focusLongestStreak: maybe(0.8, () => focusStreak + n(5)),
    focusHourPack: maybe(0.6, () => (r() < 0.4 ? 'Olvasás' : null)),
    focusHourWindowOffer: maybe(0.6, () => r() < 0.5),
    browserHitsTop: maybe(0.7, () => (r() < 0.7 ? { label: pick(LABELS), count: 1 + n(9) } : null)),
    daysTracked,
    unblockedTop: maybe(0.6, () => tops(2, [0, 1200, 7200])),
  };
}

function buildFixture(): Fixture {
  const cases: DigestCase[] = CURATED.map((input, i) => ({ seed: 1000 + i, input, text: digestText(input, labelOf) }));
  for (let seed = 1; seed <= SEEDS; seed++) {
    const input = randomInput(rng(seed));
    cases.push({ seed, input, text: digestText(input, labelOf) });
  }
  return {
    note: 'Generálja és őrzi: desktop/test/digest-fixture.test.ts (UPDATE_DIGEST_FIXTURE=1 npm test). '
      + 'Egy hét számai (a gép DigestInput alakjában; a hiányzó mező a régi hívó) és a gép mondata a [név] címkézéssel '
      + '(null: nincs miről beszélni). Olvassa: android/jvm-tests DigestFixtureTest, ios/SharedTests DigestFixtureTests — '
      + 'a megakadás szavát (a gépen a böngészőben, a telefonon a szűrőben) a gépére írva. Csupa ASCII.',
    version: 1,
    cases,
  };
}

function ascii(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function render(f: Fixture): string {
  const rows = f.cases.map((c) => {
    // A bemenet egy sorban, csupa ASCII-ban; a JSON.stringify a hiányzó mezőt kihagyja.
    const input = JSON.stringify(c.input).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return `  {"seed":${c.seed},"input":${input},"text":${c.text === null ? 'null' : ascii(c.text)}}`;
  });
  return `{\n "note": ${ascii(f.note)},\n "version": ${f.version},\n "cases": [\n${rows.join(',\n')}\n ]\n}\n`;
}

test('a visszatekintés fixtúrája friss, és nem elfajult', () => {
  const built = buildFixture();
  assert.ok(built.cases.some((c) => c.text === null), 'nincs üres hét');
  assert.ok(built.cases.filter((c) => c.text !== null).length > SEEDS / 2, 'kevés mondat');
  for (const c of built.cases) {
    if (c.text === null) continue;
    assert.ok(c.text.startsWith('Elmúlt 7 nap: '), `nem a visszatekintés hangja: ${c.text}`);
    assert.ok(!c.text.includes('undefined') && !c.text.includes('NaN'), `lyuk a mondatban: ${c.text}`);
  }
  // A platform-szó egyszer sem a telefoné: ez a gép mondata.
  assert.ok(built.cases.every((c) => !c.text || !c.text.includes('a szűrőben')));
  const text = render(built);
  if (process.env.UPDATE_DIGEST_FIXTURE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, text);
  }
  assert.ok(fs.existsSync(FIXTURE), `nincs fixture: ${FIXTURE} — UPDATE_DIGEST_FIXTURE=1 npm test`);
  const onDisk = fs.readFileSync(FIXTURE, 'utf8');
  assert.equal(
    onDisk, text,
    'a fixtures/digest-cases.json elavult a gép mondatához képest — UPDATE_DIGEST_FIXTURE=1 npm test, '
      + 'aztán a Kotlin (DigestFixtureTest) és a Swift (DigestFixtureTests) teszt mutatja meg, hol csúszott el a tükör',
  );
  assert.ok(/^[\x00-\x7f]*$/.test(onDisk), 'a fixtúra nem csupa ASCII');
});
