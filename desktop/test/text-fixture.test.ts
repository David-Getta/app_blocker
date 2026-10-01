// Megfelelőségi fixtúra a SZÖVEG-TISZTÍTÁSRA: a három nyelv ugyanazt tartja
// érvényesnek, és ugyanarra tisztítja.
//
// A fésülés fixtúrája (merge-cases.json) azt nézi, hogy a három mag ugyanazt
// SZÁMOLJA ugyanabból. Ez a fájl egy réteggel lejjebb néz: ugyanazt a
// SZÖVEGET is ugyanannak látják-e. A fedőnév, az indok, a kulcsszó, a
// megbízott neve és jelmondata, a domain mind a felhasználó billentyűzetéről
// jön, és mind a szinkronon át utazik; ha a két telefon és a gép máshol vág,
// mást tart szóköznek, vagy másképp számol hosszt, a rekord minden körben
// átíródik — vagy a jelmondat az egyik eszközön nem nyit.
//
// A buktatók, amiket a fixtúra kimond: a JS `\s` a BOM-ot (U+FEFF) is
// szóköznek veszi, a Kotlin és a Swift saját fogalma nem; a Java regex `\s`-e
// csak ASCII (a nem törő szóköz nem az); a Swift `prefix` grafémát számol, a
// Kotlin `take` UTF-16 egységet — és a gépi `slice` is azt számolta, egy
// emodzsit félbe vágva, párja nélküli helyettesítőt hagyva a rekordban.
//
// A fájl csupa ASCII: a láthatatlan jelek (BOM, nem törő szóköz, nulla
// szélességű szóköz) `\uXXXX` alakban állnak, hogy aki olvassa, lássa őket.
//
//   UPDATE_TEXT_FIXTURE=1 npm test     — a fájl újraírása

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MAX_ALIAS_LENGTH, MAX_REASON_LENGTH, WHITESPACE_CODE_POINTS, normalizeAlias, normalizeReason,
} from '../src/shared/alias';
import { MAX_KEYWORDS, cleanKeywords, normalizeKeyword } from '../src/shared/keywords';
import { MAX_PARTNER_NAME, normalizePartnerName, normalizePhrase } from '../src/shared/partner';
import { normalizeDomain } from '../src/shared/blocklist';
import { matchesRule, normalizeRule, type UrlRule } from '../src/shared/urlrules';
import { rng } from './merge-random';

/** dist-test/test/… → a tároló gyökere. */
const FIXTURE = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'text-cases.json');
/** Ennyi véletlen összerakás szekciónként a kézzel válogatott esetek mellé. */
const SEEDS = 60;

interface TextCase { in: string; out: string | null }
interface ListCase { in: string[]; out: string[] }
interface MatchCase { rule: string; url: string; out: boolean }
interface Fixture {
  note: string; version: number;
  alias: TextCase[]; reason: TextCase[]; keyword: TextCase[]; keywords: ListCase[];
  partnerName: TextCase[]; phrase: TextCase[]; domain: TextCase[];
  rule: TextCase[]; ruleMatch: MatchCase[];
}

// ----------------------------------------------------- a részleges szabály
//
// A szabályt a gépen és Androidon is kézzel írják be, és a szinkronon utazik
// (a jelével); a döntést (illik-e egy címre) a gép bővítménye hozza, de a
// mag mindhárom nyelvben ott áll. A kanonikus alak eltérése a rekordot minden
// körben átírná; az illesztés eltérése egy csatornát az egyik gépen tiltana,
// a másikon nem.

const RULE_SCHEMES = ['', '', 'https://', 'HTTP://', 'ftp://'];
const RULE_USERS = ['', '', '', 'user:pw@'];
const RULE_HOSTS = [
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'mobile.youtube.com', 'M.YouTube.com', 'm.hu', 'reddit.com',
  'sub.reddit.com', 'müller.de', '192.168.1.1', 'youtube', 'youtube.com.',
];
const RULE_PORTS = ['', '', '', ':443', ':x'];
const RULE_PATHS = [
  '', '/', '/@valaki', '/@valaki/', '/@Valaki/videos', '//@valaki//', '/r/hirek', '/ΟΔΟΣ', '/@val aki', '/@val\u00a0aki',
  `/${'a'.repeat(205)}`, `/${'🍕'.repeat(100)}`, '/x\u0301', '/@valaki\u200b', '/İ',
];
const RULE_TAILS = ['', '', '?v=1', '#top', '?x#y', '/'];

const CURATED_RULES = [
  'youtube.com/@valaki', 'https://www.youtube.com/@valaki/videos?x=1', 'www.reddit.com/r/hirek/', 'm.youtube.com/@valaki',
  'mobile.twitter.com/valaki', 'm.hu/x', 'youtube.com', '/@valaki', 'youtube.com/', 'youtube.com//@valaki//videos//',
  'youtube.com/@Valaki', 'YOUTUBE.COM/@VALAKI', 'youtube.com/@valaki#top', 'youtube.com/?v=1', 'youtube.com/@val aki',
  'youtube.com/@val\u0000aki', 'youtube.com/@val\u00a0aki', 'youtube.com/ΟΔΟΣ', `youtube.com/${'a'.repeat(199)}`,
  `youtube.com/${'a'.repeat(200)}`, `youtube.com/${'é'.repeat(199)}`, `youtube.com/${'🍕'.repeat(100)}`,
  `youtube.com/${'🍕'.repeat(101)}`, 'user:pw@youtube.com/@valaki', 'http://youtube.com:8080/@valaki',
  '\ufeffyoutube.com/@valaki\ufeff', ' youtube.com/@valaki ', 'youtube.com/@valaki/', 'youtube.com/@valaki?', 'müller.de/x',
  'xn--mller-kva.de/x', '', 'ftp://youtube.com/@valaki', 'youtube.com/@valaki\n', 'youtube.com./@valaki', 'youtube.com/İ',
];

/** A szabályok, amiket a címekre illesztünk — a gép kanonikus alakjában. */
const MATCH_RULES = [
  'youtube.com/@valaki', 'reddit.com/r/hirek', 'm.youtube.com/@valaki', 'youtube.com/@ab', 'youtube.com/ΟΔΟΣ',
  'youtube.com/@valaki/videos', 'youtube.com/@val\u00a0aki',
];
const MATCH_HOSTS = [
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'notyoutube.com', 'youtube.com.evil.com',
  'reddit.com', 'old.reddit.com', 'YOUTUBE.COM', 'youtube.com.',
];
const MATCH_PATHS = [
  '/@valaki', '/@valaki/', '/@valaki/videos', '/@valakix', '/@VALAKI', '/@ab', '/@abc', '/@ab/c', '//@valaki', '/r/hirek',
  '/r/hirek/', '/r/hirekx', '/ΟΔΟΣ', '/οδος', '/οδοσ', '/', '', '/@val\u00a0aki', '/@val%20aki',
];
const CURATED_MATCHES: Array<[string, string]> = [
  ['youtube.com/@valaki', 'https://m.youtube.com/@valaki/videos?x'],
  ['youtube.com/@ab', 'youtube.com/@abc'],
  ['youtube.com/@ab', 'youtube.com/@ab/c'],
  ['youtube.com/ΟΔΟΣ', 'youtube.com/ΟΔΟΣ'],
  ['youtube.com/ΟΔΟΣ', 'youtube.com/οδος'],
  ['youtube.com/ΟΔΟΣ', 'youtube.com/οδοσ'],
  ['youtube.com/@valaki', 'notyoutube.com/@valaki'],
  ['youtube.com/@valaki', 'youtube.com.evil.com/@valaki'],
  ['youtube.com/@valaki', '\ufeffhttps://youtube.com/@valaki\ufeff'],
  ['youtube.com/@valaki', 'youtube.com//@valaki//'],
  ['youtube.com/@valaki', 'YOUTUBE.COM/@VALAKI#x'],
  ['youtube.com/@valaki', ''],
];

const ruleKey = (r: UrlRule | null) => (r ? `${r.host}|${r.path}` : null);

const WS = WHITESPACE_CODE_POINTS.map((c) => String.fromCodePoint(c));

/**
 * Darabok a véletlen összerakáshoz: betűk, szóközök minden fajtából,
 * láthatatlan nem-szóközök, vezérlők, bontott és összetett ékezet, NFKC-
 * érzékeny jelek (teljes szélességű betű, ligatúra, bekarikázott szám, római
 * szám, félszélességű katakana), emodzsik (egyszerű, ZWJ-sorozat, zászló), és
 * hosszú futamok a plafonok környékére.
 */
const FRAGMENTS = [
  'A', 'videós', 'Shorts', 'REELS', 'live', 'ab', 'alma', 'Bogrács',
  ' ', '  ', '\t', '\n', '\r\n', '\u000b', '\u00a0', '\u1680', '\u2003', '\u2028', '\u202f', '\u3000', '\ufeff',
  '\u200b', '\u200d', '\u2060',
  '\u0000', '\u0007', '\u001f', '\u007f', '\u0085', '\u009f',
  'é', 'e\u0301', 'ő', 'İ', 'ß', 'ΟΔΟΣ', 'straße',
  '\uff21\uff22\uff23', 'ﬁlm', '①②③', 'Ⅻ', '\uff7c\uff6e\uff70\uff84', '㎞',
  '🍕', '🍕🍕', '👨\u200d👩\u200d👧', '🇭🇺', '🏳\ufe0f\u200d🌈',
  'x'.repeat(17), 'x'.repeat(38), '🍕'.repeat(21), 'e\u0301'.repeat(21),
  '-', '_', '.', ',', '!', '"', '\\', '/',
];

/** Domain-darabok: séma, felhasználó, www, nagybetű, port, út, pontok, szóközök, nem latin. */
const DOMAIN_FRAGMENTS = [
  'https://', 'HTTP://', 'user:pw@', 'www.', 'WWW.', 'm.', 'youtube', 'YouTube', 'tik-tok', '9gag',
  '.com', '.COM', '.hu', ':443', '/watch?v=1', '#f', '?q', '.', '..', ' ', '\u00a0', '\ufeff', '\u200b',
  '-', '_', 'a'.repeat(63), 'ü', '\uff59\uff4f\uff55', '🍕', '',
];

/** Kézzel válogatott szövegek: a buktatók név szerint. */
function curatedTexts(): string[] {
  const out: string[] = [
    '', '   ', '\u00a0', '\ufeff', '\u200b', 'A', 'ab', 'abc',
    'A videós', '  A    videós  ', '\n\tA videós\n', 'A\u00a0videós', '\ufeffA videós\ufeff', 'A\u200bvideós',
    'A\u0000vide\u001fós\u007f', 'A\u0001\u0301B', 'A\u0085B', 'A\u2028B', 'A\u2060B',
    `${'a'.repeat(39)}🍕🍕`, '🍕'.repeat(45), 'e\u0301'.repeat(30), `${'a'.repeat(39)} bbbb`, 'x'.repeat(60),
    'x'.repeat(150), 'szó '.repeat(40), `${'x'.repeat(139)} y`, `${'x'.repeat(140)}y`,
    'Shorts', ' Shorts ', 'SHORTS', '\uff33\uff28\uff2f\uff32\uff34\uff33', 'ﬁlm', '①②③', 'Ⅻ', '\uff7c\uff6e\uff70\uff84', '㎞', 'ΟΔΟΣ', 'İstanbul', 'straße', 'STRASSE',
    // A görög szó végi szigma: a JS és a Java ς-t ad (Final_Sigma), a Swift
    // `lowercased()` σ-t adott — a tükör a szabályt maga alkalmazza.
    'ΣΟΦΟΣ', 'Σ', 'ΟΔΟΣ.', 'ΟΔΟΣ ΟΔΟΣ', 'ΑΣ\u0301Α', 'ΟΔΟΣ\u200bΟΔΟΣ', 'Σ ΑΣΑ',
    // A már kisbetűs σ marad σ: a szabály csak a nagy Σ-ra szól.
    'οδοσ', 'οδος', 'ΟΔΟΣ οδοσ', 'σ', 'Σσ',
    'két szó', 'két\u00a0szó', 'két\ufeffszó', 'két\u200bszó', '🍕🍕', '🍕🍕🍕', 'x'.repeat(40), 'x'.repeat(41),
    'a\u0301lom', 'álom', 'alma bogrács cinege délután', 'Alma  Bogrács\tCinege\u00a0Délután', '\ufeffalma\u3000bogrács',
  ];
  // Minden szóköz-fajta külön: belül (egy szóközre), a szélen (le), halmozva.
  for (const w of WS) out.push(`a${w}b`, `${w}ab${w}`, `${w}${w}a${w}${w}b${w}${w}`);
  return out;
}

/** Kézzel válogatott domainek: ami a felhasználó beilleszthet, és ami nem domain. */
function curatedDomains(): string[] {
  return [
    'youtube.com', 'YouTube.com', ' youtube.com ', 'https://www.youtube.com/watch?v=x', 'm.youtube.com/',
    'www.youtube.com.', 'user:pw@youtube.com:443/path', 'HTTP://YOUTUBE.COM', 'ftp://youtube.com', 'youtube.com:8080',
    'youtube.com#frag', 'youtube.com?q=1', '\ufeffyoutube.com\ufeff', '\u00a0youtube.com\u00a0', 'youtube\u00a0.com',
    'youtube.com\u200b', 'you tube.com', 'müller.de', 'xn--mller-kva.de', 'MÜLLER.DE', '9gag.com', '-abc.com', 'abc-.com',
    'a.b', 'a', 'localhost', '.com', 'com.', `${'a'.repeat(63)}.com`, `${'a'.repeat(64)}.com`, 'www.', 'www.www.youtube.com',
    'youtube..com', 'youtube.com..', '', '   ', 'https://', 'http://user@', '\uff59\uff4f\uff55\uff54\uff55\uff42\uff45.com', 'İ.com', 'youtube.com/İ',
    'https://youtube.com/watch?v=🍕', 'youtube.c0m', 'yout_ube.com', '192.168.0.1', '1.2.3.4', '[::1]', '::1',
  ];
}

/**
 * Véletlen összerakás: 1–`maxParts` darab a készletből. Az első négy húzást
 * eldobjuk — a lineáris kongruens első húzásai kis magoknál egy csomóban
 * állnak, és minden eset ugyanazzal a darabbal kezdődne.
 */
function composed(r: () => number, pool: string[], maxParts: number): string {
  for (let i = 0; i < 4; i++) r();
  const n = 1 + Math.floor(r() * maxParts);
  let s = '';
  for (let i = 0; i < n; i++) s += pool[Math.floor(r() * pool.length)];
  return s;
}

const KEYWORD_LISTS: string[][] = [
  [],
  ['Shorts', 'shorts', 'ab', 'reels', ' REELS '],
  ['\uff33\uff28\uff2f\uff32\uff34\uff33', 'shorts', 'ﬁlm', 'film'],
  ['live\ufeff', 'live', '\u00a0stream\u00a0', 'stream'],
  Array.from({ length: MAX_KEYWORDS + 5 }, (_, i) => `szo${String(i).padStart(3, '0')}`),
  ['két szó', 'két\u00a0szó', 'két\u200bszó', 'ΟΔΟΣ', 'İstanbul'],
];

function buildFixture(): Fixture {
  const texts = curatedTexts();
  for (let seed = 1; seed <= SEEDS; seed++) texts.push(composed(rng(seed), FRAGMENTS, 6));
  const domains = curatedDomains();
  for (let seed = 1; seed <= SEEDS; seed++) domains.push(composed(rng(1000 + seed), DOMAIN_FRAGMENTS, 6));
  const lists = [...KEYWORD_LISTS];
  for (let seed = 1; seed <= 30; seed++) {
    const r = rng(2000 + seed);
    const n = 2 + Math.floor(r() * 5);
    lists.push(Array.from({ length: n }, () => composed(r, FRAGMENTS, 3)));
  }
  const pick = (r: () => number, pool: string[]) => pool[Math.floor(r() * pool.length)];
  const ruleInputs = [...CURATED_RULES];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(3000 + seed);
    for (let i = 0; i < 4; i++) r();
    ruleInputs.push(pick(r, RULE_SCHEMES) + pick(r, RULE_USERS) + pick(r, RULE_HOSTS) + pick(r, RULE_PORTS)
      + pick(r, RULE_PATHS) + pick(r, RULE_TAILS));
  }
  const matchPairs: Array<[string, string]> = [...CURATED_MATCHES];
  for (let seed = 1; seed <= 100; seed++) {
    const r = rng(4000 + seed);
    for (let i = 0; i < 4; i++) r();
    const rule = pick(r, MATCH_RULES);
    const parsed = normalizeRule(rule);
    assert.ok(parsed, `az illesztendő szabály nem szabály: ${ascii(rule)}`);
    // A fele a szabály KÖZELÉBEN jár (ugyanaz a hoszt vagy aldomainje, ugyanaz az
    // út vagy a határán), a fele bárhol — így a találat és a nem-találat is
    // bőven sorra kerül, a szegmenshatár mindkét oldalával.
    const near = r() < 0.5;
    const host = near ? pick(r, [parsed.host, `www.${parsed.host}`, `m.${parsed.host}`, `x.${parsed.host}`, `${parsed.host}x`])
      : pick(r, MATCH_HOSTS);
    const path = near ? pick(r, [parsed.path, `${parsed.path}/`, `${parsed.path}/videos`, `${parsed.path}x`, parsed.path.toUpperCase(), `/${parsed.path}`])
      : pick(r, MATCH_PATHS);
    const url = pick(r, RULE_SCHEMES) + pick(r, RULE_USERS) + host + pick(r, RULE_PORTS) + path + pick(r, RULE_TAILS);
    matchPairs.push([rule, url]);
  }
  const ruleMatch: MatchCase[] = matchPairs.map(([rule, url]) => {
    const parsed = normalizeRule(rule);
    assert.ok(parsed, `az illesztendő szabály nem szabály: ${ascii(rule)}`);
    return { rule, url, out: matchesRule(parsed, url) };
  });
  return {
    note: 'Generálja és őrzi: desktop/test/text-fixture.test.ts (UPDATE_TEXT_FIXTURE=1 npm test). '
      + 'A bemenet és a gép tiszta alakja (null: nem érvényes); a Kotlin TextFixtureTest és a Swift '
      + 'TextFixtureTests ugyanezt a fájlt játssza vissza a saját magjával. Csupa ASCII, hogy a '
      + 'láthatatlan jelek (BOM, nem törő szóköz) láthatók legyenek. A rule-esetek: beírt szöveg → '
      + 'a részleges szabály kanonikus alakja (host|path); a ruleMatch-esetek: szabály és cím → illik-e.',
    version: 2,
    alias: texts.map((t) => ({ in: t, out: normalizeAlias(t) ?? null })),
    reason: texts.map((t) => ({ in: t, out: normalizeReason(t) ?? null })),
    keyword: texts.map((t) => ({ in: t, out: normalizeKeyword(t) })),
    keywords: lists.map((l) => ({ in: l, out: cleanKeywords(l) })),
    partnerName: texts.map((t) => ({ in: t, out: normalizePartnerName(t) })),
    phrase: texts.map((t) => ({ in: t, out: normalizePhrase(t) })),
    domain: domains.map((d) => ({ in: d, out: normalizeDomain(d) })),
    rule: ruleInputs.map((x) => ({ in: x, out: ruleKey(normalizeRule(x)) })),
    ruleMatch,
  };
}

// ------------------------------------------------------------------ kiírás

/** JSON-szöveg csupa ASCII-ban: a 0x7f fölötti egységek `\uXXXX` alakban. */
function ascii(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
const renderCase = (c: TextCase) => `  {"in":${ascii(c.in)},"out":${c.out === null ? 'null' : ascii(c.out)}}`;
const renderList = (c: ListCase) => `  {"in":[${c.in.map(ascii).join(',')}],"out":[${c.out.map(ascii).join(',')}]}`;
const renderMatch = (c: MatchCase) => `  {"rule":${ascii(c.rule)},"url":${ascii(c.url)},"out":${c.out}}`;

function render(f: Fixture): string {
  const section = (name: string, rows: string[]) => ` "${name}": [\n${rows.join(',\n')}\n ]`;
  const body = [
    section('alias', f.alias.map(renderCase)),
    section('reason', f.reason.map(renderCase)),
    section('keyword', f.keyword.map(renderCase)),
    section('keywords', f.keywords.map(renderList)),
    section('partnerName', f.partnerName.map(renderCase)),
    section('phrase', f.phrase.map(renderCase)),
    section('domain', f.domain.map(renderCase)),
    section('rule', f.rule.map(renderCase)),
    section('ruleMatch', f.ruleMatch.map(renderMatch)),
  ].join(',\n');
  return `{\n "note": ${ascii(f.note)},\n "version": ${f.version},\n${body}\n}\n`;
}

/** Párja nélküli helyettesítő (fél emodzsi) van-e a szövegben. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

// ------------------------------------------------------------------ tesztek

test('a JS \\s készlete pontosan a kimondott lista — a Kotlin és a Swift ugyanezt hordozza', () => {
  const got: number[] = [];
  for (let c = 0; c <= 0x10ffff; c++) if (/\s/u.test(String.fromCodePoint(c))) got.push(c);
  assert.deepEqual(got, [...WHITESPACE_CODE_POINTS]);
  // A `trim` és a `\s` ugyanaz a készlet — a tisztítás mindkettőt használja.
  for (const w of WS) assert.equal(`${w}a${w}`.trim(), 'a');
});

test('a szöveg-fixtúra friss, a tisztítás idempotens, és nem hagy párja nélküli helyettesítőt', () => {
  const built = buildFixture();
  const again = (f: (s: string) => string | null | undefined, c: TextCase) => {
    if (c.out === null) return;
    assert.equal(f(c.out) ?? null, c.out, `nem idempotens: ${ascii(c.in)} → ${ascii(c.out)}`);
    assert.ok(!hasLoneSurrogate(c.out), `fél emodzsi a kimenetben: ${ascii(c.in)}`);
  };
  for (const c of built.alias) { assert.ok(!hasLoneSurrogate(c.in)); again(normalizeAlias, c); }
  for (const c of built.reason) again(normalizeReason, c);
  for (const c of built.keyword) again(normalizeKeyword, c);
  for (const c of built.partnerName) again(normalizePartnerName, c);
  for (const c of built.phrase) again(normalizePhrase, c);
  // A domain-tisztítás szándékosan NEM idempotens: egy `www.`-t vág le, nem
  // mindet (a `www.www.youtube.com` a `www.youtube.com`), mindhárom magban
  // ugyanúgy — a fixtúra ezt csak tükrözi, nem ítéli.
  for (const c of built.domain) assert.ok(!hasLoneSurrogate(c.in));
  // A szabály kanonikus alakja idempotens: a kiírt alak visszaolvasva ugyanaz.
  for (const c of built.rule) {
    if (c.out === null) continue;
    const [host, p] = c.out.split('|');
    assert.equal(ruleKey(normalizeRule(`${host}${p}`)), c.out, `nem idempotens szabály: ${ascii(c.in)}`);
  }
  assert.ok(built.ruleMatch.some((c) => c.out) && built.ruleMatch.some((c) => !c.out), 'az illesztés-esetek egyfélék');
  for (const c of built.keywords) assert.deepEqual(cleanKeywords(c.out), c.out);
  // A plafonok tényleg plafonok: a hosszú futamok kódpontban pont a határra érnek.
  const longest = (cases: TextCase[]) => Math.max(...cases.map((c) => (c.out === null ? 0 : [...c.out].length)));
  assert.equal(longest(built.alias), MAX_ALIAS_LENGTH);
  assert.equal(longest(built.reason), MAX_REASON_LENGTH);
  assert.equal(longest(built.partnerName), MAX_PARTNER_NAME);
  // A fixtúra nem elfajult: minden szekcióban van érvényes és érvénytelen is.
  for (const name of ['alias', 'keyword', 'partnerName', 'domain', 'rule'] as const) {
    const cases = built[name];
    assert.ok(cases.some((c) => c.out === null) && cases.some((c) => c.out !== null), name);
  }

  const text = render(built);
  if (process.env.UPDATE_TEXT_FIXTURE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, text);
  }
  assert.ok(fs.existsSync(FIXTURE), `nincs fixture: ${FIXTURE} — UPDATE_TEXT_FIXTURE=1 npm test`);
  const onDisk = fs.readFileSync(FIXTURE, 'utf8');
  assert.equal(
    onDisk, text,
    'a fixtures/text-cases.json elavult a gép tisztításához képest — UPDATE_TEXT_FIXTURE=1 npm test, '
      + 'aztán a Kotlin (TextFixtureTest) és a Swift (TextFixtureTests) teszt mutatja meg, hol csúszott el a tükör',
  );
  // Ami a fájlban van, az csupa ASCII — a láthatatlan jelek láthatók.
  assert.ok(/^[\x00-\x7f]*$/.test(onDisk), 'a fixtúra nem csupa ASCII');
  const parsed = JSON.parse(onDisk) as Fixture;
  assert.equal(parsed.version, built.version);
  assert.equal(parsed.alias.length, built.alias.length);
  assert.equal(parsed.domain.length, built.domain.length);
});
