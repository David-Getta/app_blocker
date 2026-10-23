// A segéd őre (shared/guard-script.ts) és a szigorú blokk (shared/strict-block.ts).
//
// A macOS-őrt itt ÉLESBEN futtatjuk, dash-sel (a macOS /bin/sh-ja is POSIX):
// csonkolt PlistBuddy-val (a segéd leírójából a bináris és a belépési pont) és
// launchctl-lel (fut-e a segéd), egy ideiglenes hosts fájlon. A Windows-őrt a
// CI-próba futtatja élesben; itt a szövegét nézzük.

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { MARKER_BEGIN, MARKER_END, buildManagedBlock } from '../src/shared/blocklist';
import {
  GUARD_LABEL, GUARD_TASK_NAME, MAC_GUARD_DEFAULTS, macGuardPlist, macGuardScript, shQuote, STRICT_FILE,
  windowsGuardRegisterScript, windowsGuardScript,
} from '../src/shared/guard-script';
import { isValidStrictBlock, renderStrictBlock, strictHostnames, strictNote } from '../src/shared/strict-block';
import { DAEMON_LABEL, TASK_NAME } from '../src/shared/install-script';

const NOTE = strictNote('darwin', '/Library/Application Support/Breaker/uninstall-macos.sh');

// ------------------------------------------------------------ szigorú blokk

test('a szigorú blokk minden oldal minden nevét tiltja — a szüneteltet és a menetrendeset is', () => {
  const sites = [
    { hostnames: ['youtube.com', 'www.youtube.com'] }, // épp szünetel — az aktív blokkban nincs
    { hostnames: ['reddit.com'] },
  ];
  const active = ['reddit.com', 'extra.example'];
  assert.deepEqual(strictHostnames(sites, active), ['extra.example', 'reddit.com', 'www.youtube.com', 'youtube.com']);
  // Ami nem hosztnév-alakú, az nem kerülhet a root által írt fájlba.
  assert.deepEqual(strictHostnames([{ hostnames: ['ok.example', 'bad name', '1.2.3.4 x.com', 'UPPER.com'] }], []), ['ok.example']);
});

test('a szigorú blokk a kész hosts-blokk: jelölők, magyarázó sor, tiltó sorok — és az őr szabálya elfogadja', () => {
  const text = renderStrictBlock(['a.example', 'b.example'], NOTE);
  const lines = text.split('\n');
  assert.equal(lines[0], MARKER_BEGIN);
  assert.ok(lines[1].startsWith('# Breaker: az app nem található'));
  assert.ok(lines.includes('0.0.0.0 a.example') && lines.includes(':: b.example'));
  assert.equal(lines[lines.length - 2], MARKER_END);
  assert.ok(text.endsWith('\n'));
  assert.ok(isValidStrictBlock(text));
  // A blokk többi része ugyanaz, mint a segédé.
  assert.equal(text.replace(`${lines[1]}\n`, ''), `${buildManagedBlock(['a.example', 'b.example'], 'darwin')}\n`);
  // Üres listánál semmi — egy magányos megjegyzést se írjon az őr a hosts fájlba.
  assert.equal(renderStrictBlock([], NOTE), '');
});

test('az őr szabálya: idegen cím, hibás jelölő, csonka fájl — elutasítva', () => {
  const good = renderStrictBlock(['a.example'], NOTE);
  assert.ok(!isValidStrictBlock(good.replace('0.0.0.0 a.example', '1.2.3.4 a.example')));
  assert.ok(!isValidStrictBlock(good.replace(':: a.example', '::1 a.example')));
  assert.ok(!isValidStrictBlock(good.replace('0.0.0.0 a.example', '0.0.0.0 a.example b.example')));
  assert.ok(!isValidStrictBlock(good.replace(MARKER_END, '# vége')));
  assert.ok(!isValidStrictBlock(good.slice(0, -1)));
  assert.ok(!isValidStrictBlock(`${good}0.0.0.0 x.example\n`));
});

// --------------------------------------------------------------- macOS őr

interface Rig {
  dir: string; hosts: string; main: string; bin: string; asar: string; alive: string; script: string; kicked: string;
}

function rig(): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const dir = path.join(root, 'state');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  const app = path.join(root, 'Breaker.app', 'Contents');
  fs.mkdirSync(path.join(app, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Resources'), { recursive: true });
  const bin = path.join(app, 'MacOS', 'Breaker');
  const asar = path.join(app, 'Resources', 'app.asar');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(asar, 'asar');
  const main = path.join(root, 'main.plist');
  fs.writeFileSync(main, `${bin}\n${asar}/dist/helper/index.js\n`);
  // PlistBuddy: a „leíró” első sora a bináris, a második a belépési pont.
  const pb = path.join(root, 'PlistBuddy');
  fs.writeFileSync(pb, '#!/bin/sh\ncase "$2" in *:0) sed -n 1p "$3";; *:1) sed -n 2p "$3";; *) exit 1;; esac\n', { mode: 0o755 });
  // launchctl: ha a jelzőfájl megvan, a segéd fut.
  const alive = path.join(root, 'alive');
  const lctl = path.join(root, 'launchctl');
  const kicked = path.join(root, 'kicked');
  fs.writeFileSync(lctl, `#!/bin/sh\n[ "$2" = system/${DAEMON_LABEL} ] || exit 113\nif [ "$1" = kickstart ]; then echo "$2" >> ${shQuote(kicked)}; exit 0; fi\nif [ -f ${shQuote(alive)} ]; then printf '\\tstate = running\\n\\tpid = 4242\\n'; else printf '\\tstate = not running\\n'; fi\n`, { mode: 0o755 });
  const hosts = path.join(root, 'hosts');
  fs.writeFileSync(hosts, `127.0.0.1 localhost\n255.255.255.255 broadcasthost\n\n${buildManagedBlock(['old.example'], 'darwin')}\n`);
  const script = path.join(root, 'guard.sh');
  fs.writeFileSync(script, macGuardScript({
    ...MAC_GUARD_DEFAULTS,
    dir, main, hosts, plistBuddy: pb, launchctl: lctl, settleSeconds: 0,
    ownerUid: process.getuid ? process.getuid() : 0, trustChain: [], flush: 'true',
  }));
  fs.writeFileSync(path.join(dir, STRICT_FILE), renderStrictBlock(['old.example', 'paused.example', 'www.paused.example'], NOTE), { mode: 0o600 });
  return { dir, hosts, main, bin, asar, alive, script, kicked };
}

function runGuard(r: Rig): void {
  execFileSync('/bin/dash', [r.script], { stdio: 'pipe' });
}

const strictOf = (r: Rig) => fs.readFileSync(path.join(r.dir, STRICT_FILE), 'utf8');
const region = (hosts: string) => {
  const a = hosts.indexOf(MARKER_BEGIN);
  const b = hosts.indexOf(MARKER_END);
  return a < 0 ? '' : hosts.slice(a, b + MARKER_END.length);
};

test('macOS-őr: amíg az app a helyén van, nem nyúl a hosts fájlhoz (ellenpróba)', () => {
  const r = rig();
  fs.writeFileSync(r.alive, '');
  const before = fs.readFileSync(r.hosts, 'utf8');
  runGuard(r);
  assert.equal(fs.readFileSync(r.hosts, 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(r.dir, 'guard.log')));
  assert.ok(!fs.existsSync(r.kicked), 'a futó segédet nem indítja újra');
});

test('macOS-őr: ha az app a helyén van, de a segéd nem fut, elindítja — a hosts fájlhoz akkor sem nyúl', () => {
  // Visszatett app: a launchd a hiányzó binárisnál feladhatta az indítást.
  const r = rig();
  const before = fs.readFileSync(r.hosts, 'utf8');
  runGuard(r);
  assert.equal(fs.readFileSync(r.hosts, 'utf8'), before);
  assert.equal(fs.readFileSync(r.kicked, 'utf8'), `system/${DAEMON_LABEL}\n`);
  assert.match(fs.readFileSync(path.join(r.dir, 'guard.log'), 'utf8'), /a segéd nem futott: elindítottam/);
});

test('macOS-őr: ha az app eltűnt, de a segéd még fut (a törölt fájlból), nem ír', () => {
  const r = rig();
  fs.rmSync(path.dirname(path.dirname(r.bin)), { recursive: true });
  fs.writeFileSync(r.alive, '');
  const before = fs.readFileSync(r.hosts, 'utf8');
  runGuard(r);
  assert.equal(fs.readFileSync(r.hosts, 'utf8'), before);
});

test('macOS-őr: ha az app eltűnt és a segéd nem fut, a szigorú blokk kerül a helyére — a szüneteltetett oldal is tilt', () => {
  const r = rig();
  fs.rmSync(path.dirname(path.dirname(r.bin)), { recursive: true });
  runGuard(r);
  const after = fs.readFileSync(r.hosts, 'utf8');
  assert.ok(after.startsWith('127.0.0.1 localhost\n255.255.255.255 broadcasthost\n\n'), 'a hosts többi része a helyén');
  assert.equal(`${region(after)}\n`, strictOf(r));
  assert.ok(after.includes('0.0.0.0 paused.example'));
  assert.equal(after.split(MARKER_BEGIN).length, 2, 'egy blokk, nem kettő');
  assert.match(fs.readFileSync(path.join(r.dir, 'guard.log'), 'utf8'), /a szigorú blokk a helyén/);
  // Másodszor: nincs változás, nincs újabb naplósor.
  runGuard(r);
  assert.equal(fs.readFileSync(r.hosts, 'utf8'), after);
  assert.equal(fs.readFileSync(path.join(r.dir, 'guard.log'), 'utf8').trim().split('\n').length, 1);
  // Kézi kivétel után visszateszi.
  fs.writeFileSync(r.hosts, '127.0.0.1 localhost\n');
  runGuard(r);
  assert.equal(`${region(fs.readFileSync(r.hosts, 'utf8'))}\n`, strictOf(r));
  assert.ok(fs.readFileSync(r.hosts, 'utf8').startsWith('127.0.0.1 localhost\n\n'));
});

test('macOS-őr: a futtathatatlan bináris vagy a hiányzó app.asar is eltűnt app', () => {
  const a = rig();
  fs.chmodSync(a.bin, 0o644);
  runGuard(a);
  assert.ok(fs.readFileSync(a.hosts, 'utf8').includes('0.0.0.0 paused.example'));
  const b = rig();
  fs.rmSync(b.asar);
  runGuard(b);
  assert.ok(fs.readFileSync(b.hosts, 'utf8').includes('0.0.0.0 paused.example'));
});

test('macOS-őr: nem megbízható vagy idegen szigorú blokk — nem ír, és naplózza', () => {
  for (const [label, spoil, expectLog] of [
    ['idegen cím', (r: Rig) => fs.writeFileSync(path.join(r.dir, STRICT_FILE), strictOf(r).replace('0.0.0.0 paused.example', '1.2.3.4 paused.example')), /idegen sor/],
    ['csoport is írhatja', (r: Rig) => fs.chmodSync(path.join(r.dir, STRICT_FILE), 0o660), /nem megbízható/],
    ['a mappát más is írhatja', (r: Rig) => fs.chmodSync(r.dir, 0o777), /állapotmappa nem megbízható/],
    ['hibás jelölő', (r: Rig) => fs.writeFileSync(path.join(r.dir, STRICT_FILE), strictOf(r).replace(MARKER_END, '# vége')), /jelölői hibásak/],
    ['szimbolikus link', (r: Rig) => {
      const f = path.join(r.dir, STRICT_FILE);
      fs.renameSync(f, `${f}.real`);
      fs.symlinkSync(`${f}.real`, f);
    }, /nem megbízható/],
  ] as const) {
    const r = rig();
    fs.rmSync(path.dirname(path.dirname(r.bin)), { recursive: true });
    spoil(r);
    const before = fs.readFileSync(r.hosts, 'utf8');
    runGuard(r);
    assert.equal(fs.readFileSync(r.hosts, 'utf8'), before, label);
    assert.match(fs.readFileSync(path.join(r.dir, 'guard.log'), 'utf8'), expectLog, label);
  }
});

test('macOS-őr: ahol nem tud dönteni, ott nem ír (nincs segéd, leválasztott kötet, áthelyezett app, felemás hosts)', () => {
  const cases: Array<[string, (r: Rig) => void]> = [
    ['nincs segéd-leíró', (r) => fs.rmSync(r.main)],
    ['leválasztott kötet', (r) => fs.writeFileSync(r.main, '/Volumes/NincsIlyen/Breaker.app/Contents/MacOS/Breaker\n/Volumes/NincsIlyen/Breaker.app/Contents/Resources/app.asar/dist/helper/index.js\n')],
    ['App Translocation', (r) => fs.writeFileSync(r.main, '/private/var/folders/x/AppTranslocation/y/d/Breaker.app/Contents/MacOS/Breaker\n/private/var/folders/x/AppTranslocation/y/d/Breaker.app/Contents/Resources/app.asar/dist/helper/index.js\n')],
    ['nincs szigorú blokk', (r) => fs.rmSync(path.join(r.dir, STRICT_FILE))],
    ['felemás jelölők a hostsban', (r) => fs.writeFileSync(r.hosts, `127.0.0.1 localhost\n${MARKER_BEGIN}\n0.0.0.0 old.example\n`)],
  ];
  for (const [label, setup] of cases) {
    const r = rig();
    fs.rmSync(path.dirname(path.dirname(r.bin)), { recursive: true });
    setup(r);
    const before = fs.readFileSync(r.hosts, 'utf8');
    runGuard(r);
    assert.equal(fs.readFileSync(r.hosts, 'utf8'), before, label);
  }
});

test('macOS-őr: a leíró percenként futtatja, KeepAlive és naplóút nélkül', () => {
  const plist = macGuardPlist();
  assert.ok(plist.includes(`<key>Label</key><string>${GUARD_LABEL}</string>`));
  assert.ok(plist.includes('<string>/bin/sh</string>'));
  assert.ok(plist.includes('<string>/Library/Application Support/Breaker/guard.sh</string>'));
  assert.ok(plist.includes('<key>StartInterval</key><integer>60</integer>'));
  assert.ok(plist.includes('<key>RunAtLoad</key><true/>'));
  for (const banned of ['KeepAlive', 'StandardOutPath', 'StandardErrorPath', 'WatchPaths']) assert.ok(!plist.includes(banned), banned);
  const script = macGuardScript();
  // Semmi nem a PATH-ból, és a futás vizsgálata a launchd-é, nem egy folyamatlista.
  assert.ok(script.includes("PB='/usr/libexec/PlistBuddy'") && script.includes("LCTL='/bin/launchctl'"));
  for (const banned of ['pgrep', 'ps -', 'awk -v']) assert.ok(!script.includes(banned), banned);
  assert.ok(script.includes(`print system/${DAEMON_LABEL}`));
});

// ------------------------------------------------------------- Windows őr

test('Windows-őr: csak ASCII, semmi a PATH-ból, és a segéd feladatából olvassa, hol az app', () => {
  const s = windowsGuardScript();
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(s), 'nem ASCII karakter az őrben');
  assert.ok(s.startsWith('# Breaker guard'));
  const lines = s.split('\r\n');
  assert.equal(lines[2], '$env:PATH = "$env:SystemRoot\\System32;$env:SystemRoot"');
  assert.equal(lines[3], '$env:PSModulePath = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules"');
  assert.ok(s.includes(`ScheduledTasks\\Get-ScheduledTask -TaskName '${TASK_NAME}'`));
  assert.ok(s.includes("& (Join-Path $sys 'ipconfig.exe') /flushdns"));
  assert.ok(!/schtasks|Invoke-Expression/i.test(s));
  // A jelölők base64-ből, bájtra (Latin-1) — a fájl ASCII marad.
  const m = s.match(/\$B = D '([A-Za-z0-9+/=]+)'/);
  assert.ok(m && Buffer.from(m[1], 'base64').toString('utf8') === MARKER_BEGIN);
  // Tartósan eltűnt: két ütemezett futás (öt perc) — egy frissítés nem állítja be.
  assert.ok(s.includes('$durable = 270'));
  // Telepítő fut-e: csak a mi nevünk. Egy állandóan futó idegen „…Setup”
  // folyamat (gyártói szolgáltatás) különben örökre kikapcsolná az őrt.
  const inst = s.match(/\$_\.ProcessName -match '([^']+)'/);
  assert.ok(inst, 'nincs telepítő-minta');
  const re = new RegExp(inst[1], 'i'); // a PowerShell -match kis-nagybetűre érzéketlen
  for (const name of ['Breaker Setup 0.4.258', 'Breaker-Setup-0.4.258', 'Uninstall Breaker', 'Un_A', 'Au_']) {
    assert.ok(re.test(name), `nem ismeri fel: ${name}`);
  }
  for (const name of ['AsusSetup', 'SetupHost', 'OneDriveSetup', 'MsiExec', 'Uninstaller', 'Breaker']) {
    assert.ok(!re.test(name), `idegen folyamatra is vár: ${name}`);
  }
});

test('Windows-őr feladata: a rendszer PowerShellje, SYSTEM, induláskor és ötpercenként', () => {
  const r = windowsGuardRegisterScript('C:\\Program Files\\Breaker Guard\\guard.ps1');
  assert.ok(r.includes("Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'"));
  assert.ok(r.includes('-File "C:\\Program Files\\Breaker Guard\\guard.ps1"'));
  assert.ok(r.includes('New-ScheduledTaskTrigger -AtStartup'));
  assert.ok(r.includes('-RepetitionInterval (New-TimeSpan -Minutes 5)'));
  assert.ok(r.includes("-UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest"));
  assert.ok(r.includes(`-TaskName '${GUARD_TASK_NAME}'`));
  assert.ok(!r.includes('"C:\\Program Files\\Breaker Guard\\guard.ps1" ') && !/schtasks/i.test(r));
});
