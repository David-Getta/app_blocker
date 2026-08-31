// Bővítmény-füstteszt: VALÓDI Chromium, a VALÓDI bővítmény betöltve.
//
// A bővítmény minden más tesztje a magokat futtatja (channels.js, storage.js)
// — de a content.js + background.js + manifest hármas csak egy igazi
// böngészőben áll össze: a web_accessible_resources nélkül az import némán
// hal meg, egy rossz üzenet-típusnál a válasz sosem jön meg, és mindkettő
// úgy nézne ki, mintha „csak épp nem tiltana”. Pont az a hibafajta, amit
// szem nélkül senki nem venne észre.
//
// A teszt egy helyi kamu videó-oldalt szolgál ki, és egy beültetett
// csatorna-szűrővel (127.0.0.1, engedélyezve: @jo) végigmegy a rétegeken:
//
//   0. a szűrő MENET KÖZBEN érkezik: a nyitott lapon újratöltés nélkül
//      kezd rejteni (a tár-figyelő útvonala);
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

  // Bő keret: a CI futója lassabb és ingadozóbb, mint egy fejlesztői gép,
  // és egy terhelési tüske miatt piros őr rosszabb, mint egy lassabb zöld.
  const WAIT_MS = 15000;
  const failures = [];
  const check = (ok, name) => { if (!ok) failures.push(name); console.log(`${ok ? 'OK ' : 'HIBA'} ${name}`); };

  /**
   * A BÖNGÉSZŐ szerinti aktuális cím — nem a Playwrighté.
   *
   * Amikor a háttér `tabs.update`-je egy még folyamatban lévő navigációt
   * szakít meg (pont ezt csinálja a tiltás), a Playwright lap-követése el
   * tudja veszíteni a keretet: a `page.url()` a megszakított címen ragad,
   * miközben a böngésző rég a tiltó lapon áll. A stressz-futások minden
   * bukásában ez volt a kép — a navigációs előzmények aktuális bejegyzése
   * a tiltó lap volt, a `page.url()` nem. Ezért a döntő szó az előzményeké.
   */
  async function browserUrl(page, context) {
    const view = page.url();
    let cdp = null;
    try {
      cdp = await context.newCDPSession(page);
      const h = await cdp.send('Page.getNavigationHistory');
      return h.entries[h.currentIndex]?.url ?? view;
    } catch {
      return view; // ha a CDP nem elérhető, marad a Playwright nézete
    } finally {
      if (cdp) await cdp.detach().catch(() => {});
    }
  }

  /** Megvárja, hogy a böngésző a mintára illő címen álljon; a címet adja vissza. */
  async function waitForBrowserUrl(page, context, re, ms) {
    const t0 = Date.now();
    for (;;) {
      const view = page.url();
      if (re.test(view)) return view;
      const real = await browserUrl(page, context);
      if (re.test(real)) return real;
      if (Date.now() - t0 >= ms) return null;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
    // A beültetés a bővítmény SAJÁT lapján át megy: a szolgáltatás-worker
    // evaluate-környezetében a fejnélküli Chromium nem adja oda a bővítmény-
    // API-kat, a beállítás-lap viszont teljes jogú — és útközben azt is
    // bizonyítja, hogy a lap egyáltalán betölt.
    const extId = new URL(sw.url()).host;
    const seeder = await context.newPage();
    await seeder.goto(`chrome-extension://${extId}/options.html`);

    const page = await context.newPage();

    // ------------------------------------- 0. a szűrő menet közben érkezik
    // Nyitva lévő lapon kapcsolják be a szűrőt: a kártyának újratöltés
    // NÉLKÜL kell eltűnnie. E nélkül egy régóta nyitott lap a betöltéskori
    // (üres) állapotot őrizné a lap élete végéig.
    await page.goto(`${base}/`);
    await page.waitForTimeout(600);
    check(await page.isVisible('#cardRossz'), 'szűrő nélkül a kártya látszik');
    await seeder.evaluate((link) => chrome.storage.local.set({ 'breaker.applink': link }), LINK);
    const liveHidden = await page.waitForSelector('#cardRossz', { state: 'hidden', timeout: WAIT_MS })
      .then(() => true).catch(() => false);
    check(liveHidden, 'a menet közben bekapcsolt szűrő újratöltés nélkül is rejt');

    // ------------------------------------------------ 1. hírfolyam-rejtés
    await page.goto(`${base}/`);
    const hidden = await page.waitForSelector('#cardRossz', { state: 'hidden', timeout: WAIT_MS })
      .then(() => true).catch(() => false);
    check(hidden, 'a nem engedélyezett csatorna videókártyája eltűnik');
    const ruleHidden = await page.waitForSelector('#cardRule', { state: 'hidden', timeout: WAIT_MS })
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
      const blocked = await waitForBrowserUrl(page, context, /blocked\.html/, WAIT_MS);
      check(!!blocked, name);
      if (blocked && /blocked\.html/.test(page.url())) {
        const text = await page.evaluate(() => document.body.innerText);
        check(text.includes('@rossz') && text.includes('töltötte fel'),
          `${name} — a tiltó lap megnevezi a kulcsot és a feltöltőt`);
      } else if (blocked) {
        // A böngésző a tiltó lapon áll, de a Playwright nézete leszakadt —
        // a szövegig ilyenkor nem érünk el. A cím paraméterei attól még
        // igazolják, mit ír ki a lap.
        check(blocked.includes('channel=%40rossz'),
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
      // A böngésző szerinti címet nézzük: a Playwright nézete beragadhat a
      // navigáció-versenynél, és egy TÉVES tiltást is eltakarna.
      check(await browserUrl(page, context) === caseUrl, name);
    }

    // ----------------------- 3,5. a csatorna-idő gyűlik, és meg is jelenik
    // Az engedélyezett feltöltő lapján mérünk: a lap előtérben van, a
    // csatorna azonosított — a másodperceknek gyűlniük kell. A kiírást a lap
    // elrejtése váltja ki (láthatóság-váltás), mert a valóságban is az.
    await page.goto(`${base}/watch?v=goodvid1234`);
    await page.bringToFront();
    await page.waitForTimeout(3500);
    await seeder.bringToFront();
    await page.waitForTimeout(500);
    const timeState = await seeder.evaluate(async () => {
      const got = await chrome.storage.local.get('breaker.chantime');
      return JSON.stringify(got['breaker.chantime'] ?? {});
    });
    const measured = timeState.includes('@jo');
    check(measured, 'a csatorna-idő gyűlik az engedélyezett csatorna lapján');
    if (!measured) console.log(`   (a mért állapot: ${timeState})`);
    await seeder.reload();
    await seeder.waitForTimeout(400);
    const optText = await seeder.evaluate(() => document.body.innerText);
    check(optText.includes('Melyik csatorna vitte az időt?') && optText.includes('@jo'),
      'a beállítás-lap mutatja a csatorna-időt');
    await page.bringToFront();

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
    const spaBlocked = await waitForBrowserUrl(page, context, /blocked\.html/, WAIT_MS);
    check(!!spaBlocked, 'egylapos váltásnál a frissült metaadat alapján tilt');

    // ------------------------------------ 5. a címből döntő réteg is él még
    // Előbb el a tiltó lapról: a /@rossz navigációt a háttér még commit
    // előtt átirányítja, tehát ha a lap egy KORÁBBI blocked.html-en állna,
    // a várakozás arra mondana igazat — a régi címre, a régi paraméterekkel.
    await page.goto(`${base}/`);
    await page.goto(`${base}/@rossz`).catch(() => { /* a navigációt elkapja a tiltás */ });
    const urlBlocked = await waitForBrowserUrl(page, context, /blocked\.html/, WAIT_MS);
    if (!urlBlocked) {
      // Hibánál mondja el magát: hol állt a lap, és él-e egyáltalán a háttér
      // — a kettő különbsége választja szét az elveszett eseményt a halott
      // workertől.
      console.log(`   (a lap itt állt: ${page.url()})`);
      const bg = await seeder.evaluate(
        () => chrome.runtime.sendMessage({ type: 'breaker:active-rules' })
          .then((a) => `él, ${a?.rules?.length ?? '?'} szabály, ${a?.channels?.length ?? '?'} szűrő`)
          .catch((e) => `nem válaszol: ${e}`),
      ).catch((e) => `a beállítás-lap sem válaszol: ${e}`);
      console.log(`   (a háttér: ${bg})`);
      const tr = await sw.evaluate(() => (self.__breakerTrace ?? ['üres nyom']).slice(-15).join('\n'))
        .catch((e) => `nyom nem olvasható: ${e}`);
      console.log(`   (a háttér nyoma:\n${tr})`);
      // A navigációs előzmények döntik el, KI nyert: ha a tiltó lap benne
      // van, csak épp nem ő az utolsó, akkor két navigáció versenyzett, és a
      // goto-é ért célba később.
      const hist = await context.newCDPSession(page)
        .then((cdp) => cdp.send('Page.getNavigationHistory'))
        .then((h) => h.entries.map((e, i) => `${i === h.currentIndex ? '>' : ' '} ${e.url}`).join('\n'))
        .catch((e) => `nem olvasható: ${e}`);
      console.log(`   (előzmények:\n${hist})`);
    }
    check(!!urlBlocked, 'a csatorna-lap címről tiltódik (régi réteg)');
    if (urlBlocked) {
      check(!urlBlocked.includes('by=video'),
        'a címből jött tiltás nem hivatkozik a feltöltőre');
    }
    await page.goto(`${base}/@jo`).catch(() => {});
    await page.waitForTimeout(400);
    const joVisible = await page.isVisible('#joCsatorna').catch(() => false);
    check(joVisible, 'az engedélyezett csatorna lapja megnyílik');

    // --------------------------------- 6. az egészében zárt oldal tiltó lapja
    // A segéd „zárva” listája: az egész hosztnévre szól, és a bővítmény a
    // nyers DNS-hibalap HELYETT a saját lapját mutatja — okkal, lejárattal.
    // A magyarázat csak friss listából beszélhet, ezért a beültetés mindig a
    // fetchedAt-tal együtt megy.
    const seedClosed = (closed, fetchedAt) => seeder.evaluate(
      (arg) => chrome.storage.local.set({
        'breaker.applink': { ...arg.link, closed: arg.closed, fetchedAt: arg.fetchedAt },
      }),
      { link: LINK, closed, fetchedAt },
    );
    await seedClosed([{ host: '127.0.0.1', reason: 'cooldown', until: Date.now() + 600_000 }],
      Date.now());
    await page.goto(`${base}/`).catch(() => { /* a navigációt elkapja a tiltás */ });
    const closedBlocked = await waitForBrowserUrl(
      page, context, /blocked\.html\?.*closedReason=cooldown/, WAIT_MS,
    );
    check(!!closedBlocked, 'a hűtés alatt álló oldal a tiltó lapra fut, okkal');
    if (closedBlocked && /blocked\.html/.test(page.url())) {
      const text = await page.evaluate(() => document.body.innerText);
      check(text.includes('Adag betelt') && text.includes('Újranyílik'),
        'a tiltó lap adag-nyelven magyaráz és visszaszámol');
    } else if (closedBlocked) {
      // A Playwright nézete leszakadt — a cím paraméterei igazolnak.
      check(closedBlocked.includes('until='),
        'a tiltó lap adag-nyelven magyaráz és visszaszámol');
    }

    // A szünet LETELTEKOR a lap utat ad vissza: a visszaszámláló helyén link
    // az eredeti címre. A lap magától nem navigál — a linken át a döntés
    // úgyis újra lefut, tehát egy közben újraindult hűtés vissza is fogná.
    const backUntil = Date.now() + 4000; // elég hosszú, hogy a döntés még hűtésben érje
    await seedClosed([{ host: '127.0.0.1', reason: 'cooldown', until: backUntil }], Date.now());
    await page.goto(`${base}/watch?v=goodvid1234`).catch(() => { /* elkapja a tiltás */ });
    const shortBlocked = await waitForBrowserUrl(page, context, /blocked\.html\?.*closedReason=/, WAIT_MS);
    check(!!shortBlocked, 'a rövid hűtés is tiltó lapra fut');
    if (shortBlocked && /blocked\.html/.test(page.url())) {
      // Megvárjuk a lejáratot, aztán újratöltünk: a lap 30 mp-enként festene
      // át, de a betöltéskori ELSŐ festés is dönt — az újratöltés után a link
      // már ott kell legyen, a paraméterben vitt EREDETI címmel.
      await page.waitForTimeout(Math.max(0, backUntil - Date.now()) + 300);
      await page.reload().catch(() => {});
      await page.waitForTimeout(400);
      const back = await page.evaluate(() => {
        const a = document.getElementById('closedBackLink');
        const p = document.getElementById('closedBack');
        return p && a ? { hidden: p.hidden, href: a.href } : null;
      }).catch(() => null);
      check(!!back && back.hidden === false && back.href === `${base}/watch?v=goodvid1234`,
        'a szünet leteltekor a lap visszautat ad az eredeti címre');
    }

    // A LEJÁRT hűtés nem tilt: a DNS már kinyitott, a lapnak hallgatnia kell —
    // akkor is, ha a bejegyzés még ott ül a tárban.
    await seedClosed([{ host: '127.0.0.1', reason: 'cooldown', until: Date.now() - 1000 }],
      Date.now());
    await page.goto(`${base}/`);
    await page.waitForTimeout(1200);
    check((await browserUrl(page, context)) === `${base}/`, 'a lejárt hűtés nem tilt tovább');

    // Az ELAVULT lista egészében néma — a lejárat nélküli zárás is. Az app
    // zárva volt közben: bármi történhetett (megváltott feloldás, levett
    // tiltás), a tiltást pedig úgyis a DNS tartja.
    await seedClosed([{ host: '127.0.0.1', reason: 'always', until: 0 }],
      Date.now() - 10 * 60_000);
    await page.goto(`${base}/`);
    await page.waitForTimeout(1200);
    check((await browserUrl(page, context)) === `${base}/`, 'az elavult zárva-lista nem tilt');
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
