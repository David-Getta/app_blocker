// A védett futtatókörnyezet telepítője (shared/runtime-shell.ts, #151).
//
// A belső szkriptet ÉLESBEN futtatjuk, dash-sel és bash --posix-szal (a macOS
// /bin/sh-ja), egy ideiglenes fán: a macOS-saját eszközök (launchctl, codesign,
// sw_vers, sysctl, plutil, ls -le, df) csonkok, a tar, az openssl, a dd és a
// többi a valódi. A launchctl-csonk a segéd indulását is eljátssza: ha a leíró
// a futtatókörnyezet Node-ját indítja, a `current` szerinti `.ok-<név>` jelet
// teszi le — vagy, ha a próba úgy kéri, nem (a segéd nem jelentkezik).

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { DAEMON_LABEL } from '../src/shared/install-script';
import { PAYLOAD_ENTRY, runtimeId } from '../src/shared/helper-runtime';
import {
  MAC_INSTALL_ERRORS, MAC_RUNTIME_SHELL_DEFAULTS, MAC_SHELL_TOOLS, macHelperPlist, macInstallError, macInstallScript,
  macRootCommand, nodeRequirement, okMarkName, type MacInstallInputs,
} from '../src/shared/runtime-shell';
import {
  brk, calls, entries, flag, install, packer, read, rig, SHELLS, sha, shTest, unflag, type Rig, type Run,
} from './runtime-rig';

test('a telepítő-teszt mindkét héjjal fut', () => {
  assert.deepEqual(SHELLS.map(([l]) => l), ['dash', 'bash --posix'], 'a CI-gépen mindkét héj kell');
});

function assertUntouched(r: Rig, run: Run, token: string): void {
  assert.notEqual(run.code, 0, run.out);
  assert.deepEqual(brk(run), [token], run.err);
  assert.ok(!fs.existsSync(r.dp), 'a leíró nem jöhetett létre');
  assert.ok(!fs.existsSync(path.join(r.rt, 'current')), 'a current nem jöhetett létre');
  assert.deepEqual(entries(r.rt), [], `maradék a futtatókörnyezetben: ${entries(r.rt).join(',')}`);
  assert.ok(!calls(r).some((c) => c.startsWith('bootout') || c.includes(DAEMON_LABEL)), calls(r).join('\n'));
}

shTest('telepítés: a pontos fa, a link, a leíró, az őr, az újraindítás és a jel', () => {
  const r = rig();
  const run = install(r);
  assert.equal(run.code, 0, run.err);
  assert.equal(run.out, `ok ${r.id}\n`);
  assert.deepEqual(brk(run), []);
  // A futtatókörnyezet: a változat, a link, a jel — és semmi más (se stage, se zár).
  assert.deepEqual(entries(r.rt), [okMarkName(r.id), r.id, 'current'].sort());
  assert.equal(fs.readlinkSync(path.join(r.rt, 'current')), r.id);
  assert.equal((fs.statSync(r.rt).mode & 0o777), 0o700);
  const v = path.join(r.rt, r.id);
  assert.deepEqual(entries(v), ['app', 'node', 'ossl-modules', 'runtime.json']);
  assert.equal(sha(fs.readFileSync(path.join(v, 'node'))), r.pin.arm64.binSha256);
  assert.equal(fs.statSync(path.join(v, 'node')).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(path.join(v, PAYLOAD_ENTRY), 'utf8'), '// segéd\n');
  assert.equal(fs.statSync(path.join(v, PAYLOAD_ENTRY)).mode & 0o777, 0o644);
  assert.deepEqual(entries(path.join(v, 'ossl-modules')), []);
  assert.deepEqual(JSON.parse(read(path.join(v, 'runtime.json'))), {
    payloadSha256: r.inputs.payloadSha256, binSha256: r.pin.arm64.binSha256, nodeVersion: 'v9.8.7', arch: 'arm64',
  });
  // A leíró és az őr.
  assert.equal(read(r.dp), macHelperPlist(501, r.rt));
  assert.equal(read(path.join(r.dir, 'guard.sh')), r.inputs.guardScript);
  assert.equal(fs.statSync(path.join(r.dir, 'guard.sh')).mode & 0o777, 0o755);
  assert.equal(read(path.join(r.ld, 'hu.breaker.guard.plist')), r.inputs.guardPlist);
  assert.deepEqual(entries(r.ld), ['hu.breaker.guard.plist', `${DAEMON_LABEL}.plist`], 'a LaunchDaemons alatt nincs ideiglenes fájl');
  assert.deepEqual(entries(r.dir).filter((e) => e.startsWith('.') || e.endsWith('.prev')), [], 'az állapotmappában nincs maradék');
  // Sorrend: az őr előbb, a segéd utána.
  const c = calls(r);
  const guardAt = c.findIndex((x) => x.startsWith('bootstrap') && x.includes('hu.breaker.guard.plist'));
  const helperAt = c.findIndex((x) => x.startsWith('bootstrap') && x.includes(`${DAEMON_LABEL}.plist`));
  assert.ok(guardAt >= 0 && helperAt > guardAt, c.join('\n'));
  assert.ok(c.includes(`bootout system/${DAEMON_LABEL}`));
  // A Node aláírójának ellenőrzése a rögzített követelménnyel.
  const cs = read(`${r.calls}.codesign`);
  assert.ok(cs.includes(`--verify --strict -R ${nodeRequirement(r.pin)}`), cs);
});

shTest('az önellenőrzés tiszta környezetben fut: a hívó DYLD_/NODE_ változói nem jutnak el a Node-ig', () => {
  const r = rig();
  const run = install(r, {}, { DYLD_INSERT_LIBRARIES: '/tmp/x.dylib', NODE_OPTIONS: '--require /tmp/x.js', OPENSSL_CONF: '/tmp/x.cnf' });
  assert.equal(run.code, 0, run.err);
  const env = read(r.nodeEnv);
  assert.match(env, /^PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/m);
  assert.match(env, new RegExp(`^OPENSSL_MODULES=.*/\\.stage\\.[^/]+/ossl-modules$`, 'm'));
  assert.ok(!/DYLD_|NODE_OPTIONS|OPENSSL_CONF/.test(env), env);
});

shTest('a csomag ujjlenyomata nem egyezik (a bemásolás előtt kicserélt fájl) — semmi nem változik', () => {
  const r = rig();
  // Ugyanakkora, érvényes tar, csak a segéd kódja más: egyedül az ujjlenyomat fogja meg.
  const at = r.payload.indexOf(Buffer.from('// segéd'));
  assert.ok(at > 0);
  const bad = Buffer.from(r.payload);
  bad.write('// SEGéD', at, 'utf8');
  assert.equal(bad.length, r.payload.length);
  fs.writeFileSync(r.inputs.payloadTar, bad);
  assertUntouched(r, install(r), 'verify');
});

shTest('a csomag mérete nem egyezik — elutasítva', () => {
  const r = rig();
  fs.appendFileSync(r.inputs.payloadTar, Buffer.alloc(512));
  assertUntouched(r, install(r), 'verify');
});

shTest('a Node tarball ujjlenyomata nem egyezik — elutasítva', () => {
  const r = rig();
  fs.appendFileSync(r.inputs.nodeTar as string, 'x');
  assertUntouched(r, install(r), 'verify');
});

shTest('a Node tarball más, de ugyanakkora, és benne ugyanaz a bináris — a tarball ujjlenyomata fogja meg', () => {
  const r = rig();
  // Ugyanaz a tartalom más időbélyeggel: ugyanaz a bináris, más tarball.
  const work = fs.mkdtempSync(path.join(r.root, 'retar-'));
  execFileSync('tar', ['-xJf', r.inputs.nodeTar as string, '-C', work]);
  let other: Buffer | null = null;
  for (let t = 1; t < 400 && !other; t++) {
    const f = path.join(r.root, `retar-${t}.tar.xz`);
    execFileSync('tar', ['-cJf', f, `--mtime=@${1_000_000 + t * 7919}`, '-C', work, 'node-v9.8.7-darwin-arm64']);
    const b = fs.readFileSync(f);
    if (b.length === r.pin.arm64.tarSize && sha(b) !== r.pin.arm64.tarSha256) other = b;
  }
  assert.ok(other, 'nem találtam ugyanakkora tarballt');
  fs.writeFileSync(r.inputs.nodeTar as string, other);
  assertUntouched(r, install(r), 'verify');
});

shTest('a futó Node elromlott (más az ujjlenyomata) — nem kölcsönzi: tarball nélkül need-node, tarballal friss', () => {
  const r = rig();
  assert.equal(install(r).code, 0);
  fs.appendFileSync(path.join(r.rt, r.id, 'node'), '\n# elrontva\n');
  const run = install(r, { nodeTar: null });
  assert.deepEqual(brk(run), ['need-node'], run.err);
  const run2 = install(r);
  assert.equal(run2.code, 0, run2.err);
  assert.equal(sha(fs.readFileSync(path.join(r.rt, r.id, 'node'))), r.pin.arm64.binSha256);
});

shTest('a Node aláírója nem a rögzített csapat (codesign) — elutasítva', () => {
  const r = rig();
  flag(r, 'codesign-bad');
  assertUntouched(r, install(r), 'codesign');
});

shTest('Node nélkül, futó futtatókörnyezet nélkül: need-node', () => {
  const r = rig();
  assertUntouched(r, install(r, { nodeTar: null }), 'need-node');
});

shTest('a felhasználói bemenet nem sima fájl (link, mappa, FIFO) — elutasítva, azonnal', () => {
  for (const kind of ['link', 'dir', 'fifo']) {
    const r = rig();
    fs.rmSync(r.inputs.payloadTar);
    if (kind === 'link') fs.symlinkSync(path.join(r.root, 'nincs'), r.inputs.payloadTar);
    if (kind === 'dir') fs.mkdirSync(r.inputs.payloadTar);
    if (kind === 'fifo') execFileSync('mkfifo', [r.inputs.payloadTar]);
    const run = install(r);
    assertUntouched(r, run, 'copy');
    assert.ok(run.ms < 5000, `${kind}: ${run.ms} ms`);
  }
});

shTest('link vagy idegen elem a csomagban — a fa-ellenőrzés elutasítja', () => {
  const r = rig();
  // Egy (aláírt-ujjlenyomatú) csomag, benne egy linkkel: a GNU tar írja.
  const work = path.join(r.root, 'evil');
  fs.mkdirSync(path.join(work, 'app', 'dist', 'helper'), { recursive: true });
  fs.writeFileSync(path.join(work, PAYLOAD_ENTRY), 'x');
  fs.symlinkSync('/etc/passwd', path.join(work, 'app', 'dist', 'helper', 'l.js'));
  const evil = path.join(r.root, 'evil.tar');
  execFileSync('tar', ['-cf', evil, '-C', work, 'app']);
  const buf = fs.readFileSync(evil);
  fs.writeFileSync(r.inputs.payloadTar, buf);
  assertUntouched(r, install(r, { payloadSha256: sha(buf), payloadSize: buf.length }), 'verify');
});

shTest('egy ACL-sor a kész fán (ls -le) — elutasítva', () => {
  const r = rig();
  flag(r, 'acl');
  assertUntouched(r, install(r), 'verify');
});

shTest('az önellenőrzés nem ok-t ír, vagy elakad — időkorláttal megáll, semmi nem változik', () => {
  const r = rig();
  flag(r, 'selfcheck-bad');
  assertUntouched(r, install(r), 'selfcheck');
  const r2 = rig();
  flag(r2, 'selfcheck-hang');
  const run = install(r2);
  assertUntouched(r2, run, 'selfcheck');
  assert.ok(run.ms < 10_000, `${run.ms} ms`);
});

shTest('a bizalmi lánc: írható szülő, linkelt állapotmappa — untrusted, semmi nem íródik', () => {
  const r = rig();
  fs.chmodSync(path.dirname(r.dir), 0o777);
  const run = install(r);
  assert.deepEqual(brk(run), ['untrusted']);
  assert.ok(!fs.existsSync(r.dir));
  const r2 = rig();
  const elsewhere = path.join(r2.root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.chmodSync(elsewhere, 0o777);
  fs.symlinkSync(elsewhere, r2.dir);
  const run2 = install(r2);
  assert.deepEqual(brk(run2), ['untrusted']);
  assert.deepEqual(entries(elsewhere), []);
  assert.equal(fs.statSync(elsewhere).mode & 0o777, 0o777, 'a link célján semmit nem állít');
  // A futtatókörnyezet helyén egy link: untrusted.
  const r3 = rig();
  fs.mkdirSync(r3.dir, { mode: 0o755 });
  fs.symlinkSync(elsewhere, r3.rt);
  assert.deepEqual(brk(install(r3)), ['untrusted']);
  assert.deepEqual(entries(elsewhere), []);
});

shTest('a macOS-verzió és a szabad hely — előtte megáll', () => {
  for (const [v, ok] of [['13.4.1', false], ['12.7', false], ['13.5', true], ['13.5.2', true], ['26.0', true], ['14', true], ['', false], ['x.y', false]] as const) {
    const r = rig();
    flag(r, 'macos', `${v}\n`);
    const run = install(r);
    if (ok) assert.equal(run.code, 0, `${v}: ${run.err}`);
    else assertUntouched(r, run, 'macos');
  }
  const r = rig();
  flag(r, 'full');
  assertUntouched(r, install(r), 'space');
});

shTest('Intel gépen az x64 Node és a hozzá tartozó változatnév', () => {
  const r = rig();
  flag(r, 'intel');
  fs.copyFileSync(path.join(r.root, 'node-v9.8.7-darwin-x64.tar.xz'), r.inputs.nodeTar as string);
  const run = install(r);
  assert.equal(run.code, 0, run.err);
  const id = runtimeId(r.inputs.payloadSha256, r.pin.x64.binSha256);
  assert.equal(run.out, `ok ${id}\n`);
  assert.equal(sha(fs.readFileSync(path.join(r.rt, id, 'node'))), r.pin.x64.binSha256);
  // Az arm64 tarballal Intelen: nem egyezik.
  const r2 = rig();
  flag(r2, 'intel');
  assertUntouched(r2, install(r2), 'verify');
});

shTest('a zár: egy élő tartó mellett busy; egy halott tartó zárját átveszi', () => {
  const r = rig();
  fs.mkdirSync(r.rt, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(r.rt, '.lock'));
  fs.writeFileSync(path.join(r.rt, '.lock', 'pid'), `${process.pid}\n`);
  const run = install(r);
  assert.deepEqual(brk(run), ['busy']);
  assert.ok(fs.existsSync(path.join(r.rt, '.lock')), 'a más zárját nem veszi el');
  assert.ok(!fs.existsSync(r.dp));
  // Azonosító nélküli, friss zár (a tartó épp most hozta létre): busy; percek múlva átvehető.
  fs.rmSync(path.join(r.rt, '.lock', 'pid'));
  assert.deepEqual(brk(install(r)), ['busy']);
  const old = Date.now() / 1000 - 120;
  fs.utimesSync(path.join(r.rt, '.lock'), old, old);
  const run1 = install(r);
  assert.equal(run1.code, 0, run1.err);
  fs.mkdirSync(path.join(r.rt, '.lock'));
  // Halott tartó: átveszi, és a végén elengedi.
  fs.writeFileSync(path.join(r.rt, '.lock', 'pid'), '999999\n');
  const run2 = install(r);
  assert.equal(run2.code, 0, run2.err);
  assert.ok(!fs.existsSync(path.join(r.rt, '.lock')));
});

shTest('újratelepítés: a futó Node-ot kölcsönzi (tarball nélkül), a maradékokat takarítja, a .bad marad', () => {
  const r = rig();
  assert.equal(install(r).code, 0);
  // Maradékok: egy félbehagyott stage, egy régi változat, egy függő frissítés, egy régi jel, egy elárvult link.
  fs.mkdirSync(path.join(r.rt, '.stage.abc123'));
  fs.mkdirSync(path.join(r.rt, '0123456789abcdef'));
  fs.writeFileSync(path.join(r.rt, '.pending'), '{}');
  fs.writeFileSync(path.join(r.rt, '.ok-0123456789abcdef'), '');
  fs.writeFileSync(path.join(r.rt, '.bad'), 'deadbeef\n');
  fs.symlinkSync('nincs', path.join(r.rt, '.current.new'));
  const nodeIno = fs.statSync(path.join(r.rt, r.id, 'node')).ino;
  const run = install(r, { nodeTar: null });
  assert.equal(run.code, 0, run.err);
  assert.deepEqual(entries(r.rt), ['.bad', okMarkName(r.id), r.id, 'current'].sort());
  assert.equal(fs.statSync(path.join(r.rt, r.id, 'node')).ino, nodeIno, 'a Node ugyanaz a fájl (kemény link)');
  assert.equal(read(`${r.calls}.codesign`).split('\n').filter(Boolean).length, 1, 'a kölcsönzött Node-ot nem kell újra ellenőrizni');
});

shTest('javítás: a meglévő változat helyére a most ellenőrzött fa kerül (egy belepiszkált fájl sem marad)', () => {
  const r = rig();
  assert.equal(install(r).code, 0);
  const entry = path.join(r.rt, r.id, PAYLOAD_ENTRY);
  fs.writeFileSync(entry, 'elrontva');
  fs.writeFileSync(path.join(r.rt, r.id, 'app', 'extra.js'), 'x');
  const run = install(r);
  assert.equal(run.code, 0, run.err);
  assert.equal(read(entry), '// segéd\n');
  assert.ok(!fs.existsSync(path.join(r.rt, r.id, 'app', 'extra.js')));
});

shTest('egészség: friss telepítésnél ha a segéd nem jelentkezik, a leíró is megy — mint a kattintás előtt', () => {
  const r = rig();
  flag(r, 'unhealthy');
  const run = install(r);
  assert.deepEqual(brk(run), ['health'], run.err);
  assert.ok(!fs.existsSync(r.dp), 'friss telepítésnél nincs leíró');
  assert.ok(!entries(r.rt).some((e) => e.startsWith('.lock') || e.startsWith('.stage')));
  const c = calls(r);
  const last = c.lastIndexOf(`bootout system/${DAEMON_LABEL}`);
  assert.ok(last >= 0 && !c.slice(last).some((x) => x.startsWith('bootstrap')), 'nem indít leíró nélkül');
});

shTest('egészség: régi elrendezésből ha az új nem jelentkezik, a régi leíró vissza és újraindul', () => {
  const r = rig();
  const legacy = '<plist><dict>\n<key>Label</key><string>hu.breaker.helper</string>\n<string>/Applications/Breaker.app/Contents/MacOS/Breaker</string>\n</dict></plist>\n';
  fs.writeFileSync(r.dp, legacy);
  flag(r, 'unhealthy');
  const run = install(r);
  assert.deepEqual(brk(run), ['health'], run.err);
  assert.equal(read(r.dp), legacy);
  assert.ok(!fs.existsSync(path.join(r.dir, 'helper.plist.prev')));
  const c = calls(r);
  assert.equal(c[c.length - 1], `bootstrap system ${r.dp}`, 'a régi segéd újra fut');
});

shTest('egészség: futtatókörnyezetből frissítve ha az új nem jelentkezik, a current vissza az előzőre', () => {
  const r = rig();
  assert.equal(install(r).code, 0);
  const prevId = r.id;
  // Új csomag: más ujjlenyomat, más változatnév.
  const payload2 = packer.makeTar([
    { path: PAYLOAD_ENTRY, mode: 0o644, data: Buffer.from('// segéd 2\n') },
    { path: 'app/package.json', mode: 0o644, data: Buffer.from('{}\n') },
  ]) as Buffer;
  fs.writeFileSync(r.inputs.payloadTar, payload2);
  flag(r, 'unhealthy');
  const run = install(r, { payloadSha256: sha(payload2), payloadSize: payload2.length, nodeTar: null });
  assert.deepEqual(brk(run), ['health'], run.err);
  assert.equal(fs.readlinkSync(path.join(r.rt, 'current')), prevId);
  assert.equal(read(r.dp), macHelperPlist(501, r.rt), 'ugyanaz a leíró marad');
  assert.ok(fs.existsSync(path.join(r.rt, prevId, 'node')));
  // Ha a segéd megint jelentkezik, a következő telepítés rendben lefut.
  unflag(r, 'unhealthy');
  const run2 = install(r, { payloadSha256: sha(payload2), payloadSize: payload2.length, nodeTar: null });
  assert.equal(run2.code, 0, run2.err);
  const id2 = runtimeId(sha(payload2), r.pin.arm64.binSha256);
  assert.deepEqual(entries(r.rt), [okMarkName(id2), id2, 'current'].sort());
});

shTest('a segéd nem indítható (bootstrap) — visszaállás, bootstrap jel; ha a régi sem, restore', () => {
  const r = rig();
  const legacy = '<plist><dict><key>Label</key><string>hu.breaker.helper</string></dict></plist>\n';
  fs.writeFileSync(r.dp, legacy);
  flag(r, 'bootstrap-fail');
  const run = install(r);
  assert.deepEqual(brk(run), ['bootstrap'], run.err);
  assert.equal(read(r.dp), legacy);
  assert.ok(!fs.existsSync(path.join(r.rt, 'current')), 'régi elrendezésből: a current link sem marad');
  assert.ok(!fs.existsSync(path.join(r.rt, '.pending')));
  const c = calls(r);
  assert.equal(c[c.length - 1], `bootstrap system ${r.dp}`, 'a régi segéd újra fut');
  // Ha a régi sem indul: kimondjuk (a gép következő indításakor indul).
  const r2 = rig();
  fs.writeFileSync(r2.dp, legacy);
  flag(r2, 'bootstrap-fail-all');
  const run2 = install(r2);
  assert.deepEqual(brk(run2), ['restore'], run2.err);
  assert.equal(read(r2.dp), legacy);
});

shTest('egy elbukott friss telepítés után az újrapróbálás sem hagy ott el nem induló segédet', () => {
  const r = rig();
  flag(r, 'unhealthy');
  assert.deepEqual(brk(install(r)), ['health']);
  assert.ok(!fs.existsSync(r.dp));
  assert.ok(!fs.existsSync(path.join(r.rt, 'current')), 'a current sem marad');
  // Újra (ugyanazzal, és egy más csomaggal is): megint semmi nem marad betöltve.
  assert.deepEqual(brk(install(r)), ['health']);
  assert.ok(!fs.existsSync(r.dp), 'nincs leíró — mint a kattintás előtt');
  assert.ok(!fs.existsSync(path.join(r.rt, 'current')));
  const c = calls(r);
  const last = c.lastIndexOf(`bootout system/${DAEMON_LABEL}`);
  assert.ok(!c.slice(last).some((x) => x.startsWith('bootstrap system') && x.includes(DAEMON_LABEL)));
});

shTest('megszakítás a váltás közben (leállítás, SIGTERM): visszaáll, interrupted jel', () => {
  const r = rig();
  const legacy = '<plist><dict>\n<key>Label</key><string>hu.breaker.helper</string>\n</dict></plist>\n';
  fs.writeFileSync(r.dp, legacy);
  flag(r, 'term-on-bootstrap');
  const run = install(r);
  assert.deepEqual(brk(run), ['interrupted'], run.err);
  assert.equal(read(r.dp), legacy, 'a régi leíró vissza');
  assert.ok(!fs.existsSync(path.join(r.rt, 'current')));
  assert.ok(!fs.existsSync(path.join(r.rt, '.pending')));
  assert.ok(!fs.existsSync(path.join(r.rt, '.lock')), 'a zár elengedve');
});

shTest('a váltás előtt a szándék a lemezen: .pending (új és előző változat) — az őr ebből áll vissza, ha a telepítő félúton leállna', () => {
  const r = rig();
  assert.equal(install(r).code, 0);
  const payload2 = packer.makeTar([
    { path: PAYLOAD_ENTRY, mode: 0o644, data: Buffer.from('// segéd 3\n') },
    { path: 'app/package.json', mode: 0o644, data: Buffer.from('{}\n') },
  ]) as Buffer;
  fs.writeFileSync(r.inputs.payloadTar, payload2);
  flag(r, 'unhealthy');
  // A launchctl-csonk a bootstrapkor feljegyzi, mi volt a .pending-ben.
  const seen = path.join(r.root, 'pending-seen');
  fs.writeFileSync(path.join(r.flags, 'note-pending'), seen);
  const run = install(r, { payloadSha256: sha(payload2), payloadSize: payload2.length, nodeTar: null });
  assert.deepEqual(brk(run), ['health']);
  const id2 = runtimeId(sha(payload2), r.pin.arm64.binSha256);
  assert.equal(read(seen), `${id2}\n${r.id}\n`);
  assert.ok(!fs.existsSync(path.join(r.rt, '.pending')), 'a visszaállás után eltűnik');
});

shTest('az őr írása megbukik (betelt lemez a dekódolás közben) — a régi őr marad, guard jel', () => {
  const r = rig();
  fs.mkdirSync(r.dir, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(r.dir, 'guard.sh'), '#!/bin/sh\n# régi őr\n');
  flag(r, 'b64-fail');
  const run = install(r);
  assert.deepEqual(brk(run), ['guard'], run.err);
  assert.equal(read(path.join(r.dir, 'guard.sh')), '#!/bin/sh\n# régi őr\n');
  assert.ok(!fs.existsSync(r.dp));
  assert.deepEqual(entries(r.dir).filter((e) => e.startsWith('.put.')), [], 'ideiglenes fájl nem marad');
});

shTest('az őr újratöltése: a változott leírónál kivárja a leállást és újrapróbál; a változatlant nem tölti újra', () => {
  const r = rig();
  // Az őr fut, a leírója régi; a leállás lassú (három megnézésig még „fut”).
  fs.writeFileSync(path.join(r.ld, 'hu.breaker.guard.plist'), '<plist><dict><key>Label</key><string>hu.breaker.guard</string><string>régi</string></dict></plist>\n');
  fs.writeFileSync(path.join(r.root, 'loaded', 'hu.breaker.guard'), '');
  flag(r, 'slow-bootout', '3');
  const run = install(r);
  assert.equal(run.code, 0, run.err);
  assert.equal(read(path.join(r.ld, 'hu.breaker.guard.plist')), r.inputs.guardPlist);
  const c = calls(r);
  assert.ok(c.includes('bootout system/hu.breaker.guard'));
  assert.ok(fs.existsSync(path.join(r.root, 'loaded', 'hu.breaker.guard')), 'az őr fut');
  // Másodszor: a leíró ugyanaz — nem tölti újra.
  fs.writeFileSync(r.calls, '');
  assert.equal(install(r).code, 0);
  assert.ok(!calls(r).includes('bootout system/hu.breaker.guard'));
});

shTest('az őr nem tölthető be — megáll, mielőtt bármi a segédhez nyúlna', () => {
  const r = rig();
  flag(r, 'guard-fail');
  const run = install(r);
  assert.deepEqual(brk(run), ['guard'], run.err);
  assert.ok(!fs.existsSync(r.dp));
  assert.ok(!fs.existsSync(path.join(r.rt, 'current')));
  assert.deepEqual(entries(r.rt), []);
});

test('a leíró: a futtatókörnyezet Node-ja, kötött kapcsolók, csak az OpenSSL modulmappája a környezetben', () => {
  const p = macHelperPlist(501);
  const strings = [...p.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const rt = '/Library/Application Support/Breaker/runtime';
  assert.deepEqual(strings, [
    DAEMON_LABEL,
    `${rt}/current/node`, '--disable-sigusr1', '--no-addons', `${rt}/current/${PAYLOAD_ENTRY}`, '--owner-uid=501',
    `${rt}/current/ossl-modules`,
    `${rt}/current`,
    'hu.breaker.app',
    '/Library/Application Support/Breaker/helper.log', '/Library/Application Support/Breaker/helper.log',
  ]);
  assert.match(p, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>OPENSSL_MODULES<\/key><string>[^<]+<\/string>\s*<\/dict>/);
  assert.ok(!/ELECTRON_|DYLD_|NODE_|app\.asar|\.app\//.test(p), p);
  assert.throws(() => macHelperPlist(-1));
  assert.throws(() => macHelperPlist(1.5));
});

test('a gyökér-parancs: env -i, a belső szkript base64-ben, bájtra visszafejthető', () => {
  const r = rig();
  const script = macInstallScript(r.inputs, r.opts);
  const cmd = macRootCommand(script);
  assert.ok(cmd.startsWith('exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin LC_ALL=C /bin/sh -c "$(/bin/echo '), cmd.slice(0, 120));
  const m = /\/bin\/echo ([A-Za-z0-9+/=]+) \| \/usr\/bin\/base64 -D\)"$/.exec(cmd);
  assert.ok(m);
  assert.equal(Buffer.from(m[1], 'base64').toString('utf8'), script);
  // A szkript a szigorú beállításokkal kezdődik.
  assert.ok(script.startsWith('set -eu\numask 077\n'));
});

test('a bemenetek alakja: rossz ujjlenyomat, méret, relatív vagy sorvéges út — nem lesz belőle parancs', () => {
  const r = rig();
  const bad: Array<Partial<MacInstallInputs>> = [
    { payloadSha256: 'A'.repeat(64) }, { payloadSha256: 'x' }, { payloadSize: 0 }, { payloadSize: 9 * 1024 * 1024 },
    { payloadTar: 'relative/payload.tar' }, { payloadTar: '/a\nb' }, { nodeTar: 'x.tar.xz' }, { ownerUid: -1 },
  ];
  for (const b of bad) assert.throws(() => macInstallScript({ ...r.inputs, ...b }, r.opts), JSON.stringify(b));
});

test('a sorrend a szkriptben: minden ellenőrzés és az őr a leállítás előtt; ideiglenes leíró csak az állapotmappában', () => {
  const r = rig();
  const s = macInstallScript(r.inputs, MAC_RUNTIME_SHELL_DEFAULTS);
  const at = (needle: string) => {
    const i = s.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };
  const bootout = at(`lctl bootout system/${DAEMON_LABEL}`);
  for (const n of ['take_lock', 'die verify', 'die codesign', '--selfcheck', "put '", 'die guard', 'plutil -lint']) {
    assert.ok(at(n) < bootout, n);
  }
  assert.ok(at('NEWPL="$D/.helper.plist.new"') < bootout);
  assert.ok(!/\$LD\/\.|LaunchDaemons\/\./.test(s), 'ideiglenes fájl a LaunchDaemons alatt');
  assert.ok(s.includes(MAC_SHELL_TOOLS.tarSafeFlags));
  assert.ok(s.includes(`-R '${nodeRequirement()}'`));
});

test('a hibajelek mondatai: minden jelnek van mondata, az ismeretlen a váratlan hiba', () => {
  const r = rig();
  const s = macInstallScript(r.inputs, r.opts);
  const used = new Set([...s.matchAll(/die ([a-z-]+)/g)].map((m) => m[1]).concat(['fail']));
  for (const t of used) assert.ok(MAC_INSTALL_ERRORS[t], t);
  for (const t of ['plist', 'bootstrap', 'health']) assert.ok(MAC_INSTALL_ERRORS[t], t);
  assert.equal(macInstallError('valami\nBRK:verify\n'), MAC_INSTALL_ERRORS.verify);
  assert.equal(macInstallError('BRK:copy BRK:health'), MAC_INSTALL_ERRORS.health);
  assert.equal(macInstallError('BRK:ismeretlen'), MAC_INSTALL_ERRORS.fail);
  assert.equal(macInstallError('User canceled.'), null);
});
