// A szinkron titkosítása.
//
// Amit ezek a tesztek őriznek, az egyetlen mondat: a KISZOLGÁLÓ NEM LÁTJA az
// adatot. Ha ez elromlik, a felhasználó blokklistája és a mért ideje — vagyis
// pont az, amivel küzd — egy idegen gépen fekszik olvashatóan.
//
// A scrypt szándékosan lassú (32 MB, pár tized másodperc), ezért itt kevés
// kulcsszármaztatás van, és amit lehet, újrahasznosítunk.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  BLOB_PREFIX, decrypt, encrypt, enroll, newRecoveryCode, normalizeRecoveryCode,
  recoveryKey, rewrapForNewPassword, unlockWithPassword, unlockWithRecovery,
  unwrapDataKey, wrapDataKey,
} from '../src/shared/sync/crypto';

const ACCOUNT = 'acc_teszt';
const PASSWORD = 'ez-egy-elég-hosszú-jelszó';

// Egyszer állítjuk elő, mert a scrypt szándékosan drága.
const enrollment = enroll(ACCOUNT, PASSWORD);

test('what the server gets never contains the data key', () => {
  const onServer = JSON.stringify(enrollment.serverSide);
  assert.ok(!onServer.includes(enrollment.dataKey.toString('base64')),
    'az adatkulcs nyersen sosem kerülhet a kiszolgálóra');
  assert.ok(!onServer.includes(PASSWORD), 'a jelszó sem');
  assert.ok(!onServer.includes(enrollment.recoveryCode), 'a helyreállító kód sem');
  assert.equal(enrollment.serverSide.accountId, ACCOUNT);
});

test('the password opens the data key, a wrong one does not', () => {
  const key = unlockWithPassword(ACCOUNT, PASSWORD, enrollment.serverSide.wrappedByPassword);
  assert.deepEqual(key, enrollment.dataKey);
  assert.throws(
    () => unlockWithPassword(ACCOUNT, PASSWORD + 'x', enrollment.serverSide.wrappedByPassword),
    'rossz jelszóval nem szabad kicsomagolni',
  );
});

test('the recovery code opens the same data key', () => {
  const key = unlockWithRecovery(enrollment.recoveryCode, enrollment.serverSide.wrappedByRecovery);
  assert.deepEqual(key, enrollment.dataKey, 'ugyanaz az adatkulcs, másik ajtón');
  // Kötőjelek és kisbetűk nélkül is: kézzel másolva senki nem figyel ezekre.
  const messy = enrollment.recoveryCode.toLowerCase().replace(/-/g, ' ');
  assert.deepEqual(
    unlockWithRecovery(messy, enrollment.serverSide.wrappedByRecovery),
    enrollment.dataKey,
  );
});

test('changing the password keeps the data readable', () => {
  // Ez a lényege annak, hogy az adatkulcs véletlen, nem a jelszóból származik:
  // a kiszolgáló nem tudná újratitkosítani az adatot, mert nem látja.
  const blob = encrypt(enrollment.dataKey, 'youtube.com');
  const next = rewrapForNewPassword(ACCOUNT, enrollment.dataKey, 'másik-jelszó-lett');
  const key = unlockWithPassword(ACCOUNT, 'másik-jelszó-lett', next.wrappedByPassword);
  assert.equal(decrypt(key, blob), 'youtube.com');
  assert.notEqual(next.authKey, enrollment.serverSide.authKey, 'a belépőkulcs viszont változik');
});

test('a tampered blob is refused, not silently accepted', () => {
  // GCM-címke nélkül a kiszolgáló (vagy aki a helyére áll) bitenként babrálhatna
  // a blokklistán úgy, hogy észre se vesszük.
  const blob = encrypt(enrollment.dataKey, '{"sites":["youtube.com"]}');
  const [tag, iv, auth, ct] = blob.split('.');
  assert.equal(tag, BLOB_PREFIX);

  const flipped = Buffer.from(ct, 'base64url');
  flipped[0] ^= 0x01;
  assert.throws(() => decrypt(enrollment.dataKey, [tag, iv, auth, flipped.toString('base64url')].join('.')));

  assert.throws(() => decrypt(enrollment.dataKey, blob.replace(BLOB_PREFIX, 'brk9')),
    'ismeretlen formátum');
  assert.throws(() => decrypt(enrollment.dataKey, 'csak.harom.resz'));
  assert.throws(() => decrypt(enrollment.dataKey, [tag, 'AAAA', auth, ct].join('.')),
    'rossz méretű IV');
});

test('the same text encrypts differently every time', () => {
  // Azonos IV ugyanazzal a kulccsal GCM-nél nem „gyengébb titkosítás”, hanem a
  // kulcs eldobása. Ha ez a teszt elbukik, a véletlen IV veszett el.
  const a = encrypt(enrollment.dataKey, 'youtube.com');
  const b = encrypt(enrollment.dataKey, 'youtube.com');
  assert.notEqual(a, b);
  assert.equal(decrypt(enrollment.dataKey, a), decrypt(enrollment.dataKey, b));
});

test('a recovery code is long, readable, and free of look-alike letters', () => {
  const code = newRecoveryCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/,
    'nyolc négyes csoport, I/L/O/U nélkül');
  assert.notEqual(code, newRecoveryCode(), 'minden kód friss');
  assert.equal(normalizeRecoveryCode('o1-Il'), '0111', 'a hasonló alakú jelek egy helyre esnek');
  assert.throws(() => recoveryKey('rövid'), 'a csonka kódot nem fogadjuk el');
});

test('a wrapped key of the wrong size is refused', () => {
  const kek = recoveryKey(newRecoveryCode());
  const bogus = wrapDataKey(kek, Buffer.alloc(8, 7)); // nem 32 bájt
  assert.throws(() => unwrapDataKey(kek, bogus), 'a méret ellenőrizve');
});

test('a short password cannot open an account', () => {
  // A jelszó itt nem egy weboldal belépője: EZ tartja a kulcsot, ami az adatot
  // nyitja. Aki a kiszolgálóra betör, offline próbálkozhat vele, korlátlanul —
  // ott már csak az scrypt lassúsága és a jelszó hossza védi.
  assert.throws(() => enroll('acc_rovid', 'rovid'), /legalább 10/);
  assert.throws(() => enroll('acc_rovid', ''), /legalább 10/);
  assert.throws(
    () => rewrapForNewPassword(ACCOUNT, enrollment.dataKey, 'rovid'),
    /legalább 10/,
    'jelszócserénél sem lehet gyengíteni',
  );
});
