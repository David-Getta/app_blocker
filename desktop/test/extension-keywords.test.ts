// A KISZÁLLÍTOTT `extension/keywords.js` szeletelt tesztje — és a párja a
// maggal: a bővítmény ugyanazt a szót ugyanarra a címre találja, mint a gép.
//
// Ha a két illesztés szétcsúszna, a felület azt mondaná, „shorts” tiltva, a
// böngésző meg átengedné — vagy fordítva: olyat tiltana, amit senki nem kért.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  cleanKeywords as coreClean, keywordHit as coreHit, normalizeKeyword as coreNormalize,
} from '../src/shared/keywords';

function extensionDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const cand = path.join(dir, 'extension');
    if (fs.existsSync(path.join(cand, 'keywords.js'))) return cand;
    dir = path.dirname(dir);
  }
  throw new Error('nem talalom az extension/ mappat');
}

interface KeywordsApi {
  MAX_KEYWORDS: number;
  normalizeKeyword: (raw: unknown) => string | null;
  cleanKeywords: (raw: unknown) => string[];
  keywordHaystack: (url: unknown) => string;
  keywordHit: (keywords: unknown, url: unknown) => string | null;
}

function load(): KeywordsApi {
  const src = fs.readFileSync(path.join(extensionDir(), 'keywords.js'), 'utf8').replace(/^export /gm, '');
  // eslint-disable-next-line no-new-func
  return new Function(
    `${src}\nreturn { MAX_KEYWORDS, normalizeKeyword, cleanKeywords, keywordHaystack, keywordHit };`,
  )() as KeywordsApi;
}

const URLS = [
  'https://www.youtube.com/shorts/abc123',
  'https://www.youtube.com/watch?v=x&list=SHORTS',
  'https://www.tiktok.com/@valaki/video/1',
  'https://example.com/j%C3%A1t%C3%A9k/lista',
  'https://example.com/%E1%A0%',
  'https://m.example.com/',
  'http://127.0.0.1:8080/?x=tiltottdolog',
  'chrome://extensions/',
  '',
  'nem-is-cím',
];
const WORDS = ['shorts', 'tiktok', 'játék', 'tiltott', 'Reels', 'ab', 'két szó'];

test('a bővítmény ugyanazt találja, mint a mag — cím és lista minden párján', () => {
  const ext = load();
  for (const url of URLS) {
    assert.equal(ext.keywordHit(WORDS, url), coreHit(WORDS, url), url);
  }
  for (const w of [...WORDS, '  Shorts ', 42, null, 'x'.repeat(41), 'a' + String.fromCharCode(0x0301) + 'lom']) {
    assert.equal(ext.normalizeKeyword(w), coreNormalize(w), String(w));
  }
  assert.deepEqual(ext.cleanKeywords(WORDS), coreClean(WORDS));
  assert.equal(ext.MAX_KEYWORDS, 40);
});

test('a bővítmény tisztít és illeszt: rossz kódolás nem dob, a séma nem számít', () => {
  const ext = load();
  assert.deepEqual(ext.cleanKeywords(['Shorts', 'shorts', 'ab', 'két szó', null, 42, 'reels']), ['shorts', 'reels']);
  assert.equal(ext.keywordHit(['shorts'], 'https://www.youtube.com/shorts/abc'), 'shorts');
  assert.equal(ext.keywordHit(['https'], 'https://example.com/'), null, 'a séma nem a cím része');
  assert.equal(ext.keywordHit(['játék'], 'https://example.com/j%C3%A1t%C3%A9k'), 'játék', 'százalék-kódolás feloldva');
  assert.equal(ext.keywordHit(['shorts'], 'https://example.com/%E1%A0%shorts'), 'shorts', 'rossz kódolás: marad, ahogy jött');
  assert.equal(ext.keywordHit(['shorts'], 'https://example.com/'), null);
  assert.equal(ext.keywordHit('nem lista', 'https://example.com/shorts'), null);
  assert.equal(ext.keywordHit(['shorts', 'reels'], 'https://example.com/reels/shorts'), 'shorts',
    'a lista sorrendje dönt, nem a cím');
});
