// A becsomagolt segéd próbái (scripts/mac-helper-probe.sh, a
// win-install-probe.ps1 segéd-lépése) a TELEPÍTŐ kódjából dolgoznak, nem egy
// másolatából: ha az app máshogy telepítené vagy máshol keresné a segédet,
// a próba is azt nézze — különben egy zöld próba egy már nem létező utat
// őrizne.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { GUARD_LABEL, GUARD_TASK_NAME } from '../src/shared/guard-script';
import { DAEMON_LABEL, TASK_NAME } from '../src/shared/install-script';

// A lefordított teszt a dist-test/test alatt fut — a desktop mappa két szinttel feljebb.
const DESKTOP = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(DESKTOP, ...p), 'utf8');

test('macOS: a próba a telepítő parancsával telepít, és ott keresi a segédet, ahol az app', () => {
  const probe = read('scripts', 'mac-helper-probe.sh');
  const install = read('src', 'main', 'install.ts');
  const script = read('src', 'shared', 'install-script.ts');
  // Az app: launchdPlist(process.execPath, helperEntryPath(), uid) → macInstallAppleScript,
  // ami a macInstallShell-t futtatja rendszergazdaként.
  assert.ok(install.includes('launchdPlist(process.execPath, helperEntryPath(), ownerUid)'));
  assert.ok(script.includes('appleScriptString(macInstallShell(plist))'));
  assert.ok(probe.includes('s.macInstallShell(s.launchdPlist('), 'a próba nem a telepítő parancsát futtatná');
  // A belépési pont: a csomagolt appban az app.getAppPath() az app.asar.
  assert.ok(install.includes("path.join(app.getAppPath(), 'dist', 'helper', 'index.js')"));
  assert.ok(probe.includes('ENTRY="$APP/Contents/Resources/app.asar/dist/helper/index.js"'));
  assert.ok(probe.includes(`LABEL=${DAEMON_LABEL}\n`), 'a próba más démont nézne, mint amit a telepítő tesz fel');
  assert.ok(read('src', 'helper', 'paths.ts').includes("if (process.platform === 'darwin') return '/var/run/breaker.sock';"));
  assert.ok(probe.includes('SOCK=/var/run/breaker.sock\n'));
  // Az eltávolító: a segéd által a gépre tett másolat (helper/guard.ts), amire a
  // szigorú blokk magyarázata mutat — és az a csomagolttal egyezik.
  assert.ok(probe.includes('SDIR="/Library/Application Support/Breaker"\n'));
  assert.ok(probe.includes('sudo sh "$SDIR/uninstall-macos.sh"'), 'a gépre tett eltávolító-másolat kell');
  assert.ok(probe.includes('sudo cmp -s "$SDIR/uninstall-macos.sh" scripts/uninstall-macos.sh'));
  assert.ok(read('src', 'helper', 'paths.ts').includes("return '/Library/Application Support/Breaker/state.json';"));
  assert.ok(probe.includes(`GLABEL=${GUARD_LABEL}\n`), 'a próba más őrt nézne, mint amit a segéd tesz fel');
});

test('Windows: a próba a telepítő szkriptjével veszi fel a feladatot, és a segéd pipe-jára csatlakozik', () => {
  const probe = read('scripts', 'win-install-probe.ps1');
  const script = read('src', 'shared', 'install-script.ts');
  assert.ok(script.includes('encodePowerShell(windowsInstallScript(exe, keyHash))'));
  assert.ok(probe.includes('s.encodePowerShell(s.windowsInstallScript('), 'a próba nem a telepítő szkriptjét futtatná');
  assert.ok(probe.includes(`$taskName = '${TASK_NAME}'`));
  assert.ok(read('src', 'helper', 'paths.ts').includes("if (process.platform === 'win32') return '\\\\\\\\.\\\\pipe\\\\breaker-helper';"));
  assert.ok(probe.includes("'\\\\.\\pipe\\breaker-helper'"));
  // A telepítő a TELEPÍTETT exe-t adja a feladatnak, ahogy az app a saját útját.
  assert.ok(probe.includes('$installJs $exe $keyHash'));
  assert.ok(probe.includes('elseif ($action.Execute -ne $exe)'));
  // Az őr: ugyanaz a feladatnév, és a végén a gépre tett eltávolító-másolat fut.
  assert.ok(probe.includes(`$guardTask = '${GUARD_TASK_NAME}'`));
  assert.ok(probe.includes("powershell -NoProfile -ExecutionPolicy Bypass -File $uninstallCopy"));
});

test('a kliens a protokoll parancsait küldi, ahogy az app', () => {
  const client = read('scripts', 'helper-probe-client.js');
  const proto = read('src', 'shared', 'protocol.ts');
  assert.ok(proto.includes("| { id: number; op: 'add_site'; input: string; usePreset: boolean }"));
  assert.ok(client.includes("ask({ op: 'add_site', input: domain, usePreset: false })"));
  assert.ok(proto.includes("| { id: number; op: 'hello'; key?: string }"));
  assert.ok(client.includes("ask({ op: 'hello', key })"));
  // A rendszer feloldója, nem a DNS-kiszolgáló: a hosts-fájlon át, ahogy a böngésző.
  assert.ok(client.includes('dns.promises.lookup('));
  assert.ok(!client.includes('dns.promises.resolve'));
});

test('mindkét próba fut a CI-ban, a becsomagolt appon', () => {
  const ci = readFileSync(join(DESKTOP, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(ci.includes('run: bash scripts/mac-helper-probe.sh release/mac-arm64/Breaker.app'));
  assert.ok(ci.includes('run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/win-install-probe.ps1'));
});
