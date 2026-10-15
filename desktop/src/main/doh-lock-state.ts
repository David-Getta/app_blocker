// Mi érvényes MOST a böngészők titkosított DNS-éről (csak macOS).
//
// A profil telepítése a felhasználó lépése a Rendszerbeállításokban — az app
// nem tudja, megtörtént-e, csak azt látja, ami a gép beállításai között áll.
// Tükör, nem ígéret: böngészőnként mondjuk, honnan venné a böngésző az
// értéket, és az mit jelent (a sor szövege: shared/doh-lock.ts). Electron
// nélkül, hogy a CI macOS-próbája közvetlenül is meghívhassa.
//
// A FORRÁSOK SORRENDJE a CFPreferences sorrendje, legfelső kulcsonként:
//   1. a kezelt beállítás (/Library/Managed Preferences) — előbb a
//      felhasználóé (<felhasználónév>/<tartomány>.plist), aztán a gépé; egy
//      profil vagy egy szervezeti felügyelet teszi ide, és a felhasználó nem
//      írhatja felül;
//   2. a felhasználó saját tartománya (~/Library/Preferences — egy
//      `defaults write` a Terminálban, rendszergazda nélkül);
//   3. a gépszintű tartomány (/Library/Preferences — ide ír a segéd).
// A Chromium-család csak az 1. pontot veszi kötelezőnek (AppValueIsForced);
// a Firefox mindhármat házirendnek olvassa, ezért nála az számít, melyik
// forrás nyer.

import { execFile } from 'child_process';
import * as os from 'os';
import { CHROMIUM_DOH_VALUE, CHROMIUM_TARGETS, FIREFOX_MAC_DOMAIN, FIREFOX_MAC_ENABLE_KEY } from '../helper/doh-policy';
import type { DohLockState } from '../shared/doh-lock';

export type { DohLockState } from '../shared/doh-lock';

export const MANAGED_PREFS_DIR = '/Library/Managed Preferences';
const PLIST_BUDDY = '/usr/libexec/PlistBuddy';
const DEFAULTS = '/usr/bin/defaults';

function exec(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5_000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

const domainOf = (prefPath: string) => prefPath.slice(prefPath.lastIndexOf('/') + 1);

/**
 * A kezelt fájlok, az erősebb elöl. KÖZVETLENÜL a fájlból olvasunk
 * (PlistBuddy), nem a `defaults`-szal: az a beállítás-szolgáltatáson
 * (cfprefsd) át olvas, ami a kezelt tartományokat gyorsítótárazhatja — a CI
 * macOS-próbája szerint egy frissen odakerült értéket nem látott.
 */
function managedFiles(domain: string, user: string): string[] {
  return [`${MANAGED_PREFS_DIR}/${user}/${domain}.plist`, `${MANAGED_PREFS_DIR}/${domain}.plist`];
}

/** Egy logikai érték a két eszköz kiírásából (PlistBuddy: true/false, defaults: 1/0). */
function bool(s: string | null | undefined): boolean | undefined {
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return undefined;
}

type Source = 'managed' | 'user' | 'machine';

/** A Firefox DNSOverHTTPS-e és kapcsolója abból a forrásból, ahonnan a Firefox venné. */
interface FirefoxKey { source: Source; on?: boolean; enabled?: boolean; locked?: boolean }

/** A `defaults read … DNSOverHTTPS` kiírásából (`{ Enabled = 0; Locked = 1; }`) egy mező. */
function dictField(text: string, field: string): boolean | undefined {
  const m = text.match(new RegExp(`\\b${field}\\s*=\\s*([^;\\s]+)\\s*;`));
  return m ? bool(m[1]) : undefined;
}

async function firefoxKey(key: string, user: string): Promise<FirefoxKey | null> {
  const ff = domainOf(FIREFOX_MAC_DOMAIN);
  const isDict = key === 'DNSOverHTTPS';
  for (const file of managedFiles(ff, user)) {
    const v = await exec(PLIST_BUDDY, ['-c', `Print :${key}`, file]);
    if (v === null) continue;
    if (!isDict) return { source: 'managed', on: bool(v) };
    return {
      source: 'managed',
      enabled: bool(await exec(PLIST_BUDDY, ['-c', `Print :${key}:Enabled`, file])),
      locked: bool(await exec(PLIST_BUDDY, ['-c', `Print :${key}:Locked`, file])),
    };
  }
  for (const [source, domain] of [['user', ff], ['machine', FIREFOX_MAC_DOMAIN]] as const) {
    const v = await exec(DEFAULTS, ['read', domain, key]);
    if (v === null) continue;
    if (!isDict) return { source, on: bool(v) };
    return { source, enabled: dictField(v, 'Enabled'), locked: dictField(v, 'Locked') };
  }
  return null;
}

export async function dohLockState(user: string = os.userInfo().username): Promise<DohLockState> {
  const forcedOff: string[] = [];
  const lockedInBrowser: string[] = [];
  for (const t of CHROMIUM_TARGETS) {
    // Az első kezelt fájl, amelyikben a kulcs megvan, dönt: ha a felhasználóé
    // mást mond, a gépé hiába „off”.
    for (const file of managedFiles(domainOf(t.macDomain), user)) {
      const v = await exec(PLIST_BUDDY, ['-c', `Print :${CHROMIUM_DOH_VALUE.name}`, file]);
      if (v === null) continue;
      if (v === CHROMIUM_DOH_VALUE.value) forcedOff.push(t.name);
      break;
    }
  }
  // A Firefoxnál két legfelső kulcs kell: a kapcsoló (nélküle a Firefox
  // macOS-en egyetlen házirendet sem olvas) és a zárolt, kikapcsolt
  // DNSOverHTTPS. Kötelező, ha MINDKETTŐ kezelt forrásból jön; ha bármelyik a
  // felhasználó vagy a gép tartományából, a böngészőben zárolva, de a
  // felhasználó saját beállítása felülírhatja.
  const sw = await firefoxKey(FIREFOX_MAC_ENABLE_KEY, user);
  const doh = await firefoxKey('DNSOverHTTPS', user);
  if (sw?.on === true && doh?.enabled === false && doh.locked === true) {
    (sw.source === 'managed' && doh.source === 'managed' ? forcedOff : lockedInBrowser).push('Firefox');
  }
  return { browsers: [...CHROMIUM_TARGETS.map((t) => t.name), 'Firefox'], forcedOff, lockedInBrowser };
}
