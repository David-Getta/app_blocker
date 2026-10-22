// Az app azonosítója egy helyen (shared/app-id.ts): a telepítő, a macOS-aláírás
// és a Windows-értesítés is ehhez köti az appot.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { APP_ID, TOAST_ACTIVATOR_CLSID } from '../src/shared/app-id';

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

test('az értesítés-kattintás COM-azonosítója rögzített, és az eltávolítók ugyanezt veszik le', () => {
  // Az Electron 41 óta az app az első értesítéskor a felhasználó saját Start
  // menüjébe is tesz egy parancsikont és egy HKCU-bejegyzést ezzel az
  // azonosítóval. Ha a három hely szétcsúszik, az eltávolító mást venne le.
  assert.match(TOAST_ACTIVATOR_CLSID, /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/);
  const main = readFileSync(join(DESKTOP, 'src', 'main', 'main.ts'), 'utf8');
  const call = main.indexOf("if (process.platform === 'win32') app.setToastActivatorCLSID(TOAST_ACTIVATOR_CLSID);");
  assert.ok(call > 0, 'magától véletlen azonosítót választana, amit az eltávolító nem tud megnevezni');
  assert.ok(call < main.indexOf('new BrowserWindow('), 'az első ablak (és értesítés) előtt kell');
  const nsh = readFileSync(join(DESKTOP, 'build', 'installer.nsh'), 'utf8');
  assert.ok(nsh.includes(`DeleteRegKey HKCU "Software\\Classes\\CLSID\\${TOAST_ACTIVATOR_CLSID}"`), 'az NSIS-eltávolító más kulcsot venne le');
  assert.match(nsh, /\$\{ifNot\} \$\{isUpdated\}/, 'frissítéskor nem nyúlhat hozzá');
  assert.match(nsh, /SetShellVarContext all/, 'a gépszintű kontextust vissza kell állítani, különben a Gépház-bejegyzés marad');
  const ps = readFileSync(join(DESKTOP, 'scripts', 'uninstall-windows.ps1'), 'utf8');
  assert.ok(ps.includes(`$toastClsid = '${TOAST_ACTIVATOR_CLSID}'`), 'a kézi eltávolító más kulcsot venne le');
  const yml = readFileSync(join(DESKTOP, 'electron-builder.yml'), 'utf8');
  assert.match(yml, /^nsis:\n(?:  .*\n)*  include: build\/installer\.nsh$/m, 'az NSIS-makró nincs bekötve');
});
