// Fókuszban töltött idő naponta — a hét alakja a menetekre.
//
// A csempe egy számban mondja a hetet; a sávok azt, egyenletesen jött-e
// össze, vagy egy napból. Egy menet a VÉGÉNEK napjára számít egészben, és a
// nap fogalma a mérésével közös (helyi naptár).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  focusByHour, focusByWeekday, focusDayNowText, focusDaySeries, focusDayStreak, focusLongestStreak, focusHourNowText, focusHourText, focusHourWarnText, focusStreakText, focusWeekdayText, isFocusHourNow, peakFocusHour, sameDayText, sameHourText,
  type FocusLogEntry,
} from '../src/shared/focus';
import { peakWeekday } from '../src/shared/browser-hits';
import { dayKey } from '../src/shared/usage';

const DAY = 86_400_000;
const HOUR = 3_600_000;

function entry(startedAt: number, endedAt: number): FocusLogEntry {
  return { packId: 'p1', packName: 'Nyelvtanulás', startedAt, endedAt, plannedEndsAt: endedAt, stopped: false };
}

test('naponta: a menet a végének napjára számít, a hét a legrégebbitől a maiig', () => {
  const now = new Date(2026, 8, 5, 20, 0).getTime(); // helyi idő, este nyolc
  const log = [
    entry(now - 3 * HOUR, now - 2 * HOUR),                   // ma, 1 óra
    entry(now - DAY - HOUR, now - DAY),                       // tegnap, 1 óra
    entry(now - DAY - 30 * 60_000, now - DAY + 10 * 60_000), // tegnap, 40 perc
    entry(now - 10 * DAY, now - 10 * DAY + HOUR),             // tíz napja: kiesik
    entry(now + HOUR, now + 2 * HOUR),                        // a jövő: kiesik
  ];
  const s = focusDaySeries(log, now, 7);
  assert.equal(s.length, 7);
  assert.equal(s[6].day, dayKey(now), 'az utolsó oszlop a mai nap');
  assert.equal(s[6].seconds, 3600);
  assert.equal(s[5].seconds, 3600 + 2400, 'tegnap: egy óra és negyven perc');
  assert.deepEqual(s.slice(0, 5).map((d) => d.seconds), [0, 0, 0, 0, 0]);
});

test('az éjfélen átnyúló menet a végének napjára számít egészben', () => {
  const now = new Date(2026, 8, 5, 20, 0).getTime();
  const midnight = new Date(2026, 8, 5, 0, 0).getTime();
  const s = focusDaySeries([entry(midnight - 30 * 60_000, midnight + 30 * 60_000)], now, 7);
  assert.equal(s[6].seconds, 3600, 'a mai napon egy óra');
  assert.equal(s[5].seconds, 0, 'tegnap semmi');
});

test('üres vagy hiányzó napló: hét nulla, a napok akkor is megvannak', () => {
  const now = new Date(2026, 8, 5, 20, 0).getTime();
  assert.deepEqual(focusDaySeries(undefined, now, 7).map((d) => d.seconds), [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(focusDaySeries([], now, 3).length, 3);
});

test('a menet-nap: négy hétből, a hét napjaira osztva — a menet a végének napjára számít, a huszonnyolc napos és a jövő nem', () => {
  const now = new Date(2026, 8, 18, 20, 0).getTime(); // péntek, este nyolc
  const log = [
    entry(now - 3 * HOUR, now - 2 * HOUR),          // ma
    entry(now - 5 * HOUR, now - 4 * HOUR),          // ma
    entry(now - 7 * DAY - HOUR, now - 7 * DAY),     // egy hete: péntek
    entry(now - DAY - HOUR, now - DAY),             // tegnap: csütörtök
    entry(now - 28 * DAY - HOUR, now - 28 * DAY),   // huszonnyolc napja: kiesik
    entry(now + HOUR, now + 2 * HOUR),              // a jövő: kiesik
  ];
  const by = focusByWeekday(log, now);
  assert.equal(by.length, 7);
  assert.equal(by[5], 3, 'péntek: ma kettő és egy hete egy');
  assert.equal(by[4], 1, 'csütörtök: tegnap');
  assert.equal(by.reduce((a, b) => a + b, 0), 4, 'a huszonnyolc napos és a jövő nem számít');
  assert.deepEqual(peakWeekday(by), { day: 5, count: 3 }, 'a holtverseny és a csúcs szabálya a csúcs-napéval közös');
  assert.equal(focusWeekdayText({ day: 2, count: 6 }), 'A négy hét menet-napja: kedd (6 menet).');
  assert.deepEqual(focusByWeekday(undefined, now), [0, 0, 0, 0, 0, 0, 0]);
});

test('a menet-nap a döntés napján: ma van-e, és csak elég mintából — a kártya és a láb mondata', () => {
  // 2026-09-22 kedd, 2026-09-23 szerda (helyi idő).
  const tuesday = new Date(2026, 8, 22, 15, 0).getTime();
  const wednesday = new Date(2026, 8, 23, 15, 0).getTime();
  assert.equal(focusDayNowText({ day: 2, count: 6 }, tuesday),
    ' Ma a négy hét menet-napja van (kedd, 6 menet) — ilyenkor szoktál leülni.');
  assert.equal(focusDayNowText({ day: 2, count: 6 }, wednesday), '', 'más napon nem');
  assert.equal(focusDayNowText({ day: 2, count: 2 }, tuesday), '', 'kevés minta: nem mondat');
  assert.equal(focusDayNowText(null, tuesday), '');
});

test('a menet-óra: négy hétből, az indulás órája szerint — a huszonnyolc napos és a jövő nem; holtversenynél a korábbi óra', () => {
  const now = new Date(2026, 8, 18, 20, 0).getTime(); // péntek, este nyolc
  const log = [
    entry(now - 3 * HOUR, now - 2 * HOUR),          // ma, 17-kor indult
    entry(now - 5 * HOUR, now - 4 * HOUR),          // ma, 15-kor
    entry(now - 7 * DAY - HOUR, now - 7 * DAY),     // egy hete, 19-kor
    entry(now - DAY - HOUR, now - DAY),             // tegnap, 19-kor
    entry(now - 28 * DAY - HOUR, now - 28 * DAY),   // huszonnyolc napja: kiesik
    entry(now + HOUR, now + 2 * HOUR),              // a jövő: kiesik
  ];
  const by = focusByHour(log, now);
  assert.equal(by.length, 24);
  assert.equal(by[19], 2, 'tizenkilenckor kettő');
  assert.equal(by[17], 1);
  assert.equal(by[15], 1);
  assert.equal(by.reduce((a, b) => a + b, 0), 4, 'a huszonnyolc napos és a jövő nem számít');
  assert.deepEqual(peakFocusHour(by), { hour: 19, count: 2 });
  assert.deepEqual(peakFocusHour([0, 2, 0, 2]), { hour: 1, count: 2 }, 'holtverseny: a korábbi óra');
  assert.equal(peakFocusHour(new Array<number>(24).fill(0)), null);
  assert.equal(focusHourText({ hour: 9, count: 6 }), 'A négy hét menet-órája: 9–10 óra (6 menet).');
  assert.equal(focusHourText({ hour: 9, count: 6 }, { pack: 'Nyelvtanulás', offer: true }),
    'A négy hét menet-órája: 9–10 óra (6 menet, magától indul: Nyelvtanulás).', 'a fedés erősebb');
  assert.equal(focusHourText({ hour: 9, count: 6 }, { offer: true }), 'A négy hét menet-órája: 9–10 óra (6 menet, nincs rá ablak).');
  // AMIKOR A CSÚCS-ÓRA A MENET-ÓRA: a két fél egy pontra mutat — különben üres.
  assert.equal(sameHourText({ hour: 21, count: 6 }, { hour: 21, count: 3 }),
    'A csúcs-óra és a menet-óra ugyanaz: 21–22 óra — a kéz akkor jár, amikor le szoktál ülni.');
  assert.equal(sameHourText({ hour: 21, count: 6 }, { hour: 9, count: 3 }), '', 'más óra: üres');
  assert.equal(sameHourText(null, { hour: 9, count: 3 }), '');
  assert.equal(sameHourText({ hour: 9, count: 6 }, null), '');
  assert.deepEqual(focusByHour(undefined, now), new Array<number>(24).fill(0));
});

test('a menet-óra a döntés órájában: most van-e, és csak elég mintából — a kártya és a láb mondata', () => {
  const at9 = new Date(2026, 8, 22, 9, 30).getTime();
  const at10 = new Date(2026, 8, 22, 10, 0).getTime();
  assert.equal(isFocusHourNow({ hour: 9, count: 6 }, at9), true);
  assert.equal(isFocusHourNow({ hour: 9, count: 6 }, at10), false, 'más órában nem');
  assert.equal(isFocusHourNow({ hour: 9, count: 2 }, at9), false, 'kevés minta: nem mondat');
  assert.equal(isFocusHourNow(null, at9), false);
  assert.equal(focusHourNowText({ hour: 9, count: 6 }, at9),
    ' Most a menet-órád van (9–10 óra, 6 menet) — ilyenkor szoktál elkezdeni.');
  assert.equal(focusHourNowText({ hour: 9, count: 6 }, at10), '', 'a menet-órán kívül a láb nem mondja');
  assert.equal(focusHourNowText(null, at9), '');
});

test('az előjelzés mondata a menet-óra előtt — a csúcs-óra előjelzésének tükre', () => {
  assert.equal(focusHourWarnText({ hour: 9, count: 6 }),
    'Mindjárt 9 óra — ilyenkor szoktál elkezdeni (6 menet négy hét alatt). Egy munkamenet most segítene — te döntesz.');
});

test('a menet-sorozat: hány napja ülsz le minden nap — ma vagy tegnap végződő, megszakítás nélküli napok; egy nap nem sorozat', () => {
  const now = new Date(2026, 8, 22, 15, 0).getTime();
  const DAY = 86_400_000;
  const run = (endedAt: number) => ({
    packId: 'p', packName: 'Nyelvtanulás', startedAt: endedAt - 3600_000, endedAt, plannedEndsAt: endedAt, stopped: false,
  });
  assert.equal(focusDayStreak([run(now - 3600_000), run(now - DAY), run(now - 2 * DAY)], now), 3, 'ma, tegnap, tegnapelőtt');
  assert.equal(focusDayStreak([run(now - DAY), run(now - 2 * DAY)], now), 2, 'ma még nem: a tegnap végződő sorozat');
  assert.equal(focusDayStreak([run(now - 3600_000), run(now - 2 * DAY)], now), 1, 'a lyuk megszakítja');
  assert.equal(focusDayStreak([run(now - 2 * DAY)], now), 0, 'se ma, se tegnap: nulla');
  assert.equal(focusDayStreak([run(now + 3600_000)], now), 0, 'a jövő nem számít');
  assert.equal(focusDayStreak([], now), 0);
  assert.equal(focusDayStreak(undefined, now), 0);
  assert.equal(focusStreakText(5), '5 napja minden nap leültél.');
  assert.equal(focusStreakText(1), '', 'egy nap nem sorozat');
  assert.equal(focusStreakText(0), '');
  // A LEGHOSSZABB SOROZAT: a napló rekordja — a mostani mércéje; a mondat csak akkor mondja, ha több.
  assert.equal(focusLongestStreak([run(now - 3600_000), run(now - DAY), run(now - 8 * DAY), run(now - 9 * DAY), run(now - 10 * DAY)], now), 3,
    'a régi hármas hosszabb a mostani kettesnél');
  assert.equal(focusLongestStreak([run(now - 3600_000), run(now - 3600_000 - 60_000)], now), 1, 'egy napon két menet egy nap');
  assert.equal(focusLongestStreak([], now), 0);
  // A FORDULÓ: a hónap és az év vége sem szakítja meg — a tegnap a naptáré, nem a számé.
  const sept1 = new Date(2026, 8, 1, 20, 0).getTime();
  assert.equal(focusLongestStreak([run(sept1), run(sept1 - DAY), run(sept1 - 2 * DAY)], sept1), 3, 'aug. 30–szept. 1: hónapforduló');
  assert.equal(focusDayStreak([run(sept1), run(sept1 - DAY), run(sept1 - 2 * DAY)], sept1), 3, 'a mostani sorozat is átlép a hónapfordulón');
  const jan1 = new Date(2027, 0, 1, 20, 0).getTime();
  assert.equal(focusLongestStreak([run(jan1), run(jan1 - DAY), run(jan1 - 2 * DAY)], jan1), 3, 'dec. 30–jan. 1: évforduló');
  assert.equal(focusDayStreak([run(jan1 - DAY), run(jan1 - 2 * DAY)], jan1), 2, 'a tegnap végződő sorozat az évfordulón is');
  assert.equal(focusStreakText(2, 3), '2 napja minden nap leültél (a leghosszabb sorozatod: 3 nap).');
  assert.equal(focusStreakText(3, 3), '3 napja minden nap leültél.', 'ha a mostani a rekord, nincs zárójel');
  assert.equal(focusStreakText(0, 4), 'A leghosszabb sorozatod: 4 nap.', 'mostani nélkül csak a rekord');
  assert.equal(focusStreakText(0, 1), '', 'egy nap rekordnak sem sorozat');
});

test('amikor a csúcs-nap a menet-nap: a két nap egy pontra mutat — a mondat; más napon üres', () => {
  assert.equal(sameDayText({ day: 2, count: 14 }, { day: 2, count: 6 }), 'A csúcs-nap és a menet-nap ugyanaz: kedd — a kéz azon a napon csúszik, amelyiken le szoktál ülni.');
  assert.equal(sameDayText({ day: 0, count: 14 }, { day: 2, count: 6 }), '', 'más nap: üres');
  assert.equal(sameDayText(null, { day: 2, count: 6 }), '');
  assert.equal(sameDayText({ day: 2, count: 14 }, null), '');
});
