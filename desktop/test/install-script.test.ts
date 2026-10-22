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
  psSingleQuoted, TASK_NAME, WINDOWS_TASK_SETTINGS_PS, windowsInstallScript, windowsLauncherCommand,
  windowsTaskSettingsRepairScript,
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

const KEY_HASH = 'ab'.repeat(32);

test('Windows: a kódolt parancsból pontosan a szkript jön vissza, az útvonal idézve', () => {
  const exe = "C:\\Program Files\\Breaker's\\Breaker.exe";
  const script = windowsInstallScript(exe, KEY_HASH);
  // Az exe és a kapcsolói KÜLÖN mennek a feladatba: nincs egyetlen szöveg,
  // amiben az exe útját idézni kellene.
  assert.ok(script.includes(
    `New-ScheduledTaskAction -Execute 'C:\\Program Files\\Breaker''s\\Breaker.exe' -Argument '--helper --client-key-sha256=${KEY_HASH}'`,
  ), `az aposztróf nincs duplázva, vagy hiányzik a kulcs-lenyomat:\n${script}`);
  assert.ok(script.includes(`Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force`));
  assert.ok(script.includes('New-ScheduledTaskTrigger -AtStartup'));
  assert.ok(script.includes("New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest"));
  // A régi példány előbb leáll — különben az indítás nem indítana újat.
  assert.ok(script.indexOf(`Stop-ScheduledTask -TaskName '${TASK_NAME}'`) < script.indexOf('Register-ScheduledTask'),
    'a leállítás a felvétel előtt');
  assert.ok(script.indexOf('Register-ScheduledTask') < script.indexOf(`Start-ScheduledTask -TaskName '${TASK_NAME}'`));
  assert.equal(decodePowerShell(encodePowerShell(script)), script);
  // Csak a szigorú alak mehet a parancssorba.
  for (const bad of ['', 'AB'.repeat(32), 'ab'.repeat(31), `${'ab'.repeat(31)}a"`, `${KEY_HASH} --x`]) {
    assert.throws(() => windowsInstallScript(exe, bad), /kulcs-lenyomat/, JSON.stringify(bad));
  }

  const launcher = windowsLauncherCommand(exe, KEY_HASH);
  const m = launcher.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/);
  assert.ok(m, `nincs kódolt parancs az indítóban:\n${launcher}`);
  assert.equal(decodePowerShell(m![1]), script);
  assert.ok(launcher.includes('-Verb RunAs -Wait -PassThru'));
  assert.ok(launcher.endsWith('exit $p.ExitCode'), 'a belső kilépési kód továbbmegy');
  assert.ok(!/-File/.test(launcher), 'nincs fájl az emelt indításban');
  assert.equal(psSingleQuoted("a'b"), "'a''b'");
});

test('Windows: az emelt szkript nem ad natív parancsnak idézőjeles argumentumot', () => {
  // A Windows PowerShell 5.1 egy natív parancs argumentumában a belső
  // idézőjelet nem védi: a v0.4.257 előtti `schtasks /TR '"C:\\Program Files\\…" …'`
  // ezen bukott el minden Program Files alá telepített gépen. Ezért az emelt
  // szkriptben se schtasks, se dupla idézőjel.
  const script = windowsInstallScript('C:\\Program Files\\Breaker\\Breaker.exe', KEY_HASH);
  assert.ok(!/schtasks/i.test(script), script);
  assert.ok(!script.includes('"'), script);
  assert.ok(!windowsTaskSettingsRepairScript().includes('"'));
});

test('Windows: a feladat egy őrző szolgáltatás beállításaival megy fel, és a segéd ugyanide javítja', () => {
  for (const flag of [
    '-AllowStartIfOnBatteries', '-DontStopIfGoingOnBatteries', '-ExecutionTimeLimit ([TimeSpan]::Zero)',
    '-RestartCount 999', '-RestartInterval (New-TimeSpan -Minutes 1)',
  ]) {
    assert.ok(WINDOWS_TASK_SETTINGS_PS.includes(flag), flag);
  }
  assert.ok(windowsInstallScript('C:\\B\\Breaker.exe', KEY_HASH).includes(`$settings = ${WINDOWS_TASK_SETTINGS_PS}`));
  const repair = windowsTaskSettingsRepairScript();
  assert.ok(repair.includes(`Set-ScheduledTask -TaskName '${TASK_NAME}' -Settings (${WINDOWS_TASK_SETTINGS_PS})`));
  // Csak a beállításokat: az indítás (a kulccsal) és a felhasználó marad.
  assert.ok(!/-Action|-Principal|-Trigger|-User/.test(repair), repair);
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
  assert.ok(code.includes('windowsLauncherCommand(process.execPath, keyHash)'));
});
