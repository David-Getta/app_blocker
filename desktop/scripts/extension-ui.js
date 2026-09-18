// A bővítmény beállítási lapja — valódi böngészőben.
//
// A `storage.js` logikáját node-tesztek fedik, a LAPOT viszont addig semmi nem
// nyitotta meg. Márpedig itt egy elgépelt azonosító vagy egy be nem töltődő
// modul ugyanolyan csendes hiba, mint bármi más: a lap megjelenik, a gomb ott
// van, és nem történik semmi.
//
// Ezért a lapot tényleg betöltjük, tényleg megnyomjuk a gombokat, és
// megnézzük, mi lett belőle.
//
// Miért kell hozzá kiszolgáló: a lap ES-modult tölt be, azt pedig a Chromium
// `file://` alól nem engedi. Egy tíz soros statikus kiszolgáló megoldja.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..', 'extension');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function serve() {
  const server = http.createServer((req, res) => {
    const name = path.basename((req.url || '/').split('?')[0]) || 'options.html';
    const file = path.join(ROOT, name);
    // Csak a bővítmény mappájából szolgálunk ki, semmi mást.
    if (path.dirname(file) !== ROOT || !fs.existsSync(file)) {
      res.writeHead(404).end('nincs ilyen');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'text/plain' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** A `chrome.storage.local` helyettese, a lap betöltése ELŐTT beadva. */
const FAKE_CHROME = `
  window.__disk = {};
  window.chrome = {
    storage: { local: {
      get: async (key) => ({ [key]: window.__disk[key] }),
      set: async (obj) => { Object.assign(window.__disk, obj); },
    } },
    runtime: { getURL: (p) => p, sendMessage: async () => ({ rules: [] }) },
  };
  // Hamis app a hídon. A lap ELŐTT kerül be, tehát ugyanazon az úton megy,
  // mint élesben: a kód a fejlécben, a válasz JSON-ban.
  window.__appRules = [{ host: 'youtube.com', path: '/@appbol' }];
  window.fetch = async (url, init) => {
    // Sima összehasonlítás, nem reguláris kifejezés: ez a szöveg egy
    // sablonliterálban utazik, és ott a fordított perjelek elvesznének.
    // A MENET indítása a hídon: a hamis app feljegyzi, mit kért a lap.
    if (String(url) === 'http://127.0.0.1:8788/focus_start' && init?.method === 'POST') {
      if (init?.headers?.['x-breaker-token'] !== 'JOKOD') {
        return { ok: false, status: 401, json: async () => ({ error: 'rossz kód' }) };
      }
      window.__started = JSON.parse(init.body || '{}');
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    // A HETI ABLAK a hídon: a hamis app feljegyzi, mit kért a lap.
    if (String(url) === 'http://127.0.0.1:8788/focus_window' && init?.method === 'POST') {
      if (init?.headers?.['x-breaker-token'] !== 'JOKOD') {
        return { ok: false, status: 401, json: async () => ({ error: 'rossz kód' }) };
      }
      window.__windowed = JSON.parse(init.body || '{}');
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (String(url) !== 'http://127.0.0.1:8788/rules') throw new Error('ECONNREFUSED');
    if (init?.headers?.['x-breaker-token'] !== 'JOKOD') {
      return { ok: false, status: 401, json: async () => ({ error: 'rossz kód' }) };
    }
    return { ok: true, status: 200, json: async () => ({ protocol: 1, rules: window.__appRules }) };
  };
`;

async function main() {
  const failures = [];
  const { server, port } = await serve();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => failures.push(`hiba a lapon: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') failures.push(`konzol-hiba: ${m.text()}`);
  });
  await page.addInitScript(FAKE_CHROME);
  await page.goto(`http://127.0.0.1:${port}/options.html`);

  // A várakozás hossza a `storage.js`-ből kerül a szövegbe. Ha a modul nem
  // töltődne be, itt maradna a helyőrző — és a lap többi része működni
  // látszana.
  await page.waitForFunction(
    () => document.getElementById('delay')?.textContent?.includes('perc'),
    undefined, { timeout: 10_000 },
  );
  const delay = await page.locator('#delay').innerText();
  if (!/^\d+ perc$/.test(delay)) failures.push(`a várakozás hossza nem jött át: ${delay}`);

  // Üresen az „üres” üzenet áll ott, nem egy néma lista.
  if (await page.locator('#empty').isHidden()) {
    failures.push('üres listánál nem látszik, hogy üres');
  }

  // Egy valódi szabály felvétele.
  await page.locator('#input').fill('https://www.youtube.com/@valaki');
  await page.getByRole('button', { name: 'Tiltás' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('#list li').length === 1,
    undefined, { timeout: 10_000 },
  );
  const row = await page.locator('#list li').first().innerText();
  if (!row.includes('youtube.com/@valaki')) failures.push(`a szabály nem így néz ki: ${row}`);
  if (!(await page.locator('#empty').isHidden())) {
    failures.push('a lista már nem üres, de az üres üzenet ott maradt');
  }
  if ((await page.locator('#input').inputValue()) !== '') {
    failures.push('a mező nem ürült ki, a következő szabály mellé gépelnének');
  }

  // Szemét: mondja meg, mit vár. Csendben eldobva a felhasználó azt hinné,
  // felvette a szabályt.
  await page.locator('#input').fill('youtube.com');
  await page.getByRole('button', { name: 'Tiltás' }).click();
  await page.waitForFunction(
    () => document.getElementById('error')?.hidden === false,
    undefined, { timeout: 10_000 },
  );
  const error = await page.locator('#error').innerText();
  if (!error.includes('youtube.com/@valaki')) failures.push(`a hibaüzenet nem segít: ${error}`);
  if ((await page.locator('#list li').count()) !== 1) {
    failures.push('a hibás bevitelből mégis lett szabály');
  }

  // A levétel NEM azonnali: ez a funkció lényege.
  await page.getByRole('button', { name: 'Levétel' }).click();
  await page.waitForFunction(
    () => document.querySelector('#list li')?.textContent?.includes('Levétel'),
    undefined, { timeout: 10_000 },
  );
  const pending = await page.locator('#list li').first().innerText();
  if (!/Levétel \d+ perc múlva/.test(pending)) {
    failures.push(`a visszaszámlálás nem látszik: ${pending}`);
  }
  if (!pending.includes('addig tilt')) {
    failures.push('nem mondja meg, hogy addig még tilt');
  }
  if ((await page.locator('#list li').count()) !== 1) {
    failures.push('a szabály azonnal eltűnt — a várakozás nem érvényesült');
  }

  // Meggondolni magad ingyen van.
  await page.getByRole('button', { name: 'Mégis maradjon' }).click();
  await page.waitForFunction(
    () => !document.querySelector('#list li')?.textContent?.includes('múlva'),
    undefined, { timeout: 10_000 },
  );

  // Az appal való összekötés. Ez a funkció azon a ponton áll, ahol a részleges
  // tiltás használhatatlanná válna: ha a szabályokat kétszer kellene felvenni,
  // a két lista előbb-utóbb szétcsúszik, és mindenki azt hiszi, a másik fele is
  // tilt.
  await page.locator('#token').fill('ROSSZKOD');
  await page.getByRole('button', { name: 'Összekötés' }).click();
  await page.waitForFunction(
    () => document.getElementById('linkState')?.textContent?.includes('kód'),
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('rossz kódnál nem mondja meg, mi a baj'));

  await page.locator('#token').fill('JOKOD');
  await page.getByRole('button', { name: 'Összekötés' }).click();
  await page.waitForFunction(
    () => document.getElementById('linkState')?.textContent?.includes('Összekötve'),
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('jó kóddal sem jött létre a kapcsolat'));

  // Az app szabálya megjelenik a listában…
  await page.waitForFunction(
    () => [...document.querySelectorAll('#list li')].some(
      (li) => li.textContent.includes('youtube.com/@appbol')),
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('az app szabálya nem jelent meg a listában'));

  // …de LEVENNI nem lehet innen. Ha lehetne, a bővítmény lenne a legolcsóbb
  // kiskapu: tíz perc várakozás egy próbatétel helyett.
  const appRow = page.locator('#list li').filter({ hasText: 'youtube.com/@appbol' });
  if (await appRow.getByRole('button', { name: 'Levétel' }).count() !== 0) {
    failures.push('az appból jött szabály levehető a bővítményből');
  }
  if (!(await appRow.innerText()).includes('appból')) {
    failures.push('nem látszik, hogy ez a szabály az appból jött');
  }

  // A korlátokat kimondó rész nem opcionális: enélkül a felhasználó azt hinné,
  // ez ugyanolyan erős, mint a DNS-szintű tiltás.
  const body = await page.locator('body').innerText();
  for (const must of ['vendég módban', 'inkognitóban', 'gyengébb réteg']) {
    if (!body.toLowerCase().includes(must.toLowerCase())) {
      failures.push(`a korlátokból hiányzik: ${must}`);
    }
  }

  // A FELUGRÓ LAP. Az ikonra kattintva eddig nem történt semmi; most egy
  // pillantás: összekötve-e, fut-e munkamenet, mi van zárva — ugyanabból a
  // tárolt állapotból, ugyanazokkal a frissességi szabályokkal, mint a tiltó
  // lap. A tárolt állapotot a lap ELŐTT adjuk be (a hamis chrome után fut).
  await page.addInitScript(`
    window.__disk['breaker.applink'] = {
      token: 'JOKOD', port: 8788, rules: [{ host: 'youtube.com', path: '/@valaki' }],
      channels: [{ host: 'youtube.com', allow: ['@x'] }],
      focus: { running: true, name: 'Nyelvtanulás', endsAt: Date.now() + 42 * 60000, allowSites: ['duolingo.com'] },
      closed: [
        { host: 'youtube.com', reason: 'always', until: 0 },
        { host: 'gemini.google.com', reason: 'cooldown', until: Date.now() + 9 * 60000 },
        { host: 'lejart.example', reason: 'limit', until: Date.now() - 1000 },
      ],
      fetchedAt: Date.now(), attemptedAt: Date.now(), error: null,
    };
  `);
  await page.goto(`http://127.0.0.1:${port}/popup.html`);
  await page.waitForFunction(
    () => /Összekötve/.test(document.getElementById('state')?.textContent || ''),
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('a felugró lap nem mondja, hogy összekötve van'));
  const popupText = await page.locator('body').innerText();
  for (const must of ['Nyelvtanulás', 'gemini.google.com', 'adag-szünet', 'youtube.com', 'Részleges szabályok: 1']) {
    if (!popupText.includes(must)) failures.push(`a felugró lapról hiányzik: ${must}`);
  }
  if (popupText.includes('lejart.example')) failures.push('a lejárt zárás ott maradt a felugró lapon');
  // A Beállítások gomb tényleg a beállításokhoz visz — és a lap bezáródik.
  await page.evaluate(() => {
    window.__optionsOpened = 0;
    window.chrome.runtime.openOptionsPage = () => { window.__optionsOpened += 1; };
    window.close = () => { window.__closed = true; };
  });
  await page.getByRole('button', { name: 'Beállítások' }).click();
  const opened = await page.evaluate(() => [window.__optionsOpened, window.__closed === true]);
  if (opened[0] !== 1) failures.push('a Beállítások gomb nem nyitja a beállításokat');
  if (!opened[1]) failures.push('a Beállítások gomb után a felugró lap nyitva maradt');
  // Futó menet mellett nincs menet-gomb: egyszerre egy menet fut.
  if (!(await page.locator('#startFocus').isHidden())) failures.push('futó menet mellett is ott a menet gombja a felugró lapon');

  // EGY KATTINTÁS a felugró lapról a menetig: menet nélkül, az app javaslatával
  // a gomb az app szövegével áll, és a kattintás a hídon indít — a kóddal.
  await page.addInitScript(`
    window.__disk['breaker.applink'] = {
      token: 'JOKOD', port: 8788, rules: [], channels: [], closed: [],
      focus: { running: false },
      suggest: { packId: 'pack_2', name: 'Mély munka', minutes: 90, focusDay: true },
      fetchedAt: Date.now(), attemptedAt: Date.now(), error: null,
    };
  `);
  await page.goto(`http://127.0.0.1:${port}/popup.html`);
  // A MENET-NAP a gomb mellett: az app mondja, a lap kimondja.
  await page.waitForFunction(
    () => document.getElementById('focusDayNote')?.textContent === 'Ma a menet-napod van — ilyenkor szoktál leülni.'
      && !document.getElementById('focusDayNote')?.hidden,
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('a felugró lap nem mondja a menet-napot az app szava szerint'));
  await page.waitForFunction(
    () => document.getElementById('startFocus')?.textContent === 'Munkamenet: Mély munka, 90 perc'
      && !document.getElementById('startFocus')?.hidden,
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('a felugró lap menet-gombja nem az app javaslatát mondja'));
  await page.locator('#startFocus').click().catch(() => failures.push('a menet gombja nem kattintható'));
  await page.waitForFunction(() => window.__started && window.__started.packId === 'pack_2' && window.__started.minutes === 90,
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('a menet gombja nem a hídon indított, a javasolt csomaggal és perccel'));

  // A TILTÓ LAPON is: ugyanaz a gomb a kísértés pillanatában — a kattintás a
  // hídon indít, a lap kimondja, hogy elindult, és a gomb eltűnik.
  await page.goto(`http://127.0.0.1:${port}/blocked.html?rule=youtube.com/@valaki&from=https://youtube.com/@valaki`);
  await page.waitForFunction(
    () => document.getElementById('startFocus')?.textContent === 'Munkamenet: Mély munka, 90 perc'
      && !document.getElementById('startFocus')?.hidden,
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('a tiltó lap menet-gombja nem az app javaslatát mondja'));
  await page.evaluate(() => { window.__started = null; });
  await page.locator('#startFocus').click().catch(() => failures.push('a tiltó lap menet-gombja nem kattintható'));
  await page.waitForFunction(
    () => window.__started && window.__started.packId === 'pack_2'
      && /Elindult: Mély munka, 90 perc/.test(document.getElementById('startFocusNote')?.textContent || '')
      && document.getElementById('startFocus')?.hidden === true,
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('a tiltó lap menet-gombja nem a hídon indított, vagy nem mondta ki, hogy elindult'));

  // ABLAK A CSÚCS-ÓRÁRA a felugró lapról: az app csúcs-órájával a gomb a
  // sávot mondja, a kattintás a hídon teszi fel — a kóddal —, és a sor kimondja.
  await page.addInitScript(`
    window.__disk['breaker.applink'] = {
      token: 'JOKOD', port: 8788, rules: [], channels: [], closed: [],
      focus: { running: false },
      suggest: { packId: 'pack_2', name: 'Mély munka', minutes: 90, peakHour: 21, focusDay: true },
      fetchedAt: Date.now(), attemptedAt: Date.now(), error: null,
    };
  `);
  await page.goto(`http://127.0.0.1:${port}/popup.html`);
  await page.waitForFunction(
    () => document.getElementById('peakWindow')?.textContent === 'Heti ablak a csúcs-órára: Mély munka, minden nap 21:00–22:00'
      && !document.getElementById('peakWindow')?.hidden,
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('a felugró lap ablak-gombja nem az app csúcs-óráját mondja'));
  await page.locator('#peakWindow').click().catch(() => failures.push('az ablak gombja nem kattintható'));
  await page.waitForFunction(
    () => window.__windowed && window.__windowed.packId === 'pack_2' && window.__windowed.hour === 21
      && /Megvan: minden nap 21:00–22:00/.test(document.getElementById('peakWindowNote')?.textContent || ''),
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('az ablak gombja nem a hídon tett ablakot, vagy nem mondta ki, hogy megvan'));

  // A TILTÓ LAPON is: ugyanaz a gomb a kísértés pillanatában — a kattintás a
  // hídon teszi fel, a lap kimondja, és a gomb eltűnik.
  await page.goto(`http://127.0.0.1:${port}/blocked.html?rule=youtube.com/@valaki&from=https://youtube.com/@valaki`);
  await page.waitForFunction(
    () => document.getElementById('peakWindow')?.textContent === 'Heti ablak a csúcs-órára: Mély munka, minden nap 21:00–22:00'
      && !document.getElementById('peakWindow')?.hidden,
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('a tiltó lap ablak-gombja nem az app csúcs-óráját mondja'));
  // A MENET-NAP a tiltó lapon is, a gomb mellett.
  await page.waitForFunction(
    () => document.getElementById('focusDayNote')?.textContent === 'Ma a menet-napod van — ilyenkor szoktál leülni.'
      && !document.getElementById('focusDayNote')?.hidden,
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('a tiltó lap nem mondja a menet-napot az app szava szerint'));
  await page.evaluate(() => { window.__windowed = null; });
  await page.locator('#peakWindow').click().catch(() => failures.push('a tiltó lap ablak-gombja nem kattintható'));
  await page.waitForFunction(
    () => window.__windowed && window.__windowed.packId === 'pack_2' && window.__windowed.hour === 21
      && /Megvan: minden nap 21:00–22:00/.test(document.getElementById('peakWindowNote')?.textContent || '')
      && document.getElementById('peakWindow')?.hidden === true,
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('a tiltó lap ablak-gombja nem a hídon tett ablakot, vagy nem mondta ki, hogy megvan'));

  await browser.close();
  server.close();

  if (failures.length) {
    console.error('Bővítmény-füstteszt HIBA:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('Bővítmény-füstteszt OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
