// A segéd csomagjának aláírt leírója (#151, macOS).
//
// MIÉRT. A rendszerjoggal futó segéd egy védett, csak a root által írható
// futtatókörnyezetből fut (nem az app-csomagból, amit az app tulajdonosa
// írhat). Új kódot onnan csak egy olyan csomagból vehet át, amit a projekt
// kiadási kulcsa aláírt, és ami újabb, mint ami fut — így egy frissítéshez nem
// kell jelszó, de egy fájlművelet az app mappájában sem ad rendszerjogot.
//
// A leíró kicsi, kötött alakú JSON: a csomag (a segéd JavaScriptje) és a Node
// futtató ujjlenyomata. Az aláírás a leíró PONTOS bájtjaira szól (Ed25519); a
// csomagot és a Node-ot a leíró ujjlenyomatai kötik hozzá. Itt csak a tiszta
// rész van: olvasás, ellenőrzés, összevetés — fájlt nem nyit, hálózatot nem ér.

import * as crypto from 'crypto';
import { isNewer, VERSION_RE } from './version';

export const MANIFEST_FORMAT = 1;
export const MANIFEST_PRODUCT = 'hu.breaker.helper';
/** Felső korlátok: a leíró, az aláírás és a csomag mérete (bájt). */
export const MANIFEST_MAX_BYTES = 64 * 1024;
export const SIGNATURE_MAX_BYTES = 1024;
export const PAYLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const NODE_TAR_MAX_BYTES = 40 * 1024 * 1024;
/**
 * Az aláíratlan leíró keyId-ja (a fejlesztői build és a még kulcs nélküli
 * kiadás így írja). Kiadási kulcs nem kaphatja ezt a nevet, és a CI-próba
 * ideiglenes kulcsának nevét sem — így egy aláíratlan vagy próba-leíró sosem
 * illik egy valódi kulcsra.
 */
export const UNSIGNED_KEY_ID = 'unsigned';
export const TEST_KEY_ID = 'ci-test';

/** Egy architektúra rögzített Node-ja: a hivatalos tarball és benne a bináris. */
export interface NodePin {
  /** a letöltött .tar.xz SHA-256-ja */
  tarSha256: string;
  tarSize: number;
  /** a bináris útja a tarballon belül */
  member: string;
  /** a kicsomagolt bináris SHA-256-ja */
  binSha256: string;
}

export interface HelperManifest {
  format: 1;
  product: 'hu.breaker.helper';
  /** az app verziója, amivel a csomag készült — csak újabbra frissül a segéd */
  appVersion: string;
  /** a segéd protokollja (HELPER_VERSION) */
  helperVersion: string;
  /** melyik kiadási kulcs írta alá */
  keyId: string;
  payload: { sha256: string; size: number };
  node: { version: string; arm64: NodePin; x64: NodePin };
}

/** Egy kiadási kulcs nyilvános fele: SPKI DER, base64-ben. */
export interface ReleaseKey {
  id: string;
  spki: string;
}

const SHA_RE = /^[0-9a-f]{64}$/;
const KEY_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NODE_VERSION_RE = /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const SIG_RE = /^[A-Za-z0-9+/]{86}==$/;

export class ManifestError extends Error {}

function fail(why: string): never {
  throw new ManifestError(why);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && Object.getPrototypeOf(v) === Object.prototype;
}

/** Pontosan ezek a kulcsok, se több, se kevesebb. */
function exactKeys(v: unknown, keys: string[], where: string): Record<string, unknown> {
  if (!isPlainObject(v)) fail(`${where}: nem objektum`);
  const got = Object.keys(v).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) {
    fail(`${where}: a kulcsok nem egyeznek (${got.join(',')})`);
  }
  return v;
}

function str(v: unknown, re: RegExp, where: string): string {
  if (typeof v !== 'string' || !re.test(v)) fail(`${where}: rossz alak`);
  return v;
}

function int(v: unknown, max: number, where: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0 || v > max) fail(`${where}: rossz szám`);
  return v;
}

function nodePin(v: unknown, arch: 'arm64' | 'x64', version: string, where: string): NodePin {
  const o = exactKeys(v, ['tarSha256', 'tarSize', 'member', 'binSha256'], where);
  const member = `node-${version}-darwin-${arch}/bin/node`;
  if (o.member !== member) fail(`${where}.member: nem ${member}`);
  return {
    tarSha256: str(o.tarSha256, SHA_RE, `${where}.tarSha256`),
    tarSize: int(o.tarSize, NODE_TAR_MAX_BYTES, `${where}.tarSize`),
    member,
    binSha256: str(o.binSha256, SHA_RE, `${where}.binSha256`),
  };
}

/**
 * A leíró szigorú olvasása: kötött kulcsok, kötött alakok, felső korlátok. Egy
 * ismeretlen mező is hiba — egy későbbi formátumot a régi segéd ne értsen félre.
 */
export function parseManifest(bytes: Buffer): HelperManifest {
  if (bytes.length === 0 || bytes.length > MANIFEST_MAX_BYTES) fail('a leíró mérete nem jó');
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('a leíró nem JSON');
  }
  const o = exactKeys(raw, ['format', 'product', 'appVersion', 'helperVersion', 'keyId', 'payload', 'node'], 'leíró');
  if (o.format !== MANIFEST_FORMAT) fail('ismeretlen formátum');
  if (o.product !== MANIFEST_PRODUCT) fail('nem a segéd csomagja');
  const payload = exactKeys(o.payload, ['sha256', 'size'], 'payload');
  const node = exactKeys(o.node, ['version', 'arm64', 'x64'], 'node');
  const version = str(node.version, NODE_VERSION_RE, 'node.version');
  return {
    format: MANIFEST_FORMAT,
    product: MANIFEST_PRODUCT,
    appVersion: str(o.appVersion, VERSION_RE, 'appVersion'),
    helperVersion: str(o.helperVersion, VERSION_RE, 'helperVersion'),
    keyId: str(o.keyId, KEY_ID_RE, 'keyId'),
    payload: {
      sha256: str(payload.sha256, SHA_RE, 'payload.sha256'),
      size: int(payload.size, PAYLOAD_MAX_BYTES, 'payload.size'),
    },
    node: {
      version,
      arm64: nodePin(node.arm64, 'arm64', version, 'node.arm64'),
      x64: nodePin(node.x64, 'x64', version, 'node.x64'),
    },
  };
}

/**
 * Az aláírás ellenőrzése a leíró pontos bájtjain, a megadott kulcsok közül a
 * leíróban megnevezettel. Csak sikeres ellenőrzés után ad vissza leírót; ha a
 * kulcs ismeretlen (vagy nincs egy sem), elutasít — kulcs nélkül nincs csendes
 * frissítés.
 */
export function verifyManifest(bytes: Buffer, sigB64: string, keys: readonly ReleaseKey[]): HelperManifest {
  const manifest = parseManifest(bytes);
  const sig = sigB64.trim();
  if (sig.length > SIGNATURE_MAX_BYTES || !SIG_RE.test(sig)) fail('az aláírás alakja nem jó');
  const key = keys.find((k) => k.id === manifest.keyId);
  if (!key) fail(`ismeretlen kiadási kulcs: ${manifest.keyId}`);
  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey({ key: Buffer.from(key.spki, 'base64'), format: 'der', type: 'spki' });
  } catch {
    fail('a kiadási kulcs nem olvasható');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('a kiadási kulcs nem Ed25519');
  if (!crypto.verify(null, bytes, publicKey, Buffer.from(sig, 'base64'))) fail('az aláírás nem érvényes');
  return manifest;
}

export { isNewer };
