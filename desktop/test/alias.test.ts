import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  displayName, displayNameNow, isAliased, normalizeAlias, MAX_ALIAS_LENGTH, REVEAL_MS,
} from '../src/shared/alias';

test('no alias means the domain is shown', () => {
  assert.equal(displayName({ domain: 'youtube.com' }), 'youtube.com');
  assert.equal(displayName({ domain: 'youtube.com', alias: '' }), 'youtube.com');
  assert.equal(displayName({ domain: 'youtube.com', alias: '   ' }), 'youtube.com');
  assert.equal(isAliased({ domain: 'youtube.com', alias: '  ' }), false);
});

test('an alias replaces the domain', () => {
  const site = { domain: 'youtube.com', alias: 'A videós' };
  assert.equal(displayName(site), 'A videós');
  assert.equal(isAliased(site), true);
});

test('control characters cannot hide inside an alias', () => {
  // Láthatatlanok maradnának a soron, de a hosszkorlátba beleszámítanának, és a
  // mentett állapotba is bekerülnének.
  const a = normalizeAlias('A\u0000vide\u001fós\u007f');
  assert.equal(a, 'A vide ós');
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(a!));
});

test('whitespace is collapsed and trimmed', () => {
  assert.equal(normalizeAlias('  A    videós  '), 'A videós');
  assert.equal(normalizeAlias('\n\tA videós\n'), 'A videós');
});

test('a very long alias is cut, and never left with a trailing space', () => {
  const long = 'x'.repeat(MAX_ALIAS_LENGTH + 20);
  assert.equal(normalizeAlias(long)!.length, MAX_ALIAS_LENGTH);
  // A vágás szóköz közepére eshet; a maradék végén ne maradjon lógó szóköz.
  const spaced = `${'a'.repeat(MAX_ALIAS_LENGTH - 1)} bbbb`;
  assert.equal(normalizeAlias(spaced), 'a'.repeat(MAX_ALIAS_LENGTH - 1));
});

test('nonsense input is treated as no alias', () => {
  assert.equal(normalizeAlias(undefined), undefined);
  assert.equal(normalizeAlias(null), undefined);
  assert.equal(normalizeAlias(42 as unknown as string), undefined);
  assert.equal(normalizeAlias(' '), undefined);
});

test('a reveal shows the real domain, but only while it lasts', () => {
  const site = { domain: 'youtube.com', alias: 'A videós' };
  const now = 1_000_000;
  assert.equal(displayNameNow(site, now, now + REVEAL_MS), 'youtube.com', 'felfedés alatt a cím');
  assert.equal(displayNameNow(site, now + REVEAL_MS - 1, now + REVEAL_MS), 'youtube.com');
  assert.equal(displayNameNow(site, now + REVEAL_MS, now + REVEAL_MS), 'A videós', 'lejárva újra fedőnév');
  assert.equal(displayNameNow(site, now + 60_000, now + REVEAL_MS), 'A videós');
  assert.equal(displayNameNow(site, now, undefined), 'A videós', 'felfedés nélkül sosem a cím');
});

test('a reveal on a site with no alias changes nothing', () => {
  assert.equal(displayNameNow({ domain: 'reddit.com' }, 0, 9_999_999), 'reddit.com');
});
