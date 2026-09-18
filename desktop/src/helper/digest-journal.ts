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
import { focusByHour, focusByWeekday, packCoveringHour, peakFocusHour, peakWindowPick, summarizeFocus, summarizeFocusPrevWeek } from '../shared/focus';
import { dayKeysBack, suggestBlocks, summarize, usageByWeekday } from '../shared/usage';
import { browserHits7d, browserHitsByWeekday, browserHitsPeakHour, browserHitsPrev7d, browserHitsTopSite, peakWeekday } from '../shared/browser-hits';
import { limitFullDays } from '../shared/limits';
import { burstTripsInDays } from '../shared/burst';
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
  const peak = browserHitsPeakHour(state.browserHits, now);
  // A menet-óra és a fedése: ha a menet-óra a csúcs-óra, a csúcs mondata mondja — kétszer ugyanazt nem.
  const fh = peakFocusHour(focusByHour(state.focusLog, now));
  const fhOwn = fh !== null && (peak === null || peak.hour !== fh.hour);
  return digestText({
    last7Seconds: s.last7Seconds,
    topWeekSites: s.topWeekSites,
    topWeekApps: s.topWeekApps,
    weekOverWeek: s.weekOverWeek,
    // A napló ablaka a statisztikáé: a mai nap kezdete mínusz hat nap.
    focusWeek: summarizeFocus(state.focusLog, startOfDay(now) - 6 * 86_400_000, now),
    focusPrevWeek: summarizeFocusPrevWeek(state.focusLog, now),
    unlocks7d: state.unlockLog.filter((t) => t >= now - 7 * 24 * 3600_000).length,
    unlocksPrev7d: state.unlockLog.filter((t) => t >= now - 14 * 24 * 3600_000 && t < now - 7 * 24 * 3600_000).length,
    dropped7d: (state.droppedAttempts ?? []).filter((t) => t >= now - 7 * 24 * 3600_000).length,
    // A keret betelt napjai — ezen a gépen mérve: dolgozik-e a keret.
    limitFullDays: limitFullDays(state.usage, state.sites, now).days,
    // Az adag a héten — a könyvből, minden oldalon összesen.
    burstTripsWeek: state.sites.reduce((a, s) => a + burstTripsInDays(state.burstTripLog, s.id, dayKeysBack(now, 7)), 0),
    browserHits7d: browserHits7d(state.browserHits, now),
    browserHitsPrev7d: browserHitsPrev7d(state.browserHits, now),
    browserHitsPeak: peak,
    // A lefedett csúcs-óra: a csomag, amelynek heti ablaka fedi — a mondat mondja.
    browserHitsPeakPack: peak ? packCoveringHour(state.focusPacks ?? [], peak.hour)?.name ?? null : null,
    // Lehetne-e ablakot tenni a csúcs-órára (a menet állapota itt nem számít): a mondat kimondja.
    peakWindowOffer: peak ? peakWindowPick(state.focusPacks ?? [], state.focusLog, null, peak.hour, now) !== null : false,
    browserHitsTop: browserHitsTopSite(state.browserHits, now, state.sites),
    // A csúcs-nap — négy hétből, a statisztika sora: a mondat is mondja.
    browserHitsWeekday: peakWeekday(browserHitsByWeekday(state.browserHits, now)),
    // A menet-nap — négy hétből, a statisztika sora: a mondat is mondja.
    focusWeekday: peakWeekday(focusByWeekday(state.focusLog, now)),
    // A menet-óra — négy hétből, az indulás órája szerint: a mondat is mondja.
    focusHour: fh,
    // A menet-óra fedése: a csomag, amelynek heti ablaka fedi — a mondat mondja; ha nem fedi semmi, de lehetne: „nincs rá ablak”.
    focusHourPack: fh && fhOwn ? packCoveringHour(state.focusPacks ?? [], fh.hour)?.name ?? null : null,
    focusHourWindowOffer: fh !== null && fhOwn && peakWindowPick(state.focusPacks ?? [], state.focusLog, null, fh.hour, now) !== null,
    // A mért idő napja — négy hétből, a statisztika sora: a mondat is mondja.
    usageWeekday: peakWeekday(usageByWeekday(state.usage, now)),
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
