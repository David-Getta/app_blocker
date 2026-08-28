// Bővítmény-füstteszt: VALÓDI Chromium, a VALÓDI bővítmény betöltve.
//
// A bővítmény minden más tesztje a magokat futtatja (channels.js, storage.js)
// — de a content.js + background.js + manifest hármas csak egy igazi
// böngészőben áll össze: a web_accessible_resources nélkül az import némán
// hal meg, egy rossz üzenet-típusnál a válasz sosem jön meg, és mindkettő
// úgy nézne ki, mintha „csak épp nem tiltana”. Pont az a hibafajta, amit
// szem nélkül senki nem venne észre.
//
// A teszt egy helyi kamu videó-oldalt szolgál ki, és a bővítménybe egy
// előre beültetett csatorna-szűrővel (127.0.0.1, engedélyezve: @jo) végigmegy
// a rétegeken:
//
//   1. hírfolyam: a nem engedélyezett csatorna VIDEÓKÁRTYÁJA eltűnik; a
//      komment és az egész polc nem — azok nem kártyák;
//   2. lejátszó-oldal: a lap metaadata (JSON-LD, mikroadat, beágyazott
//      lejátszó-adat) alapján a rossz feltöltő videója tiltó lapra fut;
//   3. elavulás-őr: a MÁSIK videót megnevező metaadat nem tilt; egylapos
//      váltásnál a frissített metaadat viszont igen;
//   4. a címből döntő régi réteg (csatorna-lap) továbbra is fog.
//
// Futtatás: node scripts/extension-e2e.js
// A hibákat GYŰJTI és a végén sorolja fel — egy elhasalt eset nem nyeli le a
// többi eredményét.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const EXT = path.join(__dirname, '..', '..', 'extension');

/** A beültetett kapocs: szűrő a 127.0.0.1-re, @jo engedélyezve, egy szabály. */
const LINK = {
  token: null, // kód nélkül a bővítmény nem keresi az appot — a beültetés marad
  port: null,
  rules: [{ host: '127.0.0.1', path: '/tiltott' }],
  focus: { running: false },
  channels: [{ host: '127.0.0.1', allow: ['@jo'] }],
  fetchedAt: Date.now(),
  attemptedAt: Date.now(),
  error: null,
};

function html(body) {
  return ['<!doctype html><html lang="hu"><head><meta charset="utf-8">',
    '<title>kamu videó-oldal</title></head><body>', body, '</body></html>'].join('');
}

/** Az oldalak. A `base` a saját teljes címünk — a metaadat abszolút címeihez. */
function pages(base) {
  const ld = (id, author) => '<script type="application/ld+json">' + JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: 'Videó',
    embedUrl: `${base}/embed/${id}`,
    author: { '@type': 'Person', name: 'Valaki', url: `${base}${author}` },
  }) + '</script>';
  return {
    '/': html([
      '<h1>Hírfolyam</h1>',
      '<article id="cardRossz"><a href="/@rossz">Rossz</a> <a href="/watch?v=rosszvid11">v</a></article>',
      '<article id="cardJo"><a href="/@jo">Jó</a> <a href="/watch?v=jovid11111">v</a></article>',
      '<article id="cardRule"><a href="/tiltott/resz">tiltott rész</a></article>',
      '<div id="komment"><a href="/@kommentelo">kommentelő</a> — jó videó volt</div>',
      '<div id="polc"><a href="/@rossz">rossz</a> <a href="/watch?v=polcvid111">1</a>',
      ' <a href="/watch?v=polcvid222">2</a> <a href="/watch?v=polcvid333">3</a></div>',
    ].join('')),
    '/watch?v=badvid12345': html(ld('badvid12345', '/@rossz') + '<p>lejátszó</p>'),
    '/watch?v=goodvid1234': html(ld('goodvid1234', '/@jo') + '<p id="jatszo">lejátszó</p>'),
    // Az elavult metaadat: a lap MÁSIK videót nevez meg — erről nem szabad ítélni.
    '/watch?v=stale123456': html(ld('elozovid999', '/@rossz') + '<p>lejátszó</p>'),
    // Lapos mikroadat, YouTube-fejléc módra: nincs VideoObject-doboz, a
    // videoId meta bizonyítja, hogy a blokk a mostani videóról szól.
    '/watch?v=flat1234567': html([
      '<meta itemprop="videoId" content="flat1234567">',
      '<span itemprop="author" itemscope itemtype="https://schema.org/Person">',
      '<link itemprop="url" href="/@rossz"></span><p>lejátszó</p>',
    ].join('')),
    // A lejátszó beágyazott adata, ahogy a nagy oldalak írják: escape-elt
    // perjelekkel. Más forrás ezen a lapon nincs.
    '/watch?v=player12345': html([
      '<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"player12345"},',
      '"microformat":{"playerMicroformatRenderer":{"ownerProfileUrl":"',
      base.replace(/\//g, '\\/'), '\\/@rossz"}}};</script><p>lejátszó</p>',
    ].join('')),
    '/@rossz': html('<h1>Rossz csatorna oldala</h1>'),
    '/@jo': html('<h1 id="joCsatorna">Jó csatorna oldala</h1>'),
  };
}

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const body = pages(base)[req.url || '/'];
      if (!body) { res.statusCode = 404; res.end('nincs ilyen lap'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  let chromium;
  for (const spec of ['playwright', 'playwright-core']) {
    try { ({ chromium } = require(spec)); break; } catch { /* a következő */ }
  }
  if (!chromium) {
    console.error('nincs playwright — a bővítmény-füstteszt nem tud futni');
    process.exit(1);
  }

  const { server, port } = await serve();
  const base = `http://127.0.0.1:${port}`;
  const profile = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'breaker-ext-e2e-'));
  // A bővítményhez TELJES Chromium kell (channel), a fejnélküli héj nem tölt
  // bővítményt — és hibát sem szólna, csak üresen futna minden.
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  const failures = [];
  const check = (ok, name) => { if (!ok) failures.push(name); console.log(`${ok ? 'OK ' : 'HIBA'} ${name}`); };

  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
    // A beültetés a bővítmény SAJÁT lapján át megy: a szolgáltatás-worker
    // evaluate-környezetében a fejnélküli Chromium nem adja oda a bővítmény-
    // API-kat, a beállítás-lap viszont teljes jogú — és útközben azt is
    // bizonyítja, hogy a lap egyáltalán betölt.
    const extId = new URL(sw.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    await page.evaluate((link) => chrome.storage.local.set({ 'breaker.applink': link }), LINK);

    // ------------------------------------------------ 1. hírfolyam-rejtés
    await page.goto(`${base}/`);
    const hidden = await page.waitForSelector('#cardRossz', { state: 'hidden', timeout: 8000 })
      .then(() => true).catch(() => false);
    check(hidden, 'a nem engedélyezett csatorna videókártyája eltűnik');
    const ruleHidden = await page.waitForSelector('#cardRule', { state: 'hidden', timeout: 8000 })
      .then(() => true).catch(() => false);
    check(ruleHidden, 'a részleges szabály kártyája továbbra is eltűnik');
    // A többinek LÁTHATÓNAK kell maradnia. Ez pont fordítva bizonyít, mint a
    // rejtés: itt a türelmetlenség hamis zöldet adna, ezért a rejtések UTÁN
    // nézzük, amikor a szkript már bizonyítottan lefutott.
    check(await page.isVisible('#cardJo'), 'az engedélyezett csatorna kártyája marad');
    check(await page.isVisible('#komment'), 'a komment nem videókártya — marad');
    check(await page.isVisible('#polc'), 'az egész polcot egy link nem tüntetheti el');

    // --------------------------------------- 2. lejátszó-oldal, forrásonként
    for (const [caseUrl, name] of [
      [`${base}/watch?v=badvid12345`, 'JSON-LD: a rossz feltöltő videója tiltó lapra fut'],
      [`${base}/watch?v=flat1234567`, 'lapos mikroadat: a rossz feltöltő videója tiltó lapra fut'],
      [`${base}/watch?v=player12345`, 'beágyazott lejátszó-adat: a rossz feltöltő videója tiltó lapra fut'],
    ]) {
      await page.goto(caseUrl);
      const blocked = await page.waitForURL(/blocked\.html/, { timeout: 8000 })
        .then(() => true).catch(() => false);
      check(blocked, name);
      if (blocked) {
        const text = await page.evaluate(() => document.body.innerText);
        check(text.includes('@rossz') && text.includes('töltötte fel'),
          `${name} — a tiltó lap megnevezi a kulcsot és a feltöltőt`);
      }
    }

    // ------------------------------------------- 3. ami NEM tilthat, az nem
    // A pozitív esetek után jövünk: a gépezet bizonyítottan él, tehát ha itt
    // nem történik semmi, az tényleg döntés, nem döglött szkript.
    for (const [caseUrl, name] of [
      [`${base}/watch?v=goodvid1234`, 'az engedélyezett feltöltő videója marad'],
      [`${base}/watch?v=stale123456`, 'a MÁSIK videót megnevező (elavult) metaadat nem tilt'],
    ]) {
      await page.goto(caseUrl);
      await page.waitForTimeout(1200); // szerző-ellenőrzés 250 ms-onként fut
      check(page.url() === caseUrl, name);
    }

    // --------------------------- 4. egylapos váltás: a friss metaadat dönt
    await page.goto(`${base}/watch?v=goodvid1234`);
    await page.waitForTimeout(600);
    await page.evaluate((b) => {
      history.pushState({}, '', '/watch?v=spavid12345');
      const s = document.querySelector('script[type="application/ld+json"]');
      s.textContent = JSON.stringify({
        '@context': 'https://schema.org', '@type': 'VideoObject', name: 'SPA',
        embedUrl: `${b}/embed/spavid12345`,
        author: { '@type': 'Person', name: 'Rossz', url: `${b}/@rossz` },
      });
    }, base);
    const spaBlocked = await page.waitForURL(/blocked\.html/, { timeout: 8000 })
      .then(() => true).catch(() => false);
    check(spaBlocked, 'egylapos váltásnál a frissült metaadat alapján tilt');

    // ------------------------------------ 5. a címből döntő réteg is él még
    await page.goto(`${base}/@rossz`).catch(() => { /* a navigációt elkapja a tiltás */ });
    const urlBlocked = await page.waitForURL(/blocked\.html/, { timeout: 8000 })
      .then(() => true).catch(() => false);
    check(urlBlocked, 'a csatorna-lap címről tiltódik (régi réteg)');
    if (urlBlocked) {
      check(!page.url().includes('by=video'),
        'a címből jött tiltás nem hivatkozik a feltöltőre');
    }
    await page.goto(`${base}/@jo`).catch(() => {});
    await page.waitForTimeout(400);
    const joVisible = await page.isVisible('#joCsatorna').catch(() => false);
    check(joVisible, 'az engedélyezett csatorna lapja megnyílik');
  } finally {
    await context.close().catch(() => {});
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} hiba:`);
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
  console.log('\na bővítmény-füstteszt zöld');
}

main().catch((err) => {
  console.error('a bővítmény-füstteszt elhasalt:', err);
  process.exit(1);
});
