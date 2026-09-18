// Heti visszatekintés: hétfő reggel egyszer, az elmúlt 7 napról, a statisztika
// címkézésével — és csak akkor, ha van miről beszélni.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  DIGEST_HOUR, MAX_DIGEST_LOG, cleanDigestLog, digestDue, digestText, hm, recordDigest, relabelDigest, weekKey,
  weekLabel,
  type DigestEntry, type DigestInput,
} from '../src/shared/digest';

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
  focusWeek: { sessions: 9, totalMs: 7 * 3600_000, stoppedEarly: 2, windowRuns: 0, topPack: 'Nyelvtanulás' },
  unlocks7d: 3,
  daysTracked: 12,
};

test('a teljes mondat: idő, a legtöbb (trenddel), menetek, feloldások', () => {
  assert.equal(digestText(full, (l) => l),
    'Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). '
    + '9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás.');
});

test('a heti ablakból indult menetek a mondatban — nulla nem mondat', () => {
  assert.equal(digestText({ ...full, focusWeek: { ...full.focusWeek, windowRuns: 3 } }, (l) => l),
    'Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). '
    + '9 menet (7 ó 0 p, 2 korán leállítva, 3 ablakból). 3 feloldás.');
});

test('a keret betelt napjai a mondatban — nulla nem mondat', () => {
  assert.equal(digestText({ ...full, limitFullDays: 3 }, (l) => l),
    'Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). '
    + '9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás. A napi keret 3 napon betelt.');
  assert.equal(digestText({ ...full, limitFullDays: 0 }, (l) => l), digestText(full, (l) => l));
  assert.equal(digestText({ ...full, burstTripsWeek: 7 }, (l) => l),
    'Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). '
    + '9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás. Az adag a héten 7× telt be.');
});

test('a címkézés a felületé: a rejtett vagy fedőnevű cím nem szivárog ki', () => {
  const text = digestText(full, (l) => (l === 'youtube.com' ? 'A videós' : l));
  assert.ok(text!.includes('a legtöbb: A videós'), text!);
  assert.ok(!text!.includes('youtube.com'), 'a valódi cím sehol');
});

test('feloldás nélkül: ezt ki lehet mondani; a végigvitt menetek is', () => {
  const text = digestText({
    ...full, unlocks7d: 0,
    focusWeek: { sessions: 4, totalMs: 3600_000, stoppedEarly: 0, windowRuns: 0, topPack: null },
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
    focusWeek: { sessions: 0, totalMs: 0, stoppedEarly: 0, windowRuns: 0, topPack: null },
  };
  assert.equal(digestText(nothing, (l) => l), null, 'egy üres értesítés zaj lenne');
});

test('a félbemaradt kísérletek is a mondatban: a feloldások mellett, vagy helyettük', () => {
  assert.equal(digestText({ ...full, dropped7d: 2 }, (l) => l),
    'Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). '
    + '9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás, 2 félbemaradt kísérlet.');
  const none = digestText({ ...full, unlocks7d: 0, dropped7d: 1, weekOverWeek: [] }, (l) => l)!;
  assert.ok(none.endsWith('Feloldás nélkül, 1 félbemaradt kísérlet.'), none);
  // Csak félbemaradt kísérlet: az is történés — mondat, még mérés és menet nélkül is.
  const only: DigestInput = {
    ...full, last7Seconds: 0, topWeekSites: [], weekOverWeek: [], daysTracked: 0, unlocks7d: 0, dropped7d: 3,
    focusWeek: { sessions: 0, totalMs: 0, stoppedEarly: 0, windowRuns: 0, topPack: null },
  };
  assert.equal(digestText(only, (l) => l), 'Elmúlt 7 nap: Feloldás nélkül, 3 félbemaradt kísérlet.');
  assert.equal(digestText({ ...full, dropped7d: 0 }, (l) => l), digestText(full, (l) => l), 'nulla: mint eddig');
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

test('napló: hetenként egy sor, a legfrissebb elöl, fél év a plafon', () => {
  let log: DigestEntry[] = [];
  log = recordDigest(log, '2026-08-31', 'Elmúlt 7 nap: 5 ó 0 p mért idő.');
  log = recordDigest(log, '2026-09-07', 'Elmúlt 7 nap: 7 ó 20 p mért idő.');
  assert.deepEqual(log.map((e) => e.week), ['2026-09-07', '2026-08-31'], 'a legfrissebb elöl');
  // Ugyanaz a hét újra: felülír, nem duplikál.
  log = recordDigest(log, '2026-09-07', 'Elmúlt 7 nap: 8 ó 0 p mért idő.');
  assert.equal(log.length, 2);
  assert.equal(log[0].text, 'Elmúlt 7 nap: 8 ó 0 p mért idő.');
  // Üres hét: nem sor — és a hét régi sorát is elviszi.
  log = recordDigest(log, '2026-09-07', null);
  assert.deepEqual(log.map((e) => e.week), ['2026-08-31']);
  // A plafon: a legrégebbi esik.
  for (let i = 0; i < MAX_DIGEST_LOG + 5; i++) {
    const d = new Date(2027, 0, 4 + 7 * i);
    log = recordDigest(log, weekKey(d.getTime()), `hét ${i}`);
  }
  assert.equal(log.length, MAX_DIGEST_LOG);
  assert.equal(log[0].text, `hét ${MAX_DIGEST_LOG + 4}`, 'a legfrissebb maradt');
  assert.ok(!log.some((e) => e.week === '2026-08-31'), 'a legrégebbi esett ki');
});

test('napló a tárból: ami nem sor, az nem sor; a mondat csonkul, a hét egy', () => {
  const junk = [
    null, 42, 'szöveg', {}, { week: '2026-9-7', text: 'rossz kulcs' }, { week: '2026-09-07', text: '   ' },
    { week: '2026-09-07', text: 'első' }, { week: '2026-09-07', text: 'utolsó' },
    { week: '2026-08-31', text: 'x'.repeat(900) },
  ];
  const log = cleanDigestLog(junk);
  assert.deepEqual(log.map((e) => e.week), ['2026-09-07', '2026-08-31']);
  assert.equal(log[0].text, 'utolsó', 'ugyanarra a hétre az utolsó marad');
  assert.equal(log[1].text.length, 500);
  assert.deepEqual(cleanDigestLog('nem tömb'), []);
  assert.deepEqual(cleanDigestLog(undefined), []);
  assert.equal(weekLabel('2026-09-07'), '2026. 09. 07.');
});

test('a napló sora a mostani címkézéssel: a fedőnév és a rejtés visszamenőleg is fed', () => {
  const text = 'Elmúlt 7 nap: 7 ó mért idő; a legtöbb: youtube.com 2 ó 40 p. Nincs tiltva, de sokat vitt: m.youtube.com 1 ó; youtu.be 5 p; notyoutube.com 3 p; github.com 2 p.';
  const sites = [{ domain: 'youtube.com', hostnames: ['youtube.com', 'm.youtube.com', 'youtu.be'] }, { domain: 'github.com', hostnames: ['github.com'] }];
  const masked = relabelDigest(text, sites, (d) => (d === 'youtube.com' ? 'A videós' : d));
  assert.equal(masked,
    'Elmúlt 7 nap: 7 ó mért idő; a legtöbb: A videós 2 ó 40 p. Nincs tiltva, de sokat vitt: A videós 1 ó; A videós 5 p; notyoutube.com 3 p; github.com 2 p.');
  // Rejtett lista: minden listázott cím a sorszámos álnevét kapja; a nem listázott marad.
  // A „notyoutube.com” nem a youtube.com aloldala — az marad; a listázottak sorszámot kapnak.
  const hidden = relabelDigest(text, sites, (d) => `${sites.findIndex((s) => s.domain === d) + 1}. rejtett oldal`);
  assert.equal(hidden,
    'Elmúlt 7 nap: 7 ó mért idő; a legtöbb: 1. rejtett oldal 2 ó 40 p. Nincs tiltva, de sokat vitt: 1. rejtett oldal 1 ó; 1. rejtett oldal 5 p; notyoutube.com 3 p; 2. rejtett oldal 2 p.');
  // Címke nélkül (nincs fedőnév, nincs rejtés) a sor változatlan.
  assert.equal(relabelDigest(text, sites, (d) => d), text);
});

test('az előző hét a menetek mellett: irány, nem ítélet — üres előző hét nem sor, a menet nélküli hét mondat', () => {
  const prev = { sessions: 5, totalMs: 3 * 3600_000 + 10 * 60_000, stoppedEarly: 1, windowRuns: 0, topPack: null };
  const head = 'Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). ';
  assert.equal(digestText({ ...full, focusPrevWeek: prev }, (l) => l),
    `${head}9 menet (7 ó 0 p, 2 korán leállítva), az előző héten 5 (3 ó 10 p). 3 feloldás.`);
  assert.equal(digestText({ ...full, focusWeek: { sessions: 0, totalMs: 0, stoppedEarly: 0, windowRuns: 0, topPack: null }, focusPrevWeek: prev }, (l) => l),
    `${head}Menet nélkül, az előző héten 5 (3 ó 10 p). 3 feloldás.`);
  assert.equal(digestText({ ...full, focusPrevWeek: { sessions: 0, totalMs: 0, stoppedEarly: 0, windowRuns: 0, topPack: null } }, (l) => l),
    digestText(full, (l) => l), 'üres előző hét: a régi mondat');
});

test('az előző hét feloldásai a szám mellett: irány, nem ítélet — üres előző hét nem sor; feloldás nélkül is mondat, ha volt mihez mérni', () => {
  const head = 'Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). '
    + '9 menet (7 ó 0 p, 2 korán leállítva). ';
  assert.equal(digestText({ ...full, unlocksPrev7d: 5 }, (l) => l), `${head}3 feloldás (az előző héten 5).`);
  assert.equal(digestText({ ...full, unlocksPrev7d: 5, dropped7d: 2 }, (l) => l), `${head}3 feloldás (az előző héten 5), 2 félbemaradt kísérlet.`);
  assert.equal(digestText({ ...full, unlocks7d: 0, unlocksPrev7d: 5 }, (l) => l), `${head}Feloldás nélkül (az előző héten 5).`);
  assert.equal(digestText({ ...full, unlocks7d: 0, unlocksPrev7d: 5, dropped7d: 1 }, (l) => l),
    `${head}Feloldás nélkül (az előző héten 5), 1 félbemaradt kísérlet.`);
  assert.equal(digestText({ ...full, unlocksPrev7d: 0 }, (l) => l), digestText(full, (l) => l), 'üres előző hét: a régi mondat');
  const bare = {
    last7Seconds: 0, topWeekSites: [], weekOverWeek: [], daysTracked: 0,
    focusWeek: { sessions: 0, totalMs: 0, stoppedEarly: 0, windowRuns: 0, topPack: null }, unlocks7d: 0,
  };
  assert.equal(digestText({ ...bare, unlocksPrev7d: 2 }, (l) => l), 'Elmúlt 7 nap: Feloldás nélkül (az előző héten 2).',
    'mérés és menet nélkül is mondat, ha az előző héten volt feloldás');
  assert.equal(digestText(bare, (l) => l), null);
});

test('a csúcs-nap a mondatban: a statisztika sora szó szerint, a megakadások után — nap nélkül nem mondat', () => {
  const head = 'Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). '
    + '9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás.';
  assert.equal(digestText({ ...full, browserHitsWeekday: { day: 0, count: 14 } }, (l) => l),
    `${head} A négy hét csúcs-napja: vasárnap (14 megakadás).`);
  assert.equal(digestText({ ...full, browserHits7d: 12, browserHitsWeekday: { day: 3, count: 9 } }, (l) => l),
    `${head} 12 megakadás a böngészőben. A négy hét csúcs-napja: szerda (9 megakadás).`, 'a megakadások mondata után');
  assert.equal(digestText({ ...full, browserHitsWeekday: null }, (l) => l), digestText(full, (l) => l), 'nap nélkül a régi mondat');
});

test('a menet-nap a mondatban: a statisztika sora szó szerint, a menetek után — nap nélkül nem mondat', () => {
  const head = 'Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). '
    + '9 menet (7 ó 0 p, 2 korán leállítva).';
  assert.equal(digestText({ ...full, focusWeekday: { day: 2, count: 6 } }, (l) => l),
    `${head} A négy hét menet-napja: kedd (6 menet). 3 feloldás.`);
  assert.equal(digestText({ ...full, focusWeekday: null }, (l) => l), digestText(full, (l) => l), 'nap nélkül a régi mondat');
});

test('a mért idő napja a mondatban: a statisztika sora szó szerint, a mért idő után — mérés és nap nélkül nem mondat', () => {
  assert.equal(digestText({ ...full, usageWeekday: { day: 6, count: 12000 } }, (l) => l),
    'Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). '
    + 'A négy hét legnagyobb napja: szombat (átlag 50 p). 9 menet (7 ó 0 p, 2 korán leállítva). 3 feloldás.');
  assert.equal(digestText({ ...full, usageWeekday: null }, (l) => l), digestText(full, (l) => l), 'nap nélkül a régi mondat');
  assert.equal(digestText({ ...full, last7Seconds: 0, usageWeekday: { day: 6, count: 12000 } }, (l) => l),
    digestText({ ...full, last7Seconds: 0 }, (l) => l), 'mérés nélkül a nap sem mondat');
});

test('a menet-sorozat a mondatban: a menetek mondata után, kettőtől — egy nap nem mondat', () => {
  const head = 'Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). '
    + '9 menet (7 ó 0 p, 2 korán leállítva).';
  assert.equal(digestText({ ...full, focusStreak: 5 }, (l) => l), `${head} 5 napja minden nap leültél. 3 feloldás.`);
  assert.equal(digestText({ ...full, focusStreak: 1 }, (l) => l), digestText(full, (l) => l), 'egy nap nem sorozat');
  assert.equal(digestText({ ...full, focusStreak: 5, focusWeekday: { day: 2, count: 6 } }, (l) => l),
    `${head} 5 napja minden nap leültél. A négy hét menet-napja: kedd (6 menet). 3 feloldás.`, 'a menet-nap előtt');
});

test('a menet-óra a mondatban: a statisztika sora szó szerint, a menet-nap után — óra nélkül nem mondat', () => {
  const head = 'Elmúlt 7 nap: 7 ó 20 p mért idő; a legtöbb: youtube.com 2 ó 40 p (▼ -33% az előző héthez képest). '
    + '9 menet (7 ó 0 p, 2 korán leállítva).';
  assert.equal(digestText({ ...full, focusWeekday: { day: 2, count: 6 }, focusHour: { hour: 9, count: 6 } }, (l) => l),
    `${head} A négy hét menet-napja: kedd (6 menet). A négy hét menet-órája: 9–10 óra (6 menet). 3 feloldás.`);
  assert.equal(digestText({ ...full, focusHour: null }, (l) => l), digestText(full, (l) => l), 'óra nélkül a régi mondat');
  // A FEDÉS a szám mellett: a csomag, amelynek ablaka fedi — vagy „nincs rá ablak”, ha lehetne. A fedés erősebb.
  assert.equal(digestText({ ...full, focusHour: { hour: 9, count: 6 }, focusHourPack: 'Nyelvtanulás', focusHourWindowOffer: true }, (l) => l),
    `${head} A négy hét menet-órája: 9–10 óra (6 menet, magától indul: Nyelvtanulás). 3 feloldás.`);
  assert.equal(digestText({ ...full, focusHour: { hour: 9, count: 6 }, focusHourWindowOffer: true }, (l) => l),
    `${head} A négy hét menet-órája: 9–10 óra (6 menet, nincs rá ablak). 3 feloldás.`);
  // AMIKOR A CSÚCS-ÓRA A MENET-ÓRA: a mondat kimondja, a menet-óra után; más órán nem.
  assert.equal(digestText({ ...full, focusHour: { hour: 21, count: 6 }, browserHits7d: 12, browserHitsPeak: { hour: 21, count: 6 } }, (l) => l),
    `${head} A négy hét menet-órája: 21–22 óra (6 menet). A csúcs-óra és a menet-óra ugyanaz: 21–22 óra — a kéz akkor jár, amikor le szoktál ülni. `
    + '3 feloldás. 12 megakadás a böngészőben, a csúcs 21–22 óra.');
  assert.equal(digestText({ ...full, focusHour: { hour: 9, count: 6 }, browserHits7d: 12, browserHitsPeak: { hour: 21, count: 6 } }, (l) => l),
    `${head} A négy hét menet-órája: 9–10 óra (6 menet). 3 feloldás. 12 megakadás a böngészőben, a csúcs 21–22 óra.`);
});
