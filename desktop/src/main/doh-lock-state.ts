// Érvényben van-e MOST a kötelező böngésző-DoH tilalom (csak macOS).
//
// A profil telepítése a felhasználó lépése a Rendszerbeállításokban — az app
// nem tudja, megtörtént-e, csak azt látja, ami a gép KEZELT beállításai
// között van (/Library/Managed Preferences: ide kerül egy telepített profil
// vagy egy szervezeti felügyelet értéke). Tükör, nem ígéret: azt mondjuk,
// ami ott áll, böngészőnként. Electron nélkül, hogy a CI macOS-próbája
// közvetlenül is meghívhassa.

import { execFile } from 'child_process';
import { CHROMIUM_DOH_VALUE, CHROMIUM_TARGETS, FIREFOX_MAC_DOMAIN, FIREFOX_MAC_ENABLE_KEY } from '../helper/doh-policy';

export const MANAGED_PREFS_DIR = '/Library/Managed Preferences';

export interface DohLockState {
  /** a böngészők, amelyeknél a kezelt beállítás „off” — vagyis kötelező a tilalom */
  forcedOff: string[];
  /** hány böngészőt nézünk összesen */
  total: number;
}

function readManaged(domain: string, key: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/defaults', ['read', `${MANAGED_PREFS_DIR}/${domain}`, key], { timeout: 5_000 },
      (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

export async function dohLockState(): Promise<DohLockState> {
  const forcedOff: string[] = [];
  for (const t of CHROMIUM_TARGETS) {
    const domain = t.macDomain.slice(t.macDomain.lastIndexOf('/') + 1);
    if (await readManaged(domain, CHROMIUM_DOH_VALUE.name) === CHROMIUM_DOH_VALUE.value) forcedOff.push(t.name);
  }
  // A Firefoxnál két érték kell: a kapcsoló (nélküle a Firefox macOS-en
  // egyetlen házirendet sem olvas) és a zárolt, kikapcsolt DNSOverHTTPS.
  const ff = FIREFOX_MAC_DOMAIN.slice(FIREFOX_MAC_DOMAIN.lastIndexOf('/') + 1);
  const enabled = await readManaged(ff, FIREFOX_MAC_ENABLE_KEY);
  const doh = (await readManaged(ff, 'DNSOverHTTPS')) ?? '';
  if (enabled === '1' && /Enabled = 0;/.test(doh) && /Locked = 1;/.test(doh)) forcedOff.push('Firefox');
  return { forcedOff, total: CHROMIUM_TARGETS.length + 1 };
}
