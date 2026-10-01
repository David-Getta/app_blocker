// Megfelelőségi fixtúra a SZINKRON TITKOSÍTÁSÁRA: a gép burkol és titkosít, a
// telefon nyit.
//
// A szinkron ígérete, hogy a kiszolgáló nem lát bele — ehhez az adatkulcsot a
// jelszóból származó kulcs burkolja, és a burkolatnak UGYANÚGY kell kinyílnia
// a gépen, az Androidon és az iPhone-on. Ha a három mag bármiben elcsúszik
// (NFKC, scrypt, HKDF-címke, a blob négy része, base64url), a hiba ott derül
// ki, ahol a legrosszabb: a felhasználó telefonján, belépéskor — a gép fiókja
// a telefonon „rossz jelszó”, és semmi nem mondja meg, miért.
//
// Eddig az Android egy kézzel bemásolt fiókon mérte magát (SyncCryptoTest),
// az iPhone titkosítása pedig sosem futott teszten. Ez a fájl a gép valódi
// kódjával ír: scrypt-vektorokat, hat fiók kulcsait és burkolatait (a jelszó
// buktatóival: ékezet két alakban, emodzsi, teljes szélességű betű és
// kompatibilitási jel, szóköz a szélen, vegyes írás), a helyreállító kód
// tiszta alakját, a jelszó hosszát, blobokat, és amit NEM szabad kinyitni.
//
// A termék `encrypt`-je minden hívásra friss véletlen IV-t húz, és annak így
// kell maradnia (GCM-nél az IV újrahasználata a kulcs eldobása). A fixtúra
// viszont csak akkor fixtúra, ha kétszer ugyanazt írja — ezért a blobokat itt
// a teszt zárja le, rögzített magú IV-vel, a gép formátumában; hogy ez tényleg
// a gép alakja, azt a valódi `decrypt` és `unlockWithPassword` ellenőrzi,
// mielőtt a fájlba kerülne. Csupa ASCII, hogy a láthatatlan jelek látszódjanak.
//
//   UPDATE_CRYPTO_FIXTURE=1 npm test     — a fájl újraírása

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BLOB_PREFIX, MIN_PASSWORD_LENGTH, authKey, decrypt, encrypt, normalizeRecoveryCode, passwordLength,
  recoveryAuthKey, recoveryKey, rootKey, subKey, unlockWithPassword, unlockWithRecovery,
} from '../src/shared/sync/crypto';
import { rng } from './merge-random';

const FIXTURE = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'crypto-cases.json');

interface ScryptCase { password: string; salt: string; n: number; r: number; p: number; dkLen: number; hex: string }
interface RecoveryCase { raw: string; norm: string }
interface PasswordCase { password: string; length: number; ok: boolean }
interface BlobCase { text: string; blob: string }
interface AccountCase {
  seed: number; accountId: string; password: string; passwordAlt: string[]; wrongPassword?: string;
  dataKey: string; recoveryCode: string; messyRecovery: string;
  authKey: string; recoveryAuthKey: string; wrappedByPassword: string; wrappedByRecovery: string;
  blobs: BlobCase[]; rejects: string[];
}
interface Fixture {
  note: string; version: number;
  scrypt: ScryptCase[]; recoveryCodes: RecoveryCase[]; passwords: PasswordCase[]; accounts: AccountCase[];
}

const ch = (code: number): string => String.fromCodePoint(code);

/** Az RFC 7914 két kisebb vektora — a gép a Node scryptjével írja, a két telefon a sajátjával számolja. */
const SCRYPT_VECTORS = [
  { password: '', salt: '', n: 16, r: 1, p: 1, dkLen: 64 },
  { password: 'password', salt: 'NaCl', n: 1024, r: 8, p: 16, dkLen: 64 },
];
const RFC_HEX = [
  '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906',
  'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640',
];

/** A helyreállító kód beírt alakjai: a kézzel írtak és a buktatók. */
const RAW_CODES: string[] = [
  '1THW-EBEP-44H9-33JC-EP8S-0S7Q-DVTF-CD6Q',
  '1thw ebep 44h9 33jc ep8s 0s7q dvtf cd6q',
  ' 1THW-EBEP-44H9-33JC-EP8S-0S7Q-DVTF-CD6Q\n',
  'o1-Il', 'u', 'U-u', '-', '', ' 1 2 3 ',
  'abc' + ch(0xa0) + 'def',             // nem törő szóköz: megy
  'ß',                                   // SS
  'ı',                                   // pont nélküli i: I, abból 1
  'ſ',                                   // hosszú s: S
  'ﬁ', 'ﬆ',                              // ligatúra: FI, abból F1; ST
  'ŉ',                                   // ʼN: N
  'ǰ',                                   // J + ékezet: J
  'ẚ',                                   // A + módosító: A
  'E' + ch(0x301), 'e' + ch(0x301),     // különálló ékezet: a betű marad, az ékezet megy
  'ę', 'ü', 'µ', 'ǆ', 'İ', ch(0x212a),  // nem latin nagybetű lesz belőle: nincs
  'Ａ', 'ａ', '１', '①',                 // teljes szélességű és bekarikázott: nincs
  '😀',
];

/** Jelszavak a tízes korlát körül: a mérce kódpont, NFKC után. */
const PASSWORDS: string[] = [
  '', 'rovid', 'kilenc!!!', 'pontosan10', 'ez-egy-elég-hosszú-jelszó',
  '😀😀😀😀😀', '😀😀😀😀😀😀😀😀😀😀',
  'éééééééééé', ('e' + ch(0x301)).repeat(10),
  'ﬁﬁﬁﬁﬁ', '🇭🇺🇭🇺🇭🇺🇭🇺🇭🇺',
  ['👨', '👩', '👧', '👦'].join(ch(0x200d)).repeat(2),
  '          ', '①②③④⑤⑥⑦⑧⑨⑩', 'Ａｂｃｄｅｆｇｈｉｊ',
];

const LONG = 'Alma, bogrács, cinege — délután a patak mellett, ősz volt és csend. '.repeat(24);

interface AccountSpec { accountId: string; password: string; alts?: (p: string) => string[]; wrong?: string; texts: string[] }
const ACCOUNTS: AccountSpec[] = [
  // Ugyanaz a fiók, mint az Android kézzel bemásolt tesztjéé (SyncCryptoTest): a belépőkulcs ott áll, itt is annak kell kijönnie.
  {
    accountId: 'acc_teszt', password: 'ez-egy-elég-hosszú-jelszó', wrong: 'ez-egy-elég-hosszú-jelszó ',
    texts: ['', 'youtube.com', '[{"id":"site_1","domain":"youtube.com"}]', LONG],
  },
  // Ékezetes jelszó két alakban: amit az egyik billentyűzet NFC-ben ad, a másik NFD-ben — ugyanaz a kulcs.
  {
    accountId: 'acc_arvizturo', password: 'árvíztűrő tükörfúrógép', alts: (p) => [p.normalize('NFD')],
    texts: ['{"alias":"árvíztűrő tükörfúrógép","emoji":"🧱🔒"}'],
  },
  { accountId: 'acc_emodzsi', password: '🔒🔑 jelszó 🧱🧱🧱', texts: ['🧱', 'üres: ""'] },
  // Teljes szélességű betű, ligatúra, bekarikázott számjegy: NFKC után a sima alak — ugyanaz a kulcs.
  { accountId: 'acc_teljes', password: 'Ｊｅｌｓｚó-ﬁnom-①②③', alts: () => ['Jelszó-finom-123'], texts: ['youtube.com'] },
  // A szóköz a jelszó része, a szélén is, duplán is — a levágott alak MÁS jelszó.
  { accountId: 'acc_szokoz', password: '  két  szó  jelszó  ', wrong: 'két szó jelszó', texts: ['a szóköz a jelszó része'] },
  { accountId: 'acc_vegyes', password: 'Ωμέγα-Пароль-日本語-pässwörd-٣٤٥-0123456789', texts: ['{"sites":[],"log":[]}'] },
];

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function bytes(r: () => number, n: number): Buffer {
  return Buffer.from(Array.from({ length: n }, () => Math.floor(r() * 256)));
}

/** Nyolc négyes csoport a Crockford-ábécéből: minden ilyen kód érvényes. */
function recoveryCodeFrom(r: () => number): string {
  const chars = Array.from({ length: 32 }, () => CROCKFORD[Math.floor(r() * CROCKFORD.length)]);
  return (chars.join('').match(/.{1,4}/g) ?? []).join('-');
}

/** Kézzel írt alak: kisbetű, szóköz a kötőjel helyett, O a 0 és l az 1 helyett — ugyanoda kell nyílnia. */
function messy(code: string): string {
  return code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
}

/**
 * AES-256-GCM a gép formátumában, ADOTT IV-vel — csak a fixtúrához. A termék
 * `encrypt`-je friss véletlen IV-t húz; a fixtúrának rögzített kell, hogy a
 * fájl kétszer ugyanaz legyen. Hogy ez a gép alakja, a valódi `decrypt` mondja.
 */
function sealWithIv(key: Buffer, text: string, iv: Buffer): string {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [BLOB_PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

function flip(b64url: string): string {
  const b = Buffer.from(b64url, 'base64url');
  b[0] ^= 0x01;
  return b.toString('base64url');
}

function toStdB64(b64url: string): string {
  return Buffer.from(b64url, 'base64url').toString('base64');
}

function buildAccount(seed: number, spec: AccountSpec): AccountCase {
  const r = rng(seed);
  for (let i = 0; i < 4; i++) r();
  const dataKey = bytes(r, 32);
  const recoveryCode = recoveryCodeFrom(r);
  const root = rootKey(spec.password, spec.accountId);
  const wrappedByPassword = sealWithIv(subKey(root, 'kek'), dataKey.toString('base64'), bytes(r, 12));
  const wrappedByRecovery = sealWithIv(recoveryKey(recoveryCode), dataKey.toString('base64'), bytes(r, 12));
  // Mielőtt a fájlba kerülne: a gép valódi kódja nyitja-e, amit a teszt zárt.
  assert.deepEqual(unlockWithPassword(spec.accountId, spec.password, wrappedByPassword), dataKey, `jelszó, fiók ${seed}`);
  assert.deepEqual(unlockWithRecovery(recoveryCode, wrappedByRecovery), dataKey, `kód, fiók ${seed}`);
  assert.deepEqual(unlockWithRecovery(messy(recoveryCode), wrappedByRecovery), dataKey, `kézzel írt kód, fiók ${seed}`);
  const passwordAlt = spec.alts ? spec.alts(spec.password) : [];
  const auth = subKey(root, 'auth').toString('base64');
  for (const alt of passwordAlt) {
    assert.notEqual(alt, spec.password, `a másik alak tényleg másik, fiók ${seed}`);
    assert.equal(authKey(alt, spec.accountId), auth, `a jelszó másik alakja ugyanazt a kulcsot adja, fiók ${seed}`);
  }
  if (spec.wrong !== undefined) {
    assert.notEqual(spec.wrong, spec.password);
    assert.throws(() => unlockWithPassword(spec.accountId, spec.wrong as string, wrappedByPassword), `rossz jelszó, fiók ${seed}`);
  }
  const blobs: BlobCase[] = spec.texts.map((text) => {
    const blob = sealWithIv(dataKey, text, bytes(r, 12));
    assert.equal(decrypt(dataKey, blob), text, `blob, fiók ${seed}`);
    return { text, blob };
  });
  // A szabványos base64-ábécé, kitöltéssel: a gép ezt is kinyitja, tehát a telefonnak is kell.
  const last = blobs[blobs.length - 1];
  const [p0, iv0, tag0, ct0] = last.blob.split('.');
  const std = [p0, toStdB64(iv0), toStdB64(tag0), toStdB64(ct0)].join('.');
  assert.equal(decrypt(dataKey, std), last.text, `szabványos ábécé, fiók ${seed}`);
  blobs.push({ text: last.text, blob: std });
  // Amit NEM szabad kinyitni: más előtag, csonka, rossz méret, babrált titkos és címke, üres titkos, más kulcs.
  const base = sealWithIv(dataKey, 'tiltott', bytes(r, 12));
  const [p, iv, tag, ct] = base.split('.');
  const otherKey = bytes(r, 32);
  const rejects = [
    base.replace(BLOB_PREFIX, 'brk9'),
    [p, iv, tag].join('.'),
    `${base}.x`,
    [p, 'AAAA', tag, ct].join('.'),
    [p, iv, tag.slice(0, -2), ct].join('.'),
    [p, iv, tag, flip(ct)].join('.'),
    [p, iv, flip(tag), ct].join('.'),
    [p, iv, tag, ''].join('.'),
    sealWithIv(otherKey, 'tiltott', Buffer.from(iv, 'base64url')),
  ];
  for (const bad of rejects) assert.throws(() => decrypt(dataKey, bad), `nyitni nem szabad: ${bad}`);
  return {
    seed, accountId: spec.accountId, password: spec.password, passwordAlt,
    ...(spec.wrong !== undefined ? { wrongPassword: spec.wrong } : {}),
    dataKey: dataKey.toString('base64'), recoveryCode, messyRecovery: messy(recoveryCode),
    authKey: auth, recoveryAuthKey: recoveryAuthKey(recoveryCode),
    wrappedByPassword, wrappedByRecovery, blobs, rejects,
  };
}

function buildFixture(): Fixture {
  const scrypt = SCRYPT_VECTORS.map((v, i) => {
    const hex = crypto.scryptSync(v.password, v.salt, v.dkLen, { N: v.n, r: v.r, p: v.p }).toString('hex');
    assert.equal(hex, RFC_HEX[i], 'a Node scryptje az RFC vektorát adja');
    return { ...v, hex };
  });
  const recoveryCodes = RAW_CODES.map((raw) => ({ raw, norm: normalizeRecoveryCode(raw) }));
  const passwords = PASSWORDS.map((password) => {
    const length = passwordLength(password);
    return { password, length, ok: length >= MIN_PASSWORD_LENGTH };
  });
  const accounts = ACCOUNTS.map((spec, i) => buildAccount(101 + i, spec));
  return {
    note: 'Generálja és őrzi: desktop/test/crypto-fixture.test.ts (UPDATE_CRYPTO_FIXTURE=1 npm test). '
      + 'A gép valódi kódja írja: scrypt-vektorok (RFC 7914), a helyreállító kód tiszta alakja, a jelszó hossza '
      + '(kódpont, NFKC után), és fiókonként a jelszóból származó belépőkulcs, a vele és a helyreállító kóddal burkolt '
      + 'adatkulcs, a gép blobjai és amit nem szabad kinyitni. Az IV-k rögzített magúak, hogy a fájl kétszer ugyanaz '
      + 'legyen; a termék encrypt-je véletlen IV-t húz. Olvassa: android/jvm-tests CryptoFixtureTest, '
      + 'ios/SharedTests CryptoFixtureTests. Csupa ASCII.',
    version: 1,
    scrypt, recoveryCodes, passwords, accounts,
  };
}

/** Minden nem ASCII jel számmal írva: a láthatatlan jelek látszanak, és a fájl mindenhol ugyanúgy olvasódik. */
function ascii(json: string): string {
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    out += code < 0x7f ? json[i] : '\\u' + code.toString(16).padStart(4, '0');
  }
  return out;
}

function render(f: Fixture): string {
  const rows = (items: unknown[]) => items.map((c) => '  ' + ascii(JSON.stringify(c))).join(',\n');
  return `{\n "note": ${ascii(JSON.stringify(f.note))},\n "version": ${f.version},\n`
    + ` "scrypt": [\n${rows(f.scrypt)}\n ],\n`
    + ` "recoveryCodes": [\n${rows(f.recoveryCodes)}\n ],\n`
    + ` "passwords": [\n${rows(f.passwords)}\n ],\n`
    + ` "accounts": [\n${rows(f.accounts)}\n ]\n}\n`;
}

test('a titkosítás fixtúrája friss, és a gép a saját kulcsait nyitja', () => {
  const built = buildFixture();
  assert.equal(
    built.accounts[0].authKey, 'SPgYkvURBdAHhJqHf6fDAAWoPBMxS3oqvosFvdPTU0w=',
    'ugyanaz a belépőkulcs, mint amit az Android kézzel bemásolt tesztje a gépről kapott',
  );
  assert.ok(built.passwords.some((p) => p.ok) && built.passwords.some((p) => !p.ok), 'a jelszavak a korlát két oldalán');
  assert.ok(built.recoveryCodes.some((c) => c.norm === '') && built.recoveryCodes.some((c) => c.norm.length === 32));
  assert.ok(built.accounts.some((a) => a.passwordAlt.length > 0) && built.accounts.some((a) => a.wrongPassword));
  // A termék encrypt-je is a gép alakját adja: négy rész, friss IV, és a saját decrypt nyitja.
  const key = Buffer.from(built.accounts[0].dataKey, 'base64');
  const own = encrypt(key, 'youtube.com');
  assert.equal(own.split('.').length, 4);
  assert.notEqual(own, encrypt(key, 'youtube.com'), 'friss IV minden híváshoz');
  assert.equal(decrypt(key, own), 'youtube.com');
  const text = render(built);
  if (process.env.UPDATE_CRYPTO_FIXTURE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, text);
  }
  assert.ok(fs.existsSync(FIXTURE), `nincs fixture: ${FIXTURE} — UPDATE_CRYPTO_FIXTURE=1 npm test`);
  const onDisk = fs.readFileSync(FIXTURE, 'utf8');
  assert.equal(
    onDisk, text,
    'a fixtures/crypto-cases.json elavult a gép kulcsaihoz képest — UPDATE_CRYPTO_FIXTURE=1 npm test, '
      + 'aztán a Kotlin (CryptoFixtureTest) és a Swift (CryptoFixtureTests) teszt mutatja meg, hol csúszott el a tükör',
  );
  assert.ok(/^[\x00-\x7f]*$/.test(onDisk), 'a fixtúra nem csupa ASCII');
});
