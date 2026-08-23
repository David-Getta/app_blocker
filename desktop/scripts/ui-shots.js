// Renderer smoke test + screenshot generator.
//
// Two jobs in one, because they need exactly the same setup:
//   1. It actually LOADS the built renderer and drives it. A renderer can break
//      in ways tsc never sees (a module specifier without .js, a null element
//      lookup) and then the whole window is silently blank. That failure has
//      happened twice; here it fails loudly instead.
//   2. It refreshes docs/images/*.png so the README shows the current UI.
//
// The Electron bridge (window.lakat) is replaced by an in-page fake backed by a
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
function fakeBridgeSource() {
  return `
    const now = Date.now();
    const day = (back) => {
      const d = new Date(now); d.setHours(12,0,0,0); d.setDate(d.getDate() - back);
      const m = String(d.getMonth()+1).padStart(2,'0');
      return d.getFullYear() + '-' + m + '-' + String(d.getDate()).padStart(2,'0');
    };
    const sites = [
      { id: 'site_1', domain: 'youtube.com', hostnames: ['youtube.com','www.youtube.com','m.youtube.com','youtu.be'],
        addedAt: now - 86400000*9, pauseUntil: null, pendingDeleteAt: null, blockedNow: true },
      { id: 'site_2', domain: 'reddit.com', hostnames: ['reddit.com','www.reddit.com'],
        addedAt: now - 86400000*4, pauseUntil: null, pendingDeleteAt: null,
        schedule: { mode: 'scheduled_block', bands: [{ days: [1,2,3,4,5], startMin: 540, endMin: 1020 }] },
        blockedNow: true },
      { id: 'site_3', domain: 'instagram.com', hostnames: ['instagram.com','www.instagram.com'],
        addedAt: now - 86400000*2, pauseUntil: null, pendingDeleteAt: null, blockedNow: true },
    ];
    let session = null;
    const status = () => ({
      helperVersion: 1, platform: 'darwin', sites, tier: 1, unlocks7d: 2,
      session, dohPolicyApplied: true, usageEnabled: true, now: Date.now(),
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
    window.lakat = {
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
        return { ok: true, data: {} };
      },
      install: async () => ({ ok: true }),
      checkUpdate: async () => ({ ok: true }),
      installUpdate: async () => ({ ok: true }),
      getUpdateState: async () => ({ status: 'idle' }),
      onUpdateState: () => {},
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
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 });

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

  await page.waitForSelector('#statTiles .tile', { timeout: 15_000 });
  const tiles = await page.locator('#statTiles .tile').count();
  if (tiles !== 4) failures.push(`expected 4 stat tiles, saw ${tiles}`);
  const bars = await page.locator('#topSites .bar-row').count();
  if (bars === 0) failures.push('the weekly top-sites chart rendered no bars');

  if (!CHECK_ONLY) {
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, 'desktop-home.png'), fullPage: false });
    await page.locator('#statsCard').screenshot({ path: path.join(OUT, 'desktop-stats.png') });
  }

  // Drive the unlock flow: pause -> challenge modal with a wrong answer.
  await page.locator('#siteList .site-row').first()
    .getByRole('button', { name: /Feloldás időre/ }).click();
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
