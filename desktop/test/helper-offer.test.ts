// A felület döntései a segéd frissítéséről (shared/helper-offer.ts), a Node
// letöltése (shared/node-download.ts) és a macOS-verzió (helper-runtime.ts), #151.

import { strict as assert } from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { helperBanner, offerAction, type HelperFacts, type OwnBuild } from '../src/shared/helper-offer';
import { macosAtLeast } from '../src/shared/helper-runtime';
import { cachedTarballOk, downloadVerified, type FetchFn } from '../src/shared/node-download';
import { isNewer } from '../src/shared/version';
import { isNewer as manifestIsNewer } from '../src/shared/helper-manifest';

const OWN: OwnBuild = { sha256: 'a'.repeat(64), appVersion: '0.4.301', helperVersion: '0.7.0', signed: true };
const UNSIGNED: OwnBuild = { ...OWN, signed: false };
const root = (over: Partial<HelperFacts> = {}): HelperFacts => ({
  platform: 'darwin', helperVersion: '0.7.0', helperLayout: 'root', helperBuild: 'b'.repeat(64), helperAppVersion: '0.4.300',
  helperUpdate: { state: 'idle' }, ...over,
});

test('felkínálás: csak a védett futtatókörnyezetből futó, a frissítést ismerő, régebbi csomagú segédnek', () => {
  assert.equal(offerAction(root(), OWN), 'offer');
  assert.equal(offerAction(root({ helperBuild: OWN.sha256 }), OWN), 'none', 'ugyanaz a csomag');
  assert.equal(offerAction(root({ helperLayout: 'bundle' }), OWN), 'none', 'a régi elrendezés a gombbal frissül');
  assert.equal(offerAction(root({ platform: 'win32' }), OWN), 'none');
  assert.equal(offerAction(root({ helperVersion: '0.6.8' }), OWN), 'none', 'a régi segéd nem ismeri az ajánlatot');
  assert.equal(offerAction(root({ helperVersion: '0.7.1' }), OWN), 'offer');
  assert.equal(offerAction(root({ helperAppVersion: '0.4.302' }), OWN), 'helper-newer');
  assert.equal(offerAction(root({ helperAppVersion: '0.4.301' }), OWN), 'none', 'ugyanaz a verzió, más csomag: nem kínáljuk');
  assert.equal(offerAction(root({ helperUpdate: { state: 'working' } }), OWN), 'none');
  assert.equal(offerAction(root({ helperUpdate: { state: 'activating' } }), OWN), 'none');
  assert.equal(offerAction(root({ helperUpdate: { state: 'failed', error: 'stage' } }), OWN), 'offer', 'a türelmi időt a segéd tartja');
  // Aláíratlan saját csomag (fejlesztői build, kulcs előtti kiadás): a segéd úgysem venné át.
  assert.equal(offerAction(root(), UNSIGNED), 'none');
  assert.equal(offerAction(root({ helperAppVersion: '0.4.302' }), UNSIGNED), 'helper-newer', 'az app frissítése így is a teendő');
});

test('aláíratlan saját csomagnál nincs csendes út: a sáv a régi szabály szerint (csak protokoll-eltérésre) szól', () => {
  assert.equal(helperBanner(root(), UNSIGNED, '0.7.0'), 'none', 'ugyanaz a protokoll: csendben (a diagnosztika mondja ki)');
  assert.equal(helperBanner(root(), UNSIGNED, '0.7.1'), 'stale', 'más protokoll: gomb, egy jelszó');
  assert.equal(helperBanner(root({ helperUpdate: { state: 'failed', error: 'unsigned' } }), UNSIGNED, '0.7.0'), 'none');
  assert.equal(helperBanner(root({ helperAppVersion: '0.4.400', helperVersion: '0.7.1' }), UNSIGNED, '0.7.0'), 'helper-newer');
  assert.equal(helperBanner(root({ helperBuild: OWN.sha256 }), UNSIGNED, '0.7.0'), 'none');
});

test('a sáv: régi segéd → frissítő gomb; csendes frissítés hibája → javítás; újabb segéd → app-frissítés; különben semmi', () => {
  assert.equal(helperBanner({ helperVersion: '0.6.8' }, OWN, '0.7.0'), 'stale');
  assert.equal(helperBanner({ helperVersion: '0.7.0', helperLayout: 'bundle' }, OWN, '0.7.0'), 'none', 'nem macOS: nincs mit költöztetni');
  assert.equal(helperBanner({ platform: 'darwin', helperVersion: '0.7.0', helperLayout: 'bundle' }, OWN, '0.7.0'), 'move');
  assert.equal(helperBanner({ platform: 'darwin', helperVersion: '0.7.0', helperLayout: 'dev' }, OWN, '0.7.0'), 'none');
  assert.equal(helperBanner({ helperVersion: '0.6.9', helperLayout: 'bundle' }, OWN, '0.7.0'), 'stale');
  assert.equal(helperBanner({}, OWN, '0.7.0'), 'none', 'nincs segéd: más sáv szól');
  assert.equal(helperBanner(root(), OWN, '0.7.0'), 'none', 'a csendes frissítés folyamatban — nem zavarunk');
  assert.equal(helperBanner(root({ helperBuild: OWN.sha256 }), OWN, '0.7.0'), 'none');
  assert.equal(helperBanner(root({ helperUpdate: { state: 'failed', error: 'stage' } }), OWN, '0.7.0'), 'repair');
  assert.equal(helperBanner(root({ helperUpdate: { state: 'rolled-back', error: 'rolled-back' } }), OWN, '0.7.0'), 'repair');
  assert.equal(helperBanner(root({ helperUpdate: { state: 'failed', error: 'need-node' } }), OWN, '0.7.0'), 'none', 'a Node-ot a felület tölti le');
  assert.equal(helperBanner(root({ helperAppVersion: '0.4.400' }), OWN, '0.7.0'), 'helper-newer');
  // Egy újabb protokollú, de csendben frissülő segéd mellett nincs „régi” sáv.
  assert.equal(helperBanner(root({ helperVersion: '0.7.0' }), OWN, '0.7.1'), 'none');
  // Saját csomag nélkül (fejlesztői futás) a régi szabály.
  assert.equal(helperBanner(root(), null, '0.7.1'), 'stale');
});

test('a verzió-összevetés egy helyen: a leíró ugyanazt használja', () => {
  assert.equal(isNewer, manifestIsNewer);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
});

test('macOS-verzió: 13.5 és afölött igen, alatta és rossz alakra nem', () => {
  for (const [v, ok] of [['13.5', true], ['13.5.2', true], ['13.6', true], ['14.0', true], ['26.1', true], ['14', true],
    ['13.4.1', false], ['13', false], ['12.7.6', false], ['', false], ['x', false]] as const) {
    assert.equal(macosAtLeast(v, [13, 5]), ok, v);
  }
});

function fakeFetch(map: Record<string, Buffer | number>, log: string[] = []): FetchFn {
  return async (url) => {
    log.push(url);
    const v = map[url];
    if (typeof v === 'number') return { ok: false, status: v, body: null };
    if (!v) throw new Error('nincs kapcsolat');
    return {
      ok: true, status: 200,
      body: (async function* gen() { for (let i = 0; i < v.length; i += 7) yield new Uint8Array(v.subarray(i, i + 7)); })(),
    };
  };
}

test('Node letöltése: az első jó forrásból; rossz ujjlenyomat, méret, HTTP-hiba — a következőre lép; ha egyik sem jó, dob', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodedl-'));
  const good = crypto.randomBytes(1000);
  const pin = { tarSha256: crypto.createHash('sha256').update(good).digest('hex'), tarSize: good.length };
  const dest = path.join(dir, 'node-v1.2.3-darwin-arm64.tar.xz');
  const log: string[] = [];
  await downloadVerified(['https://a/x', 'https://b/x', 'https://c/x'], dest, pin, fakeFetch({
    'https://a/x': 404, 'https://b/x': Buffer.concat([good, Buffer.from('x')]), 'https://c/x': good,
  }, log));
  assert.deepEqual(log, ['https://a/x', 'https://b/x', 'https://c/x']);
  assert.ok(fs.readFileSync(dest).equals(good));
  assert.deepEqual(fs.readdirSync(dir), [path.basename(dest)], 'ideiglenes fájl nem marad');
  assert.equal(cachedTarballOk(dest, pin), true);
  // Rossz tartalom a gyorsítótárban: törlődik.
  fs.writeFileSync(dest, crypto.randomBytes(1000));
  assert.equal(cachedTarballOk(dest, pin), false);
  assert.ok(!fs.existsSync(dest));
  // Egyik forrás sem jó.
  await assert.rejects(downloadVerified(['https://a/x', 'https://d/x'], dest, pin, fakeFetch({
    'https://a/x': crypto.randomBytes(1000),
  })), /A Node\.js letöltése nem sikerült.*ujjlenyomat.*nincs kapcsolat/s);
  assert.deepEqual(fs.readdirSync(dir), []);
});
