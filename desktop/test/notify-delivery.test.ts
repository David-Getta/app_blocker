// Ha a rendszer nem jelenít meg egy értesítést, azt nem nyeljük el
// (shared/notify-delivery.ts): a beállítások lapja kimondja, csendben.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { notifyFailText, parseFailedAt } from '../src/shared/notify-delivery';

test('a mondat megmondja, mi maradt el, és hol kapcsolható be — platformonként', () => {
  const mac = notifyFailText('darwin', '09:30');
  assert.ok(mac.includes('(09:30)') && mac.includes('Rendszerbeállítások › Értesítések › Breaker'), mac);
  assert.ok(mac.includes('szünet vége'), 'kimondja, mit nem fog hallani');
  const win = notifyFailText('win32', '09:30');
  assert.ok(win.includes('Gépház › Rendszer › Értesítések › Breaker'), win);
  assert.ok(notifyFailText('linux', '09:30').includes('a rendszer értesítési beállításaiban'));
});

test('a tárolt időpont: csak véges, pozitív szám számít hibának', () => {
  assert.equal(parseFailedAt(null), null);
  assert.equal(parseFailedAt(''), null);
  assert.equal(parseFailedAt('abc'), null);
  assert.equal(parseFailedAt('-5'), null);
  assert.equal(parseFailedAt('Infinity'), null);
  assert.equal(parseFailedAt('1791400000000'), 1791400000000);
});

test('a rendererben MINDEN értesítés a közös úton megy — egy sem kerülheti meg a hibafigyelést', () => {
  // A lefordított teszt a dist-test/test alatt fut — a forrás két szinttel feljebb.
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'renderer.ts'), 'utf8');
  const raw = src.split('new Notification(').length - 1;
  assert.equal(raw, 1, 'csak a notify() hozhat létre értesítést, különben a meg nem jelenése némán elveszne');
  assert.match(src, /n\.addEventListener\('error', \(\) => noteNotifyDelivery\(Date\.now\(\)\)\);/);
  assert.match(src, /n\.addEventListener\('show', \(\) => noteNotifyDelivery\(null\)\);/);
});
