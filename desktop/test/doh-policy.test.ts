// A böngészők DoH-házirendje: mit ír a segéd, és mit vesz le az eltávolító.
//
// A tét kétirányú. Ha egy böngésző kimarad az egyik platformon, abban a
// böngészőben a hosts-tiltás csendben nem érvényesül (Windowson a Brave és a
// Chromium így maradt ki, amíg macOS-en benne volt). Ha pedig az eltávolító
// nem viszi, amit a segéd írt, a Breaker törlése után a böngésző
// „szervezet által felügyelt” marad, a DoH zárolva — a felhasználó gépén
// olyan nyom, amit senki nem kért.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  CHROMIUM_DOH_VALUE, CHROMIUM_TARGETS, FIREFOX_MAC_DOMAIN, FIREFOX_POLICY_JSON, FIREFOX_WIN_KEY,
  FIREFOX_WIN_VALUES, windowsDohCommands,
} from '../src/helper/doh-policy';

/** A tár gyökere — a tesztek forrásból és fordított kimenetből (dist-test) is futnak. */
function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'desktop', 'scripts', 'uninstall-windows.ps1'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('nem találom a tár gyökerét');
}
const ROOT = repoRoot();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** A PowerShell a registryt `HKLM:\…` alakban írja, a reg.exe `HKLM\…`-ban. */
const psKey = (k: string) => k.replace(/^HKLM\\/, 'HKLM:\\');

test('minden Chromium-alapú böngésző mindkét platformon kap házirendet', () => {
  assert.deepEqual(CHROMIUM_TARGETS.map((t) => t.name), ['Chrome', 'Edge', 'Chromium', 'Brave']);
  for (const t of CHROMIUM_TARGETS) {
    assert.ok(t.winKey.startsWith('HKLM\\SOFTWARE\\Policies\\'), t.winKey);
    assert.ok(t.macDomain.startsWith('/Library/Preferences/'), t.macDomain);
  }
  assert.equal(new Set(CHROMIUM_TARGETS.map((t) => t.winKey)).size, CHROMIUM_TARGETS.length);
  assert.equal(new Set(CHROMIUM_TARGETS.map((t) => t.macDomain)).size, CHROMIUM_TARGETS.length);
});

test('a Windows-parancsok: a Chromium-család „off”, a Firefox DWORD-ökkel', () => {
  const cmds = windowsDohCommands();
  assert.equal(cmds.length, CHROMIUM_TARGETS.length + FIREFOX_WIN_VALUES.length);
  for (const [i, t] of CHROMIUM_TARGETS.entries()) {
    assert.deepEqual(cmds[i], {
      cmd: 'reg', args: ['add', t.winKey, '/v', 'DnsOverHttpsMode', '/t', 'REG_SZ', '/d', 'off', '/f'],
    });
  }
  const ff = cmds.slice(CHROMIUM_TARGETS.length);
  assert.deepEqual(ff.map((c) => c.args), [
    ['add', FIREFOX_WIN_KEY, '/v', 'Enabled', '/t', 'REG_DWORD', '/d', '0', '/f'],
    ['add', FIREFOX_WIN_KEY, '/v', 'Locked', '/t', 'REG_DWORD', '/d', '1', '/f'],
  ]);
  assert.equal(FIREFOX_WIN_KEY, 'HKLM\\SOFTWARE\\Policies\\Mozilla\\Firefox\\DNSOverHTTPS');
});

test('a Windows-eltávolító mindent visz, amit a segéd ír — és csak ha a miénk', () => {
  const ps = read('desktop/scripts/uninstall-windows.ps1');
  for (const t of CHROMIUM_TARGETS) assert.ok(ps.includes(`"${psKey(t.winKey)}"`), `hiányzik: ${t.winKey}`);
  assert.ok(ps.includes(`"${CHROMIUM_DOH_VALUE.name}"`));
  assert.ok(ps.includes(`$v -eq "${CHROMIUM_DOH_VALUE.value}"`), 'csak az „off” értéket vehetjük le');
  assert.ok(ps.includes(`"${psKey(FIREFOX_WIN_KEY)}"`));
  assert.ok(ps.includes('$ffv.Enabled -eq 0 -and $ffv.Locked -eq 1'), 'a Firefoxét is csak ha a miénk');
  // A régi segéd policies.json-ja: csak a pontosan saját tartalmú fájl megy.
  assert.ok(ps.includes(`'${FIREFOX_POLICY_JSON.replace(/\s/g, '')}'`));
});

test('a macOS-eltávolító mindent visz, amit a segéd ír — és csak ha a miénk', () => {
  const sh = read('desktop/scripts/uninstall-macos.sh');
  for (const t of CHROMIUM_TARGETS) assert.ok(sh.includes(t.macDomain), `hiányzik: ${t.macDomain}`);
  assert.ok(sh.includes(`DnsOverHttpsMode 2>/dev/null)" = "off"`));
  assert.ok(sh.includes(`defaults delete ${FIREFOX_MAC_DOMAIN} DNSOverHTTPS`));
  assert.ok(sh.includes('*"Enabled = 0;"*"Locked = 1;"*'));
});

test('a segéd nem írja felül a Firefox policies.json-ját', () => {
  // Az egész fájlt cserélte volna — vele egy szervezet vagy egy másik
  // program saját Firefox-házirendjét is.
  const src = read('desktop/src/helper/hosts.ts');
  assert.ok(!/['"`]policies\.json['"`]|['"`]distribution['"`]/.test(src), 'a hosts.ts megint a policies.json-hoz nyúl');
  assert.ok(src.includes('windowsDohCommands()'));
});
