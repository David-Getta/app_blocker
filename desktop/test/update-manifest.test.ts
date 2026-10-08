import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  appBundlePath, compareVersions, macosMajor, macRequirementOf, macTooOldText, pickMacAsset, pickMacUpdate,
  parseLatestMacYml, manifestEntryFor,
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
    asset('Breaker-0.2.0.dmg'),
    asset('Breaker-0.2.0-arm64.dmg'),
    asset('Breaker-0.2.0-mac.zip'),
    asset('Breaker-0.2.0-arm64-mac.zip'),
    asset('Breaker-0.2.0.exe'),
  ];
  assert.equal(pickMacAsset(assets, 'arm64')?.name, 'Breaker-0.2.0-arm64-mac.zip');
  assert.equal(pickMacAsset(assets, 'x64')?.name, 'Breaker-0.2.0-mac.zip');
});

test('a universal build is accepted, but only as a fallback', () => {
  const universalOnly = [asset('Breaker-0.2.0-universal-mac.zip')];
  assert.equal(pickMacAsset(universalOnly, 'arm64')?.name, 'Breaker-0.2.0-universal-mac.zip');

  const both = [asset('Breaker-0.2.0-universal-mac.zip'), asset('Breaker-0.2.0-arm64-mac.zip')];
  assert.equal(pickMacAsset(both, 'arm64')?.name, 'Breaker-0.2.0-arm64-mac.zip',
    'the arch-specific build is half the download');
});

test('no mac zip in the release means no self-update', () => {
  assert.equal(pickMacAsset([asset('Breaker-0.2.0.dmg'), asset('Breaker-0.2.0.exe')], 'arm64'), null);
});

// A rendszerkövetelményt hordozó csomag (`-darwinNN.zip`). A régi frissítő
// (≤ v0.4.240) minden `mac` nevű zipet felrakna, és a régi példányt az új
// indítása ELŐTT törli — egy macOS 13-at kérő build egy macOS 12-es gépen el
// nem induló appot hagyna. Ezért a név NEM tartalmazhatja a `mac` szót.

test('a követelményt hordozó név: a régi frissítő nem látja, az új kiolvassa', () => {
  const gated = 'Breaker-0.4.242-arm64-darwin13.zip';
  assert.equal(macRequirementOf(gated), 13);
  assert.equal(macRequirementOf('Breaker-0.4.242-x64-darwin13.zip'), 13);
  assert.equal(macRequirementOf('Breaker-0.4.240-arm64-mac.zip'), null);
  assert.equal(macRequirementOf('Breaker-bovitmeny-v0.4.242.zip'), null);
  // A régi frissítő mintája: `.zip` és `mac` a névben. Ha ez illene, a régi
  // gépek egy el nem induló appot kapnának.
  assert.equal(/\.zip$/i.test(gated) && /mac/i.test(gated), false);
  assert.equal(pickMacAsset([asset(gated)], 'arm64'), null, 'a v0.4.240-es választó nem nyúl hozzá');
});

test('a macOS főverziója a rendszer verziójából — ismeretlennél null', () => {
  assert.equal(macosMajor('12.7.6'), 12);
  assert.equal(macosMajor('10.15.7'), 10);
  assert.equal(macosMajor('13.0'), 13);
  assert.equal(macosMajor('26.0.1'), 26);
  assert.equal(macosMajor('15'), 15);
  assert.equal(macosMajor(''), null);
  assert.equal(macosMajor('Darwin 22.6.0'), null);
  assert.equal(macosMajor('12.x'), null);
});

test('elég új macOS-en a követelményt hordozó csomag jön, a gép architektúrája szerint', () => {
  const assets = [
    asset('Breaker-0.4.242-arm64.dmg'),
    asset('Breaker-0.4.242-arm64-darwin13.zip'),
    asset('Breaker-0.4.242-x64-darwin13.zip'),
    asset('Breaker-bovitmeny-v0.4.242.zip'),
  ];
  const arm = pickMacUpdate(assets, 'arm64', '14.6.1');
  assert.equal(arm.kind === 'asset' && arm.asset.name, 'Breaker-0.4.242-arm64-darwin13.zip');
  const intel = pickMacUpdate(assets, 'x64', '13.0');
  assert.equal(intel.kind === 'asset' && intel.asset.name, 'Breaker-0.4.242-x64-darwin13.zip');
});

test('régebbi macOS-en semmi nem töltődik le — és kimondjuk, mi kell', () => {
  const assets = [asset('Breaker-0.4.242-arm64-darwin13.zip'), asset('Breaker-0.4.242-x64-darwin13.zip')];
  assert.deepEqual(pickMacUpdate(assets, 'x64', '12.7.6'), { kind: 'too-old', needs: 13, has: '12.7.6' });
  assert.deepEqual(pickMacUpdate(assets, 'x64', '10.15.7'), { kind: 'too-old', needs: 13, has: '10.15.7' });
  // Ismeretlen rendszerverziónál az óvatos irány: egy el nem induló app
  // rosszabb, mint egy régi, működő verzió.
  assert.deepEqual(pickMacUpdate(assets, 'arm64', ''), { kind: 'too-old', needs: 13, has: '' });
});

test('a régi nevű csomag a korábbi kiadásoké — azt továbbra is felismerjük', () => {
  const legacy = [asset('Breaker-0.4.240-arm64-mac.zip'), asset('Breaker-0.4.240-mac.zip')];
  const arm = pickMacUpdate(legacy, 'arm64', '11.7');
  assert.equal(arm.kind === 'asset' && arm.asset.name, 'Breaker-0.4.240-arm64-mac.zip');
  assert.deepEqual(pickMacUpdate([asset('Breaker-0.4.242.exe')], 'arm64', '14.0'), { kind: 'none' });
  // Ha a kiadásban mindkét fajta van, a követelményt hordozó dönt.
  const both = [...legacy, asset('Breaker-0.4.242-arm64-darwin13.zip')];
  assert.equal(pickMacUpdate(both, 'arm64', '12.0').kind, 'too-old');
});

test('a fiók-panel mondata: melyik verzió, mit kér, mi fut itt — és hogy az app működik tovább', () => {
  const t = macTooOldText({ version: '0.4.242', needs: 13, has: '12.7.6' });
  assert.ok(t.includes('v0.4.242') && t.includes('macOS 13') && t.includes('macOS 12.7.6'), t);
  assert.ok(t.includes('működik tovább'), 'a mondat nem ijeszt: a tiltás és a mérés megy tovább');
  const unknown = macTooOldText({ version: '0.4.242', needs: 13, has: '' });
  assert.ok(unknown.includes('nem sikerült kiolvasni') && !unknown.includes('macOS  '), unknown);
});

test('a követelményt hordozó univerzális csomag csak tartalék, és rá is áll a követelmény', () => {
  const universal = [asset('Breaker-0.4.242-universal-darwin13.zip')];
  const ok = pickMacUpdate(universal, 'arm64', '13.1');
  assert.equal(ok.kind === 'asset' && ok.asset.name, 'Breaker-0.4.242-universal-darwin13.zip');
  assert.equal(pickMacUpdate(universal, 'x64', '12.1').kind, 'too-old');
  // Csak a másik architektúra csomagja van: nincs mit felrakni.
  assert.deepEqual(pickMacUpdate([asset('Breaker-0.4.242-arm64-darwin13.zip')], 'x64', '14.0'), { kind: 'none' });
});

test('latest-mac.yml is read for version, files and checksums', () => {
  const yml = [
    'version: 0.2.0',
    'files:',
    '  - url: Breaker-0.2.0-mac.zip',
    '    sha512: AAAAsha512forintel==',
    '    size: 91234567',
    '  - url: Breaker-0.2.0-arm64-mac.zip',
    '    sha512: BBBBsha512forarm==',
    '    size: 87654321',
    'path: Breaker-0.2.0-mac.zip',
    'sha512: AAAAsha512forintel==',
    'releaseDate: 2026-08-23T10:00:00.000Z',
  ].join('\n');

  const m = parseLatestMacYml(yml);
  assert.equal(m.version, '0.2.0');
  assert.equal(m.files.length, 2);
  assert.equal(manifestEntryFor(m, 'Breaker-0.2.0-arm64-mac.zip')?.sha512, 'BBBBsha512forarm==');
  assert.equal(manifestEntryFor(m, 'Breaker-0.2.0-arm64-mac.zip')?.size, 87654321);
  assert.equal(manifestEntryFor(m, 'nincs-ilyen.zip'), null);
});

test('a malformed manifest degrades instead of throwing', () => {
  assert.deepEqual(parseLatestMacYml('').files, []);
  assert.deepEqual(parseLatestMacYml('csak: valami\nmás: sor').files, []);
  const partial = parseLatestMacYml('files:\n  - url: a.zip\n');
  assert.equal(partial.files[0].url, 'a.zip');
  assert.equal(partial.files[0].sha512, undefined, 'no checksum is a missing check, not a crash');
});

test('the app bundle is derived from the executable path', () => {
  assert.equal(
    appBundlePath('/Applications/Breaker.app/Contents/MacOS/Breaker'),
    '/Applications/Breaker.app');
  assert.equal(
    appBundlePath('/Users/valaki/Downloads/Breaker.app/Contents/MacOS/Breaker'),
    '/Users/valaki/Downloads/Breaker.app');
});

test('outside a bundle there is nothing to replace', () => {
  // dev run / Linux / a loose build directory: the self-updater must not fire
  assert.equal(appBundlePath('/usr/local/bin/breaker'), null);
  assert.equal(appBundlePath('C:\\Program Files\\Breaker\\Breaker.exe'), null);
});
