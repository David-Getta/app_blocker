// A BŐVÍTMÉNY is visszajátssza a közös szöveg-fixtúrát.
//
// A böngészőben a bővítmény dönt a teljes címről: a kulcsszóról és a részleges
// szabályról — a saját, fordítás nélküli másolatával (`extension/keywords.js`,
// `extension/rules-core.js`). A két telefon a `fixtures/text-cases.json`-t
// játssza vissza; ha a bővítmény ugyanazt a beírást másképp olvasná, az app
// azt mondaná, a szabály él, a böngésző meg átengedné — vagy a bővítmény
// beállítás-lapja elutasítaná azt, amit az app elfogadott. Ez pont így volt: a
// bővítmény az út hosszát UTF-16 egységben mérte, az app kódpontban, és hat
// emodzsis szabályt a fixtúrából a bővítmény nem fogadott el.
//
// A teszt a KISZÁLLÍTOTT bájtokat futtatja (beolvasva, az `export` szó
// nélkül), nem egy másolatot róluk.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface TextCase { in: string; out: string | null }
interface ListCase { in: string[]; out: string[] }
interface MatchCase { rule: string; url: string; out: boolean }
interface Fixture { rule: TextCase[]; ruleMatch: MatchCase[]; keyword: TextCase[]; keywords: ListCase[] }

interface Rule { host: string; path: string }
interface RulesApi {
  normalizeRule: (input: unknown) => Rule | null;
  matchesRule: (rule: Rule, url: string) => boolean;
  ruleLabel: (rule: Rule) => string;
}
interface KeywordsApi {
  normalizeKeyword: (raw: unknown) => string | null;
  cleanKeywords: (raw: unknown) => string[];
  keywordHit: (keywords: unknown, url: unknown) => string | null;
}

function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'extension', 'rules-core.js')) && fs.existsSync(path.join(dir, 'fixtures'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('nem találom a tároló gyökerét (extension/ és fixtures/)');
}

/** A kiszállított ESM-fájl, az `export` szó nélkül lefuttatva — minden exportja. */
function loadShipped<T>(file: string): T {
  const src = fs.readFileSync(path.join(repoRoot(), 'extension', file), 'utf8');
  const names: string[] = [];
  const body = src.replace(/^export (const|function) (\w+)/gm, (_m, kind: string, name: string) => {
    names.push(name);
    return `${kind} ${name}`;
  });
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn { ${names.join(', ')} };`)() as T;
}

const fixture = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'fixtures', 'text-cases.json'), 'utf8')) as Fixture;
const rules = loadShipped<RulesApi>('rules-core.js');
const keywords = loadShipped<KeywordsApi>('keywords.js');
const show = (s: string) => JSON.stringify(s);

test('a bővítmény a részleges szabályt ugyanúgy olvassa, mint az app és a két telefon', () => {
  assert.ok(fixture.rule.length > 50, 'a fixtúra csonka');
  for (const c of fixture.rule) {
    const r = rules.normalizeRule(c.in);
    assert.equal(r ? `${r.host}|${r.path}` : null, c.out, `szabály: ${show(c.in)}`);
  }
});

test('a bővítmény a szabályt ugyanarra a címre illeszti, mint az app és a két telefon', () => {
  assert.ok(fixture.ruleMatch.length > 50, 'a fixtúra csonka');
  for (const c of fixture.ruleMatch) {
    const r = rules.normalizeRule(c.rule);
    assert.ok(r, `az illesztendő szabály a bővítményben nem szabály: ${show(c.rule)}`);
    assert.equal(rules.matchesRule(r, c.url), c.out, `${show(c.rule)} ~ ${show(c.url)}`);
  }
});

test('a bővítmény a kulcsszót és a listát ugyanúgy tisztítja, mint az app és a két telefon', () => {
  assert.ok(fixture.keyword.length > 50, 'a fixtúra csonka');
  for (const c of fixture.keyword) assert.equal(keywords.normalizeKeyword(c.in), c.out, `kulcsszó: ${show(c.in)}`);
  for (const c of fixture.keywords) assert.deepEqual(keywords.cleanKeywords(c.in), c.out, `lista: ${show(c.in.join('|'))}`);
});

test('a bővítmény kulcsszó-találata a tisztított listával: a fixtúra minden szava a saját címén', () => {
  // Minden érvényes szó megtalálja magát egy őt tartalmazó címben — és a
  // tisztítás előtti alakja is ugyanazt a szót adja (a bővítmény a hídon
  // tisztítatlan listát is kaphat).
  for (const c of fixture.keyword) {
    if (c.out === null) continue;
    const url = `https://example.com/${encodeURIComponent(c.out)}/x`;
    assert.equal(keywords.keywordHit([c.in], url), c.out, `találat: ${show(c.in)}`);
  }
});
