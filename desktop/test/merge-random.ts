// Véletlen szinkron-rekordok a tesztekhez — a fuzz és a megfelelőségi
// fixture közös generátora.
//
// A véletlen egy LCG, és a képlete meg a hívási sorrendje SZERZŐDÉS: a Kotlin
// (MergeFuzzTest) és a Swift (MergeFuzzTests) tükör ugyanezt a sorozatot
// állítja elő ugyanabból a magból, tehát ugyanazokat az eseteket járja be.
// Ha itt egy r() hívás sorrendje változik, ott is változnia kell.

import type { SyncSite } from '../src/shared/sync/merge';
import { emptyFocus, type SyncFocus } from '../src/shared/sync/focus-merge';
import type { FocusLogEntry, FocusPack } from '../src/shared/focus';
import type { Band, Schedule } from '../src/shared/schedule';
import type { UrlRule } from '../src/shared/urlrules';
import { windowKey, type LockdownWindow } from '../src/shared/lockdown';
import { keywordsKey } from '../src/shared/keywords';
import { partnerKey, type PartnerLock } from '../src/shared/partner';
import type { UsageDay, UsageState } from '../src/shared/usage';

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

/** Menetrendek: érvényes sávokkal, különböző tiltott perc-összeggel — a döntetlen-lánc ezt nézi. */
export const SCHEDULES: Schedule[] = [
  { mode: 'scheduled_block', bands: [{ days: [1, 2, 3, 4, 5], startMin: 540, endMin: 1020 }] },
  { mode: 'scheduled_allow', bands: [{ days: [0, 6], startMin: 600, endMin: 720 }] },
  { mode: 'scheduled_block', bands: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 1320, endMin: 360 }] },
];
/** Adag-szabályok: adag és szünet másodpercben — a kettő csak együtt értelmes. */
export const BURSTS: [number, number][] = [[600, 300], [1200, 900]];
/** Részleges szabályok KANONIKUS alakban — így egyik nyelv olvasója sem írja át őket. */
export const RULES: UrlRule[] = [{ host: 'youtube.com', path: '/@valaki' }, { host: 'youtube.com', path: '/shorts' }];

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
  // MENETREND, ADAG, RÉSZLEGES SZABÁLYOK — hat húzás, mind feltétel nélkül,
  // ugyanebben a sorrendben a három nyelvben. A szabályoknál három különböző
  // dolog a „nem tudok a mezőről” (régi kliens), a „volt, és el lett távolítva”
  // (üres) és a lista — mindhárom jár, mert a fésülés is így különbözteti.
  const schedDraw = r();
  const schedPick = Math.floor(r() * 3);
  const burstDraw = r();
  const burstPick = Math.floor(r() * 2);
  const rulesDraw = r();
  const rulesPick = Math.floor(r() * 3);
  const schedule = schedDraw < 0.4 ? SCHEDULES[schedPick] : undefined;
  const burst = burstDraw < 0.3 ? BURSTS[burstPick] : undefined;
  const rules: UrlRule[] | undefined = rulesDraw < 0.25 ? undefined
    : rulesDraw < 0.45 ? []
      : rulesPick === 2 ? [RULES[0], RULES[1]] : [RULES[rulesPick]];
  // A SZABÁLYLISTA JELE — két húzás, feltétel nélkül: van-e jel (csak lista
  // mellett; a jel nélküli lista a régi rekord), és az értéke, legfeljebb a rev.
  const rulesMarkDraw = r();
  const rulesMarkValue = Math.min(1 + Math.floor(r() * 5), rev);
  const rulesRev = rules !== undefined && rulesMarkDraw < 0.6 ? rulesMarkValue : undefined;
  return {
    id: 'site_1', domain: 'youtube.com', hostnames, addedAt: 1_000,
    ...(Object.keys(marks).length ? { hostnameMarks: marks } : {}),
    pauseUntil: null, pendingDeleteAt, dailyLimitSeconds, alias, reason, rev, updatedAt, updatedBy: device,
    ...(schedule ? { schedule } : {}),
    ...(burst ? { burstSeconds: burst[0], cooldownSeconds: burst[1] } : {}),
    ...(rules !== undefined ? { rules } : {}),
    ...(rulesRev !== undefined ? { rulesRev } : {}),
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

/**
 * Naplósorok készlete — a napló egyesítés, nem döntés, de a részleteiben
 * dől el, hogy a három nyelv ugyanoda jut-e: ugyanarról a menetről két
 * változat (a korábbi vég nyer, a leállítás nyer, a későbbi terv nyer), és
 * azonos végű sorok más csomaggal (a rendezés harmadik kulcsa a kezdés).
 */
export const LOGS: FocusLogEntry[] = [
  { packId: 'p1', packName: 'csomag p1', startedAt: 1_000, endedAt: 2_000, plannedEndsAt: 2_000, stopped: false },
  { packId: 'p1', packName: 'csomag p1', startedAt: 1_000, endedAt: 1_500, plannedEndsAt: 2_000, stopped: true },
  { packId: 'p2', packName: 'csomag p2', startedAt: 3_000, endedAt: 4_000, plannedEndsAt: 4_000, stopped: false, window: true },
  { packId: 'p3', packName: 'csomag p3', startedAt: 500, endedAt: 4_000, plannedEndsAt: 4_500, stopped: false },
  { packId: 'p1', packName: 'csomag p1', startedAt: 1_000, endedAt: 2_000, plannedEndsAt: 2_600, stopped: false },
];
/** Napló-részhalmazok: az egyes esetekhez, sorrendben — a húzás ezek közül választ. */
export const LOG_SETS: number[][] = [[0], [1], [0, 2], [1, 2, 3], [4, 3]];

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
  // A NAPLÓ — két húzás, feltétel nélkül, ugyanebben a sorrendben a három
  // nyelvben: van-e napló, és melyik részhalmaz. A sorok BEMENETI sorrendje
  // szándékosan nem rendezett: a fésülés rendez, és a kulcs a fésült sorrendet
  // viszi — a rendezés is tükrözött logika.
  const logDraw = r();
  const logPick = Math.floor(r() * 5);
  const log = logDraw < 0.5 ? LOG_SETS[logPick].map((i) => LOGS[i]) : [];
  return {
    ...emptyFocus(device), packs, ...(Object.keys(marks).length ? { packMarks: marks } : {}),
    run, log, rev, updatedAt, updatedBy: device,
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
  // A menetrend a módjával és a sávjaival (tartalom szerint rendezve), az adag
  // a párjával, a szabályok rendezve — és a „nincs mező” (-) más, mint az üres ([]).
  const sched = s.schedule
    ? `${s.schedule.mode}:${s.schedule.bands.map(windowKey).sort().join(';')}` : '-';
  const burst = s.burstSeconds !== undefined && s.cooldownSeconds !== undefined
    ? `${s.burstSeconds}/${s.cooldownSeconds}` : '-';
  const rules = s.rules === undefined ? '-' : `[${s.rules.map((x) => x.host + x.path).sort().join(',')}]`;
  return `hosts=[${[...s.hostnames].sort().join(',')}] marks=[${marks}] rev=${s.rev}`
    + ` pending=${opt(s.pendingDeleteAt)} limit=${opt(s.dailyLimitSeconds)} alias=${opt(s.alias)}`
    + ` reason=${opt(s.reason)}`
    + ` at=${s.updatedAt} by=${s.updatedBy}`
    + ` sched=${sched} burst=${burst} rules=${rules} rmark=${s.rulesRev ?? 0}`;
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
    + ` partner=[${partnerKey(f.partner)}] pmark=${f.partnerRev ?? 0}`
    // A napló a FÉSÜLT sorrendben: a rendezés (vég, csomag, kezdés) is tükrözött.
    + ` log=[${f.log.map((e) => `${e.packId}/${e.startedAt}/${e.endedAt}/${e.plannedEndsAt}/${e.stopped ? 1 : 0}/${e.window ? 1 : 0}`).join(';')}]`;
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

/** Egy mező cseréje az `a` oldal-rekordon, és a fajtája. */
export interface SiteFlip { flip: SyncSite; what: string }

/**
 * EGY MEZŐ CSERÉJE az oldal-rekordon — a KÖZELI rekordok fésüléséhez. A
 * véletlen a/b/c rekordok sok mezőben térnek el egymástól; a szigorúság-lánc
 * éles esetei (azonos rev, egyetlen mezőben más rekord: menetrend, keret,
 * adag, törlésre várás, egy név jellel vagy jel nélkül, a szabálylista jellel
 * vagy jel nélkül, az időbélyeg és az eszköznév döntetlenje) ritkán jönnek ki
 * belőlük. Itt az `a` és egy egy mezőben más párja fésülődik, MINDKÉT
 * sorrendben: a három nyelvnek ugyanazt kell adnia, és a két sorrendnek is.
 * Egy húzás, az a/b/c után: a fuzz-generátorokat nem érinti.
 */
export function flipSite(r: () => number, a: SyncSite): SiteFlip {
  const kind = Math.floor(r() * 14);
  const withMarks = (s: SyncSite, marks: Record<string, number>): SyncSite => {
    const out: SyncSite = { ...s };
    if (Object.keys(marks).length > 0) out.hostnameMarks = marks; else delete out.hostnameMarks;
    return out;
  };
  const marks = { ...(a.hostnameMarks ?? {}) };
  const extra = a.hostnames.filter((h) => h !== HOSTS[0]);
  switch (kind) {
    case 0: // egy név levétele JELLEL (kifizetett) — vagy felvétele jellel, ha csak a fő név van
      if (extra.length > 0) {
        return { what: 'host-mark', flip: withMarks({ ...a, hostnames: a.hostnames.filter((h) => h !== extra[0]) }, { ...marks, [extra[0]]: a.rev }) };
      }
      return { what: 'host+mark', flip: withMarks({ ...a, hostnames: [...a.hostnames, HOSTS[1]] }, { ...marks, [HOSTS[1]]: a.rev }) };
    case 1: { // ugyanez JEL NÉLKÜL (régi kliens): a bővebb nyer, a rekord dönt
      const bare = { ...marks };
      if (extra.length > 0) {
        delete bare[extra[0]];
        return { what: 'host-', flip: withMarks({ ...a, hostnames: a.hostnames.filter((h) => h !== extra[0]) }, bare) };
      }
      delete bare[HOSTS[1]];
      return { what: 'host+', flip: withMarks({ ...a, hostnames: [...a.hostnames, HOSTS[1]] }, bare) };
    }
    case 2: return { what: 'pending', flip: { ...a, pendingDeleteAt: a.pendingDeleteAt === null ? 5_000 : null } };
    case 3: return a.schedule
      ? { what: 'sched-', flip: { ...a, schedule: undefined } }
      : { what: 'sched+', flip: { ...a, schedule: SCHEDULES[0] } };
    case 4: return { what: 'limit', flip: { ...a, dailyLimitSeconds: (a.dailyLimitSeconds ?? 0) + 600 } };
    case 5: return a.burstSeconds !== undefined
      ? { what: 'burst-', flip: { ...a, burstSeconds: undefined, cooldownSeconds: undefined } }
      : { what: 'burst+', flip: { ...a, burstSeconds: 600, cooldownSeconds: 300 } };
    case 6: return a.cooldownSeconds !== undefined
      ? { what: 'cooldown', flip: { ...a, cooldownSeconds: a.cooldownSeconds + 300 } }
      : { what: 'burst+', flip: { ...a, burstSeconds: 600, cooldownSeconds: 300 } };
    // A fedőnév és az indok nem billenti a szigorúságot: azonos rev-nél a
    // döntetlent az időbélyeg és az eszköznév töri el. Ugyanaz az eszköz nem ír
    // két rekordot ugyanazzal a rev-vel (minden szerkesztés léptet), ezért a
    // csere MÁSIK eszköztől jön — így a döntetlen-törés determinisztikus.
    case 7: return { what: 'alias', flip: { ...a, alias: a.alias ? undefined : 'n9', updatedBy: 'masik' } };
    case 8: return { what: 'reason', flip: { ...a, reason: a.reason ? undefined : 'r9', updatedBy: 'masik' } };
    case 9: // a szabálylista cseréje JELLEL: a lista ki vagy be, a jel a rekord rev-je
      return a.rules && a.rules.length > 0
        ? { what: 'rules-mark', flip: { ...a, rules: [], rulesRev: a.rev } }
        : { what: 'rules+mark', flip: { ...a, rules: [RULES[0]], rulesRev: a.rev } };
    case 10: // ugyanez JEL NÉLKÜL (régi rekord): a rekord rev-je dönt
      return a.rules && a.rules.length > 0
        ? { what: 'rules-', flip: { ...a, rules: [], rulesRev: undefined } }
        : { what: 'rules+', flip: { ...a, rules: [RULES[0]], rulesRev: undefined } };
    case 11: return { what: 'rev', flip: { ...a, rev: a.rev + 1 } };
    case 12: return { what: 'updatedAt', flip: { ...a, updatedAt: a.updatedAt + 1 } };
    default: return { what: 'updatedBy', flip: { ...a, updatedBy: 'masik' } };
  }
}

/** A mérés napjai, céljai és címkéi — a használati statisztika egyesítéséhez. */
export const USAGE_DAYS = ['2026-09-28', '2026-09-29', '2026-09-30'];
export const USAGE_KEYS = ['site:youtube.com', 'site:reddit.com', 'app:com.example.app', 'app:Safari'];
export const USAGE_LABELS = ['YouTube', 'Reddit', 'Példa app', 'Safari'];

/**
 * Egy eszköz mérése — a használati statisztika egyesítéséhez (`combineUsage`
 * / `UsageLogic.combineUsage` / `UsageStats.combine`). Harminckét húzás, mind
 * feltétel nélkül: naponként van-e nap, célonként van-e mérés és mennyi
 * (egész percek, hogy a három nyelv számformátuma ne játsszon), célonként
 * van-e címke (az eszköz nevével, hogy a címke-verseny — a több időt mérő
 * eszközé — látható legyen), és a kapcsoló. Ezt csak a fixtúra használja: a
 * Kotlin és a Swift a kész állapotokat olvassa a dróton át.
 */
export function randomUsage(r: () => number, device: string): UsageState {
  const days: UsageDay[] = [];
  for (const day of USAGE_DAYS) {
    const hasDay = r() < 0.6;
    const seconds: Record<string, number> = {};
    for (const k of USAGE_KEYS) {
      const hasKey = r() < 0.5;
      const amount = 60 * (1 + Math.floor(r() * 5));
      if (hasDay && hasKey) seconds[k] = amount;
    }
    if (hasDay) days.push({ day, seconds });
  }
  const labels: Record<string, string> = {};
  for (let i = 0; i < USAGE_KEYS.length; i++) {
    const hasLabel = r() < 0.6;
    if (hasLabel) labels[USAGE_KEYS[i]] = `${USAGE_LABELS[i]} (${device})`;
  }
  const enabled = r() < 0.7;
  return { days, labels, enabled };
}

/** A használati statisztika megfelelőségi kulcsa — a napok az EGYESÍTETT sorrendben, a célok és a címkék rendezve. */
export function usageConformanceKey(u: UsageState): string {
  const byKey = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);
  const days = u.days.map((d) => `${d.day}:{${Object.entries(d.seconds).sort(byKey).map(([k, v]) => `${k}=${v}`).join(',')}}`).join(';');
  const labels = Object.entries(u.labels).sort(byKey).map(([k, v]) => `${k}=${v}`).join(',');
  return `enabled=${u.enabled ? 1 : 0} days=[${days}] labels=[${labels}]`;
}
