// Párosító kód.
//
// Ez a funkció azon a ponton áll, ahol a szinkron eddig meghalt: be kellett
// gépelni egy IP-címet. Ha a kód rosszul működik, a felhasználó vagy nem tud
// belépni, vagy — ami rosszabb — MÁSHOVA lép be, mint hitte.
//
// Ezért a tesztek nem szép eseteket néznek, hanem a két kártékony kimenetelt:
// jó kódot elutasítani, és rossz kódból érvényes címet csinálni.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  DEFAULT_SYNC_PORT, decodePairingCode, encodePairingCode, formatPairingCode,
  resolveServerInput,
} from '../src/shared/sync/pairing';

test('a home address becomes a very short code', () => {
  // A rövidség a lényeg: ha a kód is tíz karakter, semmivel nem jobb az
  // IP-címnél. Otthon szinte mindig 192.168.x.y van, és épp azt a két bájtot
  // kell leírni, ami változik.
  const code = encodePairingCode('http://192.168.1.10:8787');
  assert.ok(code, 'kódolhatónak kell lennie');
  assert.equal(code.length, 5, `öt karakter, nem ${code.length}`);
  assert.equal(decodePairingCode(code), 'http://192.168.1.10:8787');
});

test('every private range survives the round trip', () => {
  for (const url of [
    'http://192.168.0.1:8787',
    'http://192.168.255.255:8787',
    'http://10.0.0.5:8787',
    'http://10.255.255.254:8787',
    'http://172.16.4.9:8787',
    'http://172.31.200.1:8787',
    'http://100.64.3.7:8787',   // CGNAT — a „bármi” ág
    'http://8.8.8.8:8787',
  ]) {
    const code = encodePairingCode(url);
    assert.ok(code, `nem kódolható: ${url}`);
    assert.equal(decodePairingCode(code), url, `oda-vissza eltér: ${url} -> ${code}`);
    assert.ok(code.length <= 8, `túl hosszú (${code.length}): ${url}`);
  }
});

test('a non-default port is carried too', () => {
  const url = 'http://192.168.1.10:9000';
  const code = encodePairingCode(url)!;
  assert.equal(decodePairingCode(code), url);
  // Az alapértelmezett port NEM kerül a kódba — ezért rövidebb.
  assert.ok(code.length > encodePairingCode('http://192.168.1.10:8787')!.length);
});

test('a mistyped code is refused, not silently pointed elsewhere', () => {
  // Ez a legfontosabb teszt. Ellenőrző összeg nélkül egy elrontott betűből
  // MÁSIK, létező cím lenne, és a felhasználó csak annyit látna, hogy a
  // kiszolgáló nem érhető el — miközben valójában elgépelte a kódot.
  const good = encodePairingCode('http://192.168.1.10:8787')!;
  let refused = 0;
  let total = 0;
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  for (let i = 0; i < good.length; i++) {
    for (const ch of alphabet) {
      if (ch === good[i]) continue;
      total++;
      const bad = good.slice(0, i) + ch + good.slice(i + 1);
      const decoded = decodePairingCode(bad);
      if (decoded === null) refused++;
      else assert.notEqual(decoded, 'http://192.168.1.10:8787');
    }
  }
  // Öt bit ellenőrző összeg: az egykarakteres elgépelések nagy részét elkapja.
  assert.ok(refused / total > 0.9, `csak ${Math.round((refused / total) * 100)}%-ot fogott meg`);
});

test('hyphens, spaces and lower case never decide whether a code works', () => {
  // Kézzel másolva senki nem figyel ezekre. Egy kód, ami emiatt nem megy,
  // ugyanolyan rossz, mint a be nem gépelt IP-cím.
  const code = encodePairingCode('http://10.0.0.5:8787')!;
  const want = 'http://10.0.0.5:8787';
  assert.equal(decodePairingCode(code.toLowerCase()), want);
  assert.equal(decodePairingCode(formatPairingCode(code)), want);
  assert.equal(decodePairingCode(` ${code.split('').join(' ')} `), want);
});

test('look-alike characters land in the same place', () => {
  // A Crockford ábécében nincs I, L, O és U. Aki mégis annak látja az 1-est
  // vagy a 0-t, jó eredményt kapjon, ne hibaüzenetet.
  const code = encodePairingCode('http://192.168.1.10:8787')!;
  const messy = code.replace(/1/g, 'I').replace(/0/g, 'O');
  assert.equal(decodePairingCode(messy), 'http://192.168.1.10:8787');
});

test('junk does not become a valid address', () => {
  // A bizonytalanság itt az ELUTASÍTÁS felé dől: egy véletlenül elfogadott kód
  // olyan gépre küldené a jelszót, amiről a felhasználó nem tud.
  for (const bad of ['', '   ', 'ZZZZZ', 'ABC', 'nem egy kód', '!!!!!', 'A'.repeat(40)]) {
    assert.equal(decodePairingCode(bad), null, bad);
  }
  assert.equal(decodePairingCode(undefined as unknown as string), null);
});

test('what cannot be coded honestly returns null', () => {
  // Tartománynévre és HTTPS-re nem gyártunk kódot: az működésképtelen lenne,
  // és a felület inkább a teljes címet mutatja.
  assert.equal(encodePairingCode('https://192.168.1.10:8787'), null);
  assert.equal(encodePairingCode('http://sync.pelda.hu:8787'), null);
  assert.equal(encodePairingCode('nem egy cím'), null);
  assert.equal(encodePairingCode(undefined as unknown as string), null);
});

test('one field takes both a code and an address', () => {
  // Külön mező a kódnak és a címnek azt jelentené, hogy előbb el kell dönteni,
  // melyikbe kell írni — és pont az ilyen apró döntéseknél hagyják abba.
  const code = encodePairingCode('http://192.168.1.10:8787')!;
  assert.equal(resolveServerInput(code), 'http://192.168.1.10:8787');
  assert.equal(resolveServerInput('http://192.168.1.10:8787'), 'http://192.168.1.10:8787');
  assert.equal(resolveServerInput('https://sync.pelda.hu'), 'https://sync.pelda.hu');
  // Séma nélkül: a http:// hiánya nem hiba, csak kihagyott gépelés.
  assert.equal(resolveServerInput('192.168.1.10:8787'), 'http://192.168.1.10:8787');
  assert.equal(resolveServerInput('sync.pelda.hu'), 'http://sync.pelda.hu');
  assert.equal(resolveServerInput(''), null);
  assert.equal(resolveServerInput('   '), null);
});

test('the code reads back in groups, because it is copied by hand', () => {
  assert.equal(formatPairingCode('ABCDEFG'), 'ABCD-EFG');
  assert.equal(formatPairingCode('ABCD'), 'ABCD');
  assert.equal(DEFAULT_SYNC_PORT, 8787);
});
