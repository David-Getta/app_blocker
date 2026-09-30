// Véletlen szinkron-rekordok a tesztekhez — a fuzz és a megfelelőségi
// fixture közös generátora.
//
// A véletlen egy LCG, és a képlete meg a hívási sorrendje SZERZŐDÉS: a Kotlin
// (MergeFuzzTest) és a Swift (MergeFuzzTests) tükör ugyanezt a sorozatot
// állítja elő ugyanabból a magból, tehát ugyanazokat az eseteket járja be.
// Ha itt egy r() hívás sorrendje változik, ott is változnia kell.

import type { SyncSite } from '../src/shared/sync/merge';
import { emptyFocus, type SyncFocus } from '../src/shared/sync/focus-merge';
import type { FocusPack } from '../src/shared/focus';
import type { Band } from '../src/shared/schedule';
import { windowKey, type LockdownWindow } from '../src/shared/lockdown';
import { keywordsKey } from '../src/shared/keywords';
import { partnerKey, type PartnerLock } from '../src/shared/partner';

/** Determinisztikus véletlen (LCG): a mag a hibaüzenetben áll, a bukás megismételhető. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export const HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'yt.be'];
export const DEVICES = ['gep-a', 'gep-b', 'telefon'];

export function randomSite(r: () => number, device: string): SyncSite {
  const hostnames = HOSTS.filter((h, i) => i === 0 || r() < 0.5);
  const marks: Record<string, number> = {};
  for (const h of HOSTS.slice(1)) if (r() < 0.4) marks[h] = 1 + Math.floor(r() * 5);
  const pendingDeleteAt = r() < 0.15 ? 5_000 + Math.floor(r() * 3) : null;
  const dailyLimitSeconds = r() < 0.4 ? 600 * (1 + Math.floor(r() * 3)) : undefined;
  const alias = r() < 0.3 ? `n${Math.floor(r() * 3)}` : undefined;
  // Az indok a fedőnévvel azonos módon utazik — a fésülés ugyanúgy a nyertesét viszi.
  const reason = r() < 0.2 ? `r${Math.floor(r() * 2)}` : undefined;
  const rev = 1 + Math.floor(r() * 5);
  const updatedAt = 100 + Math.floor(r() * 5);
  // A jel sosem nagyobb a rekord rev-jénél — a bemenet mindhárom nyelvben
  // így tisztít, tehát a megfelelőségi fixture-ben sem lehet más.
  for (const h of Object.keys(marks)) marks[h] = Math.min(marks[h], rev);
  return {
    id: 'site_1', domain: 'youtube.com', hostnames, addedAt: 1_000,
    ...(Object.keys(marks).length ? { hostnameMarks: marks } : {}),
    pauseUntil: null, pendingDeleteAt, dailyLimitSeconds, alias, reason, rev, updatedAt, updatedBy: device,
  };
}

export const PACK_IDS = ['p1', 'p2', 'p3', 'p4'];
export const WIN: Band = { days: [1, 2, 3, 4, 5], startMin: 540, endMin: 720 };
/**
 * A zárlat-ablakok készlete. Az azonosító eszközönként más (`w1@gep-a`): a
 * tartalom szerinti unió így az azonosító-ütközés helyett a KULCS szerinti
 * összevonást járja be — a megfelelőségi kulcs a tartalmat nézi.
 */
export const WINDOWS: Omit<LockdownWindow, 'id'>[] = [
  { days: [1, 2, 3, 4, 5], startMin: 540, endMin: 1020 },
  { days: [1], startMin: 1320, endMin: 360 },
  { days: [0, 6], startMin: 0, endMin: 1440 },
];

/** Kulcsszó-készletek: egy-egy szó, és a kettő együtt — azonos jelnél az unió jön ki. */
export const KEYWORD_SETS: string[][] = [['shorts'], ['reels'], ['shorts', 'reels']];
/**
 * Két rögzített megbízott-zár. A só és a lenyomat itt csak ALAKRA jó (base64,
 * a hossz a korláton belül) — a fésülés a jelet és a felvétel idejét nézi, a
 * jelmondatot sehol. A `setAt` különbözik: azonos jelnél a korábbi nyer.
 */
export const PARTNERS: PartnerLock[] = [
  { name: 'Anna', salt: 'QUFBQUFBQUFBQUFBQUFBQQ==', hash: 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=', setAt: 5 },
  { name: 'Bela', salt: 'Q0NDQ0NDQ0NDQ0NDQ0NDQw==', hash: 'REREREREREREREREREREREREREREREREREREREREREQ=', setAt: 3 },
];

export function randomFocus(r: () => number, device: string): SyncFocus {
  const packs: FocusPack[] = PACK_IDS.filter(() => r() < 0.6).map((id) => ({
    id, name: `csomag ${id} v${Math.floor(r() * 3)}`, allowSites: ['quizlet.com'], allowApps: [],
    defaultMinutes: 50, ...(r() < 0.4 ? { recurrence: WIN } : {}),
  }));
  const marks: Record<string, number> = {};
  for (const id of PACK_IDS) if (r() < 0.4) marks[id] = 1 + Math.floor(r() * 5);
  const rev = 1 + Math.floor(r() * 5);
  // A jel sosem nagyobb a blob rev-jénél (a bemenet is így tisztít): a
  // csomag nélküli menet lehetetlensége erre épül.
  for (const id of Object.keys(marks)) marks[id] = Math.min(marks[id], rev);
  // A menet lejárata és kezdése is csak pár értéket vesz fel: legyen sok
  // döntetlen, mert éppen a döntetlen-lánc az, ami sorrendfüggő tud lenni.
  const run = r() < 0.4 && packs.length > 0
    ? {
        packId: packs[Math.floor(r() * packs.length)].id,
        startedAt: 10 + 60_000 * Math.floor(r() * 2),
        endsAt: 610_000 + 60_000 * Math.floor(r() * 2),
      }
    : null;
  const updatedAt = 100 + Math.floor(r() * 5);
  // A ZÁRLAT (magasvízjel) ÉS AZ ABLAKOK A JELÜKKEL — kilenc húzás, mind
  // feltétel nélkül, ugyanebben a sorrendben a három nyelvben: a
  // magasvízjel vége csak pár értéket vesz fel (döntetlen), az ablakok egy
  // háromelemű készletből jönnek, a jel legfeljebb a blob rev-je.
  const lockDraw = r();
  const lockStart = 100 + Math.floor(r() * 3);
  const lockEnd = 1_000 + 500 * Math.floor(r() * 3);
  const lockdown = lockDraw < 0.3 ? { startedAt: lockStart, until: lockEnd } : undefined;
  const hasWindows = r() < 0.5;
  const drawn = WINDOWS.filter(() => r() < 0.5);
  const windows: LockdownWindow[] = hasWindows
    ? drawn.map((w, i) => ({ id: `w${i + 1}@${device}`, ...w })) : [];
  const markDraw = r();
  const markValue = Math.min(1 + Math.floor(r() * 5), rev);
  const windowsRev = windows.length > 0 || markDraw < 0.3 ? markValue : undefined;
  // A REJTÉS A JELÉVEL — három húzás, mind feltétel nélkül, ugyanebben a
  // sorrendben a három nyelvben: rejtve-e, van-e jel rejtés nélkül is (a
  // kikapcsolás is jelet hagy), és a jel értéke — legfeljebb a blob rev-je.
  const hideDraw = r();
  const hideMarkDraw = r();
  const hideMarkValue = Math.min(1 + Math.floor(r() * 5), rev);
  const hide = hideDraw < 0.3;
  const hideRev = hide || hideMarkDraw < 0.2 ? hideMarkValue : undefined;
  // KULCSSZAVAK ÉS MEGBÍZOTT A JELÜKKEL — nyolc húzás, mind feltétel nélkül,
  // ugyanebben a sorrendben a három nyelvben: van-e lista, melyik készlet, van-e
  // jel lista nélkül is (a kifizetett levétel), a jel értéke; és ugyanez a
  // megbízottra (két rögzített zár, a felvétel ideje töri el a döntetlent).
  const kwDraw = r();
  const kwPick = Math.floor(r() * 3);
  const kwMarkDraw = r();
  const kwMarkValue = Math.min(1 + Math.floor(r() * 5), rev);
  const keywords = kwDraw < 0.4 ? KEYWORD_SETS[kwPick] : [];
  const keywordsRev = keywords.length > 0 || kwMarkDraw < 0.2 ? kwMarkValue : undefined;
  const pDraw = r();
  const pPick = Math.floor(r() * 2);
  const pMarkDraw = r();
  const pMarkValue = Math.min(1 + Math.floor(r() * 5), rev);
  const partner = pDraw < 0.3 ? PARTNERS[pPick] : undefined;
  const partnerRev = partner || pMarkDraw < 0.2 ? pMarkValue : undefined;
  return {
    ...emptyFocus(device), packs, ...(Object.keys(marks).length ? { packMarks: marks } : {}),
    run, rev, updatedAt, updatedBy: device,
    ...(lockdown ? { lockdown } : {}),
    ...(windows.length > 0 ? { lockdownWindows: windows } : {}),
    ...(windowsRev !== undefined ? { lockdownWindowsRev: windowsRev } : {}),
    ...(hide ? { hideSiteList: true } : {}),
    ...(hideRev !== undefined ? { hideSiteListRev: hideRev } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(keywordsRev !== undefined ? { keywordsRev } : {}),
    ...(partner ? { partner } : {}),
    ...(partnerRev !== undefined ? { partnerRev } : {}),
  };
}

/**
 * A MEGFELELŐSÉGI kulcs — bájtra ugyanez a három nyelvben (Kotlin
 * MergeFixtureTest, Swift MergeFixtureTests). Ami benne van, annak a három
 * tükörben azonosan kell kijönnie ugyanabból a két bemenetből.
 */
export function siteConformanceKey(s: SyncSite): string {
  const marks = Object.entries(s.hostnameMarks ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join(',');
  const opt = (v: number | string | null | undefined) => (v === null || v === undefined ? '-' : String(v));
  return `hosts=[${[...s.hostnames].sort().join(',')}] marks=[${marks}] rev=${s.rev}`
    + ` pending=${opt(s.pendingDeleteAt)} limit=${opt(s.dailyLimitSeconds)} alias=${opt(s.alias)}`
    + ` reason=${opt(s.reason)}`
    + ` at=${s.updatedAt} by=${s.updatedBy}`;
}

export function focusConformanceKey(f: SyncFocus): string {
  const packs = [...f.packs].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)).map((p) => {
    const rec = p.recurrence
      ? `${[...p.recurrence.days].sort((a, b) => a - b).join(',')}/${p.recurrence.startMin}/${p.recurrence.endMin}`
      : '-';
    return [p.id, p.name, [...p.allowSites].sort().join(','), [...p.allowApps].sort().join(','), String(p.defaultMinutes), rec].join('|');
  }).join(';');
  const marks = Object.entries(f.packMarks ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join(',');
  const run = f.run ? `${f.run.packId}/${f.run.startedAt}/${f.run.endsAt}` : '-';
  const lock = f.lockdown ? `${f.lockdown.startedAt}/${f.lockdown.until}` : '-';
  // Az ablakok TARTALOM szerint, rendezve: az azonosító és a sorrend nem jelentés.
  const windows = (f.lockdownWindows ?? []).map(windowKey).sort().join(';');
  return `packs=[${packs}] run=${run} marks=[${marks}] rev=${f.rev} at=${f.updatedAt} by=${f.updatedBy}`
    + ` lock=${lock} windows=[${windows}] wmark=${f.lockdownWindowsRev ?? 0}`
    + ` hide=${f.hideSiteList ? 1 : 0} hmark=${f.hideSiteListRev ?? 0}`
    + ` kw=[${keywordsKey(f.keywords ?? [])}] kmark=${f.keywordsRev ?? 0}`
    + ` partner=[${partnerKey(f.partner)}] pmark=${f.partnerRev ?? 0}`;
}

/** Egy mező cseréje az `a` blobon, és hogy a csere jelentés-e (különbség). */
export interface FocusFlip { flip: SyncFocus; what: string; same: boolean }

/**
 * EGY MEZŐ CSERÉJE — a különbség-kulcs (`sameFocus` / `FocusSync.same`)
 * megfelelőségéhez. A fésülés fixtúrája azt nézi, hogy a három tükör ugyanoda
 * jut; ez azt, hogy ugyanazt tartja KÜLÖNBSÉGNEK. A v0.4.170-ben a Swift
 * kulcsából kimaradt a rejtés: azonos rev mellett a cseréje
 * „nincs mit feltölteni” lett volna — és a fésülés fixtúrája ezt nem látta.
 *
 * Tizenkilenc fajta: tizenöt jelentés (különbség), négy nem az (időbélyeg,
 * eszköznév, ablak-azonosító, a csomagok sorrendje). A várt érték a fajtából
 * következik, és a gép tesztje ellenőrzi is — így egy hatástalan csere (amit
 * a normalizálás visszaírna) nem marad néma. EGY húzás, az a/b/c UTÁN: a
 * Kotlin és a Swift fuzz-generátort nem érinti, a fixtúra a cserét JSON-ban
 * viszi, a tükrök csak visszajátsszák.
 */
export function flipFocus(r: () => number, a: SyncFocus): FocusFlip {
  const kind = Math.floor(r() * 19);
  const first = a.packs[0];
  const diff = (what: string, flip: SyncFocus): FocusFlip => ({ what, flip, same: false });
  const noDiff = (what: string, flip: SyncFocus): FocusFlip => ({ what, flip, same: true });
  const addPack = (): FocusFlip => diff('packs+', {
    ...a, packs: [...a.packs, { id: 'p9', name: 'csomag p9 v0', allowSites: ['quizlet.com'], allowApps: [], defaultMinutes: 50 }],
  });
  const bumpAt = (): FocusFlip => noDiff('updatedAt', { ...a, updatedAt: a.updatedAt + 1 });
  // Egy MÁSIK érvényes jel: pozitív, legfeljebb a rev — ha nincs ilyen (rev 1,
  // jel 1), akkor a jel elhagyása, ami szintén különbség (0).
  const otherMark = (cur: number | undefined): number | undefined => (cur !== 1 ? 1 : a.rev >= 2 ? 2 : undefined);
  const ws = a.lockdownWindows ?? [];
  switch (kind) {
    case 0: return first ? diff('packs-', { ...a, packs: a.packs.slice(1) }) : addPack();
    case 1: return first ? diff('pack.name', { ...a, packs: [{ ...first, name: `${first.name} x` }, ...a.packs.slice(1)] }) : addPack();
    case 2: {
      if (!first) return addPack();
      const bare: FocusPack = {
        id: first.id, name: first.name, allowSites: first.allowSites, allowApps: first.allowApps, defaultMinutes: first.defaultMinutes,
      };
      return diff('pack.recurrence', { ...a, packs: [first.recurrence ? bare : { ...bare, recurrence: WIN }, ...a.packs.slice(1)] });
    }
    case 3:
      if (a.run) return diff('run-', { ...a, run: null });
      return first ? diff('run+', { ...a, run: { packId: first.id, startedAt: 10, endsAt: 610_000 } }) : addPack();
    case 4: return diff('log+', {
      ...a, log: [...a.log, { packId: 'p1', packName: 'csomag', startedAt: 1, endedAt: 2, plannedEndsAt: 2, stopped: false }],
    });
    case 5: return a.lockdown
      ? diff('lockdown-', { ...a, lockdown: undefined })
      : diff('lockdown+', { ...a, lockdown: { startedAt: 100, until: 2_000 } });
    case 6: return ws.length > 0
      ? diff('windows-', { ...a, lockdownWindows: ws.slice(1) })
      : diff('windows+', { ...a, lockdownWindows: [{ id: 'w1@flip', ...WINDOWS[0] }] });
    case 7: return diff('wmark', { ...a, lockdownWindowsRev: otherMark(a.lockdownWindowsRev) });
    case 8: return a.keywords?.length
      ? diff('keywords-', { ...a, keywords: [] })
      : diff('keywords+', { ...a, keywords: ['shorts'] });
    case 9: return diff('kmark', { ...a, keywordsRev: otherMark(a.keywordsRev) });
    case 10: return a.hideSiteList
      ? diff('hide-', { ...a, hideSiteList: undefined })
      : diff('hide+', { ...a, hideSiteList: true });
    case 11: return diff('hmark', { ...a, hideSiteListRev: otherMark(a.hideSiteListRev) });
    case 12: return diff('rev', { ...a, rev: a.rev + 1 });
    case 13: {
      const marks = { ...(a.packMarks ?? {}) };
      const m = otherMark(marks.p4);
      if (m === undefined) delete marks.p4; else marks.p4 = m;
      return diff('packMarks', { ...a, packMarks: marks });
    }
    case 14: return bumpAt();
    case 15: return noDiff('updatedBy', { ...a, updatedBy: 'masik' });
    case 17: return a.partner
      ? diff('partner-', { ...a, partner: undefined })
      : diff('partner+', { ...a, partner: PARTNERS[0] });
    case 18: return diff('pmark', { ...a, partnerRev: otherMark(a.partnerRev) });
    default:
      // Ami NEM jelentés: az ablak azonosítója és a csomagok sorrendje.
      if (ws.length > 0) return noDiff('window.id', { ...a, lockdownWindows: [{ ...ws[0], id: 'w9@flip' }, ...ws.slice(1)] });
      if (a.packs.length >= 2) return noDiff('packs.order', { ...a, packs: [...a.packs].reverse() });
      return bumpAt();
  }
}
