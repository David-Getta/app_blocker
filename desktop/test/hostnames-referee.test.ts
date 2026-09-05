// Hosztnevek: felvenni ingyen, levenni próbatétel — és csak ami az oldalé.
//
// A hosts fájlba az oldal hosztnevei mennek. Egy név levétele (pl. a YouTube
// Music engedése a YouTube tiltása mellett) lazítás: ha egy gomb lenne, a
// hosts-szintű tiltás annyit érne, mint egy kikapcsoló.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-hosts-'));
process.env.BREAKER_STATE = path.join(tmp, 'state.json');
process.env.BREAKER_HOSTS = path.join(tmp, 'hosts');
fs.writeFileSync(process.env.BREAKER_HOSTS, '127.0.0.1 localhost\n');

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { defaultState, newId, type HelperState } from '../src/helper/state';
import * as referee from '../src/helper/referee';
import { hostnameBelongsTo, MAX_HOSTNAMES_PER_SITE, normalizeHostname } from '../src/shared/blocklist';
import type { Step, MathChainStep, MemoryStep, ReverseStep, TranscribeStep } from '../src/shared/challenges';
import { reverseString } from '../src/shared/challenges';

function stateWithSite(): { state: HelperState; siteId: string } {
  const state = defaultState();
  const siteId = newId('site');
  state.sites.push({
    id: siteId, domain: 'youtube.com',
    hostnames: ['m.youtube.com', 'music.youtube.com', 'www.youtube.com', 'youtube.com'],
    addedAt: Date.now(), pauseUntil: null, pendingDeleteAt: null,
  });
  return { state, siteId };
}

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

const codeIs = (code: string) => (e: unknown): boolean => (e as { code?: string }).code === code;

test('normalizeHostname: séma, port, út lekerül; a www és az aldomain marad', () => {
  assert.equal(normalizeHostname('https://Music.YouTube.com:443/watch?v=x'), 'music.youtube.com');
  assert.equal(normalizeHostname('www.youtube.com.'), 'www.youtube.com');
  assert.equal(normalizeHostname('youtu.be'), 'youtu.be');
  assert.equal(normalizeHostname('nincs-pont'), null);
  assert.equal(normalizeHostname(''), null);
  assert.equal(normalizeHostname('rossz_karakter.com'), null);
});

test('hostnameBelongsTo: aldomain és társoldal igen, hasonló nevű idegen nem', () => {
  assert.equal(hostnameBelongsTo('music.youtube.com', 'youtube.com'), true);
  assert.equal(hostnameBelongsTo('youtube.com', 'youtube.com'), true);
  assert.equal(hostnameBelongsTo('youtu.be', 'youtube.com'), true);
  assert.equal(hostnameBelongsTo('www.youtu.be', 'youtube.com'), true);
  assert.equal(hostnameBelongsTo('notyoutube.com', 'youtube.com'), false);
  assert.equal(hostnameBelongsTo('reddit.com', 'youtube.com'), false);
});

test('felvétel ingyen és azonnal — normalizálva, rendezve', () => {
  const { state, siteId } = stateWithSite();
  const r = referee.startHostnameChange(state, siteId, 'https://TV.youtube.com/', false, Date.now());
  assert.equal(r.applied, true);
  assert.equal(r.session, null);
  assert.deepEqual(state.sites[0].hostnames,
    ['m.youtube.com', 'music.youtube.com', 'tv.youtube.com', 'www.youtube.com', 'youtube.com']);
});

test('idegen név nem vehető fel — az másik oldal', () => {
  const { state, siteId } = stateWithSite();
  assert.throws(() => referee.startHostnameChange(state, siteId, 'reddit.com', false, Date.now()),
    codeIs('FOREIGN_HOSTNAME'));
  assert.throws(() => referee.startHostnameChange(state, siteId, 'notyoutube.com', false, Date.now()),
    codeIs('FOREIGN_HOSTNAME'));
  assert.equal(state.sites[0].hostnames.length, 4);
});

test('ugyanaz kétszer: marad egy, és nem indul semmi', () => {
  const { state, siteId } = stateWithSite();
  const r = referee.startHostnameChange(state, siteId, 'music.youtube.com', false, Date.now());
  assert.equal(r.applied, true);
  assert.equal(state.sites[0].hostnames.length, 4);
});

test('érvénytelen és túl sok név hiba', () => {
  const { state, siteId } = stateWithSite();
  assert.throws(() => referee.startHostnameChange(state, siteId, 'nincs pont', false, Date.now()),
    codeIs('BAD_HOSTNAME'));
  const now = Date.now();
  for (let i = state.sites[0].hostnames.length; i < MAX_HOSTNAMES_PER_SITE; i++) {
    referee.startHostnameChange(state, siteId, `h${i}.youtube.com`, false, now);
  }
  assert.throws(() => referee.startHostnameChange(state, siteId, 'meg-egy.youtube.com', false, now),
    codeIs('TOO_MANY_HOSTNAMES'));
});

test('az oldal saját címe nem vehető le — ahhoz törölni kell', () => {
  const { state, siteId } = stateWithSite();
  assert.throws(() => referee.startHostnameChange(state, siteId, 'youtube.com', true, Date.now()),
    codeIs('PRIMARY_HOSTNAME'));
  assert.throws(() => referee.startHostnameChange(state, siteId, 'nincs.youtube.com', true, Date.now()),
    codeIs('NO_HOSTNAME'));
});

test('levétel próbatétel: csak a teljesítés után tűnik el a név', () => {
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  const r = referee.startHostnameChange(state, siteId, 'music.youtube.com', true, now);
  assert.equal(r.applied, false);
  assert.ok(r.session, 'próbatétel indul');
  assert.ok(state.sites[0].hostnames.includes('music.youtube.com'), 'amíg tart, a név marad');
  solveWholeSession(state, now);
  assert.equal(state.session, null);
  assert.ok(!state.sites[0].hostnames.includes('music.youtube.com'), 'a teljesítés veszi le');
  assert.ok(state.sites[0].hostnames.includes('youtube.com'), 'a többi marad');
});

test('futó kísérlet mellett a levétel vár', () => {
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  referee.startHostnameChange(state, siteId, 'music.youtube.com', true, now);
  assert.throws(() => referee.startHostnameChange(state, siteId, 'm.youtube.com', true, now), codeIs('BUSY'));
});
