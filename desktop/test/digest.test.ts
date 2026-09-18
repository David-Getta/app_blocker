// Heti visszatekintés: hétfő reggel egyszer, az elmúlt 7 napról, a statisztika
// címkézésével — és csak akkor, ha van miről beszélni.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { DIGEST_HOUR, digestDue, digestText, hm, weekKey, type DigestInput } from '../src/shared/digest';

const at = (y: number, m: number, d: number, hh: number, mm = 0): number =>
  new Date(y, m - 1, d, hh, mm).getTime();

// 2026. szeptember 7. hétfő.
const MON = '2026-09-07';

test('weekKey: a hét kulcsa a hétfő dátuma — vasárnap még az előző hété', () => {
  assert.equal(weekKey(at(2026, 9, 7, 0)), MON, 'hétfő hajnal');
  assert.equal(weekKey(at(2026, 9, 10, 15)), MON, 'csütörtök');
  assert.equal(weekKey(at(2026, 9, 13, 23, 59)), MON, 'vasárnap este');
  assert.equal(weekKey(at(2026, 9, 6, 12)), '2026-08-31', 'vasárnap: az előző hét');
  assert.equal(weekKey(at(2026, 9, 14, 0)), '2026-09-14', 'a következő hétfő');
});

test('digestDue: hétfő reggeltől esedékes, egy héten egyszer', () => {
  assert.equal(digestDue(null, at(2026, 9, 7, DIGEST_HOUR - 1, 59)), null, 'hétfő 6:59: még nem');
  assert.equal(digestDue(null, at(2026, 9, 7, DIGEST_HOUR)), MON, 'hétfő 7:00: igen');
  assert.equal(digestDue('2026-08-31', at(2026, 9, 9, 10)), MON, 'szerdán is, ha hétfőn nem futott az app');
  assert.equal(digestDue(MON, at(2026, 9, 9, 10)), null, 'ezen a héten már volt');
  assert.equal(digestDue(MON, at(2026, 9, 14, 8)), '2026-09-14', 'a következő hétfőn újra');
  assert.equal(digestDue(MON, at(2026, 9, 14, 3)), null, 'de csak reggel héttől');
});

test('hm: órák és percek, mint a csempéken', () => {
  assert.equal(hm(58 * 60), '58 p');
  assert.equal(hm(3600 + 28 * 60), '1 ó 28 p');
  assert.equal(hm(7 * 3600 + 20 * 60), '7 ó 20 p');
  assert.equal(hm(0), '0 p');
});

const full: DigestInput = {
  last7Seconds: 7 * 3600 + 20 * 60,
  topWeekSites: [{ label: 'youtube.com', seconds: 2 * 3600 + 40 * 60, blocked: true }],
  weekOverWeek: [{ label: 'youtube.com', thisWeek: 9600, deltaPct: -33 }],
  focusWeek: { sessions: 9, totalMs: 7 * 3600_000, stoppedEarly: 2, topPack: 'Nyelvtanulás' },
  unlocks7d: 3,
  daysTracked: 12,
};

test('a teljes mondat: idő, a legtöbb (trenddel), menetek, feloldások', () => {
  assert.equal(digestText(full, (l) => l),
    'Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). '
    + '9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás.');
});

test('a címkézés a felületé: a rejtett vagy fedőnevű cím nem szivárog ki', () => {
  const text = digestText(full, (l) => (l === 'youtube.com' ? 'A videós' : l));
  assert.ok(text!.includes('a legtöbb: A videós'), text!);
  assert.ok(!text!.includes('youtube.com'), 'a valódi cím sehol');
});

test('feloldás nélkül: ezt ki lehet mondani; a végigvitt menetek is', () => {
  const text = digestText({
    ...full, unlocks7d: 0,
    focusWeek: { sessions: 4, totalMs: 3600_000, stoppedEarly: 0, topPack: null },
    weekOverWeek: [{ label: 'youtube.com', thisWeek: 9600, deltaPct: 3 }],
  }, (l) => l);
  assert.equal(text,
    'Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p. 4 menet (1 ó 0 p, mind végigvive). Feloldás nélkül.');
});

test('mérés nélkül a menetek és a feloldások még mondat; semmi nélkül null', () => {
  const noUsage: DigestInput = {
    ...full, last7Seconds: 0, topWeekSites: [], weekOverWeek: [], daysTracked: 0,
  };
  assert.equal(digestText(noUsage, (l) => l), 'Elmúlt 7 nap: 9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás.');
  const nothing: DigestInput = {
    ...noUsage, unlocks7d: 0,
    focusWeek: { sessions: 0, totalMs: 0, stoppedEarly: 0, topPack: null },
  };
  assert.equal(digestText(nothing, (l) => l), null, 'egy üres értesítés zaj lenne');
});

test('az app is bekerül: a mért időben benne van, a mondat enélkül hazudna', () => {
  const withApp = {
    ...full,
    topWeekApps: [{ label: 'Slack', seconds: 3 * 3600 + 10 * 60 }, { label: 'Terminal', seconds: 3600 }],
    weekOverWeek: [...full.weekOverWeek, { label: 'Slack', thisWeek: 11400, deltaPct: 41.6 }],
  };
  assert.equal(digestText(withApp, (l) => l),
    'Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest); '
    + 'appban a legtöbb: Slack 3 ó 10 p (▲ +42% az előző héthez képest). '
    + '9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás.');
  // Oldal nélkül is: a telefonon lehet, hogy csak app van.
  const onlyApp = { ...withApp, topWeekSites: [] };
  assert.ok(digestText(onlyApp, (l) => l)!.startsWith('Elmúlt 7 nap: 7 ó 20 p mért idő; appban a legtöbb: Slack 3 ó 10 p'));
  assert.equal(digestText({ ...full, topWeekApps: [] }, (l) => l), digestText(full, (l) => l), 'üres lista: mint eddig');
});

test('a nem tiltott, sokat vitt oldal is bekerül — a legnagyobb, a felület címkéjével', () => {
  const withOpen = { ...full, unblockedTop: [{ label: 'news.ycombinator.com', seconds: 2 * 3600 + 120 }, { label: 'github.com', seconds: 1800 }] };
  const text = digestText(withOpen, (l) => l)!;
  assert.ok(text.endsWith('Nincs tiltva, de sokat vitt: news.ycombinator.com 2 ó 2 p.'), text);
  assert.ok(!text.includes('github.com'), 'csak a legnagyobb — a többi a kártyán vár');
  assert.equal(digestText({ ...full, unblockedTop: [] }, (l) => l), digestText(full, (l) => l), 'üres lista: mint eddig');
  // Mérés nélkül nincs miről beszélni — az üres hétre a javaslat sem ül rá.
  const nothing = { ...full, last7Seconds: 0, daysTracked: 0, unblockedTop: [{ label: 'x.com', seconds: 9000 }] };
  assert.ok(!(digestText(nothing, (l) => l) ?? '').includes('x.com'));
});
