import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as referee from '../src/helper/referee';
import { defaultState, type HelperState } from '../src/helper/state';
import type {
  MathChainStep, MemoryStep, ReverseStep, Step, TranscribeStep,
} from '../src/shared/challenges';

/**
 * A csatorna-szűrő súrlódása.
 *
 * A felhasználó kifejezetten azt kérte, hogy a szűrő olyan kapcsolható legyen,
 * mint a munkamenet — és a munkamenetet leállítani sem egy gomb. A szabály tehát
 * ugyanaz, mint mindenhol: szigorítani ingyen, lazítani próbatétellel. Ha a
 * kikapcsolás ingyen lenne, a szűrő annyit érne, mint egy jegyzet arról, hogy
 * mit KELLENE néznem.
 */

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

const NOW = 1_800_000_000_000;

function withFilter(enabled = true): HelperState {
  const state = defaultState();
  referee.startChannelFilterSave(state, {
    host: 'youtube.com', allow: ['@jo', '@masik'], enabled,
  }, NOW);
  return state;
}

test('új szűrő felvétele ingyen van, bekapcsolva is', () => {
  // Egy új szűrő SZŰKÍT: eddig minden csatorna nyílt, mostantól csak kettő.
  const state = withFilter(true);
  assert.equal(state.session, null, 'nem indul próbatétel');
  const f = state.channelFilters![0];
  assert.equal(f.host, 'youtube.com');
  assert.deepEqual(f.allow, ['@jo', '@masik']);
  assert.equal(f.enabled, true);
});

test('engedélyezett csatorna LEVÉTELE ingyen van — szigorítás', () => {
  const state = withFilter(true);
  const f = state.channelFilters![0];
  const r = referee.startChannelFilterSave(state, {
    id: f.id, host: f.host, allow: ['@jo'], enabled: true,
  }, NOW);
  assert.equal(r.applied, true);
  assert.deepEqual(state.channelFilters![0].allow, ['@jo']);
});

test('a kikapcsolás próbatételbe kerül, és csak a teljesítés után él', () => {
  const state = withFilter(true);
  const f = state.channelFilters![0];
  const r = referee.startChannelFilterSave(state, {
    id: f.id, host: f.host, allow: f.allow, enabled: false,
  }, NOW);
  assert.equal(r.applied, false);
  assert.ok(r.session, 'próbatétel indul');
  // AMÍG A PRÓBATÉTEL TART, A SZŰRŐ MÉG ÉL. Ezen áll az egész: ha már az
  // indításkor kikapcsolna, a próbatétel díszlet lenne.
  assert.equal(state.channelFilters![0].enabled, true);
  solveWholeSession(state, NOW);
  assert.equal(state.session, null, 'a próbatétel elfogyott');
  assert.equal(state.channelFilters![0].enabled, false, 'most már kikapcsolt');
});

test('új engedélyezett csatorna bekapcsolt szűrőn: próbatétel', () => {
  const state = withFilter(true);
  const f = state.channelFilters![0];
  const r = referee.startChannelFilterSave(state, {
    id: f.id, host: f.host, allow: [...f.allow, '@uj'], enabled: true,
  }, NOW);
  assert.equal(r.applied, false);
  assert.deepEqual(state.channelFilters![0].allow, ['@jo', '@masik'], 'addig a régi lista él');
  solveWholeSession(state, NOW);
  assert.deepEqual(state.channelFilters![0].allow, ['@jo', '@masik', '@uj']);
});

test('kikapcsolt szűrőn minden módosítás ingyen van', () => {
  const state = withFilter(false);
  const f = state.channelFilters![0];
  const r = referee.startChannelFilterSave(state, {
    id: f.id, host: f.host, allow: [...f.allow, '@uj'], enabled: false,
  }, NOW);
  assert.equal(r.applied, true, 'kikapcsolva nem tilt semmit — nincs mit lazítani');
});

test('a törlés bekapcsolt szűrőn próbatétel, kikapcsoltan ingyen', () => {
  const on = withFilter(true);
  const rOn = referee.startChannelFilterDelete(on, on.channelFilters![0].id, NOW);
  assert.equal(rOn.applied, false);
  assert.equal(on.channelFilters!.length, 1, 'a próbatételig a szűrő megvan');
  solveWholeSession(on, NOW);
  assert.equal(on.channelFilters!.length, 0, 'teljesítés után tűnik el');

  const off = withFilter(false);
  const rOff = referee.startChannelFilterDelete(off, off.channelFilters![0].id, NOW);
  assert.equal(rOff.applied, true);
  assert.equal(off.channelFilters!.length, 0);
});

test('egy oldalra csak egy szűrő lehet', () => {
  const state = withFilter(true);
  assert.throws(
    () => referee.startChannelFilterSave(state, {
      host: 'www.youtube.com', allow: ['@x'], enabled: false,
    }, NOW),
    /már van/,
  );
});

test('szemét bemenetből nem lesz szűrő', () => {
  const state = defaultState();
  assert.throws(
    () => referee.startChannelFilterSave(state, { host: 'nem jó', allow: ['@x'], enabled: true }, NOW),
    /oldal/,
  );
  assert.throws(
    () => referee.startChannelFilterSave(state, { host: 'youtube.com', allow: ['két szó'], enabled: true }, NOW),
    /oldal|csatorna/,
  );
});
