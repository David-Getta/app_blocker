// Az indok (miért tiltottad) a szinkronon: a nyertes rekorddal jön, mint a fedőnév.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mergeSite, type SyncSite } from '../src/shared/sync/merge';

const base: SyncSite = {
  id: 's1', domain: 'youtube.com', hostnames: ['youtube.com'], addedAt: 1, pauseUntil: null, pendingDeleteAt: null,
  rev: 1, updatedAt: 100, updatedBy: 'gep-a',
};

test('az indok a nagyobb rev-ű rekorddal jön, és a levétel is átmegy', () => {
  const withReason: SyncSite = { ...base, reason: 'Mert este nem alszom', rev: 2, updatedAt: 200, updatedBy: 'telefon' };
  assert.equal(mergeSite(base, withReason).reason, 'Mert este nem alszom');
  assert.equal(mergeSite(withReason, base).reason, 'Mert este nem alszom', 'a sorrend nem számít');
  // Levétel: az újabb rekordon már nincs indok — a régi nem támasztja fel.
  const removed: SyncSite = { ...base, rev: 3, updatedAt: 300, updatedBy: 'gep-a' };
  assert.equal(mergeSite(withReason, removed).reason, undefined);
});

test('azonos rev-nél a később írt rekord indoka marad', () => {
  const a: SyncSite = { ...base, rev: 2, updatedAt: 200, updatedBy: 'gep-a', reason: 'A' };
  const b: SyncSite = { ...base, rev: 2, updatedAt: 300, updatedBy: 'gep-b', reason: 'B' };
  assert.equal(mergeSite(a, b).reason, 'B');
  assert.equal(mergeSite(b, a).reason, 'B');
});
