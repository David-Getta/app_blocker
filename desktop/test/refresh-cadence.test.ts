// A felület frissítési üteme: látható ablaknál sűrű, rejtettnél ritka.
//
// A tét: a háttérben futó app ablaka rejtve van, a felület mégis két
// másodpercenként kérte le a teljes állapotot és rajzolt újra mindent. Rejtve
// csak az értesítések kellenek — ritkábban, rajzolás nélkül.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { HIDDEN_REFRESH_MS, refreshDue, VISIBLE_REFRESH_MS } from '../src/shared/refresh-cadence';

const T0 = 1_800_000_000_000;

test('látható ablaknál minden kör kérdez, rejtettnél csak tízmásodpercenként', () => {
  assert.equal(VISIBLE_REFRESH_MS, 2000);
  assert.equal(HIDDEN_REFRESH_MS, 10_000);
  assert.equal(refreshDue(true, T0, T0 + 1), true);
  assert.equal(refreshDue(false, T0, T0 + 2000), false);
  assert.equal(refreshDue(false, T0, T0 + 9999), false);
  assert.equal(refreshDue(false, T0, T0 + 10_000), true);
  assert.equal(refreshDue(false, T0, T0 - 60_000), true, 'visszaugró óra: nem akad meg');
});

/** Egy forrásfájl a tesztek mellől — forrásból és fordított kimenetből is. */
function source(rel: string): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
    dir = path.dirname(dir);
  }
  throw new Error(`nem találom: ${rel}`);
}

test('a bekötés: a fő folyamat jelzi a láthatóságot, a felület ebből üteméz és rejtve nem rajzol', () => {
  const main = source('src/main/main.ts');
  assert.ok(main.includes("win.webContents.send('breaker:visibility', win.isVisible() && !win.isMinimized());"));
  assert.ok(main.includes("win.webContents.on('did-finish-load', sendVisibility);"), 'a rejtve induló ablak is megkapja');
  const preload = source('src/main/preload.ts');
  assert.ok(preload.includes("ipcRenderer.on('breaker:visibility'"));
  const renderer = source('src/renderer/renderer.ts');
  assert.ok(renderer.includes('if (refreshDue(windowVisible, lastRefreshAt, Date.now())) void refresh();'));
  // Rejtve az értesítések mennek, a rajz nem: a rejtett ág a runNotices-t hívja,
  // és visszatér, mielőtt a render() sorra kerülne.
  // A rejtett ág a látható ág első sikeréig tart — a horgony a megjegyzés, nem
  // a sorok pontos rendje (az állapot-mezők köre bővülhet).
  const end = renderer.indexOf('// First successful connection');
  assert.ok(end > 0, 'megvan a látható ág horgonya');
  const hidden = renderer.slice(renderer.indexOf('if (!windowVisible) {'), end);
  assert.ok(hidden.includes('runNotices();'), 'rejtve is mennek az értesítések');
  assert.ok(!hidden.includes('render()'), 'rejtve nincs rajz');
  assert.ok(hidden.includes('return;'));
});
