#!/usr/bin/env node
// A segéd csomagja (payload.tar) a védett futtatókörnyezethez (#151, macOS).
//
// MIT. A rendszerjoggal futó segéd nem az app-csomagból fut, hanem egy root
// által írható mappából; oda ez a csomag kerül: a segéd lefordított
// JavaScriptje (a dist/helper/index.js-ből elérhető fájlok, és semmi más), a
// teljes eltávolító szkript, és egy kis package.json. Mellé egy leíró
// (manifest.json) a csomag és a rögzített Node ujjlenyomatával — ezt írja alá
// a kiadás (scripts/sign-helper-manifest.js).
//
// DETERMINISZTIKUS. Ugyanabból a forrásból bájtra ugyanaz a csomag: rendezett
// sorrend, mtime 0, uid/gid 0, rögzített jogok (fájl 644, mappa és .sh 755).
// Így a csomag ujjlenyomata előre kiszámolható és aláírható, és egy másik
// gépen épített példány összevethető vele.
//
// SZIGORÚ. A rootként futó kód csak a Node beépített moduljait töltheti be:
// egy npm-függőség, vagy a GUI kódja (dist/main) a csomagban hiba. Egyetlen
// kivétel az Electron `original-fs`-e, amit a kód csak Electronban kér
// (process.versions.electron mögött) — a sima Node-on sosem töltődik be.
//
// Kimenet:
//   dist-payload/helper/payload.tar     a csomag
//   dist-payload/helper/manifest.json   a leíró (aláíratlan: keyId 'unsigned')
//   dist/main/helper-payload.json       a GUI-nak: melyik csomagot hozta

const crypto = require('crypto');
const fs = require('fs');
const { builtinModules } = require('module');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/** A csomag belépési pontja, a dist-hez képest. */
const ENTRY = 'helper/index.js';
/** Ezekben a dist-mappákban lehet a segéd kódja; máshol nem (a main a GUI-é). */
const ALLOWED_DIRS = ['helper', 'shared'];
/** Csak Electronban kért modulok — a kód őrzi (process.versions.electron). */
const ELECTRON_ONLY = new Set(['original-fs']);
/** Az aláíratlan leíró keyId-ja; a kiadási kulcsok között nem lehet ilyen. */
const UNSIGNED_KEY_ID = 'unsigned';
/** A CI-próba ideiglenes kulcsának azonosítója (csak a test-keys.json-ban). */
const TEST_KEY_ID = 'ci-test';
const SAFE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/?$/;

class PackError extends Error {}

function isBuiltin(spec) {
  const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
  return builtinModules.includes(bare) || builtinModules.includes(spec);
}

/**
 * A require-ok kiolvasása a lefordított kódból. Megjegyzésben is megtalálja —
 * az is hiba, ha nem beépített modult nevez meg: inkább egy hamis riasztás,
 * mint egy át nem nézett függőség. A nem szöveges require (változóval) mindig
 * hiba: azt nem lehet előre bejárni.
 */
function requiresOf(source, file) {
  const out = [];
  const re = /\brequire\s*\(/g;
  let m;
  while ((m = re.exec(source))) {
    const rest = source.slice(re.lastIndex);
    const lit = /^\s*(['"])([^'"\\\n]+)\1\s*\)/.exec(rest);
    if (!lit) throw new PackError(`${file}: nem szöveges require — nem járható be előre`);
    out.push(lit[2]);
  }
  return out;
}

function resolveRelative(distDir, fromRel, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  for (const cand of [base, `${base}.js`, `${base}.json`, `${base}/index.js`]) {
    const abs = path.join(distDir, ...cand.split('/'));
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) throw new PackError(`${cand}: szimbolikus link a csomagban`);
    if (st.isFile()) return cand;
  }
  throw new PackError(`${fromRel}: nem található: ${spec}`);
}

/** A belépési pontból elérhető fájlok (a dist-hez képest, rendezve). */
function collectClosure(distDir, entry = ENTRY) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    if (rel.startsWith('../') || path.posix.isAbsolute(rel) || !ALLOWED_DIRS.includes(rel.split('/')[0])) {
      throw new PackError(`${rel}: a segéd csak a ${ALLOWED_DIRS.join(', ')} mappából tölthet be kódot`);
    }
    seen.add(rel);
    if (!rel.endsWith('.js')) continue;
    const abs = path.join(distDir, ...rel.split('/'));
    const st = fs.lstatSync(abs);
    if (!st.isFile()) throw new PackError(`${rel}: nem sima fájl`);
    const src = fs.readFileSync(abs, 'utf8');
    for (const spec of requiresOf(src, rel)) {
      if (spec.startsWith('./') || spec.startsWith('../')) {
        queue.push(resolveRelative(distDir, rel, spec));
      } else if (ELECTRON_ONLY.has(spec)) {
        if (!src.includes('process.versions.electron')) {
          throw new PackError(`${rel}: a(z) ${spec} csak Electronban van, a kód nem őrzi`);
        }
      } else if (!isBuiltin(spec)) {
        throw new PackError(`${rel}: nem beépített modul: ${spec} — rootként csak a Node saját moduljai futhatnak`);
      }
    }
  }
  return [...seen].sort();
}

// --- ustar --------------------------------------------------------------

function octal(n, width) {
  const s = n.toString(8);
  if (s.length > width - 1) throw new PackError(`túl nagy szám a tar-fejlécben: ${n}`);
  return `${'0'.repeat(width - 1 - s.length)}${s}\0`;
}

function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', name };
  // A hosszabb utat egy / mentén kettévágjuk: előtag (≤155) és név (≤100).
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/' || i === name.length - 1) continue;
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { prefix, name: rest };
  }
  throw new PackError(`túl hosszú út a tarban: ${name}`);
}

function header(name, { mode, size, type }) {
  const h = Buffer.alloc(512, 0);
  const parts = splitName(name);
  h.write(parts.name, 0, 100, 'ascii');
  h.write(octal(mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write(octal(0, 8), 329, 'ascii');
  h.write(octal(0, 8), 337, 'ascii');
  h.write(parts.prefix, 345, 155, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${octal(sum, 7)} `, 148, 'ascii');
  return h;
}

/**
 * Determinisztikus ustar: a bejegyzések út szerint rendezve, a mappák is
 * (a szülők mind), mtime 0, uid/gid 0, üres tulajdonos-név. Csak sima fájl és
 * mappa — link, eszköz, különleges jog nincs benne.
 */
function makeTar(entries) {
  const files = new Map();
  for (const e of entries) {
    if (!SAFE_PATH.test(e.path) || e.path.endsWith('/')) throw new PackError(`rossz út: ${e.path}`);
    if (e.path.split('/').some((p) => p === '.' || p === '..')) throw new PackError(`rossz út: ${e.path}`);
    if (files.has(e.path)) throw new PackError(`kétszer: ${e.path}`);
    files.set(e.path, e);
  }
  const dirs = new Set();
  for (const p of files.keys()) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(`${segs.slice(0, i).join('/')}/`);
  }
  for (const d of dirs) if (files.has(d.slice(0, -1))) throw new PackError(`fájl és mappa is: ${d}`);
  const names = [...dirs, ...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const chunks = [];
  for (const n of names) {
    if (n.endsWith('/')) {
      chunks.push(header(n, { mode: 0o755, size: 0, type: '5' }));
      continue;
    }
    const e = files.get(n);
    const data = e.data;
    chunks.push(header(n, { mode: e.mode, size: data.length, type: '0' }));
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  let tar = Buffer.concat(chunks);
  // A szokásos 10240 bájtos rekordhatárra kerekítve (a bsdtar és a GNU tar is így ír).
  const rec = (10240 - (tar.length % 10240)) % 10240;
  if (rec) tar = Buffer.concat([tar, Buffer.alloc(rec, 0)]);
  return tar;
}

// --- a csomag -----------------------------------------------------------

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * A csomag bejegyzései: a kód, az eltávolító, a package.json, és ha a CI
 * próbája kéri, a próba nyilvános kulcsa (test-keys.json). A kiadás ez utóbbit
 * nem engedi (sign-helper-manifest.js --release).
 */
function payloadEntries({ distDir, appVersion, testPubkey }) {
  const entries = [];
  for (const rel of collectClosure(distDir)) {
    entries.push({ path: `app/dist/${rel}`, mode: 0o644, data: fs.readFileSync(path.join(distDir, ...rel.split('/'))) });
  }
  const uninstall = path.join(distDir, 'uninstall', 'uninstall-macos.sh');
  if (!fs.lstatSync(uninstall).isFile()) throw new PackError('az eltávolító nem sima fájl');
  entries.push({ path: 'app/dist/uninstall/uninstall-macos.sh', mode: 0o755, data: fs.readFileSync(uninstall) });
  const pkg = { name: 'breaker-helper', private: true, type: 'commonjs', version: appVersion };
  entries.push({ path: 'app/package.json', mode: 0o644, data: Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`) });
  if (testPubkey) {
    const keys = [{ id: TEST_KEY_ID, spki: testPubkey }];
    entries.push({ path: 'app/test-keys.json', mode: 0o644, data: Buffer.from(`${JSON.stringify(keys, null, 2)}\n`) });
  }
  return entries;
}

function readTarNames(tar) {
  const names = [];
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (s, l) => h.subarray(s, s + l).toString('ascii').replace(/\0.*$/s, '');
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 12), 8);
    names.push({ name, type: field(156, 1), mode: parseInt(field(100, 8), 8), size });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

function pack({ root = ROOT, out, infoPath, appVersion, testPubkey } = {}) {
  const distDir = path.join(root, 'dist');
  const outDir = out || path.join(root, 'dist-payload', 'helper');
  const infoFile = infoPath || path.join(distDir, 'main', 'helper-payload.json');
  const version = appVersion || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (!/^\d{1,4}\.\d{1,5}\.\d{1,6}$/.test(version)) throw new PackError(`az app verziója nem x.y.z: ${version}`);
  if (testPubkey !== undefined && !/^[A-Za-z0-9+/]+={0,2}$/.test(testPubkey)) {
    throw new PackError('a BREAKER_HELPER_TEST_PUBKEY nem base64');
  }
  const { HELPER_VERSION } = require(path.join(distDir, 'shared', 'protocol.js'));
  const { NODE_RUNTIME } = require(path.join(distDir, 'shared', 'helper-runtime.js'));
  const { parseManifest, MANIFEST_FORMAT, MANIFEST_PRODUCT, PAYLOAD_MAX_BYTES } = require(path.join(distDir, 'shared', 'helper-manifest.js'));

  const tar = makeTar(payloadEntries({ distDir, appVersion: version, testPubkey }));
  if (tar.length > PAYLOAD_MAX_BYTES) throw new PackError(`a csomag túl nagy: ${tar.length} bájt`);
  const digest = sha256(tar);
  const manifest = {
    format: MANIFEST_FORMAT,
    product: MANIFEST_PRODUCT,
    appVersion: version,
    helperVersion: HELPER_VERSION,
    keyId: UNSIGNED_KEY_ID,
    payload: { sha256: digest, size: tar.length },
    node: { version: NODE_RUNTIME.version, arm64: NODE_RUNTIME.arm64, x64: NODE_RUNTIME.x64 },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  parseManifest(manifestBytes); // ugyanazzal a szigorral, amivel a segéd olvassa

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'payload.tar'), tar);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), manifestBytes);
  const info = { sha256: digest, size: tar.length, appVersion: version, helperVersion: HELPER_VERSION };
  fs.mkdirSync(path.dirname(infoFile), { recursive: true });
  fs.writeFileSync(infoFile, `${JSON.stringify(info, null, 2)}\n`);
  return { tar, manifest, info, outDir };
}

module.exports = {
  ENTRY, PackError, TEST_KEY_ID, UNSIGNED_KEY_ID,
  collectClosure, makeTar, pack, payloadEntries, readTarNames, requiresOf, sha256,
};

if (require.main === module) {
  try {
    const r = pack({ testPubkey: process.env.BREAKER_HELPER_TEST_PUBKEY || undefined });
    const files = readTarNames(r.tar).filter((e) => e.type === '0').length;
    console.log(`helper payload: ${files} fájl, ${r.tar.length} bájt, sha256 ${r.info.sha256} → ${path.relative(ROOT, r.outDir)}`);
    if (process.env.BREAKER_HELPER_TEST_PUBKEY) console.log('FIGYELEM: a csomagban a CI-próba kulcsa is benne van (test-keys.json) — kiadásra nem alkalmas');
  } catch (e) {
    console.error(`pack-helper-payload: ${e instanceof PackError ? e.message : e.stack}`);
    process.exit(1);
  }
}
