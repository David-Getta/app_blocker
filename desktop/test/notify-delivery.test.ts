// Ha a rendszer nem jelenít meg egy értesítést, azt nem nyeljük el
// (shared/notify-delivery.ts): a beállítások lapja kimondja, csendben.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { notifyFailText, notifyTestText, parseFailedAt } from '../src/shared/notify-delivery';

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

test('a próba-gomb nem állítja, hogy az értesítés megjelent — azt csak a felhasználó látja', () => {
  // A `show` annyi, hogy a rendszer átvette: kikapcsolt értesítésnél és
  // fókusz-módban is jöhet, a mostani Electron macOS-en hibát sosem ad.
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const outcome of ['sent', 'accepted', 'failed', 'off'] as const) {
      const text = notifyTestText(platform, outcome);
      assert.ok(text.trim() !== '', `${platform}/${outcome}: néma`);
      assert.doesNotMatch(text, /megjelent|kézbesít/i, `${platform}/${outcome}: többet állít, mint amit az app tud: ${text}`);
    }
  }
  // Átvételkor megmondja, hol keresse, ha mégsem látta.
  assert.ok(notifyTestText('darwin', 'accepted').includes('Rendszerbeállítások › Értesítések › Breaker'));
  assert.ok(notifyTestText('win32', 'accepted').includes('Gépház › Rendszer › Értesítések › Breaker'));
  assert.ok(notifyTestText('darwin', 'accepted').includes('fókusz-mód'));
});
