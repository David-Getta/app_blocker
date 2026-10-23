// A segéd őre (shared/guard-script.ts) és a szigorú blokk (shared/strict-block.ts).
//
// A macOS-őrt itt ÉLESBEN futtatjuk, dash-sel (a macOS /bin/sh-ja is POSIX):
// csonkolt PlistBuddy-val (a segéd leírójából a bináris és a belépési pont) és
// launchctl-lel (fut-e a segéd, kit indít el), egy ideiglenes hosts fájlon, és
// megszámoljuk, hányszor ürítené a DNS-gyorsítótárat. A Windows-őrt a
// CI-próba futtatja élesben; itt a szövegét nézzük.

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { MARKER_BEGIN, MARKER_END, buildManagedBlock } from '../src/shared/blocklist';
import {
  GUARD_DEAD_FILE, GUARD_GONE_FILE, GUARD_LABEL, GUARD_TASK_NAME, MAC_GUARD_DEFAULTS, macGuardPlist, macGuardScript,
  shQuote, STRICT_FILE, windowsGuardLoader, windowsGuardRegisterScript, windowsGuardScript,
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

test('a szigorú blokk a kész hosts-blokk: jelölők, magyarázó sor, tiltó sorok', () => {
  const text = renderStrictBlock(['a.example', 'b.example'], NOTE);
  const lines = text.split('\n');
  assert.equal(lines[0], MARKER_BEGIN);
  assert.ok(lines[1].startsWith('# Breaker: a védelem segédje nem fut'));
  assert.ok(lines[1].includes('a teljes lista tilt'));
  assert.ok(lines.includes('0.0.0.0 a.example') && lines.includes(':: b.example'));
  assert.equal(lines[lines.length - 2], MARKER_END);
  assert.ok(text.endsWith('\n'));
  assert.ok(isValidStrictBlock(text));
  // A blokk többi része ugyanaz, mint a segédé.
  assert.equal(text.replace(`${lines[1]}\n`, ''), `${buildManagedBlock(['a.example', 'b.example'], 'darwin')}\n`);
  // Üres listánál semmi — egy magányos megjegyzést se írjon az őr a hosts fájlba.
  assert.equal(renderStrictBlock([], NOTE), '');
  // Méretkorlát nincs: egy nagyon hosszú lista is érvényes blokk (a korlát
  // ingyenes kiskapu volt — utána az őr semmit nem írt).
  const many = Array.from({ length: 30000 }, (_, i) => `${'a'.repeat(60)}${i}.example`);
  assert.ok(isValidStrictBlock(renderStrictBlock(many, NOTE)));
});

test('a blokk alakja: idegen cím, hibás jelölő, csonka fájl — nem érvényes', () => {
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
  root: string; dir: string; hosts: string; main: string; bin: string; asar: string; alive: string; script: string;
  kicked: string; flushes: string; flap: string;
}

const DEAD_SECONDS = 300;

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
  // launchctl: ha a jelzőfájl megvan, a segéd fut; a kickstartot feljegyzi.
  const alive = path.join(root, 'alive');
  const kicked = path.join(root, 'kicked');
  const lctl = path.join(root, 'launchctl');
  // „flap”: egy újra és újra összeomló segéd — minden megnézéskor más azonosító.
  const flap = path.join(root, 'flap');
  fs.writeFileSync(lctl, [
    '#!/bin/sh',
    `[ "$2" = system/${DAEMON_LABEL} ] || exit 113`,
    `if [ "$1" = kickstart ]; then echo "$2" >> ${shQuote(kicked)}; exit 0; fi`,
    `if [ -f ${shQuote(flap)} ]; then n=$(cat ${shQuote(flap)}); echo $((n + 1)) > ${shQuote(flap)}; printf '\\tstate = running\\n\\tpid = %s\\n' "$n"; exit 0; fi`,
    `if [ -f ${shQuote(alive)} ]; then printf '\\tstate = running\\n\\tpid = 4242\\n'; else printf '\\tstate = not running\\n'; fi`,
    '',
  ].join('\n'), { mode: 0o755 });
  const hosts = path.join(root, 'hosts');
  fs.writeFileSync(hosts, `127.0.0.1 localhost\n255.255.255.255 broadcasthost\n\n${buildManagedBlock(['old.example'], 'darwin')}\n`);
  const flushes = path.join(root, 'flushes');
  const script = path.join(root, 'guard.sh');
  fs.writeFileSync(script, macGuardScript({
    ...MAC_GUARD_DEFAULTS,
    dir, main, hosts, plistBuddy: pb, launchctl: lctl, settleSeconds: 0, deadSeconds: DEAD_SECONDS, pidCheckSeconds: 0,
    ownerUid: process.getuid ? process.getuid() : 0, trustChain: [], flush: `echo x >> ${shQuote(flushes)}`,
  }));
  fs.writeFileSync(path.join(dir, STRICT_FILE), renderStrictBlock(['old.example', 'paused.example', 'www.paused.example'], NOTE), { mode: 0o600 });
  return { root, dir, hosts, main, bin, asar, alive, script, kicked, flushes, flap };
}

function runGuard(r: Rig): void {
  execFileSync(process.env.GUARD_SH || '/bin/dash', [r.script], { stdio: 'pipe' });
}

const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const strictOf = (r: Rig) => fs.readFileSync(path.join(r.dir, STRICT_FILE), 'utf8');
const logOf = (r: Rig) => read(path.join(r.dir, 'guard.log'));
const flushCount = (r: Rig) => read(r.flushes).split('\n').filter(Boolean).length;
const region = (hosts: string) => {
  const a = hosts.indexOf(MARKER_BEGIN);
  const b = hosts.indexOf(MARKER_END);
  return a < 0 ? '' : hosts.slice(a, b + MARKER_END.length);
};
const deleteApp = (r: Rig) => fs.rmSync(path.dirname(path.dirname(r.bin)), { recursive: true });
/** A blokk, ahogy az őr írja: a jelölők, a megjegyzés, a tiltó sorok bájtsorrendben. */
const expectedRegion = (names: string[], note = NOTE) => [
  MARKER_BEGIN, note,
  ...names.map((n) => `0.0.0.0 ${n}`).sort(), ...names.map((n) => `:: ${n}`).sort(),
  MARKER_END,
].join('\n');

test('macOS-őr: amíg a segéd fut, semmihez nem nyúl (ellenpróba)', () => {
  const r = rig();
  fs.writeFileSync(r.alive, '');
  const before = read(r.hosts);
  runGuard(r);
  assert.equal(read(r.hosts), before);
  assert.equal(logOf(r), '');
  assert.ok(!fs.existsSync(r.kicked), 'a futó segédet nem indítja újra');
  assert.ok(!fs.existsSync(path.join(r.dir, GUARD_DEAD_FILE)));
});

test('macOS-őr: ha az app eltűnt, de a segéd még fut (a törölt fájlból), nem ír', () => {
  const r = rig();
  deleteApp(r);
  fs.writeFileSync(r.alive, '');
  const before = read(r.hosts);
  runGuard(r);
  assert.equal(read(r.hosts), before);
});

test('macOS-őr: ha az app eltűnt és a segéd nem fut, a szigorú blokk kerül a helyére — a szüneteltetett oldal is tilt', () => {
  const r = rig();
  deleteApp(r);
  runGuard(r);
  const after = read(r.hosts);
  assert.ok(after.startsWith('127.0.0.1 localhost\n255.255.255.255 broadcasthost\n\n'), 'a hosts többi része a helyén');
  assert.equal(region(after), expectedRegion(['old.example', 'paused.example', 'www.paused.example']));
  assert.equal(after.split(MARKER_BEGIN).length, 2, 'egy blokk, nem kettő');
  assert.match(logOf(r), /az app nem található: a szigorú blokk a helyén/);
  assert.equal(flushCount(r), 1);
  // Másodszor: nincs írás, nincs DNS-ürítés, nincs újabb naplósor.
  const st = fs.statSync(r.hosts);
  runGuard(r);
  assert.equal(read(r.hosts), after);
  assert.equal(fs.statSync(r.hosts).mtimeMs, st.mtimeMs);
  assert.equal(flushCount(r), 1, 'a változatlan blokkot újraírta (és a DNS-t is ürítette)');
  assert.equal(logOf(r).trim().split('\n').length, 1);
  // Kézi kivétel után visszateszi.
  fs.writeFileSync(r.hosts, '127.0.0.1 localhost\n');
  runGuard(r);
  assert.equal(region(read(r.hosts)), expectedRegion(['old.example', 'paused.example', 'www.paused.example']));
  assert.ok(read(r.hosts).startsWith('127.0.0.1 localhost\n\n'));
  assert.equal(flushCount(r), 2);
});

test('macOS-őr: unió — egy elavult szigorú blokk sem vesz ki egy épp tiltott nevet', () => {
  const r = rig();
  // Az élő blokkban egy újabb név, ami a (régebbi segéd után elavult) szigorú blokkból hiányzik.
  fs.writeFileSync(r.hosts, `127.0.0.1 localhost\n\n${buildManagedBlock(['new.example', 'old.example'], 'darwin')}\n`);
  deleteApp(r);
  runGuard(r);
  assert.equal(region(read(r.hosts)), expectedRegion(['new.example', 'old.example', 'paused.example', 'www.paused.example']));
});

test('macOS-őr: a futtathatatlan bináris vagy a hiányzó app.asar is eltűnt app', () => {
  const a = rig();
  fs.chmodSync(a.bin, 0o644);
  runGuard(a);
  assert.ok(read(a.hosts).includes('0.0.0.0 paused.example'));
  const b = rig();
  fs.rmSync(b.asar);
  runGuard(b);
  assert.ok(read(b.hosts).includes('0.0.0.0 paused.example'));
});

test('macOS-őr: ha az app a helyén van, de a segéd nem indul, elindítja — és öt perc után a szigorú blokk áll be', () => {
  const r = rig();
  const before = read(r.hosts);
  const stamp = path.join(r.dir, GUARD_DEAD_FILE);
  // Első észlelés: elindítja, feljegyzi, a hosts fájlhoz nem nyúl.
  runGuard(r);
  assert.equal(read(r.hosts), before);
  assert.equal(read(r.kicked), `system/${DAEMON_LABEL}\n`);
  assert.match(logOf(r), /a segéd nem futott: elindítottam/);
  assert.match(read(stamp), /^\d+\n$/);
  // Még nem telt el öt perc: semmi.
  runGuard(r);
  assert.equal(read(r.hosts), before);
  // Öt perce nem indul: a szigorú blokk áll be (a befagyott helyett).
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(stamp, `${now - DEAD_SECONDS - 5}\n`);
  runGuard(r);
  assert.equal(region(read(r.hosts)), expectedRegion(['old.example', 'paused.example', 'www.paused.example']));
  assert.match(logOf(r), /a segéd nem indul: a szigorú blokk a helyén/);
  // A segéd újra fut: a bélyeg megy.
  fs.writeFileSync(r.alive, '');
  runGuard(r);
  assert.ok(!fs.existsSync(stamp));
});

test('macOS-őr: az újra és újra összeomló segéd nem „él” — a pillanatnyi azonosító nem állítja vissza az órát', () => {
  const r = rig();
  fs.writeFileSync(r.flap, '100');
  const stamp = path.join(r.dir, GUARD_DEAD_FILE);
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(stamp, `${now - DEAD_SECONDS - 5}\n`);
  runGuard(r);
  assert.ok(fs.existsSync(stamp), 'a bélyeg maradt (nem vette élőnek)');
  assert.equal(region(read(r.hosts)), expectedRegion(['old.example', 'paused.example', 'www.paused.example']));
});

test('macOS-őr: a visszaállított óra nem halasztja — a jövőbeli bélyeget a mostani időre írja', () => {
  const r = rig();
  const stamp = path.join(r.dir, GUARD_DEAD_FILE);
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(stamp, `${now + 10 * 365 * 86400}\n`);
  runGuard(r);
  const written = Number(read(stamp).trim());
  assert.ok(Math.abs(written - now) < 60, `a bélyeg: ${written}`);
  // Szemét a bélyegben: szintén most kezdődik.
  fs.writeFileSync(stamp, 'nem szám\n');
  runGuard(r);
  assert.match(read(stamp), /^\d+\n$/);
});

test('macOS-őr: felemás jelölők és hiányzó hosts — rendbe teszi, nem hagyja annyiban', () => {
  for (const [label, hosts] of [
    ['csak a nyitó jelölő maradt', `127.0.0.1 localhost\n${MARKER_BEGIN}\n# saját sor\n`],
    ['csak a záró jelölő maradt', `127.0.0.1 localhost\n${MARKER_END}\n# saját sor\n`],
    ['fordított sorrend', `127.0.0.1 localhost\n${MARKER_END}\n# saját sor\n${MARKER_BEGIN}\n`],
  ] as const) {
    const r = rig();
    deleteApp(r);
    fs.writeFileSync(r.hosts, hosts);
    runGuard(r);
    const after = read(r.hosts);
    assert.equal(region(after), expectedRegion(['old.example', 'paused.example', 'www.paused.example']), label);
    assert.equal(after.split(MARKER_BEGIN).length, 2, `${label}: egy nyitó jelölő`);
    assert.equal(after.split(MARKER_END).length, 2, `${label}: egy záró jelölő`);
    assert.ok(after.startsWith('127.0.0.1 localhost\n# saját sor\n\n'), `${label}: a többi sor marad: ${after}`);
    assert.match(logOf(r), /felemások voltak/, label);
  }
  // A hosts fájl hiányzik: alap hosts + a szigorú blokk, olvasható jogokkal.
  const r = rig();
  deleteApp(r);
  fs.rmSync(r.hosts);
  runGuard(r);
  const after = read(r.hosts);
  assert.ok(after.startsWith('127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n::1'), after);
  assert.equal(region(after), expectedRegion(['old.example', 'paused.example', 'www.paused.example']));
  assert.equal(fs.statSync(r.hosts).mode & 0o777, 0o644);
});

test('macOS-őr: idegen sor a szigorú blokkban — kihagyja, a többit beírja; csupa szemétnél nem ír', () => {
  const r = rig();
  deleteApp(r);
  const f = path.join(r.dir, STRICT_FILE);
  fs.writeFileSync(f, strictOf(r)
    .replace('0.0.0.0 paused.example', '1.2.3.4 paused.example')
    .replace(MARKER_END, `0.0.0.0 a.example b.example\nfoo\n${MARKER_END}`), { mode: 0o600 });
  runGuard(r);
  const after = read(r.hosts);
  assert.ok(!after.includes('1.2.3.4'), 'más címre irányított név nem kerülhet be');
  assert.ok(!after.includes('a.example b.example') && !after.includes('\nfoo\n'));
  assert.ok(after.includes(':: paused.example') && after.includes('0.0.0.0 www.paused.example'));
  assert.match(logOf(r), /idegen sorait kihagytam: 3/);
  // Egy tiltó sor sincs benne: nem ír (egy üres blokk lazítás volna).
  const z = rig();
  deleteApp(z);
  fs.writeFileSync(path.join(z.dir, STRICT_FILE), `${MARKER_BEGIN}\n# csak megjegyzés\n1.2.3.4 x.example\n${MARKER_END}\n`, { mode: 0o600 });
  const before = read(z.hosts);
  runGuard(z);
  assert.equal(read(z.hosts), before);
  assert.match(logOf(z), /nincs tiltó sor/);
});

test('macOS-őr: nem megbízható szigorú blokk vagy mappa — nem ír', () => {
  for (const [label, spoil, expectLog] of [
    ['csoport is írhatja', (r: Rig) => fs.chmodSync(path.join(r.dir, STRICT_FILE), 0o660), /nem megbízható/],
    ['más is írhatja', (r: Rig) => fs.chmodSync(path.join(r.dir, STRICT_FILE), 0o606), /nem megbízható/],
    // A saját üzenete van: Linuxon a link 0777-es, a find magától is elutasítaná —
    // így a teszt csak a `-L` vizsgálattal megy át.
    ['szimbolikus link', (r: Rig) => {
      const f = path.join(r.dir, STRICT_FILE);
      fs.renameSync(f, `${f}.real`);
      fs.symlinkSync(`${f}.real`, f);
    }, /szimbolikus link/],
    // A mappa nem megbízható: oda naplót sem ír.
    ['a mappát más is írhatja', (r: Rig) => fs.chmodSync(r.dir, 0o777), null],
  ] as const) {
    const r = rig();
    deleteApp(r);
    spoil(r);
    const before = read(r.hosts);
    runGuard(r);
    assert.equal(read(r.hosts), before, label);
    if (expectLog) assert.match(logOf(r), expectLog, label);
    else assert.equal(logOf(r), '', `${label}: nem megbízható mappába nem naplózhat`);
  }
});

test('macOS-őr: ahol nem tud dönteni, ott nem ír (nincs segéd, leválasztott kötet, karantén, nincs szigorú blokk)', () => {
  const cases: Array<[string, (r: Rig) => void]> = [
    ['nincs segéd-leíró', (r) => fs.rmSync(r.main)],
    ['leválasztott kötet', (r) => fs.writeFileSync(r.main, '/Volumes/NincsIlyen/Breaker.app/Contents/MacOS/Breaker\n/Volumes/NincsIlyen/Breaker.app/Contents/Resources/app.asar/dist/helper/index.js\n')],
    ['App Translocation', (r) => fs.writeFileSync(r.main, '/private/var/folders/x/AppTranslocation/y/d/Breaker.app/Contents/MacOS/Breaker\n/private/var/folders/x/AppTranslocation/y/d/Breaker.app/Contents/Resources/app.asar/dist/helper/index.js\n')],
    ['nincs szigorú blokk', (r) => fs.rmSync(path.join(r.dir, STRICT_FILE))],
  ];
  for (const [label, setup] of cases) {
    const r = rig();
    deleteApp(r);
    setup(r);
    const before = read(r.hosts);
    runGuard(r);
    assert.equal(read(r.hosts), before, label);
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
  for (const banned of ['pgrep', 'ps -', 'awk -v', 'wc -c < "$STRICT"']) assert.ok(!script.includes(banned), banned);
  assert.ok(script.includes(`print system/${DAEMON_LABEL}`));
  assert.ok(script.includes('deadSeconds') === false && script.includes('-ge 300 ]'), 'öt perc a nem induló segédre');
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
  assert.ok(s.includes('$deadAfter = 600'));
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
  // …és egy nyitva hagyott eltávolító-ablak se tartsa örökké: legfeljebb fél óra.
  assert.ok(s.includes('$installCap = 1800'));
  assert.ok(s.includes('if ((Installing) -and $goneFor -lt $installCap) { exit 0 }'));
  assert.ok(s.includes('if ((Installing) -and $deadFor -lt $installCap) { exit 0 }'));
});

test('Windows-őr: a segéd állapotmappájába nem ír — a bélyeg és a napló a saját mappájában', () => {
  // Ha a ProgramData\Breaker eltűnik, egy sima felhasználó újra létrehozhatja,
  // és egy SYSTEM-írást máshova irányíthatna: oda az őr csak olvas.
  const s = windowsGuardScript();
  assert.ok(s.includes("$guardDir = Join-Path $pf 'Breaker Guard'"));
  assert.ok(s.includes(`$goneMark = Join-Path $guardDir '${GUARD_GONE_FILE}'`));
  assert.ok(s.includes(`$deadMark = Join-Path $guardDir '${GUARD_DEAD_FILE}'`));
  assert.ok(s.includes("$logFile = Join-Path $guardDir 'guard.log'"));
  assert.ok(!/Join-Path \$stateDir '(?!strict-hosts')/.test(s), 'az állapotmappában a szigorú blokkon kívül semmit nem érinthet');
  // A saját mappáját is ellenőrzi, mielőtt bármit írna.
  assert.ok(s.includes('try { $guardOk = Trusted-Dir $guardDir } catch { }'));
  assert.ok(s.includes('  if (-not $guardOk) { exit 0 }'));
  assert.ok(s.includes('if (-not $guardOk) { return }'));
  // Az állapotmappát olvasás előtt: nem csatolási pont, a SYSTEM-é vagy a rendszergazdáké.
  assert.ok(s.includes('if (-not (Trusted-Dir $stateDir))'));
});

test('Windows-őr: a futó segédet nem írja felül; a hiányzó meghajtó eltűnés; unió; felemás jelölő; óra', () => {
  const s = windowsGuardScript();
  // A futó segéd: soha nem ír (egy átnevezett, futó exe se váltakozzon vele).
  assert.ok(s.includes("if ([string]$t.State -eq 'Running') { return @{ s = 'alive' } }"));
  assert.ok(s.indexOf("return @{ s = 'alive' }") < s.indexOf("return @{ s = 'gone' }"));
  // A kihúzott meghajtó nem „semleges” többé: eltűnt app.
  assert.ok(!s.includes('GetPathRoot'), 'a hiányzó meghajtó ne tegye tétlenné az őrt');
  // Unió: a hosts régi blokkjának tiltó sorai is a halmazba kerülnek.
  assert.ok(s.includes('if ($in) { $cur.Add($l); if ($l -cmatch $BlockRe) { [void]$set.Add($l) } } else { $out.Add($l) }'));
  // Felemás jelölők: csak a jelölő-sorok mennek, és a blokk akkor is beíródik.
  assert.ok(s.includes('foreach ($l in $lines) { if ($l -cne $B -and $l -cne $E) { $out.Add($l) } }'));
  // Hiányzó hosts: üres listával indul, és ír.
  assert.ok(s.includes('if ([IO.File]::Exists($hostsFile)) { $lines = Lines ([IO.File]::ReadAllBytes($hostsFile)) }'));
  // Idegen sor: kimarad, nem akasztja meg az egészet; méretkorlát nincs.
  assert.ok(s.includes('else { $foreign++ }'));
  assert.ok(!/\$bytes\.Length -gt/.test(s));
  // A jövőbeli bélyeg (visszaállított óra) a mostani időre íródik.
  assert.ok(s.includes('if ($null -eq $since -or $since -gt $now) { [IO.File]::WriteAllText($p, $now.ToString(\'o\')); return 0 }'));
});

test('Windows-őr feladata: a rendszer PowerShellje, SYSTEM, induláskor és ötpercenként — szkriptfájl nélkül', () => {
  const guardPath = 'C:\\Program Files\\Breaker Guard\\guard.ps1';
  const r = windowsGuardRegisterScript(guardPath);
  assert.ok(r.includes("Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'"));
  assert.ok(r.includes('New-ScheduledTaskTrigger -AtStartup'));
  assert.ok(r.includes('-RepetitionInterval (New-TimeSpan -Minutes 5)'));
  assert.ok(r.includes("-UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest"));
  assert.ok(r.includes(`-TaskName '${GUARD_TASK_NAME}'`));
  assert.ok(!/schtasks/i.test(r));
  // Nem -File: egy „csak aláírt szkript” csoportházirend azt letiltaná, és az
  // őr csendben sosem futna. A parancs a fájlt szkriptblokként indítja.
  assert.ok(!r.includes('-File') && !r.includes('-ExecutionPolicy'));
  const m = r.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/);
  assert.ok(m, 'nincs kódolt parancs');
  const loader = Buffer.from(m[1], 'base64').toString('utf16le');
  assert.equal(loader, windowsGuardLoader(guardPath));
  assert.equal(loader, "& ([ScriptBlock]::Create([IO.File]::ReadAllText('C:\\Program Files\\Breaker Guard\\guard.ps1')))");
});
