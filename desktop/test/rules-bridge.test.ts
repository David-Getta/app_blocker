// A híd a bővítményhez.
//
// Ez a végpont a saját gépen belül adja ki, mi van részlegesen tiltva. Két
// dolgot nem szabad elrontani, és egyik sem látszana használat közben:
//
//   1. ha a hálózat felé is szolgálna, a blokklista kimenne a Wi-Fire;
//   2. ha kód nélkül is válaszolna, a gépen futó bármelyik program elolvashatná.
//
// A harmadik: ezen a hídon SEMMIT nem lehet módosítani. Ha lehetne, a bővítmény
// lenne a legegyszerűbb kiskapu az egész appban.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  answer, newBridgeToken, startRulesBridge, TOKEN_HEADER, tokenMatches,
} from '../src/main/rules-bridge';

const RULES = [{ host: 'youtube.com', path: '/@valaki' }];
const deps = (token = 'ABCD-EFGH') => ({ token, getRules: async () => RULES });

test('the rules only come out with the right code', async () => {
  const d = deps();
  const ok = await answer(d, 'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' });
  assert.equal(ok.status, 200);
  assert.deepEqual((ok.body as { rules: unknown }).rules, RULES);

  for (const bad of [undefined, '', 'ROSSZ', 'ABCD-EFG', 'ABCD-EFGHI', 42, null]) {
    const r = await answer(d, 'GET', '/rules', { [TOKEN_HEADER]: bad });
    assert.equal(r.status, 401, String(bad));
    assert.equal((r.body as { rules?: unknown }).rules, undefined, 'kód nélkül semmi nem szivárog');
  }
});

test('the code survives being copied by hand', async () => {
  // Kötőjel, kisbetű és szóköz nem dönthet arról, hogy működik-e: ezt a kódot
  // az ember a felületről másolja át.
  const d = deps('ABCD-EFGH');
  for (const form of ['abcd-efgh', 'ABCDEFGH', ' ABCD EFGH ', 'abcdEFGH']) {
    const r = await answer(d, 'GET', '/rules', { [TOKEN_HEADER]: form });
    assert.equal(r.status, 200, form);
  }
  assert.equal(tokenMatches('ABCD-EFGH', 'ABCD-EFGX'), false);
});

test('nothing can be changed through this bridge', async () => {
  // Csak GET, és csak egy útvonal. Egy írható végpont itt azt jelentené, hogy a
  // bővítményből — vagy bármi másból, ami a kódot ismeri — fel lehetne oldani.
  const d = deps();
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await answer(d, method, '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' });
    assert.equal(r.status, 405, method);
  }
  for (const path of ['/', '/sites', '/rules/add', '/status']) {
    const r = await answer(d, 'GET', path, { [TOKEN_HEADER]: 'ABCD-EFGH' });
    assert.equal(r.status, 404, path);
  }
  // A lekérdezés nem számít: `/rules?x=1` ugyanaz a végpont.
  assert.equal((await answer(d, 'GET', '/rules?x=1', { [TOKEN_HEADER]: 'ABCD-EFGH' })).status, 200);
});

test('the generated code is readable and unguessable', () => {
  const token = newBridgeToken();
  assert.match(token, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4})+$/,
    'Crockford base32, négyes csoportokban');
  // Tíz bájt = 80 bit. Végigpróbálni nem lehet, és leírni még el lehet.
  assert.equal(token.replace(/-/g, '').length, 16);
  assert.notEqual(newBridgeToken(), newBridgeToken());
});

test('the bridge listens on the loopback address only', async () => {
  // EZ A LÉNYEG. A szinkron-kiszolgáló a hálózat felé szolgál ki; ez SOHA.
  // Ha ez a kötés elcsúszna, a blokklista a Wi-Fin is elérhető lenne — és
  // semmi nem jelezné, mert a saját gépről ugyanúgy működne.
  const h = await startRulesBridge({ ...deps(), startPort: 18788 });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/rules`, {
      headers: { [TOKEN_HEADER]: 'ABCD-EFGH' },
    });
    assert.equal(r.status, 200);
    const body = await r.json() as { protocol: number; rules: unknown };
    assert.equal(body.protocol, 1);
    assert.deepEqual(body.rules, RULES);
    // A böngésző a CORS-t a válasz fejlécei alapján dönti el. Ha ide kikerülne
    // egy megengedő fejléc, egy TETSZŐLEGES weboldal is elolvashatná — a
    // bővítménynek viszont nincs rá szüksége (host_permissions).
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    assert.equal(r.headers.get('cache-control'), 'no-store');

    // A gép hálózati címén NEM figyel. A hurok-címen kívül bármelyik cím
    // elutasított kapcsolatot ad.
    const outside = await fetch(`http://127.0.0.2:${h.port}/rules`, {
      headers: { [TOKEN_HEADER]: 'ABCD-EFGH' },
    }).then(() => 'válaszolt').catch(() => 'nem válaszolt');
    assert.equal(outside, 'nem válaszolt');
  } finally {
    h.close();
  }
});

test('a busy port does not kill the bridge', async () => {
  // A 8788 bármelyik másik program alatt lehet. Ha ilyenkor elhasalnánk, a
  // bővítmény némán maradna szabályok nélkül.
  const first = await startRulesBridge({ ...deps(), startPort: 18800 });
  const second = await startRulesBridge({ ...deps(), startPort: 18800 });
  try {
    assert.notEqual(first.port, second.port);
    assert.equal(second.port, first.port + 1);
  } finally {
    first.close();
    second.close();
  }
});

test('a szabályok és a munkamenet EGYSZERRE indul, nem egymás után', async () => {
  // A kettő ugyanabból az egy állapotból jön, és a hívó össze is vonja őket egy
  // lekérdezéssé — de csak akkor tudja, ha PÁRHUZAMOSAN indulnak. Sorosan a
  // második csak az első befejezése után kezdődne, tehát két külön lekérdezés
  // lenne belőle, dupla késleltetéssel.
  //
  // Ez nem sebességi finomkodás: a bővítmény három másodperc után továbblép,
  // és a dupla késleltetés ezt átlépheti — a szabályok pedig CSENDBEN nem
  // frissülnének. A böngésző a régi listával menne tovább.
  let focusStarted = false;
  let sawFocusStart = false;
  const d = {
    token: 'ABCD-EFGH',
    getRules: async () => {
      // Elengedjük a vezérlést: ha a kettő párhuzamos, a másik ezalatt elindul.
      await new Promise((r) => { setTimeout(r, 20); });
      sawFocusStart = focusStarted;
      return RULES;
    },
    getFocus: async () => { focusStarted = true; return { running: false }; },
  };
  const r = await answer(d, 'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' });
  assert.equal(r.status, 200);
  assert.equal(sawFocusStart, true, 'a munkamenet lekérdezése nem várta meg a szabályokét');
});
