// A segéd csendes frissítése (helper/update.ts, #151): élesben, a valódi
// héjakkal (dash, csonkolt macOS-eszközök — test/runtime-rig.ts). Előbb a
// telepítő teszi fel a futtatókörnyezetet, aztán a „segéd” egy aláírt, újabb
// csomagot vesz át — vagy elutasítja, és akkor semmi nem változik.

import { strict as assert } from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { PAYLOAD_ENTRY, runtimeId } from '../src/shared/helper-runtime';
import type { HelperManifest, ReleaseKey } from '../src/shared/helper-manifest';
import {
  badPayloads, offerPathProblem, releaseLock, runUpdate, takeLock, trustedKeys, type UpdateDeps, type UpdateOffer,
} from '../src/helper/update';
import { buildNodeTar, currentShell, entries, flag, install, packer, read, rig, sha, shTest, type Rig } from './runtime-rig';

function keyPair(id: string): { key: ReleaseKey; priv: crypto.KeyObject } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { key: { id, spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }, priv: privateKey };
}

interface Bundle { dir: string; payload: Buffer; manifest: HelperManifest }

/** Egy új csomag egy „app” mappájában: payload.tar, manifest.json, manifest.sig. */
function makeBundle(r: Rig, o: { version?: string; text?: string; signer?: { key: ReleaseKey; priv: crypto.KeyObject }; node?: HelperManifest['node']; name?: string } = {}): Bundle {
  const dir = path.join(r.root, o.name ?? 'New', 'Breaker.app', 'Contents', 'Resources', 'helper');
  fs.mkdirSync(dir, { recursive: true });
  const payload = packer.makeTar([
    { path: PAYLOAD_ENTRY, mode: 0o644, data: Buffer.from(o.text ?? '// segéd, új\n') },
    { path: 'app/package.json', mode: 0o644, data: Buffer.from(`{"version":"${o.version ?? '0.4.301'}"}\n`) },
  ]) as Buffer;
  fs.writeFileSync(path.join(dir, 'payload.tar'), payload);
  const signer = o.signer ?? SIGNER;
  const manifest: HelperManifest = {
    format: 1, product: 'hu.breaker.helper', appVersion: o.version ?? '0.4.301', helperVersion: '0.7.0', keyId: signer.key.id,
    payload: { sha256: sha(payload), size: payload.length },
    node: o.node ?? { version: r.pin.version, arm64: r.pin.arm64, x64: r.pin.x64 },
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'manifest.json'), bytes);
  fs.writeFileSync(path.join(dir, 'manifest.sig'), `${crypto.sign(null, bytes, signer.priv).toString('base64')}\n`);
  return { dir, payload, manifest };
}

const SIGNER = keyPair('ci-test');

function runShell(script: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const sh = currentShell();
    const p = spawn(sh[0], [...sh.slice(1), '-c', script], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

function deps(r: Rig, over: Partial<UpdateDeps> = {}): UpdateDeps {
  return {
    root: r.rt,
    ownId: r.id,
    ownAppVersion: '0.4.300',
    ownBinSha256: r.pin.arm64.binSha256,
    arch: 'arm64',
    keys: () => [SIGNER.key],
    runShell,
    shellOptions: r.opts,
    log: () => {},
    now: () => Date.now(),
    pid: process.pid,
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    ...over,
  };
}

/** Telepítve, a segéd „fut”: a current a telepített változat. */
function installed(): Rig {
  const r = rig();
  const run = install(r);
  assert.equal(run.code, 0, run.err);
  return r;
}

function assertNothingChanged(r: Rig): void {
  assert.equal(fs.readlinkSync(path.join(r.rt, 'current')), r.id);
  assert.ok(!fs.existsSync(path.join(r.rt, '.pending')), '.pending maradt');
  assert.ok(!fs.existsSync(path.join(r.rt, '.lock')), 'a zár maradt');
  assert.deepEqual(entries(r.rt).filter((e) => e.startsWith('.in.') || e.startsWith('.stage.')), [], 'ideiglenes mappa maradt');
}

const offerOf = (b: Bundle, nodeTar?: string): UpdateOffer => ({ bundle: b.dir, ...(nodeTar ? { nodeTar } : {}) });

shTest('csendes frissítés: aláírt, újabb csomag — összeáll, .pending, a current átáll; a régi változat marad a visszaálláshoz', async () => {
  const r = installed();
  const b = makeBundle(r);
  const res = await runUpdate(offerOf(b), deps(r));
  const id2 = runtimeId(sha(b.payload), r.pin.arm64.binSha256);
  assert.deepEqual(res, { ok: true, id: id2, appVersion: '0.4.301', payloadSha256: sha(b.payload) });
  assert.equal(fs.readlinkSync(path.join(r.rt, 'current')), id2);
  assert.equal(read(path.join(r.rt, '.pending')), `${id2}\n${r.id}\n`);
  assert.equal(read(path.join(r.rt, id2, PAYLOAD_ENTRY)), '// segéd, új\n');
  assert.ok(fs.existsSync(path.join(r.rt, r.id, 'node')), 'az előző változat megvan (az őr ide áll vissza)');
  assert.equal(fs.statSync(path.join(r.rt, id2, 'node')).ino, fs.statSync(path.join(r.rt, r.id, 'node')).ino, 'a Node kölcsönzött');
  assert.ok(fs.existsSync(path.join(r.rt, '.lock')), 'sikernél a zárat a kilépés előtt a hívó engedi el');
  releaseLock(r.rt, process.pid);
  assert.ok(!fs.existsSync(path.join(r.rt, '.lock')));
  assert.deepEqual(entries(r.rt).filter((e) => e.startsWith('.in.') || e.startsWith('.stage.')), []);
});

shTest('elutasítva, és semmi nem változik: idegen kulcs, régebbi vagy ugyanaz a verzió, kicserélt csomag, .bad', async () => {
  const r = installed();
  const stranger = keyPair('ci-test');
  const cases: Array<[string, () => Bundle, string]> = [
    ['idegen kulcs (ugyanazzal az azonosítóval)', () => makeBundle(r, { signer: stranger, name: 'a' }), 'unsigned'],
    ['régebbi verzió', () => makeBundle(r, { version: '0.4.299', name: 'b' }), 'not-newer'],
    ['ugyanaz a verzió', () => makeBundle(r, { version: '0.4.300', name: 'c' }), 'not-newer'],
    ['kicserélt csomag a régi leíróval', () => {
      const b = makeBundle(r, { name: 'd' });
      fs.writeFileSync(path.join(b.dir, 'payload.tar'), packer.makeTar([
        { path: PAYLOAD_ENTRY, mode: 0o644, data: Buffer.from('// más kód\n') },
        { path: 'app/package.json', mode: 0o644, data: Buffer.from('{"version":"0.4.301"}\n') },
      ]));
      return b;
    }, 'mismatch'],
    ['egyszer már el nem indult csomag', () => {
      const b = makeBundle(r, { name: 'e', text: '// rossz\n' });
      fs.appendFileSync(path.join(r.rt, '.bad'), `${sha(b.payload)}\n`);
      return b;
    }, 'bad'],
    ['aláírás nélkül', () => {
      const b = makeBundle(r, { name: 'f' });
      fs.rmSync(path.join(b.dir, 'manifest.sig'));
      return b;
    }, 'copy'],
  ];
  for (const [label, make, error] of cases) {
    const res = await runUpdate(offerOf(make()), deps(r));
    assert.equal(res.ok, false, label);
    assert.equal(!res.ok && res.error, error, `${label}: ${JSON.stringify(res)}`);
    assertNothingChanged(r);
  }
  assert.ok(badPayloads(r.rt).size === 1);
});

shTest('új Node: a leíró más bináris-ujjlenyomatot rögzít — tarball nélkül need-node, a felkínált tarballal áll össze', async () => {
  const r = installed();
  const fresh = buildNodeTar(r.root, 'arm64', 'v9.8.8', r.nodeEnv, r.flags, 'új Node');
  const node = { version: 'v9.8.8', arm64: fresh.pin, x64: { ...r.pin.x64, member: 'node-v9.8.8-darwin-x64/bin/node' } };
  const b = makeBundle(r, { node });
  assert.notEqual(fresh.pin.binSha256, r.pin.arm64.binSha256);
  const res = await runUpdate(offerOf(b), deps(r));
  assert.deepEqual(res, { ok: false, error: 'need-node', detail: 'v9.8.8' });
  assertNothingChanged(r);
  const res2 = await runUpdate(offerOf(b, fresh.tarFile), deps(r));
  assert.equal(res2.ok, true, JSON.stringify(res2));
  const id2 = runtimeId(sha(b.payload), fresh.pin.binSha256);
  assert.equal(fs.readlinkSync(path.join(r.rt, 'current')), id2);
  assert.equal(sha(fs.readFileSync(path.join(r.rt, id2, 'node'))), fresh.pin.binSha256);
  releaseLock(r.rt, process.pid);
  // Az új Node aláírója nem a rögzített csapat: az összeállítás áll meg.
  const r2 = installed();
  const b2 = makeBundle(r2, { node });
  flag(r2, 'codesign-bad');
  const res3 = await runUpdate(offerOf(b2, fresh.tarFile), deps(r2));
  assert.deepEqual(res3, { ok: false, error: 'stage', detail: 'codesign' });
  assertNothingChanged(r2);
});

shTest('a felkínált út: rossz alak, FIFO a leíró helyén — elutasítva; a segéd köre közben is jár', async () => {
  const r = installed();
  for (const bundle of ['relative/helper', '/tmp/x/helper', '/a/../Breaker.app/Contents/Resources/helper', '/a/Breaker.app/Contents/Resources/helper/']) {
    const res = await runUpdate({ bundle }, deps(r));
    assert.deepEqual(res, { ok: false, error: 'path', detail: 'a csomag mappája' }, bundle);
  }
  const b = makeBundle(r);
  assert.deepEqual(await runUpdate(offerOf(b, '/tmp/evil.tar.xz'), deps(r)), { ok: false, error: 'path', detail: 'a Node tarball' });
  fs.rmSync(path.join(b.dir, 'manifest.json'));
  execFileSync('mkfifo', [path.join(b.dir, 'manifest.json')]);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  const t0 = Date.now();
  const res = await runUpdate(offerOf(b), deps(r));
  clearInterval(timer);
  assert.equal(!res.ok && res.error, 'copy');
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(ticks > 0, 'a segéd köre nem állt meg');
  assertNothingChanged(r);
});

shTest('a zár: amíg egy élő folyamat tartja, busy; egy halottét átveszi', async () => {
  const r = installed();
  const b = makeBundle(r);
  fs.mkdirSync(path.join(r.rt, '.lock'));
  fs.writeFileSync(path.join(r.rt, '.lock', 'pid'), `${process.ppid}\n`);
  assert.deepEqual(await runUpdate(offerOf(b), deps(r)), { ok: false, error: 'busy' });
  assert.equal(read(path.join(r.rt, '.lock', 'pid')), `${process.ppid}\n`, 'a más zárját nem veszi el');
  fs.writeFileSync(path.join(r.rt, '.lock', 'pid'), '999999\n');
  const res = await runUpdate(offerOf(b), deps(r));
  assert.equal(res.ok, true, JSON.stringify(res));
  releaseLock(r.rt, process.pid);
});

test('a zár és a kulcsok: takeLock/releaseLock csak a sajátját engedi; a futtatókörnyezet próba-kulcsa hozzáadódik', () => {
  const r = rig();
  fs.mkdirSync(r.rt, { recursive: true });
  const alive = () => true;
  assert.equal(takeLock(r.rt, 111, alive, Date.now()), true);
  assert.equal(takeLock(r.rt, 222, alive, Date.now()), false);
  releaseLock(r.rt, 222);
  assert.ok(fs.existsSync(path.join(r.rt, '.lock')), 'más nem engedheti el');
  assert.equal(takeLock(r.rt, 222, alive, Date.now() + 11 * 60_000), true, 'tíz perc után elavult');
  releaseLock(r.rt, 222);
  assert.ok(!fs.existsSync(path.join(r.rt, '.lock')));
  const base = [{ id: 'r1', spki: 'AAAA' }];
  assert.deepEqual(trustedKeys(base, r.rt, '0123456789abcdef'), base);
  fs.mkdirSync(path.join(r.rt, '0123456789abcdef', 'app'), { recursive: true });
  fs.writeFileSync(path.join(r.rt, '0123456789abcdef', 'app', 'test-keys.json'), JSON.stringify([{ id: 'ci-test', spki: 'BBBB' }, { id: 'r1', spki: 'CCCC' }, 'szemét']));
  assert.deepEqual(trustedKeys(base, r.rt, '0123456789abcdef'), [...base, { id: 'ci-test', spki: 'BBBB' }], 'egy kiadási kulcsot nem írhat felül');
});

test('a felkínált út alakja', () => {
  assert.equal(offerPathProblem({ bundle: '/Applications/Breaker.app/Contents/Resources/helper' }), null);
  assert.equal(offerPathProblem({ bundle: '/Applications/Breaker.app/Contents/Resources/helper', nodeTar: '/Users/a/Library/Caches/hu.breaker.app/node/node-v24.22.1-darwin-arm64.tar.xz' }), null);
  assert.notEqual(offerPathProblem({ bundle: '/Applications/Breaker.app/Contents/Resources/helper', nodeTar: '/x/node.tar.xz' }), null);
  assert.notEqual(offerPathProblem({ bundle: '/Applications/Breaker.app/Contents/Resources/helper\n' }), null);
  assert.notEqual(offerPathProblem({ bundle: 42 as unknown as string }), null);
});
