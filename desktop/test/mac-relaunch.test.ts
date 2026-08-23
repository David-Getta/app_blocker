import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { relaunchScript, shQuote, RELAUNCH_WAIT_STEPS } from '../src/shared/mac-relaunch';

test('the new instance is started only AFTER the old one is gone', () => {
  // Ez a teszt lényege. A Lakat egypéldányos: ha még futunk, amikor az újat
  // elindítjuk, az új nem kapja meg a zárat és azonnal kilép — utána a régi is
  // kilép, és a felhasználónak nem marad futó appja. A várakozásnak tehát meg
  // KELL előznie az indítást.
  const s = relaunchScript(4321, '/Applications/Lakat.app', ['/Applications/Lakat.app.old-4321']);
  const wait = s.indexOf('kill -0 4321');
  const open = s.indexOf('open -n');
  assert.ok(wait >= 0, 'megvárja a régi példány kilépését');
  assert.ok(open > wait, 'és csak azután indít');
});

test('the old bundle is deleted only after we are gone, and before the new start', () => {
  // A régi bundle-ből fut a kód, amíg élünk: futás közben törölni kockázat.
  const s = relaunchScript(7, '/Applications/Lakat.app', ['/Applications/Lakat.app.old-7']);
  const wait = s.indexOf('kill -0 7');
  const rm = s.indexOf('rm -rf');
  const open = s.indexOf('open -n');
  assert.ok(rm > wait && rm < open, `a takarítás a várakozás után, az indítás előtt van: ${s}`);
});

test('the wait is bounded, so a stuck exit still gets the user an app', () => {
  const s = relaunchScript(9, '/A/B.app', ['/A/B.app.old']);
  assert.match(s, new RegExp(`-lt ${RELAUNCH_WAIT_STEPS}`));
});

test('a path with spaces or quotes cannot break out of the command', () => {
  // Az útvonal a telepítés helyéből jön; idézőjelezés nélkül egy trükkös név
  // tetszőleges parancsot futtatna a felhasználó nevében.
  assert.equal(shQuote('/Applications/My App.app'), `'/Applications/My App.app'`);
  assert.equal(shQuote(`/tmp/it's here`), `'/tmp/it'\\''s here'`);
  const evil = `/tmp/x'; touch /tmp/pwned; echo '`;
  const s = relaunchScript(1, evil, ['/tmp/backup']);
  assert.ok(!s.includes('; touch /tmp/pwned;') || s.includes(`'\\''`),
    'a beágyazott parancs idézőjelen belül marad');
});

test('the quoting really holds when a shell runs it', () => {
  // Nem elég ránézésre helyesnek lennie: futtassuk le tényleg. A szkript egy
  // már nem létező pid-re vár (azonnal továbbmegy), és az `open` helyett a
  // PATH elejére tett saját szkriptünk fut, ami leírja, mit kapott.
  if (process.platform === 'win32') return; // nincs POSIX héj
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lakat-relaunch-'));
  const out = path.join(dir, 'got.txt');
  const fakeBin = path.join(dir, 'bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'open'), `#!/bin/sh\nprintf '%s\\n' "$2" > ${JSON.stringify(out)}\n`, { mode: 0o755 });

  const weird = path.join(dir, `Lakat 'x'.app`);
  fs.mkdirSync(weird);
  const backup = path.join(dir, 'backup.app');
  fs.mkdirSync(backup);
  const workDir = path.join(dir, 'letöltés munkamappa');
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'big.zip'), 'x');

  // pid 2^22-1: biztosan nem fut, tehát a `kill -0` azonnal hamis.
  const script = relaunchScript(4194303, weird, [backup, workDir]);
  execFileSync('/bin/sh', ['-c', script], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    timeout: 20_000,
  });

  assert.equal(fs.readFileSync(out, 'utf8').trim(), weird, 'az útvonal egyben érkezett meg');
  assert.equal(fs.existsSync(backup), false, 'a régi bundle törlődött');
  assert.equal(fs.existsSync(workDir), false, 'a letöltés munkamappája sem maradt ott');
  assert.equal(fs.existsSync(path.join(dir, 'pwned')), false, 'semmi nem szökött ki a parancsból');
  fs.rmSync(dir, { recursive: true, force: true });
});
