// A bővítmény szabály-magja és az appé UGYANAZT kell mondja.
//
// Ez a legcsendesebb elromlás, amit ez a funkció produkálni tud: az ember
// felvesz egy szabályt az appban, ott szépen megjelenik, a böngésző meg
// átengedi az oldalt. Semmi nem hibázik, semmi nem naplózódik — egyszerűen nem
// az történik, amit kért.
//
// A két megvalósítás azért külön, mert máshol fut: a bővítményben nincs
// fordítás, a segédben viszont TypeScript van. A KÖZÖS pontjuk ez a táblázat.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from '../src/shared/urlrules';

/**
 * A bővítmény magja ESM, a tesztfuttató viszont CommonJS-be fordít — egy sima
 * `import` itt nem megy. Ezért a fájlt BEOLVASSUK és lefuttatjuk.
 *
 * Ez nem kerülő út, hanem pontosan az, amit akarunk: a teszt a ténylegesen
 * kiszállított bájtokat hajtja végre, nem egy másolatot róluk.
 */
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

function loadExtensionCore(): typeof ts {
  const file = path.join(extensionDir(), 'rules-core.js');
  const src = fs.readFileSync(file, 'utf8');
  const names: string[] = [];
  const body = src.replace(/^export (const|function) (\w+)/gm, (_m, kind, name) => {
    names.push(name as string);
    return `${kind} ${name}`;
  });
  if (names.length < 5) throw new Error('a bővítmény magja nem exportál eleget');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn { ${names.join(', ')} };`)() as typeof ts;
}

const ext = loadExtensionCore();

/** Amit az ember beírhat — a jókat és a szemetet is. */
const INPUTS = [
  'youtube.com/@valaki',
  'https://www.youtube.com/@valaki',
  'https://www.YouTube.com/@Valaki/videos?x=1',
  'www.youtube.com//@valaki/',
  'youtube.com/channel/UCabc123',
  'reddit.com/r/hirek/',
  'old.reddit.com/r/hirek',
  'youtube.com',
  'https://youtube.com',
  'youtube.com/',
  'youtube.com/?x=1',
  '/@valaki',
  '@valaki',
  '',
  '   ',
  'nem egy cím',
  'youtube.com/@va laki',
  'http://youtube.com:8080/@valaki',
  'youtube.com/#horgony',
  `youtube.com/${'a'.repeat(250)}`,
];

/** Amivel a böngésző tényleg megkeresi a szabályt. */
const URLS = [
  'https://www.youtube.com/@valaki',
  'https://www.youtube.com/@valaki/videos',
  'https://www.youtube.com/@valakimas',
  'https://m.youtube.com/@valaki',
  'https://youtube.com/@VALAKI/',
  'https://www.youtube.com/',
  'https://www.youtube.com/watch?v=abc',
  'https://notyoutube.com/@valaki',
  'https://youtube.com.hamis.hu/@valaki',
  'https://old.reddit.com/r/hirek/top',
  'https://reddit.com/r/hirekx',
  'about:blank',
  'chrome://extensions',
  '',
  'nem url',
];

test('the two rule cores read the same input the same way', () => {
  for (const input of INPUTS) {
    assert.deepEqual(
      ext.normalizeRule(input), ts.normalizeRule(input),
      `eltérés a beírt szövegnél: ${JSON.stringify(input)}`,
    );
  }
});

test('the two rule cores match the same URLs', () => {
  // Minden érvényes szabályt minden URL-lel összevetünk. Ez a szorzat az, ami
  // egy egyedi eltérést is elkap — nem csak a kényelmes eseteket.
  const rules = INPUTS.map((i) => ts.normalizeRule(i)).filter(Boolean) as ts.UrlRule[];
  assert.ok(rules.length >= 6, 'legyen mit összevetni');
  for (const rule of rules) {
    for (const url of URLS) {
      assert.equal(
        ext.matchesRule(rule, url), ts.matchesRule(rule, url),
        `eltérés: ${ts.ruleLabel(rule)} vs ${JSON.stringify(url)}`,
      );
    }
  }
});

test('the two cores agree on the whole rule list and on the label', () => {
  const rules = [ts.normalizeRule('youtube.com/@a')!, ts.normalizeRule('reddit.com/r/hirek')!];
  for (const url of URLS) {
    assert.equal(ext.anyRuleMatches(rules, url), ts.anyRuleMatches(rules, url), url);
  }
  for (const rule of rules) {
    assert.equal(ext.ruleLabel(rule), ts.ruleLabel(rule));
  }
  assert.equal(ext.MAX_RULE_PATH_LENGTH, ts.MAX_RULE_PATH_LENGTH);
});

test('the extension can say WHICH rule caught the page', () => {
  // A tiltó lapnak meg kell tudnia nevezni, mi miatt állt meg. Egy általános
  // „valami tiltva van” önmagában értelmezhetetlen — és ilyenkor az ember az
  // egészet kapcsolja ki, nem az egy szabályt javítja.
  const rules = [ts.normalizeRule('youtube.com/@a')!, ts.normalizeRule('youtube.com/@b')!];
  const hit = (ext as unknown as {
    firstMatch: (r: ts.UrlRule[], u: string) => ts.UrlRule | null;
  }).firstMatch(rules, 'https://www.youtube.com/@b/videos');
  assert.deepEqual(hit, rules[1]);
});
