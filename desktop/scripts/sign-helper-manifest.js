#!/usr/bin/env node
// A segéd csomagjának leíróját aláírja a kiadási kulccsal (#151, macOS).
//
// Használat:
//   node scripts/sign-helper-manifest.js [--release] [mappa]
//
// A kulcs a HELPER_SIGNING_KEY környezeti változóban jön (PKCS#8 PEM, a
// scripts/gen-helper-key.js írta). A leíró keyId-ját az dönti el, melyik
// kulccsal írunk alá: a nyilvános felét a telepített segédek kulcslistájában
// (shared/helper-keys.ts) keressük — amit egy segéd sem tudna ellenőrizni,
// azt nem írjuk alá.
//
// Kulcs nélkül (fejlesztői build) a leíró aláíratlan marad: az app így is
// működik, a segéd csak jelszóval frissül.
//
// --release: a kiadás módja.
//   - A csomagban nem lehet a CI-próba kulcsa (test-keys.json).
//   - Ha a kulcslista nem üres, a kulcs kötelező, és a listán kell lennie.
//   - Amíg a lista üres, figyelmeztet, és aláíratlan csomagot enged.
//
// --adopt <mappa>: a kiadás macOS-csomagolója. A leírót egy külön job írja
//   alá (release.yml: helper-sign — csak ott van a kulcs); a csomagoló a
//   SAJÁT buildje mellé veszi át, és csak ha a két build bájtra ugyanazt a
//   csomagot adta (a csomag determinisztikus). Az aláírást a kiadási
//   kulcslistával ellenőrzi, ahogy egy telepített segéd tenné.
//
// A titkos kulcs sosem kerül a kimenetre; a hibaüzenet sem idézi.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readTarNames, sha256, TEST_KEY_ID, UNSIGNED_KEY_ID } = require('./pack-helper-payload');

const ROOT = path.join(__dirname, '..');

class SignError extends Error {}

function sign({ dir, release = false, pem, testPubkey, keys } = {}) {
  const dist = path.join(ROOT, 'dist', 'shared');
  const { parseManifest, verifyManifest } = require(path.join(dist, 'helper-manifest.js'));
  const releaseKeys = keys || require(path.join(dist, 'helper-keys.js')).RELEASE_KEYS;
  const manifestPath = path.join(dir, 'manifest.json');
  const sigPath = path.join(dir, 'manifest.sig');
  const tar = fs.readFileSync(path.join(dir, 'payload.tar'));
  const manifest = parseManifest(fs.readFileSync(manifestPath));

  // A leíró ehhez a csomaghoz tartozik-e (egy elavult leírót ne írjunk alá).
  if (manifest.payload.sha256 !== sha256(tar) || manifest.payload.size !== tar.length) {
    throw new SignError('a leíró nem ehhez a payload.tar-hoz tartozik — futtasd újra a buildet');
  }
  const hasTestKeys = readTarNames(tar).some((e) => e.name === 'app/test-keys.json');
  if (release && hasTestKeys) throw new SignError('a kiadás csomagjában nem lehet a CI-próba kulcsa (test-keys.json)');

  // Egy korábbi aláírás nem maradhat egy új leíró mellett.
  fs.rmSync(sigPath, { force: true });

  if (!pem) {
    if (release && releaseKeys.length > 0) {
      throw new SignError('a kiadás aláírt csomagot kér, de a HELPER_SIGNING_KEY üres');
    }
    return { signed: false, why: release ? 'no-keys' : 'dev' };
  }

  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(pem);
  } catch {
    throw new SignError('a HELPER_SIGNING_KEY nem olvasható titkos kulcs');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new SignError('a HELPER_SIGNING_KEY nem Ed25519 kulcs');
  const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');

  const trust = [...releaseKeys];
  if (!release && testPubkey) trust.push({ id: TEST_KEY_ID, spki: testPubkey });
  const key = trust.find((k) => k.spki === spki);
  if (!key) {
    throw new SignError(release
      ? 'a kulcs nincs a kiadási kulcsok listáján (shared/helper-keys.ts) — az aláírását egy telepített segéd sem fogadná el'
      : 'a kulcs nincs se a kiadási kulcsok listáján, se a CI-próba kulcsaként megadva');
  }
  if (key.id === TEST_KEY_ID && !hasTestKeys) {
    throw new SignError('a CI-próba kulcsával írnánk alá, de a csomagban nincs test-keys.json');
  }

  const signedManifest = { ...manifest, keyId: key.id };
  const bytes = Buffer.from(`${JSON.stringify(signedManifest, null, 2)}\n`);
  const sig = crypto.sign(null, bytes, privateKey).toString('base64');
  // Ugyanazzal az ellenőrzéssel, amivel a segéd fogadja.
  verifyManifest(bytes, sig, trust);
  fs.writeFileSync(manifestPath, bytes);
  fs.writeFileSync(sigPath, `${sig}\n`);
  return { signed: true, keyId: key.id };
}

/**
 * Egy másik jobban aláírt leíró átvétele a helyben épített csomag mellé
 * (lásd a fejet: --adopt). Csak ha ugyanaz a csomag és ugyanaz a leíró —
 * egy eltérés azt jelenti, hogy a két build más forrásból vagy más
 * eszközökkel készült, és akkor a kiadás megáll: utólag semmit nem írunk alá.
 */
function adopt({ dir, from, keys } = {}) {
  const dist = path.join(ROOT, 'dist', 'shared');
  const { parseManifest, verifyManifest } = require(path.join(dist, 'helper-manifest.js'));
  const releaseKeys = keys || require(path.join(dist, 'helper-keys.js')).RELEASE_KEYS;
  const tar = fs.readFileSync(path.join(dir, 'payload.tar'));
  if (readTarNames(tar).some((e) => e.name === 'app/test-keys.json')) {
    throw new SignError('a kiadás csomagjában nem lehet a CI-próba kulcsa (test-keys.json)');
  }
  const local = parseManifest(fs.readFileSync(path.join(dir, 'manifest.json')));
  const bytes = fs.readFileSync(path.join(from, 'manifest.json'));
  const fromSig = path.join(from, 'manifest.sig');
  const signed = fs.existsSync(fromSig);
  let manifest;
  if (signed) {
    manifest = verifyManifest(bytes, fs.readFileSync(fromSig, 'utf8'), releaseKeys);
  } else {
    if (releaseKeys.length > 0) throw new SignError('a kiadás aláírt leírót kér, de az átvett leíró aláíratlan');
    manifest = parseManifest(bytes);
    if (manifest.keyId !== UNSIGNED_KEY_ID) throw new SignError('az átvett leíró kulcsot nevez meg, de aláírás nincs mellette');
  }
  if (manifest.payload.sha256 !== sha256(tar) || manifest.payload.size !== tar.length) {
    throw new SignError('az aláírt csomag és az itt épített eltér — a két build nem ugyanabból készült');
  }
  if (JSON.stringify({ ...manifest, keyId: UNSIGNED_KEY_ID }) !== JSON.stringify({ ...local, keyId: UNSIGNED_KEY_ID })) {
    throw new SignError('az átvett leíró más (verzió, Node, protokoll), mint az itt épített');
  }
  const sigPath = path.join(dir, 'manifest.sig');
  fs.rmSync(sigPath, { force: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), bytes);
  if (signed) fs.copyFileSync(fromSig, sigPath);
  return { signed, keyId: manifest.keyId };
}

module.exports = { SignError, adopt, sign, UNSIGNED_KEY_ID };

if (require.main === module) {
  const args = process.argv.slice(2);
  const release = args.includes('--release');
  const adoptAt = args.indexOf('--adopt');
  const from = adoptAt >= 0 ? args[adoptAt + 1] : undefined;
  const rest = args.filter((_, i) => adoptAt < 0 || (i !== adoptAt && i !== adoptAt + 1));
  const unknown = rest.filter((a) => a.startsWith('-') && a !== '--release');
  if (unknown.length || (adoptAt >= 0 && (!from || from.startsWith('-') || release))) {
    console.error(unknown.length ? `ismeretlen kapcsoló: ${unknown.join(' ')}` : 'használat: --adopt <az aláírt leíró mappája> [mappa]');
    process.exit(2);
  }
  const dir = rest.find((a) => !a.startsWith('-')) || path.join(ROOT, 'dist-payload', 'helper');
  try {
    if (from) {
      const r = adopt({ dir, from });
      if (r.signed) {
        console.log(`a segéd aláírt leírója átvéve (kulcs: ${r.keyId}); a csomag bájtra egyezik`);
      } else {
        console.log('::warning::A segéd csomagja aláíratlan: még nincs kiadási kulcs (shared/helper-keys.ts). A telepített segédek csak jelszóval frissülnek.');
      }
    } else {
      const r = sign({
        dir,
        release,
        pem: (process.env.HELPER_SIGNING_KEY || '').trim() || undefined,
        testPubkey: process.env.BREAKER_HELPER_TEST_PUBKEY || undefined,
      });
      if (r.signed) {
        console.log(`a segéd leírója aláírva (kulcs: ${r.keyId})`);
      } else if (r.why === 'no-keys') {
        // A GitHub Actions ezt a sort figyelmeztetésként mutatja a futás lapján.
        console.log('::warning::A segéd csomagja aláíratlan: még nincs kiadási kulcs (shared/helper-keys.ts). A telepített segédek csak jelszóval frissülnek.');
      } else {
        console.log('a segéd leírója aláíratlan (nincs HELPER_SIGNING_KEY) — fejlesztői build');
      }
    }
  } catch (e) {
    const msg = e instanceof SignError || (e && e.constructor && e.constructor.name === 'ManifestError') ? e.message : String(e && e.stack);
    console.error(`sign-helper-manifest: ${msg}`);
    process.exit(1);
  }
}
