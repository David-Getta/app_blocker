// A WINDOWS-SEGÉD KAPUJA: a kulcsos segéd csak a `hello`-val és a jó kulccsal
// kezdő kapcsolatnak felel. A valódi szerver (`startServer`), a valódi kliens
// (`HelperClient`), valódi socketen — a platformtól függetlenül, mert a kapu
// a kulcson múlik, nem a Windowson. (Hogy Windowson a sima felhasználó
// tényleg eléri a SYSTEM-szervert, azt a CI Windows-próbája nézi:
// desktop/scripts/win-pipe-probe.ps1.)

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-auth-'));
process.env.BREAKER_STATE = path.join(tmp, 'state.json');
process.env.BREAKER_HOSTS = path.join(tmp, 'hosts');
const KEYED = path.join(tmp, 'keyed.sock');
const KEYLESS = path.join(tmp, 'keyless.sock');
const OLD = path.join(tmp, 'old.sock');
fs.writeFileSync(process.env.BREAKER_HOSTS, '127.0.0.1 localhost\n');

import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { startServer } from '../src/helper/server';
import { defaultState } from '../src/helper/state';
import { HelperClient } from '../src/main/helper-client';
import {
  CLIENT_KEY_ARG, clientKeyHash, clientKeyMatches, isClientKey, keyHashFromArgs, newClientKey,
} from '../src/shared/client-key';

const KEY = newClientKey();
let keyed: net.Server;
let keyless: net.Server;
let old: net.Server;
let noted = 0;

function serve(sock: string, clientKeySha256?: string): Promise<net.Server> {
  process.env.BREAKER_SOCKET = sock;
  const state = defaultState();
  const server = startServer({
    getState: () => state,
    commit: () => {},
    dohApplied: () => false,
    log: () => {},
    selfTest: () => null,
    runSelfTest: async () => ({ at: 0, checked: 0, leaking: [], unresolved: 0 }),
    noteClient: () => { noted += 1; },
    clientKeySha256,
  });
  return new Promise((resolve) => {
    if (server.listening) resolve(server);
    else server.once('listening', () => resolve(server));
  });
}

before(async () => {
  keyed = await serve(KEYED, clientKeyHash(KEY));
  keyless = await serve(KEYLESS);
  // Egy RÉGI segéd: a `hello`-t nem ismeri, a többire felel.
  old = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, nl)) as { id: number; op: string };
        buf = buf.slice(nl + 1);
        conn.write(JSON.stringify(req.op === 'hello'
          ? { id: req.id, ok: false, error: 'ismeretlen', code: 'UNKNOWN_OP' }
          : { id: req.id, ok: true, data: { helperVersion: 'régi' } }) + '\n');
      }
    });
  });
  await new Promise<void>((resolve) => old.listen(OLD, () => resolve()));
});

after(() => {
  keyed.close();
  keyless.close();
  old.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Nyers sorok egy kapcsolaton: a válaszok, és hogy a szerver bontott-e. */
function rawSession(sock: string, lines: unknown[]): Promise<{ replies: Array<{ ok: boolean; code?: string }>; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    const replies: Array<{ ok: boolean; code?: string }> = [];
    let buf = '';
    let closed = false;
    c.setEncoding('utf8');
    c.on('connect', () => { for (const l of lines) c.write(JSON.stringify(l) + '\n'); });
    c.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        replies.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
    });
    c.on('end', () => { closed = true; });
    c.on('close', () => resolve({ replies, closed }));
    c.on('error', reject);
    setTimeout(() => { c.destroy(); }, 1500);
  });
}

test('a kulcs-modul: csak a szigorú alak, és a lenyomat időzítés-biztos egyezése', () => {
  assert.ok(isClientKey(KEY));
  assert.ok(clientKeyMatches(KEY, clientKeyHash(KEY)));
  assert.equal(clientKeyMatches(newClientKey(), clientKeyHash(KEY)), false);
  for (const bad of [undefined, null, 42, '', KEY.toUpperCase(), KEY.slice(1), `${KEY} `, { key: KEY }]) {
    assert.equal(clientKeyMatches(bad, clientKeyHash(KEY)), false, JSON.stringify(bad));
  }
  assert.equal(clientKeyMatches(KEY, 'nem lenyomat'), false);
  const hash = clientKeyHash(KEY);
  assert.equal(keyHashFromArgs(['node', 'x', '--helper', `${CLIENT_KEY_ARG}${hash}`]), hash);
  assert.equal(keyHashFromArgs(['--helper']), undefined);
  assert.equal(keyHashFromArgs([`${CLIENT_KEY_ARG}${hash.toUpperCase()}`]), undefined, 'csak kisbetű');
  assert.equal(keyHashFromArgs([`${CLIENT_KEY_ARG}xyz`]), undefined);
});

test('kulcsos segéd: hello nélkül egyetlen parancs sem fut, és a kapcsolat bomlik', async () => {
  const before = noted;
  const r = await rawSession(KEYED, [{ id: 1, op: 'status' }, { id: 2, op: 'status' }]);
  assert.equal(r.replies[0]?.ok, false);
  assert.equal(r.replies[0]?.code, 'UNAUTHORIZED');
  assert.ok(r.closed, 'a szerver bontott');
  assert.ok(!r.replies.some((x) => x.ok), 'semmi nem futott le');
  assert.equal(noted, before, 'a kulcs nélküli kérés nem jelzi az app jelenlétét');
});

test('kulcsos segéd: rossz kulcs — elutasítva és bontva', async () => {
  const r = await rawSession(KEYED, [{ id: 1, op: 'hello', key: newClientKey() }, { id: 2, op: 'status' }]);
  assert.equal(r.replies[0]?.code, 'UNAUTHORIZED');
  assert.ok(r.closed);
  assert.ok(!r.replies.some((x) => x.ok));
});

test('kulcsos segéd: jó kulccsal a kapcsolat él, a parancsok futnak', async () => {
  const before = noted;
  const r = await rawSession(KEYED, [{ id: 1, op: 'hello', key: KEY }, { id: 2, op: 'status' }]);
  assert.deepEqual(r.replies.map((x) => x.ok), [true, true]);
  assert.ok(noted > before, 'a hitelesített kérés jelzi az app jelenlétét');
});

test('a kliens: kulccsal szóba áll a kulcsos segéddel; kulcs nélkül kimondott hibát kap', async () => {
  process.env.BREAKER_SOCKET = KEYED;
  const good = new HelperClient({ key: () => KEY });
  const st = await good.call('status') as { helperVersion: string };
  assert.ok(st.helperVersion, 'a status megjött');
  // Ugyanazon a kapcsolaton egymás után is.
  await good.call('status');
  good.close();

  const none = new HelperClient();
  await assert.rejects(none.call('status'), (e: Error & { code?: string }) => e.code === 'UNAUTHORIZED');
  none.close();
  const wrong = new HelperClient({ key: () => newClientKey() });
  await assert.rejects(wrong.call('status'), (e: Error & { code?: string }) => e.code === 'UNAUTHORIZED');
  wrong.close();
});

test('a kliens: egyszerre indított kérések is megvárják a kézfogást', async () => {
  process.env.BREAKER_SOCKET = KEYED;
  const c = new HelperClient({ key: () => KEY });
  const all = await Promise.all([c.call('status'), c.call('status'), c.call('status')]);
  assert.equal(all.length, 3);
  c.close();
});

test('kulcs nélküli segéd (macOS, Linux): a hello üres jóváhagyás, a kulcsos kliens is megy', async () => {
  process.env.BREAKER_SOCKET = KEYLESS;
  const c = new HelperClient({ key: () => KEY });
  assert.ok(await c.call('status'));
  c.close();
  const plain = new HelperClient();
  assert.ok(await plain.call('status'));
  plain.close();
});

test('régi segéd: a hello-t nem ismeri — a kliens nem akad el rajta', async () => {
  process.env.BREAKER_SOCKET = OLD;
  const c = new HelperClient({ key: () => KEY });
  const st = await c.call('status') as { helperVersion: string };
  assert.equal(st.helperVersion, 'régi');
  c.close();
});
