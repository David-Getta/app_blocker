// Mérés nélkül nincs keret-idő — bekapcsolható szigorítás a gépen.
//
// MIÉRT. A napi keret és az adag a mért időből fogy, a mérés pedig az appban
// fut (a segéd nem lát bele a felhasználó munkamenetébe, lásd
// main/tracker.ts). Az app a háttérben fut és bejelentkezéskor indul (lásd
// shared/background.ts), de a szándékos kilépés, vagy a rendszer indítási
// kapcsolója megállítja — és amíg nem fut, a keretes oldal korlátlanul nyitva
// van. Aki ezt a rést is be akarja zárni, bekapcsolja ezt: ha az app nem
// jelentkezik, a keretes és adagos oldalak ZÁRVA vannak, amíg vissza nem jön.
//
// Az irány: bekapcsolni ingyen (szigorítás), kikapcsolni próbatétel (lazítás).
//
// HONNAN TUDJA A SEGÉD, HOGY AZ APP FUT. Az app húsz másodpercenként amúgy is
// kérdez (a munkamenet állapotát), a felülete pedig még sűrűbben — a segéd
// bármelyik kérését jelenlétnek veszi. Külön életjel nem kell, így egy régebbi
// app is jelen lévőnek látszik. A türelmi idő bőven a kérések fölött van.
//
// AZ ÉBREDÉS. Alvás után a segéd köre előbb járhat, mint ahogy az app újra
// kérdezne: a nagy ugrás a körök között ébredés, nem távollét — ilyenkor
// újraindul a türelmi idő, különben minden fedélnyitás bezárna egy fél percre.

import { normalizeBurst } from './burst.js';
import { normalizeLimit } from './limits.js';

/** Ennyi csend után számít az app távollévőnek (bőven a 20 mp-es kérdezés fölött). */
export const APP_GRACE_MS = 3 * 60_000;
/** Ekkora szünet a segéd körei között már ébredés (vagy óraugrás), nem rendes kör. */
export const WAKE_GAP_MS = 60_000;

/**
 * Jelen van-e az app: az utolsó jele a türelmi időn belül van — vagy épp
 * most ébredtünk, és még nem jelezhetett. A `lastSeen` induláskor a segéd
 * indulásának ideje: a bejelentkezésnek is jár a türelmi idő.
 */
export function appPresent(lastSeen: number, lastTickAt: number, now: number): boolean {
  if (now - lastTickAt > WAKE_GAP_MS) return true;
  return now - lastSeen <= APP_GRACE_MS;
}

/** A keret vagy az adag a mért időből fogy — mérés nélkül nem él. */
export function needsMeasurement(site: {
  dailyLimitSeconds?: number; burstSeconds?: number; cooldownSeconds?: number;
}): boolean {
  return normalizeLimit(site.dailyLimitSeconds) !== null
    || normalizeBurst(site.burstSeconds, site.cooldownSeconds) !== null;
}

/**
 * Zárva-e az oldal a mérés hiánya miatt. A kifizetett szünet (feloldás) ezt
 * is felülírja, mint minden mást: a próbatétellel megszerzett idő az övé.
 */
export function closedForMissingMeasurement(
  site: {
    dailyLimitSeconds?: number; burstSeconds?: number; cooldownSeconds?: number; pauseUntil: number | null;
  },
  required: boolean, present: boolean, now: number,
): boolean {
  if (!required || present) return false;
  if (site.pauseUntil !== null && site.pauseUntil > now) return false;
  return needsMeasurement(site);
}
