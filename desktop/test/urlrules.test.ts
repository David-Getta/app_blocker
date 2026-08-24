// Részleges tiltás: a szabály magja.
//
// Itt egyetlen hiba két irányba tud sülni, és mindkettő rossz:
//
//   - túl szűken fog  -> a felhasználó azt hiszi, letiltotta a csatornát, és az
//                        mégis megjelenik;
//   - túl tágan fog   -> letilt valamit, amit nem akart, és nem érti, miért.
//
// A második a veszélyesebb, mert bizalmat veszít: ha egyszer véletlenül elvesz
// valamit, az ember kikapcsolja az egészet.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  anyRuleMatches, matchesRule, MAX_RULE_PATH_LENGTH, normalizeRule, ruleLabel, sameRule,
} from '../src/shared/urlrules';

test('what people actually paste becomes a rule', () => {
  assert.deepEqual(normalizeRule('https://www.youtube.com/@valaki'),
    { host: 'youtube.com', path: '/@valaki' });
  assert.deepEqual(normalizeRule('youtube.com/@valaki'),
    { host: 'youtube.com', path: '/@valaki' });
  // Záró perjel, több perjel, nagybetű: mind ugyanaz a csatorna.
  assert.deepEqual(normalizeRule('www.YouTube.com//@Valaki/'),
    { host: 'youtube.com', path: '/@valaki' });
  assert.deepEqual(normalizeRule('  reddit.com/r/hirek/  '),
    { host: 'reddit.com', path: '/r/hirek' });
  assert.deepEqual(normalizeRule('youtube.com/channel/UCabc123'),
    { host: 'youtube.com', path: '/channel/ucabc123' });
});

test('the query string is dropped, because it names a video and not a channel', () => {
  // Ha a `?v=...` bent maradna, a szabály EGYETLEN videóra vonatkozna, a
  // felhasználó viszont azt hinné, hogy a csatornát tiltotta le. Az ilyen
  // félreértés csendes: semmi nem jelezné, hogy nem az történt, amit akart.
  assert.deepEqual(normalizeRule('https://www.youtube.com/@valaki/videos?x=1&y=2'),
    { host: 'youtube.com', path: '/@valaki/videos' });
  assert.deepEqual(normalizeRule('youtube.com/@valaki#rolam'),
    { host: 'youtube.com', path: '/@valaki' });
});

test('a rule without a path is refused: that would be the whole site', () => {
  // Az egész oldal tiltására ott a DNS-szintű blokk. Egy „részleges” szabály,
  // ami mindent tilt, csak félreértés forrása lenne — ráadásul gyengébb is,
  // mert csak a böngészőben él.
  assert.equal(normalizeRule('youtube.com'), null);
  assert.equal(normalizeRule('https://www.youtube.com'), null);
  assert.equal(normalizeRule('youtube.com/'), null);
  assert.equal(normalizeRule('youtube.com/?x=1'), null);
});

test('junk is refused rather than turned into something surprising', () => {
  assert.equal(normalizeRule(''), null);
  assert.equal(normalizeRule('   '), null);
  assert.equal(normalizeRule('/@valaki'), null, 'nincs hoszt: mihez tartozna?');
  assert.equal(normalizeRule('nem egy cím'), null);
  assert.equal(normalizeRule(undefined as unknown as string), null);
  assert.equal(normalizeRule(`youtube.com/${'a'.repeat(MAX_RULE_PATH_LENGTH + 5)}`), null);
  assert.equal(normalizeRule('youtube.com/@va laki'), null, 'szóköz nem való egy útba');
});

test('a channel is blocked, and a similarly named one is NOT', () => {
  // Sztring-előtagként a `/@ab` ráillene a `/@abc`-re is. Vagyis egy csatorna
  // tiltása csendben letiltana egy másikat, akinek hasonlóan kezdődik a neve —
  // és a felhasználó nem értené, hova tűnt.
  const rule = normalizeRule('youtube.com/@ab');
  assert.ok(rule);
  assert.equal(matchesRule(rule, 'https://www.youtube.com/@ab'), true);
  assert.equal(matchesRule(rule, 'https://www.youtube.com/@ab/videos'), true);
  assert.equal(matchesRule(rule, 'https://www.youtube.com/@ab?tab=1'), true);
  assert.equal(matchesRule(rule, 'https://www.youtube.com/@abc'), false);
  assert.equal(matchesRule(rule, 'https://www.youtube.com/@abc/videos'), false);
});

test('a rule pasted from a phone covers the desktop site too', () => {
  // Aki a telefonjáról másolja a linket, `m.youtube.com/@valaki`-t illeszt be.
  // Szó szerint véve a szabály CSAK a mobil hoszton fogna, és a gépen
  // megnyitott ugyanolyan csatorna átmenne rajta — némán.
  assert.deepEqual(normalizeRule('https://m.youtube.com/@valaki'),
    { host: 'youtube.com', path: '/@valaki' });
  assert.deepEqual(normalizeRule('mobile.twitter.com/valaki'),
    { host: 'twitter.com', path: '/valaki' });
  // Viszont egy `m.`-mel kezdődő VALÓDI domainből nem csinálunk csonkot.
  assert.deepEqual(normalizeRule('m.hu/valami'), { host: 'm.hu', path: '/valami' });
});

test('the mobile host is the same channel', () => {
  // `m.youtube.com/@valaki` ugyanoda visz. Ha csak a pontos hoszt számítana, a
  // telefonos nézet kiskapu lenne.
  const rule = normalizeRule('youtube.com/@valaki')!;
  assert.equal(matchesRule(rule, 'https://m.youtube.com/@valaki'), true);
  assert.equal(matchesRule(rule, 'https://music.youtube.com/@valaki'), true);
  // Viszont egy MÁSIK oldal, ami csak a végén hasonlít, nem esik alá.
  assert.equal(matchesRule(rule, 'https://notyoutube.com/@valaki'), false);
  assert.equal(matchesRule(rule, 'https://youtube.com.hamis.hu/@valaki'), false);
});

test('the front page stays reachable when only a channel is blocked', () => {
  // Ez a lényeg: „a YouTube maradjon, de EZ a csatorna ne”. Ha a főoldal is
  // elesne, a részleges tiltás nem különbözne a teljestől.
  const rule = normalizeRule('youtube.com/@valaki')!;
  assert.equal(matchesRule(rule, 'https://www.youtube.com/'), false);
  assert.equal(matchesRule(rule, 'https://www.youtube.com'), false);
  assert.equal(matchesRule(rule, 'https://www.youtube.com/watch?v=abc'), false);
  assert.equal(matchesRule(rule, 'https://www.youtube.com/@masik'), false);
});

test('case and trailing slashes never decide whether a rule bites', () => {
  // Ha egy szabály hol fogna, hol nem, azt senki nem tudná értelmezni — és a
  // felhasználó azt hinné, hogy az app megbízhatatlan.
  const rule = normalizeRule('youtube.com/@Valaki')!;
  for (const url of [
    'https://www.YouTube.com/@valaki',
    'https://www.youtube.com/@VALAKI/',
    'http://youtube.com:443/@Valaki/videos',
    'https://www.youtube.com//@valaki',
  ]) {
    assert.equal(matchesRule(rule, url), true, url);
  }
});

test('garbage URLs do not match, instead of matching everything', () => {
  // A böngészőből érkező cím nem mindig szabályos. A bizonytalanság itt a NEM
  // ILLESZKEDÉS felé dől: egy hibás címre ráhúzott szabály olyat venne el,
  // amit a felhasználó nem tiltott.
  const rule = normalizeRule('youtube.com/@valaki')!;
  for (const bad of ['', '   ', 'about:blank', 'chrome://extensions', 'nem url']) {
    assert.equal(matchesRule(rule, bad), false, bad);
  }
  assert.equal(matchesRule(rule, undefined as unknown as string), false);
});

test('a list of rules answers as one', () => {
  const rules = [normalizeRule('youtube.com/@a')!, normalizeRule('reddit.com/r/hirek')!];
  assert.equal(anyRuleMatches(rules, 'https://youtube.com/@a/videos'), true);
  assert.equal(anyRuleMatches(rules, 'https://old.reddit.com/r/hirek/top'), true);
  assert.equal(anyRuleMatches(rules, 'https://youtube.com/@b'), false);
  assert.equal(anyRuleMatches([], 'https://youtube.com/@a'), false);
});

test('the same rule twice is the same rule, and reads back as typed', () => {
  const a = normalizeRule('https://www.youtube.com/@valaki/')!;
  const b = normalizeRule('youtube.com/@Valaki')!;
  assert.equal(sameRule(a, b), true);
  assert.equal(sameRule(a, normalizeRule('youtube.com/@masik')!), false);
  assert.equal(ruleLabel(a), 'youtube.com/@valaki');
});
