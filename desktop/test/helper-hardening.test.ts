// Integration tests against the REAL helper IPC server.
//
// The helper runs as root/SYSTEM and rewrites its whole state file on every
// commit, so anything reaching its socket is untrusted input to a privileged
// process. These tests drive the actual server over a real socket and assert
// that hostile input cannot grow the state file without bound or wedge
// persistence permanently.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-hard-'));
process.env.BREAKER_STATE = path.join(tmp, 'state.json');
process.env.BREAKER_HOSTS = path.join(tmp, 'hosts');
process.env.BREAKER_SOCKET = path.join(tmp, 'breaker.sock');
fs.writeFileSync(process.env.BREAKER_HOSTS, '127.0.0.1 localhost\n');

import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { startServer, MAX_BATCH_SAMPLES } from '../src/helper/server';
import { defaultState, saveState, type HelperState } from '../src/helper/state';
import { MAX_TARGETS_PER_DAY, OTHER_SITE_KEY } from '../src/shared/usage';

let server: net.Server;
let state: HelperState;

before(async () => {
  state = defaultState();
  server = startServer({
    getState: () => state,
    commit: () => saveState(state),
    dohApplied: () => false,
    log: () => { /* quiet during tests */ },
  });
  // wait for listen()
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
  });
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let nextId = 1;

/** One request/response round trip over the real socket. */
function call(op: string, payload: Record<string, unknown> = {}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(process.env.BREAKER_SOCKET!);
    let buf = '';
    const id = nextId++;
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ id, op, ...payload }) + '\n'));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      sock.end();
      resolve(JSON.parse(buf.slice(0, nl)));
    });
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 5000);
  });
}

function stateSize(): number {
  try {
    return fs.statSync(process.env.BREAKER_STATE!).size;
  } catch {
    return 0;
  }
}

test('an unknown command fails loudly instead of silently doing nothing', async () => {
  // Ez a frissítés utáni valós állapot: az új GUI már fut, a root démont
  // viszont a launchd csak a következő indításkor cseréli le, tehát a régi
  // helper kap egy olyan parancsot, amit nem ismer. Ha ilyenkor a switch
  // egyszerűen kifutna, a válasz `ok: true, data: undefined` lenne, és a
  // felhasználó azt hinné, beállította a napi keretet — közben semmi nem
  // történt. Egy blokkoló appban ez a legrosszabb hibamód.
  const r = await call('set_something_from_the_future', { siteId: 'x' });
  assert.equal(r.ok, false, 'az ismeretlen parancs nem lehet sikeres');
  assert.match(String(r.error), /nem ismeri ezt a parancsot/);
  assert.equal((r as { code?: string }).code, 'UNKNOWN_OP');
});

test('a known command still answers normally after an unknown one', async () => {
  // Az ismeretlen parancs nem ránthatja magával a kapcsolatot vagy a helpert.
  const r = await call('status');
  assert.equal(r.ok, true);
  assert.equal(typeof (r.data as { helperVersion?: unknown }).helperVersion, 'string',
    'a helper megmondja a protokollverzióját, ebből veszi észre a GUI az elavulást');
});

test('an oversized request line is refused instead of being buffered', async () => {
  // First line of defence: one request is one JSON line, so a client streaming
  // an endless line must be cut off rather than accumulated in memory.
  await assert.rejects(
    () => call('usage_batch', {
      samples: [{ key: 'site:a.com', label: 'x'.repeat(4 * 1024 * 1024), seconds: 5, at: Date.now() }],
    }),
    (err: NodeJS.ErrnoException) => err.code === 'ECONNRESET' || /timeout/.test(String(err.message)),
    'the connection is closed on an oversized line',
  );
});

test('a hostile usage_batch cannot grow the state file without bound', async () => {
  await call('add_site', { input: 'youtube.com', usePreset: false });
  const baseline = stateSize();

  // Second line of defence: requests that fit comfortably under the line cap
  // but carry huge keys and labels. Before hardening, repeating this grew the
  // root-owned state file by hundreds of megabytes and then wedged it for good.
  const huge = 'x'.repeat(100_000);
  for (let round = 0; round < 20; round++) {
    const samples = Array.from({ length: 4 }, (_, i) => ({
      key: `site:${huge}${round}_${i}`,
      label: huge,
      seconds: 5,
      at: Date.now(),
    }));
    const res = await call('usage_batch', { samples });
    assert.equal(res.ok, true, 'the helper stays responsive');
    assert.equal((res.data as { recorded: number }).recorded, 0,
      'oversized keys are rejected outright');
  }

  const grown = stateSize() - baseline;
  assert.ok(grown < 512 * 1024,
    `state file grew by ${grown} bytes; oversized keys and labels must be rejected`);
});

test('the helper can still persist after the hostile batches', async () => {
  // The reported failure mode: once the state file passed what JSON.stringify
  // can produce, every op that commits threw forever and changes were silently
  // lost on restart.
  const res = await call('add_site', { input: 'reddit.com', usePreset: false });
  assert.equal(res.ok, true, 'add_site still works');

  const onDisk = JSON.parse(fs.readFileSync(process.env.BREAKER_STATE!, 'utf8'));
  const domains = (onDisk.sites as { domain: string }[]).map((s) => s.domain);
  assert.deepEqual(domains.sort(), ['reddit.com', 'youtube.com'],
    'both sites survive a restart, not just the in-memory view');
});

test('malformed samples are skipped, valid ones in the same batch still count', async () => {
  const now = Date.now();
  const res = await call('usage_batch', {
    samples: [
      { key: 'nonsense', label: 'x', seconds: 5, at: now },              // no kind prefix
      { key: 'site:a.com', label: 'a', seconds: -5, at: now },           // negative
      { key: 'site:b.com', label: 'b', seconds: Number.NaN, at: now },   // NaN
      { key: 'site:c.com', label: 'c', seconds: 5, at: Number.NaN },     // bad timestamp
      { key: 'site:d.com', label: 'd', seconds: 5, at: now + 400 * 24 * 3600_000 }, // far future
      { key: 42 as unknown as string, label: 'e', seconds: 5, at: now }, // not a string
      { key: 'site:good.com', label: 'good', seconds: 5, at: now },      // the only valid one
    ],
  });
  assert.equal(res.ok, true);
  assert.equal((res.data as { recorded: number }).recorded, 1, 'exactly one sample was accepted');
});

test('a far-future timestamp cannot evict real history', async () => {
  const stats = await call('usage_stats');
  assert.equal(stats.ok, true);
  const onDisk = JSON.parse(fs.readFileSync(process.env.BREAKER_STATE!, 'utf8')) as HelperState;
  const days = onDisk.usage.days.map((d) => d.day);
  // Retention keeps at most RETENTION_DAYS buckets; a rejected far-future
  // sample must not have created one that pushes today's data out.
  assert.ok(days.length >= 1, 'history exists');
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.ok(days.includes(todayKey), "today's bucket is still there");
});

test('a batch is capped and a day cannot hold unbounded targets', async () => {
  const now = Date.now();
  // more samples than the batch cap, all individually valid
  const samples = Array.from({ length: MAX_BATCH_SAMPLES + 400 }, (_, i) => ({
    key: `site:flood${i}.example`, label: `flood${i}`, seconds: 1, at: now,
  }));
  await call('usage_batch', { samples });
  // and again, to push well past the per-day target cap
  await call('usage_batch', { samples: samples.slice(MAX_BATCH_SAMPLES) });

  const onDisk = JSON.parse(fs.readFileSync(process.env.BREAKER_STATE!, 'utf8')) as HelperState;
  const today = onDisk.usage.days[onDisk.usage.days.length - 1];
  const targetCount = Object.keys(today.seconds).length;
  assert.ok(targetCount <= MAX_TARGETS_PER_DAY,
    `a day holds ${targetCount} targets; the cap is ${MAX_TARGETS_PER_DAY}`);
  assert.ok(OTHER_SITE_KEY in today.seconds,
    'the folded-away tail is preserved in the catch-all, not silently dropped');
});

test('the helper socket is not reachable by other local users', () => {
  // The helper runs as root and its socket is a command channel into it. If the
  // file is group- or world-accessible, any local process can drive the root
  // daemon: pause a block, delete a site, rewrite the hosts file.
  if (process.platform === 'win32') return;
  const mode = fs.statSync(process.env.BREAKER_SOCKET!).mode & 0o777;
  assert.equal(mode & 0o077, 0, `socket mode is ${mode.toString(8)}, must be owner-only`);
});
