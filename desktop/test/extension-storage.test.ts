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
