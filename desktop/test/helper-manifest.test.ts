// A segéd csomagjának aláírt leírója (shared/helper-manifest.ts, #151): a
// szigorú olvasás, az Ed25519-ellenőrzés a leíró pontos bájtjain, és a
// verzió-összevetés. A kulcslista (shared/helper-keys.ts) amíg üres, semmit
// nem enged át.

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { RELEASE_KEYS } from '../src/shared/helper-keys';
import {
  isNewer, MANIFEST_MAX_BYTES, ManifestError, parseManifest, verifyManifest, type HelperManifest, type ReleaseKey,
} from '../src/shared/helper-manifest';

const SHA = (c: string) => c.repeat(64);

function sample(over: Partial<HelperManifest> = {}): HelperManifest {
  return {
    format: 1,
    product: 'hu.breaker.helper',
    appVersion: '0.4.260',
    helperVersion: '0.7.0',
    keyId: 'r1',
    payload: { sha256: SHA('a'), size: 1_000_000 },
    node: {
      version: 'v24.11.1',
      arm64: { tarSha256: SHA('b'), tarSize: 28_000_000, member: 'node-v24.11.1-darwin-arm64/bin/node', binSha256: SHA('c') },
      x64: { tarSha256: SHA('d'), tarSize: 29_000_000, member: 'node-v24.11.1-darwin-x64/bin/node', binSha256: SHA('e') },
    },
    ...over,
  };
}

function keyPair(id = 'r1'): { key: ReleaseKey; sign: (b: Buffer) => string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    key: { id, spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
    sign: (b) => crypto.sign(null, b, privateKey).toString('base64'),
  };
}

const bytesOf = (m: unknown) => Buffer.from(JSON.stringify(m, null, 2));

test('a kiadási kulcsok listája: amíg üres, semmit nem enged át', () => {
  const k = keyPair();
  const b = bytesOf(sample());
  assert.ok(Array.isArray(RELEASE_KEYS));
  if (RELEASE_KEYS.length === 0) assert.throws(() => verifyManifest(b, k.sign(b), RELEASE_KEYS), ManifestError);
  for (const key of RELEASE_KEYS) {
    assert.match(key.id, /^[a-z0-9][a-z0-9-]{0,31}$/);
    const pub = crypto.createPublicKey({ key: Buffer.from(key.spki, 'base64'), format: 'der', type: 'spki' });
    assert.equal(pub.asymmetricKeyType, 'ed25519', key.id);
  }
  assert.equal(new Set(RELEASE_KEYS.map((k2) => k2.id)).size, RELEASE_KEYS.length, 'két kulcsnak ugyanaz az azonosítója');
});

test('az aláírt leíró átmegy; egy bájt eltérés, más kulcs, ismeretlen kulcs-azonosító nem', () => {
  const k = keyPair();
  const b = bytesOf(sample());
  const sig = k.sign(b);
  assert.deepEqual(verifyManifest(b, sig, [k.key]), sample());
  assert.deepEqual(verifyManifest(b, `${sig}\n`, [k.key]), sample(), 'a záró sorvég nem számít');
  // Egy bájt a leíróban (egy szóköz is): az aláírás a pontos bájtokra szól.
  const flipped = Buffer.from(b);
  flipped[flipped.length - 2] = 0x20;
  assert.throws(() => verifyManifest(flipped, sig, [k.key]), /aláírás nem érvényes|nem JSON/);
  const spaced = Buffer.concat([b, Buffer.from(' ')]);
  assert.throws(() => verifyManifest(spaced, sig, [k.key]), /aláírás nem érvényes/);
  // Más kulcs ugyanazzal az azonosítóval.
  const other = keyPair();
  assert.throws(() => verifyManifest(b, sig, [other.key]), /aláírás nem érvényes/);
  assert.throws(() => verifyManifest(b, other.sign(b), [k.key]), /aláírás nem érvényes/);
  // A leíró egy olyan kulcsot nevez meg, ami nincs a listában.
  const b2 = bytesOf(sample({ keyId: 'r2' }));
  assert.throws(() => verifyManifest(b2, k.sign(b2), [k.key]), /ismeretlen kiadási kulcs: r2/);
  assert.throws(() => verifyManifest(b, sig, []), /ismeretlen kiadási kulcs/);
  // Nem Ed25519 kulcs a listában: elutasít.
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.throws(() => verifyManifest(b, sig, [{ id: 'r1', spki: rsa }]), /nem Ed25519/);
  assert.throws(() => verifyManifest(b, sig, [{ id: 'r1', spki: 'bm9wZQ==' }]), /nem olvasható/);
});

test('az aláírás alakja kötött: rossz hossz, rossz betű, túl hosszú szöveg — elutasítva', () => {
  const k = keyPair();
  const b = bytesOf(sample());
  const sig = k.sign(b);
  for (const bad of ['', sig.slice(0, -4), `${sig}AAAA`, sig.replace(/[A-Za-z]/, '*'), 'x'.repeat(5000)]) {
    assert.throws(() => verifyManifest(b, bad, [k.key]), /aláírás alakja/, JSON.stringify(bad.slice(0, 20)));
  }
});

test('a leíró olvasása szigorú: ismeretlen vagy hiányzó mező, rossz alak, túl nagy szám', () => {
  const ok = sample();
  assert.deepEqual(parseManifest(bytesOf(ok)), ok);
  const bad: Array<[string, unknown]> = [
    ['extra mező', { ...ok, extra: 1 }],
    ['hiányzó mező', (() => { const c: Record<string, unknown> = { ...ok }; delete c.keyId; return c; })()],
    ['__proto__', JSON.parse(JSON.stringify(ok).replace('{', '{"__proto__":{"x":1},'))],
    ['formátum', { ...ok, format: 2 }],
    ['termék', { ...ok, product: 'hu.breaker.app' }],
    ['appVersion', { ...ok, appVersion: '0.4' }],
    ['appVersion szöveg', { ...ok, appVersion: '0.4.260-beta' }],
    ['helperVersion', { ...ok, helperVersion: 7 }],
    ['keyId', { ...ok, keyId: 'R1' }],
    ['payload sha', { ...ok, payload: { sha256: SHA('A'), size: 1 } }],
    ['payload méret 0', { ...ok, payload: { sha256: SHA('a'), size: 0 } }],
    ['payload túl nagy', { ...ok, payload: { sha256: SHA('a'), size: 9 * 1024 * 1024 } }],
    ['payload tört', { ...ok, payload: { sha256: SHA('a'), size: 1.5 } }],
    ['payload extra', { ...ok, payload: { sha256: SHA('a'), size: 1, url: 'x' } }],
    ['node verzió', { ...ok, node: { ...ok.node, version: '24.11.1' } }],
    ['node tag', { ...ok, node: { ...ok.node, arm64: { ...ok.node.arm64, member: '../../bin/sh' } } }],
    ['node tag más verzió', { ...ok, node: { ...ok.node, x64: { ...ok.node.x64, member: 'node-v24.0.0-darwin-x64/bin/node' } } }],
    ['node tag más arch', { ...ok, node: { ...ok.node, arm64: { ...ok.node.arm64, member: 'node-v24.11.1-darwin-x64/bin/node' } } }],
    ['node tar túl nagy', { ...ok, node: { ...ok.node, x64: { ...ok.node.x64, tarSize: 41 * 1024 * 1024 } } }],
    ['node hiányzó arch', { ...ok, node: { version: ok.node.version, arm64: ok.node.arm64 } }],
    ['tömb', [ok]],
    ['null', null],
  ];
  for (const [label, v] of bad) {
    assert.throws(() => parseManifest(bytesOf(v)), ManifestError, label);
  }
  assert.throws(() => parseManifest(Buffer.from('{')), /nem JSON/);
  assert.throws(() => parseManifest(Buffer.alloc(0)), /mérete/);
  assert.throws(() => parseManifest(Buffer.alloc(MANIFEST_MAX_BYTES + 1, 0x20)), /mérete/);
});

test('verzió-összevetés: számként, tagonként; rossz alakra nem újabb', () => {
  assert.equal(isNewer('0.4.260', '0.4.259'), true);
  assert.equal(isNewer('0.4.259', '0.4.260'), false);
  assert.equal(isNewer('0.4.259', '0.4.259'), false, 'az egyenlő nem újabb');
  assert.equal(isNewer('0.10.0', '0.9.99'), true, 'nem szövegként');
  assert.equal(isNewer('1.0.0', '0.99.999'), true);
  assert.equal(isNewer('0.4.1000', '0.4.999'), true);
  assert.equal(isNewer('0.4', '0.3.0'), false);
  assert.equal(isNewer('0.4.260-x', '0.4.259'), false);
  assert.equal(isNewer('0.4.260', 'x'), false);
});

test('a kulcsgeneráló szkript: titkos fél csak a tulajdonosnak, meglévőt nem ír felül, a nyilvános fél ellenőriz', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkey-'));
  const file = path.join(dir, 'key.pem');
  const script = path.join(__dirname, '..', '..', 'scripts', 'gen-helper-key.js');
  const out = execFileSync(process.execPath, [script, file, 'r7'], { encoding: 'utf8' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const m = out.match(/\{ id: 'r7', spki: '([A-Za-z0-9+/=]+)' \}/);
  assert.ok(m, out);
  const priv = crypto.createPrivateKey(fs.readFileSync(file));
  const b = bytesOf(sample({ keyId: 'r7' }));
  const sig = crypto.sign(null, b, priv).toString('base64');
  assert.equal(verifyManifest(b, sig, [{ id: 'r7', spki: m[1] }]).keyId, 'r7');
  // Másodszor ugyanoda: nem írja felül.
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => execFileSync(process.execPath, [script, file], { stdio: 'pipe' }));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => execFileSync(process.execPath, [script, path.join(dir, 'x.pem'), 'Rossz'], { stdio: 'pipe' }));
});
