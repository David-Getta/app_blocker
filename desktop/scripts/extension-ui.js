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

  // A korlátokat kimondó rész nem opcionális: enélkül a felhasználó azt hinné,
  // ez ugyanolyan erős, mint a DNS-szintű tiltás.
  const body = await page.locator('body').innerText();
  for (const must of ['vendég módban', 'inkognitóban', 'gyengébb réteg']) {
    if (!body.toLowerCase().includes(must.toLowerCase())) {
      failures.push(`a korlátokból hiányzik: ${must}`);
    }
  }

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
