// A böngészők titkosított DNS-ének (DoH) gépszintű házirendje — MIT írunk és HOVA.
//
// A böngésző saját DoH-ja a hosts fájl mellett oldja fel a neveket: a tiltás
// abban a böngészőben nem érvényesülne. A segéd ezért gépszintű házirenddel
// kikapcsolja (lásd hosts.ts, applyDohPolicies). Ez a modul csak ADAT és a
// parancsok összerakása — futtatni a segéd futtatja, levenni az eltávolító
// szkriptek veszik le; a teszt (doh-policy.test.ts) nézi, hogy a két platform
// ugyanazokat a böngészőket fedi, és hogy az eltávolító mindent visz, amit
// a segéd ír.
//
// Források: a Chromium a Windows-házirendet a `SOFTWARE\Policies\<gyártó>\<termék>`
// kulcsból olvassa (Google\Chrome, Microsoft\Edge, Chromium; a Brave a
// BraveSoftware\Brave alól); a Firefox a `Software\Policies\Mozilla\Firefox\
// DNSOverHTTPS` alól, DWORD értékekkel (mozilla/policy-templates).

/** Egy Chromium-alapú böngésző házirend-helye mindkét platformon. */
export interface ChromiumPolicyTarget {
  name: string;
  /** Windows: a HKLM alatti házirend-kulcs */
  winKey: string;
  /** macOS: a gépszintű beállítás-tartomány (plist útvonal kiterjesztés nélkül) */
  macDomain: string;
}

export const CHROMIUM_TARGETS: readonly ChromiumPolicyTarget[] = [
  { name: 'Chrome', winKey: 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome', macDomain: '/Library/Preferences/com.google.Chrome' },
  { name: 'Edge', winKey: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', macDomain: '/Library/Preferences/com.microsoft.Edge' },
  { name: 'Chromium', winKey: 'HKLM\\SOFTWARE\\Policies\\Chromium', macDomain: '/Library/Preferences/org.chromium.Chromium' },
  { name: 'Brave', winKey: 'HKLM\\SOFTWARE\\Policies\\BraveSoftware\\Brave', macDomain: '/Library/Preferences/com.brave.Browser' },
];

/** A Chromium-házirend neve és értéke: a DoH kikapcsolva. */
export const CHROMIUM_DOH_VALUE = { name: 'DnsOverHttpsMode', value: 'off' } as const;

/**
 * A Firefox Windows-házirendje a registryben. Ez a telepítés UTÁN felrakott
 * Firefoxra is hat, és a felhasználónként, a Program Files-on kívül
 * telepítettre is. A mai Firefox a registry és a policies.json házirendjét
 * összefésüli (ütközésben a registry nyer) — a fájlhoz ezért nem nyúlunk.
 */
export const FIREFOX_WIN_KEY = 'HKLM\\SOFTWARE\\Policies\\Mozilla\\Firefox\\DNSOverHTTPS';
export const FIREFOX_WIN_VALUES: readonly { name: string; dword: 0 | 1 }[] = [
  { name: 'Enabled', dword: 0 },
  { name: 'Locked', dword: 1 },
];

/** A Firefox macOS-tartománya (gépszintű beállítás, a bundle érintése nélkül). */
export const FIREFOX_MAC_DOMAIN = '/Library/Preferences/org.mozilla.firefox';

/**
 * A Firefox macOS-en csak akkor olvas házirendet, ha ez igaz (a
 * mozilla/policy-templates szerint: „Enable policy support on macOS”; a
 * forrásban nsMacPreferencesReader::PoliciesEnabled). Nélküle a DNSOverHTTPS
 * ott áll, és semmit nem tesz. Az eltávolító csak akkor veszi le, ha a
 * tartományban rajta kívül semmi nem maradt — egy másik eszköz saját
 * Firefox-házirendje enélkül hatástalanná válna.
 */
export const FIREFOX_MAC_ENABLE_KEY = 'EnterprisePoliciesEnabled';

/**
 * A v0.4.252 előtti segéd ezt írta a Firefox telepítési mappájába
 * (distribution/policies.json), a meglévő fájlt egészében cserélve. Ma már
 * nem írjuk; az eltávolító csak akkor törli, ha pontosan ez van benne.
 */
export const FIREFOX_POLICY_JSON = JSON.stringify(
  { policies: { DNSOverHTTPS: { Enabled: false, Locked: true } } }, null, 2,
);

/** A Windows-ág `reg add` parancsai, sorrendben. */
export function windowsDohCommands(): Array<{ cmd: string; args: string[] }> {
  const out: Array<{ cmd: string; args: string[] }> = [];
  for (const t of CHROMIUM_TARGETS) {
    out.push({
      cmd: 'reg',
      args: ['add', t.winKey, '/v', CHROMIUM_DOH_VALUE.name, '/t', 'REG_SZ', '/d', CHROMIUM_DOH_VALUE.value, '/f'],
    });
  }
  for (const v of FIREFOX_WIN_VALUES) {
    out.push({ cmd: 'reg', args: ['add', FIREFOX_WIN_KEY, '/v', v.name, '/t', 'REG_DWORD', '/d', String(v.dword), '/f'] });
  }
  return out;
}

// ------------------------------------------------- macOS: a DoH-zár profil
//
// macOS-en a segéd a gépszintű beállításokba (/Library/Preferences) írja a
// tilalmat, de a Chromium onnan csak AJÁNLÁSKÉNT veszi (az értéket csak akkor
// kezeli kötelezőnek, ha a rendszer „rákényszerítettnek” látja —
// policy_loader_mac.mm: AppValueIsForced), vagyis a böngésző beállításaiban
// visszakapcsolható. Egy konfigurációs profil kényszerített értékként adja
// ugyanezt. A profilt a felhasználó MAGA telepíti (a Rendszerbeállításokban),
// és ugyanott bármikor eltávolíthatja — súrlódás, nem lakat.

/** A profil azonosítója: újratelepítéskor ugyanezt cseréli, nem tesz mellé egy másodikat. */
export const DOH_PROFILE_ID = 'hu.breaker.doh';
const DOH_PROFILE_UUID = 'EC01BAFF-2B29-4C93-ACE0-9EC7BBAEDA87';
const DOH_PREFS_PAYLOAD_UUID = '8BE58CB4-0FB4-47D0-966A-D7DC0ABA22A0';

const xmlText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const domainOf = (prefPath: string) => prefPath.slice(prefPath.lastIndexOf('/') + 1);

/** Egy alkalmazás kényszerített beállításai a ManagedClient-payloadban. */
function forcedDomain(domain: string, settings: string[], indent: string): string[] {
  return [
    `${indent}<key>${xmlText(domain)}</key>`,
    `${indent}<dict>`,
    `${indent}  <key>Forced</key>`,
    `${indent}  <array>`,
    `${indent}    <dict>`,
    `${indent}      <key>mcx_preference_settings</key>`,
    `${indent}      <dict>`,
    ...settings.map((l) => `${indent}        ${l}`),
    `${indent}      </dict>`,
    `${indent}    </dict>`,
    `${indent}  </array>`,
    `${indent}</dict>`,
  ];
}

/** A DoH-zár profil (.mobileconfig) szövege — aláíratlan, a felhasználó telepíti. */
export function dohProfileXml(): string {
  const ind = '        ';
  const domains: string[] = [];
  for (const t of CHROMIUM_TARGETS) {
    domains.push(...forcedDomain(domainOf(t.macDomain), [
      `<key>${CHROMIUM_DOH_VALUE.name}</key>`,
      `<string>${CHROMIUM_DOH_VALUE.value}</string>`,
    ], ind));
  }
  domains.push(...forcedDomain(domainOf(FIREFOX_MAC_DOMAIN), [
    `<key>${FIREFOX_MAC_ENABLE_KEY}</key>`,
    '<true/>',
    '<key>DNSOverHTTPS</key>',
    '<dict>',
    '  <key>Enabled</key>',
    '  <false/>',
    '  <key>Locked</key>',
    '  <true/>',
    '</dict>',
  ], ind));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>PayloadContent</key>',
    '  <array>',
    '    <dict>',
    '      <key>PayloadType</key>',
    '      <string>com.apple.ManagedClient.preferences</string>',
    '      <key>PayloadVersion</key>',
    '      <integer>1</integer>',
    '      <key>PayloadIdentifier</key>',
    `      <string>${DOH_PROFILE_ID}.preferences</string>`,
    '      <key>PayloadUUID</key>',
    `      <string>${DOH_PREFS_PAYLOAD_UUID}</string>`,
    '      <key>PayloadDisplayName</key>',
    `      <string>${xmlText('Böngészők: titkosított DNS kikapcsolva')}</string>`,
    '      <key>PayloadEnabled</key>',
    '      <true/>',
    '      <key>PayloadContent</key>',
    '      <dict>',
    ...domains,
    '      </dict>',
    '    </dict>',
    '  </array>',
    '  <key>PayloadDisplayName</key>',
    `  <string>${xmlText('Breaker — böngésző-DoH zár')}</string>`,
    '  <key>PayloadDescription</key>',
    `  <string>${xmlText(
      'A Chrome, az Edge, a Chromium, a Brave és a Firefox saját titkosított DNS-e (DoH) '
      + 'kikapcsolva és zárolva, hogy a Breaker tiltása ezekben a böngészőkben is érvényesüljön. '
      + 'A profilt a Rendszerbeállításokban bármikor eltávolíthatod.',
    )}</string>`,
    '  <key>PayloadIdentifier</key>',
    `  <string>${DOH_PROFILE_ID}</string>`,
    '  <key>PayloadOrganization</key>',
    '  <string>Breaker</string>',
    '  <key>PayloadRemovalDisallowed</key>',
    '  <false/>',
    '  <key>PayloadScope</key>',
    '  <string>System</string>',
    '  <key>PayloadType</key>',
    '  <string>Configuration</string>',
    '  <key>PayloadUUID</key>',
    `  <string>${DOH_PROFILE_UUID}</string>`,
    '  <key>PayloadVersion</key>',
    '  <integer>1</integer>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
