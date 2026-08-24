'use strict';
// A szinkron-kiszolgáló a VALÓDI HTTP-n keresztül.
//
// Amit ezek a tesztek őriznek:
//   1. a kiszolgáló nem lát bele semmibe, és nem is ad ki semmit hitelesítés nélkül;
//   2. két eszköz párhuzamos írása nem tünteti el egyikét sem;
//   3. semmilyen kiszolgálói művelet nem OLDHAT FEL semmit a kliensen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, Store } = require('../server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-sync-'));
const server = createApp(new Store(tmp));
let base;

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function post(url, body) {
  const r = await fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

const ACC = { accountId: 'david@example', authKey: 'AUTH-KULCS-1' };

test('signing up stores only wrapped keys', async () => {
  const r = await post('/v1/signup', {
    ...ACC, wrappedByPassword: 'brk1.a.b.c', wrappedByRecovery: 'brk1.d.e.f',
  });
  assert.equal(r.status, 200);

  // Ami a lemezen fekszik, abban nincs se jelszó, se adatkulcs — csak burkolat.
  const files = fs.readdirSync(path.join(tmp, 'accounts'));
  const raw = fs.readFileSync(path.join(tmp, 'accounts', files[0]), 'utf8');
  assert.ok(!raw.includes(ACC.authKey), 'a belépőkulcs nyersen nem tárolható');
  assert.ok(raw.includes('brk1.a.b.c'), 'a burkolt kulcs viszont igen — az átlátszatlan');
});

test('the same account id cannot be taken twice', async () => {
  const r = await post('/v1/signup', {
    ...ACC, wrappedByPassword: 'brk1.x.y.z', wrappedByRecovery: 'brk1.x.y.z',
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'TAKEN');
});

test('a wrong key and a missing account are indistinguishable', async () => {
  // Különben a hibaüzenetből ki lehetne deríteni, kinek van itt fiókja.
  const wrong = await post('/v1/signin', { ...ACC, authKey: 'ROSSZ' });
  const missing = await post('/v1/signin', { accountId: 'nincs@ilyen', authKey: 'BARMI' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.json, missing.json);
});

test('nothing is served without the auth key', async () => {
  for (const url of ['/v1/pull', '/v1/push', '/v1/usage-all', '/v1/forget-device', '/v1/rekey']) {
    const r = await post(url, { accountId: ACC.accountId, authKey: 'ROSSZ' });
    assert.equal(r.status, 401, `${url} kiadott valamit hitelesítés nélkül`);
  }
});

test('a push builds on a version, and a stale one is refused', async () => {
  const first = await post('/v1/push', {
    ...ACC, collection: 'sites', deviceId: 'gep-a', baseVersion: 0, payload: 'brk1.1.1.1',
  });
  assert.deepEqual(first.json, { ok: true, version: 1 });

  // A másik eszköz még a 0-s verziót ismeri: NEM írhatja felül. Enélkül az
  // egyik gép csendben eltüntetné a másik blokkjait.
  const stale = await post('/v1/push', {
    ...ACC, collection: 'sites', deviceId: 'gep-b', baseVersion: 0, payload: 'brk1.2.2.2',
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.conflict, true);
  assert.equal(stale.json.version, 1);
  assert.equal(stale.json.payload, 'brk1.1.1.1', 'az aktuális tartalmat visszaadja, hogy fésülni lehessen');

  // Fésülés után a helyes alapverzióval már átmegy.
  const retry = await post('/v1/push', {
    ...ACC, collection: 'sites', deviceId: 'gep-b', baseVersion: 1, payload: 'brk1.3.3.3',
  });
  assert.deepEqual(retry.json, { ok: true, version: 2 });

  const pulled = await post('/v1/pull', { ...ACC, collection: 'sites' });
  assert.equal(pulled.json.payload, 'brk1.3.3.3');
  assert.equal(pulled.json.version, 2);
});

test('usage is per device, and every device is readable in one call', async () => {
  await post('/v1/push', {
    ...ACC, collection: 'usage', deviceId: 'gep-a', baseVersion: 0, payload: 'brk1.a.a.a', nameBlob: 'brk1.n.a.a',
  });
  await post('/v1/push', {
    ...ACC, collection: 'usage', deviceId: 'gep-b', baseVersion: 0, payload: 'brk1.b.b.b', nameBlob: 'brk1.n.b.b',
  });
  // Az egyik eszköz feltöltése nem üti a másikét — ebből lesz a másik eszköz
  // statisztikája a felületen.
  const all = await post('/v1/usage-all', ACC);
  const byId = Object.fromEntries(all.json.devices.map((d) => [d.deviceId, d.payload]));
  assert.equal(byId['gep-a'], 'brk1.a.a.a');
  assert.equal(byId['gep-b'], 'brk1.b.b.b');
});

test('forgetting a device only removes it from the account', async () => {
  // A helyi blokkokhoz a kiszolgáló nem is fér hozzá — de a mérése megmarad,
  // tehát a visszacsatlakozás nem veszít adatot.
  const r = await post('/v1/forget-device', { ...ACC, deviceId: 'gep-b' });
  assert.equal(r.status, 200);
  assert.ok(!r.json.devices.some((d) => d.deviceId === 'gep-b'));
  const still = await post('/v1/pull', { ...ACC, collection: 'usage', deviceId: 'gep-b' });
  assert.equal(still.json.payload, 'brk1.b.b.b', 'az adata megmarad, csak nem listázzuk');
});

test('changing the password rewraps the key without touching the data', async () => {
  const before = await post('/v1/pull', { ...ACC, collection: 'sites' });
  const r = await post('/v1/rekey', {
    ...ACC, newAuthKey: 'AUTH-KULCS-2', newWrappedByPassword: 'brk1.uj.uj.uj',
  });
  assert.equal(r.status, 200);

  assert.equal((await post('/v1/signin', ACC)).status, 401, 'a régi kulcs már nem jó');
  const now = await post('/v1/signin', { accountId: ACC.accountId, authKey: 'AUTH-KULCS-2' });
  assert.equal(now.json.wrappedByPassword, 'brk1.uj.uj.uj');

  const after = await post('/v1/pull', { accountId: ACC.accountId, authKey: 'AUTH-KULCS-2', collection: 'sites' });
  assert.deepEqual(after.json, before.json, 'a tárolt adat egy bájtot sem változott');
});

test('oversized and malformed input is refused', async () => {
  const acc2 = { accountId: 'nagy@example', authKey: 'K' };
  await post('/v1/signup', { ...acc2, wrappedByPassword: 'brk1.a.b.c', wrappedByRecovery: 'brk1.a.b.c' });

  const big = await post('/v1/push', {
    ...acc2, collection: 'sites', deviceId: 'g', baseVersion: 0, payload: 'x'.repeat(1_000_001),
  });
  assert.equal(big.status, 413);

  const badJson = await fetch(base + '/v1/pull', { method: 'POST', body: '{nem json' });
  assert.equal(badJson.status, 400);

  const badProto = await post('/v1/pull', { ...acc2, protocol: 99, collection: 'sites' });
  assert.equal(badProto.status, 426, 'más protokollverziónál mondja meg, hogy frissíteni kell');

  const badCollection = await post('/v1/pull', { ...acc2, collection: 'akarmi' });
  assert.equal(badCollection.status, 400);
});

test('an unknown route and a GET do not leak anything', async () => {
  assert.equal((await fetch(base + '/v1/pull')).status, 404, 'GET-re nincs adat');
  assert.equal((await post('/nincs-ilyen', {})).status, 404);
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, protocol: 1 });
});

test('signup can be closed off on a private server', async () => {
  const closed = createApp(new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-closed-'))),
    { openSignup: false });
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${closed.address().port}/v1/signup`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: 'valaki@example', authKey: 'K', wrappedByPassword: 'brk1.a.b.c', wrappedByRecovery: 'brk1.a.b.c' }),
  });
  assert.equal(r.status, 403);
  closed.close();
});

test('an account cannot collect devices without bound', async () => {
  // Eszközönként külön mérés-blob tárolódik, tehát eszközazonosítókat gyártva
  // egy fiók korlátlanul enné a lemezt.
  const acc = { accountId: 'sok@example', authKey: 'K' };
  await post('/v1/signup', { ...acc, wrappedByPassword: 'brk1.a.b.c', wrappedByRecovery: 'brk1.a.b.c' });
  for (let i = 0; i < 25; i++) {
    await post('/v1/signin', { ...acc, deviceId: `dev-${i}`, nameBlob: 'brk1.n.n.n' });
  }
  const r = await post('/v1/signin', { ...acc, deviceId: 'dev-utolso' });
  assert.equal(r.json.devices.length, 20, 'a lista korlátos marad');
  // A LEGRÉGEBBEN látott esik ki, nem az, aki most jelentkezett be.
  assert.ok(r.json.devices.some((d) => d.deviceId === 'dev-utolso'));
  assert.ok(!r.json.devices.some((d) => d.deviceId === 'dev-0'));
});

test('signup can close itself after the first account', async () => {
  // Ezt használja a beépített (asztali appból indított) kiszolgáló: az első
  // fiók után a hálózaton más ne tudjon újat nyitni rajta.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-once-'));
  const store = new Store(dir);
  const once = createApp(store, { openSignup: () => !store.hasAnyAccount() });
  await new Promise((r) => once.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${once.address().port}/v1/signup`;
  const body = (id) => JSON.stringify({
    accountId: id, authKey: 'K', wrappedByPassword: 'brk1.a.b.c', wrappedByRecovery: 'brk1.a.b.c',
  });
  const headers = { 'content-type': 'application/json' };

  const first = await fetch(url, { method: 'POST', headers, body: body('elso@example') });
  assert.equal(first.status, 200, 'az első fiók létrejön');
  const second = await fetch(url, { method: 'POST', headers, body: body('masodik@example') });
  assert.equal(second.status, 403, 'a második már nem');
  once.close();
})
