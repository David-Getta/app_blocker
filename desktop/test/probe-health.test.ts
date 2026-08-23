import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ProbeHealth, PROBE_FAIL_THRESHOLD } from '../src/shared/probe-health';

test('a fresh tracker is not accused of being blocked', () => {
  const h = new ProbeHealth();
  assert.equal(h.blocked, false);
  assert.equal(h.neverWorked, true, 'it has genuinely not seen anything yet');
});

test('the first few empty probes are normal, not a failure', () => {
  // macOS-en az ELSŐ lekérdezés hozza fel az engedélykérő ablakot, és amíg a
  // felhasználó nem válaszol, a szonda üresen tér vissza. Ha ilyenkor azonnal
  // hibát kiáltanánk, mindenki a saját engedélykérése miatt kapna riasztást.
  const h = new ProbeHealth();
  for (let i = 0; i < PROBE_FAIL_THRESHOLD - 1; i++) {
    h.record(false);
    assert.equal(h.blocked, false, `${i + 1}. üres minta még nem jelent bajt`);
  }
  h.record(false);
  assert.equal(h.blocked, true, 'a sorozat viszont igen');
});

test('one good probe clears the alarm immediately', () => {
  // Ez az engedély megadásának pillanata: a figyelmeztetés ne ragadjon be.
  const h = new ProbeHealth();
  for (let i = 0; i < PROBE_FAIL_THRESHOLD + 5; i++) h.record(false);
  assert.equal(h.blocked, true);
  h.record(true);
  assert.equal(h.blocked, false);
  assert.equal(h.neverWorked, false);
});

test('a long outage does not need a matching run of successes to recover', () => {
  // A számláló a küszöbnél megáll, tehát nem gyűlik korlátlanul: egy órányi
  // hiba után is EGY jó minta old fel, nem ezer.
  const h = new ProbeHealth();
  for (let i = 0; i < 10_000; i++) h.record(false);
  h.record(true);
  assert.equal(h.blocked, false);
});

test('failures after a success can raise the alarm again', () => {
  // A jogosultság elvehető futás közben is (a felhasználó visszavonja).
  const h = new ProbeHealth();
  h.record(true);
  assert.equal(h.neverWorked, false);
  for (let i = 0; i < PROBE_FAIL_THRESHOLD; i++) h.record(false);
  assert.equal(h.blocked, true);
  assert.equal(h.neverWorked, false, 'egyszer már működött, ezt nem felejtjük el');
});
