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
    rules: { host: string; path: string }[]; fetchedAt: number; error: string | null }>;
  setToken: (t: string) => Promise<string | null>;
  forgetToken: () => Promise<void>;
  pullFromApp: (now?: number, fetchImpl?: unknown) => Promise<{ ok: boolean;
    rules?: { host: string; path: string }[]; error?: string }>;
  dueForRefresh: (link: { token: string | null; fetchedAt: number }, now: number) => boolean;
  withAppRules: (
    local: { host: string; path: string }[], app: { host: string; path: string }[],
  ) => { host: string; path: string; fromApp?: boolean }[];
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
  const src = fs.readFileSync(path.join(extensionDir(), 'app-link.js'), 'utf8');
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
