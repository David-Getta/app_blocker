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
  CHROMIUM_DOH_VALUE, CHROMIUM_TARGETS, FIREFOX_MAC_DOMAIN, FIREFOX_MAC_ENABLE_KEY, FIREFOX_POLICY_JSON,
  FIREFOX_SWITCH_MARK, FIREFOX_WIN_KEY, FIREFOX_WIN_VALUES, DOH_PROFILE_ID, dohProfileXml, windowsDohCommands,
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

test('a Windows-parancsok: a Chromium-család „off”, a Firefox DWORD-ökkel (a Fallback is)', () => {
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
    // Egy ott maradt Fallback=0 mellett a Firefox az Enabled=0-t „csak DoH”-nak venné.
    ['add', FIREFOX_WIN_KEY, '/v', 'Fallback', '/t', 'REG_DWORD', '/d', '1', '/f'],
  ]);
  assert.equal(FIREFOX_WIN_KEY, 'HKLM\\SOFTWARE\\Policies\\Mozilla\\Firefox\\DNSOverHTTPS');
});

test('a Windows-eltávolító mindent visz, amit a segéd ír — és csak ha a miénk', () => {
  const ps = read('desktop/scripts/uninstall-windows.ps1');
  for (const t of CHROMIUM_TARGETS) assert.ok(ps.includes(`"${psKey(t.winKey)}"`), `hiányzik: ${t.winKey}`);
  assert.ok(ps.includes(`"${CHROMIUM_DOH_VALUE.name}"`));
  assert.ok(ps.includes(`$v -eq "${CHROMIUM_DOH_VALUE.value}"`), 'csak az „off” értéket vehetjük le');
  assert.ok(ps.includes(`"${psKey(FIREFOX_WIN_KEY)}"`));
  for (const v of FIREFOX_WIN_VALUES) assert.ok(ps.includes(`"${v.name}"`), `a Firefox ${v.name} értékét nem veszi le`);
  assert.ok(ps.includes('$ffv.Enabled -eq 0 -and $ffv.Locked -eq 1'), 'a Firefoxét is csak ha a miénk');
  assert.ok(ps.includes('if ($ffv.Fallback -eq 1) { Remove-ItemProperty -Path $ff -Name "Fallback"'), 'a Fallback=1 is a miénk');
  // Az üresen maradt kulcs is nyom (a Firefox egy üres DNSOverHTTPS-t is házirendnek vesz).
  assert.ok(ps.includes('Remove-EmptyKeys $ff'));
  assert.ok(ps.includes('Remove-EmptyKeys $key'));
  assert.ok(ps.includes('$k.ValueCount -ne 0 -or $k.SubKeyCount -ne 0'), 'csak a teljesen üres kulcs mehet');
  // A régi segéd policies.json-ja: csak a pontosan saját tartalmú fájl megy.
  assert.ok(ps.includes(`'${FIREFOX_POLICY_JSON.replace(/\s/g, '')}'`));
});

test('a macOS-eltávolító mindent visz, amit a segéd ír — és csak ha a miénk', () => {
  const sh = read('desktop/scripts/uninstall-macos.sh');
  for (const t of CHROMIUM_TARGETS) assert.ok(sh.includes(t.macDomain), `hiányzik: ${t.macDomain}`);
  assert.ok(sh.includes(`DnsOverHttpsMode 2>/dev/null)" = "off"`));
  assert.ok(sh.includes('defaults delete $FF DNSOverHTTPS'));
  assert.ok(sh.includes('*"Enabled = 0;"*"Locked = 1;"*'));
  // A Firefox házirend-kapcsolója: ha a segéd kapcsolta be (feljegyezte), vele
  // megy; feljegyzés nélkül csak akkor, ha rajta kívül semmi nem maradt.
  assert.ok(sh.includes(`FF_MARK="${FIREFOX_SWITCH_MARK}"`), 'az eltávolító más feljegyzést néz, mint amit a segéd ír');
  assert.ok(sh.includes(`if [ -f "$FF_MARK" ]; then\n  defaults delete $FF ${FIREFOX_MAC_ENABLE_KEY}`));
  assert.ok(sh.includes(`"{${FIREFOX_MAC_ENABLE_KEY}=1;}"`));
  assert.ok(sh.includes(`FF=${FIREFOX_MAC_DOMAIN}\n`));
  // A feljegyzés a segéd állapot-mappájában van: az eltávolító ELŐBB olvassa, aztán törli.
  assert.ok(sh.indexOf('if [ -f "$FF_MARK" ]') < sh.indexOf('rm -rf "/Library/Application Support/Breaker"'));
  assert.ok(FIREFOX_SWITCH_MARK.startsWith('/Library/Application Support/Breaker/'));
});

test('a macOS-eltávolító a DoH-zár profilt is leveszi — vagy megmondja, hol', () => {
  // Nélküle a böngészők a Breaker törlése után is „felügyeltek” maradnának.
  const sh = read('desktop/scripts/uninstall-macos.sh');
  assert.ok(sh.includes(`profiles remove -identifier ${DOH_PROFILE_ID}`));
  assert.ok(sh.includes(`grep -q '${DOH_PROFILE_ID.replace(/\./g, '\\.')}'`));
  assert.ok(sh.includes('profil fent maradt: távolítsd el kézzel'));
});

test('a segéd feljegyzi, ha a Firefox kapcsolóját ő kapcsolta be — az első beírás előtt', () => {
  const src = read('desktop/src/helper/hosts.ts');
  const mark = src.indexOf('if (!fs.existsSync(FIREFOX_SWITCH_MARK)');
  const write = src.indexOf("['write', FIREFOX_MAC_DOMAIN, FIREFOX_MAC_ENABLE_KEY, '-bool', 'true']");
  assert.ok(mark > 0 && write > mark, 'a feljegyzésnek a kapcsoló beírása ELŐTT kell döntenie');
  // Nem csak a hiányzó kapcsoló: a hamisat is mi kapcsoljuk be.
  assert.ok(src.includes("!/^(1|true|yes)$/i.test(await capture('/usr/bin/defaults', ['read', FIREFOX_MAC_DOMAIN, FIREFOX_MAC_ENABLE_KEY]) ?? '')"));
});

test('a macOS-eltávolító python nélkül is kiveszi a hosts-blokkot', () => {
  // A mai macOS-en python3 gyárilag nincs: a `set -e` miatt a szkript a
  // hosts-blokknál megállt volna, és a tiltás bent marad. A python BÁRHOL a
  // kódban (`/usr/bin/python3 -`, `$(python3 …)`, `| python3 -`) — csak a
  // megjegyzés nem számít. A macOS-próba a PATH-ról is elrejti.
  const sh = read('desktop/scripts/uninstall-macos.sh');
  const code = sh.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/\bpython[0-9.]*\b/.test(code), 'a szkript megint pythont futtat');
  for (const bad of ['/usr/bin/python3 - <<PY', 'HOSTS=$(python3 -c 1)', 'cat /etc/hosts | python3 -']) {
    assert.ok(/\bpython[0-9.]*\b/.test(bad), `az ellenőrzés nem fogná: ${bad}`);
  }
  assert.ok(sh.includes("awk '/^# >>> BREAKER BLOCK BEGIN/"));
  assert.ok(sh.includes("grep -q '^# <<< BREAKER BLOCK END' /etc/hosts"), 'csonka blokknál ne dobja ki a fájl végét');
});

test('macOS-en a Firefox házirend-kapcsolója is felkerül', () => {
  // Nélküle a Firefox macOS-en egyetlen házirendet sem olvas — a DNSOverHTTPS
  // ott áll, és semmit nem tesz.
  assert.equal(FIREFOX_MAC_ENABLE_KEY, 'EnterprisePoliciesEnabled');
  const src = read('desktop/src/helper/hosts.ts');
  assert.ok(src.includes("['write', FIREFOX_MAC_DOMAIN, FIREFOX_MAC_ENABLE_KEY, '-bool', 'true']"));
});

test('a segéd nem írja felül a Firefox policies.json-ját', () => {
  // Az egész fájlt cserélte volna — vele egy szervezet vagy egy másik
  // program saját Firefox-házirendjét is.
  const src = read('desktop/src/helper/hosts.ts');
  assert.ok(!/['"`]policies\.json['"`]|['"`]distribution['"`]/.test(src), 'a hosts.ts megint a policies.json-hoz nyúl');
  assert.ok(src.includes('windowsDohCommands()'));
});

/**
 * Egy XML-plist beolvasása — csak az, amit a profil használ (dict, array, key,
 * string, integer, true, false). Ha egy címke nincs lezárva vagy rossz helyen
 * áll, kivételt dob: így a teszt a jólformáltságot is nézi. A valódi macOS
 * `plutil -lint`-je a CI macOS-próbájában fut (mac-doh-probe.sh).
 */
function parsePlist(xml: string): unknown {
  const body = xml.replace(/^<\?xml[^>]*>\s*<!DOCTYPE[^>]*>\s*<plist version="1\.0">/, '').replace(/<\/plist>\s*$/, '');
  const tokens = body.match(/<[^>]+>|[^<]+/g) ?? [];
  let i = 0;
  const skipWs = () => { while (i < tokens.length && !tokens[i].startsWith('<') && tokens[i].trim() === '') i++; };
  const text = (tag: string): string => {
    let t = '';
    if (!tokens[i].startsWith('<')) t = tokens[i++];
    if (tokens[i++] !== `</${tag}>`) throw new Error(`lezáratlan <${tag}>`);
    return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  };
  const value = (): unknown => {
    skipWs();
    const tok = tokens[i++];
    if (tok === '<true/>') return true;
    if (tok === '<false/>') return false;
    if (tok === '<string>') return text('string');
    if (tok === '<integer>') return Number(text('integer'));
    if (tok === '<array>') {
      const out: unknown[] = [];
      for (;;) { skipWs(); if (tokens[i] === '</array>') { i++; return out; } out.push(value()); }
    }
    if (tok === '<dict>') {
      const out: Record<string, unknown> = {};
      for (;;) {
        skipWs();
        if (tokens[i] === '</dict>') { i++; return out; }
        if (tokens[i++] !== '<key>') throw new Error('a dict-ben kulcs nélküli érték');
        const k = text('key');
        if (k in out) throw new Error(`kétszer szereplő kulcs: ${k}`);
        out[k] = value();
      }
    }
    throw new Error(`váratlan elem: ${tok}`);
  };
  const v = value();
  skipWs();
  if (i !== tokens.length) throw new Error('maradék a plist után');
  return v;
}

test('a macOS-profil: érvényes plist, ugyanazokat a böngészőket kényszeríti, mint a segéd', () => {
  const p = parsePlist(dohProfileXml()) as Record<string, any>;
  assert.equal(p.PayloadType, 'Configuration');
  assert.equal(p.PayloadIdentifier, DOH_PROFILE_ID);
  assert.equal(p.PayloadScope, 'System');
  assert.equal(p.PayloadRemovalDisallowed, false, 'a felhasználó bármikor eltávolíthatja — súrlódás, nem lakat');
  assert.match(p.PayloadUUID, /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  assert.equal(p.PayloadContent.length, 1);
  const prefs = p.PayloadContent[0];
  assert.equal(prefs.PayloadType, 'com.apple.ManagedClient.preferences');
  assert.notEqual(prefs.PayloadUUID, p.PayloadUUID);
  const domains = prefs.PayloadContent as Record<string, any>;
  const forced = (d: string) => {
    assert.ok(domains[d], `hiányzik: ${d}`);
    assert.equal(domains[d].Forced.length, 1);
    return domains[d].Forced[0].mcx_preference_settings;
  };
  for (const t of CHROMIUM_TARGETS) {
    const d = t.macDomain.slice(t.macDomain.lastIndexOf('/') + 1);
    assert.deepEqual(forced(d), { DnsOverHttpsMode: 'off' });
  }
  // A Firefox a kapcsoló nélkül macOS-en egyetlen házirendet sem olvasna.
  assert.deepEqual(forced('org.mozilla.firefox'), {
    [FIREFOX_MAC_ENABLE_KEY]: true, DNSOverHTTPS: { Enabled: false, Locked: true },
  });
  assert.equal(Object.keys(domains).length, CHROMIUM_TARGETS.length + 1);
});

test('a plist-olvasó tényleg elkapja a rossz profilt', () => {
  // Ugyanazzal a fejjel, amit a profil ír — fej nélkül a bemenet már az első
  // elemnél elbukna, és a teszt rossz okból lenne zöld.
  const HDR = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';
  assert.deepEqual(parsePlist(`${HDR}<plist version="1.0"><dict><key>a</key><true/></dict></plist>`), { a: true });
  assert.throws(() => parsePlist(`${HDR}<plist version="1.0"><dict><key>a</key><string>x</dict></plist>`), /lezáratlan <string>/);
  assert.throws(() => parsePlist(`${HDR}<plist version="1.0"><dict><key>a</key><true/><key>a</key><true/></dict></plist>`),
    /kétszer szereplő kulcs: a/);
  assert.throws(() => parsePlist(`${HDR}<plist version="1.0"><dict><true/></dict></plist>`), /kulcs nélküli érték/);
});
