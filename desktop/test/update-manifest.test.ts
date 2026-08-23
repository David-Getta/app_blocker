import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  compareVersions, pickMacAsset, parseLatestMacYml, manifestEntryFor,
} from '../src/shared/update-manifest';

const asset = (name: string) => ({ name, url: `https://example/${name}` });

test('version compare handles the shapes GitHub tags actually have', () => {
  assert.ok(compareVersions('0.2.0', '0.1.9') > 0);
  assert.ok(compareVersions('v0.2.0', '0.2.0') === 0, 'a leading v is not a difference');
  assert.ok(compareVersions('1.0', '1.0.0') === 0, 'missing parts count as zero');
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0, 'numeric, not lexicographic');
  assert.ok(compareVersions('0.1.0', '0.1.0') === 0);
  assert.ok(compareVersions('rubbish', '0.0.1') < 0, 'garbage is never newer');
});

test('the right zip is picked for the running Mac', () => {
  const assets = [
    asset('Lakat-0.2.0.dmg'),
    asset('Lakat-0.2.0-arm64.dmg'),
    asset('Lakat-0.2.0-mac.zip'),
    asset('Lakat-0.2.0-arm64-mac.zip'),
    asset('Lakat-0.2.0.exe'),
  ];
  assert.equal(pickMacAsset(assets, 'arm64')?.name, 'Lakat-0.2.0-arm64-mac.zip');
  assert.equal(pickMacAsset(assets, 'x64')?.name, 'Lakat-0.2.0-mac.zip');
});

test('a universal build is accepted, but only as a fallback', () => {
  const universalOnly = [asset('Lakat-0.2.0-universal-mac.zip')];
  assert.equal(pickMacAsset(universalOnly, 'arm64')?.name, 'Lakat-0.2.0-universal-mac.zip');

  const both = [asset('Lakat-0.2.0-universal-mac.zip'), asset('Lakat-0.2.0-arm64-mac.zip')];
  assert.equal(pickMacAsset(both, 'arm64')?.name, 'Lakat-0.2.0-arm64-mac.zip',
    'the arch-specific build is half the download');
});

test('no mac zip in the release means no self-update', () => {
  assert.equal(pickMacAsset([asset('Lakat-0.2.0.dmg'), asset('Lakat-0.2.0.exe')], 'arm64'), null);
});

test('latest-mac.yml is read for version, files and checksums', () => {
  const yml = [
    'version: 0.2.0',
    'files:',
    '  - url: Lakat-0.2.0-mac.zip',
    '    sha512: AAAAsha512forintel==',
    '    size: 91234567',
    '  - url: Lakat-0.2.0-arm64-mac.zip',
    '    sha512: BBBBsha512forarm==',
    '    size: 87654321',
    'path: Lakat-0.2.0-mac.zip',
    'sha512: AAAAsha512forintel==',
    'releaseDate: 2026-08-23T10:00:00.000Z',
  ].join('\n');

  const m = parseLatestMacYml(yml);
  assert.equal(m.version, '0.2.0');
  assert.equal(m.files.length, 2);
  assert.equal(manifestEntryFor(m, 'Lakat-0.2.0-arm64-mac.zip')?.sha512, 'BBBBsha512forarm==');
  assert.equal(manifestEntryFor(m, 'Lakat-0.2.0-arm64-mac.zip')?.size, 87654321);
  assert.equal(manifestEntryFor(m, 'nincs-ilyen.zip'), null);
});

test('a malformed manifest degrades instead of throwing', () => {
  assert.deepEqual(parseLatestMacYml('').files, []);
  assert.deepEqual(parseLatestMacYml('csak: valami\nmás: sor').files, []);
  const partial = parseLatestMacYml('files:\n  - url: a.zip\n');
  assert.equal(partial.files[0].url, 'a.zip');
  assert.equal(partial.files[0].sha512, undefined, 'no checksum is a missing check, not a crash');
});
