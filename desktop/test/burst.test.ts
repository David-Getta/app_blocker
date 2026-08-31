import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  isBurstLoosening, isCoolingDown, normalizeBurst, noteBurstUsage,
  type BurstRule, type BurstState,
} from '../src/shared/burst';
import { isBlockedNowWithLimit } from '../src/shared/limits';
import { emptyUsage } from '../src/shared/usage';
import * as referee from '../src/helper/referee';
import { startBurstChange, tick } from '../src/helper/referee';
import { defaultState, type HelperState, type SiteRec } from '../src/helper/state';
import type {
  MathChainStep, MemoryStep, ReverseStep, Step, TranscribeStep,
} from '../src/shared/challenges';

function reverseString(s: string): string { return [...s].reverse().join(''); }

function solveStep(step: Step, now: number): string {
  switch (step.type) {
    case 'TRANSCRIBE': return (step as TranscribeStep).text;
    case 'MATH_CHAIN': {
      const m = step as MathChainStep;
      return String(m.problems[m.pos].a);
    }
    case 'MEMORY': {
      const m = step as MemoryStep;
      m.armedAt = now - m.showMs - m.waitMs - 1000;
      return m.code;
    }
    case 'REVERSE': return reverseString((step as ReverseStep).text);
    case 'DELAY': throw new Error('a várakozást átvenni kell, nem megválaszolni');
  }
}

function solveWholeSession(state: HelperState, now: number): void {
  let guard = 0;
  while (state.session && guard++ < 200) {
    const step = state.session.steps[state.session.stepIndex];
    referee.submitAnswer(state, state.session.id, solveStep(step, now), now);
  }
}

/**
 * Az adag-szabály: ennyi használat után ennyi szünet. A példa, amiből
 * született: 2 perc Gemini -> 10 perc tiltás -> feloldás.
 */

const RULE: BurstRule = { burstSeconds: 120, cooldownSeconds: 600 };
const T0 = 1_000_000_000;

// ------------------------------------------------------------- normalizálás

test('a szabályhoz mindkét szám kell — fél-kitöltve nincs szabály', () => {
  assert.deepEqual(normalizeBurst(120, 600), RULE);
  assert.equal(normalizeBurst(120, null), null);
  assert.equal(normalizeBurst(null, 600), null);
  assert.equal(normalizeBurst(0, 600), null);
  assert.equal(normalizeBurst(120, -1), null);
  assert.equal(normalizeBurst(Number.NaN, 600), null);
});

test('a plafon egy nap — ami több, az már a sima tiltás dolga', () => {
  const r = normalizeBurst(999 * 3600, 999 * 3600)!;
  assert.equal(r.burstSeconds, 24 * 3600);
  assert.equal(r.cooldownSeconds, 24 * 3600);
});

// ------------------------------------------------------------- a számláló

test('az adag betelik, indul a hűtés, a számláló nulláról jön vissza', () => {
  let st: BurstState | undefined;
  st = noteBurstUsage(RULE, st, 60, T0);
  assert.equal(st.usedSeconds, 60);
  assert.equal(isCoolingDown(st, T0), false, 'fél adag még nem tilt');
  st = noteBurstUsage(RULE, st, 60, T0 + 60_000);
  assert.equal(st.usedSeconds, 0, 'beteléskor a számláló nullázódik');
  assert.equal(st.cooldownUntil, T0 + 60_000 + 600_000, 'a hűtés a minta idejétől számít');
  assert.ok(isCoolingDown(st, T0 + 120_000));
  assert.equal(isCoolingDown(st, T0 + 60_000 + 600_000), false, 'a hűtés magától lejár');
});

test('hűtés alatt a minta nem számít — a hibalapon ülve mért idő nem hosszabbít', () => {
  let st = noteBurstUsage(RULE, undefined, 120, T0); // azonnal betelik
  const until = st.cooldownUntil;
  st = noteBurstUsage(RULE, st, 300, T0 + 60_000); // a tiltott lapon mért idő
  assert.equal(st.cooldownUntil, until, 'a hűtés nem tolódik ki');
  assert.equal(st.usedSeconds, 0, 'és a következő adagba sem számít bele');
});

test('egy hűtésnyi pihenő után a számláló tiszta lappal indul', () => {
  let st = noteBurstUsage(RULE, undefined, 100, T0);
  assert.equal(st.usedSeconds, 100);
  // 10 percnél hosszabb csend -> a következő minta nem 100+30, hanem 30.
  st = noteBurstUsage(RULE, st, 30, T0 + 601_000);
  assert.equal(st.usedSeconds, 30);
});

test('az elkésett régi minta nem gyárthat hamis pihenőt', () => {
  let st = noteBurstUsage(RULE, undefined, 80, T0);
  // Egy köteg elkésett, RÉGEBBI szeletet hoz: a lastAt nem léphet hátra,
  // különben a következő friss minta „pihenőt” látna, és nullázna.
  st = noteBurstUsage(RULE, st, 10, T0 - 700_000);
  assert.equal(st.lastAt, T0, 'a lastAt nem lép hátra');
  st = noteBurstUsage(RULE, st, 15, T0 + 5_000);
  assert.equal(st.usedSeconds, 105, 'nem volt pihenő — a számláló gyűlik tovább');
});

// ---------------------------------------------------------------- lazítás

test('mi lazítás és mi nem — mert a lazítás próbatételbe kerül', () => {
  assert.equal(isBurstLoosening(null, RULE), false, 'szabályt felvenni szigorítás');
  assert.equal(isBurstLoosening(RULE, null), true, 'levenni lazítás');
  assert.equal(isBurstLoosening(RULE, { ...RULE, burstSeconds: 60 }), false, 'kisebb adag: szigorítás');
  assert.equal(isBurstLoosening(RULE, { ...RULE, burstSeconds: 300 }), true, 'nagyobb adag: lazítás');
  assert.equal(isBurstLoosening(RULE, { ...RULE, cooldownSeconds: 1200 }), false, 'hosszabb szünet: szigorítás');
  assert.equal(isBurstLoosening(RULE, { ...RULE, cooldownSeconds: 60 }), true, 'rövidebb szünet: lazítás');
  assert.equal(
    isBurstLoosening(RULE, { burstSeconds: 60, cooldownSeconds: 60 }), true,
    'vegyes módosításnál a lazító fele dönt',
  );
});

// ------------------------------------------------------------- tiltás-döntés

function siteWith(over: Partial<SiteRec>): SiteRec {
  return {
    id: 'site_1', domain: 'gemini.google.com', hostnames: ['gemini.google.com'],
    addedAt: T0, pauseUntil: null, pendingDeleteAt: null,
    // Az adag-szabály tipikus gazdája nem az egészében tiltott oldal, hanem a
    // menetrend szerint SZABAD: azt nem a menetrend zárja, hanem az adag. A
    // „sose tiltsa” alak egy teljes-hetes engedő sáv (az üres sáv-lista
    // szándékosan mindig-tiltást jelent — fail-closed).
    schedule: {
      mode: 'scheduled_allow',
      bands: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }],
    },
    ...over,
  };
}

test('a hűtés DNS-tiltás, a megvásárolt szünet viszont a hűtést is legyőzi', () => {
  const site = siteWith({ burstSeconds: 120, cooldownSeconds: 600 });
  const burst: BurstState = { usedSeconds: 0, lastAt: T0, cooldownUntil: T0 + 600_000 };
  assert.equal(isBlockedNowWithLimit(site, emptyUsage(), T0 + 1000, null, burst), true);
  assert.equal(
    isBlockedNowWithLimit(siteWith({ ...site, pauseUntil: T0 + 300_000 }), emptyUsage(), T0 + 1000, null, burst),
    false,
    'a szünetért próbatétellel fizettek — a hűtés nem veheti el',
  );
  assert.equal(isBlockedNowWithLimit(site, emptyUsage(), T0 + 601_000, null, burst), false,
    'a hűtés lejártával az oldal magától kinyílik');
});

// ------------------------------------------------------------- referee-kapu

function stateWith(site: SiteRec): HelperState {
  const s = defaultState();
  s.sites = [site];
  return s;
}

test('felvenni és szigorítani ingyen, lazítani próbatétel — és a teljesítés alkalmaz', () => {
  const st = stateWith(siteWith({}));
  const r1 = startBurstChange(st, 'site_1', 120, 600, T0);
  assert.equal(r1.applied, true, 'szabályt felvenni szigorítás — azonnal él');
  assert.equal(st.sites[0].burstSeconds, 120);

  const r2 = startBurstChange(st, 'site_1', 60, 900, T0);
  assert.equal(r2.applied, true, 'kisebb adag, hosszabb szünet: ingyen');

  const r3 = startBurstChange(st, 'site_1', 300, 900, T0);
  assert.equal(r3.applied, false, 'nagyobb adag: próbatétel');
  assert.equal(st.sites[0].burstSeconds, 60, 'amíg a próbatétel tart, a régi él');
  assert.deepEqual(st.session?.pendingBurst, { burstSeconds: 300, cooldownSeconds: 900 });

  // A próbatétel teljesítése: a függő szabály életbe lép.
  solveWholeSession(st, T0 + 60_000);
  assert.equal(st.sites[0].burstSeconds, 300, 'a teljesítés alkalmazza a lazítást');
  assert.equal(st.sites[0].cooldownSeconds, 900);
  assert.equal(st.session, null);
});

test('a fél-kitöltött kérés hiba, nem meglepetés', () => {
  const st = stateWith(siteWith({ burstSeconds: 120, cooldownSeconds: 600 }));
  assert.throws(() => startBurstChange(st, 'site_1', 60, null, T0), /mindkét szám/);
  assert.equal(st.sites[0].burstSeconds, 120, 'a szabály nem változott');
});

// ------------------------------------------------------------- takarítás

test('a tick a törölt oldal és a rég alvó számlálót is kitakarítja', () => {
  const st = stateWith(siteWith({ burstSeconds: 120, cooldownSeconds: 600 }));
  st.bursts = {
    site_1: { usedSeconds: 10, lastAt: T0, cooldownUntil: 0 },
    site_torolt: { usedSeconds: 5, lastAt: T0, cooldownUntil: 0 },
  };
  assert.equal(tick(st, T0 + 60_000), true, 'az árva bejegyzés törlése változás');
  assert.deepEqual(Object.keys(st.bursts!), ['site_1'], 'az élő oldalé megmarad');
  assert.equal(tick(st, T0 + 25 * 3600_000), true);
  assert.deepEqual(Object.keys(st.bursts!), [], 'egy nap csend után a számláló is megy');
});
