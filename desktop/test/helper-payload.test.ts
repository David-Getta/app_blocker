// A segéd csomagja (scripts/pack-helper-payload.js) és a leíró aláírása
// (scripts/sign-helper-manifest.js), #151: a csomagban pontosan a segéd kódja
// van, determinisztikus, a rendszer tar-ja kibontja, rootként csak beépített
// modul tölthető be, és csak egy telepített segéd által ismert kulccsal írunk
// alá.

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  parseManifest, TEST_KEY_ID, UNSIGNED_KEY_ID, verifyManifest, type ReleaseKey,
} from '../src/shared/helper-manifest';
import {
  NODE_RUNTIME, nodeTarName, nodeTarUrls, PAYLOAD_ENTRY, RUNTIME_ENTRY, RUNTIME_ID_RE, RUNTIME_ROOT, runtimeId,
} from '../src/shared/helper-runtime';
import { HELPER_VERSION } from '../src/shared/protocol';

const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const packer = require(path.join(ROOT, 'scripts', 'pack-helper-payload.js'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const signer = require(path.join(ROOT, 'scripts', 'sign-helper-manifest.js'));

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function packTo(opts: Record<string, unknown> = {}) {
  const dir = tmp('payload-');
  const r = packer.pack({ out: path.join(dir, 'helper'), infoPath: path.join(dir, 'helper-payload.json'), appVersion: '0.4.300', ...opts });
  return { dir, out: path.join(dir, 'helper'), ...r };
}

function keyPair(id = 'r1'): { key: ReleaseKey; pem: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    key: { id, spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

test('a csomag: a belépési pontból elérhető kód, az eltávolító és a package.json — más semmi', () => {
  const r = packTo();
  const entries = packer.readTarNames(r.tar) as Array<{ name: string; type: string; mode: number; size: number }>;
  const files = entries.filter((e) => e.type === '0').map((e) => e.name);
  const closure = (packer.collectClosure(DIST) as string[]).map((f) => `app/dist/${f}`);
  assert.deepEqual(files.sort(), [...closure, 'app/dist/uninstall/uninstall-macos.sh', 'app/package.json'].sort());
  assert.ok(files.includes(PAYLOAD_ENTRY), 'a belépési pont a csomagban');
  assert.ok(closure.length > 20, `a zárlat gyanúsan kicsi: ${closure.length}`);
  assert.ok(!files.some((f) => f.startsWith('app/dist/main/') || f.startsWith('app/dist/ui/')), 'GUI-kód a csomagban');
  assert.ok(!files.includes('app/test-keys.json'), 'próba-kulcs a kiadási csomagban');
  // Csak sima fájl és mappa, rögzített jogokkal.
  for (const e of entries) {
    assert.ok(e.type === '0' || e.type === '5', `${e.name}: ${e.type}`);
    const want = e.type === '5' || e.name.endsWith('.sh') ? 0o755 : 0o644;
    assert.equal(e.mode, want, e.name);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.notEqual(pkg.version, undefined);
});

test('determinisztikus: kétszer csomagolva bájtra ugyanaz; más verzió más ujjlenyomat', () => {
  const a = packTo();
  const b = packTo();
  assert.equal(packer.sha256(a.tar), packer.sha256(b.tar));
  assert.ok(fs.readFileSync(path.join(a.out, 'payload.tar')).equals(fs.readFileSync(path.join(b.out, 'payload.tar'))));
  assert.ok(fs.readFileSync(path.join(a.out, 'manifest.json')).equals(fs.readFileSync(path.join(b.out, 'manifest.json'))));
  const c = packTo({ appVersion: '0.4.301' });
  assert.notEqual(packer.sha256(c.tar), packer.sha256(a.tar));
  // A fejlécben nincs idő, tulajdonos-név, gép-függő adat.
  for (let off = 0; off < a.tar.length; off += 512) {
    const h = a.tar.subarray(off, off + 512);
    if (h.subarray(257, 262).toString() !== 'ustar') continue;
    assert.equal(h.subarray(136, 147).toString(), '00000000000', 'mtime');
    assert.equal(h.subarray(265, 329).toString().replace(/\0/g, ''), '', 'uname/gname');
  }
});

test('a rendszer tar-ja kibontja, és a kibontott fájlok egyeznek a lefordított kóddal', () => {
  const r = packTo();
  const x = tmp('payload-x-');
  execFileSync('tar', ['-xf', path.join(r.out, 'payload.tar'), '-C', x]);
  for (const rel of packer.collectClosure(DIST) as string[]) {
    assert.ok(fs.readFileSync(path.join(x, 'app', 'dist', rel)).equals(fs.readFileSync(path.join(DIST, rel))), rel);
  }
  assert.ok(fs.readFileSync(path.join(x, 'app', 'dist', 'uninstall', 'uninstall-macos.sh'))
    .equals(fs.readFileSync(path.join(ROOT, 'scripts', 'uninstall-macos.sh'))));
  const pkg = JSON.parse(fs.readFileSync(path.join(x, 'app', 'package.json'), 'utf8'));
  assert.deepEqual(pkg, { name: 'breaker-helper', private: true, type: 'commonjs', version: '0.4.300' });
  // A tar a saját listájában is ugyanazt látja.
  const listed = execFileSync('tar', ['-tf', path.join(r.out, 'payload.tar')], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(listed, (packer.readTarNames(r.tar) as Array<{ name: string }>).map((e) => e.name));
});

test('a leíró: a csomag ujjlenyomata, a rögzített Node, a segéd protokollja; aláíratlanul', () => {
  const r = packTo();
  const bytes = fs.readFileSync(path.join(r.out, 'manifest.json'));
  const m = parseManifest(bytes);
  assert.equal(m.payload.sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(r.out, 'payload.tar'))).digest('hex'));
  assert.equal(m.payload.size, fs.statSync(path.join(r.out, 'payload.tar')).size);
  assert.equal(m.appVersion, '0.4.300');
  assert.equal(m.helperVersion, HELPER_VERSION);
  assert.equal(m.keyId, UNSIGNED_KEY_ID);
  assert.deepEqual(m.node, { version: NODE_RUNTIME.version, arm64: NODE_RUNTIME.arm64, x64: NODE_RUNTIME.x64 });
  assert.ok(!fs.existsSync(path.join(r.out, 'manifest.sig')));
  const info = JSON.parse(fs.readFileSync(path.join(r.dir, 'helper-payload.json'), 'utf8'));
  assert.deepEqual(info, { sha256: m.payload.sha256, size: m.payload.size, appVersion: '0.4.300', helperVersion: HELPER_VERSION });
  // A szkript és a mag ugyanazokat a foglalt azonosítókat ismeri.
  assert.equal(packer.UNSIGNED_KEY_ID, UNSIGNED_KEY_ID);
  assert.equal(packer.TEST_KEY_ID, TEST_KEY_ID);
});

test('a próba-kulcs csak kérésre kerül a csomagba, és csak base64 lehet', () => {
  const k = keyPair();
  const r = packTo({ testPubkey: k.key.spki });
  const x = tmp('payload-k-');
  execFileSync('tar', ['-xf', path.join(r.out, 'payload.tar'), '-C', x]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x, 'app', 'test-keys.json'), 'utf8')), [{ id: TEST_KEY_ID, spki: k.key.spki }]);
  assert.throws(() => packTo({ testPubkey: 'nem"base64' }), /nem base64/);
  assert.throws(() => packTo({ appVersion: '0.4' }), /nem x\.y\.z/);
});

/** Egy kis dist-fa a szabályok próbájához. */
function fakeDist(files: Record<string, string>): string {
  const root = tmp('fake-');
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return root;
}

test('rootként csak beépített modul: npm-csomag, GUI-kód, változós require — a csomagolás elhasal', () => {
  const ok = fakeDist({
    'helper/index.js': 'require("./a"); require("node:fs"); require(\'crypto\'); require("../shared/b.js");',
    'helper/a.js': 'const { x } = require("../shared/sync/c");',
    'shared/b.js': 'require("path")',
    'shared/sync/c.js': '',
    'shared/unused.js': 'require("electron")',
  });
  assert.deepEqual(packer.collectClosure(ok), ['helper/a.js', 'helper/index.js', 'shared/b.js', 'shared/sync/c.js']);

  const bad: Array<[string, Record<string, string>, RegExp]> = [
    ['npm-csomag', { 'helper/index.js': 'require("electron-updater")' }, /nem beépített modul: electron-updater/],
    ['electron', { 'helper/index.js': 'require("electron")' }, /nem beépített modul: electron/],
    ['GUI-kód', { 'helper/index.js': 'require("../main/updater")', 'main/updater.js': '' }, /csak a helper, shared mappából/],
    ['változós', { 'helper/index.js': 'const m = "fs"; require(m)' }, /nem szöveges require/],
    ['sablon', { 'helper/index.js': 'require(`fs`)' }, /nem szöveges require/],
    ['hiányzó', { 'helper/index.js': 'require("./nincs")' }, /nem található: \.\/nincs/],
    ['őrizetlen original-fs', { 'helper/index.js': 'require("original-fs")' }, /nem őrzi/],
    ['megjegyzésben is', { 'helper/index.js': '// require("left-pad")' }, /nem beépített modul: left-pad/],
  ];
  for (const [label, files, re] of bad) {
    assert.throws(() => packer.collectClosure(fakeDist(files)), re, label);
  }
  // Az original-fs az Electron-őr mögött megengedett.
  const guarded = fakeDist({ 'helper/index.js': 'if (process.versions.electron) require("original-fs")' });
  assert.deepEqual(packer.collectClosure(guarded), ['helper/index.js']);
  // Szimbolikus link a zárlatban: hiba.
  const linked = fakeDist({ 'helper/index.js': 'require("./l")', 'helper/real.js': '' });
  fs.symlinkSync(path.join(linked, 'helper', 'real.js'), path.join(linked, 'helper', 'l.js'));
  assert.throws(() => packer.collectClosure(linked), /szimbolikus link/);
});

test('a tar-író: hosszú út előtaggal, rossz út és kettőzés elutasítva', () => {
  const long = `app/${'a'.repeat(60)}/${'b'.repeat(60)}/c.js`;
  const tar = packer.makeTar([{ path: long, mode: 0o644, data: Buffer.from('x') }]);
  assert.equal(tar.length % 10240, 0);
  const names = (packer.readTarNames(tar) as Array<{ name: string }>).map((e) => e.name);
  assert.ok(names.includes(long), names.join(','));
  const x = tmp('tar-long-');
  fs.writeFileSync(path.join(x, 't.tar'), tar);
  execFileSync('tar', ['-xf', path.join(x, 't.tar'), '-C', x]);
  assert.equal(fs.readFileSync(path.join(x, ...long.split('/')), 'utf8'), 'x');
  for (const p of ['../x', 'app/../x', '/abs', 'app/./x', 'app/x y', 'app/é', 'app/x/']) {
    assert.throws(() => packer.makeTar([{ path: p, mode: 0o644, data: Buffer.alloc(0) }]), /rossz út/, p);
  }
  assert.throws(() => packer.makeTar([
    { path: 'a/b', mode: 0o644, data: Buffer.alloc(0) }, { path: 'a/b', mode: 0o644, data: Buffer.alloc(0) },
  ]), /kétszer/);
  assert.throws(() => packer.makeTar([
    { path: 'a/b', mode: 0o644, data: Buffer.alloc(0) }, { path: 'a/b/c', mode: 0o644, data: Buffer.alloc(0) },
  ]), /fájl és mappa is/);
  assert.throws(() => packer.makeTar([{ path: `${'d'.repeat(160)}/${'f'.repeat(101)}`, mode: 0o644, data: Buffer.alloc(0) }]), /túl hosszú/);
});

test('aláírás: a kulcs a listán → aláírt, a segéd ellenőrzése szerint érvényes; a keyId a kulcsé', () => {
  const k = keyPair('r3');
  const r = packTo();
  const res = signer.sign({ dir: r.out, pem: k.pem, keys: [keyPair('r1').key, k.key] });
  assert.deepEqual(res, { signed: true, keyId: 'r3' });
  const bytes = fs.readFileSync(path.join(r.out, 'manifest.json'));
  const sig = fs.readFileSync(path.join(r.out, 'manifest.sig'), 'utf8');
  const m = verifyManifest(bytes, sig, [k.key]);
  assert.equal(m.keyId, 'r3');
  assert.equal(m.payload.sha256, packer.sha256(fs.readFileSync(path.join(r.out, 'payload.tar'))));
  // Kiadásként is (nincs próba-kulcs a csomagban).
  const r2 = packTo();
  assert.equal(signer.sign({ dir: r2.out, pem: k.pem, keys: [k.key], release: true }).keyId, 'r3');
});

test('aláírás: listán kívüli kulcs, nem Ed25519, rossz PEM — elutasítva, a titok nem kerül az üzenetbe', () => {
  const r = packTo();
  const listed = keyPair('r1');
  const stranger = keyPair('r9');
  assert.throws(() => signer.sign({ dir: r.out, pem: stranger.pem, keys: [listed.key] }), /nincs se a kiadási kulcsok listáján/);
  assert.throws(() => signer.sign({ dir: r.out, pem: stranger.pem, keys: [listed.key], release: true }), /egy telepített segéd sem fogadná el/);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.throws(() => signer.sign({ dir: r.out, pem: rsa, keys: [listed.key] }), /nem Ed25519/);
  const garbage = '-----BEGIN PRIVATE KEY-----\nTITOK-NE-LÁSSAM\n-----END PRIVATE KEY-----\n';
  assert.throws(() => signer.sign({ dir: r.out, pem: garbage, keys: [listed.key] }), (e: Error) => {
    assert.match(e.message, /nem olvasható titkos kulcs/);
    assert.ok(!e.message.includes('TITOK'), 'a titok az üzenetben');
    return true;
  });
  assert.ok(!fs.existsSync(path.join(r.out, 'manifest.sig')));
  assert.equal(parseManifest(fs.readFileSync(path.join(r.out, 'manifest.json'))).keyId, UNSIGNED_KEY_ID);
});

test('aláírás: a próba-kulcs csak próbán, csak ha a csomag is hordozza; kiadásban soha', () => {
  const t = keyPair(TEST_KEY_ID);
  const withKey = packTo({ testPubkey: t.key.spki });
  assert.deepEqual(signer.sign({ dir: withKey.out, pem: t.pem, testPubkey: t.key.spki, keys: [] }), { signed: true, keyId: TEST_KEY_ID });
  verifyManifest(fs.readFileSync(path.join(withKey.out, 'manifest.json')), fs.readFileSync(path.join(withKey.out, 'manifest.sig'), 'utf8'), [t.key]);
  // Kiadásban a próba-kulcsos csomag már a kulcs előtt elbukik.
  assert.throws(() => signer.sign({ dir: withKey.out, release: true, keys: [] }), /nem lehet a CI-próba kulcsa/);
  assert.throws(() => signer.sign({ dir: withKey.out, pem: t.pem, testPubkey: t.key.spki, release: true, keys: [] }), /nem lehet a CI-próba kulcsa/);
  // Próba-kulcs, de a csomagban nincs: a segéd úgysem fogadná el.
  const without = packTo();
  assert.throws(() => signer.sign({ dir: without.out, pem: t.pem, testPubkey: t.key.spki, keys: [] }), /nincs test-keys\.json/);
  // Kiadásban a próba-kulcs a bizalmi körbe sem kerül be.
  assert.throws(() => signer.sign({ dir: without.out, pem: t.pem, testPubkey: t.key.spki, release: true, keys: [] }), /egy telepített segéd sem fogadná el/);
});

test('aláírás kulcs nélkül: fejlesztői build aláíratlan; kiadás csak amíg nincs kiadási kulcs', () => {
  const k = keyPair();
  const r = packTo();
  // Egy korábbi aláírás nem maradhat ott.
  signer.sign({ dir: r.out, pem: k.pem, keys: [k.key] });
  assert.ok(fs.existsSync(path.join(r.out, 'manifest.sig')));
  const again = packTo();
  fs.copyFileSync(path.join(r.out, 'manifest.sig'), path.join(again.out, 'manifest.sig'));
  assert.deepEqual(signer.sign({ dir: again.out, keys: [k.key] }), { signed: false, why: 'dev' });
  assert.ok(!fs.existsSync(path.join(again.out, 'manifest.sig')), 'régi aláírás maradt');
  assert.deepEqual(signer.sign({ dir: again.out, release: true, keys: [] }), { signed: false, why: 'no-keys' });
  assert.throws(() => signer.sign({ dir: again.out, release: true, keys: [k.key] }), /a HELPER_SIGNING_KEY üres/);
});

test('aláírás: elavult leíró (a csomag változott) — nem írjuk alá', () => {
  const k = keyPair();
  const r = packTo();
  fs.appendFileSync(path.join(r.out, 'payload.tar'), Buffer.alloc(512, 0));
  assert.throws(() => signer.sign({ dir: r.out, pem: k.pem, keys: [k.key] }), /nem ehhez a payload\.tar-hoz/);
});

test('a kiadási kulcsok listáját az aláíró a forrásból olvassa — ugyanazt, amit a segéd lefordítva ismer', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { RELEASE_KEYS } = require(path.join(DIST, 'shared', 'helper-keys.js'));
  assert.deepEqual(signer.readReleaseKeys(), RELEASE_KEYS);
  const src = (body: string) => `// fej\nexport const RELEASE_KEYS: readonly ReleaseKey[] = [${body}];\n`;
  assert.deepEqual(signer.readReleaseKeys(src("\n  { id: 'r1', spki: 'QUJD' }, // első\n  { id: 'r2', spki: 'REVG' },\n")),
    [{ id: 'r1', spki: 'QUJD' }, { id: 'r2', spki: 'REVG' }]);
  for (const bad of ['KULCS', "{ id: 'r1', spki: 'QUJD' }, ...MAS", "{ id: 'r1', spki: KULCS }"]) {
    assert.throws(() => signer.readReleaseKeys(src(bad)), /ismeretlen alakú/, bad);
  }
  assert.throws(() => signer.readReleaseKeys('export const RELEASE_KEYS = [];'), /nem olvasható/);
});

test('az aláíró a lefordított kód és a függőségek nélkül fut (a kiadásban a kulcs mellett semmi más)', () => {
  const root = tmp('signer-');
  for (const f of ['scripts/sign-helper-manifest.js', 'scripts/pack-helper-payload.js', 'src/shared/helper-keys.ts']) {
    fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(root, f));
  }
  const r = packTo();
  const env = { PATH: process.env.PATH ?? '', HELPER_SIGNING_KEY: '', BREAKER_HELPER_TEST_PUBKEY: '' };
  if (signer.readReleaseKeys().length === 0) {
    const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'sign-helper-manifest.js'), '--release', r.out], { env, encoding: 'utf8', cwd: root });
    assert.match(out, /::warning::/);
  }
  // Egy listán kívüli kulccsal: a lista olvasható volt, a hiba a kulcsé — nem egy hiányzó modulé.
  assert.throws(() => execFileSync(process.execPath, [path.join(root, 'scripts', 'sign-helper-manifest.js'), '--release', r.out], {
    env: { ...env, HELPER_SIGNING_KEY: keyPair('x').pem }, stdio: 'pipe', cwd: root,
  }), (e: Error & { stderr: Buffer }) => {
    assert.match(String(e.stderr), /nincs a kiadási kulcsok listáján/);
    return true;
  });
});

test('átvétel (a kiadás útja): a másik jobban aláírt leíró csak a bájtra egyező csomag mellé kerül', () => {
  const k = keyPair('r1');
  // Az aláíró job buildje, és a csomagolóé: ugyanabból a forrásból, tehát ugyanaz.
  const signedBuild = packTo();
  signer.sign({ dir: signedBuild.out, pem: k.pem, keys: [k.key], release: true });
  const own = packTo();
  assert.deepEqual(signer.adopt({ dir: own.out, from: signedBuild.out, keys: [k.key] }), { signed: true, keyId: 'r1' });
  const m = verifyManifest(fs.readFileSync(path.join(own.out, 'manifest.json')), fs.readFileSync(path.join(own.out, 'manifest.sig'), 'utf8'), [k.key]);
  assert.equal(m.payload.sha256, packer.sha256(fs.readFileSync(path.join(own.out, 'payload.tar'))));
  // Más forrás (itt: más verzió) — más csomag: megáll, és semmit nem ír.
  const other = packTo({ appVersion: '0.4.301' });
  const before = fs.readFileSync(path.join(other.out, 'manifest.json'));
  assert.throws(() => signer.adopt({ dir: other.out, from: signedBuild.out, keys: [k.key] }), /eltér/);
  assert.ok(fs.readFileSync(path.join(other.out, 'manifest.json')).equals(before));
  assert.ok(!fs.existsSync(path.join(other.out, 'manifest.sig')));
  // Ugyanaz a csomag, de a leíró más (itt: a protokoll): megáll.
  const proto = packTo();
  const pm = JSON.parse(fs.readFileSync(path.join(proto.out, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(proto.out, 'manifest.json'), `${JSON.stringify({ ...pm, helperVersion: '9.9.9' }, null, 2)}\n`);
  assert.throws(() => signer.adopt({ dir: proto.out, from: signedBuild.out, keys: [k.key] }), /más \(verzió/);
  // Egy másik, azonos azonosítójú kulcs a listán: az aláírás nem érvényes.
  assert.throws(() => signer.adopt({ dir: packTo().out, from: signedBuild.out, keys: [keyPair('r1').key] }), /nem érvényes/);
  // Aláíratlan leíró: csak amíg nincs kiadási kulcs; a próba-kulcsos csomag soha.
  const unsignedBuild = packTo();
  const plain = packTo();
  fs.writeFileSync(path.join(plain.out, 'manifest.sig'), 'régi\n');
  assert.deepEqual(signer.adopt({ dir: plain.out, from: unsignedBuild.out, keys: [] }), { signed: false, keyId: UNSIGNED_KEY_ID });
  assert.ok(!fs.existsSync(path.join(plain.out, 'manifest.sig')), 'egy régi aláírás nem maradhat');
  assert.throws(() => signer.adopt({ dir: packTo().out, from: unsignedBuild.out, keys: [k.key] }), /aláírt leírót kér/);
  const t = keyPair(TEST_KEY_ID);
  assert.throws(() => signer.adopt({ dir: packTo({ testPubkey: t.key.spki }).out, from: unsignedBuild.out, keys: [] }), /CI-próba kulcsa/);
});

test('a parancssor: a build kimenete, kulcs nélkül fejlesztői módban; ismeretlen kapcsoló hiba', () => {
  const script = path.join(ROOT, 'scripts', 'sign-helper-manifest.js');
  const r = packTo();
  const env = { ...process.env, HELPER_SIGNING_KEY: '', BREAKER_HELPER_TEST_PUBKEY: '' };
  assert.match(execFileSync(process.execPath, [script, r.out], { env, encoding: 'utf8' }), /aláíratlan/);
  assert.throws(() => execFileSync(process.execPath, [script, '--force', r.out], { env, stdio: 'pipe' }));
  const status = (args: string[]): number | null => {
    try {
      execFileSync(process.execPath, [script, ...args], { env, stdio: 'pipe' });
      return 0;
    } catch (e) {
      return (e as { status: number | null }).status;
    }
  };
  assert.equal(status(['--adopt']), 2, 'hiányzó mappa: használati hiba');
  assert.equal(status(['--adopt', r.out, '--release', r.out]), 2, 'a kettő együtt: használati hiba');
  // Az átvétel a parancssorból: a csomag mellé — kulcs nélkül figyelmeztetéssel,
  // kiadási kulccsal (a listán) aláíratlant nem vesz át.
  const own = packTo();
  if (signer.readReleaseKeys().length === 0) {
    assert.match(execFileSync(process.execPath, [script, '--adopt', r.out, own.out], { env, encoding: 'utf8' }), /::warning::.*aláíratlan/);
  } else {
    assert.equal(status(['--adopt', r.out, own.out]), 1);
  }
  const k = keyPair(TEST_KEY_ID);
  const t = packTo({ testPubkey: k.key.spki });
  const out = execFileSync(process.execPath, [script, t.out], {
    env: { ...env, HELPER_SIGNING_KEY: k.pem, BREAKER_HELPER_TEST_PUBKEY: k.key.spki }, encoding: 'utf8',
  });
  assert.match(out, /aláírva \(kulcs: ci-test\)/);
  assert.ok(!out.includes('PRIVATE KEY'));
});

test('a rögzített Node és a futtatókörnyezet neve: kötött alak, tartalomból számolva', () => {
  for (const arch of ['arm64', 'x64'] as const) {
    const pin = NODE_RUNTIME[arch];
    assert.equal(pin.member, `node-${NODE_RUNTIME.version}-darwin-${arch}/bin/node`);
    assert.match(pin.tarSha256, /^[0-9a-f]{64}$/);
    assert.match(pin.binSha256, /^[0-9a-f]{64}$/);
    assert.ok(pin.tarSize > 20_000_000 && pin.tarSize < 40 * 1024 * 1024, `${arch}: ${pin.tarSize}`);
    const urls = nodeTarUrls(arch);
    assert.equal(urls.length, 2);
    for (const u of urls) {
      assert.ok(u.startsWith('https://'), u);
      assert.ok(u.endsWith(`/${nodeTarName(arch)}`), u);
    }
  }
  assert.notEqual(NODE_RUNTIME.arm64.tarSha256, NODE_RUNTIME.x64.tarSha256);
  assert.equal(NODE_RUNTIME.teamId, 'HX7739G8FX');
  assert.deepEqual(NODE_RUNTIME.minMacos, [13, 5]);
  assert.equal(RUNTIME_ENTRY, `${RUNTIME_ROOT}/current/${PAYLOAD_ENTRY}`);
  const a = runtimeId('a'.repeat(64), 'b'.repeat(64));
  assert.match(a, RUNTIME_ID_RE);
  assert.equal(a, runtimeId('a'.repeat(64), 'b'.repeat(64)), 'ugyanaz a tartalom, ugyanaz a név');
  assert.notEqual(a, runtimeId('a'.repeat(64), 'c'.repeat(64)), 'más Node, más név');
  assert.notEqual(a, runtimeId('c'.repeat(64), 'b'.repeat(64)), 'más csomag, más név');
});
