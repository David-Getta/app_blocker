// A segéd őr-oldala (#149): a saját kód figyelése (helper/code-watch.ts), a
// szigorú blokk kiírása (helper/strict.ts), a telepítés helye
// (macInstallLocationProblem), és az eltávolítók sorrendje — előbb a segéd,
// aztán az őr, és csak utána a hosts fájl.

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { codePaths, codeWatchStep, fileMark, markOf, type CodeWatch } from '../src/helper/code-watch';
import { strictBlockPath } from '../src/helper/paths';
import { defaultState } from '../src/helper/state';
import { writeStrictBlock } from '../src/helper/strict';
import { macInstallLocationProblem } from '../src/shared/install-script';
import { isValidStrictBlock } from '../src/shared/strict-block';

function findRepo(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'desktop', 'scripts', 'uninstall-macos.sh'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('a tároló gyökere nem található');
}
const read = (rel: string): string => fs.readFileSync(path.join(findRepo(), rel), 'utf8');

// ------------------------------------------------------------ a saját kód figyelése

test('a kód-figyelő csak a lecsillapodott változásra dönt — frissülés vagy eltűnés', () => {
  const w: CodeWatch = { base: 'a|b', pending: null };
  assert.equal(codeWatchStep(w, 'a|b', 0), 'same');
  // Csere közben: az első eltérés még csak „ülepszik”.
  assert.equal(codeWatchStep(w, 'a2|b', 1_000), 'settling');
  assert.equal(codeWatchStep(w, 'a2|b', 60_000), 'settling', 'egy perc még nem telt el');
  // Ha közben tovább változik (a másoló még dolgozik), az óra elölről indul.
  assert.equal(codeWatchStep(w, 'a2|b2', 61_000), 'settling');
  assert.equal(codeWatchStep(w, 'a2|b2', 120_000), 'settling');
  assert.equal(codeWatchStep(w, 'a2|b2', 121_000), 'changed');

  // Visszaállt az eredetire: semmi teendő, és a félbehagyott eltérés is törlődik.
  const back: CodeWatch = { base: 'a|b', pending: null };
  codeWatchStep(back, 'missing|b', 0);
  assert.equal(codeWatchStep(back, 'a|b', 30_000), 'same');
  assert.equal(back.pending, null);
  assert.equal(codeWatchStep(back, 'missing|b', 40_000), 'settling', 'új eltérés, új óra');

  // Ha bármelyik fájl hiányzik és úgy is marad: az app eltűnt.
  const gone: CodeWatch = { base: 'a|b', pending: null };
  codeWatchStep(gone, 'a|missing', 0);
  assert.equal(codeWatchStep(gone, 'a|missing', 60_000), 'gone');
  const both: CodeWatch = { base: 'a|b', pending: null };
  codeWatchStep(both, 'missing|missing', 0);
  assert.equal(codeWatchStep(both, 'missing|missing', 59_999), 'settling');
  assert.equal(codeWatchStep(both, 'missing|missing', 60_000), 'gone');
});

test('a segéd sosem lép ki magától — a futó kódot csak rendszergazdai lépés vagy újraindítás cseréli', () => {
  // Ha a segéd egy csomag-cserére vagy egy eltűnésre kilépne, a launchd
  // (KeepAlive) — vagy az őr — azt indítaná újra rendszerjoggal, ami épp az app
  // mappájában van. Ezért a segéd kódjában nincs kilépés; a kód-figyelő csak
  // naplóz (code-watch.ts).
  const dir = path.join(findRepo(), 'desktop', 'src', 'helper');
  const offenders: string[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    if (/process\.(exit|abort|reallyExit)\b|process\.kill\(\s*process\.pid/.test(code)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `kilépés a segédben: ${offenders.join(', ')}`);
  // A figyelő be van kötve, és mindkét esetet naplózza.
  const index = read('desktop/src/helper/index.ts');
  assert.ok(index.includes('const verdict = codeWatchStep(watch, mark, Date.now());'));
  assert.ok(index.includes("log('az app frissült: a segéd a következő indulásig a régi kódon fut');"));
  assert.ok(index.includes("log('az app eltűnt: a segéd a beállított szabályokkal tovább tilt; ha leáll, az őr veszi át');"));
  // Egy eset egyszer naplózódik: utána az új állapot az alap.
  assert.ok(index.includes('watch.base = mark;'));
});

test('a kód-figyelő csak a becsomagolt segédet nézi: a bináris és az app.asar', () => {
  const exe = '/Applications/Breaker.app/Contents/MacOS/Breaker';
  const entry = '/Applications/Breaker.app/Contents/Resources/app.asar/dist/helper/index.js';
  assert.deepEqual(codePaths(exe, entry), [exe, '/Applications/Breaker.app/Contents/Resources/app.asar']);
  // Fejlesztői futás (nincs asar) és belépési pont nélküli futás: nincs figyelés.
  assert.equal(codePaths('/usr/local/bin/node', '/src/desktop/dist/helper/index.js'), null);
  assert.equal(codePaths(exe, undefined), null);
});

test('az ujjlenyomat a cserét is észreveszi (új inode), a hiányt is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-codewatch-'));
  const f = path.join(dir, 'app.asar');
  assert.equal(fileMark(f), 'missing');
  fs.writeFileSync(f, 'v1');
  const m1 = fileMark(f);
  assert.notEqual(m1, 'missing');
  // Egy frissítő átnevezéssel cserél: ugyanakkora tartalom, más inode.
  const tmp = path.join(dir, 'new');
  fs.writeFileSync(tmp, 'v2');
  fs.renameSync(tmp, f);
  assert.notEqual(fileMark(f), m1);
  assert.equal(markOf([f, path.join(dir, 'nincs')]).split('|')[1], 'missing');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ a szigorú blokk kiírása

test('a segéd kiírja a szigorú blokkot: minden oldal minden neve, 0600, és az őr szabálya elfogadja', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-strict-'));
  process.env.BREAKER_STATE = path.join(dir, 'state.json');
  const logs: string[] = [];
  const log = (m: string): void => { logs.push(m); };
  const now = Date.now();
  const state = defaultState();
  state.sites.push(
    // szünetel — az élő blokkban nincs, a szigorúban ott kell lennie
    { id: 's1', domain: 'youtube.com', hostnames: ['youtube.com', 'www.youtube.com'], addedAt: 0, pauseUntil: now + 3_600_000, pendingDeleteAt: null },
    { id: 's2', domain: 'reddit.com', hostnames: ['reddit.com'], addedAt: 0, pauseUntil: null, pendingDeleteAt: null },
  );
  writeStrictBlock(state, now, log);
  const file = strictBlockPath();
  assert.equal(path.dirname(file), dir, 'a szigorú blokk a segéd állapotmappájába kerül');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(isValidStrictBlock(text), text);
  for (const h of ['youtube.com', 'www.youtube.com', 'reddit.com']) {
    assert.ok(text.includes(`0.0.0.0 ${h}\n`), `hiányzik: ${h}`);
  }
  assert.ok(text.includes('a teljes lista tilt'), 'a magyarázó sor hiányzik');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'ideiglenes fájl maradt');

  // Ugyanaz a lista: nem ír újra — de ha a fájl közben eltűnt, visszaírja.
  const before = fs.statSync(file).mtimeMs;
  writeStrictBlock(state, now, log);
  assert.equal(fs.statSync(file).mtimeMs, before);
  fs.rmSync(file);
  writeStrictBlock(state, now, log);
  assert.equal(fs.readFileSync(file, 'utf8'), text);

  // Üres lista: nincs mit tartani — a fájl megy, az őr nem ír magányos megjegyzést.
  state.sites = [];
  writeStrictBlock(state, now, log);
  assert.ok(!fs.existsSync(file));
  assert.deepEqual(logs, []);

  // A hiba sosem dob: a segéd tiltása ettől nem állhat meg.
  process.env.BREAKER_STATE = path.join(dir, 'nincs-ilyen-mappa', 'state.json');
  state.sites.push({ id: 's3', domain: 'x.example', hostnames: ['x.example'], addedAt: 0, pauseUntil: null, pendingDeleteAt: null });
  assert.doesNotThrow(() => writeStrictBlock(state, now, log));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^a szigorú blokk nem íródott ki/);
  delete process.env.BREAKER_STATE;
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ a telepítés helye

test('macOS-en lemezképről és karanténból nem telepítünk segédet', () => {
  assert.equal(macInstallLocationProblem('/Applications/Breaker.app/Contents/MacOS/Breaker'), null);
  assert.equal(macInstallLocationProblem('/Users/anna/Applications/Breaker.app/Contents/MacOS/Breaker'), null);
  for (const bad of [
    '/Volumes/Breaker/Breaker.app/Contents/MacOS/Breaker',
    '/private/var/folders/xy/T/AppTranslocation/1234/d/Breaker.app/Contents/MacOS/Breaker',
    '/usr/local/bin/electron',
  ]) {
    assert.match(macInstallLocationProblem(bad) ?? '', /Alkalmazások mappába/, bad);
  }
  const src = read('desktop/src/main/install.ts');
  const check = src.indexOf('macInstallLocationProblem(process.execPath)');
  assert.ok(check > 0 && check < src.indexOf("runFile('/usr/bin/osascript'"), 'a hely ellenőrzése a jelszókérés ELŐTT jön');
});

// ------------------------------------------------------------ az eltávolítók

test('a macOS-eltávolító előbb a segédet, aztán az őrt állítja le — és csak utána nyúl a hosts fájlhoz', () => {
  const sh = read('desktop/scripts/uninstall-macos.sh');
  const helper = sh.indexOf('launchctl bootout system/hu.breaker.helper');
  const guard = sh.indexOf('launchctl bootout system/hu.breaker.guard');
  const plists = sh.indexOf('rm -f /Library/LaunchDaemons/hu.breaker.helper.plist /Library/LaunchDaemons/hu.breaker.guard.plist');
  const hosts = sh.indexOf("awk '/^# >>> BREAKER BLOCK BEGIN/");
  assert.ok(helper > 0 && guard > helper, 'a segéd előbb: egy futó segéd újratelepítené az őrt');
  assert.ok(plists > guard && hosts > plists, 'a hosts csak a leállás után — különben az őr visszaírná');
  // Ha valamelyik nem áll le, hangosan megáll, nem takarít félig.
  assert.ok(sh.includes('A segéd vagy az őr nem állt le'));
  // Az állapotmappával megy a szigorú blokk, az őr szkriptje és az eltávolító másolata is.
  assert.ok(sh.includes('rm -rf "/Library/Application Support/Breaker"'));
});

test('a Windows-eltávolító a BreakerGuard feladatot és a „Breaker Guard” mappát is viszi', () => {
  const ps = read('desktop/scripts/uninstall-windows.ps1');
  const helper = ps.indexOf('schtasks /Delete /F /TN "BreakerHelper"');
  const guard = ps.indexOf('schtasks /Delete /F /TN "BreakerGuard"');
  assert.ok(helper > 0 && guard > helper, 'a segéd előbb, aztán az őr');
  assert.ok(ps.includes('schtasks /End /TN "BreakerGuard"'));
  assert.ok(ps.includes('Join-Path $pf "Breaker Guard"'));
  // A saját mappájából futtatva se tartsa nyitva azt, amit törölni akar.
  assert.ok(ps.indexOf('Set-Location -LiteralPath $env:SystemRoot') < helper);
  // A hosts-takarítás az őr leállítása után.
  const hostsAt = ps.search(/BREAKER BLOCK BEGIN/);
  assert.ok(hostsAt > guard, 'a hosts csak az őr után — különben visszaírná');
});

test('az eltávolító szkriptek a csomagba kerülnek (a segéd ebből tesz másolatot)', () => {
  const copy = read('desktop/scripts/copy-static.js');
  assert.ok(copy.includes("for (const f of ['uninstall-macos.sh', 'uninstall-windows.ps1'])"));
  assert.ok(copy.includes("path.join(__dirname, '..', 'dist', 'uninstall')"));
  const guard = read('desktop/src/helper/guard.ts');
  assert.ok(guard.includes("path.join(__dirname, '..', 'uninstall', name)"), 'a segéd máshonnan másol, mint ahova a build tesz');
});

test('az NSIS-eltávolító nem nyúl a feladatokhoz és a hosts fájlhoz — csak kimondja, mi marad', () => {
  const nsh = read('desktop/build/installer.nsh');
  const code = nsh.split('\n').filter((l) => !/^\s*;/.test(l)).join('\n');
  assert.ok(code.includes('!macro customUnInit'));
  assert.ok(code.includes('${ifNot} ${isUpdated}'), 'frissítéskor ne kérdezzen');
  assert.ok(code.includes('/SD IDOK'), 'csendes módban se akadjon el');
  assert.ok(code.includes('$PROGRAMFILES64\\Breaker Guard\\uninstall-windows.ps1'));
  assert.ok(!/schtasks|BreakerGuard|BreakerHelper|drivers\\etc\\hosts|ExecWait|nsExec/i.test(code), 'az app eltávolítása nem lehet ingyenes lazítás');
});
