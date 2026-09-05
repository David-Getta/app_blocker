// „Utolsó feloldás: N napja” — naptári napokban, nem huszonnégy órás
// egységekben: a tegnap esti feloldás tegnap, akkor is, ha tíz órája volt.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { daysSinceUnlock } from '../src/shared/digest';

const at = (y: number, m: number, d: number, hh: number, mm = 0): number =>
  new Date(y, m - 1, d, hh, mm).getTime();

test('üres napló: még nem volt feloldás — null, nem nulla', () => {
  assert.equal(daysSinceUnlock([], at(2026, 9, 7, 10)), null);
});

test('a mai feloldás nulla, a tegnap esti egy — éjfél a határ, nem huszonnégy óra', () => {
  assert.equal(daysSinceUnlock([at(2026, 9, 7, 8)], at(2026, 9, 7, 10)), 0, 'ma');
  assert.equal(daysSinceUnlock([at(2026, 9, 6, 23, 30)], at(2026, 9, 7, 0, 30)), 1, 'egy órája, de tegnap');
  assert.equal(daysSinceUnlock([at(2026, 9, 6, 10)], at(2026, 9, 7, 9)), 1, 'kevesebb mint egy napja, de tegnap');
});

test('a legutóbbi számít, nem a legrégebbi', () => {
  const log = [at(2026, 8, 20, 9), at(2026, 9, 4, 9), at(2026, 8, 30, 9)];
  assert.equal(daysSinceUnlock(log, at(2026, 9, 7, 12)), 3);
});
