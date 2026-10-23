// A felület döntései a segéd frissítéséről (#151, macOS): mikor kínálja fel a
// saját csomagját csendben, és mikor szól a felhasználónak. Függőség nélkül —
// a fő folyamat és a felület (böngésző-oldal) is ezt használja.

import { isNewer } from './version.js';

/** Az app saját csomagja (dist/main/helper-payload.json). */
export interface OwnBuild {
  sha256: string;
  appVersion: string;
  helperVersion: string;
  /** a leírója aláírt — aláíratlant (fejlesztői build, kulcs előtti kiadás) a segéd nem vesz át */
  signed: boolean;
  /** a gép macOS-e futtatja-e a védett futtatókörnyezetet (13.5+); hiányában igen */
  runtimeSupported?: boolean;
}

/** Amit a döntés a segéd státuszából néz. */
export interface HelperFacts {
  platform?: string;
  helperVersion?: string;
  helperLayout?: 'root' | 'bundle' | 'dev';
  helperBuild?: string;
  helperAppVersion?: string;
  helperUpdate?: { state: string; error?: string; at?: number };
}

/** A legkisebb segéd-protokoll, ami a csendes frissítést ismeri. */
export const OFFER_MIN_HELPER = '0.7.0';

/**
 * Ha a csendes frissítéshez új Node kell, a felület tölti le. Ennyi ideig
 * hagyjuk dolgozni; ha utána is ott áll, és a protokoll más, a gomb segít (és
 * kimondja, ha nincs internet).
 */
export const NEED_NODE_GRACE_MS = 3 * 60_000;

function atLeast(a: string | undefined, b: string): boolean {
  return !!a && (a === b || isNewer(a, b));
}

export type OfferAction = 'none' | 'offer' | 'helper-newer';

/**
 * Felkínáljuk-e a saját csomagunkat a segédnek. Csak a védett
 * futtatókörnyezetből futó, a frissítést ismerő segédnek, csak ha a csomagja
 * más, a miénk újabb, és aláírt (aláíratlant a segéd úgysem venne át). Ha a
 * segédé újabb (az appot visszaállították), az app frissítése a teendő — azt
 * mondjuk ki.
 */
export function offerAction(st: HelperFacts, own: OwnBuild): OfferAction {
  if (st.platform !== 'darwin' || st.helperLayout !== 'root') return 'none';
  if (!atLeast(st.helperVersion, OFFER_MIN_HELPER)) return 'none';
  if (!st.helperBuild || st.helperBuild === own.sha256) return 'none';
  if (st.helperAppVersion && isNewer(st.helperAppVersion, own.appVersion)) return 'helper-newer';
  if (st.helperAppVersion && !isNewer(own.appVersion, st.helperAppVersion)) return 'none';
  if (!own.signed) return 'none';
  const u = st.helperUpdate?.state;
  if (u === 'working' || u === 'activating') return 'none';
  return 'offer';
}

export type HelperBanner =
  /** nincs mit mondani */
  | 'none'
  /** régi segéd: a frissítő gomb (egy jelszó) */
  | 'stale'
  /** macOS: a segéd még az app-csomagból fut — a költöztetés egy jelszó */
  | 'move'
  /** a csendes frissítés nem sikerült: a gomb javít (egy jelszó) */
  | 'repair'
  /** a segéd újabb, mint az app: az appot kell frissíteni */
  | 'helper-newer';

/**
 * A felület sávja. A régi (0.7.0 előtti) segéd és az app-csomagból futó segéd
 * a gombbal frissül; a védett futtatókörnyezetből futó segéd csendben — ott
 * csak akkor szólunk, ha a csendes frissítés elbukott, vagy a segéd újabb.
 * Aláíratlan saját csomagnál nincs csendes út: ott a régi szabály áll (csak a
 * protokoll eltérése kér gombot), a diagnosztika mondja ki, melyik kiadás fut.
 */
export function helperBanner(
  st: HelperFacts, own: OwnBuild | null, appHelperVersion: string, now: number = Date.now(),
): HelperBanner {
  if (!st.helperVersion) return 'none';
  if (st.helperLayout === 'root' && atLeast(st.helperVersion, OFFER_MIN_HELPER) && own) {
    const action = offerAction(st, own);
    if (action === 'helper-newer') return 'helper-newer';
  }
  if (st.helperLayout === 'root' && atLeast(st.helperVersion, OFFER_MIN_HELPER) && own?.signed) {
    if (st.helperBuild === own.sha256) return 'none';
    const u = st.helperUpdate;
    if (u && (u.state === 'failed' || u.state === 'rolled-back')) {
      if (u.error !== 'need-node') return 'repair';
      // A Node letöltése a felületen múlik: ha percek óta nem sikerül, és a
      // segéd protokollja más, ne maradjon szó nélkül.
      if (st.helperVersion !== appHelperVersion && now - (u.at ?? now) >= NEED_NODE_GRACE_MS) return 'repair';
    }
    return 'none';
  }
  if (st.helperVersion !== appHelperVersion) return 'stale';
  // Ugyanaz a protokoll, de macOS-en még az app-csomagból fut: amíg így van,
  // egy fájlművelet az app mappájában a következő induláskor rootként futna.
  // A védett helyhez macOS 13.5 kell — régebbin a gomb nem segítene (a
  // diagnosztika mondja ki, miért marad).
  if (st.platform === 'darwin' && st.helperLayout === 'bundle') return own?.runtimeSupported === false ? 'none' : 'move';
  return 'none';
}
