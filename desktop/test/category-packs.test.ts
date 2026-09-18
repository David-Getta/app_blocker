// Kategória-csomagok: tiszta domainek, és a három nyelv ugyanazt a listát hordozza.
//
//   UPDATE_PACKS_FIXTURE=1 npm test     — a fixtures/category-packs.json újraírása
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CATEGORY_PACKS, normalizeDomain } from '../src/shared/blocklist';

const FIXTURE = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'category-packs.json');

test('a csomagok domainjei tiszták, és mindegyik egy csomagban szerepel', () => {
  const seen = new Set<string>();
  const keys = new Set<string>();
  for (const p of CATEGORY_PACKS) {
    assert.ok(p.key && p.label && p.domains.length >= 3, `${p.key}: üres csomag`);
    assert.ok(!keys.has(p.key), `${p.key}: kétszer`);
    keys.add(p.key);
    for (const d of p.domains) {
      assert.equal(normalizeDomain(d), d, `${p.key}: ${d} nem a tiszta alak`);
      assert.ok(!seen.has(d), `${d} két csomagban is`);
      seen.add(d);
    }
  }
});

test('a fixtures/category-packs.json a gép listája — a telefonok ehhez mérik magukat', () => {
  const text = JSON.stringify(CATEGORY_PACKS, null, 2) + '\n';
  if (process.env.UPDATE_PACKS_FIXTURE) {
    fs.writeFileSync(FIXTURE, text);
    return;
  }
  assert.ok(fs.existsSync(FIXTURE), `nincs fixture: ${FIXTURE} — UPDATE_PACKS_FIXTURE=1 npm test`);
  assert.equal(fs.readFileSync(FIXTURE, 'utf8'), text,
    'a fixtures/category-packs.json elavult a gép listájához képest — UPDATE_PACKS_FIXTURE=1 npm test');
});
