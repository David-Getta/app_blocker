// A letöltőoldal füstteszt + képernyőkép.
//
// Az oldal a GitHub API-ból oldja fel a letöltési címeket, mert a fájlnevekben
// benne van a verzió. Itt ezt a választ HAMISÍTJUK: a teszt nem függhet a
// hálózattól, és nem is a GitHub kiadásait ellenőrizzük, hanem azt, hogy az
// oldal a kapott adatból helyes felületet épít.
//
// Amit elkap, és semmi más nem: elrontott `download.js` (a lap üresen marad
// vagy hibára fut), hiányzó platform-kártya, elveszett letöltési link.
//
//   node scripts/website-shot.js          -> képernyőkép is
//   node scripts/website-shot.js --check  -> csak ellenőrzés

const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const SITE = path.join(ROOT, 'website');
const OUT = path.join(ROOT, 'docs', 'images');
const CHECK_ONLY = process.argv.includes('--check');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

function serve() {
  const server = http.createServer((req, res) => {
    const name = path.basename((req.url || '/').split('?')[0]) || 'index.html';
    const file = path.join(SITE, name === '/' ? 'index.html' : name);
    if (path.dirname(file) !== SITE || !fs.existsSync(file)) {
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

/** Egy valósághű kiadás, a v0.3.5 tényleges fájlnevei alapján. */
const FAKE_RELEASE = {
  tag_name: 'v0.3.5',
  assets: [
    { name: 'Breaker-0.3.5-arm64.dmg', browser_download_url: 'https://example.test/arm64.dmg' },
    { name: 'Breaker-0.3.5.dmg', browser_download_url: 'https://example.test/intel.dmg' },
    { name: 'Breaker-Setup-0.3.5.exe', browser_download_url: 'https://example.test/setup.exe' },
    { name: 'Breaker-v0.3.5.apk', browser_download_url: 'https://example.test/app.apk' },
    { name: 'Breaker-v0.3.5.aab', browser_download_url: 'https://example.test/app.aab' },
    { name: 'Breaker-bovitmeny-v0.3.5.zip', browser_download_url: 'https://example.test/ext.zip' },
    { name: 'Breaker-0.3.5-mac.zip', browser_download_url: 'https://example.test/mac.zip' },
    { name: 'latest.yml', browser_download_url: 'https://example.test/latest.yml' },
  ],
};

async function main() {
  const failures = [];
  const { server, port } = await serve();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => failures.push(`hiba a lapon: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') failures.push(`konzol-hiba: ${m.text()}`);
  });

  await page.addInitScript((release) => {
    // Windowsnak adjuk ki magunkat, hogy az elsődleges kártya determinisztikus
    // legyen — enélkül a futtató gépétől függene, mit fotózunk.
    Object.defineProperty(navigator, 'userAgent', {
      get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });
    window.fetch = async () => ({ ok: true, json: async () => release });
  }, FAKE_RELEASE);

  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(
    () => document.querySelectorAll('#grid .card').length > 0,
    undefined, { timeout: 15_000 },
  ).catch(() => failures.push('a platformlista üres maradt — a download.js elhasalt'));

  const text = (await page.locator('body').innerText()) || '';
  for (const want of ['Breaker', 'Windows', 'macOS', 'Android', 'iPhone', 'Böngésző']) {
    if (!text.includes(want)) failures.push(`hiányzik a lapról: ${want}`);
  }
  // Az elsődleges kártya a felismert rendszerre szól, és VAN benne letöltés.
  const primary = (await page.locator('#primary').innerText()) || '';
  if (!primary.includes('Windows')) failures.push(`az elsődleges kártya nem Windows: ${primary}`);
  if (!primary.includes('v0.3.5')) failures.push('az elsődleges kártya nem mondja meg a verziót');
  const href = await page.locator('#primary a.btn').first().getAttribute('href');
  if (href !== 'https://example.test/setup.exe') failures.push(`rossz letöltési cím: ${href}`);

  // Az emoji-mentesség nem szőrözés: az emoji minden rendszeren máshogy néz ki,
  // és egy terméklapon a rendszer betűkészletétől függő rajz nem márka.
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) {
    failures.push('emoji maradt a lapon');
  }
  // A bővítmény külön kártyát kap, a nyers fájlnév helyett érthető felirattal.
  if (!text.includes('kicsomagolva betöltendő')) {
    failures.push('a bővítmény nem kapott saját, érthető feliratot');
  }

  if (!CHECK_ONLY) {
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, 'website.png'), fullPage: true });
  }

  await browser.close();
  server.close();

  if (failures.length) {
    console.error('Letöltőoldal-füstteszt HIBA:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(CHECK_ONLY ? 'Letöltőoldal-füstteszt OK' : `Letöltőoldal-füstteszt OK, kép: ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
