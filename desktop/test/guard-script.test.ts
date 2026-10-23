// A segéd őre (shared/guard-script.ts) és a szigorú blokk (shared/strict-block.ts).
//
// A macOS-őrt itt ÉLESBEN futtatjuk, dash-sel (a macOS /bin/sh-ja is POSIX):
// csonkolt PlistBuddy-val (a segéd leírójából a bináris és a belépési pont) és
// launchctl-lel (fut-e a segéd, kit indít el), egy ideiglenes hosts fájlon, és
// megszámoljuk, hányszor ürítené a DNS-gyorsítótárat. A Windows-őr hosts-írását
// (Apply-Strict) PowerShell 7-tel futtatjuk, és ugyanarra a hosts fájlra a két őr
// eredményét összevetjük; a többi részét (Feladatütemező, jogok) a CI-próba
// futtatja élesben Windowson, itt a szövegét nézzük.

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { MARKER_BEGIN, MARKER_END, buildManagedBlock } from '../src/shared/blocklist';
import {
  GUARD_DEAD_FILE, GUARD_GONE_FILE, GUARD_LABEL, GUARD_TASK_NAME, MAC_GUARD_DEFAULTS, macGuardPlist, macGuardScript,
  shQuote, STRICT_FILE, WINDOWS_GUARD_DEFAULTS, windowsGuardLoader, windowsGuardRegisterScript, windowsGuardScript,
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
  kicked: string; flushes: string; flap: string; aliveAfter: string;
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
  const aliveAfter = path.join(root, 'aliveAfter');
  const calls = path.join(root, 'calls');
  fs.writeFileSync(lctl, [
    '#!/bin/sh',
    `[ "$2" = system/${DAEMON_LABEL} ] || exit 113`,
    `if [ "$1" = kickstart ]; then echo "$2" >> ${shQuote(kicked)}; exit 0; fi`,
    `if [ -f ${shQuote(flap)} ]; then n=$(cat ${shQuote(flap)}); echo $((n + 1)) > ${shQuote(flap)}; printf '\\tstate = running\\n\\tpid = %s\\n' "$n"; exit 0; fi`,
    // „aliveAfter”: a segéd az N-edik megnézéstől fut (közben elindult).
    `if [ -f ${shQuote(aliveAfter)} ]; then c=$(($(cat ${shQuote(calls)} 2>/dev/null || echo 0) + 1)); echo $c > ${shQuote(calls)}; [ $c -ge $(cat ${shQuote(aliveAfter)}) ] && touch ${shQuote(alive)}; fi`,
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
  return { root, dir, hosts, main, bin, asar, alive, script, kicked, flushes, flap, aliveAfter };
}

// Minden macOS-őr teszt két héjjal fut: dash (szigorú POSIX) és bash --posix
// (a macOS /bin/sh-ja a bash, sh-módban).
const SHELLS: Array<[string, string[]]> = ([
  ['dash', ['/bin/dash']],
  ['bash --posix', ['/bin/bash', '--posix']],
] as Array<[string, string[]]>).filter(([, cmd]) => fs.existsSync(cmd[0]));
let shell: string[] = SHELLS[0][1];

function macTest(name: string, fn: () => void): void {
  for (const [label, cmd] of SHELLS) {
    test(`${name} [${label}]`, () => { shell = cmd; fn(); });
  }
}

function runGuard(r: Rig): void {
  execFileSync(shell[0], [...shell.slice(1), r.script], { stdio: 'pipe' });
}

test('az őr-teszt mindkét héjjal fut', () => {
  assert.deepEqual(SHELLS.map(([l]) => l), ['dash', 'bash --posix'], 'a CI-gépen mindkét héj kell');
});

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

macTest('macOS-őr: amíg a segéd fut, semmihez nem nyúl (ellenpróba)', () => {
  const r = rig();
  fs.writeFileSync(r.alive, '');
  const before = read(r.hosts);
  runGuard(r);
  assert.equal(read(r.hosts), before);
  assert.equal(logOf(r), '');
  assert.ok(!fs.existsSync(r.kicked), 'a futó segédet nem indítja újra');
  assert.ok(!fs.existsSync(path.join(r.dir, GUARD_DEAD_FILE)));
});

macTest('macOS-őr: ha az app eltűnt, de a segéd még fut (a törölt fájlból), nem ír', () => {
  const r = rig();
  deleteApp(r);
  fs.writeFileSync(r.alive, '');
  const before = read(r.hosts);
  runGuard(r);
  assert.equal(read(r.hosts), before);
});

macTest('macOS-őr: ha az app eltűnt és a segéd nem fut, a szigorú blokk kerül a helyére — a szüneteltetett oldal is tilt', () => {
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

macTest('macOS-őr: unió — egy elavult szigorú blokk sem vesz ki egy épp tiltott nevet', () => {
  const r = rig();
  // Az élő blokkban egy újabb név, ami a (régebbi segéd után elavult) szigorú blokkból hiányzik.
  fs.writeFileSync(r.hosts, `127.0.0.1 localhost\n\n${buildManagedBlock(['new.example', 'old.example'], 'darwin')}\n`);
  deleteApp(r);
  runGuard(r);
  assert.equal(region(read(r.hosts)), expectedRegion(['new.example', 'old.example', 'paused.example', 'www.paused.example']));
});

macTest('macOS-őr: a futtathatatlan bináris vagy a hiányzó app.asar is eltűnt app', () => {
  const a = rig();
  fs.chmodSync(a.bin, 0o644);
  runGuard(a);
  assert.ok(read(a.hosts).includes('0.0.0.0 paused.example'));
  const b = rig();
  fs.rmSync(b.asar);
  runGuard(b);
  assert.ok(read(b.hosts).includes('0.0.0.0 paused.example'));
});

macTest('macOS-őr: ha az app a helyén van, de a segéd nem indul, elindítja — és öt perc után a szigorú blokk áll be', () => {
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

macTest('macOS-őr: az újra és újra összeomló segéd nem „él” — a pillanatnyi azonosító nem állítja vissza az órát', () => {
  const r = rig();
  fs.writeFileSync(r.flap, '100');
  const stamp = path.join(r.dir, GUARD_DEAD_FILE);
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(stamp, `${now - DEAD_SECONDS - 5}\n`);
  runGuard(r);
  assert.ok(fs.existsSync(stamp), 'a bélyeg maradt (nem vette élőnek)');
  assert.equal(region(read(r.hosts)), expectedRegion(['old.example', 'paused.example', 'www.paused.example']));
});

macTest('macOS-őr: a visszaállított óra nem halasztja — a jövőbeli bélyeget a mostani időre írja', () => {
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

macTest('macOS-őr: felemás jelölők és hiányzó hosts — rendbe teszi, ahogy a segéd', () => {
  // A záró nélküli nyitó jelölő: a mögötte álló tiltó sorok és a saját
  // megjegyzésünk a blokkba kerülnek, a felhasználó többi sora (például egy
  // később hozzáfűzött saját bejegyzés) marad. A nyitó nélküli záró csak magát viszi.
  for (const [label, hosts, head] of [
    ['csak a nyitó jelölő maradt, utána saját sorok',
      `127.0.0.1 localhost\n${MARKER_BEGIN}\n# Added by Docker Desktop\n192.168.65.2 host.docker.internal\n`,
      '127.0.0.1 localhost\n# Added by Docker Desktop\n192.168.65.2 host.docker.internal\n\n'],
    ['csak a záró jelölő maradt', `127.0.0.1 localhost\n${MARKER_END}\n# saját sor\n`, '127.0.0.1 localhost\n# saját sor\n\n'],
    ['fordított sorrend', `127.0.0.1 localhost\n${MARKER_END}\n# saját sor\n${MARKER_BEGIN}\n`, '127.0.0.1 localhost\n# saját sor\n\n'],
  ] as const) {
    const r = rig();
    deleteApp(r);
    fs.writeFileSync(r.hosts, hosts);
    runGuard(r);
    const after = read(r.hosts);
    assert.equal(region(after), expectedRegion(['old.example', 'paused.example', 'www.paused.example']), label);
    assert.equal(after.split(MARKER_BEGIN).length, 2, `${label}: egy nyitó jelölő`);
    assert.equal(after.split(MARKER_END).length, 2, `${label}: egy záró jelölő`);
    assert.ok(after.startsWith(head), `${label}: ${after}`);
    assert.match(logOf(r), /felemások voltak/, label);
  }
  // Egy félbemaradt írás: a nyitó jelölő után a régi blokk darabja (a régi
  // megjegyzéssel), majd egy később hozzáfűzött saját sor. A tiltó sorok a
  // blokkba kerülnek (unió), nem maradnak kezeletlen bejegyzésként — különben se
  // a segéd, se az eltávolító nem venné ki őket soha —, a saját sor marad.
  const r = rig();
  deleteApp(r);
  fs.writeFileSync(r.hosts, `127.0.0.1 localhost\n\n${MARKER_BEGIN}\n${NOTE}\n0.0.0.0 stale.example\n:: stale.example\n10.0.0.5 nas.local\n`);
  runGuard(r);
  const after = read(r.hosts);
  assert.equal(region(after), expectedRegion(['old.example', 'paused.example', 'stale.example', 'www.paused.example']));
  assert.equal(after.slice(0, after.indexOf(MARKER_BEGIN)), '127.0.0.1 localhost\n10.0.0.5 nas.local\n\n', after);
  assert.equal(after.split('stale.example').length, 3, 'a régi tiltó sorok egyszer, a blokkban');
  // A hosts fájl hiányzik: alap hosts + a szigorú blokk, olvasható jogokkal.
  const m = rig();
  deleteApp(m);
  fs.rmSync(m.hosts);
  runGuard(m);
  const fresh = read(m.hosts);
  assert.ok(fresh.startsWith('127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n::1'), fresh);
  assert.equal(region(fresh), expectedRegion(['old.example', 'paused.example', 'www.paused.example']));
  assert.equal(fs.statSync(m.hosts).mode & 0o777, 0o644);
});

macTest('macOS-őr: CRLF sorvégű hosts — a jelölőket felismeri, egy blokk marad', () => {
  // A segéd CRLF-et is felismer (blocklist.ts); az őr se írjon mellé egy másodikat.
  const r = rig();
  deleteApp(r);
  fs.writeFileSync(r.hosts, `127.0.0.1 localhost\r\n\r\n${buildManagedBlock(['old.example'], 'darwin').replace(/\n/g, '\r\n')}\r\n`);
  runGuard(r);
  const after = read(r.hosts);
  assert.equal(after.split(MARKER_BEGIN).length, 2, after);
  assert.ok(!after.includes('\r'));
  assert.equal(region(after), expectedRegion(['old.example', 'paused.example', 'www.paused.example']));
  // Csak a sor végi CR megy: a sor közepi CR a felhasználó bájtja (a segéd is
  // csak a CRLF-et olvassa LF-nek) — két sora nem forrhat össze.
  const m = rig();
  deleteApp(m);
  fs.writeFileSync(m.hosts, '127.0.0.1 localhost\r\n10.0.0.1 a\rb\n');
  runGuard(m);
  assert.ok(read(m.hosts).startsWith('127.0.0.1 localhost\n10.0.0.1 a\rb\n\n'), JSON.stringify(read(m.hosts).slice(0, 60)));
});

macTest('macOS-őr: ami a hosts helyén áll, de nem fájl, ahhoz nem nyúl', () => {
  const r = rig();
  deleteApp(r);
  fs.rmSync(r.hosts);
  fs.mkdirSync(r.hosts);
  runGuard(r);
  assert.deepEqual(fs.readdirSync(r.hosts), [], 'a mappába tett egy fájlt');
  assert.match(logOf(r), /nem tudtam írni a hosts fájlt: nem fájl/);
  assert.equal(flushCount(r), 0);
});

macTest('macOS-őr: a hosts helyén álló linket a saját fájlja váltja fel — mint a segédnél', () => {
  // Egy link nem állíthatja le az őrt örökre: ha fájlra mutat, annak sorai
  // maradnak; ha mappára, eszközre vagy sehova, alap hosts-szal kezd. A link
  // célja érintetlen marad.
  const cases: Array<[string, (r: Rig) => string, string]> = [
    ['mappára', (r) => { const d = path.join(r.root, 'dir'); fs.mkdirSync(d); return d; }, '127.0.0.1\tlocalhost'],
    ['sehova', (r) => path.join(r.root, 'nincs'), '127.0.0.1\tlocalhost'],
    ['fájlra', (r) => { const f = path.join(r.root, 'other'); fs.writeFileSync(f, '10.9.9.9 cel.lan\n'); return f; }, '10.9.9.9 cel.lan'],
    ['csőre', (r) => { const f = path.join(r.root, 'fifo'); execFileSync('mkfifo', [f]); return f; }, '127.0.0.1\tlocalhost'],
  ];
  for (const [label, target, head] of cases) {
    const r = rig();
    deleteApp(r);
    fs.rmSync(r.hosts);
    const t = target(r);
    const before = fs.existsSync(t) && fs.statSync(t).isFile() ? read(t) : null;
    fs.symlinkSync(t, r.hosts);
    execFileSync(shell[0], [...shell.slice(1), r.script], { stdio: 'pipe', timeout: 20_000 });
    assert.ok(!fs.lstatSync(r.hosts).isSymbolicLink(), `${label}: a link maradt`);
    const after = read(r.hosts);
    assert.ok(after.startsWith(head), `${label}: ${JSON.stringify(after.slice(0, 40))}`);
    assert.equal(region(after), expectedRegion(['old.example', 'paused.example', 'www.paused.example']), label);
    if (fs.existsSync(t) && fs.statSync(t).isDirectory()) assert.deepEqual(fs.readdirSync(t), [], `${label}: a mappába írt`);
    if (before !== null) assert.equal(read(t), before, `${label}: a link célját átírta`);
    assert.equal(flushCount(r), 1, label);
  }
});

macTest('macOS-őr: betelt lemez — a hosts fájl érintetlen, ideiglenes fájl nem marad', () => {
  // Fájlméret-korlát (ulimit -f, 512 bájtos egységek): a munkafájlok elférnek,
  // az új hosts fájl (a régi sorok + a blokk) nem. A régi helyben írás itt csonka
  // blokkot hagyott — elsőként az IPv6-sorok vesztek el.
  const r = rig();
  deleteApp(r);
  const user = Array.from({ length: 60 }, (_, i) => `10.0.${i}.1 host${i}.lan`).join('\n');
  fs.writeFileSync(r.hosts, `${user}\n`);
  fs.writeFileSync(path.join(r.dir, STRICT_FILE), renderStrictBlock(Array.from({ length: 30 }, (_, i) => `blocked${i}.example`), NOTE), { mode: 0o600 });
  const before = read(r.hosts);
  const strictSize = fs.statSync(path.join(r.dir, STRICT_FILE)).size;
  assert.ok(before.length > 1000 && strictSize > 1000 && before.length + strictSize > 2200 && strictSize < 1900,
    `a próba mérete: ${before.length} + ${strictSize}`);
  execFileSync('/bin/sh', ['-c', 'trap "" XFSZ; ulimit -f 4; exec "$@"', 'sh', ...shell, r.script], { stdio: 'pipe' });
  assert.equal(read(r.hosts), before, 'a hosts fájl megváltozott');
  assert.deepEqual(fs.readdirSync(path.dirname(r.hosts)).filter((f) => f.startsWith('.hosts.')), [], 'ideiglenes fájl maradt');
  assert.match(logOf(r), /nem tudtam írni a hosts fájlt/);
  assert.equal(flushCount(r), 0);
});

macTest('macOS-őr: az írás egy átnevezés — nem marad ideiglenes fájl, a hosts új inode', () => {
  const r = rig();
  deleteApp(r);
  const before = fs.statSync(r.hosts).ino;
  runGuard(r);
  assert.notEqual(fs.statSync(r.hosts).ino, before, 'helyben írt (egy betelt lemezen félbemaradhatna)');
  assert.deepEqual(fs.readdirSync(path.dirname(r.hosts)).filter((f) => f.startsWith('.hosts.')), []);
  assert.deepEqual(fs.readdirSync(r.dir).filter((f) => f.startsWith('.guard.')), [], 'a munkamappa ott maradt');
  assert.equal(fs.statSync(r.hosts).mode & 0o777, 0o644);
});

macTest('macOS-őr: ha a segéd közvetlenül írás előtt elindul, nem ír', () => {
  // A megnézések sorrendje: belépéskor, a várakozás után, írás előtt. Az
  // utolsónál a segéd már fut — egy most induló segéd és az őr ne írjon felváltva.
  const r = rig();
  deleteApp(r);
  fs.writeFileSync(r.aliveAfter, '3');
  const before = read(r.hosts);
  runGuard(r);
  assert.equal(read(r.hosts), before);
  assert.equal(flushCount(r), 0);
});

macTest('macOS-őr: idegen sor a szigorú blokkban — kihagyja, a többit beírja; csupa szemétnél nem ír', () => {
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

macTest('macOS-őr: nem megbízható szigorú blokk vagy mappa — nem ír', () => {
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

macTest('macOS-őr: ahol nem tud dönteni, ott nem ír (nincs segéd, leválasztott kötet, karantén, nincs szigorú blokk)', () => {
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

macTest('macOS-őr: a leíró percenként futtatja, KeepAlive és naplóút nélkül', () => {
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
  assert.ok(s.includes('if ($deadFor -ge $deadAfter -and -not ((Installing) -and $deadFor -lt $installCap)) {'));
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
  // Unió: a hosts régi blokkjának tiltó sorai is a halmazba kerülnek. (A
  // felemás jelölőket és a sorvégeket az élő próba nézi lent.)
  assert.ok(s.includes('    if ($l -cmatch $BlockRe) { [void]$set.Add($l) }'));
  assert.ok(s.includes('if (-not $ok) { $cur.Clear();'));
  // A nyelvi összevetés nem dönthet: minden StartsWith/EndsWith sorszámos, és
  // szöveget -ceq/-eq '' helyett a Same (bájtra azonos) hasonlít.
  const calls = [...s.matchAll(/\.(StartsWith|EndsWith)\(([^)]*)\)/g)];
  assert.ok(calls.length >= 3);
  for (const c of calls) assert.ok(c[2].includes('[StringComparison]::Ordinal'), c[0]);
  assert.ok(!/-ceq|-eq ''|-ne ''/.test(s), 'nyelvi szöveg-összevetés az őrben');
  assert.ok(s.includes("function Same([string]$a, [string]$b) { return [string]::Equals($a, $b, [StringComparison]::Ordinal) }"));
  assert.ok(!s.includes('TrimEnd('), 'a TrimEnd az összes sor végi CR-t vinné');
  // Az írás egy csere: egy betelt lemez vagy egy leállítás sem hagy félig írt
  // hosts fájlt. Helyben csak akkor ír, ha a csere nem megy — és az ideiglenes
  // fájl ilyenkor is eltűnik.
  const lines = s.split('\r\n');
  const rep = lines.indexOf('      try { [IO.File]::Replace($tmp, $hostsFile, [NullString]::Value) }');
  assert.ok(rep > 0, 'nincs csere');
  assert.deepEqual(lines.slice(rep + 1, rep + 5), [
    '      catch {',
    '        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue',
    '        [IO.File]::WriteAllBytes($hostsFile, $bytes)',
    '      }',
  ]);
  assert.equal(s.split('[IO.File]::WriteAllBytes($hostsFile').length, 2, 'helyben írás a cserén kívül is');
  const fin = lines.indexOf('  } finally {', rep);
  assert.ok(fin > rep && lines[fin + 1] === '    if ([IO.File]::Exists($tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }');
  // A nem induló segéd: előbb a szigorú blokk, csak utána indítjuk — a saját
  // indításunk különben „futónak” látszana az írás előtti újranézésnél. Az írás
  // hibája (például egy zárolt hosts fájl) nem akadályozhatja meg az indítást.
  const deadIf = lines.indexOf('    if ($deadFor -ge $deadAfter -and -not ((Installing) -and $deadFor -lt $installCap)) {');
  assert.ok(deadIf > 0, 'nincs dead-ág');
  assert.match(lines[deadIf + 1], /^ {6}try \{ Apply-Strict 'dead' \} catch \{ Log \(\(U '[A-Za-z0-9+/=]+'\) \+ \$_\.Exception\.Message\) \}$/);
  assert.equal(lines[deadIf + 2], '    }');
  const start = lines.findIndex((l) => l.includes("Start-ScheduledTask -TaskName '"));
  assert.ok(start > deadIf + 2, 'előbb indít, aztán ír');
  assert.equal(s.split("Apply-Strict 'dead'").length, 2);
  // Hiányzó hosts: üres listával indul, és ír.
  assert.ok(s.includes('if ([IO.File]::Exists($hostsFile)) { $lines = Lines ([IO.File]::ReadAllBytes($hostsFile)) }'));
  // Idegen sor: kimarad, nem akasztja meg az egészet; méretkorlát nincs.
  assert.ok(s.includes('else { $foreign++ }'));
  assert.ok(!/\$bytes\.Length -gt/.test(s));
  // A jövőbeli bélyeg (visszaállított óra) a mostani időre íródik.
  assert.ok(s.includes('if ($null -eq $since -or $since -gt $now) { [IO.File]::WriteAllText($p, $now.ToString(\'o\')); return 0 }'));
});

// ------------------------------------------------ Windows őr élesben (pwsh)
//
// A Windows-őr hosts-írását (Apply-Strict) a kiszállított szövegből futtatjuk
// PowerShell 7-tel: a GitHub Linux-gépein van (ott kötelező), helyben a PWSH
// változó mutathat rá. A gép-specifikus részeket (Feladatütemező, tulajdonos-
// ellenőrzés, DNS-ürítés) csonkoljuk; az összefésülés, a sorvégek és az írás a
// valódi kód. Ugyanarra a hosts fájlra a két őrnek ugyanazt kell írnia — a
// sorvég kivételével (Windowson CRLF).

function findPwsh(): string | null {
  if (process.env.PWSH) return process.env.PWSH;
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (d && fs.existsSync(path.join(d, 'pwsh'))) return path.join(d, 'pwsh');
  }
  return null;
}
const PWSH = findPwsh();

test('a Windows-őr élő próbája a CI-ban fut', () => {
  if (process.env.CI) assert.ok(PWSH, 'a CI-gépen pwsh kell');
});

interface WinRig { root: string; hosts: string; strict: string; flushes: string; log: string; script: string }

const psQuote = (p: string) => `'${p.replace(/'/g, "''")}'`;

function winRig(hosts: Buffer | null, strict: string, extra: string[] = []): WinRig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wguard-'));
  const sys = path.join(root, 'sys');
  fs.mkdirSync(sys);
  const flushes = path.join(root, 'flushes');
  fs.writeFileSync(path.join(sys, 'ipconfig.exe'), `#!/bin/sh\necho "$1" >> ${shQuote(flushes)}\n`, { mode: 0o755 });
  const hostsFile = path.join(root, 'hosts');
  if (hosts) fs.writeFileSync(hostsFile, hosts);
  const strictFile = path.join(root, STRICT_FILE);
  fs.writeFileSync(strictFile, strict);
  const log = path.join(root, 'guard.log');
  // A PATH és a modulút sorát kihagyjuk: a pwsh a saját moduljait innen tölti.
  const lines = windowsGuardScript(WINDOWS_GUARD_DEFAULTS).split('\r\n')
    .filter((l) => !l.startsWith('$env:PATH =') && !l.startsWith('$env:PSModulePath ='));
  const main = lines.indexOf('try {');
  assert.ok(main > 0, 'nincs fő rész');
  const script = path.join(root, 'guard.ps1');
  fs.writeFileSync(script, [
    ...lines.slice(0, main),
    `$strict = ${psQuote(strictFile)}`,
    `$hostsFile = ${psQuote(hostsFile)}`,
    `$logFile = ${psQuote(log)}`,
    `$sys = ${psQuote(sys)}`,
    '$guardOk = $true',
    'function Owner-Ok([string]$p) { return $true }',
    'function Trusted-Dir([string]$p) { return $true }',
    "function Get-State { return @{ s = 'gone' } }",
    ...extra,
    "try { Apply-Strict 'gone' } catch { Log ('hiba: ' + $_.Exception.Message); exit 3 }",
    'exit 0',
    '',
  ].join('\n'));
  return { root, hosts: hostsFile, strict: strictFile, flushes, log, script };
}

function runWin(r: WinRig): void {
  execFileSync(PWSH as string, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', r.script], {
    stdio: 'pipe', env: { ...process.env, SystemRoot: r.root, ProgramData: r.root, ProgramW6432: r.root },
  });
}

const winTest = (name: string, fn: () => void) => test(name, { skip: PWSH ? false : 'nincs pwsh' }, fn);
const latin1 = (f: string) => fs.readFileSync(f).toString('latin1');

// Ugyanazok a bájtok mindkét őrnek. A felemás jelölők, a sorvégek és az ékezetek
// azok a helyek, ahol két külön írt értelmező szét szokott csúszni.
const MIRROR_CASES: Array<[string, Buffer]> = ([
  ['nincs blokk', '127.0.0.1 localhost\n10.0.0.1 nas.lan\n'],
  ['régi blokk, utána saját sor', `127.0.0.1 localhost\n\n${buildManagedBlock(['old.example', 'zzz.example'], 'darwin')}\n# utána\n10.0.0.9 z.lan\n`],
  ['CRLF', `127.0.0.1 localhost\r\n\r\n${MARKER_BEGIN}\r\n0.0.0.0 crlf.example\r\n${MARKER_END}\r\n`],
  ['sor közepi CR', '127.0.0.1 localhost\r\n10.0.0.1 a\rb\n'],
  ['két CR a sor végén', '10.0.0.1 a\r\r\n10.0.0.2 b\n'],
  ['csak nyitó, utána saját sorok',
    `127.0.0.1 localhost\n\n${MARKER_BEGIN}\n${NOTE}\n0.0.0.0 stale.example\n:: stale.example\n# Added by Docker Desktop\n192.168.65.2 host.docker.internal\n\n`],
  ['csak záró', `127.0.0.1 localhost\n${MARKER_END}\n10.0.0.2 b.lan\n`],
  ['két blokk', `${MARKER_BEGIN}\n0.0.0.0 a.example\n${MARKER_END}\n10.0.0.3 c.lan\n${MARKER_BEGIN}\n:: b.example\n# második belső\n${MARKER_END}\n`],
  ['egymásba ágyazott nyitó', `${MARKER_BEGIN}\n0.0.0.0 a1.example\n${MARKER_BEGIN}\n0.0.0.0 a2.example\n${MARKER_END}\n10.0.0.3 c.lan\n`],
  ['blokk, majd záró nélküli nyitó',
    `${MARKER_BEGIN}\n0.0.0.0 x.example\n# belső\n${MARKER_END}\n10.0.0.4 d.lan\n${MARKER_BEGIN}\n# régi\n10.0.0.5 e.lan\n:: y.example\n# Breaker: régi megjegyzés\n# Breaker2 marad\n`],
  ['üres', ''],
  ['csak üres sorok', '\n\n\n'],
  ['üres sorok elöl és hátul', '\n\n127.0.0.1 localhost\n\n\n'],
  ['záró sorvég nélkül', '127.0.0.1 localhost'],
  ['ékezetes saját sorok', '# Ügyfél gépe — tükör\n10.0.0.6 ügyfél.lan\n'],
  ['szóköz a jelölő végén (nem jelölő)', `${MARKER_BEGIN} \n0.0.0.0 z.example\n${MARKER_END}\n`],
  ['tiltó sor a blokkon kívül', '0.0.0.0 kint.example\n127.0.0.1 localhost\n'],
] as Array<[string, string]>).map(([n, t]) => [n, Buffer.from(t, 'utf8')] as [string, Buffer]);

// Érvénytelen UTF-8 bájt is: mindkét őr bájtra megőrzi.
MIRROR_CASES.push(['érvénytelen UTF-8 bájt', Buffer.concat([Buffer.from('10.0.0.7 '), Buffer.from([0xe9, 0xff]), Buffer.from('.lan\n')])]);
// A nyelvi összevetés figyelmen kívül hagyja a vezérlőbájtokat és a lágy
// kötőjelet (Latin-1 0xAD): az ilyen bájttal elrontott tiltó sort a blokk
// változatlannak, a jelölőt jelölőnek, az egybájtos sort üresnek látná.
{
  const want = expectedRegion(['old.example', 'paused.example', 'www.paused.example']);
  const [pre, post] = want.split('0.0.0.0 old.example');
  MIRROR_CASES.push(['lágy kötőjel egy tiltó sorban (különben változatlan blokk)', Buffer.concat([
    Buffer.from(`127.0.0.1 localhost\n\n${pre}0.0.0.0 old.ex`), Buffer.from([0xad]), Buffer.from(`ample${post}\n`)])]);
  MIRROR_CASES.push(['vezérlőbájt egy tiltó sorban', Buffer.concat([
    Buffer.from(`127.0.0.1 localhost\n\n${pre}0.0.0.0 old.`), Buffer.from([0x01]), Buffer.from(`example${post}\n`)])]);
  MIRROR_CASES.push(['vezérlőbájt a jelölő végén (nem jelölő)', Buffer.concat([
    Buffer.from(`10.0.0.8 f.lan\n${MARKER_BEGIN}`), Buffer.from([0x1f]), Buffer.from('\n0.0.0.0 z.example\n')])]);
  MIRROR_CASES.push(['egyetlen vezérlőbájtból álló sor a végén', Buffer.concat([
    Buffer.from('127.0.0.1 localhost\n'), Buffer.from([0x01]), Buffer.from('\n')])]);
}

winTest('a Windows-oldali szkriptek szintaktikailag hibátlanok (a PowerShell saját elemzőjével)', () => {
  // Egy elírt zárójel a Windows-őrben csak a becsomagolt próbán derülne ki,
  // fél óra múlva — vagy sehol, ha az az ág ott nem fut.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wparse-'));
  const files: Array<[string, string]> = [
    ['guard.ps1', windowsGuardScript()],
    ['register.ps1', windowsGuardRegisterScript('C:\\Program Files\\Breaker Guard\\guard.ps1')],
  ];
  for (const [name, text] of files) fs.writeFileSync(path.join(root, name), text);
  const paths = [
    ...files.map(([name]) => path.join(root, name)),
    path.join(__dirname, '..', '..', 'scripts', 'uninstall-windows.ps1'),
    path.join(__dirname, '..', '..', 'scripts', 'win-install-probe.ps1'),
  ];
  for (const p of paths) assert.ok(fs.existsSync(p), p);
  const parse = path.join(root, 'parse.ps1');
  fs.writeFileSync(parse, [
    '$bad = 0',
    'foreach ($p in $args) {',
    '  $e = $null',
    '  [void][Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$e)',
    '  foreach ($x in $e) { $bad++; Write-Output ($p + ":" + $x.Extent.StartLineNumber + ": " + $x.Message) }',
    '}',
    'Write-Output ("errors: " + $bad + " / files: " + $args.Count)',
    '',
  ].join('\n'));
  const out = execFileSync(PWSH as string, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', parse, ...paths], { encoding: 'utf8' });
  assert.match(out, new RegExp(`^errors: 0 / files: ${paths.length}\\s*$`), out);
});

winTest('a két őr ugyanazt írja: a Windows-őr a macOS-őr tükre (sorvég nélkül)', () => {
  const strict = renderStrictBlock(['old.example', 'paused.example', 'www.paused.example'], NOTE);
  shell = SHELLS[0][1];
  for (const [label, hosts] of MIRROR_CASES) {
    const m = rig();
    deleteApp(m);
    fs.writeFileSync(m.hosts, hosts);
    runGuard(m);
    const w = winRig(hosts, strict);
    runWin(w);
    const mac = latin1(m.hosts);
    const win = latin1(w.hosts);
    assert.ok(!win.replace(/\r\n/g, '').includes('\n'), `${label}: a Windows-őr LF-et írt`);
    assert.equal(win.replace(/\r\n/g, '\n'), mac, `${label}:\n${JSON.stringify(win)}\n${JSON.stringify(mac)}`);
    assert.equal(read(w.flushes), '/flushdns\n', `${label}: egy ürítés`);
    // Másodszor egyik sem ír.
    runGuard(m);
    runWin(w);
    assert.equal(latin1(m.hosts), mac, `${label}: a macOS-őr újraírta`);
    assert.equal(latin1(w.hosts), win, `${label}: a Windows-őr újraírta`);
    assert.equal(flushCount(m), 1, `${label}: a macOS-őr újra ürített`);
    assert.equal(read(w.flushes), '/flushdns\n', `${label}: a Windows-őr újra ürített`);
    assert.deepEqual(fs.readdirSync(w.root).filter((f) => f.includes('.tmp')), [], `${label}: ideiglenes fájl maradt`);
  }
});

winTest('Windows-őr élesben: a hiányzó hosts fájlt létrehozza; idegen sor kimarad; üres lista nem ír', () => {
  const strict = renderStrictBlock(['a.example'], NOTE);
  const w = winRig(null, strict);
  runWin(w);
  assert.equal(read(w.hosts), strict.replace(/\n/g, '\r\n'));
  const f = winRig(Buffer.from('127.0.0.1 localhost\r\n'), `${strict}10.0.0.1 idegen.example\n`);
  runWin(f);
  assert.ok(!latin1(f.hosts).includes('idegen'), 'az idegen sor bekerült');
  assert.match(read(f.log), /idegen sorait kihagytam: 1/);
  const e = winRig(Buffer.from('127.0.0.1 localhost\r\n'), `${MARKER_BEGIN}\n${NOTE}\n${MARKER_END}\n`);
  runWin(e);
  assert.equal(latin1(e.hosts), '127.0.0.1 localhost\r\n');
  assert.equal(read(e.flushes), '');
});

winTest('Windows-őr élesben: ha a csere nem megy, helyben ír; ideiglenes fájl nem marad', () => {
  // A Replace hibáját csonkoljuk (Windowson egy a hosts fájlt nyitva tartó
  // program okozza); a helyben írás a valódi kód.
  const strict = renderStrictBlock(['a.example'], NOTE);
  const w = winRig(Buffer.from('127.0.0.1 localhost\r\n'), strict);
  const src = fs.readFileSync(w.script, 'utf8');
  const broken = src.replace('[IO.File]::Replace($tmp, $hostsFile, [NullString]::Value)', "throw 'zárolva'");
  assert.notEqual(broken, src);
  fs.writeFileSync(w.script, broken);
  runWin(w);
  assert.ok(latin1(w.hosts).includes('0.0.0.0 a.example\r\n'), latin1(w.hosts));
  assert.deepEqual(fs.readdirSync(w.root).filter((f) => f.includes('.tmp')), []);
  // Ha a helyben írás sem megy: hiba a naplóban, a hosts érintetlen, ideiglenes fájl nincs.
  const z = winRig(Buffer.from('127.0.0.1 localhost\r\n'), strict);
  fs.writeFileSync(z.script, fs.readFileSync(z.script, 'utf8')
    .replace('[IO.File]::Replace($tmp, $hostsFile, [NullString]::Value)', "throw 'zárolva'")
    .replace('[IO.File]::WriteAllBytes($hostsFile, $bytes)', "throw 'ez is'"));
  assert.throws(() => runWin(z));
  assert.equal(latin1(z.hosts), '127.0.0.1 localhost\r\n');
  assert.match(read(z.log), /hiba: ez is/);
  assert.deepEqual(fs.readdirSync(z.root).filter((f) => f.includes('.tmp')), []);
  assert.equal(read(z.flushes), '');
  // Az ideiglenes fájl írása közben jön a hiba (betelt lemez): a fél fájl sem marad.
  const d = winRig(Buffer.from('127.0.0.1 localhost\r\n'), strict);
  fs.writeFileSync(d.script, fs.readFileSync(d.script, 'utf8')
    .replace('[IO.File]::WriteAllBytes($tmp, $bytes)', "[IO.File]::WriteAllBytes($tmp, $bytes); throw 'betelt'"));
  assert.throws(() => runWin(d));
  assert.equal(latin1(d.hosts), '127.0.0.1 localhost\r\n');
  assert.deepEqual(fs.readdirSync(d.root).filter((f) => f.includes('.tmp')), []);
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
  // A kezdőidőpont a múltban: egy visszaállított óra se állítsa le az ismétlést.
  assert.ok(r.includes("-Once -At ([DateTime]'2000-01-01T00:00:00') -RepetitionInterval (New-TimeSpan -Minutes 5)"));
  const m = r.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/);
  assert.ok(m, 'nincs kódolt parancs');
  const loader = Buffer.from(m[1], 'base64').toString('utf16le');
  assert.equal(loader, windowsGuardLoader(guardPath));
  assert.equal(loader, "& ([ScriptBlock]::Create([IO.File]::ReadAllText('C:\\Program Files\\Breaker Guard\\guard.ps1')))");
});
