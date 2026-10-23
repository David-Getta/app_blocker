// A csendes frissítés bekötése (helper/updater.ts) és a futtatókörnyezet
// takarítása (helper/runtime.ts: gcRuntime), #151.

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { gcRuntime } from '../src/helper/runtime';
import { createUpdater, UPDATE_COOLDOWN_MS, UPDATE_RECHECK_MS } from '../src/helper/updater';
import type { UpdateDeps } from '../src/helper/update';
import { MAC_RUNTIME_SHELL_DEFAULTS } from '../src/shared/runtime-shell';

const ID = '0123456789abcdef';
const BUNDLE = '/Applications/Breaker.app/Contents/Resources/helper';

function root(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  fs.chmodSync(r, 0o700);
  return r;
}

function deps(r: string, over: Partial<UpdateDeps> = {}, clock = { t: 1_000_000 }) {
  const shells: string[] = [];
  const d = {
    root: r, ownId: ID, ownAppVersion: '0.4.300', ownBinSha256: 'b'.repeat(64), arch: 'arm64' as const,
    keys: () => [],
    runShell: async (script: string) => { shells.push(script); return { code: 1, out: '', err: 'BRK:copy\n' }; },
    shellOptions: MAC_RUNTIME_SHELL_DEFAULTS,
    log: () => {},
    now: () => clock.t,
    pid: process.pid,
    alive: () => true,
    onActivated: () => {},
    ...over,
  };
  return { d, shells, clock };
}

test('egy sikertelen próba után türelmi idő; az állapot a hibát mondja; az ajánlat megjegyezve', async () => {
  const r = root();
  const { d, shells, clock } = deps(r);
  const u = createUpdater(d);
  assert.deepEqual(u.status(), { state: 'idle' });
  const res = await u.offer({ bundle: BUNDLE });
  assert.deepEqual(res, { ok: false, error: 'copy', detail: 'copy' });
  assert.equal(u.status().state, 'failed');
  assert.equal(u.status().error, 'copy');
  assert.equal(shells.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r, '.offer.json'), 'utf8')), { bundle: BUNDLE });
  assert.ok(!fs.existsSync(path.join(r, '.lock')), 'a zár elengedve');
  // Ugyanaz az ajánlat tíz percen belül: nem futtatunk semmit.
  assert.deepEqual(await u.offer({ bundle: BUNDLE }), { ok: false, error: 'cooldown' });
  assert.equal(shells.length, 1);
  // Más ajánlat (Node tarballal): mehet.
  await u.offer({ bundle: BUNDLE, nodeTar: '/Users/a/Library/Caches/hu.breaker.app/node/node-v24.22.1-darwin-arm64.tar.xz' });
  assert.equal(shells.length, 2);
  clock.t += UPDATE_COOLDOWN_MS + 1;
  await u.offer({ bundle: BUNDLE });
  assert.equal(shells.length, 3);
  // Rossz alakú út: se héj, se megjegyzés.
  assert.deepEqual(await u.offer({ bundle: '/tmp/x' }), { ok: false, error: 'path', detail: 'a csomag mappája' });
  assert.equal(shells.length, 3);
});

test('egyszerre egy: a második ajánlat busy, amíg az első fut', async () => {
  const r = root();
  let release: () => void = () => {};
  const { d } = deps(r, {
    runShell: () => new Promise((resolve) => { release = () => resolve({ code: 1, out: '', err: 'BRK:copy' }); }),
  });
  const u = createUpdater(d);
  const first = u.offer({ bundle: BUNDLE });
  await new Promise((res) => setImmediate(res));
  assert.equal(u.status().state, 'working');
  assert.deepEqual(await u.offer({ bundle: BUNDLE }), { ok: false, error: 'busy' });
  release();
  await first;
  assert.equal(u.status().state, 'failed');
});

test('ha az őr visszaállította a legutóbb átvett csomagot, az állapot ezt mondja', () => {
  const r = root();
  fs.writeFileSync(path.join(r, '.offer.json'), JSON.stringify({ bundle: BUNDLE, lastSha: 'c'.repeat(64) }));
  fs.writeFileSync(path.join(r, '.bad'), `${'c'.repeat(64)}\n`);
  assert.equal(createUpdater(deps(r).d).status().state, 'rolled-back');
  fs.writeFileSync(path.join(r, '.bad'), `${'d'.repeat(64)}\n`);
  assert.equal(createUpdater(deps(r).d).status().state, 'idle');
  // Szemét a megjegyzett ajánlatban: nincs belőle semmi.
  fs.writeFileSync(path.join(r, '.offer.json'), JSON.stringify({ bundle: '/etc/../x' }));
  assert.equal(createUpdater(deps(r).d).status().state, 'idle');
});

test('a megjegyzett ajánlatot magától is újranézi: két perc múlva, aztán hatóránként', async () => {
  const r = root();
  const { d, shells } = deps(r);
  fs.writeFileSync(path.join(r, '.offer.json'), JSON.stringify({ bundle: BUNDLE }));
  const timers: Array<{ fn: () => void; ms: number }> = [];
  createUpdater(d).start((fn, ms) => timers.push({ fn, ms }));
  assert.deepEqual(timers.map((t) => t.ms), [2 * 60_000]);
  timers[0].fn();
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(shells.length, 1);
  assert.deepEqual(timers.map((t) => t.ms), [2 * 60_000, UPDATE_RECHECK_MS]);
  // Ajánlat nélkül nincs mit nézni.
  const r2 = root();
  const x = deps(r2);
  const t2: Array<() => void> = [];
  createUpdater(x.d).start((fn) => t2.push(fn));
  t2[0]();
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(x.shells.length, 0);
});

test('takarítás a rendben elindult változat után: csak ő, a link, a zár, a .bad, az ajánlat és a jele marad', () => {
  const r = root();
  fs.mkdirSync(path.join(r, ID));
  fs.symlinkSync(ID, path.join(r, 'current'));
  for (const d of ['fedcba9876543210', '.in.abc', '.stage.def', '.old.ghi']) fs.mkdirSync(path.join(r, d));
  for (const f of [`.ok-${ID}`, '.ok-fedcba9876543210', '.pending', '.bad', '.offer.json', '.current.new']) fs.writeFileSync(path.join(r, f), '');
  const logs: string[] = [];
  let took = 0;
  let released = 0;
  gcRuntime(ID, () => { took += 1; return true; }, () => { released += 1; }, (m) => logs.push(m), r);
  assert.deepEqual(fs.readdirSync(r).sort(), ['.bad', `.ok-${ID}`, '.offer.json', ID, 'current'].sort());
  assert.equal(took, 1);
  assert.equal(released, 1);
  assert.match(logs.join('\n'), /takarítva \(7 elem\)/);
  // Foglalt zárnál semmihez nem nyúl; ha a current nem ő, akkor sem.
  fs.mkdirSync(path.join(r, 'fedcba9876543210'));
  gcRuntime(ID, () => false, () => { released += 1; }, () => {}, r);
  assert.ok(fs.existsSync(path.join(r, 'fedcba9876543210')));
  assert.equal(released, 1, 'amit nem vett el, nem is engedi el');
  gcRuntime('fedcba9876543210', () => true, () => {}, () => {}, r);
  assert.ok(fs.existsSync(path.join(r, ID)), 'nem a current változat nem takarít');
});
