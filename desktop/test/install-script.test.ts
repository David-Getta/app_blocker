// A telepítő emelt része fájl nélkül.
//
// A tét: eddig egy temp-fájlt futtattunk rendszergazdaként, és a kiírás meg a
// futtatás között a saját felhasználóként kódot futtató támadó kicserélhette —
// root/SYSTEM jogért. Most a teljes parancs az emelt folyamat parancssorában
// megy. Ezek a tesztek azt nézik, hogy a parancsból VISSZAFEJTHETŐ pontosan az,
// amit írni akartunk — idézés, base64, UTF-16 együtt —, és hogy a telepítő
// forrásában nem maradt ideiglenes fájl.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  appleScriptString, DAEMON_LABEL, encodePowerShell, launchdPlist, macInstallAppleScript, macInstallShell,
  psSingleQuoted, TASK_NAME, windowsInstallScript, windowsLauncherCommand,
} from '../src/shared/install-script';

const EXEC = '/Applications/Breaker "teszt" & co.app/Contents/MacOS/Breaker';
const ENTRY = '/Applications/Breaker.app/Contents/Resources/app.asar/dist/helper/index.js';

test('a plist a démont írja le, az útvonalakat XML-ben idézve', () => {
  const plist = launchdPlist(EXEC, ENTRY, 501);
  assert.ok(plist.includes(`<string>${DAEMON_LABEL}</string>`));
  assert.ok(plist.includes('<string>/Applications/Breaker "teszt" &amp; co.app/Contents/MacOS/Breaker</string>'));
  assert.ok(plist.includes('<string>--owner-uid=501</string>'));
  assert.ok(plist.includes('<key>ELECTRON_RUN_AS_NODE</key><string>1</string>'));
});

/** Egy AppleScript-szöveg visszafejtése: a `\"` és a `\\` vissza. */
function appleScriptUnquote(literal: string): string {
  assert.ok(literal.startsWith('"') && literal.endsWith('"'));
  return literal.slice(1, -1).replace(/\\(["\\])/g, '$1');
}

test('macOS: a gyökér-héj parancsából pontosan a plist fejthető vissza', () => {
  const plist = launchdPlist(EXEC, ENTRY, 501);
  const shell = macInstallShell(plist);
  const m = shell.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| \/usr\/bin\/base64 -D > ([^\s;]+)/);
  assert.ok(m, `nincs base64-es kiírás a parancsban:\n${shell}`);
  assert.equal(Buffer.from(m![1], 'base64').toString('utf8'), plist);
  assert.equal(m![2], `/Library/LaunchDaemons/${DAEMON_LABEL}.plist`);
  // A sorrend: kiírás, jogok, a régi démon le, az új fel.
  const order = ['set -e', 'base64 -D', 'chown root:wheel', 'chmod 644', 'launchctl bootout', 'launchctl bootstrap'];
  const at = order.map((x) => shell.indexOf(x));
  assert.ok(at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1])), `rossz sorrend:\n${shell}`);
  assert.ok(!shell.includes('\n'), 'egy sor: az osascript-szöveg sortörés nélkül');
});

test('macOS: az AppleScript-szövegből a gyökér-héj parancsa változatlanul jön vissza', () => {
  const plist = launchdPlist(EXEC, ENTRY, 501);
  const script = macInstallAppleScript(plist);
  const m = script.match(/^do shell script ("(?:[^"\\]|\\.)*") with administrator privileges$/);
  assert.ok(m, `nem egy do shell script hívás:\n${script}`);
  assert.equal(appleScriptUnquote(m![1]), macInstallShell(plist));
  assert.equal(appleScriptUnquote(appleScriptString('a "b" \\ c')), 'a "b" \\ c');
});

/** A `-EncodedCommand` visszafejtése: base64, UTF-16LE. */
function decodePowerShell(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

test('Windows: a kódolt parancsból pontosan a szkript jön vissza, az útvonal idézve', () => {
  const exe = "C:\\Program Files\\Breaker's\\Breaker.exe";
  const script = windowsInstallScript(exe);
  assert.ok(script.includes(`/TR '"C:\\Program Files\\Breaker''s\\Breaker.exe" --helper'`),
    `az aposztróf nincs duplázva:\n${script}`);
  assert.ok(script.includes(`schtasks /Create /F /TN "${TASK_NAME}" /SC ONSTART /RU SYSTEM`));
  assert.equal(decodePowerShell(encodePowerShell(script)), script);

  const launcher = windowsLauncherCommand(exe);
  const m = launcher.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/);
  assert.ok(m, `nincs kódolt parancs az indítóban:\n${launcher}`);
  assert.equal(decodePowerShell(m![1]), script);
  assert.ok(launcher.includes('-Verb RunAs -Wait -PassThru'));
  assert.ok(launcher.endsWith('exit $p.ExitCode'), 'a belső kilépési kód továbbmegy');
  assert.ok(!/-File/.test(launcher), 'nincs fájl az emelt indításban');
  assert.equal(psSingleQuoted("a'b"), "'a''b'");
});

/** A telepítő forrása — a tesztek forrásból és fordított kimenetből is futnak. */
function installSource(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'src', 'main', 'install.ts');
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
    dir = path.dirname(dir);
  }
  throw new Error('nem találom a src/main/install.ts-t');
}

test('a telepítő nem ír ideiglenes fájlt, amit emelt joggal futtatna', () => {
  const code = installSource().replace(/\/\/.*$/gm, '');
  for (const banned of ['writeFileSync', 'mkdtemp', "'-File'", 'install.sh', 'install.ps1', "getPath('temp')", 'tmpdir(']) {
    assert.ok(!code.includes(banned), `a telepítőben ott maradt: ${banned}`);
  }
  assert.ok(code.includes('macInstallAppleScript(plist)'));
  assert.ok(code.includes('windowsLauncherCommand(process.execPath)'));
});
