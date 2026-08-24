// Renderer smoke test + screenshot generator.
//
// Two jobs in one, because they need exactly the same setup:
//   1. It actually LOADS the built renderer and drives it. A renderer can break
//      in ways tsc never sees (a module specifier without .js, a null element
//      lookup) and then the whole window is silently blank. That failure has
//      happened twice; here it fails loudly instead.
//   2. It refreshes docs/images/*.png so the README shows the current UI.
//
// The Electron bridge (window.breaker) is replaced by an in-page fake backed by a
// small scripted state, so no helper, no root, no Electron — just Chromium.
//
// Run: node scripts/ui-shots.js            (writes docs/images, exits non-zero on any page error)
//      node scripts/ui-shots.js --check    (smoke test only, no screenshots written)

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Serve dist/ui, not dist/ui/renderer: the page imports ../shared/*.js, which
// would fall outside a root set at the renderer folder (exactly the 404 that
// blanks the window in production too).
const WEB = path.join(ROOT, 'dist', 'ui');
const OUT = path.join(ROOT, '..', 'docs', 'images');
const CHECK_ONLY = process.argv.includes('--check');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function globalPlaywrightPath() {
  try {
    const root = require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
    const p = path.join(root, 'playwright');
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

// file:// would work for the HTML but not for ES modules (CORS), so serve it.
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = (req.url || '/').split('?')[0];
      const file = path.join(WEB, rel === '/' ? 'renderer/index.html' : rel);
      if (!file.startsWith(WEB) || !fs.existsSync(file)) { res.statusCode = 404; res.end('no'); return; }
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** The scripted backend the fake bridge answers from. Kept deliberately small. */
function helperVersion() {
  // A protokollverziót a LEFORDÍTOTT forrásból olvassuk, nem másoljuk ide:
  // különben a bumpolás után a füstteszt csendben rossz értéket használna.
  const file = path.join(WEB, 'shared', 'protocol.js');
  const m = fs.readFileSync(file, 'utf8').match(/HELPER_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error(`nem található a HELPER_VERSION itt: ${file}`);
  return m[1];
}

function fakeBridgeSource() {
  return `
    const now = Date.now();
    const day = (back) => {
      const d = new Date(now); d.setHours(12,0,0,0); d.setDate(d.getDate() - back);
      const m = String(d.getMonth()+1).padStart(2,'0');
      return d.getFullYear() + '-' + m + '-' + String(d.getDate()).padStart(2,'0');
    };
    window.__fakeSites = [
      { id: 'site_1', domain: 'youtube.com', hostnames: ['youtube.com','www.youtube.com','m.youtube.com','youtu.be'],
        addedAt: now - 86400000*9, pauseUntil: null, pendingDeleteAt: null,
        dailyLimitSeconds: 1200, usedTodaySeconds: 900, usedTodayElsewhere: 420,
        limitExhausted: false, blockedNow: true },
      { id: 'site_2', domain: 'reddit.com', hostnames: ['reddit.com','www.reddit.com'],
        addedAt: now - 86400000*4, pauseUntil: null, pendingDeleteAt: null,
        schedule: { mode: 'scheduled_block', bands: [{ days: [1,2,3,4,5], startMin: 540, endMin: 1020 }] },
        usedTodaySeconds: 540, limitExhausted: false, blockedNow: true },
      { id: 'site_3', domain: 'instagram.com', hostnames: ['instagram.com','www.instagram.com'],
        addedAt: now - 86400000*2, pauseUntil: null, pendingDeleteAt: null,
        dailyLimitSeconds: 600, usedTodaySeconds: 600, limitExhausted: true, blockedNow: true },
    ];
    let session = null;
    // A GUI a saját protokollverziójához hasonlítja: a demóban EGYEZZEN, hogy a
    // képernyőképeken ne üljön ott a „régi a háttérszolgáltatás” sáv. A
    // nem-egyező esetet a füstteszt külön, szándékosan állítja elő.
    // A mérés alapból lát adatot; a „nem kap adatot” esetet a füstteszt
    // szándékosan állítja elő.
    // Munkamenet-csomagok. Egy futó munkamenet külön képernyőképet érdemel,
    // de az alap nézetben csak a lista áll ott.
    window.__fakePacks = [
      { id: 'pack_1', name: 'Nyelvtanulás', allowSites: ['translate.google.com', 'quizlet.com'],
        allowApps: ['Word'], defaultMinutes: 50 },
      { id: 'pack_2', name: 'Mély munka', allowSites: ['github.com'], allowApps: ['Code'],
        defaultMinutes: 90 },
    ];
    window.__fakeRun = null;
    window.__fakeTracker = { blocked: false, neverWorked: false, platform: 'darwin' };
    window.__fakeUpdate = { status: 'idle' };
    window.__fakeHelperVersion = ${JSON.stringify(helperVersion())};
    // A „lista elrejtése” beállítást a HÁTTÉRSZOLGÁLTATÁS tárolja, nem az ablak.
    // Itt a sessionStorage áll a helyére, hogy az újratöltés (= app-újraindítás)
    // után is megmaradjon: épp ez a beállítás lényege, tehát a teszt is csak így
    // tud róla igazat mondani.
    window.__fakeHideList = sessionStorage.getItem('fakeHideList') === '1';
    window.__fakeSync = undefined;
    const status = () => ({
      helperVersion: window.__fakeHelperVersion, platform: 'darwin',
      sites: window.__fakeSites, tier: 1, unlocks7d: 2,
      hideSiteList: window.__fakeHideList,
      sync: window.__fakeSync,
      session, dohPolicyApplied: true, usageEnabled: true, now: Date.now(),
      focusPacks: window.__fakePacks, focusRun: window.__fakeRun,
    });
    // 30 days, because that is what the helper actually sends (and what the
    // chart title claims) — a shorter demo series would make the screenshot lie.
    const series = [];
    const mins = [38,52,20,64,45,71,58,26,49,66,35,57,24,44,61,29,53,70,41,33,68,47,25,59,36,74,42,30,55,63];
    for (let i = 29; i >= 0; i--) series.push({ day: day(i), seconds: mins[29-i] * 60 });
    const t = (key, label, kind, seconds) => ({ key, label, kind, seconds });
    const stats = {
      summary: {
        enabled: true,
        todaySeconds: 3480, yesterdaySeconds: 5280, last7Seconds: 26400, last30Seconds: 98400,
        topToday: [ t('site:youtube.com','youtube.com','site',1500), t('app:com.slack','Slack','app',1080),
                    t('site:reddit.com','reddit.com','site',540), t('app:com.apple.Safari','Safari','app',360) ],
        topWeekSites: [ t('site:youtube.com','youtube.com','site',9600), t('site:reddit.com','reddit.com','site',5400),
                        t('site:news.example','news.example','site',2700), t('site:github.com','github.com','site',1800) ],
        topWeekApps: [ t('app:com.slack','Slack','app',7200), t('app:com.apple.Safari','Safari','app',4500),
                       t('app:com.microsoft.VSCode','Visual Studio Code','app',3600) ],
        weekOverWeek: [
          { key: 'site:youtube.com', label: 'youtube.com', kind: 'site', thisWeek: 9600, lastWeek: 14400, deltaPct: -33.3 },
          { key: 'app:com.slack', label: 'Slack', kind: 'app', thisWeek: 7200, lastWeek: 7000, deltaPct: 2.8 },
          { key: 'site:reddit.com', label: 'reddit.com', kind: 'site', thisWeek: 5400, lastWeek: 3600, deltaPct: 50 },
        ],
        daysTracked: 14,
      },
      focusSeries: series,
      focusLabel: 'youtube.com',
    };
    window.breaker = {
      platform: 'darwin',
      call: async (op, payload) => {
        if (op === 'status') return { ok: true, data: status() };
        if (op === 'usage_stats') return { ok: true, data: stats };
        if (op === 'start_unlock') {
          session = {
            id: 'ses_demo', kind: 'pause', siteId: payload.siteId, minutes: payload.minutes,
            stepIndex: 0, stepCount: 2,
            current: { id: 'st_1', type: 'TRANSCRIBE',
              text: 'A pillanatnyi késztetés nem parancs; a figyelmem oda megy, ahová én küldöm.' },
          };
          return { ok: true, data: session };
        }
        if (op === 'submit') {
          return { ok: true, data: { accepted: false, sessionDone: false,
            message: 'Nem egyezik karakterre pontosan. Ellenőrizd az írásjeleket és a kis-/nagybetűket.',
            session } };
        }
        if (op === 'abandon') { session = null; return { ok: true, data: {} }; }
        if (op === 'sync_devices') {
          return { ok: true, data: {
            combined: { deviceCount: 2, todaySeconds: 4680, last7Seconds: 35400, top: [
              { label: 'youtube.com', seconds: 9600 }, { label: 'Slack', seconds: 7200 },
              { label: 'reddit.com', seconds: 5400 } ] },
            devices: [
              { deviceId: 'd1', name: 'Mac gép', self: true, todaySeconds: 3480,
                last7Seconds: 26400, top: [
                  { label: 'youtube.com', seconds: 9600 }, { label: 'Slack', seconds: 7200 } ] },
              { deviceId: 'd2', name: 'Telefon', self: false, todaySeconds: 1200,
                last7Seconds: 9000, top: [{ label: 'reddit.com', seconds: 5400 }] },
            ] } };
        }
        if (op === 'set_hide_list') {
          window.__fakeHideList = payload.hidden === true;
          sessionStorage.setItem('fakeHideList', window.__fakeHideList ? '1' : '0');
          return { ok: true, data: status() };
        }
        if (op === 'focus_start') {
          window.__fakeRun = {
            packId: payload.packId, startedAt: Date.now(),
            endsAt: Date.now() + payload.minutes * 60000,
          };
          return { ok: true, data: status() };
        }
        if (op === 'focus_change') {
          // Hosszabbítás azonnal; rövidítés próbatétel — a hamis híd is így
          // viselkedik, különben a füstteszt egy nem létező utat járna.
          if (window.__fakeRun && payload.endsAt !== null
              && payload.endsAt >= window.__fakeRun.endsAt) {
            window.__fakeRun = { ...window.__fakeRun, endsAt: payload.endsAt };
            return { ok: true, data: { applied: true, session: null, status: status() } };
          }
          return { ok: true, data: { applied: false, session: null, status: status() } };
        }
        if (op === 'focus_save') {
          const pack = { ...payload.pack, id: payload.pack.id || 'pack_uj' };
          const at = window.__fakePacks.findIndex((p) => p.id === pack.id);
          if (at >= 0) window.__fakePacks[at] = pack; else window.__fakePacks.push(pack);
          return { ok: true, data: status() };
        }
        if (op === 'focus_delete') {
          window.__fakePacks = window.__fakePacks.filter((p) => p.id !== payload.packId);
          return { ok: true, data: status() };
        }
        if (op === 'set_alias') {
          const site = window.__fakeSites.find((x) => x.id === payload.siteId);
          if (site) {
            const a = (payload.alias || '').trim();
            if (a) site.alias = a; else delete site.alias;
          }
          return { ok: true, data: status() };
        }
        return { ok: true, data: {} };
      },
      install: async () => ({ ok: true }),
      checkUpdate: async () => ({ ok: true }),
      getUpdateState: async () => window.__fakeUpdate,
      getTrackerState: async () => window.__fakeTracker,
      // A füstteszt innen hajtja a frissítési sávot: ugyanaz a csatorna, amit
      // a fő folyamat használ.
      // A gépen futó kiszolgáló: a hamis híd is tud róla, hogy a füstteszt
      // láthassa a be- és kikapcsolt állapotot.
      getSyncServer: async () => window.__fakeHost || { running: false },
      getBridgeInfo: async () => window.__fakeBridge || { running: false },
      getOverlayState: async () => ({ shortcutOk: true, warnApp: window.__fakeWarn || null }),
      hideOverlay: async () => { window.__overlayHidden = true; },
      toggleOverlay: async () => {},
      startSyncServer: async () => {
        window.__fakeHost = {
          running: true,
          url: 'http://192.168.1.10:8787',
          localUrl: 'http://127.0.0.1:8787',
        };
        return window.__fakeHost;
      },
      stopSyncServer: async () => { window.__fakeHost = { running: false }; return window.__fakeHost; },
      onUpdateState: (cb) => { window.__pushUpdate = cb; },
      installUpdate: async () => { window.__installCalled = (window.__installCalled || 0) + 1; return { ok: true }; },
    };
  `;
}

async function main() {
  if (!fs.existsSync(path.join(WEB, 'renderer', 'index.html'))) {
    console.error('build first: npm run build');
    process.exit(1);
  }
  // playwright may only be installed globally on this machine
  let chromium;
  for (const spec of ['playwright', globalPlaywrightPath()]) {
    if (!spec) continue;
    try { ({ chromium } = require(spec)); break; } catch { /* try the next */ }
  }
  if (!chromium) {
    console.error('playwright is not available here; skipping UI shots');
    process.exit(0);
  }

  const { server, port } = await serve();
  const browser = await chromium.launch();
  // A témát KI KELL MONDANI. A Playwright alapértelmezése a világos, tehát
  // enélkül a „sötét” ellenőrzés is világosban futna — és a sötét téma
  // ellenőrizetlen maradna, miközben a képernyőképek is átbillennének.
  const page = await browser.newPage({
    viewport: { width: 1180, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });

  // Any page-level failure is a test failure: a blank window is exactly what
  // this script exists to catch.
  const failures = [];
  page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') failures.push(`console: ${m.text()}`); });
  page.on('requestfailed', (r) => failures.push(`request failed: ${r.url()}`));

  await page.addInitScript(fakeBridgeSource());
  await page.goto(`http://127.0.0.1:${port}/renderer/index.html`);

  // The home screen is only "up" once the status poll has painted the sites.
  await page.waitForSelector('#siteList .site-row', { timeout: 15_000 });
  const siteCount = await page.locator('#siteList .site-row').count();
  if (siteCount !== 3) failures.push(`expected 3 site rows, saw ${siteCount}`);

  // Munkamenetek: „most csak EZ mehet”. A csomagnak látszania kell, és a
  // futó munkamenetnek meg kell mondania, mennyi van hátra — enélkül a
  // funkció nem indítható és nem követhető.
  const packNames = await page.locator('#focusPacks .focus-name').allTextContents();
  if (!packNames.includes('Nyelvtanulás')) {
    failures.push(`a munkamenet-csomagok nem látszanak (${JSON.stringify(packNames)})`);
  }
  await page.evaluate(() => {
    window.__fakeRun = { packId: 'pack_1', startedAt: Date.now(), endsAt: Date.now() + 42 * 60_000 };
  });
  await page.waitForFunction(
    () => !document.getElementById('focusRunning')?.classList.contains('hidden'),
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('a futó munkamenet nem jelent meg'));
  const leftText = await page.locator('#focusRunning .focus-left').textContent().catch(() => '');
  if (!/\d+ perc/.test(leftText || '')) {
    failures.push(`a hátralévő idő nem olvasható: ${leftText}`);
  }
  await page.evaluate(() => { window.__fakeRun = null; });
  await page.waitForFunction(
    () => document.getElementById('focusRunning')?.classList.contains('hidden'),
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('a lejárt munkamenet ott maradt'));

  // A napi keret KÖZÖS az eszközök között: a mérő a teljes elhasznált időt
  // mutatja. Ki kell mondani, mennyi ment el máshol — enélkül úgy néz ki,
  // mintha az app rosszul számolna.
  // A böngésző-bővítmény összekötése: a kód a RÉSZEK párbeszédben van, mert ott
  // derül ki, hogy ehhez a funkcióhoz bővítmény kell. Ha a kód nem jelenne meg,
  // a szabályokat kétszer kellene felvenni — az appban és a bővítményben is.
  await page.evaluate(() => { window.__fakeBridge = { running: true, port: 8788, token: 'ABCD-EFGH-JKMN-PQRS' }; });
  await page.locator('#siteList .site-row').first()
    .getByRole('button', { name: /^Részek/ }).click();
  await page.waitForSelector('.modal .bridge-box .pair-code', { timeout: 10_000 })
    .catch(() => failures.push('a szabály-párbeszédben nincs bővítmény-kód'));
  const bridgeCode = await page.locator('.modal .bridge-box .pair-code').textContent()
    .catch(() => '');
  if ((bridgeCode || '').trim() !== 'ABCD-EFGH-JKMN-PQRS') {
    failures.push(`rossz bővítmény-kód a párbeszédben: ${bridgeCode}`);
  }
  await page.locator('.modal').getByRole('button', { name: /^Bezárás$/ }).click();

  const notes = await page.locator('#siteList .limit-note').allTextContents();
  if (!notes.some((t) => /másik eszközön/.test(t))) {
    failures.push(`hiányzik a „másik eszközön” sor a keret alól (${JSON.stringify(notes)})`);
  }

  await page.waitForSelector('#statTiles .tile', { timeout: 15_000 });
  const tiles = await page.locator('#statTiles .tile').count();
  if (tiles !== 4) failures.push(`expected 4 stat tiles, saw ${tiles}`);
  const bars = await page.locator('#topSites .bar-row').count();
  if (bars === 0) failures.push('the weekly top-sites chart rendered no bars');

  // the daily budget meter: one per site that has a budget
  // A sötét ág tényleg sötét-e? A világos ágnál ugyanez a mérés fut fordítva;
  // a kettő együtt zárja ki, hogy egy témát véletlenül sose nézzünk meg.
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const darkSum = (darkBg.match(/\d+/g) || []).slice(0, 3).reduce((a, b) => a + Number(b), 0);
  if (darkSum > 200) {
    failures.push(`the dark theme is not in effect, body background is ${darkBg}`);
  }

  const meters = await page.locator('.limit-meter').count();
  if (meters !== 2) failures.push(`expected 2 budget meters, saw ${meters}`);
  const spent = await page.locator('.limit-meter', { hasText: 'elfogyott' }).count();
  if (spent !== 1) failures.push('the spent budget is not called out in words');

  // Egyező protokollverziónál a figyelmeztető sáv NEM látszik...
  if (await page.locator('#helperStaleBanner:not(.hidden)').count() !== 0) {
    failures.push('the stale-helper banner shows even though the versions match');
  }
  // ...régi helpernél viszont MEGJELENIK, és meg is nevezi a két verziót.
  // Ez a frissítés utáni valós állapot: az új GUI már fut, a root démont a
  // launchd csak a következő indításkor cseréli. Ha ezt elhallgatnánk, a
  // felhasználó annyit látna, hogy a napi keret „nem csinál semmit”.
  await page.evaluate(() => { window.__fakeHelperVersion = '0.0.1-regi'; });
  await page.waitForSelector('#helperStaleBanner:not(.hidden)', { timeout: 15_000 });
  const staleText = await page.locator('#helperStaleText').textContent();
  if (!staleText || !staleText.includes('0.0.1-regi')) {
    failures.push(`the stale-helper banner does not name the running version: ${staleText}`);
  }
  await page.evaluate((v) => { window.__fakeHelperVersion = v; }, helperVersion());
  await page.waitForSelector('#helperStaleBanner', { state: 'hidden', timeout: 15_000 });

  // A mérés bekapcsolva, de a szonda nem lát semmit (macOS-en megtagadott
  // automatizálási engedély). Ezt ki KELL írni: enélkül a statisztika örökre
  // nulla, a napi keret sosem fogy, és a felület védelmet mutatna ott, ahol
  // nincs. A szövegnek meg kell mondania, hol lehet megadni az engedélyt, és
  // hogy ez a keretet is érinti.
  if (await page.locator('#usageBlocked:not(.hidden)').count() !== 0) {
    failures.push('the measurement warning shows even though the probe is fine');
  }
  await page.evaluate(() => {
    window.__fakeTracker = { blocked: true, neverWorked: true, platform: 'darwin' };
  });
  await page.waitForSelector('#usageBlocked:not(.hidden)', { timeout: 15_000 });
  const blockedText = (await page.locator('#usageBlocked').textContent()) || '';
  for (const needle of ['Automatizálás', 'napi időkeret']) {
    if (!blockedText.includes(needle)) {
      failures.push(`the measurement warning does not mention "${needle}": ${blockedText}`);
    }
  }
  await page.evaluate(() => {
    window.__fakeTracker = { blocked: false, neverWorked: false, platform: 'darwin' };
  });
  await page.waitForSelector('#usageBlocked', { state: 'hidden', timeout: 15_000 });

  // A frissítési sáv — ez a projekt egyik ígérete („egy gombnyomás”), tehát
  // nézzük meg, hogy tényleg megjelenik, egyszer indít, és hiba esetén
  // megmondja az OKOT is, nem csak azt, hogy „valami nem sikerült”.
  if (await page.locator('#updateBar:not(.hidden)').count() !== 0) {
    failures.push('the update bar shows while there is no update');
  }
  await page.evaluate(() => window.__pushUpdate({ status: 'downloading', version: '9.9.9', percent: 42 }));
  const dl = (await page.locator('#updateText').textContent()) || '';
  if (!dl.includes('42') || !dl.includes('9.9.9')) {
    failures.push(`the download progress does not name version and percent: ${dl}`);
  }
  await page.evaluate(() => window.__pushUpdate({ status: 'ready', version: '9.9.9' }));
  await page.waitForSelector('#updateBtn:not(.hidden)', { timeout: 10_000 });
  await page.locator('#updateBtn').click();
  if (!(await page.locator('#updateBtn').isDisabled())) {
    failures.push('the update button stays clickable during the swap');
  }
  await page.locator('#updateBtn').click({ force: true }).catch(() => { /* letiltva, ez a jó */ });
  const installCalls = await page.evaluate(() => window.__installCalled || 0);
  if (installCalls !== 1) failures.push(`the update was started ${installCalls} times, expected exactly 1`);

  await page.evaluate(() => window.__pushUpdate({ status: 'error', error: 'nincs írási jog' }));
  const errText = (await page.locator('#updateText').textContent()) || '';
  if (!errText.includes('nincs írási jog')) {
    failures.push(`the update error does not say why: ${errText}`);
  }
  if (await page.locator('#updateBtn').isDisabled()) {
    failures.push('the button stays disabled after a failed update, so there is no way out');
  }
  await page.evaluate(() => window.__pushUpdate({ status: 'idle' }));
  await page.waitForSelector('#updateBar', { state: 'hidden', timeout: 10_000 });

  if (!CHECK_ONLY) {
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, 'desktop-home.png'), fullPage: false });
    await page.locator('#statsCard').screenshot({ path: path.join(OUT, 'desktop-stats.png') });
  }

  // Drive the unlock flow: pause -> challenge modal with a wrong answer.
  await page.locator('#siteList .site-row').first()
    .getByRole('button', { name: /^Feloldás$/ }).click();
  await page.waitForSelector('#pauseDialog:not(.hidden)', { timeout: 10_000 });
  await page.locator('#pauseDialog button[data-minutes="30"]').click();
  await page.waitForSelector('#sessionModal:not(.hidden)', { timeout: 10_000 });
  await page.waitForSelector('#stepArea textarea', { timeout: 10_000 });

  // Pasting must not work: a whole string arriving in one input event is wiped
  // and called out. (fill() is exactly that, which makes it a free test.)
  await page.fill('#stepArea textarea', 'A pillanatnyi késztetés nem parancs; a figyelmem oda megy, ahová én küldöm.');
  await page.waitForSelector('#stepMessage:not(.hidden)', { timeout: 5_000 });
  const pasteMsg = await page.locator('#stepMessage').textContent();
  if (!/beilleszt/i.test(pasteMsg || '')) failures.push(`paste guard did not fire: ${pasteMsg}`);
  if (await page.inputValue('#stepArea textarea') !== '') failures.push('pasted text was not cleared');

  // Typed input: the live feedback marks the first differing character.
  await page.locator('#stepArea textarea').pressSequentially('A pillanatnyi kesztetes', { delay: 5 });
  await page.waitForSelector('.live-feedback.bad', { timeout: 5_000 });
  await page.locator('.step-submit').click();
  await page.waitForSelector('#stepMessage:not(.hidden)', { timeout: 10_000 });
  if (!CHECK_ONLY) {
    await page.screenshot({ path: path.join(OUT, 'desktop-challenge.png'), fullPage: false });
  }

  // Back out, then the schedule editor: the other flow with real friction rules.
  await page.getByRole('button', { name: /Feladom/ }).click();
  await page.waitForSelector('#sessionModal.hidden', { state: 'attached', timeout: 10_000 });
  await page.locator('#siteList .site-row').first()
    .getByRole('button', { name: /Menetrend/ }).click();
  // the editor is built on the fly (no id), so anchor on its heading
  await page.getByRole('heading', { name: /Menetrend:/ }).waitFor({ timeout: 10_000 });
  if (!CHECK_ONLY) {
    await page.screenshot({ path: path.join(OUT, 'desktop-schedule.png'), fullPage: false });
  }

  // --------------------------------------------------------------- fedőnév
  //
  // A lista maga is ingerforrás, ezért lehet a címet fedőnév mögé tenni. A
  // funkció akkor ér valamit, ha SEHOL nem szivárog ki a valódi cím — elég
  // egyetlen hely, és az egész kidobható. Ezért nem csak a sort nézzük, hanem
  // a statisztikát is, ahol a segéd a valódi domaint küldi címkeként.
  // Az előző lépés menetrend-szerkesztője még nyitva van, és elfogná a
  // kattintást; csukjuk be.
  await page.getByRole('button', { name: /^Mégse$/ }).click().catch(() => { /* már zárva */ });
  await page.locator('#siteList .site-row').first()
    .getByRole('button', { name: /^Fedőnév$/ }).click();
  await page.getByRole('heading', { name: /Név elrejtése:/ }).waitFor({ timeout: 10_000 });
  await page.locator('.alias-input').fill('A videós');
  await page.getByRole('button', { name: /^Mentés$/ }).click();
  await page.waitForFunction(
    () => (document.querySelector('#siteList .site-row .site-domain') || {}).textContent
      ?.includes('A videós'),
    undefined, { timeout: 10_000 },
  );

  const listText = (await page.locator('#siteList').textContent()) || '';
  if (listText.includes('youtube.com')) {
    failures.push('the real domain is still on the list after an alias was set');
  }
  const statsText = (await page.locator('#statsCard').textContent()) || '';
  if (statsText.includes('youtube.com')) {
    failures.push('the real domain still shows in the statistics after an alias was set');
  }
  if (!statsText.includes('A videós')) {
    failures.push('the statistics do not use the alias');
  }
  if (!CHECK_ONLY) {
    await page.screenshot({ path: path.join(OUT, 'desktop-alias.png'), fullPage: false });
  }

  // A felfedés IDEIGLENES: megmutatja a címet, aztán magától visszabújik.
  await page.locator('#siteList .site-row').first()
    .getByRole('button', { name: /Mutasd/ }).click();
  await page.waitForFunction(
    () => (document.querySelector('#siteList .site-row .site-domain') || {}).textContent
      ?.includes('youtube.com'),
    undefined, { timeout: 10_000 },
  );
  // ...és vissza is bújik magától, emberi beavatkozás nélkül.
  await page.waitForFunction(
    () => (document.querySelector('#siteList .site-row .site-domain') || {}).textContent
      ?.includes('A videós'),
    undefined, { timeout: 20_000 },
  );

  // A fedőnév levehető, és akkor újra a cím áll ott.
  await page.locator('#siteList .site-row').first()
    .getByRole('button', { name: /^Fedőnév$/ }).click();
  await page.getByRole('button', { name: /Fedőnév levétele/ }).click();
  await page.waitForFunction(
    () => (document.querySelector('#siteList .site-row .site-domain') || {}).textContent
      ?.includes('youtube.com'),
    undefined, { timeout: 10_000 },
  );

  // ------------------------------------------------------- a lista elrejtése
  //
  // A kérés nem az volt, hogy egy gomb összecsukja a listát, hanem hogy az app
  // MEGNYITÁSAKOR se álljon ott, mi van blokkolva. Két dolgot kell tehát
  // bizonyítani: (1) rejtve egyetlen cím se maradjon a listakártyán — nem elég,
  // ha csak nincs kigörgetve; és (2) a beállítás TÚLÉLJE az újraindítást,
  // különben minden induláskor újra kellene rejteni, és nem érne semmit.
  await page.getByRole('button', { name: 'Lista elrejtése' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('#siteList .site-row').length === 0
      && !document.getElementById('listHidden').classList.contains('hidden'),
    undefined, { timeout: 10_000 },
  );
  // A rejtés az EGÉSZ ablakra szól, nem csak a listakártyára: a statisztika
  // címkéi és a felvevő kártya gyorsgombjai ugyanúgy kiírnák a címet. Ezért itt
  // a teljes szöveget nézzük meg — így egy jövőbeli, máshol megjelenő cím is
  // elbukik, nem csak az, amire most gondoltunk.
  // innerText, nem textContent: a LÁTHATÓ szöveg a kérdés. (Egy becsukott
  // párbeszédben ott maradhat a legutóbbi címe — az nem jelenik meg senkinek,
  // viszont textContent-tel hamis riasztást adna.) A listakártyát külön,
  // DOM-szinten is megnézzük lentebb.
  const hiddenBody = await page.locator('body').innerText() || '';
  for (const leak of ['youtube', 'reddit', 'instagram']) {
    if (hiddenBody.toLowerCase().includes(leak)) {
      const at = hiddenBody.toLowerCase().indexOf(leak);
      failures.push(`while the list is hidden the window still names a blocked site (${leak}): `
        + `…${hiddenBody.slice(Math.max(0, at - 60), at + 40).replace(/\s+/g, ' ').trim()}…`);
    }
  }
  const hiddenCard = (await page.locator('#listCard').textContent()) || '';
  // A darabszám viszont MARADJON: azt kérte, hogy MIK vannak blokkolva ne
  // látszódjon, nem azt, hogy hány.
  if (!hiddenCard.includes('3 oldal')) {
    failures.push(`the collapsed list does not say how many sites are blocked: ${hiddenCard.trim()}`);
  }
  if (!CHECK_ONLY) {
    await page.screenshot({ path: path.join(OUT, 'desktop-list-hidden.png'), fullPage: false });
  }

  // Megnyitni egy kattintás — de csak erre a munkamenetre.
  await page.getByRole('button', { name: 'Lista megnyitása' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('#siteList .site-row').length === 3,
    undefined, { timeout: 10_000 },
  );

  // Újraindítás után megint rejtve. Enélkül ez csak egy összecsukó gomb volna.
  await page.reload();
  await page.waitForFunction(
    () => !document.getElementById('listHidden').classList.contains('hidden'),
    undefined, { timeout: 15_000 },
  );
  if (await page.locator('#siteList .site-row').count() !== 0) {
    failures.push('after a restart the hidden list is rendered anyway');
  }

  // És visszavonható: megnyitás, majd a fejlécgomb kikapcsolja a beállítást —
  // ennek szintén túl kell élnie egy újraindítást.
  await page.getByRole('button', { name: 'Lista megnyitása' }).click();
  await page.getByRole('button', { name: 'Ne rejtse ezután' }).click();
  await page.reload();
  await page.waitForFunction(
    () => document.querySelectorAll('#siteList .site-row').length === 3,
    undefined, { timeout: 15_000 },
  );
  if (!(await page.getByRole('button', { name: 'Lista elrejtése' }).count())) {
    failures.push('the hide setting cannot be turned back on after being switched off');
  }

  // ------------------------------------------- szünetelő és törlésre váró oldal
  //
  // Ezt a két állapotot eddig SEMMI nem ellenőrizte, pedig a felhasználó
  // mindkettőt látni fogja, és mindkettőben más gomb az egyetlen kiút. Ha egy
  // átalakítás elrontja őket, az addig marad bent, amíg valaki bele nem fut.
  await page.evaluate((now) => {
    window.__fakeSites = [
      {
        id: 'site_p', domain: 'youtube.com', hostnames: ['youtube.com'],
        addedAt: now - 86400000, pauseUntil: now + 22 * 60_000, pendingDeleteAt: null,
        dailyLimitSeconds: 1200, usedTodaySeconds: 1200, limitExhausted: true, blockedNow: false,
      },
      {
        id: 'site_d', domain: 'reddit.com', hostnames: ['reddit.com'],
        addedAt: now - 86400000, pauseUntil: null, pendingDeleteAt: now + 8 * 3600_000,
        usedTodaySeconds: 0, limitExhausted: false, blockedNow: true,
      },
    ];
  }, Date.now());
  // A státusz-lekérdezés 2 másodpercenként fut: a listát MEG KELL VÁRNI, nem
  // elég ránézni. (Ezen bukott el először ez a teszt.)
  await page.waitForFunction(
    () => document.querySelectorAll('#siteList .site-row').length === 2,
    undefined, { timeout: 15_000 },
  );

  const pausedRow = page.locator('#siteList .site-row').first();
  if (!(await pausedRow.getByRole('button', { name: /visszakapcsolása/ }).count())) {
    failures.push('a paused site offers no way to re-lock it early');
  }
  // A szünet alatt is fogy a keret — ezt ki KELL írni, mert a szünet végén
  // különben váratlanul zár be az oldal.
  const pausedMeter = (await pausedRow.locator('.limit-meter').textContent()) || '';
  if (!pausedMeter.includes('szünet')) {
    failures.push(`the paused row does not say the budget keeps draining: ${pausedMeter}`);
  }

  const deletingRow = page.locator('#siteList .site-row').nth(1);
  if (!(await deletingRow.getByRole('button', { name: /visszavonása/ }).count())) {
    failures.push('a pending deletion cannot be cancelled from the list');
  }
  // Törlés közben NE legyen ott a feloldás és a törlés gomb: ilyenkor egyetlen
  // értelmes művelet van, a visszavonás.
  if (await deletingRow.getByRole('button', { name: /^(Feloldás|Törlés)$/ }).count()) {
    failures.push('the deleting row still offers unlock or delete');
  }
  if (!CHECK_ONLY) {
    await page.screenshot({ path: path.join(OUT, 'desktop-states.png'), fullPage: false });
  }

  // ------------------------------------------------------------------ fiók
  //
  // A szinkron a legveszélyesebb funkció ebben az appban: ha a felület rosszul
  // mondja el, mit csinál, a felhasználó abban a hitben lép be, hogy a listája
  // valahol olvashatóan fekszik — vagy abban a hitben lép ki, hogy a blokkjai
  // eltűnnek. Ezért a kártya SZÖVEGÉT is megnézzük, nem csak azt, hogy ott van-e.
  const syncText = (await page.locator('#syncCard').innerText()) || '';
  if (!/titkosítva/i.test(syncText)) {
    failures.push('the sync card does not say the data goes up encrypted');
  }
  if (!/egyetlen blokkot sem visz el/i.test(syncText)) {
    failures.push('the sync card does not say that signing out keeps the blocks');
  }
  // A kiszolgáló ebben az appban is elindítható — enélkül a szinkron papíron
  // létezik, gyakorlatban nem. A cím KIÍRVA kell hogy legyen: ezt kell a
  // telefonba begépelni.
  await page.getByRole('button', { name: 'Kiszolgáló indítása ezen a gépen' }).click();
  await page.waitForFunction(
    () => (document.getElementById('syncHostState').textContent || '').includes('192.168.1.10'),
    undefined, { timeout: 10_000 },
  );
  const hostLine = (await page.locator('#syncHostState').innerText()) || '';
  if (!/nincs szinkron/i.test(hostLine)) {
    failures.push(`the host line does not say that the app must keep running: ${hostLine}`);
  }
  if (!(await page.getByRole('button', { name: 'Kiszolgáló leállítása' }).count())) {
    failures.push('the running server cannot be stopped');
  }
  await page.getByRole('button', { name: 'Kiszolgáló leállítása' }).click();
  await page.waitForFunction(
    () => document.getElementById('syncHostState').classList.contains('hidden'),
    undefined, { timeout: 10_000 },
  );

  for (const id of ['syncServer', 'syncAccount', 'syncPassword']) {
    if (!(await page.locator(`#${id}`).count())) failures.push(`missing sync field: ${id}`);
  }
  // A cím mezője NEM kötelező. Ez volt az a pont, ahol a szinkron meghalt: aki
  // idáig eljutott, ott feladta, mert egy IP-címet kellett volna begépelnie.
  const serverPlaceholder = await page.locator('#syncServer').getAttribute('placeholder');
  if (!/üresen/i.test(serverPlaceholder || '')) {
    failures.push(`a cím mezője nem mondja meg, hogy elhagyható: ${serverPlaceholder}`);
  }
  // A gépen futó kiszolgáló a PÁROSÍTÓ KÓDOT írja ki, nem az IP-címet.
  await page.getByRole('button', { name: /Kiszolgáló indítása/ }).click();
  await page.waitForFunction(
    () => document.querySelector('#syncHostState .pair-code') !== null,
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('a kiszolgáló nem írta ki a párosító kódot'));
  const pairCode = (await page.locator('#syncHostState .pair-code').innerText().catch(() => '')) || '';
  if (!/^[0-9A-Z-]{4,14}$/.test(pairCode)) failures.push(`furcsa párosító kód: ${pairCode}`);
  const hostText = (await page.locator('#syncHostState').innerText()) || '';
  if (!hostText.includes('192.168.1.10')) {
    failures.push('a teljes cím eltűnt — kell annak, akinél a kód nem megy');
  }
  await page.getByRole('button', { name: /Kiszolgáló leállítása/ }).click();
  await page.waitForFunction(
    () => document.getElementById('syncHostState').classList.contains('hidden'),
    undefined, { timeout: 10_000 },
  );
  if (await page.locator('#syncPassword').getAttribute('type') !== 'password') {
    failures.push('the sync password field is not masked');
  }
  // Elfelejtett jelszó: a helyreállító kód nem külön képernyő, hanem a meglévő
  // űrlap mellé nyílik. Ha ez a gomb elveszne, a kódnak nem lenne hol beírni —
  // vagyis a kiadott mentőöv semmit sem érne.
  if (!(await page.locator('#syncRecoveryBox').isHidden())) {
    failures.push('the recovery box is open before it is asked for');
  }
  await page.getByRole('button', { name: 'Elfelejtett jelszó' }).click();
  await page.waitForFunction(
    () => !document.getElementById('syncRecoveryBox').classList.contains('hidden'),
    undefined, { timeout: 10_000 },
  );
  if (!(await page.locator('#syncRecoveryCode').count())) {
    failures.push('there is nowhere to type the recovery code');
  }
  await page.getByRole('button', { name: 'Elfelejtett jelszó' }).click();
  // Bejelentkezve más a kártya: a beviteli mezők eltűnnek, a szinkron gomb jön.
  await page.evaluate(() => {
    window.__fakeSync = {
      serverUrl: 'https://sync.pelda.hu', accountId: 'david@example',
      deviceName: 'Mac gép', lastSyncAt: Date.now() - 60_000,
    };
  });
  await page.waitForFunction(
    () => !document.getElementById('syncNowBtn').classList.contains('hidden'),
    undefined, { timeout: 10_000 },
  );
  if (!(await page.locator('#syncSignedOut').isHidden())) {
    failures.push('the sign-in form is still shown while signed in');
  }
  const who = (await page.locator('#syncWho').innerText()) || '';
  if (!who.includes('david@example')) failures.push(`the account is not named: ${who}`);

  // A többi eszköz statisztikája — ez volt a kérés másik fele. És ami itt a
  // legkönnyebben elromlik: a másik eszköz adata NEM nevezheti meg a blokkolt
  // oldalt, ha a lista rejtve van. Ott lyukadna ki a rejtés, ahol senki nem
  // keresi.
  await page.getByRole('button', { name: 'Eszközök és idejük' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('#syncDevices .sync-device').length === 3,
    undefined, { timeout: 10_000 },
  );
  const devText = (await page.locator('#syncDevices').innerText()) || '';
  for (const want of ['Mac gép', 'Telefon', 'youtube.com', 'reddit.com']) {
    if (!devText.includes(want)) failures.push(`the device list is missing ${want}`);
  }
  // Az ÖSSZESÍTETT sor: ez az a szám, ami tényleg számít. És elöl kell álljon —
  // ha a lista végére kerülne, senki nem találkozna vele.
  const allCard = page.locator('#syncDevices .sync-device').first();
  const allText = (await allCard.innerText()) || '';
  if (!/Mind a\(z\) 2 eszköz együtt/.test(allText)) {
    failures.push(`the combined row is not first: ${allText.split('\n')[0]}`);
  }
  if (!allText.includes('1 ó 18 p')) {
    failures.push(`the combined today total is wrong: ${allText}`);
  }
  // Nem újratöltéssel: a hamis híd az induláskor visszaállna, és ilyenkor épp
  // a FUTÓ állapotot akarjuk átbillenteni.
  await page.evaluate(() => { window.__fakeHideList = true; });
  await page.waitForFunction(
    () => document.querySelectorAll('#siteList .site-row').length === 0,
    undefined, { timeout: 10_000 },
  );
  await page.getByRole('button', { name: 'Eszközök és idejük' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('#syncDevices .sync-device').length === 3,
    undefined, { timeout: 10_000 },
  );
  const hiddenDevText = (await page.locator('#syncDevices').innerText()) || '';
  for (const leak of ['youtube', 'reddit']) {
    if (hiddenDevText.toLowerCase().includes(leak)) {
      failures.push(`the other device's stats name a blocked site while the list is hidden: ${leak}`);
    }
  }
  if (!hiddenDevText.includes('rejtett oldal')) {
    failures.push('the masked label is missing from the other device stats');
  }
  // Vissza a rejtés előtti állapotba. A darabszámot nem kötjük meg: ekkorra a
  // teszt már átírta a hamis oldallistát a szünetelő/törlésre váró esethez.
  await page.evaluate(() => { window.__fakeHideList = false; });
  await page.waitForFunction(
    () => document.querySelectorAll('#siteList .site-row').length > 0,
    undefined, { timeout: 10_000 },
  );
  if (!CHECK_ONLY) {
    // Odagörgetünk: a kártya a lap alján ül, enélkül a képen a főképernyő
    // teteje lenne — vagyis pont az nem, amit dokumentálni akarunk.
    await page.locator('#syncCard').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, 'desktop-sync.png'), fullPage: false });
  }
  await page.evaluate(() => { window.__fakeSync = undefined; });

  // ------------------------------------------------------- világos téma
  // A felület a rendszer beállítását követi, tehát KÉT megjelenése van. Ha
  // csak a sötétet néznénk, egy világosban olvashatatlan szín addig maradna
  // bent, amíg valaki panaszkodik. A rács MINDEN cellája ugyanaz a kód, csak
  // más tokenekkel — ezért elég a főképernyőt végigjárni.
  const lightPage = await browser.newPage({
    viewport: { width: 1180, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  await lightPage.addInitScript(fakeBridgeSource());
  await lightPage.goto(`http://127.0.0.1:${port}/renderer/index.html`);
  await lightPage.waitForSelector('#siteList .site-row', { timeout: 15_000 });
  if (await lightPage.locator('#siteList .site-row').count() !== 3) {
    failures.push('the light theme does not render the site list');
  }
  await lightPage.waitForSelector('#statTiles .tile', { timeout: 15_000 });
  if (await lightPage.locator('.limit-meter').count() !== 2) {
    failures.push('the budget meters are missing in the light theme');
  }
  // A tokencsere tényleg megtörtént-e: sötétben szinte fekete a háttér.
  const lightBg = await lightPage.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  const lightSum = (lightBg.match(/\d+/g) || []).slice(0, 3).reduce((a, b) => a + Number(b), 0);
  if (lightSum < 500) {
    failures.push(`the light theme did not take effect, body background is ${lightBg}`);
  }
  if (!CHECK_ONLY) {
    await lightPage.screenshot({ path: path.join(OUT, 'desktop-home-light.png'), fullPage: false });
  }
  await lightPage.close();

  // A felvevő mező legrosszabb csendes hibája: aki bemásolja a
  // `youtube.com/@valaki` címet, azt hiszi, egy csatornát tilt le — a blokkolás
  // viszont DNS-szintű, tehát az EGÉSZ youtube.com esne el. Semmi nem hibázik,
  // csak nem az történik, amit kért.
  const beforeAdd = await page.locator('#siteList .site-row').count();
  await page.locator('#addInput').fill('https://www.youtube.com/@valaki');
  await page.locator('#addForm button[type=submit]').click();
  await page.waitForFunction(
    () => !document.getElementById('addError').classList.contains('hidden'),
    undefined, { timeout: 10_000 },
  );
  const warn = (await page.locator('#addError').innerText()) || '';
  for (const want of ['EGÉSZ youtube.com', 'bővítmény', 'nyomd meg újra']) {
    if (!warn.includes(want)) failures.push(`a figyelmeztetésből hiányzik: ${want} (${warn})`);
  }
  if ((await page.locator('#siteList .site-row').count()) !== beforeAdd) {
    failures.push('az első megnyomás mégis felvette az oldalt — nem volt figyelmeztetés');
  }
  // A második megnyomás viszont TOVÁBBENGED: nem tiltjuk meg, csak megmondjuk
  // előre. (Hogy a felvétel utána sikerül-e, a segéden múlik; itt az számít,
  // hogy a figyelmeztetés nem áll az útjába másodszor is.)
  await page.locator('#addForm button[type=submit]').click();
  await page.waitForFunction(
    () => {
      const el = document.getElementById('addError');
      return el.classList.contains('hidden') || !el.textContent.includes('nyomd meg újra');
    },
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('a második megnyomás is csak figyelmeztetett'));
  // Sima cím esetén NINCS figyelmeztetés — különben mindenki átlapozná.
  await page.locator('#addInput').fill('pelda-oldal.hu');
  await page.locator('#addForm button[type=submit]').click();
  await page.waitForFunction(
    () => {
      const el = document.getElementById('addError');
      return el.classList.contains('hidden') || !el.textContent.includes('EGÉSZ');
    },
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('út nélküli címnél is figyelmeztetett'));

  // ------------------------------------------------------- a gyorsbillentyűs réteg
  //
  // Ez egy külön LAP, saját HTML-lel és saját szkripttel. Eddig semmi nem
  // nyitotta meg: egy elgépelt azonosító vagy egy be nem töltődő modul itt
  // ugyanolyan csendes hiba lenne, mint bárhol — a réteg előjönne, és nem
  // történne semmi.
  const over = await browser.newPage();
  over.on('pageerror', (e) => failures.push(`hiba a rétegen: ${e.message}`));
  await over.addInitScript(fakeBridgeSource());
  await over.goto(`http://127.0.0.1:${port}/renderer/overlay.html`);
  await over.waitForSelector('.pack', { timeout: 15_000 })
    .catch(() => failures.push('a réteg nem listázta ki a csomagokat'));
  const overNames = await over.locator('.pack-name').allTextContents();
  if (!overNames.includes('Nyelvtanulás')) {
    failures.push(`a rétegen nincsenek csomagok (${JSON.stringify(overNames)})`);
  }
  // Számbillentyű: a réteg egy másodpercet kap, és az egérhez nyúlni fél
  // másodperc. Ha ez nem megy, a funkció lényege veszik el.
  await over.keyboard.press('1');
  await over.waitForFunction(
    () => document.body.innerText.includes('Meddig tartson'),
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('számbillentyűre nem jött elő a hossz-választás'));
  await over.getByRole('button', { name: '50 perc' }).click();
  await over.waitForFunction(
    () => document.body.innerText.includes('perc') && document.querySelector('.focus-left, .left'),
    undefined, { timeout: 10_000 },
  ).catch(() => failures.push('az indítás után nem látszik a futó munkamenet'));
  const runText = await over.locator('.running').first().innerText().catch(() => '');
  if (!/Most csak ez mehet/.test(runText)) {
    failures.push(`a futó munkamenet nem sorolja fel, mi mehet: ${runText}`);
  }
  // Az Esc zárja. Egy ottfelejtett, mindig felül lévő réteg a legrosszabb, amit
  // ez a funkció tehet.
  await over.keyboard.press('Escape');
  const hidden = await over.evaluate(() => window.__overlayHidden === true);
  if (!hidden) failures.push('az Esc nem zárta be a réteget');
  await over.close();
  await page.evaluate(() => { window.__fakeRun = null; });

  await browser.close();
  server.close();

  if (failures.length) {
    console.error('UI smoke test failed:');
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(CHECK_ONLY ? 'UI smoke test OK' : `UI smoke test OK, screenshots written to ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
