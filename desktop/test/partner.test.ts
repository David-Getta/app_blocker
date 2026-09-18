// PÁRBAN ZÁROLÁS: a lazítás végén a megbízott jelmondata is kell.
//
//   UPDATE_PARTNER_FIXTURE=1 npm test   — a fixtures/partner-hash.json újraírása
//
// A fixture a Kotlin és a Swift tükörnek szól: ugyanabból a jelmondatból és
// sóból ugyanazt a lenyomatot kell számolniuk, különben a gépen felvett
// megbízott a telefonon sosem stimmelne — csendben.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_PARTNER_NAME, MAX_PARTNER_TRIES, mergePartner, normalizePartnerLock, normalizePartnerName,
  normalizePhrase, type PartnerLock,
} from '../src/shared/partner';
import { hashPhrase, makePartnerLock, verifyPhrase } from '../src/helper/partner-crypto';
import { defaultState, newId, type HelperState } from '../src/helper/state';
import * as referee from '../src/helper/referee';
import { adoptFocusRevision, bumpFocusRevision } from '../src/helper/revisions';
import { emptyFocus, mergeFocus, normalizeSyncFocus, sameFocus } from '../src/shared/sync/focus-merge';
import { parseCombo, reverseString, type Step } from '../src/shared/challenges';

const FIXTURE = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'partner-hash.json');
const PHRASE = 'alma bogrács cinege délután';
const SALT = 'AAAAAAAAAAAAAAAAAAAAAA==';

test('a jelmondat kanonikus alakja: kis-nagybetű, szóközök, NFKC nem számít', () => {
  assert.equal(normalizePhrase('  Alma  BOGRÁCS\tcinege\n délután '), PHRASE);
  // Bontott ékezet (a + kombináló vessző) ugyanaz, mint az összetett á.
  assert.equal(normalizePhrase('a' + String.fromCharCode(0x0301) + 'lma bogrács cinege délután'), normalizePhrase('álma bogrács cinege délután'));
  assert.equal(normalizePhrase('   '), '');
  assert.equal(normalizePartnerName('  Anna   Kovács '), 'Anna Kovács');
  assert.equal(normalizePartnerName(''), null);
  assert.equal(normalizePartnerName(42), null);
  assert.equal(normalizePartnerName('x'.repeat(100))!.length, MAX_PARTNER_NAME);
});

test('a lenyomat: a jó jelmondat átmegy bármilyen alakban, a rossz és az üres nem', () => {
  const lock = makePartnerLock('Anna', PHRASE, 1000);
  assert.equal(lock.name, 'Anna');
  assert.ok(lock.salt.length >= 16 && lock.hash.length >= 32);
  assert.ok(verifyPhrase(lock, 'ALMA  bogrács  Cinege délután '));
  assert.ok(!verifyPhrase(lock, 'alma bogrács cinege este'));
  assert.ok(!verifyPhrase(lock, ''));
  // Két felvétel két só: ugyanaz a jelmondat más lenyomat.
  const again = makePartnerLock('Anna', PHRASE, 1000);
  assert.notEqual(again.salt, lock.salt);
  assert.notEqual(again.hash, lock.hash);
  assert.deepEqual(normalizePartnerLock(lock), lock);
  assert.equal(normalizePartnerLock({ ...lock, hash: 'rövid' }), null);
  assert.equal(normalizePartnerLock({ ...lock, name: '' }), null);
  assert.equal(normalizePartnerLock('x'), null);
});

test('a fixtures/partner-hash.json a gép lenyomata — a telefonok ehhez mérik magukat', () => {
  const current = { phrase: PHRASE, salt: SALT, hash: hashPhrase(PHRASE, SALT), wrong: 'alma bogrács cinege este' };
  if (process.env.UPDATE_PARTNER_FIXTURE) {
    fs.writeFileSync(FIXTURE, JSON.stringify(current, null, 2) + '\n');
  }
  assert.ok(fs.existsSync(FIXTURE), `nincs fixture: ${FIXTURE} — UPDATE_PARTNER_FIXTURE=1 npm test`);
  const stored = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(stored, current, 'a fixtures/partner-hash.json elavult — UPDATE_PARTNER_FIXTURE=1 npm test');
  // A lenyomat determinisztikus: ugyanaz a só, ugyanaz a lenyomat.
  assert.equal(hashPhrase(' Alma bogrács CINEGE délután', SALT), stored.hash);
  assert.notEqual(hashPhrase(stored.wrong, SALT), stored.hash);
});

// ------------------------------------------------------------------ a bíró

function stateWithSite(): { state: HelperState; siteId: string } {
  const state = defaultState();
  const siteId = newId('site');
  state.sites.push({
    id: siteId, domain: 'youtube.com', hostnames: ['youtube.com', 'www.youtube.com'],
    addedAt: 1, pauseUntil: null, pendingDeleteAt: null,
  });
  return { state, siteId };
}

function solveStep(step: Step, now: number): string {
  switch (step.type) {
    case 'TRANSCRIBE': return step.text;
    case 'MATH_CHAIN': return String(step.problems[step.pos].a);
    case 'MEMORY': step.armedAt = now - step.showMs - step.waitMs - 1000; return step.code;
    case 'REVERSE': return reverseString(step.text);
    case 'DELAY': throw new Error('a várakozást átvenni kell, nem megválaszolni');
    case 'PARTNER': throw new Error('a megbízott lépése a jelmondat');
  }
}

/** Végigviszi a kísérletet a megbízott lépéséig — a várakozást is átveszi. */
function solveUntilPartner(state: HelperState, sessionId: string, now: number): void {
  let guard = 0;
  while (state.session && guard++ < 200) {
    const step = state.session.steps[state.session.stepIndex];
    if (step.type === 'PARTNER') return;
    if (step.type === 'DELAY') {
      step.claimableAt = now - 1;
      referee.claimDelay(state, sessionId, now);
      continue;
    }
    referee.submitAnswer(state, sessionId, solveStep(step, now), now);
  }
  throw new Error('a kísérlet elfogyott a megbízott lépése előtt');
}

test('megbízottal a terv utolsó lépése az ő jelmondata — a várakozás után', () => {
  const { state, siteId } = stateWithSite();
  const now = 1_700_000_000_000;
  const { phrase, name } = referee.setPartner(state, '  Anna ', now);
  assert.equal(name, 'Anna');
  assert.equal(phrase.split(' ').length, 4, 'négy szó');
  assert.equal(phrase, phrase.toLowerCase());
  assert.ok(state.partner && state.partner.name === 'Anna');
  assert.throws(() => referee.setPartner(state, 'Béla', now), /Már van megbízott/);

  referee.startSession(state, 'pause', siteId, 15, now);
  const steps = state.session!.steps;
  assert.equal(steps[steps.length - 1].type, 'PARTNER');
  assert.equal(steps[steps.length - 2].type, 'DELAY');
  assert.equal((steps[steps.length - 1] as { name: string }).name, 'Anna');

  const id = state.session!.id;
  solveUntilPartner(state, id, now);
  // Rossz jelmondat: nem sorsol újat, csak számol; a plafonnál a kísérlet elszáll.
  for (let i = 1; i < MAX_PARTNER_TRIES; i++) {
    const r = referee.submitAnswer(state, id, 'alma bogrács cinege este', now);
    assert.equal(r.accepted, false);
    assert.ok(r.message && r.message.includes('Nem ez a jelmondat'));
    assert.ok(state.session, 'a kísérlet még él');
  }
  assert.throws(() => referee.submitAnswer(state, id, 'megint rossz', now), /elölről/);
  assert.equal(state.session, null, 'a plafonnál elszállt');
  assert.equal(state.sites[0].pauseUntil, null, 'feloldás nem történt');

  // Újra: minden lépés elölről, és a jó jelmondat a végén feloldja.
  const again = referee.startSession(state, 'pause', siteId, 15, now + 1000);
  solveUntilPartner(state, again.id, now + 1000);
  const r = referee.submitAnswer(state, again.id, ` ${phrase.toUpperCase()} `, now + 1000);
  assert.equal(r.accepted, true);
  assert.equal(r.sessionDone, true);
  assert.ok(state.sites[0].pauseUntil !== null && state.sites[0].pauseUntil > now, 'a szünet elindult');
});

test('a feladott kísérlet kombinációja nem tartalmazza a megbízott lépését', () => {
  const { state, siteId } = stateWithSite();
  const now = 1_700_000_000_000;
  referee.setPartner(state, 'Anna', now);
  const info = referee.startSession(state, 'pause', siteId, 15, now);
  referee.abandonSession(state, info.id);
  const debt = (state.abandons ?? [])[0];
  assert.ok(debt, 'a feladás adóssága megvan');
  assert.ok(!debt.comboKey.includes('PARTNER'), debt.comboKey);
  assert.ok(parseCombo(debt.comboKey), 'a kulcs visszaolvasható — a hűtés alatt ugyanaz jön vissza');
});

test('a megbízott levétele próbatétel, a végén az ő jelmondatával', () => {
  const { state } = stateWithSite();
  const now = 1_700_000_000_000;
  assert.equal(referee.startPartnerRemoval(state, now).applied, true, 'megbízott nélkül nincs mit levenni');
  const { phrase } = referee.setPartner(state, 'Anna', now);
  const r = referee.startPartnerRemoval(state, now);
  assert.equal(r.applied, false);
  assert.ok(r.session);
  assert.equal(state.session!.steps[state.session!.steps.length - 1].type, 'PARTNER');
  solveUntilPartner(state, r.session!.id, now);
  const done = referee.submitAnswer(state, r.session!.id, phrase, now);
  assert.equal(done.sessionDone, true);
  assert.equal(state.partner, undefined, 'a megbízott lekerült');
  assert.equal(state.unlockLog.length, 1, 'a lazítás a naplóban');
});

test('ha a megbízott közben lekerült (szinkron), a lépése tárgytalan: átmegy', () => {
  const { state, siteId } = stateWithSite();
  const now = 1_700_000_000_000;
  referee.setPartner(state, 'Anna', now);
  const info = referee.startSession(state, 'pause', siteId, 15, now);
  solveUntilPartner(state, info.id, now);
  delete state.partner;
  const r = referee.submitAnswer(state, info.id, 'bármi', now);
  assert.equal(r.sessionDone, true);
});

// ------------------------------------------------------------ a jel és a szinkron

test('a felvétel és a levétel lépteti a blobot, és a megbízott jele a blob száma', () => {
  const state = defaultState();
  const now = 1_700_000_000_000;
  assert.equal(bumpFocusRevision(state, 'dev', now), false, 'üres állapot: nincs mit léptetni');
  referee.setPartner(state, 'Anna', now);
  assert.equal(bumpFocusRevision(state, 'dev', now), true);
  assert.equal(state.partnerRev, state.focusRev);
  const rev = state.focusRev!;
  assert.equal(bumpFocusRevision(state, 'dev', now + 1), false, 'változatlan: nem léptet');
  delete state.partner;
  assert.equal(bumpFocusRevision(state, 'dev', now + 2), true, 'a levétel is döntés');
  assert.equal(state.partnerRev, rev + 1);
  // Egy másik eszközről átvett megbízott: a lenyomat és a kulcs újraszámolva —
  // nincs léptetés, és egy későbbi saját szerkesztés sem bélyegzi át a jelét
  // (azzal a másik eszköz levételét írná felül: azonos jelnél a beállított nyer).
  state.partner = makePartnerLock('Béla', 'alma bogrács cinege este', now);
  state.partnerRev = 7;
  adoptFocusRevision(state);
  assert.equal(bumpFocusRevision(state, 'dev', now + 3), false, 'az átvétel nem szerkesztés');
  state.focusPacks = [{ id: 'p1', name: 'Írás', allowSites: [], allowApps: [], defaultMinutes: 25 }];
  assert.equal(bumpFocusRevision(state, 'dev', now + 4), true);
  assert.equal(state.partnerRev, 7, 'az átvett megbízott jele marad');
});

test('fésülés: a jel dönt, azonos jelnél a beállított — és a korábban felvett', () => {
  const a: PartnerLock = { name: 'Anna', salt: 'A'.repeat(24), hash: 'B'.repeat(44), setAt: 100 };
  const b: PartnerLock = { name: 'Béla', salt: 'C'.repeat(24), hash: 'D'.repeat(44), setAt: 200 };
  assert.equal(mergePartner(3, a, 5, undefined), undefined, 'a nagyobb jelű levétel átmegy');
  assert.equal(mergePartner(5, undefined, 3, a), undefined, 'a helyi, nagyobb jelű levétel marad');
  assert.equal(mergePartner(3, a, 3, undefined), a, 'azonos jelnél a beállított nyer');
  assert.equal(mergePartner(3, undefined, 3, b), b);
  assert.equal(mergePartner(3, b, 3, a), a, 'mindkettő beállítva: a korábban felvett');
  assert.equal(mergePartner(2, a, 3, b), b, 'nagyobb jel: a másik megbízott');

  const base = emptyFocus('dev');
  const local = { ...base, partner: a, partnerRev: 3, rev: 3 };
  const removed = { ...base, partnerRev: 5, rev: 5, updatedBy: 'other' };
  const merged = mergeFocus(local, removed);
  assert.equal(merged.partner, undefined);
  assert.equal(merged.partnerRev, 5);
  // A régi kliens blobja (jel nélkül) sosem viszi el a megbízottat.
  const old = { ...base, rev: 9, updatedAt: 999, updatedBy: 'old' };
  assert.deepEqual(mergeFocus(local, old).partner, a);
  assert.ok(!sameFocus(local, { ...local, partner: b }), 'a megbízott cseréje különbség: fel kell tölteni');
  // Kívülről jött adat: a rossz alakú megbízott nincs, a jel a blob rev-jéig.
  const n = normalizeSyncFocus({ partner: { name: 'X', salt: 'rövid', hash: 'rövid' }, partnerRev: 99, rev: 4 }, 'dev');
  assert.equal(n.partner, undefined);
  assert.equal(n.partnerRev, undefined);
  const ok = normalizeSyncFocus({ partner: a, partnerRev: 4, rev: 4 }, 'dev');
  assert.deepEqual(ok.partner, a);
  assert.equal(ok.partnerRev, 4);
});
