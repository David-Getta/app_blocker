// Az app azonosítója egy helyen (shared/app-id.ts): a telepítő, a macOS-aláírás
// és a Windows-értesítés is ehhez köti az appot.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { APP_ID } from '../src/shared/app-id';

// A lefordított teszt a dist-test/test alatt fut — a desktop mappa két szinttel feljebb.
const DESKTOP = join(__dirname, '..', '..');

test('a telepítő ugyanazzal az azonosítóval jelöli a csomagot, amit az app mond', () => {
  const yml = readFileSync(join(DESKTOP, 'electron-builder.yml'), 'utf8');
  const m = yml.match(/^appId:\s*(\S+)\s*$/m);
  assert.ok(m, 'az electron-builder.yml-ben nincs appId');
  assert.equal(m[1], APP_ID, 'a Windows nem kötné az értesítéseket a telepített app parancsikonjához');
});

test('Windowson az app az ablakok előtt beállítja az azonosítóját', () => {
  const main = readFileSync(join(DESKTOP, 'src', 'main', 'main.ts'), 'utf8');
  const call = main.indexOf("if (process.platform === 'win32') app.setAppUserModelId(APP_ID);");
  assert.ok(call > 0, 'az Electron magától „electron.app.Breaker”-t mondana');
  assert.ok(call < main.indexOf('new BrowserWindow('), 'az első ablak előtt kell');
});

test('a Mac-csomag füstpróbája is ezt az azonosítót várja az aláírásban', () => {
  const smoke = readFileSync(join(DESKTOP, 'scripts', 'smoke-packaged.sh'), 'utf8');
  assert.ok(smoke.includes(`^Identifier=${APP_ID.replace(/\./g, '\\.')}$`), 'a füstpróba más azonosítót nézne');
});
