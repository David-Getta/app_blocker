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

test('a menet indítása a hídról: a kóddal, csomaggal és perccel — a bíró nemje válasz, nem hiba', async () => {
  const started: { packId: string; minutes: number }[] = [];
  let refuse: string | null = null;
  const d = {
    ...deps(),
    getSuggest: async () => ({ packId: 'pack_1', name: 'Nyelvtanulás', minutes: 25, focusDay: true }),
    startFocus: async (packId: string, minutes: number) => {
      if (refuse) throw new Error(refuse);
      started.push({ packId, minutes });
    },
  };
  const rules = await answer(d, 'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' });
  assert.deepEqual((rules.body as { suggest: unknown }).suggest, { packId: 'pack_1', name: 'Nyelvtanulás', minutes: 25, focusDay: true },
    'a javasolt csomag a szabályokkal együtt megy le — a menet-nappal');
  const ok = await answer(d, 'POST', '/focus_start', { [TOKEN_HEADER]: 'ABCD-EFGH' }, { packId: 'pack_1', minutes: 25 });
  assert.equal(ok.status, 200);
  assert.deepEqual(started, [{ packId: 'pack_1', minutes: 25 }]);
  assert.equal((await answer(d, 'POST', '/focus_start', { [TOKEN_HEADER]: 'ROSSZ' }, { packId: 'pack_1', minutes: 25 })).status, 401,
    'kód nélkül nem indul');
  for (const bad of [{}, { packId: '', minutes: 25 }, { packId: 'pack_1', minutes: 0 }, { packId: 'pack_1', minutes: 2.5 }, { packId: 'pack_1' }]) {
    assert.equal((await answer(d, 'POST', '/focus_start', { [TOKEN_HEADER]: 'ABCD-EFGH' }, bad)).status, 400, JSON.stringify(bad));
  }
  refuse = 'Már fut egy menet.';
  const no = await answer(d, 'POST', '/focus_start', { [TOKEN_HEADER]: 'ABCD-EFGH' }, { packId: 'pack_1', minutes: 25 });
  assert.equal(no.status, 409);
  assert.equal((no.body as { error: string }).error, 'Már fut egy menet.');
  assert.equal(started.length, 1, 'a nem után nem indult új');
  const old = await answer(deps(), 'POST', '/focus_start', { [TOKEN_HEADER]: 'ABCD-EFGH' }, { packId: 'pack_1', minutes: 25 });
  assert.equal(old.status, 404, 'indító nélkül a végpont nincs');
  assert.equal((await answer(deps(), 'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' })).body && true, true);
});

test('ablak a csúcs-órára a hídról: a kóddal, csomaggal és órával — csak felvétel, a bíró nemje válasz', async () => {
  const added: { packId: string; hour: number }[] = [];
  let refuse: string | null = null;
  const d = {
    ...deps(),
    getSuggest: async () => ({ packId: 'pack_1', name: 'Nyelvtanulás', minutes: 25, peakHour: 21, focusHour: 9, focusHourPack: 'Mély munka', sameHour: false }),
    addFocusWindow: async (packId: string, hour: number) => {
      if (refuse) throw new Error(refuse);
      added.push({ packId, hour });
    },
  };
  const rules = await answer(d, 'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' });
  assert.equal((rules.body as { suggest: { peakHour: number } }).suggest.peakHour, 21, 'a csúcs-óra a javaslattal megy le');
  assert.equal((rules.body as { suggest: { focusHour: number } }).suggest.focusHour, 9, 'a menet-óra is — a csúcs-óra gombjának tükre');
  assert.equal((rules.body as { suggest: { focusHourPack: string } }).suggest.focusHourPack, 'Mély munka', 'a menet-óra fedése is lemegy');
  assert.equal((rules.body as { suggest: { sameHour: boolean } }).suggest.sameHour, false, 'az egybeesés jele is lemegy');
  const ok = await answer(d, 'POST', '/focus_window', { [TOKEN_HEADER]: 'ABCD-EFGH' }, { packId: 'pack_1', hour: 21 });
  assert.equal(ok.status, 200);
  assert.deepEqual(added, [{ packId: 'pack_1', hour: 21 }]);
  assert.equal((await answer(d, 'POST', '/focus_window', { [TOKEN_HEADER]: 'ROSSZ' }, { packId: 'pack_1', hour: 21 })).status, 401,
    'kód nélkül nem megy');
  for (const bad of [{}, { packId: '', hour: 21 }, { packId: 'pack_1', hour: 24 }, { packId: 'pack_1', hour: -1 }, { packId: 'pack_1', hour: 2.5 }, { packId: 'pack_1' }]) {
    assert.equal((await answer(d, 'POST', '/focus_window', { [TOKEN_HEADER]: 'ABCD-EFGH' }, bad)).status, 400, JSON.stringify(bad));
  }
  refuse = 'Ennek a csomagnak már van heti ablaka — az appban szerkeszthető.';
  const no = await answer(d, 'POST', '/focus_window', { [TOKEN_HEADER]: 'ABCD-EFGH' }, { packId: 'pack_1', hour: 21 });
  assert.equal(no.status, 409);
  assert.equal((no.body as { error: string }).error, refuse);
  assert.equal(added.length, 1, 'a nem után nem került fel');
  const old = await answer(deps(), 'POST', '/focus_window', { [TOKEN_HEADER]: 'ABCD-EFGH' }, { packId: 'pack_1', hour: 21 });
  assert.equal(old.status, 404, 'felvevő nélkül a végpont nincs');
});

test('nothing can be changed through this bridge', async () => {
  // Csak GET a szabályokra, és befelé csak három út: a megakadás-könyv, a menet
  // INDÍTÁSA és a heti ablak FELVÉTELE — mind a lazítás irányában zárt. Egy feloldó végpont itt azt
  // jelentené, hogy a bővítményből — vagy bármi másból, ami a kódot ismeri —
  // fel lehetne oldani.
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

test('a csatorna-szűrők is lemennek a hídon — és üresen is mező marad', async () => {
  // A bővítmény ebből tudja, MIT szűrjön. Ha a mező kimaradna, a szűrő az
  // appban létezne, a böngészőben meg semmit nem csinálna — a leg­csendesebb
  // hibafajta, ami ellen az egész ellenőrző-készlet szól.
  const d = {
    token: 'ABCD-EFGH',
    getRules: async () => RULES,
    getChannels: async () => [{ host: 'youtube.com', allow: ['@jo'] }],
  };
  const r = await answer(d, 'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' });
  assert.equal(r.status, 200);
  assert.deepEqual(
    (r.body as { channels: unknown }).channels,
    [{ host: 'youtube.com', allow: ['@jo'] }],
  );

  // Szűrők nélkül ÜRES lista megy, nem hiányzó mező: a bővítmény oldalán a
  // „nincs szűrő” és a „régi app” így két külön eset marad.
  const none = await answer(deps(), 'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' });
  assert.deepEqual((none.body as { channels: unknown }).channels, []);
});

test('a zárva lévő oldalak okostul lemennek a hídon — üresen is mező marad', async () => {
  // Ebből magyaráz a bővítmény tiltó-lapja a nyers DNS-hibalap helyett. Ha a
  // mező kimaradna, semmi nem törne el láthatóan — csak arra nem válaszolna
  // senki, hogy miért nem megy az oldal, és meddig. Pont az ilyen csendes
  // kimaradás ellen van ez a teszt.
  const closed = [
    { host: 'gemini.google.com', reason: 'cooldown' as const, until: 1_800_000_000_000 },
    { host: 'youtube.com', reason: 'always' as const, until: 0 },
  ];
  const d = {
    token: 'ABCD-EFGH',
    getRules: async () => RULES,
    getClosed: async () => closed,
  };
  const r = await answer(d, 'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' });
  assert.equal(r.status, 200);
  assert.deepEqual((r.body as { closed: unknown }).closed, closed);

  const none = await answer(deps(), 'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' });
  assert.deepEqual((none.body as { closed: unknown }).closed, []);
  assert.deepEqual((none.body as { notes: unknown }).notes, [], 'indok nélkül üres lista, nem hiányzó mező');
});

test('a zárlat vége is átmegy a hídon — nélküle null, hogy a lap ne ígérjen feloldást', async () => {
  // A tiltó lap lába alapból azt mondja, hogy az appban feloldható, próbatétellel.
  // Zárlat alatt pont ez az út nincs — a lapnak tudnia kell róla.
  const withLock = { ...deps(), getLockdown: async () => ({ until: 1_800_000_000_000 }) };
  const r = await answer(withLock, 'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' });
  assert.equal(r.status, 200);
  assert.deepEqual((r.body as { lockdown: unknown }).lockdown, { until: 1_800_000_000_000 });

  const r2 = await answer(deps(), 'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' });
  assert.equal((r2.body as { lockdown: unknown }).lockdown, null, 'zárlat nélkül null, nem hiányzó mező');

  // A heti ablak jele is átmegy: a lap ebből mondja, hogy az ablak tartja.
  const byWindow = { ...deps(), getLockdown: async () => ({ until: 1_800_000_000_000, byWindow: true }) };
  const r3 = await answer(byWindow, 'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' });
  assert.deepEqual((r3.body as { lockdown: unknown }).lockdown, { until: 1_800_000_000_000, byWindow: true });
});

test('a megbízott neve is átmegy a hídon — nélküle null, hogy a lap ne mondjon olyat, ami nincs', async () => {
  // A tiltó lap lába a feloldás útját mondja; megbízottal az az út az ő
  // jelmondatával ér véget — a lapnak tudnia kell róla. Csak a név megy: a
  // lenyomat a segédé, a bővítménynek semmi dolga vele.
  const withPartner = { ...deps(), getPartner: async () => ({ name: 'Anna' }) };
  const r = await answer(withPartner, 'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' });
  assert.equal(r.status, 200);
  assert.deepEqual((r.body as { partner: unknown }).partner, { name: 'Anna' });

  const r2 = await answer(deps(), 'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' });
  assert.equal((r2.body as { partner: unknown }).partner, null, 'megbízott nélkül null, nem hiányzó mező');
});

test('a kulcsszavak is átmennek a hídon — nélkülük üres lista, nem hiányzó mező', async () => {
  // A kulcsszót CSAK a böngésző tudja érvényesíteni: ha a híd nem adná le,
  // a lista az appban csak dísz lenne. Üresen is mező, hogy a régi és az új
  // válasz ugyanolyan alakú legyen.
  const withWords = { ...deps(), getKeywords: async () => ['shorts', 'reels'] };
  const r = await answer(withWords, 'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' });
  assert.equal(r.status, 200);
  assert.deepEqual((r.body as { keywords: unknown }).keywords, ['shorts', 'reels']);
  const r2 = await answer(deps(), 'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' });
  assert.deepEqual((r2.body as { keywords: unknown }).keywords, []);
});

test('a megakadás-könyv az EGYETLEN befelé út: kóddal, alakkal — és szabályt nem ír', async () => {
  // A bővítmény könyvelése jön rajta (hányszor vitt a tiltó lapra), semmi
  // más: a híd továbbra sem tud szabályt felvenni vagy levenni. Kód nélkül
  // 401, rossz alakkal 400, GET-tel 404 — és a régi híd (putHits nélkül)
  // csendben nyugtáz, hogy a bővítmény ne hibázzon rajta.
  const got: { source: string; days: unknown[] }[] = [];
  const d = { ...deps(), putHits: async (source: string, days: unknown[]) => { got.push({ source, days }); } };
  const days = [{ day: '2026-09-18', total: 2, byReason: { keyword: 2 } }];
  const ok = await answer(d, 'POST', '/hits', { [TOKEN_HEADER]: 'ABCD-EFGH' }, { source: 'chrome1', days });
  assert.equal(ok.status, 200);
  assert.deepEqual(got, [{ source: 'chrome1', days }]);
  const noToken = await answer(d, 'POST', '/hits', {}, { source: 'chrome1', days });
  assert.equal(noToken.status, 401);
  const badShape = await answer(d, 'POST', '/hits', { [TOKEN_HEADER]: 'ABCD-EFGH' }, { days: 'nem' });
  assert.equal(badShape.status, 400);
  assert.equal((await answer(d, 'GET', '/hits', { [TOKEN_HEADER]: 'ABCD-EFGH' })).status, 404);
  assert.equal((await answer(d, 'POST', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' }, {})).status, 405, 'a szabályokra nincs befelé út');
  assert.equal(got.length, 1, 'a rossz kérések nem könyveltek');
  const old = await answer(deps(), 'POST', '/hits', { [TOKEN_HEADER]: 'ABCD-EFGH' }, { source: 'chrome1', days });
  assert.equal(old.status, 200, 'putHits nélkül is nyugta: a bővítmény ne hibázzon');
});

test('a valódi hídon a törzs beolvasva jön — a rossz JSON 400, a túl nagy 413', async () => {
  const got: unknown[] = [];
  const h = await startRulesBridge({ ...deps(), startPort: 18820, putHits: async (source, days) => { got.push({ source, days }); } });
  try {
    const url = `http://127.0.0.1:${h.port}/hits`;
    const headers = { [TOKEN_HEADER]: 'ABCD-EFGH', 'content-type': 'application/json' };
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ source: 'edge1', days: [{ day: '2026-09-18', total: 1 }] }) });
    assert.equal(r.status, 200);
    assert.deepEqual(got, [{ source: 'edge1', days: [{ day: '2026-09-18', total: 1 }] }]);
    const bad = await fetch(url, { method: 'POST', headers, body: '{nem json' });
    assert.equal(bad.status, 400);
    const big = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ source: 'x', days: [], pad: 'a'.repeat(70 * 1024) }) })
      .then((res) => res.status, () => 413); // a megszakított kérésre a kliens hibát is dobhat
    assert.equal(big, 413);
    assert.equal(got.length, 1);
  } finally {
    h.close();
  }
});

test('az indokok is a válaszban vannak, hosztnevenként — a régi hídon üres lista', async () => {
  const notes = [{ host: 'youtube.com', text: 'Mert este nem alszom tőle' }];
  const r = await answer(
    { token: 'ABCD-EFGH', getRules: async () => [], getNotes: async () => notes },
    'GET', '/rules', { [TOKEN_HEADER]: 'ABCD-EFGH' },
  );
  assert.equal(r.status, 200);
  assert.deepEqual((r.body as { notes: unknown }).notes, notes);
});
