// A heti napló a SEGÉDBEN: a hét sora akkor is íródik, ha az app nem fut.
//
// A hétfő reggeli értesítés a felületé — csak futó app mellett jöhet, és ezt
// a doksi kimondja. A napló sora viszont nem értesítés, hanem könyvelés: a
// segéd mindig fut, a mérés és a napló nála van, tehát a sort ő írja a
// körében, hétfő reggel héttől — pontosan úgy, ahogy a telefonon a szűrő
// szolgáltatása. A felület csak mutatja, a mostani címkézésével.
//
// A címkézés itt a BEÁLLÍTÁSÉ (rejtett lista → sorszám, fedőnév → fedőnév),
// nem a felület pillanatnyi felfedéséé: a segéd azt nem látja, és a sor a
// kirakáskor úgyis a felület címkéjét kapja (`relabelDigest`).

import { cleanDigestLog, digestDue, digestText, recordDigest } from '../shared/digest';
import { displayName, isAliased } from '../shared/alias';
import { summarizeFocus } from '../shared/focus';
import { suggestBlocks, summarize } from '../shared/usage';
import { browserHits7d, browserHitsPeakHour, browserHitsTopSite } from '../shared/browser-hits';
import type { HelperState } from './state';

/** A mai nap kezdete helyi idő szerint — ugyanaz, mint a statisztikáé. */
function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * A segéd címkézése: rejtett listánál sorszám (a lista sorrendjéből, tehát
 * két frissítés között nem ugrál), fedőnévnél a fedőnév — a felület
 * `statLabel`-jének a tükre, a beállítás szerint. Ami nincs a listán, marad.
 */
export function helperLabel(state: HelperState): (label: string) => string {
  return (label) => {
    const idx = state.sites.findIndex((s) => s.domain === label);
    if (idx < 0) return label;
    const site = state.sites[idx];
    if (state.hideSiteList === true && !isAliased(site)) return `${idx + 1}. rejtett oldal`;
    return displayName(site);
  };
}

/** A visszatekintés mondata a segéd mostani állapotából — vagy null, ha nincs miről. */
export function digestTextNow(state: HelperState, now: number): string | null {
  const s = summarize(state.usage, now);
  return digestText({
    last7Seconds: s.last7Seconds,
    topWeekSites: s.topWeekSites,
    topWeekApps: s.topWeekApps,
    weekOverWeek: s.weekOverWeek,
    // A napló ablaka a statisztikáé: a mai nap kezdete mínusz hat nap.
    focusWeek: summarizeFocus(state.focusLog, startOfDay(now) - 6 * 86_400_000, now),
    unlocks7d: state.unlockLog.filter((t) => t >= now - 7 * 24 * 3600_000).length,
    dropped7d: (state.droppedAttempts ?? []).filter((t) => t >= now - 7 * 24 * 3600_000).length,
    browserHits7d: browserHits7d(state.browserHits, now),
    browserHitsPeak: browserHitsPeakHour(state.browserHits, now),
    browserHitsTop: browserHitsTopSite(state.browserHits, now, state.sites),
    daysTracked: s.daysTracked,
    unblockedTop: suggestBlocks(s.topWeekSites, state.sites).map((t) => ({ label: t.label, seconds: t.seconds })),
  }, helperLabel(state));
}

/**
 * A hét sora a naplóba, ha esedékes — a segéd köre hívja. Igaz, ha írt: a
 * hét el van könyvelve, és a mondat a naplóban (az üres hét nem sor, de a
 * hét régi sorát sem hagyja ott).
 */
export function journalTick(state: HelperState, now: number): boolean {
  const key = digestDue(state.digestWeekKey ?? null, now);
  if (!key) return false;
  const text = digestTextNow(state, now);
  state.digestWeekKey = key;
  state.digestLog = recordDigest(cleanDigestLog(state.digestLog), key, text);
  return true;
}
