import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { DeliveryHealth, DELIVERY_FAIL_THRESHOLD } from '../src/shared/delivery-health';

/**
 * A mérés második csendes elhasalása.
 *
 * A szonda-figyelmeztetés azt fogja meg, ha az előtér-szonda nem lát semmit.
 * Ez az ellenkezője: a szonda LÁT, a minta elkészül, a segéd átveszi a
 * kérést — és egyetlen sort sem rögzít belőle. A válasz sikeres, tehát a
 * puffer kiürül, és a mért idő VÉGLEG elveszik. A képernyőn ugyanaz a nulla
 * áll, mint a szonda hibájánál, a teendő viszont más — ezért két külön jelzés.
 */

const drop = { delivered: true, recorded: 0, sent: 4 };
const good = { delivered: true, recorded: 4, sent: 4 };
const down = { delivered: false, recorded: 0, sent: 4 };

test('egy eldobott köteg még nem riaszt', () => {
  const h = new DeliveryHealth();
  h.record(drop);
  assert.equal(h.dropping, false);
});

test('sorozatban eldobott kötegek után szól', () => {
  const h = new DeliveryHealth();
  for (let i = 0; i < DELIVERY_FAIL_THRESHOLD; i += 1) h.record(drop);
  assert.equal(h.dropping, true);
});

test('egyetlen sikeres rögzítés törli a sorozatot', () => {
  const h = new DeliveryHealth();
  for (let i = 0; i < DELIVERY_FAIL_THRESHOLD; i += 1) h.record(drop);
  h.record(good);
  assert.equal(h.dropping, false);
});

test('az elérhetetlen segéd NEM adatvesztés', () => {
  // Ilyenkor a puffer megtartja a mintákat, és a következő kör újrapróbálja.
  // Ha ezt is eldobásnak vennénk, a mérés minden zökkenőre azt állítaná, hogy
  // elveszett az idő — pedig nem veszett el.
  const h = new DeliveryHealth();
  for (let i = 0; i < DELIVERY_FAIL_THRESHOLD * 2; i += 1) h.record(down);
  assert.equal(h.dropping, false);
  assert.equal(h.stuck, true);
});

test('az ÜRES köteg nem számít eldobásnak', () => {
  // Nulla mintából nulla rögzített sor a helyes eredmény, nem hiba. Enélkül
  // egy tétlen gép pár perc után hamis riasztást adna.
  const h = new DeliveryHealth();
  for (let i = 0; i < DELIVERY_FAIL_THRESHOLD; i += 1) {
    h.record({ delivered: true, recorded: 0, sent: 0 });
  }
  assert.equal(h.dropping, false);
});

test('a segéd visszatérése törli az elérhetetlenség sorozatát', () => {
  const h = new DeliveryHealth();
  h.record(down);
  h.record(down);
  assert.equal(h.stuck, false);
  h.record(good);
  assert.equal(h.stuck, false);
});
