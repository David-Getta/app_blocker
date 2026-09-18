// Kulcsszó-szabályok: a mag (alak, lista, fésülés, illesztés), a bíró (felvenni
// ingyen, levenni próbatétel), a jel (lenyomat), és a drót (fésülés a blobon).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  KEYWORD_SUGGESTIONS, MAX_KEYWORDS, MAX_KEYWORD_LENGTH, MIN_KEYWORD_LENGTH, cleanKeywords, isKeywordsLoosening,
  keywordHit, keywordsKey, mergeKeywords, normalizeKeyword, sameKeywords,
} from '../src/shared/keywords';
import { defaultState, newId, type HelperState } from '../src/helper/state';
import * as referee from '../src/helper/referee';
import { adoptFocusRevision, bumpFocusRevision } from '../src/helper/revisions';
import { mergeFocus, normalizeSyncFocus, sameFocus, type SyncFocus } from '../src/shared/sync/focus-merge';
import { reverseString, type Step } from '../src/shared/challenges';

test('a kulcsszó kanonikus alakja: kisbetű, NFKC, szélek le — szóköz és rövid nem szabály', () => {
  assert.equal(normalizeKeyword('  Shorts '), 'shorts');
  assert.equal(normalizeKeyword('REELS'), 'reels');
  assert.equal(normalizeKeyword('ab'), null, 'két betű mindenre illene');
  assert.equal(normalizeKeyword('két szó'), null, 'egy cím sem tartalmaz szóközt');
  assert.equal(normalizeKeyword('x'.repeat(MAX_KEYWORD_LENGTH + 1)), null);
  assert.equal(normalizeKeyword('x'.repeat(MAX_KEYWORD_LENGTH)), 'x'.repeat(MAX_KEYWORD_LENGTH));
  assert.equal(normalizeKeyword('x'.repeat(MIN_KEYWORD_LENGTH)), 'xxx');
  assert.equal(normalizeKeyword(42), null);
  assert.equal(normalizeKeyword(''), null);
  // Bontott ékezet ugyanaz, mint az összetett.
  assert.equal(normalizeKeyword('a' + String.fromCharCode(0x0301) + 'lom'), 'álom');
});

test('a lista tisztán: csak az érvényes, egyszer, a plafonig; a kulcs rendezett', () => {
  assert.deepEqual(cleanKeywords(['Shorts', 'shorts', 'ab', 'reels', 42, null, ' REELS ']), ['shorts', 'reels']);
  assert.deepEqual(cleanKeywords('nem tömb'), []);
  const many = Array.from({ length: MAX_KEYWORDS + 5 }, (_, i) => `szo${i.toString().padStart(3, '0')}`);
  assert.equal(cleanKeywords(many).length, MAX_KEYWORDS);
  assert.equal(keywordsKey(['reels', 'shorts']), keywordsKey(['shorts', 'reels']), 'a sorrend nem jelentés');
  assert.ok(sameKeywords(['Shorts', 'reels'], ['reels', 'shorts']));
  assert.ok(!sameKeywords(['shorts'], ['shorts', 'reels']));
});

test('lazítás-e: ami a mostaniból hiányzik az újból, az levétel; a bővítés nem', () => {
  assert.equal(isKeywordsLoosening([], ['shorts']), false, 'felvétel: szigorítás');
  assert.equal(isKeywordsLoosening(['shorts'], ['shorts', 'reels']), false, 'bővítés: szigorítás');
  assert.equal(isKeywordsLoosening(['shorts', 'reels'], ['shorts']), true, 'levétel: lazítás');
  assert.equal(isKeywordsLoosening(['shorts'], []), true);
  assert.equal(isKeywordsLoosening(['shorts'], ['SHORTS']), false, 'ugyanaz más alakban');
});

test('fésülés a jel szerint: nagyobb jel nyer, azonos jelnél a bővebb — a jeltelen sosem töröl', () => {
  assert.deepEqual(mergeKeywords(3, ['shorts'], 5, ['reels']), ['reels'], 'a nagyobb jelű levétel átmegy');
  assert.deepEqual(mergeKeywords(5, ['shorts'], 3, ['reels']), ['shorts']);
  assert.deepEqual(mergeKeywords(3, ['shorts'], 3, ['reels']), ['shorts', 'reels'], 'azonos jel: unió');
  assert.deepEqual(mergeKeywords(0, [], 0, ['shorts']), ['shorts'], 'a jeltelen blob nem törli a listát');
  assert.deepEqual(mergeKeywords(2, ['shorts'], 0, []), ['shorts']);
});

test('illesztés: a cím bárhol tartalmazza — hosztban is —, kódolás feloldva, kisbetűvel', () => {
  const words = ['shorts', 'tiktok', 'játék'];
  assert.equal(keywordHit(words, 'https://www.youtube.com/shorts/abc'), 'shorts');
  assert.equal(keywordHit(words, 'https://www.youtube.com/watch?v=x&list=SHORTS'), 'shorts', 'kisbetű-független');
  assert.equal(keywordHit(words, 'https://www.tiktok.com/@valaki'), 'tiktok', 'a hosztnév is a cím része');
  assert.equal(keywordHit(words, 'https://example.com/j%C3%A1t%C3%A9k'), 'játék', 'a százalék-kódolás feloldva');
  assert.equal(keywordHit(words, 'https://example.com/hirek'), null);
  assert.equal(keywordHit(words, 'https://example.com/%E0%A4%A'), null, 'rossz kódolás: marad, nem hasal el');
  assert.equal(keywordHit([], 'https://www.youtube.com/shorts/abc'), null);
  assert.equal(keywordHit(['ab'], 'https://ab.com'), null, 'érvénytelen kulcsszó nem illik');
});

// ------------------------------------------------------------------ a bíró

function stateWithSite(): { state: HelperState; siteId: string } {
  const state = defaultState();
  const siteId = newId('site');
  state.sites.push({
    id: siteId, domain: 'youtube.com', hostnames: ['youtube.com'], addedAt: 1, pauseUntil: null, pendingDeleteAt: null,
  });
  return { state, siteId };
}

function solveStep(step: Step, now: number): string {
  switch (step.type) {
    case 'TRANSCRIBE': return step.text;
    case 'MATH_CHAIN': return String(step.problems[step.pos].a);
    case 'MEMORY': step.armedAt = now - step.showMs - step.waitMs - 1000; return step.code;
    case 'REVERSE': return reverseString(step.text);
    case 'DELAY': throw new Error('a várakozást átvenni kell');
    case 'PARTNER': throw new Error('a megbízott lépése a jelmondat');
  }
}

function solveAll(state: HelperState, now: number): void {
  let guard = 0;
  while (state.session && guard++ < 60) {
    const s = state.session;
    const step = s.steps[s.stepIndex];
    if (step.type === 'DELAY') {
      referee.claimDelay(state, s.id, (step.claimableAt ?? now) + 1);
    } else {
      referee.submitAnswer(state, s.id, solveStep(step, now), now);
    }
  }
  assert.equal(state.session, null, 'a kísérlet végigment');
}

test('a bíró: felvenni és bővíteni ingyen, levenni próbatétel — a levétel a teljesítéskor lép életbe', () => {
  const { state } = stateWithSite();
  const now = 1_700_000_000_000;
  assert.equal(referee.setKeywords(state, ['Shorts'], now).applied, true, 'felvétel ingyen');
  assert.deepEqual(state.keywords, ['shorts']);
  assert.equal(referee.setKeywords(state, ['shorts', 'reels'], now).applied, true, 'bővítés ingyen');
  assert.deepEqual(state.keywords, ['shorts', 'reels']);
  assert.equal(referee.setKeywords(state, ['reels', 'shorts'], now).applied, true, 'ugyanaz más sorrendben: nincs mit tenni');

  const r = referee.setKeywords(state, ['shorts'], now);
  assert.equal(r.applied, false, 'levétel: próbatétel');
  assert.equal(state.session?.siteId, 'keywords');
  assert.deepEqual(state.session?.pendingKeywords, ['shorts']);
  assert.equal(r.session?.keywords, true, 'a felület ebből tudja, mi a tét');
  assert.deepEqual(state.keywords, ['shorts', 'reels'], 'amíg a próbatétel tart, a lista marad');
  assert.throws(() => referee.setKeywords(state, [], now), (e: referee.RefereeError) => e.code === 'BUSY');
  solveAll(state, now);
  assert.deepEqual(state.keywords, ['shorts'], 'a teljesítéskor lép életbe');
  assert.equal(state.unlockLog.length, 1, 'a lazítás a naplóban');

  // Az utolsó levétele: üres lista — és üresen nincs mező.
  const last = referee.setKeywords(state, [], now + 1000);
  assert.equal(last.applied, false);
  solveAll(state, now + 1000);
  assert.equal(state.keywords, undefined);
});

test('a bíró: futó levétel közben a felvétel ingyen — és a levétel végén sem vész el', () => {
  // A szigorítás sosem vár a lazításra: közben is felvehető egy szó. De a
  // teljesítéskor a függő lista ül vissza — ha az nem tudna a közben jött
  // szóról, a szigorítás némán eltűnne, pont a levétel árán.
  const { state } = stateWithSite();
  const now = 1_700_000_000_000;
  referee.setKeywords(state, ['shorts', 'reels'], now);
  assert.equal(referee.setKeywords(state, ['reels'], now).applied, false, 'a shorts levétele próbatétel');
  assert.equal(referee.setKeywords(state, ['shorts', 'reels', 'live'], now).applied, true, 'közben a live ingyen');
  assert.deepEqual(state.keywords, ['shorts', 'reels', 'live']);
  assert.deepEqual(state.session?.pendingKeywords, ['reels', 'live'], 'a függő lista is tud a live-ról');
  solveAll(state, now);
  assert.deepEqual(state.keywords, ['reels', 'live'], 'a shorts lement, a live megmaradt');
});

test('a bíró: rossz kulcsszó és túl sok kulcsszó hiba, nem csendes csonkolás', () => {
  const { state } = stateWithSite();
  const now = 1_700_000_000_000;
  assert.throws(() => referee.setKeywords(state, ['ab'], now), (e: referee.RefereeError) => e.code === 'BAD_KEYWORD');
  assert.throws(() => referee.setKeywords(state, ['két szó'], now), (e: referee.RefereeError) => e.code === 'BAD_KEYWORD');
  assert.throws(() => referee.setKeywords(state, ['shorts', 'SHORTS'], now), (e: referee.RefereeError) => e.code === 'BAD_KEYWORD');
  const many = Array.from({ length: MAX_KEYWORDS + 1 }, (_, i) => `szo${i.toString().padStart(3, '0')}`);
  assert.throws(() => referee.setKeywords(state, many, now), (e: referee.RefereeError) => e.code === 'TOO_MANY_KEYWORDS');
  assert.equal(state.keywords, undefined, 'hibánál semmi nem változik');
});

test('a jel: a felvétel és a levétel lépteti a blobot, az átvétel nem', () => {
  const state = defaultState();
  const now = 1_700_000_000_000;
  assert.equal(bumpFocusRevision(state, 'dev', now), false, 'üres állapot: nincs mit léptetni');
  referee.setKeywords(state, ['shorts'], now);
  assert.equal(bumpFocusRevision(state, 'dev', now), true);
  assert.equal(state.keywordsRev, state.focusRev);
  const rev = state.focusRev!;
  assert.equal(bumpFocusRevision(state, 'dev', now + 1), false, 'változatlan: nem léptet');
  state.focusPacks = [{ id: 'p1', name: 'Írás', allowSites: [], allowApps: [], defaultMinutes: 25 }];
  assert.equal(bumpFocusRevision(state, 'dev', now + 2), true);
  assert.equal(state.keywordsRev, rev, 'a csomag szerkesztése nem a kulcsszavak jele');
  referee.setKeywords(state, ['shorts', 'reels'], now + 3);
  assert.equal(bumpFocusRevision(state, 'dev', now + 3), true);
  assert.equal(state.keywordsRev, rev + 2);
  // Egy másik eszközről átvett lista: a lenyomat és a kulcs újraszámolva — nincs léptetés,
  // és a következő saját szerkesztés sem bélyegzi át a jelét.
  state.keywords = ['reels'];
  state.keywordsRev = 9;
  adoptFocusRevision(state);
  assert.equal(bumpFocusRevision(state, 'dev', now + 4), false, 'az átvétel nem szerkesztés');
  state.focusPacks = [];
  assert.equal(bumpFocusRevision(state, 'dev', now + 5), true);
  assert.equal(state.keywordsRev, 9, 'az átvett lista jele marad');
});

// ------------------------------------------------------------------ a drót

const focus = (over: Partial<SyncFocus>): SyncFocus =>
  ({ packs: [], run: null, log: [], rev: 0, updatedAt: 0, updatedBy: 'x', ...over });

test('a blob hordozza a kulcsszavakat és a jelüket; a szemét és a túl nagy jel kiesik', () => {
  const n = normalizeSyncFocus({ keywords: ['Shorts', 'ab', 'shorts', 42], keywordsRev: 2, rev: 3 }, 'dev');
  assert.deepEqual(n.keywords, ['shorts']);
  assert.equal(n.keywordsRev, 2);
  const big = normalizeSyncFocus({ keywords: ['shorts'], keywordsRev: 99, rev: 3 }, 'dev');
  assert.equal(big.keywordsRev, undefined, 'a jel legfeljebb a blob rev-je');
  const none = normalizeSyncFocus({ keywords: [], rev: 3 }, 'dev');
  assert.equal(none.keywords, undefined, 'üresen nincs mező');
});

test('a blob fésülése: a jel dönt, azonos jelnél az unió; a régi kliens nem töröl', () => {
  const local = focus({ keywords: ['shorts'], keywordsRev: 3, rev: 3 });
  const removed = focus({ keywordsRev: 5, rev: 5, updatedBy: 'other' });
  const merged = mergeFocus(local, removed);
  assert.equal(merged.keywords, undefined, 'a nagyobb jelű levétel átmegy');
  assert.equal(merged.keywordsRev, 5);
  const same = mergeFocus(local, focus({ keywords: ['reels'], keywordsRev: 3, rev: 3 }));
  assert.deepEqual(same.keywords, ['shorts', 'reels'], 'azonos jel: unió');
  const old = focus({ rev: 9, updatedAt: 999, updatedBy: 'old' });
  assert.deepEqual(mergeFocus(local, old).keywords, ['shorts'], 'a jeltelen blob nem viszi el');
  assert.ok(!sameFocus(local, focus({ ...local, keywords: ['shorts', 'reels'] })), 'a lista cseréje különbség: fel kell tölteni');
});

test('a javaslatok maguk is érvényes kulcsszavak — kanonikus alakban, egyszer, a plafon alatt', () => {
  for (const s of KEYWORD_SUGGESTIONS) assert.equal(normalizeKeyword(s), s, s);
  assert.equal(new Set(KEYWORD_SUGGESTIONS).size, KEYWORD_SUGGESTIONS.length);
  assert.ok(KEYWORD_SUGGESTIONS.length <= MAX_KEYWORDS);
  assert.deepEqual(cleanKeywords(KEYWORD_SUGGESTIONS), KEYWORD_SUGGESTIONS);
});
