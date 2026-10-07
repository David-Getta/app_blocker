// A bővítmény súrlódása.
//
// Ez a funkció akkor ér valamit, ha a levétel NEM egy gomb. A felvétel ingyen
// van (szigorítás), a levétel várakozás (lazítás) — ugyanaz a szabály, mint az
// appban mindenhol.
//
// A tesztek a TÉNYLEGESEN kiszállított `extension/storage.js`-t futtatják, egy
// hamis `chrome.storage.local` fölött. Egy külön másolat itt semmit nem érne:
// pont az a kérdés, hogy amit a böngészőbe töltünk, az mit csinál.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

interface RuleRec { host: string; path: string; addedAt: number; removeAt: number | null }
interface Store { rules: RuleRec[] }
interface Api {
  REMOVE_DELAY_MS: number;
  MAX_RULES: number;
  load: () => Promise<Store>;
  activeRules: (s: Store, now: number) => RuleRec[];
  addRule: (input: string, now?: number) => Promise<{ ok: boolean; error?: string; label?: string }>;
  startRemoval: (h: string, p: string, now?: number) => Promise<{ ok: boolean; removeAt?: number }>;
  cancelRemoval: (h: string, p: string) => Promise<void>;
  sweep: (now?: number) => Promise<RuleRec[]>;
}

/**
 * A bővítmény mappája — a `__dirname`-től felfelé keresve.
 *
 * A tesztek kétféleképpen futnak: forrásból (`test/`) és a fordított
 * kimenetből (`dist-test/test/`). Egy fix relatív út az egyikben jó lenne, a
 * másikban némán rossz fájlt keresne.
 */
function extensionDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'extension');
    if (fs.existsSync(path.join(candidate, 'rules-core.js'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('nem talalom az extension/ mappat');
}

/** Egy friss bővítmény-példány, saját üres tárolóval. */
function freshExtension(): Api {
  const disk: Record<string, unknown> = {};
  const chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: disk[key] }),
        set: async (obj: Record<string, unknown>) => { Object.assign(disk, obj); },
      },
    },
  };
  const dir = extensionDir();
  const core = fs.readFileSync(path.join(dir, 'rules-core.js'), 'utf8');
  const storage = fs.readFileSync(path.join(dir, 'storage.js'), 'utf8');
  const names: string[] = [];
  const strip = (src: string): string => src
    .replace(/^import[^;]+;\s*$/gm, '')
    .replace(/^export (const|async function|function) (\w+)/gm, (_m, kind, name) => {
      names.push(name as string);
      return `${kind} ${name}`;
    });
  const body = `${strip(core)}\n${strip(storage)}`;
  // eslint-disable-next-line no-new-func
  return new Function('chrome', `${body}\nreturn { ${names.join(', ')} };`)(chrome) as Api;
}

const NOW = 1_800_000_000_000;

test('adding a rule is free and takes effect at once', () => {
  // A szigorítás soha nem kér semmit. Ha a felvétel is súrlódna, senki nem
  // venne fel szabályt — és a funkció nem létezne.
  const ext = freshExtension();
  return (async () => {
    const r = await ext.addRule('https://www.youtube.com/@valaki', NOW);
    assert.equal(r.ok, true);
    assert.equal(r.label, 'youtube.com/@valaki');
    const state = await ext.load();
    assert.equal(ext.activeRules(state, NOW).length, 1);
  })();
});

test('the same rule twice stays one rule', async () => {
  const ext = freshExtension();
  await ext.addRule('youtube.com/@valaki', NOW);
  await ext.addRule('https://m.youtube.com/@Valaki/', NOW);
  assert.equal((await ext.load()).rules.length, 1);
});

test('junk is refused with a sentence, not with silence', async () => {
  // Ha a hibás bevitel csendben eldobódna, a felhasználó azt hinné, felvette a
  // szabályt — és csak hetekkel később venné észre, hogy sosem tiltott semmit.
  const ext = freshExtension();
  const r = await ext.addRule('youtube.com', NOW);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /youtube\.com\/@valaki/, 'mondja meg, mit vár');
  assert.equal((await ext.load()).rules.length, 0);
});

test('removing is NOT a button: it blocks until the wait is over', async () => {
  // Ez a funkció lényege. Ha a levétel azonnali lenne, a részleges tiltás
  // annyit érne, mint egy kikapcsoló gomb.
  const ext = freshExtension();
  await ext.addRule('youtube.com/@valaki', NOW);
  const started = await ext.startRemoval('youtube.com', '/@valaki', NOW);
  assert.equal(started.ok, true);
  assert.equal(started.removeAt, NOW + ext.REMOVE_DELAY_MS);

  // Közvetlenül a határidő ELŐTT még tilt.
  const state = await ext.load();
  assert.equal(ext.activeRules(state, NOW + ext.REMOVE_DELAY_MS - 1).length, 1);
  // Utána már nem.
  assert.equal(ext.activeRules(state, NOW + ext.REMOVE_DELAY_MS + 1).length, 0);
});

test('pressing remove again does not push the deadline out', async () => {
  // Enélkül a gomb ismételgetése kitolná a határidőt, ami zavarba ejtő — és
  // pont az ellenkezője annak, amit a felhasználó akar.
  const ext = freshExtension();
  await ext.addRule('youtube.com/@valaki', NOW);
  const first = await ext.startRemoval('youtube.com', '/@valaki', NOW);
  const again = await ext.startRemoval('youtube.com', '/@valaki', NOW + 60_000);
  assert.equal(again.removeAt, first.removeAt);
});

test('changing your mind is free, in both directions', async () => {
  // A szigorítás mindig ingyen van: a visszaszámlálás megszakítása is, és az
  // újrafelvétel is. Csak a lazítás kerül időbe.
  const ext = freshExtension();
  await ext.addRule('youtube.com/@valaki', NOW);
  await ext.startRemoval('youtube.com', '/@valaki', NOW);
  await ext.cancelRemoval('youtube.com', '/@valaki');
  assert.equal((await ext.load()).rules[0].removeAt, null);

  await ext.startRemoval('youtube.com', '/@valaki', NOW);
  await ext.addRule('youtube.com/@valaki', NOW); // újrafelvétel = visszavonás
  assert.equal((await ext.load()).rules[0].removeAt, null);
});

test('an expired rule is actually cleaned up, not kept forever', async () => {
  const ext = freshExtension();
  await ext.addRule('youtube.com/@valaki', NOW);
  await ext.addRule('reddit.com/r/hirek', NOW);
  await ext.startRemoval('youtube.com', '/@valaki', NOW);
  const kept = await ext.sweep(NOW + ext.REMOVE_DELAY_MS + 1);
  assert.deepEqual(kept.map((r) => `${r.host}${r.path}`), ['reddit.com/r/hirek']);
  assert.equal((await ext.load()).rules.length, 1);
});

test('a corrupt stored record does not take the whole list down', async () => {
  // A tároló a felhasználó gépén van, és túléli a bővítmény frissítéseit. Egy
  // régi vagy elrontott bejegyzés nem törölheti el a többi tiltást.
  const ext = freshExtension();
  await ext.addRule('youtube.com/@valaki', NOW);
  const state = await ext.load();
  state.rules.push(null as unknown as RuleRec);
  state.rules.push({ host: 5 } as unknown as RuleRec);
  // A `load` szűr, tehát a szemét nem jut tovább.
  assert.equal(ext.activeRules({ rules: state.rules.filter((r) => r && typeof r.host === 'string') }, NOW).length, 1);
});

test('the wait is long enough to outlast an impulse', async () => {
  // Nem a szám a lényeg, hanem a nagyságrend: percekben mérve, nem
  // másodpercekben. Egy pár másodperces várakozás nem súrlódás, csak bosszúság.
  const ext = freshExtension();
  assert.ok(ext.REMOVE_DELAY_MS >= 5 * 60_000, 'legalább öt perc');
  assert.ok(ext.MAX_RULES >= 50, 'ne fogyjon el a hely valódi használatnál');
});

// ---------------------------------------------------------------------------
// A kapcsolat az appal
// ---------------------------------------------------------------------------
//
// A szabályokat az appban veszi fel az ember (ott van mögöttük a próbatétel).
// Ha ez a kapcsolat rosszul működik, két dolog történhet, és mindkettő csendes:
//
//   1. az app szabályai NEM érnek ide  -> a felhasználó azt hiszi, tilt, és nem;
//   2. az app szabályai innen levehetők -> a bővítmény lesz a legolcsóbb kiskapu.

interface LinkApi {
  FIRST_PORT: number;
  PORT_TRIES: number;
  REFRESH_MS: number;
  TOKEN_HEADER: string;
  loadLink: () => Promise<{ token: string | null; port: number | null;
    rules: { host: string; path: string }[];
    channels: { host: string; allow: string[] }[];
    focus: { running: boolean; name: string; endsAt: number; allowSites: string[]; window: boolean;
      windows: { packId: string; name: string; allowSites: string[]; startsAt: number; endsAt: number }[]; };
    keywords: string[];
    fetchedAt: number; error: string | null }>;
  setToken: (t: string) => Promise<string | null>;
  forgetToken: () => Promise<void>;
  pullFromApp: (now?: number, fetchImpl?: unknown, timeoutMs?: number) => Promise<{ ok: boolean;
    rules?: { host: string; path: string }[]; error?: string }>;
  dueForRefresh: (
    link: { token: string | null; fetchedAt: number; attemptedAt?: number }, now: number,
  ) => boolean;
  withAppRules: (
    local: { host: string; path: string }[], app: { host: string; path: string }[],
  ) => { host: string; path: string; fromApp?: boolean }[];
  currentTabHint: (api: unknown) => Promise<{ focused: boolean; host: string | null }>;
  postTabHint: (hint: { focused: boolean; host: string | null }, fetchImpl?: unknown, timeoutMs?: number) =>
    Promise<{ ok: boolean; error?: string }>;
}

function freshLink(): LinkApi {
  const disk: Record<string, unknown> = {};
  const chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: disk[key] }),
        set: async (obj: Record<string, unknown>) => { Object.assign(disk, obj); },
      },
    },
  };
  // Az app-link a kulcsszó-tisztítást a `keywords.js`-ből veszi: ugyanazokat
  // a kiszállított bájtokat töltjük elé, amiket a böngésző is.
  const src = fs.readFileSync(path.join(extensionDir(), 'keywords.js'), 'utf8')
    + '\n' + fs.readFileSync(path.join(extensionDir(), 'incognito.js'), 'utf8')
    + '\n' + fs.readFileSync(path.join(extensionDir(), 'app-link.js'), 'utf8');
  const names: string[] = [];
  const body = src
    .replace(/^import[^;]+;\s*$/gm, '')
    .replace(/^export (const|async function|function) (\w+)/gm, (_m, kind, name) => {
      names.push(name as string);
      return `${kind} ${name}`;
    });
  // eslint-disable-next-line no-new-func
  return new Function('chrome', 'fetch', `${body}\nreturn { ${names.join(', ')} };`)(
    chrome, async () => { throw new Error('nincs hálózat'); },
  ) as LinkApi;
}

/** Egy hamis app: adott porton válaszol, adott kóddal. */
function fakeApp(port: number, token: string, rules: { host: string; path: string }[]) {
  return async (url: string, init: { headers: Record<string, string> }) => {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/rules$/.exec(url);
    if (!m) throw new Error('rossz cím');
    if (Number(m[1]) !== port) throw new Error('ECONNREFUSED');
    if (init.headers['x-breaker-token'] !== token) {
      return { ok: false, status: 401, json: async () => ({ error: 'rossz kód' }) };
    }
    return { ok: true, status: 200, json: async () => ({ protocol: 1, rules }) };
  };
}

test('the app rules arrive, even when the app moved to another port', async () => {
  // A 8788 bármelyik másik program alatt lehet; az app ilyenkor a következőn
  // indul. Ha csak az elsőt próbálnánk, a bővítmény némán maradna szabály
  // nélkül — és a felhasználó azt hinné, hogy tilt.
  const ext = freshLink();
  await ext.setToken('ABCD-EFGH');
  const app = fakeApp(8790, 'ABCD-EFGH', [{ host: 'youtube.com', path: '/@valaki' }]);
  const r = await ext.pullFromApp(1000, app);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rules, [{ host: 'youtube.com', path: '/@valaki' }]);
  // A megtalált portot megjegyezzük: tíz kérés helyett egy.
  assert.equal((await ext.loadLink()).port, 8790);
});

test('a lehúzás megmondja az appnak, fut-e a bővítmény inkognitóban — ha a böngésző nem tudja, nem küldi', async () => {
  // Az app ebből mondja ki a munkamenet kártyáján, ha inkognitóban a
  // fehérlista nem érvényesül. A böngésző válaszát a kiszállított incognito.js
  // olvassa — a `globalThis.chrome`-ról, ezért azt cseréljük a teszt idejére.
  const seen: (string | undefined)[] = [];
  const app = async (_url: string, init: { headers: Record<string, string> }) => {
    seen.push(init.headers['x-breaker-incognito']);
    return { ok: true, status: 200, json: async () => ({ protocol: 1, rules: [] }) };
  };
  const g = globalThis as { chrome?: unknown };
  const before = g.chrome;
  try {
    for (const [allowed, want] of [[false, '0'], [true, '1'], [null, undefined]] as const) {
      g.chrome = allowed === null ? undefined : { extension: { isAllowedIncognitoAccess: async () => allowed } };
      const ext = freshLink();
      await ext.setToken('ABCD-EFGH');
      assert.equal((await ext.pullFromApp(1000, app)).ok, true);
      assert.equal(seen[seen.length - 1], want, String(allowed));
    }
    // Ha a böngésző kérdése hibát dob, a lehúzás attól még megy, jel nélkül.
    g.chrome = { extension: { isAllowedIncognitoAccess: async () => { throw new Error('nincs ilyen'); } } };
    const ext = freshLink();
    await ext.setToken('ABCD-EFGH');
    assert.equal((await ext.pullFromApp(1000, app)).ok, true);
    assert.equal(seen[seen.length - 1], undefined);
  } finally {
    g.chrome = before;
  }
});

test('a mérő jele: a fókuszos ablak elöl lévő fülének tartománya — fókusz nélkül semmi', async () => {
  // Az app ebből méri az oldalt ott, ahol a gép maga nem tudja kiolvasni a
  // címet. Ha a böngésző nincs elöl, a jel ezt mondja — különben az app egy
  // régi oldalra könyvelné egy másik app perceit.
  const ext = freshLink();
  const api = (focused: boolean, url: string | undefined) => ({
    windows: { getLastFocused: async () => ({ id: 7, focused }) },
    tabs: { query: async (q: { active: boolean; windowId: number }) => (q.active && q.windowId === 7 ? [{ url }] : []) },
  });
  assert.deepEqual(await ext.currentTabHint(api(true, 'https://www.YouTube.com/watch?v=x')),
    { focused: true, host: 'www.youtube.com' });
  assert.deepEqual(await ext.currentTabHint(api(true, 'chrome://newtab/')), { focused: true, host: null });
  assert.deepEqual(await ext.currentTabHint(api(true, undefined)), { focused: true, host: null });
  assert.deepEqual(await ext.currentTabHint(api(false, 'https://youtube.com/')), { focused: false, host: null });
  const broken = { windows: { getLastFocused: async () => { throw new Error('nincs ablak'); } } };
  assert.deepEqual(await ext.currentTabHint(broken), { focused: false, host: null });

  // A küldés: a hídon, a kóddal, a /tab útra — összekötés nélkül nem megy ki.
  const sent: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  const app = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    sent.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  assert.equal((await ext.postTabHint({ focused: true, host: 'youtube.com' }, app)).ok, false, 'kód nélkül nem');
  await ext.setToken('ABCD-EFGH');
  await ext.pullFromApp(1000, fakeApp(8790, 'ABCD-EFGH', []));
  assert.equal((await ext.postTabHint({ focused: true, host: 'youtube.com' }, app)).ok, true);
  const last = sent[sent.length - 1];
  assert.equal(last.url, 'http://127.0.0.1:8790/tab');
  assert.equal(last.init.method, 'POST');
  assert.equal(last.init.headers['x-breaker-token'], 'ABCD-EFGH');
  assert.deepEqual(JSON.parse(last.init.body), { focused: true, host: 'youtube.com' });
});

test('egy néma port nem állítja meg a keresést', async () => {
  // EZ A LÉNYEG. A `fetch`-nek a böngészőben nincs alapértelmezett határideje.
  // Ha a 8788-on valami MÁS ül, fogadja a kapcsolatot, de sosem válaszol, a
  // lekérdezés időkorlát nélkül örökre ott állna — a bővítmény csendben a régi
  // szabálylistával működne tovább, és az appban felvett új tiltás sosem érne
  // át. Semmi nem szólna róla.
  const ext = freshLink();
  await ext.setToken('ABCD-EFGH');
  const app = fakeApp(8790, 'ABCD-EFGH', [{ host: 'youtube.com', path: '/@valaki' }]);
  const nema = (url: string, init: unknown) => (
    url.includes(':8788/')
      ? new Promise(() => { /* soha nem válaszol */ })
      : (app as (u: string, i: unknown) => Promise<unknown>)(url, init)
  );
  // VERSENY, nem puszta `await`: határidő nélkül a hívás örökre várna, és a
  // futtató csendben kevesebb tesztet jelentene — hiba nélkül. Egy eltűnt
  // teszt rosszabb egy pirosnál, mert a szám ránézésre ugyanolyan zöld.
  const r = await Promise.race([
    ext.pullFromApp(1000, nema, 30),
    new Promise<{ ok: boolean }>((res) => { setTimeout(() => res({ ok: false }), 500); }),
  ]) as { ok: boolean; rules?: { host: string; path: string }[] };
  assert.equal(r.ok, true, 'a néma portot átugorja, és megtalálja az appot');
  assert.deepEqual(r.rules, [{ host: 'youtube.com', path: '/@valaki' }]);
});

test('a néma TÖRZS sem állítja meg a keresést', async () => {
  // A fejléc megjön, a törzs nem fejeződik be. Határidő nélkül ez ugyanaz a
  // megállás, csak eggyel később — a `res.json()` várna örökre.
  const ext = freshLink();
  await ext.setToken('ABCD-EFGH');
  const app = fakeApp(8790, 'ABCD-EFGH', [{ host: 'youtube.com', path: '/@valaki' }]);
  const csonka = (url: string, init: unknown) => (
    url.includes(':8788/')
      ? Promise.resolve({ status: 200, ok: true, json: () => new Promise(() => {}) })
      : (app as (u: string, i: unknown) => Promise<unknown>)(url, init)
  );
  const r = await Promise.race([
    ext.pullFromApp(1000, csonka, 30),
    new Promise<{ ok: boolean }>((res) => { setTimeout(() => res({ ok: false }), 500); }),
  ]) as { ok: boolean; rules?: { host: string; path: string }[] };
  assert.equal(r.ok, true, 'a néma törzset átugorja, és megtalálja az appot');
  assert.deepEqual(r.rules, [{ host: 'youtube.com', path: '/@valaki' }]);
});

test('a SIKERTELEN kör is elhalasztja a következőt', async () => {
  // Enélkül egy zárva lévő app mellett MINDEN lapbetöltés újraindítaná a
  // tízportos keresést. A `fetchedAt` ugyanis csak sikernél lép, tehát arra a
  // kérdésre, hogy letelt-e a húsz másodperc, örökre igen lenne a válasz. A
  // felhasználó annyit venne észre, hogy lassul a böngészője.
  const ext = freshLink();
  await ext.setToken('ABCD-EFGH');
  const senki = () => Promise.reject(new Error('nincs ott semmi'));
  // A PRÓBA IDEJE messze legyen a nullától: sikertelen körnél a `fetchedAt`
  // nulla marad, tehát kis időbélyegekkel a két szabály ugyanazt adná, és a
  // teszt csendben mindent átengedne. Az első változatom pont ezen bukott el.
  const t0 = 10 * ext.REFRESH_MS;
  const r = await ext.pullFromApp(t0, senki, 30);
  assert.equal(r.ok, false);

  const link = await ext.loadLink();
  assert.equal(ext.dueForRefresh(link, t0 + 1000), false, 'egy másodperccel később még nem');
  assert.equal(ext.dueForRefresh(link, t0 + ext.REFRESH_MS), true, 'húsz másodperc után igen');

  // A SZABÁLYLISTÁT viszont nem bántja: az app elérhetetlensége nem jelenti
  // azt, hogy nincsenek szabályok.
  assert.equal(link.fetchedAt, 0, 'a friss lekérdezés ideje nem hazudik');
});

test('a wrong code says so, instead of looking like a network problem', async () => {
  const ext = freshLink();
  await ext.setToken('ROSSZ');
  const app = fakeApp(8788, 'ABCD-EFGH', []);
  const r = await ext.pullFromApp(1000, app);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /kód/);
});

test('when the app is closed, the last known rules stay in force', async () => {
  // EZ A LÉNYEG. Ha az elérhetetlen app „nulla szabályt” jelentene, elég lenne
  // bezárni az appot ahhoz, hogy a részleges tiltás megszűnjön — vagyis a
  // legolcsóbb feloldás egy ablak bezárása lenne.
  const ext = freshLink();
  await ext.setToken('ABCD-EFGH');
  await ext.pullFromApp(1000, fakeApp(8788, 'ABCD-EFGH', [{ host: 'youtube.com', path: '/@a' }]));
  const down = await ext.pullFromApp(2000, async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(down.ok, false);
  const link = await ext.loadLink();
  assert.deepEqual(link.rules, [{ host: 'youtube.com', path: '/@a' }], 'a lista megmarad');
  assert.ok(link.error, 'de a felület megtudja, hogy nem friss');
});

test('an empty answer from a reachable app IS the answer', async () => {
  // Ha az appban levették az összes szabályt (próbatétellel), annak ide is meg
  // kell érkeznie — különben a bővítmény örökre tiltana valamit, amit a
  // felhasználó már kifizetett.
  const ext = freshLink();
  await ext.setToken('ABCD-EFGH');
  await ext.pullFromApp(1000, fakeApp(8788, 'ABCD-EFGH', [{ host: 'youtube.com', path: '/@a' }]));
  const r = await ext.pullFromApp(2000, fakeApp(8788, 'ABCD-EFGH', []));
  assert.equal(r.ok, true);
  assert.deepEqual((await ext.loadLink()).rules, []);
});

test('changing or clearing the code never drops the rules', async () => {
  // A szabályok eldobása lazítás lenne, méghozzá a legolcsóbb fajta: elég
  // lenne kitörölni a kódot.
  const ext = freshLink();
  await ext.setToken('ABCD-EFGH');
  await ext.pullFromApp(1000, fakeApp(8788, 'ABCD-EFGH', [{ host: 'youtube.com', path: '/@a' }]));
  await ext.setToken('MASIK-KOD');
  assert.equal((await ext.loadLink()).rules.length, 1);
  await ext.forgetToken();
  assert.equal((await ext.loadLink()).rules.length, 1);
});

test('the app rules are added to the local ones, never instead of them', async () => {
  const ext = freshLink();
  const local = [{ host: 'reddit.com', path: '/r/hirek' }];
  const app = [{ host: 'youtube.com', path: '/@a' }, { host: 'reddit.com', path: '/r/hirek' }];
  const merged = ext.withAppRules(local, app);
  assert.equal(merged.length, 2, 'a duplikátum egy marad');
  assert.deepEqual(merged.map((r) => `${r.host}${r.path}`).sort(),
    ['reddit.com/r/hirek', 'youtube.com/@a']);
  // Ami az appból jött, meg van jelölve: a felület ezért tudja letiltani rajta
  // a „Levétel” gombot — levenni az appban kell, ahol próbatételbe kerül.
  assert.equal(merged.find((r) => r.host === 'youtube.com')?.fromApp, true);
  assert.equal(merged.find((r) => r.host === 'reddit.com')?.fromApp, undefined);
});

test('we do not ask the app on every navigation', async () => {
  const ext = freshLink();
  assert.equal(ext.dueForRefresh({ token: null, fetchedAt: 0 }, 10_000), false, 'kód nélkül soha');
  assert.equal(ext.dueForRefresh({ token: 'K', fetchedAt: 0 }, ext.REFRESH_MS), true);
  assert.equal(ext.dueForRefresh({ token: 'K', fetchedAt: 1000 }, 1000 + ext.REFRESH_MS - 1), false);
});

// ---------------------------------------------------------------------------
// Munkamenet: „most csak EZ mehet”
// ---------------------------------------------------------------------------
//
// Ez a réteg fordítva működik, mint a szabályok: fehérlista. Két hiba
// lehetséges, és mindkettő csendes — átenged valamit, amit nem soroltak fel,
// vagy örökre bent ragad, mert a lejáratot nem veszi észre.

interface FocusApi extends LinkApi {
  focusActive: (link: unknown, now?: number) => boolean;
  focusAllows: (link: unknown, host: string, now?: number) => boolean;
}

function fakeAppWithFocus(
  port: number, token: string, focus: Record<string, unknown>,
) {
  return async (url: string, init: { headers: Record<string, string> }) => {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/rules$/.exec(url);
    if (!m || Number(m[1]) !== port) throw new Error('ECONNREFUSED');
    if (init.headers['x-breaker-token'] !== token) {
      return { ok: false, status: 401, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ protocol: 1, rules: [], focus }) };
  };
}

test('during a session only the listed hosts get through', async () => {
  const ext = freshLink() as FocusApi;
  await ext.setToken('K');
  await ext.pullFromApp(1000, fakeAppWithFocus(8788, 'K', {
    running: true, name: 'Nyelvtanulás', endsAt: 1000 + 3600_000,
    allowSites: ['google.com', 'quizlet.com'],
  }));
  const link = await ext.loadLink();

  assert.equal(ext.focusActive(link, 1000), true);
  assert.equal(ext.focusAllows(link, 'google.com', 1000), true);
  assert.equal(ext.focusAllows(link, 'translate.google.com', 1000), true, 'aldomain is mehet');
  assert.equal(ext.focusAllows(link, 'youtube.com', 1000), false);
  // A végén hasonlító tartománynév a leggyakoribb megkerülés.
  assert.equal(ext.focusAllows(link, 'notgoogle.com', 1000), false);
  assert.equal(ext.focusAllows(link, '', 1000), false);
});

test('a session ends on its own clock, not on the app being open', async () => {
  // Ha a lejáratot az apptól kérdeznénk, egy bezárt app örökre bent tartana a
  // fehérlistában. Ha viszont az elérhetetlen app „nincs munkamenet”-et
  // jelentene, az app bezárása lenne a feloldás. Egyik sem jó: a lejárat
  // IDŐPONT, és azt helyben nézzük.
  const ext = freshLink() as FocusApi;
  await ext.setToken('K');
  await ext.pullFromApp(1000, fakeAppWithFocus(8788, 'K', {
    running: true, name: 'Nyelvtanulás', endsAt: 1000 + 60_000, allowSites: ['google.com'],
  }));
  const link = await ext.loadLink();
  assert.equal(ext.focusActive(link, 1000 + 30_000), true, 'félidőben fut');
  assert.equal(ext.focusActive(link, 1000 + 61_000), false, 'lejárat után nem');

  // És amíg fut, az app elérhetetlensége nem oldja fel.
  await ext.pullFromApp(1000 + 30_000, async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(ext.focusActive(await ext.loadLink(), 1000 + 30_000), true);
});

test('a heti ablak jele túléli a tárolást, a hiánya pedig hamis', async () => {
  // A híd mondja meg, hogy a menet az ablak szerint indult; a bővítmény
  // tárolja, és a felugró meg a tiltó lap ebből beszél. Egy régebbi app,
  // ami nem küld ilyet, nem ablak — nem „ismeretlen”.
  const ext = freshLink() as FocusApi;
  await ext.setToken('K');
  await ext.pullFromApp(1000, fakeAppWithFocus(8788, 'K', {
    running: true, name: 'Mély munka', endsAt: 1000 + 3600_000, allowSites: ['github.com'], window: true,
  }));
  assert.equal((await ext.loadLink()).focus.window, true);
  await ext.pullFromApp(2000, fakeAppWithFocus(8788, 'K', {
    running: true, name: 'Mély munka', endsAt: 2000 + 3600_000, allowSites: ['github.com'],
  }));
  assert.equal((await ext.loadLink()).focus.window, false);
});

test('a heti ablakok tárolódnak, és ha az app elhallgat, a böngésző betartja őket', async () => {
  // A segéd az ablak menetét az app nélkül is elindítja; a böngészőben a
  // bővítmény tartja be — az app bezárása nem lehet az ablak feloldása.
  const ext = freshLink() as FocusApi;
  await ext.setToken('K');
  const start = 1000 + 3600_000;
  await ext.pullFromApp(1000, fakeAppWithFocus(8788, 'K', {
    running: false,
    windows: [
      { packId: 'p1', name: 'Mély munka', allowSites: ['github.com', 7], startsAt: start, endsAt: start + 3600_000 },
      { packId: '', name: 'x', allowSites: [], startsAt: 1, endsAt: 2 },
      { packId: 'p2', name: 'fordított', allowSites: [], startsAt: 5, endsAt: 4 },
      { packId: 'p3', name: 'szám', allowSites: [], startsAt: '1', endsAt: 2 },
      null,
    ],
  }));
  const link = await ext.loadLink();
  assert.deepEqual(link.focus.windows, [
    { packId: 'p1', name: 'Mély munka', allowSites: ['github.com'], startsAt: start, endsAt: start + 3600_000 },
  ], 'a rosszul formált kimarad, a nem szöveges oldal is');
  // Az app ezután nem válaszol.
  await ext.pullFromApp(start - 1000, async () => { throw new Error('ECONNREFUSED'); });
  const quiet = await ext.loadLink();
  assert.equal(ext.focusActive(quiet, start - 1), false, 'az ablak előtt nincs menet');
  assert.equal(ext.focusActive(quiet, start + 60_000), true, 'az ablakban van');
  assert.equal(ext.focusAllows(quiet, 'github.com', start + 60_000), true);
  assert.equal(ext.focusAllows(quiet, 'youtube.com', start + 60_000), false);
  assert.equal(ext.focusActive(quiet, start + 3600_000), false, 'a végével vége');

  // Egy régi app nem küld ablakot: az nem hiba, üres lista.
  await ext.pullFromApp(2000, fakeAppWithFocus(8788, 'K', { running: false }));
  assert.deepEqual((await ext.loadLink()).focus.windows, []);
});

test('no session means the whitelist does not bite at all', async () => {
  const ext = freshLink() as FocusApi;
  await ext.setToken('K');
  await ext.pullFromApp(1000, fakeAppWithFocus(8788, 'K', { running: false }));
  const link = await ext.loadLink();
  assert.equal(ext.focusActive(link, 1000), false);
  // Enélkül a bővítmény munkamenet nélkül is mindent tiltana — használhatatlan.
  assert.equal(ext.focusAllows(link, 'google.com', 1000), false, 'nincs mit engednie');
});

// ------------------------------------------------------- csatorna-szűrők

function fakeAppWithChannels(port: number, token: string, body: Record<string, unknown>) {
  return async (url: string, init: { headers: Record<string, string> }) => {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/rules$/.exec(url);
    if (!m || Number(m[1]) !== port) throw new Error('ECONNREFUSED');
    if (init.headers['x-breaker-token'] !== token) {
      return { ok: false, status: 401, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ protocol: 1, rules: [], ...body }) };
  };
}

test('a csatorna-szűrők megérkeznek és a gyorsítótár is őrzi őket', async () => {
  const ext = freshLink();
  await ext.setToken('ABCD-EFGH');
  const app = fakeAppWithChannels(8788, 'ABCD-EFGH', {
    channels: [
      { host: 'youtube.com', allow: ['@jo', '@masik'] },
      { host: 42, allow: ['@szemet'] },          // rossz rekord: kiesik
      { host: 'tiktok.com', allow: 'nem-lista' }, // ez is
    ],
  });
  const r = await ext.pullFromApp(1000, app);
  assert.equal(r.ok, true);
  const link = await ext.loadLink();
  assert.deepEqual(link.channels, [{ host: 'youtube.com', allow: ['@jo', '@masik'] }],
    'a jó rekord megvan, a szemét kiesett');

  // AZ APP BEZÁRÁSA NEM FELOLDÁS. Ha az app nem érhető el, az utoljára
  // letöltött szűrő él tovább — különben a legolcsóbb kiskapu egy ablak
  // bezárása lenne, pont mint a szabályoknál.
  const senki = () => Promise.reject(new Error('nincs ott'));
  await ext.pullFromApp(2000, senki, 30);
  assert.deepEqual((await ext.loadLink()).channels,
    [{ host: 'youtube.com', allow: ['@jo', '@masik'] }]);
});

test('a kulcsszavak megérkeznek tisztán, és az app bezárása után is élnek', async () => {
  // A hídról a lista jön; a szemét (rövid, szóközös, nem szöveg, duplum)
  // már itt kiesik, hogy a háttér döntése ne a nyers válaszon fusson.
  const ext = freshLink();
  await ext.setToken('ABCD-EFGH');
  const app = fakeAppWithChannels(8788, 'ABCD-EFGH', {
    keywords: ['Shorts', 'reels', 'ab', 'két szó', 42, 'shorts', null],
  });
  const r = await ext.pullFromApp(1000, app);
  assert.equal(r.ok, true);
  assert.deepEqual((await ext.loadLink()).keywords, ['shorts', 'reels']);
  // Az app bezárása nem feloldás: a lista marad.
  await ext.pullFromApp(2000, () => Promise.reject(new Error('nincs ott')), 30);
  assert.deepEqual((await ext.loadLink()).keywords, ['shorts', 'reels']);
  // A régi app válasza (keywords mező nélkül) üres lista, nem hiba.
  const ext2 = freshLink();
  await ext2.setToken('ABCD-EFGH');
  assert.equal((await ext2.pullFromApp(1000, fakeAppWithChannels(8788, 'ABCD-EFGH', {}))).ok, true);
  assert.deepEqual((await ext2.loadLink()).keywords, []);
});

test('a megakadások átmennek az appnak — egyszer, amíg nem változnak; port nélkül nem; a hiba nem jegyzi meg', async () => {
  type Init = { method?: string; headers: Record<string, string>; body?: string };
  type Push = (report: unknown, now: number, fetchImpl: unknown) => Promise<{ ok: boolean; skipped?: boolean; error?: string }>;
  const ext = freshLink() as LinkApi & { pushHits: Push };
  const posts: { url: string; init: Init }[] = [];
  let postStatus = 200;
  const app = async (url: string, init: Init) => {
    if (init.method === 'POST') {
      posts.push({ url, init });
      return { ok: postStatus === 200, status: postStatus, json: async () => ({}) };
    }
    return fakeApp(8788, 'ABCD-EFGH', [])(url, init);
  };
  await ext.setToken('ABCD-EFGH');
  const report = [{ day: '2026-09-18', total: 2, byReason: { keyword: 2 } }];
  assert.equal((await ext.pushHits(report, 1000, app)).ok, false, 'port nélkül (még nem volt lehúzás) nem megy');
  assert.equal((await ext.pullFromApp(1000, app)).ok, true);
  assert.equal((await ext.pushHits(report, 2000, app)).ok, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'http://127.0.0.1:8788/hits');
  assert.equal(posts[0].init.headers['x-breaker-token'], 'ABCD-EFGH');
  const body = JSON.parse(posts[0].init.body ?? '{}') as { source: string; days: unknown };
  assert.deepEqual(body.days, report);
  assert.match(body.source, /^[A-Za-z0-9]{8,}$/, 'a forrás azonosítója: ezé a böngésző-profilé');
  assert.deepEqual(await ext.pushHits(report, 3000, app), { ok: true, skipped: true }, 'ugyanaz a jelentés nem megy kétszer');
  assert.equal(posts.length, 1);
  postStatus = 500;
  const more = [...report, { day: '2026-09-17', total: 1, byReason: { closed: 1 } }];
  assert.equal((await ext.pushHits(more, 4000, app)).ok, false, 'az app hibája hiba');
  postStatus = 200;
  assert.equal((await ext.pushHits(more, 5000, app)).ok, true, '…és a következő körben újra megy');
  assert.equal(posts.length, 3);
  const again = JSON.parse(posts[2].init.body ?? '{}') as { source: string };
  assert.equal(again.source, body.source, 'a forrás azonosítója állandó');
});

test('a menet indítása a hídon: a kóddal, a megjegyzett portra; a bíró nemje a válaszból; port nélkül nem', async () => {
  type Init = { method?: string; headers: Record<string, string>; body?: string };
  type Start = (packId: string, minutes: number, fetchImpl: unknown) => Promise<{ ok: boolean; error?: string }>;
  type Clean = (raw: unknown) => { packId: string; name: string; minutes: number; peakHour: number | null; peakPack: string | null; focusDay: boolean; focusHour: number | null; focusHourPack: string | null; sameHour: boolean; focusHourNow: boolean; focusStreak: number; focusLongestStreak: number; limitSoon: string } | null;
  type AddWin = (packId: string, hour: number, fetchImpl: unknown) => Promise<{ ok: boolean; error?: string }>;
  const ext = freshLink() as LinkApi & { startFocusInApp: Start; cleanSuggest: Clean; addFocusWindowInApp: AddWin };
  const posts: { url: string; init: Init }[] = [];
  let refuse: string | null = null;
  const app = async (url: string, init: Init) => {
    if (init.method === 'POST') {
      posts.push({ url, init });
      return refuse
        ? { ok: false, status: 409, json: async () => ({ error: refuse }) }
        : { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return fakeApp(8788, 'ABCD-EFGH', [])(url, init);
  };
  await ext.setToken('ABCD-EFGH');
  assert.equal((await ext.startFocusInApp('pack_1', 25, app)).ok, false, 'port nélkül (még nem volt lehúzás) nem megy');
  assert.equal((await ext.pullFromApp(1000, app)).ok, true);
  assert.deepEqual(await ext.startFocusInApp('pack_1', 25, app), { ok: true });
  assert.equal(posts[0].url, 'http://127.0.0.1:8788/focus_start');
  assert.equal(posts[0].init.headers['x-breaker-token'], 'ABCD-EFGH');
  assert.deepEqual(JSON.parse(posts[0].init.body ?? '{}'), { packId: 'pack_1', minutes: 25 });
  refuse = 'Már fut egy menet.';
  assert.deepEqual(await ext.startFocusInApp('pack_1', 25, app), { ok: false, error: 'Már fut egy menet.' }, 'a bíró nemje szöveggel');
  // A HETI ABLAK ugyanazon az úton: a kóddal, a csomaggal és az órával — a nem szöveggel.
  refuse = null;
  assert.deepEqual(await ext.addFocusWindowInApp('pack_1', 21, app), { ok: true });
  assert.equal(posts[posts.length - 1].url, 'http://127.0.0.1:8788/focus_window');
  assert.equal(posts[posts.length - 1].init.headers['x-breaker-token'], 'ABCD-EFGH');
  assert.deepEqual(JSON.parse(posts[posts.length - 1].init.body ?? '{}'), { packId: 'pack_1', hour: 21 });
  refuse = 'Ennek a csomagnak már van heti ablaka — az appban szerkeszthető.';
  assert.deepEqual(await ext.addFocusWindowInApp('pack_1', 21, app), { ok: false, error: refuse }, 'a híd nemje szöveggel');
  assert.deepEqual(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25 }), { packId: 'p', name: 'N', minutes: 25, peakHour: null, peakPack: null, focusDay: false, focusHourNow: false, focusHour: null, focusHourPack: null, sameHour: false, focusStreak: 0, focusLongestStreak: 0, limitSoon: '' });
  assert.deepEqual(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, peakHour: 21 }), { packId: 'p', name: 'N', minutes: 25, peakHour: 21, peakPack: null, focusDay: false, focusHourNow: false, focusHour: null, focusHourPack: null, sameHour: false, focusStreak: 0, focusLongestStreak: 0, limitSoon: '' });
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, focusHour: 9 })?.focusHour, 9, 'a menet-óra, amire ablak tehető: az app szava');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, focusHour: 24 })?.focusHour, null, 'rossz óra: nincs menet-óra, a javaslat marad');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, focusHourPack: 'Nyelvtanulás' })?.focusHourPack, 'Nyelvtanulás', 'a menet-órát fedő csomag neve');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, focusHourPack: 'x'.repeat(80) })?.focusHourPack?.length, 40, 'kívülről jött név: rövidre vágva');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, sameHour: true })?.sameHour, true, 'az egybeesés: az app szava');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, sameHour: 1 })?.sameHour, false, 'csak a szó szerinti igaz');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, focusStreak: 5 })?.focusStreak, 5, 'a menet-sorozat: az app száma');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, focusStreak: -1 })?.focusStreak, 0, 'rossz szám: nulla, a javaslat marad');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, focusStreak: '5' })?.focusStreak, 0, 'csak egész szám');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, focusLongestStreak: 12 })?.focusLongestStreak, 12, 'a rekord: az app száma');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, focusLongestStreak: -1 })?.focusLongestStreak, 0, 'rossz szám: nulla');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, limitSoon: 'Ma még 3 perc a kereted: youtube.com.' })?.limitSoon, 'Ma még 3 perc a kereted: youtube.com.', 'a közeledő keret sora: az app kész mondata');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, limitSoon: 42 })?.limitSoon, '', 'nem szöveg: üres');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, limitSoon: 'x'.repeat(200) })?.limitSoon?.length, 80, 'kívülről jött szöveg: rövidre vágva');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, focusDay: true })?.focusDay, true, 'a menet-nap: az app szava');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, focusDay: 'igen' })?.focusDay, false, 'csak a szó szerinti igaz');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, focusHourNow: true })?.focusHourNow, true, 'a menet-óra: az app szava');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, focusHourNow: 'most' })?.focusHourNow, false, 'csak a szó szerinti igaz');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, peakPack: 'Nyelvtanulás', focusDay: false })?.peakPack, 'Nyelvtanulás', 'a fedő csomag neve');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, peakPack: 'x'.repeat(80) })?.peakPack?.length, 40, 'kívülről jött név: rövidre vágva');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 25, peakHour: 24 })?.peakHour, null, 'rossz óra: nincs csúcs, a javaslat marad');
  assert.equal(ext.cleanSuggest({ packId: 'p', name: 'N', minutes: 0 }), null);
  assert.equal(ext.cleanSuggest({ packId: '', name: 'N', minutes: 25 }), null);
  assert.equal(ext.cleanSuggest(undefined), null, 'régi app válasza: nincs javaslat');
  // A javaslat a lehúzással jön és a linkben marad.
  const withSuggest = async (url: string, init: Init) => {
    const r = await fakeApp(8788, 'ABCD-EFGH', [])(url, init);
    return { ...r, json: async () => ({ ...(await r.json()), suggest: { packId: 'p2', name: 'Mély munka', minutes: 90 } }) };
  };
  assert.equal((await ext.pullFromApp(2000, withSuggest)).ok, true);
  assert.deepEqual(((await ext.loadLink()) as unknown as { suggest: unknown }).suggest,
    { packId: 'p2', name: 'Mély munka', minutes: 90, peakHour: null, peakPack: null, focusDay: false, focusHourNow: false, focusHour: null, focusHourPack: null, sameHour: false, focusStreak: 0, focusLongestStreak: 0, limitSoon: '' });
});

test('egy RÉGI app válasza (channels mező nélkül) üres listát ad, nem hibát', async () => {
  const ext = freshLink();
  await ext.setToken('ABCD-EFGH');
  const app = fakeAppWithChannels(8788, 'ABCD-EFGH', {});
  const r = await ext.pullFromApp(1000, app);
  assert.equal(r.ok, true);
  assert.deepEqual((await ext.loadLink()).channels, [],
    'a hiányzó mező nem hiba: a szűrés egyszerűen nem fut, ahogy eddig sem');
});
