// Megfelelőségi fixtúra az ÓRAÁTÁLLÍTÁSRA: ugyanaz a heti sáv és időpont
// ugyanazt az előfordulást és döntést adja a gépen, az Androidon és az
// iPhone-on — Europe/Budapest időzónában, a 2026-os tavaszi (március 29.,
// 2:00 → 3:00) és őszi (október 25., 3:00 → 2:00) átállás éjszakáján.
//
// MIÉRT. A többi fixtúra UTC-ben jár, ott nincs átállás. Az őszi éjszakán a
// 2:00–2:59 kétszer van: a gép (JS) a kétszer előforduló falióra-időt az
// ELSŐ előfordulásra teszi, a Java GregorianCalendar a másodikra — egy
// 2:30-kor induló heti ablak (menet vagy zárlat) a két eszközön egy óra
// eltéréssel indult volna, két naplósorral. A szabály a JS-é (az ES-szabvány
// mondja ki): a kétszer előforduló idő az első, a kihagyott (tavasszal a
// 2:xx) az átállás előtti eltolással olvasva — vagyis egy órával később.
//
// Két szakasz: a heti ablak előfordulásai (`occurrenceAt`, `nextOccurrence`
// — a menet és a zárlat-ablak közös darabja), és a menetrend döntései
// (`isBlockedBySchedule`, `nextCloseAt`, `nextOpenAt`) ugyanazokon a
// sávokon. A Kotlin és a Swift a saját időzónáját erre állítja (a Swift
// kimondva kihagy, ha nem tudja).
//
//   UPDATE_DST_FIXTURE=1 npm test     — a fájl újraírása

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

process.env.TZ = 'Europe/Budapest';

import { nextOccurrence, occurrenceAt } from '../src/shared/focus';
import { isBlockedBySchedule, nextCloseAt, nextOpenAt, type Band, type Weekday } from '../src/shared/schedule';

const FIXTURE = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'dst-cases.json');
const MIN = 60_000;

/** A két átállás éjszakája: szombat 22:00 helyi időtől vasárnap 5:00-ig, UTC-ben megadva. */
const NIGHTS = [
  { name: 'tavasz', from: Date.UTC(2026, 2, 28, 21, 0), to: Date.UTC(2026, 2, 29, 3, 0) },   // 22:00 CET → 05:00 CEST
  { name: 'ősz', from: Date.UTC(2026, 9, 24, 20, 0), to: Date.UTC(2026, 9, 25, 4, 0) },      // 22:00 CEST → 05:00 CET
];

/** Hajnali sávok: a kihagyott és a kétszer előforduló óra szélein, éjfélen átnyúlva is. */
const BANDS: Band[] = [
  { days: [0], startMin: 120, endMin: 180 },        // 2:00–3:00
  { days: [0], startMin: 150, endMin: 210 },        // 2:30–3:30
  { days: [0], startMin: 90, endMin: 150 },         // 1:30–2:30
  { days: [0], startMin: 179, endMin: 181 },        // 2:59–3:01
  { days: [0], startMin: 0, endMin: 120 },          // 0:00–2:00
  { days: [6], startMin: 1380, endMin: 180 },       // szombat 23:00 – vasárnap 3:00
  { days: [6], startMin: 1410, endMin: 150 },       // szombat 23:30 – vasárnap 2:30
  { days: [0, 1, 2, 3, 4, 5, 6] as Weekday[], startMin: 150, endMin: 151 },  // minden nap 2:30–2:31
];

interface Case {
  band: Band; t: number;
  occ: [number, number] | null; next: [number, number] | null;
  blocked: boolean; close: number; open: number;
}

function buildCases(): Case[] {
  const out: Case[] = [];
  for (const night of NIGHTS) {
    for (const band of BANDS) {
      for (let t = night.from; t <= night.to; t += 15 * MIN) {
        const o = occurrenceAt(band, t);
        const n = nextOccurrence(band, t);
        const schedule = { mode: 'scheduled_block' as const, bands: [band] };
        out.push({
          band, t,
          occ: o ? [o.startsAt, o.endsAt] : null,
          next: n ? [n.startsAt, n.endsAt] : null,
          blocked: isBlockedBySchedule(schedule, t),
          close: nextCloseAt(schedule, t),
          open: nextOpenAt(schedule, t),
        });
      }
    }
  }
  return out;
}

function render(cases: Case[]): string {
  const note = 'Generálja és őrzi: desktop/test/dst-fixture.test.ts (UPDATE_DST_FIXTURE=1 npm test). '
    + 'Europe/Budapest, a 2026-os tavaszi és őszi átállás éjszakája: hajnali sávok előfordulása (occ: most, '
    + 'next: a következő) és a menetrend döntése (blocked, close, open) negyedóránként. A kétszer előforduló '
    + 'falióra-idő az első, a kihagyott az átállás előtti eltolással (a JS szabálya). Olvassa: android/jvm-tests '
    + 'DstFixtureTest, ios/SharedTests DstFixtureTests. Csupa ASCII.';
  const ascii = (s: string) => s.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const rows = cases.map((c) => '  ' + ascii(JSON.stringify(c))).join(',\n');
  return `{\n "note": ${ascii(JSON.stringify(note))},\n "version": 1,\n "tz": "Europe/Budapest",\n "cases": [\n${rows}\n ]\n}\n`;
}

test('az óraátállítás fixtúrája friss, és nem elfajult', () => {
  // Az időzóna tényleg él: a tavaszi éjszakán az eltolás +1 → +2, ősszel +2 → +1.
  assert.equal(new Date(Date.UTC(2026, 2, 29, 0, 30)).getHours(), 1);
  assert.equal(new Date(Date.UTC(2026, 2, 29, 1, 30)).getHours(), 3, 'tavasszal a 2:xx kimarad');
  assert.equal(new Date(Date.UTC(2026, 9, 25, 0, 30)).getHours(), 2);
  assert.equal(new Date(Date.UTC(2026, 9, 25, 1, 30)).getHours(), 2, 'ősszel a 2:xx kétszer van');
  // A szabály, amit a fixtúra rögzít: a kétszer előforduló 2:30 az első (00:30 UTC), a kihagyott 2:30 3:30 lesz.
  assert.equal(new Date(2026, 9, 25, 2, 30).getTime(), Date.UTC(2026, 9, 25, 0, 30));
  assert.equal(new Date(2026, 2, 29, 2, 30).getTime(), Date.UTC(2026, 2, 29, 1, 30));
  const cases = buildCases();
  assert.ok(cases.length > 200);
  assert.ok(cases.some((c) => c.occ) && cases.some((c) => !c.occ), 'van tartó és nem tartó előfordulás');
  assert.ok(cases.some((c) => c.blocked) && cases.some((c) => !c.blocked));
  // Az őszi 2:30-as kezdés az ELSŐ 2:30 (00:30 UTC) — ezt nézi a Kotlin és a Swift is.
  assert.ok(cases.some((c) => c.next && c.next[0] === Date.UTC(2026, 9, 25, 0, 30)), 'az őszi 2:30 az első előfordulás');
  const text = render(cases);
  if (process.env.UPDATE_DST_FIXTURE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, text);
  }
  assert.ok(fs.existsSync(FIXTURE), `nincs fixture: ${FIXTURE} — UPDATE_DST_FIXTURE=1 npm test`);
  const onDisk = fs.readFileSync(FIXTURE, 'utf8');
  assert.equal(onDisk, text,
    'a fixtures/dst-cases.json elavult a gép szabályához képest — UPDATE_DST_FIXTURE=1 npm test, '
      + 'aztán a Kotlin (DstFixtureTest) és a Swift (DstFixtureTests) teszt mutatja meg, hol csúszott el a tükör');
  assert.ok(/^[\x00-\x7f]*$/.test(onDisk), 'a fixtúra nem csupa ASCII');
});
