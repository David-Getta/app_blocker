// Fókuszban töltött idő naponta — a hét alakja a menetekre.
//
// A csempe egy számban mondja a hetet; a sávok azt, egyenletesen jött-e
// össze, vagy egy napból. Egy menet a VÉGÉNEK napjára számít egészben, és a
// nap fogalma a mérésével közös (helyi naptár).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { focusDaySeries, type FocusLogEntry } from '../src/shared/focus';
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
