// A segéd és a védett futtatókörnyezet (helper/runtime.ts, #151): honnan fut,
// melyik változat, a „rendben elindultam” jel, és az önellenőrzés.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { currentTarget, layoutOf, markHealthy, runtimeIdOf, runtimeInfo, selfCheck } from '../src/helper/runtime';
import { statusOf } from '../src/helper/server';
import { defaultState } from '../src/helper/state';
import { RUNTIME_ROOT } from '../src/shared/helper-runtime';

const ID = '0123456789abcdef';

test('a változat neve az útból: csak <futtatókörnyezet>/<16 hexa>/app/dist/helper', () => {
  assert.equal(runtimeIdOf(`${RUNTIME_ROOT}/${ID}/app/dist/helper`), ID);
  for (const bad of [
    `${RUNTIME_ROOT}/current/app/dist/helper`,
    `${RUNTIME_ROOT}/${ID.toUpperCase()}/app/dist/helper`,
    `${RUNTIME_ROOT}/${ID}0/app/dist/helper`,
    `${RUNTIME_ROOT}/${ID}/app/dist/main`,
    `${RUNTIME_ROOT}/${ID}/app/dist/helper/x`,
    `${RUNTIME_ROOT}x/${ID}/app/dist/helper`,
    `/tmp${RUNTIME_ROOT}/${ID}/app/dist/helper`,
    `${RUNTIME_ROOT}/${ID}`,
  ]) {
    assert.equal(runtimeIdOf(bad), null, bad);
  }
  assert.equal(layoutOf(`${RUNTIME_ROOT}/${ID}/app/dist/helper`), 'root');
  assert.equal(layoutOf('/Applications/Breaker.app/Contents/Resources/app.asar/dist/helper'), 'bundle');
  assert.equal(layoutOf('C:\\Program Files\\Breaker\\resources\\app.asar\\dist\\helper'), 'bundle');
  assert.equal(layoutOf('/Users/x/app_blocker/desktop/dist/helper'), 'dev');
});

function fakeRuntime(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrt-'));
  const v = path.join(root, ID);
  fs.mkdirSync(path.join(v, 'app', 'dist', 'helper'), { recursive: true });
  fs.writeFileSync(path.join(v, 'runtime.json'), JSON.stringify({
    payloadSha256: 'a'.repeat(64), binSha256: 'b'.repeat(64), nodeVersion: 'v24.22.1', arch: 'arm64',
  }));
  fs.writeFileSync(path.join(v, 'app', 'package.json'), JSON.stringify({ version: '0.4.300' }));
  fs.symlinkSync(ID, path.join(root, 'current'));
  return root;
}

test('a futó változat adatai a futtatókörnyezet saját fájljaiból; rossz alakú mező kimarad', () => {
  const root = fakeRuntime();
  const dir = path.join(root, ID, 'app', 'dist', 'helper');
  assert.deepEqual(runtimeInfo(dir, root), {
    layout: 'root', id: ID, payloadSha256: 'a'.repeat(64), binSha256: 'b'.repeat(64), nodeVersion: 'v24.22.1', appVersion: '0.4.300',
  });
  fs.writeFileSync(path.join(root, ID, 'runtime.json'), JSON.stringify({ payloadSha256: 'X', nodeVersion: 24 }));
  fs.writeFileSync(path.join(root, ID, 'app', 'package.json'), 'nem json');
  const info = runtimeInfo(dir, root);
  assert.equal(info.layout, 'root');
  assert.equal(info.payloadSha256, undefined);
  assert.equal(info.nodeVersion, undefined);
  assert.equal(info.appVersion, undefined);
  assert.deepEqual(runtimeInfo('/x/app.asar/dist/helper', root), { layout: 'bundle' });
  assert.equal(currentTarget(root), ID);
  fs.rmSync(path.join(root, 'current'));
  fs.symlinkSync('../etc', path.join(root, 'current'));
  assert.equal(currentTarget(root), null, 'csak 16 hexa jegyű célt fogad el');
});

test('a „rendben elindultam” jel: .ok-<név>; a .pending csak akkor megy, ha erre a változatra várt', () => {
  const root = fakeRuntime();
  const logs: string[] = [];
  fs.writeFileSync(path.join(root, '.pending'), `${'f'.repeat(16)}\n${ID}\n`);
  markHealthy(ID, (m) => logs.push(m), root);
  assert.ok(fs.existsSync(path.join(root, `.ok-${ID}`)));
  assert.equal(fs.statSync(path.join(root, `.ok-${ID}`)).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(root, '.pending')), 'másik változatra várt — marad');
  fs.writeFileSync(path.join(root, '.pending'), `${ID}\n${'f'.repeat(16)}\n`);
  markHealthy(ID, (m) => logs.push(m), root);
  assert.ok(!fs.existsSync(path.join(root, '.pending')));
  assert.ok(logs.some((l) => l.includes('a frissítés rendben')));
  // Írhatatlan futtatókörnyezet: nem dob, naplóz.
  markHealthy(ID, (m) => logs.push(m), path.join(root, 'nincs'));
  assert.ok(logs.some((l) => l.includes('nem íródott ki')));
});

test('az önellenőrzés: a segéd lefordított belépési pontja --selfcheck-re ok-t ír, tiszta környezetben, mellékhatás nélkül', () => {
  assert.equal(selfCheck(), true);
  const entry = path.join(__dirname, '..', '..', 'dist', 'helper', 'index.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-'));
  const p = spawnSync(process.execPath, ['--disable-sigusr1', '--no-addons', entry, '--selfcheck'], {
    cwd, env: { PATH: '/usr/bin:/bin', HOME: cwd }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout, 'ok\n');
  assert.deepEqual(fs.readdirSync(cwd), [], 'nem írt semmit');
});

test('a status kimondja, honnan fut a segéd (a tesztben: fejlesztői futás)', () => {
  const st = statusOf(defaultState(), false);
  assert.equal(st.helperLayout, 'dev');
  assert.equal(st.helperRuntime, undefined);
});
