// Mérés nélkül nincs keret-idő: a bekapcsolható mérés-őr.
//
// A tét: a napi keret és az adag a mért időből fogy, a mérés az appban fut.
// A kilépés megállítja — és amíg az app nem fut, a keretes oldal korlátlanul
// nyitva volna. A mérés-őr ezt zárja be: ha az app nem jelentkezik, a
// keretes és adagos oldalak zárva. Bekapcsolni ingyen, kikapcsolni próbatétel.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  APP_GRACE_MS, appPresent, closedForMissingMeasurement, needsMeasurement, WAKE_GAP_MS,
} from '../src/shared/measure-guard';
import { activeHostnames } from '../src/helper/hosts';
import * as referee from '../src/helper/referee';
import { defaultState, type HelperState, type SiteRec } from '../src/helper/state';
import { statusOf } from '../src/helper/server';
import type {
  MathChainStep, MemoryStep, ReverseStep, Step, TranscribeStep,
} from '../src/shared/challenges';

const T0 = 1_800_000_000_000;

const site = (over: Partial<SiteRec> = {}): SiteRec => ({
  id: 's1', domain: 'youtube.com', hostnames: ['youtube.com', 'www.youtube.com'],
  addedAt: 0, pauseUntil: null, pendingDeleteAt: null,
  // Mindig tiltott helyett NYITVA a menetrend szerint egész héten — így csak a
  // keret (vagy a mérés-őr) zárhatja.
  schedule: { mode: 'scheduled_allow', bands: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }] },
  ...over,
});

// ------------------------------------------------------------------ a mag

test('az app jelen van a türelmi időn belül, utána nincs', () => {
  assert.equal(APP_GRACE_MS, 3 * 60_000);
  assert.equal(appPresent(T0, T0, T0 + APP_GRACE_MS), true, 'a határon még igen');
  assert.equal(appPresent(T0, T0 + APP_GRACE_MS, T0 + APP_GRACE_MS + 1), false);
});

test('ébredés után jár a türelmi idő: a nagy ugrás a körök között nem távollét', () => {
  // A segéd utolsó köre egy órája volt (alvás), az app is akkor jelzett utoljára.
  assert.equal(appPresent(T0, T0, T0 + 3600_000), true, 'épp felébredtünk: még nem jelezhetett');
  assert.equal(appPresent(T0, T0 + 3600_000 - WAKE_GAP_MS, T0 + 3600_000), false,
    'rendes körök mellett az egyórás csend távollét');
});

test('a keret és az adag mérés nélkül nem él — a puszta tiltás igen', () => {
  assert.equal(needsMeasurement({ dailyLimitSeconds: 20 * 60 }), true);
  assert.equal(needsMeasurement({ burstSeconds: 120, cooldownSeconds: 600 }), true);
  assert.equal(needsMeasurement({}), false);
  assert.equal(needsMeasurement({ dailyLimitSeconds: 0 }), false, 'nulla: nincs keret');
  assert.equal(needsMeasurement({ burstSeconds: 120 }), false, 'szünet nélkül nincs adag');
});

test('a mérés-őr csak bekapcsolva, csak távollétben, és a kifizetett feloldás felülírja', () => {
  const s = { dailyLimitSeconds: 1200, pauseUntil: null };
  assert.equal(closedForMissingMeasurement(s, true, false, T0), true);
  assert.equal(closedForMissingMeasurement(s, true, true, T0), false, 'az app fut');
  assert.equal(closedForMissingMeasurement(s, false, false, T0), false, 'nincs bekapcsolva');
  assert.equal(closedForMissingMeasurement({ ...s, pauseUntil: T0 + 60_000 }, true, false, T0), false,
    'a kifizetett feloldás az övé');
  assert.equal(closedForMissingMeasurement({ pauseUntil: null }, true, false, T0), false, 'keret nélkül nincs mit őrizni');
});

// ------------------------------------------------------------ a hosts-blokk

test('a hosts-blokk: távollétben a keretes oldal zárva, a keret nélküli nem', () => {
  const st = defaultState();
  st.sites = [
    site({ dailyLimitSeconds: 20 * 60 }),
    site({ id: 's2', domain: 'wiki.org', hostnames: ['wiki.org'] }),
  ];
  st.requireMeasurement = true;
  assert.deepEqual(activeHostnames(st, T0, true), [], 'az app fut: a keret még nem fogyott el');
  assert.deepEqual(activeHostnames(st, T0, false), ['www.youtube.com', 'youtube.com']);
  delete st.requireMeasurement;
  assert.deepEqual(activeHostnames(st, T0, false), [], 'kikapcsolt őr: a régi viselkedés');
});

// ------------------------------------------------------------------ a bíró

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
    case 'PARTNER': throw new Error('megbízott nélkül futunk');
  }
}

function solveWholeSession(state: HelperState, now: number): void {
  let guard = 0;
  while (state.session && guard++ < 200) {
    const step = state.session.steps[state.session.stepIndex];
    if (step.type === 'DELAY') {
      step.claimableAt = now - 1;
      referee.claimDelay(state, state.session.id, now);
      continue;
    }
    referee.submitAnswer(state, state.session.id, solveStep(step, now), now);
  }
}

test('bekapcsolni ingyen, kikapcsolni próbatétel — és csak a teljesítéskor kapcsol ki', () => {
  const st = defaultState();
  const on = referee.setRequireMeasurement(st, true, T0);
  assert.deepEqual(on, { applied: true, session: null });
  assert.equal(st.requireMeasurement, true);
  assert.equal(statusOf(st, true).requireMeasurement, true, 'a felület is látja');

  const off = referee.setRequireMeasurement(st, false, T0);
  assert.equal(off.applied, false);
  assert.ok(off.session, 'kikapcsolni csak próbatétellel');
  assert.equal(off.session!.siteId, 'measure');
  assert.equal(st.requireMeasurement, true, 'a próbák alatt az őr marad');

  solveWholeSession(st, T0 + 1000);
  assert.equal(st.session, null);
  assert.equal(st.requireMeasurement, undefined, 'a teljesítéskor kapcsol ki');
  assert.equal(statusOf(st, true).requireMeasurement, false);
});

test('ugyanaz az állapot nem kerül semmibe; futó kísérlet mellett nincs új', () => {
  const st = defaultState();
  assert.deepEqual(referee.setRequireMeasurement(st, false, T0), { applied: true, session: null });
  referee.setRequireMeasurement(st, true, T0);
  assert.deepEqual(referee.setRequireMeasurement(st, true, T0), { applied: true, session: null });
  referee.setRequireMeasurement(st, false, T0);
  assert.throws(() => referee.setRequireMeasurement(st, false, T0), /folyamatban lévő kísérletet/);
});

test('zárlat alatt a kikapcsolás el sem indul', () => {
  const st = defaultState();
  referee.setRequireMeasurement(st, true, T0);
  referee.startLockdownNow(st, 3600_000, T0);
  assert.throws(() => referee.setRequireMeasurement(st, false, T0 + 1000));
  assert.equal(st.requireMeasurement, true);
  assert.equal(st.session, null);
});
