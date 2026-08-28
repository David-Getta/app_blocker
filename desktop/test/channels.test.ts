import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from '../src/shared/channels';

/**
 * A csatorna-szűrő magja KÉT példányban él: a bővítmény a saját JS-ét viszi,
 * a segéd és a felület a TypeScript ikret. Ez a fájl a KISZÁLLÍTOTT
 * bővítmény-bájtokat futtatja ugyanazon a bemenet-készleten, és a két oldal
 * eredményét hasonlítja — ha szétcsúsznak, az app mást engedélyezne, mint
 * amit a böngésző tilt, és senki nem venné észre.
 */

function extensionDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'extension');
    if (fs.existsSync(path.join(candidate, 'channels.js'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('nem talalom az extension/ mappat');
}

function loadExtensionChannels(): typeof ts {
  const src = fs.readFileSync(path.join(extensionDir(), 'channels.js'), 'utf8');
  const names: string[] = [];
  const body = src.replace(/^export (const|function) (\w+)/gm, (_m, kind, name) => {
    names.push(name as string);
    return `${kind} ${name}`;
  });
  if (names.length < 5) throw new Error('a bővítmény csatorna-magja nem exportál eleget');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn { ${names.join(', ')} };`)() as typeof ts;
}

const ext = loadExtensionChannels();

// ---------------------------------------------------------------- paritás

/** Amit az ember beírhat — a jókat és a szemetet is. */
const ENTRY_INPUTS = [
  '@Kurzgesagt', 'kurzgesagt', 'https://www.youtube.com/@Valaki/videos?x=1',
  'youtube.com/@Valaki', '/channel/UCabc123', 'channel/UCabc123', 'c/SomeName',
  'user/OldStyle', 'https://www.youtube.com/channel/UCabc123', '@', '', '   ',
  'két szó', 'https://youtube.com', '/watch', 'tiktok.com/@Valaki/video/123',
  '@nagyon.pontos-név_2', 'https://www.twitch.tv/streamer',
];

const PATH_INPUTS = [
  '/@Kurzgesagt/videos', '/@valaki', '/watch', '/results?q=@x', '/channel/UCx',
  '/c/Name/videos', '/user/Old', '/channel/', '/c', '/', '', '/@',
  '/%40Encoded', '/shorts/abc', '/feed/subscriptions', '/@Valaki?tab=1',
];

const URL_INPUTS = [
  'https://www.youtube.com/@rossz',
  'https://youtube.com/@jo/videos',
  'https://m.youtube.com/@rossz',
  'https://www.youtube.com/watch?v=abc',
  'https://www.youtube.com/channel/UCrossz',
  'https://mas-oldal.hu/@rossz',
  'http://user:pass@www.youtube.com/@rossz',
  'chrome://settings', 'nem-cím',
];

const CHANNELS = [{ host: 'youtube.com', allow: ['@jo', 'channel/ucjo'] }];

test('a bővítmény és az app UGYANAZT a kulcsot adja minden bemenetre', () => {
  for (const input of ENTRY_INPUTS) {
    assert.equal(
      ext.normalizeChannelEntry(input), ts.normalizeChannelEntry(input),
      `normalizeChannelEntry eltér ezen: ${JSON.stringify(input)}`,
    );
  }
  for (const input of PATH_INPUTS) {
    assert.equal(
      ext.channelKeyFromPath(input), ts.channelKeyFromPath(input),
      `channelKeyFromPath eltér ezen: ${JSON.stringify(input)}`,
    );
  }
  for (const input of ENTRY_INPUTS) {
    assert.equal(
      ext.normalizeFilterHost(input), ts.normalizeFilterHost(input),
      `normalizeFilterHost eltér ezen: ${JSON.stringify(input)}`,
    );
  }
  for (const url of URL_INPUTS) {
    assert.deepEqual(
      ext.channelVerdict(url, CHANNELS), ts.channelVerdict(url, CHANNELS),
      `channelVerdict eltér ezen: ${JSON.stringify(url)}`,
    );
  }
});

test('a korlátok is ugyanazok a két oldalon', () => {
  assert.equal(ext.MAX_CHANNEL_FILTERS, ts.MAX_CHANNEL_FILTERS);
  assert.equal(ext.MAX_ALLOW_PER_FILTER, ts.MAX_ALLOW_PER_FILTER);
  assert.equal(ext.MAX_CHANNEL_KEY_LENGTH, ts.MAX_CHANNEL_KEY_LENGTH);
});

// ------------------------------------------------------------- viselkedés

test('a tiltás a csatorna-alakú címekre szűkül', () => {
  const v = (url: string) => ext.channelVerdict(url, CHANNELS);
  assert.deepEqual(v('https://www.youtube.com/@rossz'), { host: 'youtube.com', key: '@rossz' });
  assert.equal(v('https://youtube.com/@jo/videos'), null, 'az engedélyezett mehet');
  assert.deepEqual(v('https://m.youtube.com/@rossz'), { host: 'youtube.com', key: '@rossz' },
    'az aldomain is a szűrő alá esik');
  assert.equal(v('https://www.youtube.com/watch?v=abc'), null,
    'ami nem csatorna-alakú, az szabad — kezdőlap, keresés, videó');
  assert.equal(v('https://www.youtube.com/channel/UCjo'), null, 'a channel/ forma is engedélyezhető');
  assert.deepEqual(v('https://www.youtube.com/channel/UCrossz'), { host: 'youtube.com', key: 'channel/ucrossz' });
  assert.equal(v('https://mas-oldal.hu/@rossz'), null, 'más oldalra a szűrő nem szól');
  assert.equal(v('chrome://settings', ), null, 'nem-web címekhez nem nyúlunk');
});

test('a felhasználónév a címben nem téveszti meg a hoszt-illesztést', () => {
  // A `user:pass@` alak a @ miatt könnyen összekeverhető a csatornával — a
  // hosztot a @ UTÁN kell keresni, a kulcsot meg az útvonalban.
  assert.deepEqual(
    ext.channelVerdict('http://user:pass@www.youtube.com/@rossz', CHANNELS),
    { host: 'youtube.com', key: '@rossz' },
  );
});

// ------------------------------------------------------------- tisztítás

test('a mentés előtti tisztítás eldobja a szemetet, de megtartja a jót', () => {
  const f = ts.sanitizeFilter({
    host: 'https://www.YouTube.com/', enabled: true,
    allow: ['@Jo', 'jo', '   ', 'két szó', 'https://www.youtube.com/@Masik/videos', '@jo'],
  });
  assert.ok(f);
  assert.equal(f!.host, 'youtube.com');
  assert.deepEqual(f!.allow, ['@jo', '@masik'], 'kisbetűs, kettőzés és szemét nélkül');
  assert.equal(f!.enabled, true);
});

test('üres fehérlistával a szűrő érvénytelen', () => {
  // Egy bekapcsolt, üres fehérlistájú szűrő az oldal ÖSSZES csatornáját
  // tiltaná — ha ezt akarja valaki, arra ott a teljes tiltás, kimondva.
  assert.equal(ts.sanitizeFilter({ host: 'youtube.com', allow: ['  ', 'két szó'], enabled: true }), null);
  assert.equal(ts.sanitizeFilter({ host: 'nem jó hoszt', allow: ['@jo'], enabled: true }), null);
});

// ---------------------------------------------------------------- lazítás

const BASE: ts.ChannelFilter = { id: 'f1', host: 'youtube.com', allow: ['@jo'], enabled: true };

test('mi lazítás és mi nem — mert a lazítás próbatételbe kerül', () => {
  const next = (p: Partial<Omit<ts.ChannelFilter, 'id'>>) =>
    ({ host: BASE.host, allow: BASE.allow, enabled: BASE.enabled, ...p });
  assert.equal(ts.isFilterLoosening(undefined, next({})), false, 'új szűrő: szigorítás, ingyen');
  assert.equal(ts.isFilterLoosening({ ...BASE, enabled: false }, next({})), false,
    'kikapcsolt szűrőn minden módosítás ingyen van');
  assert.equal(ts.isFilterLoosening(BASE, next({ enabled: false })), true, 'a kikapcsolás lazítás');
  assert.equal(ts.isFilterLoosening(BASE, next({ host: 'tiktok.com' })), true,
    'a gazdagép cseréje felszabadítja a régit — lazítás');
  assert.equal(ts.isFilterLoosening(BASE, next({ allow: ['@jo', '@uj'] })), true,
    'új engedélyezett csatorna bekapcsolt szűrőn: több nyílik meg — lazítás');
  assert.equal(ts.isFilterLoosening(BASE, next({ allow: [] })), false,
    'engedélyezett csatorna levétele: szigorítás, ingyen');
});
