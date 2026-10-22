// Ha a rendszer nem jelenít meg egy értesítést, azt nem nyeljük el
// (shared/notify-delivery.ts): a beállítások lapja kimondja, csendben.

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  NOTIFY_BODY_MAX, NOTIFY_TITLE_MAX, NotifyMemory, notifyFailText, notifyTestText, parseFailedAt,
  parseNotifyEvent, parseNotifyRequest,
} from '../src/shared/notify-delivery';

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

test('a rendererben MINDEN értesítés a fő folyamaton át megy — egy sem kerülheti meg a hibafigyelést', () => {
  // A lefordított teszt a dist-test/test alatt fut — a forrás két szinttel feljebb.
  const root = join(__dirname, '..', '..', 'src');
  const src = readFileSync(join(root, 'renderer', 'renderer.ts'), 'utf8');
  // A böngészős értesítés hibáját az Electron nem adja tovább a lapnak: egy
  // ilyen út mellett a visszautasítás némán elveszne.
  assert.equal(src.split('new Notification(').length - 1, 0, 'a felület nem hozhat létre böngészős értesítést');
  assert.match(src, /const send = window\.breaker\?\.notify;/);
  assert.match(src, /window\.breaker\.onNotifyEvent\?\.\(onNotifyEvent\);/);
  assert.match(src, /ev\.kind === 'failed'\) \{\n\s+noteNotifyDelivery\(Date\.now\(\)\);/);
  assert.match(src, /ev\.kind === 'shown'\) \{\n\s+noteNotifyDelivery\(null\);/);
  // A fő folyamat a `failed` eseményt hallgatja, és visszaküldi.
  const main = readFileSync(join(root, 'main', 'notify.ts'), 'utf8');
  assert.match(main, /ipcMain\.handle\('breaker:notify', /);
  assert.match(main, /n\.on\('failed', /);
  assert.match(main, /n\.on\('show', \(\) => \{\n\s+on\.shown\?\.\(\);\n\s+tell\('shown'\);/);
  assert.match(main, /report\.send\('breaker:notify-event', /);
  assert.match(main, /\n  n\.show\(\);\n/);
  // A fő folyamat saját értesítése (a háttérben futás jelzése) is ezen az úton
  // megy: máshol nem születhet értesítés, különben a sorsa nem jutna vissza.
  for (const f of readdirSync(join(root, 'main')).filter((n) => n.endsWith('.ts') && n !== 'notify.ts')) {
    const text = readFileSync(join(root, 'main', f), 'utf8');
    assert.equal(text.split('new Notification(').length - 1, 0, `${f}: értesítés a közös út mellett`);
  }
  assert.match(readFileSync(join(root, 'main', 'main.ts'), 'utf8'), /sendNotification\(mainNotifyId\(\), 'Breaker — a háttérben fut tovább'/);
  const preload = readFileSync(join(root, 'main', 'preload.ts'), 'utf8');
  assert.match(preload, /ipcRenderer\.on\('breaker:notify-event', /);
  assert.match(preload, /ipcRenderer\.invoke\('breaker:notify', req\)/);
});

test('a kérés ellenőrzése: csak a várt alak megy át, a hossz kódpontban vágva', () => {
  assert.deepEqual(parseNotifyRequest({ id: 'n1', title: 'Breaker', body: 'szöveg' }), { id: 'n1', title: 'Breaker', body: 'szöveg' });
  for (const bad of [null, undefined, 'x', 1, [], {}, { id: 'n1', title: 'T' }, { id: 'n1', body: 'b' },
    { id: '', title: 'T', body: 'b' }, { id: 'a b', title: 'T', body: 'b' }, { id: 'x'.repeat(41), title: 'T', body: 'b' },
    { id: 'n1', title: '   ', body: 'b' }, { id: 'n1', title: 5, body: 'b' }, { id: 'n1', title: 'T', body: null }]) {
    assert.equal(parseNotifyRequest(bad), null, JSON.stringify(bad));
  }
  const long = parseNotifyRequest({ id: 'n2', title: '😀'.repeat(NOTIFY_TITLE_MAX + 5), body: 'é'.repeat(NOTIFY_BODY_MAX + 1) });
  assert.ok(long);
  assert.equal([...long.title].length, NOTIFY_TITLE_MAX);
  assert.ok(long.title.endsWith('😀'), 'emodzsi nem törik félbe');
  assert.equal([...long.body].length, NOTIFY_BODY_MAX);
});

test('az esemény ellenőrzése a felületen', () => {
  for (const kind of ['shown', 'failed', 'click'] as const) {
    assert.deepEqual(parseNotifyEvent({ id: 'n7', kind }), { id: 'n7', kind });
  }
  for (const bad of [null, {}, { id: 'n7' }, { id: 'n7', kind: 'error' }, { id: 'n 7', kind: 'shown' }, ['n7', 'shown']]) {
    assert.equal(parseNotifyEvent(bad), null, JSON.stringify(bad));
  }
});

test('a korlátos emlékezet: a legrégebbi esik ki, és visszakapjuk, hogy el lehessen engedni', () => {
  const m = new NotifyMemory<string>(2);
  assert.deepEqual(m.add('a', 'A'), []);
  assert.deepEqual(m.add('b', 'B'), []);
  assert.deepEqual(m.add('c', 'C'), ['A']);
  assert.equal(m.get('a'), undefined);
  assert.equal(m.get('c'), 'C');
  // Újra felvéve a sor végére kerül: nem az esik ki.
  assert.deepEqual(m.add('b', 'B2'), []);
  assert.deepEqual(m.add('d', 'D'), ['C']);
  m.delete('b');
  assert.equal(m.size, 1);
});

test('a próba-gomb nem állítja, hogy az értesítés megjelent — azt csak a felhasználó látja', () => {
  // A `show` annyi, hogy a rendszer átvette: fókusz-módban és Windowson a
  // kikapcsolt értesítésnél is jöhet — hogy látszott-e, azt az app nem tudja.
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const outcome of ['sent', 'accepted', 'failed', 'off', 'error'] as const) {
      const text = notifyTestText(platform, outcome);
      assert.ok(text.trim() !== '', `${platform}/${outcome}: néma`);
      assert.doesNotMatch(text, /megjelent|kézbesít/i, `${platform}/${outcome}: többet állít, mint amit az app tud: ${text}`);
    }
  }
  // Átvételkor megmondja, hol keresse, ha mégsem látta.
  assert.ok(notifyTestText('darwin', 'accepted').includes('Rendszerbeállítások › Értesítések › Breaker'));
  assert.ok(notifyTestText('win32', 'accepted').includes('Gépház › Rendszer › Értesítések › Breaker'));
  assert.ok(notifyTestText('darwin', 'accepted').includes('fókusz-mód'));
  // macOS-en az első értesítés előtt jön az engedély-kérdés: a visszautasított
  // próba ezt is számba veszi, nem csak a kikapcsolt értesítést.
  assert.ok(notifyTestText('darwin', 'failed').includes('engedélyt'));
  // macOS-en a kikapcsolt értesítés visszautasításként jön — átvételkor nem
  // arra küldjük a felhasználót, hanem a fókusz-módra és a stílusra.
  assert.ok(!notifyTestText('darwin', 'accepted').includes('ki vannak kapcsolva'));
  assert.ok(notifyTestText('darwin', 'accepted').includes('stílusa Nincs'));
  assert.ok(notifyTestText('win32', 'accepted').includes('ki vannak kapcsolva'));
  // A híd hibája az app hibája: nem a rendszer beállítására mutat.
  assert.ok(notifyTestText('darwin', 'error').includes('a Breaker hibája'));
  assert.ok(!notifyTestText('win32', 'failed').includes('engedélyt'));
});
