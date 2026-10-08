// Véletlen szinkron-rekordok a tesztekhez — a fuzz és a megfelelőségi
// fixture közös generátora.
//
// A véletlen egy LCG, és a képlete meg a hívási sorrendje SZERZŐDÉS: a Kotlin
// (MergeFuzzTest) és a Swift (MergeFuzzTests) tükör ugyanezt a sorozatot
// állítja elő ugyanabból a magból, tehát ugyanazokat az eseteket járja be.
// Ha itt egy r() hívás sorrendje változik, ott is változnia kell.

import { isGone, ruleKey, type SyncSite } from '../src/shared/sync/merge';
import { emptyFocus, normalizeSyncFocus, type SyncFocus } from '../src/shared/sync/focus-merge';
import { isRunning, isSiteAllowed, type FocusLogEntry, type FocusPack, type FocusRun } from '../src/shared/focus';
import type { Band, Schedule, ScheduleMode, Weekday } from '../src/shared/schedule';
import type { UrlRule } from '../src/shared/urlrules';
import { windowKey, windowMarksKey, type Lockdown, type LockdownWindow } from '../src/shared/lockdown';
import { keywordInHost, keywordMarksKey, keywordsKey } from '../src/shared/keywords';
import { partnerId, partnerKey, type PartnerGone, type PartnerLock } from '../src/shared/partner';
import {
  dayKeysBack, rank, summarize, totalsForDays, type TargetTotal, type UsageDay, type UsageState, type WeekDelta,
} from '../src/shared/usage';
import type { Limitable, SharedToday } from '../src/shared/limits';
import type { BurstRule } from '../src/shared/burst';

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
  // A KIFIZETETT LAZÍTÁSOK — három húzás, feltétel nélkül, ugyanebben a
  // sorrendben a három nyelvben: van-e számláló, melyik mezőé, és mennyi —
  // legfeljebb a rev (csak léptetés írhatja). Egyenlő számnál a szigorúbb
  // alak jön ki, eltérőnél a több kifizetett lazítás — mindkettő jár.
  const loosDraw = r();
  const loosPick = Math.floor(r() * 4);
  const loosValue = Math.min(1 + Math.floor(r() * 2), rev);
  const loosens = loosDraw < 0.4 ? { [LOOSENS[loosPick]]: loosValue } : {};
  // A SZABÁLYOK JELEI — négy húzás, feltétel nélkül, ugyanebben a sorrendben
  // a három nyelvben: a két készlet-szabály mindegyikére van-e jele, és mennyi
  // (legfeljebb a rev). A listán nem lévő szabály jele sírkő; csak lista mellett.
  const rm0Draw = r();
  const rm0Value = Math.min(1 + Math.floor(r() * 5), rev);
  const rm1Draw = r();
  const rm1Value = Math.min(1 + Math.floor(r() * 5), rev);
  const ruleMarks: Record<string, number> = {};
  if (rules !== undefined && rm0Draw < 0.5) ruleMarks[ruleKey(RULES[0])] = rm0Value;
  if (rules !== undefined && rm1Draw < 0.5) ruleMarks[ruleKey(RULES[1])] = rm1Value;
  // A VÉGIGMENT TÖRLÉS JELE — két húzás, feltétel nélkül, ugyanebben a
  // sorrendben a három nyelvben: van-e, és mennyi — legfeljebb a törlés
  // számlálója (a bemenet mindhárom nyelvben így tisztít). A rekord halott,
  // ha egyenlő vele, és vár; visszavont, ha egyenlő, és nem vár.
  const goneDraw = r();
  const goneValue = 1 + Math.floor(r() * 2);
  const del = (loosens as Partial<Record<(typeof LOOSENS)[number], number>>).deleteLoosens ?? 0;
  const goneLoosens = del > 0 && goneDraw < 0.6 ? Math.min(goneValue, del) : undefined;
  return {
    id: 'site_1', domain: 'youtube.com', hostnames, addedAt: 1_000,
    ...(Object.keys(marks).length ? { hostnameMarks: marks } : {}),
    pauseUntil: null, pendingDeleteAt, dailyLimitSeconds, alias, reason, rev, updatedAt, updatedBy: device,
    ...(schedule ? { schedule } : {}),
    ...(burst ? { burstSeconds: burst[0], cooldownSeconds: burst[1] } : {}),
    ...(rules !== undefined ? { rules } : {}),
    ...(rulesRev !== undefined ? { rulesRev } : {}),
    ...(Object.keys(ruleMarks).length ? { ruleMarks } : {}),
    ...loosens,
    ...(goneLoosens !== undefined ? { goneLoosens } : {}),
  };
}

/** A négy kifizetett-lazítás számláló, a húzás sorrendjében. */
export const LOOSENS = ['deleteLoosens', 'scheduleLoosens', 'limitLoosens', 'burstLoosens'] as const;

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
 * Három rögzített megbízott-zár. A só és a lenyomat itt csak ALAKRA jó
 * (base64, a hossz a korláton belül) — a fésülés az AZONOSSÁGOT (só és
 * lenyomat), a levettek nyomát és a felvétel idejét nézi, a jelmondatot
 * sehol. A `setAt` különbözik: a legkorábban felvett a fő, a többi társ.
 */
export const PARTNERS: PartnerLock[] = [
  { name: 'Anna', salt: 'QUFBQUFBQUFBQUFBQUFBQQ==', hash: 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=', setAt: 5 },
  { name: 'Bela', salt: 'Q0NDQ0NDQ0NDQ0NDQ0NDQw==', hash: 'REREREREREREREREREREREREREREREREREREREREREQ=', setAt: 3 },
  { name: 'Cili', salt: 'RUVFRUVFRUVFRUVFRUVFRQ==', hash: 'RkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkY=', setAt: 4 },
];
/** A csere-fajták megbízottja — a húzásokban sosem szerepel, tehát a felvétele mindig különbség. */
export const PARTNER_FLIP: PartnerLock = {
  name: 'Dora', salt: 'R0dHR0dHR0dHR0dHR0dHRw==', hash: 'SEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEg=', setAt: 9,
};

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

/**
 * A fésülés „most”-ja: a menetek ekkor még futnak (a vég 610 000 vagy
 * 670 000), a sírkövek közül a 800 000 utáni a jövőben ért véget (öt perc
 * tűréssel), tehát nem zár le menetet.
 */
export const FOCUS_MERGE_NOW = 500_000;

/**
 * SÍRKÖVEK: naplósorok, amelyek a generált menetek egyikére hivatkoznak — a
 * menet kezdése 10 vagy 60 010, a vége 610 000 vagy 670 000, az eredeti
 * kezdése (ha eltolták) 5. Leállítás, lejárat, rövidítés utáni leállítás, egy
 * eltolt menet sora, és egy a jövőben véget ért sor.
 */
export const TOMBS: FocusLogEntry[] = [
  { packId: 'p1', packName: 'csomag p1', startedAt: 10, endedAt: 300_000, plannedEndsAt: 610_000, stopped: true },
  { packId: 'p2', packName: 'csomag p2', startedAt: 10, endedAt: 610_000, plannedEndsAt: 610_000, stopped: false },
  { packId: 'p3', packName: 'csomag p3', startedAt: 60_010, endedAt: 400_000, plannedEndsAt: 610_000, stopped: true, cuts: 1 },
  { packId: 'p1', packName: 'csomag p1', startedAt: 60_010, endedAt: 450_000, plannedEndsAt: 670_000, stopped: true, origin: 5 },
  { packId: 'p4', packName: 'csomag p4', startedAt: 10, endedAt: 900_000, plannedEndsAt: 900_000, stopped: false },
];

/** Egy kézzel írt fésülési eset: a menet új szabályainak egy-egy ága. */
export interface FocusScenario { name: string; a: SyncFocus; b: SyncFocus; c: SyncFocus }

/**
 * A MENET SZABÁLYAINAK MINDEN ÁGA, kézzel — a véletlen generátor egyiket-másikat
 * ritkán hozza, a tükröknek viszont mindet bizonyítaniuk kell. Mindegyik a
 * `FOCUS_MERGE_NOW` időpontban értendő.
 */
export function focusScenarios(): FocusScenario[] {
  const p = (id: string, sites: string[] = ['quizlet.com']): FocusPack => ({
    id, name: `csomag ${id}`, allowSites: sites, allowApps: [], defaultMinutes: 50,
  });
  const blob = (device: string, over: Partial<SyncFocus>): SyncFocus => ({
    ...emptyFocus(device), packs: [p('p1')], rev: 3, updatedAt: 100, updatedBy: device, ...over,
  });
  const row = (over: Partial<FocusLogEntry>): FocusLogEntry => ({
    packId: 'p1', packName: 'csomag p1', startedAt: 10, endedAt: 300_000, plannedEndsAt: 610_000, stopped: true, ...over,
  });
  const run = { packId: 'p1', startedAt: 10, endsAt: 610_000 };
  const third = blob('telefon', { rev: 2 });
  return [
    // A leállítás naplósora lezárja a menetet — rev-től függetlenül.
    { name: 'sirko-leallit', a: blob('gep-a', { run, rev: 9 }), b: blob('gep-b', { log: [row({})], rev: 2 }), c: third },
    // A kifizetett rövidítés nyer a hosszabb, régi változat felett.
    {
      name: 'rovidites-nyer',
      a: blob('gep-a', { run: { ...run, endsAt: 550_000, cuts: 1 }, rev: 2 }),
      b: blob('gep-b', { run, rev: 9 }), c: third,
    },
    // A jövőben véget ért sor nem zár le menetet.
    {
      name: 'jovobeli-sor',
      a: blob('gep-a', { run: { ...run, endsAt: 900_000 } }),
      b: blob('gep-b', { log: [row({ endedAt: 900_000, plannedEndsAt: 900_000, stopped: false })], rev: 8 }), c: third,
    },
    // Az eltolt menet ugyanaz a menet: a lezárás sora rá is vonatkozik.
    {
      name: 'eltolt-menet',
      a: blob('gep-a', { run: { packId: 'p1', startedAt: 60_010, endsAt: 660_010, origin: 5 } }),
      b: blob('gep-b', { log: [row({ startedAt: 5, endedAt: 400_000, plannedEndsAt: 600_005, stopped: false })] }),
      c: blob('telefon', { run: { packId: 'p1', startedAt: 5, endsAt: 600_005 }, rev: 2 }),
    },
    // A hosszabbítás, amiről a lezáró nem tudott, túléli a lezárást.
    {
      name: 'hosszabbitas-tulel',
      a: blob('gep-a', { run: { ...run, endsAt: 670_000 } }),
      b: blob('gep-b', { log: [row({ endedAt: 610_000, plannedEndsAt: 610_000, stopped: false })], rev: 8 }), c: third,
    },
    // Felhúzott rev, sor nélkül: a menet fut tovább.
    { name: 'felhuzott-rev', a: blob('gep-a', { run }), b: blob('gep-b', { rev: 50 }), c: third },
    // Felhúzott jelű törlés: a futó menet csomagja marad.
    {
      name: 'csomag-torles',
      a: blob('gep-a', { run }), b: blob('gep-b', { packs: [], packMarks: { p1: 50 }, rev: 50 }), c: third,
    },
    // Felhúzott jelű bővítés: a futó menet fehérlistája nem bővül.
    {
      name: 'csomag-bovites',
      a: blob('gep-a', { run }),
      b: blob('gep-b', { packs: [p('p1', ['quizlet.com', 'youtube.com'])], packMarks: { p1: 50 }, rev: 50 }), c: third,
    },
  ];
}

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
  // TÁRS-MEGBÍZOTT ÉS A LEVETTEK NYOMA — öt húzás, feltétel nélkül, ugyanebben
  // a sorrendben a három nyelvben: van-e társ, melyik a háromból (lehet a fő
  // is — a normalizálás kiszűri); van-e nyom, kié, és mikori. A nyom a főt is
  // eltalálhatja: akkor a fő nem él, és a társ lép a helyére.
  const coDraw = r();
  const coPick = Math.floor(r() * 3);
  const goneDraw = r();
  const gonePick = Math.floor(r() * 3);
  const goneAt = 1 + Math.floor(r() * 3);
  const partnerCo = coDraw < 0.25 ? [PARTNERS[coPick]] : [];
  const partnersGone: PartnerGone[] = goneDraw < 0.2 ? [{ id: partnerId(PARTNERS[gonePick]), at: goneAt }] : [];
  // A KULCSSZÓ-JELEK — három húzás, feltétel nélkül, ugyanebben a sorrendben
  // a három nyelvben: van-e jel, melyik kulcsszóé (a listán lévőé is lehet,
  // a hiányzóé is — az a levétel jele), és mekkora — legfeljebb a blob rev-je.
  const kmDraw = r();
  const kmPick = Math.floor(r() * 2);
  const kmValue = Math.min(1 + Math.floor(r() * 5), rev);
  const keywordMarks: Record<string, number> = kmDraw < 0.35 ? { [['shorts', 'reels'][kmPick]]: kmValue } : {};
  // AZ ABLAK-JELEK — három húzás, feltétel nélkül, ugyanebben a sorrendben a
  // három nyelvben: van-e jel, melyik ablak tartalmáé (a listán lévőé is
  // lehet, a hiányzóé is — az a levétel jele), és mekkora.
  const wmDraw = r();
  const wmPick = Math.floor(r() * WINDOWS.length);
  const wmValue = Math.min(1 + Math.floor(r() * 5), rev);
  const lockdownWindowMarks: Record<string, number> = wmDraw < 0.35 ? { [windowKey(WINDOWS[wmPick])]: wmValue } : {};
  // A NAPLÓ — két húzás, feltétel nélkül, ugyanebben a sorrendben a három
  // nyelvben: van-e napló, és melyik részhalmaz. A sorok BEMENETI sorrendje
  // szándékosan nem rendezett: a fésülés rendez, és a kulcs a fésült sorrendet
  // viszi — a rendezés is tükrözött logika.
  const logDraw = r();
  const logPick = Math.floor(r() * 5);
  const rows = logDraw < 0.5 ? LOG_SETS[logPick].map((i) => LOGS[i]) : [];
  // A MENET JELEI ÉS A SÍRKŐ — négy húzás, feltétel nélkül, ugyanebben a
  // sorrendben a három nyelvben: rövidítette-e (egyszer), eltolta-e az óra
  // (az eredeti kezdés 5), van-e sírkő, és melyik. A sírkő a sorok VÉGÉRE
  // kerül: a bemeneti sorrend itt sem rendezett.
  const cutsDraw = r();
  const originDraw = r();
  const tombDraw = r();
  const tombPick = Math.floor(r() * TOMBS.length);
  const marked = run
    ? { ...run, ...(cutsDraw < 0.25 ? { cuts: 1 } : {}), ...(originDraw < 0.2 ? { origin: 5 } : {}) }
    : null;
  const log = tombDraw < 0.3 ? [...rows, TOMBS[tombPick]] : rows;
  return {
    ...emptyFocus(device), packs, ...(Object.keys(marks).length ? { packMarks: marks } : {}),
    run: marked, log, rev, updatedAt, updatedBy: device,
    ...(lockdown ? { lockdown } : {}),
    ...(windows.length > 0 ? { lockdownWindows: windows } : {}),
    ...(windowsRev !== undefined ? { lockdownWindowsRev: windowsRev } : {}),
    ...(hide ? { hideSiteList: true } : {}),
    ...(hideRev !== undefined ? { hideSiteListRev: hideRev } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(keywordsRev !== undefined ? { keywordsRev } : {}),
    ...(partner ? { partner } : {}),
    ...(partnerRev !== undefined ? { partnerRev } : {}),
    ...(partnerCo.length > 0 ? { partnerCo } : {}),
    ...(partnersGone.length > 0 ? { partnersGone } : {}),
    ...(Object.keys(keywordMarks).length > 0 ? { keywordMarks } : {}),
    ...(Object.keys(lockdownWindowMarks).length > 0 ? { lockdownWindowMarks } : {}),
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
    + ` sched=${sched} burst=${burst} rules=${rules} rmark=${s.rulesRev ?? 0}`
    + ` loos=${s.deleteLoosens ?? 0}/${s.scheduleLoosens ?? 0}/${s.limitLoosens ?? 0}/${s.burstLoosens ?? 0}`
    + ` rmarks=[${Object.entries(s.ruleMarks ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join(',')}]`
    + ` gone=${s.goneLoosens ?? 0}`;
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
  const run = f.run
    ? `${f.run.packId}/${f.run.startedAt}/${f.run.endsAt}/${f.run.cuts ?? 0}/${f.run.origin ?? '-'}` : '-';
  const lock = f.lockdown ? `${f.lockdown.startedAt}/${f.lockdown.until}` : '-';
  // Az ablakok TARTALOM szerint, rendezve: az azonosító és a sorrend nem jelentés.
  const windows = (f.lockdownWindows ?? []).map(windowKey).sort().join(';');
  return `packs=[${packs}] run=${run} marks=[${marks}] rev=${f.rev} at=${f.updatedAt} by=${f.updatedBy}`
    + ` lock=${lock} windows=[${windows}] wmark=${f.lockdownWindowsRev ?? 0}`
    + ` hide=${f.hideSiteList ? 1 : 0} hmark=${f.hideSiteListRev ?? 0}`
    + ` kw=[${keywordsKey(f.keywords ?? [])}] kmark=${f.keywordsRev ?? 0} kwm=[${keywordMarksKey(f.keywordMarks)}]`
    + ` wm=[${windowMarksKey(f.lockdownWindowMarks)}]`
    + ` partner=[${partnerKey(f.partner)}] pmark=${f.partnerRev ?? 0}`
    + ` co=[${(f.partnerCo ?? []).map(partnerKey).join(';')}]`
    + ` gone=[${(f.partnersGone ?? []).map((g) => `${g.id}@${g.at}`).join(';')}]`
    // A napló a FÉSÜLT sorrendben: a rendezés (vég, csomag, kezdés) is tükrözött.
    + ` log=[${f.log.map((e) => `${e.packId}/${e.startedAt}/${e.endedAt}/${e.plannedEndsAt}/${e.stopped ? 1 : 0}/${e.window ? 1 : 0}`
      + `/${e.cuts ?? 0}/${e.origin ?? '-'}`).join(';')}]`;
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
 * Huszonöt fajta: huszonegy jelentés (különbség), négy nem az (időbélyeg,
 * eszköznév, ablak-azonosító, a csomagok sorrendje). A menet
 * rövidítésszáma és eredeti kezdése jelentés: a fésülés ezekből dönt; a
 * társ-megbízott és a levettek nyoma is: élő megbízottat csak a nyoma visz el;
 * a kulcsszó- és az ablak-jelek is: elemenként azok döntenek. A várt érték a fajtából
 * következik, és a gép tesztje ellenőrzi is — így egy hatástalan csere (amit
 * a normalizálás visszaírna) nem marad néma. EGY húzás, az a/b/c UTÁN: a
 * Kotlin és a Swift fuzz-generátort nem érinti, a fixtúra a cserét JSON-ban
 * viszi, a tükrök csak visszajátsszák.
 */
export function flipFocus(r: () => number, a: SyncFocus): FocusFlip {
  const kind = Math.floor(r() * 25);
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
    // A megbízottak a NORMALIZÁLT alakból: a nyom a fő-t is eltalálhatja, és
    // akkor a nyers mező elhagyása nem különbség — a csere hatása a
    // fésülés-utáni állapoton dől el.
    case 17: return normalizeSyncFocus(a, 'x').partner
      ? diff('partner-', { ...a, partner: undefined, partnerCo: undefined })
      : diff('partner+', { ...a, partner: PARTNER_FLIP });
    case 18: return diff('pmark', { ...a, partnerRev: otherMark(a.partnerRev) });
    case 19:
      if (!a.run) return first ? diff('run+', { ...a, run: { packId: first.id, startedAt: 10, endsAt: 610_000, cuts: 1 } }) : addPack();
      return diff('run.cuts', { ...a, run: { ...a.run, cuts: a.run.cuts ? a.run.cuts + 1 : 1 } });
    case 20:
      if (!a.run) return diff('log+', { ...a, log: [...a.log, { ...TOMBS[0] }] });
      return diff('run.origin', { ...a, run: { ...a.run, origin: a.run.origin === 5 ? 6 : 5 } });
    case 21: {
      const n = normalizeSyncFocus(a, 'x');
      return n.partnerCo?.length
        ? diff('partnerCo-', { ...a, partner: n.partner, partnerCo: undefined })
        : diff('partnerCo+', { ...a, partnerCo: [...(a.partnerCo ?? []), PARTNER_FLIP] });
    }
    case 22: return normalizeSyncFocus(a, 'x').partnersGone?.length
      ? diff('partnersGone-', { ...a, partnersGone: undefined })
      : diff('partnersGone+', { ...a, partnersGone: [{ id: partnerId(PARTNER_FLIP), at: 1 }] });
    // A kulcsszó-jelek is jelentés: a levétel jele nélkül a levétel sosem érne át.
    case 23: return a.keywordMarks
      ? diff('keywordMarks-', { ...a, keywordMarks: undefined })
      : diff('keywordMarks+', { ...a, keywordMarks: { stream: 1 } });
    // Az ablak-jelek is jelentés: tartalmanként azok döntenek.
    case 24: return a.lockdownWindowMarks
      ? diff('windowMarks-', { ...a, lockdownWindowMarks: undefined })
      : diff('windowMarks+', { ...a, lockdownWindowMarks: { '0/60/120': 1 } });
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
  const kind = Math.floor(r() * 17);
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
    // Egy kifizetett lazítás nyoma: a számláló egy mezőn eggyel nő, a rev vele.
    case 13: return { what: 'loosens', flip: { ...a, limitLoosens: (a.limitLoosens ?? 0) + 1, rev: a.rev + 1 } };
    // Egy szabály kifizetett levétele: sírkő a léptetett rev-vel.
    case 14: return {
      what: 'ruleMark',
      flip: {
        ...a, rules: (a.rules ?? []).filter((x) => ruleKey(x) !== ruleKey(RULES[0])),
        ruleMarks: { ...(a.ruleMarks ?? {}), [ruleKey(RULES[0])]: a.rev + 1 }, rev: a.rev + 1,
      },
    };
    // A végigment törlés sírköve: a kérés számlálója a jelen, és vár — a
    // rekord halott. Számláló nélkül egy kifizetett kéréssel (a rev-vel).
    case 15: {
      const del = a.deleteLoosens ?? a.rev;
      return { what: 'gone', flip: { ...a, pendingDeleteAt: a.pendingDeleteAt ?? 5_000, deleteLoosens: del, goneLoosens: del } };
    }
    default: return { what: 'updatedBy', flip: { ...a, updatedBy: 'masik' } };
  }
}

/** A lista-esetek „most”-ja: a határidők körülötte — egy lejárt, egy épp most, egy jövőbeli. */
export const LIST_NOW = 6_000;
/**
 * A lista-esetek rekordjai: négy azonosító, három domain — kettő UGYANAZON a
 * domainen, hogy a domain szerinti összevonás és a sírkő találkozzon.
 */
export const LIST_SITES: { id: string; domain: string; addedAt: number }[] = [
  { id: 's1', domain: 'youtube.com', addedAt: 1_000 },
  { id: 's2', domain: 'youtu.be', addedAt: 2_000 },
  { id: 's3', domain: 'youtube.com', addedAt: 3_000 },
  { id: 's4', domain: 'yt.be', addedAt: 4_000 },
];
export interface ListCase { a: SyncSite[]; b: SyncSite[]; c: SyncSite[]; local: string[]; now: number }

/**
 * Három eszköz listája, sírkövekkel — a lista-szintű fésüléshez
 * (`mergeSiteLists`), az előkészítéshez (`settleIncoming`) és a
 * szétosztáshoz (`splitMerged`). Rekordonként öt húzás, feltétel nélkül,
 * ugyanebben a sorrendben a három nyelvben: van-e, milyen állapotú (élő,
 * vár, halott, visszavont, régi — számláló nélküli — kérés), mikor jár le,
 * mennyi a számláló, mennyi a rev; a végén azonosítónként egy: helyi-e.
 */
export function randomListCase(r: () => number): ListCase {
  const lists = DEVICES.map((device) => {
    const out: SyncSite[] = [];
    for (const { id, domain, addedAt } of LIST_SITES) {
      const has = r() < 0.6;
      const kind = Math.floor(r() * 5);
      const at = LIST_NOW - 1_000 + Math.floor(r() * 3) * 1_000;
      const count = 1 + Math.floor(r() * 2);
      const rev = 2 + Math.floor(r() * 4);
      if (!has) continue;
      const base: SyncSite = {
        id, domain, hostnames: [domain], addedAt, pauseUntil: null, pendingDeleteAt: null,
        rev, updatedAt: 100 + rev, updatedBy: device,
      };
      if (kind === 1) out.push({ ...base, pendingDeleteAt: at, deleteLoosens: count });
      else if (kind === 2) out.push({ ...base, pendingDeleteAt: at, deleteLoosens: count, goneLoosens: count });
      else if (kind === 3) out.push({ ...base, deleteLoosens: count, goneLoosens: count });
      else if (kind === 4) out.push({ ...base, pendingDeleteAt: at });
      else out.push(base);
    }
    return out;
  });
  const local = LIST_SITES.filter(() => r() < 0.5).map((s) => s.id);
  return { a: lists[0], b: lists[1], c: lists[2], local, now: LIST_NOW };
}

/**
 * A sírkövek plafonja: hetven halott rekord, sok holtversennyel a határidőben
 * — a legkésőbbi határidejűek maradnak, holtversenyben az azonosító dönt
 * (kódegység szerint: a `g10` a `g2` előtt).
 */
export function goneCapList(): SyncSite[] {
  return Array.from({ length: 70 }, (_, i) => ({
    id: `g${i}`, domain: 'youtube.com', hostnames: ['youtube.com'], addedAt: 1_000 + i, pauseUntil: null,
    pendingDeleteAt: 5_000 + (i % 7) * 10, deleteLoosens: 1, goneLoosens: 1, rev: 2, updatedAt: 100, updatedBy: 'gep-a',
  }));
}

/** Egy lista kulcsa — a sorrend is számít: a fésülés kanonikus sorrendet ad. */
export function listConformanceKey(list: SyncSite[]): string[] {
  return list.map((s) => `${s.id}|${s.domain}|${isGone(s) ? 'dead' : 'live'}|${siteConformanceKey(s)}`);
}

/** A mérés napjai, céljai és címkéi — a használati statisztika egyesítéséhez. */
/** Két nap az előző hétből is, hogy a hét az előző héthez képest (weekOverWeek) ne csak null legyen. */
export const USAGE_DAYS = ['2026-09-20', '2026-09-22', '2026-09-28', '2026-09-29', '2026-09-30'];
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

/**
 * A DÖNTÉS bemenete: egy oldal, a helyi mérés, a többi eszköz mai összegzése
 * és egy időpont — a kimenet: tilt-e MOST (`isBlockedNowWithLimit`).
 *
 * Az időpont dél UTC-ben, és a menetrend vagy nincs, vagy EGÉSZ HETES nyitó
 * sáv: a menetrend és a napkulcs helyi időben értékelődik ki, és a három
 * teszt a futtató gép időzónájában fut. Délben a napkulcs −12…+11 órás
 * eltolásnál is ugyanaz a nap; egy részleges sáv viszont nem lenne — az
 * egész hetes sáv igen, az minden helyi percet lefed. Menetrend nélkül az
 * oldal mindig zár (a keret sosem dönt), a nyitó sávval a keret dönt: így
 * dől el itt a szünet, a törlésre várás és a KÖZÖS napi keret (a saját sor
 * kihagyva, a nem mai nap kihagyva, a távoli másodpercek csak hozzáadnak);
 * a részleges sávok a nyelvenkénti teszteké maradnak.
 */
export const DECISION_NOW = 1790769600000;
export const DECISION_TODAY = '2026-09-30';
export const DECISION_YESTERDAY = '2026-09-29';
export const DECISION_DOMAIN = 'youtube.com';

export interface DecisionCase { site: Limitable & { domain: string }; usage: UsageState; shared: SharedToday | null }

/** Egész hetes nyitó menetrend: minden helyi percben enged — a keret dönt. */
export const OPEN_ALL_WEEK: Schedule = {
  mode: 'scheduled_allow', bands: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }],
};

/** Tizenkét húzás, mind feltétel nélkül — csak a fixtúráé. */
export function randomDecision(r: () => number): DecisionCase {
  // BEMELEGÍTÉS: az LCG első húzásai kis, szomszédos magoknál szinte azonosak
  // (0,236…0,267), tehát egy háromutas választás az első húzásból mindig
  // ugyanoda esne. Négy eldobott húzás után a sorozat már szétterül. Csak itt:
  // a fésülés-generátorok sorrendje a Kotlin és Swift fuzz szerződése.
  for (let i = 0; i < 4; i++) r();
  const schedDraw = r();
  const pauseDraw = Math.floor(r() * 4);
  const pendingDraw = r();
  const limitDraw = Math.floor(r() * 3);
  const usedToday = 300 * Math.floor(r() * 6);
  const yesterdayDraw = r();
  const otherDraw = r();
  const otherSeconds = 300 * Math.floor(r() * 5);
  const selfDraw = r();
  const oldDraw = r();
  const sharedDraw = r();
  const limitValue = 600 * (1 + Math.floor(r() * 2));
  const key = `site:${DECISION_DOMAIN}`;
  const site = {
    domain: DECISION_DOMAIN,
    // Szünet: nincs, él (a jövőben jár le), már lejárt (nem számít), vagy él és
    // 36 óra múlva jár le — az minden időzónában túl van legalább egy éjfélen:
    // a szünet végén a napi keret már nulláról indul (`closesAfterPause`).
    pauseUntil: pauseDraw === 0 ? null : pauseDraw === 1 ? DECISION_NOW + 60_000
      : pauseDraw === 2 ? DECISION_NOW - 60_000 : DECISION_NOW + 36 * 3_600_000,
    pendingDeleteAt: pendingDraw < 0.3 ? DECISION_NOW + 3_600_000 : null,
    // Nyitó menetrend a kétharmadban: enélkül az oldal mindig zár, és a keret sosem dönt.
    ...(schedDraw < 0.66 ? { schedule: OPEN_ALL_WEEK } : {}),
    ...(limitDraw === 0 ? {} : { dailyLimitSeconds: limitValue }),
  };
  const days: UsageDay[] = [];
  if (usedToday > 0) days.push({ day: DECISION_TODAY, seconds: { [key]: usedToday } });
  // A tegnapi perc nem számít a mai keretbe.
  if (yesterdayDraw < 0.5) days.push({ day: DECISION_YESTERDAY, seconds: { [key]: 900 } });
  const usage: UsageState = { days, labels: {}, enabled: true };
  const devices: SharedToday['devices'] = [];
  // A saját sorunk visszajön a kiszolgálótól — ki kell hagyni, különben minden perc kétszer számítana.
  if (selfDraw < 0.5) devices.push({ deviceId: 'me', day: DECISION_TODAY, seconds: { [key]: 900 } });
  if (otherDraw < 0.6) devices.push({ deviceId: 'other', day: DECISION_TODAY, seconds: { [key]: otherSeconds } });
  // A másik eszköz TEGNAPI sora: más időzóna, más nap — nem számít.
  if (oldDraw < 0.4) devices.push({ deviceId: 'old', day: DECISION_YESTERDAY, seconds: { [key]: 1_200 } });
  const shared: SharedToday | null = sharedDraw < 0.8 ? { selfDeviceId: 'me', devices } : null;
  return { site, usage, shared };
}

/** Egy mérés-minta az adag-számlálónak: ennyi másodperc, ekkor. */
export interface BurstSample { seconds: number; at: number }
export interface BurstRun { rule: BurstRule; samples: BurstSample[] }

/**
 * Az ADAG-SZÁMLÁLÓ bemenete: egy szabály és nyolc mérés-minta — a kimenet a
 * számláló állapota minden minta után (`noteBurstUsage` /
 * `BurstLogic.noteUsage`). A minták időköze hol kisebb a szünetnél (gyűlik),
 * hol nagyobb (tiszta lap), hol a hűtésbe esik (nem számít), és néha egy
 * elkésett régi minta jön (a `lastAt` nem léphet hátra). A gép és az Android
 * mér és tilt; az iPhone nem mér előteret, ott a szabály nem érvényesül —
 * ezért ez a két nyelv tükre. Csak a fixtúráé: a fuzz-generátorokat nem érinti.
 */
export function randomBurstRun(r: () => number): BurstRun {
  // Bemelegítés, mint a döntésnél: az LCG első húzásai kis magoknál összetartanak.
  for (let i = 0; i < 4; i++) r();
  const rule: BurstRule = {
    burstSeconds: 300 * (1 + Math.floor(r() * 3)),
    cooldownSeconds: 120 * (1 + Math.floor(r() * 3)),
  };
  const GAPS = [10_000, 60_000, 130_000, 250_000, 400_000];
  const samples: BurstSample[] = [];
  let at = 1_000_000;
  for (let i = 0; i < 8; i++) {
    const seconds = 60 * (1 + Math.floor(r() * 4));
    const gap = GAPS[Math.floor(r() * 5)];
    const late = r() < 0.2;
    // Az elkésett minta a MÚLTBÓL jön: nem a sorban következő időpont, hanem
    // egy korábbi — a köteg így hozza. Az időpont-sor egyébként előre halad.
    const sampleAt = late ? Math.max(0, at - 30_000) : at + gap;
    if (!late) at = sampleAt;
    samples.push({ seconds, at: sampleAt });
  }
  return { rule, samples };
}

/**
 * A MUNKAMENET-DÖNTÉS: mi mehet egy menet alatt. A két telefon DNS-motora
 * dönti (`Focus.verdict`), a gép a böngésző-bővítményben; a szabálysor
 * ugyanaz, és a gép közös darabjaiból összerakható — ez a referencia:
 *
 *   1. a blokklista mindig nyer (végződés szerint, a kiterjesztett
 *      hosztnév-listán — ahogy a DNS-motor illeszt);
 *   1b. kulcsszó a hosztnévben → tiltva, kivéve a saját fiókkiszolgálót;
 *   2. nem fut menet, vagy nincs csomag → mehet;
 *   3. a csomagon rajta van (egyezés vagy aldomain) → mehet;
 *   4. a saját fiókkiszolgáló → mehet;
 *   5. minden más → tiltva: a menet fehérlista.
 *
 * A rendszer-infrastruktúra kivétele (`isInfrastructure`) szándékosan nincs
 * benne: a két telefon listája különbözik (Google, illetve Apple hosztok), ezt
 * a check-infra-allow őrzi. A nevek készlete ezért egyik listát sem érinti.
 */
export const VERDICT_HOSTS = [
  'youtube.com', 'www.youtube.com', 'music.youtube.com', 'quizlet.com', 'app.quizlet.com',
  'reddit.com', 'tiktok.com', 'www.tiktok.com', 'notyoutube.com', 'live.example.org',
  'sync.pelda.hu', 'api.sync.pelda.hu', 'example.org',
];
export const VERDICT_BLOCKED: string[][] = [[], ['youtube.com'], ['youtube.com', 'tiktok.com'], ['reddit.com']];
export const VERDICT_KEYWORDS: string[][] = [[], ['tiktok'], ['live'], ['tiktok', 'quiz']];
export const VERDICT_PACKS: FocusPack[] = [
  { id: 'p1', name: 'Tanulás', allowSites: ['quizlet.com'], allowApps: [], defaultMinutes: 25 },
  { id: 'p2', name: 'Kutatás', allowSites: ['youtube.com', 'example.org'], allowApps: [], defaultMinutes: 50 },
];
export const VERDICT_NOW = 1_000_000;
export const VERDICT_SYNC_HOST = 'sync.pelda.hu';

export interface VerdictCase {
  host: string; blocked: string[]; keywords: string[];
  run: FocusRun | null; pack: FocusPack | null; syncHost: string | null; now: number;
}

/** Hat húzás a bemelegítés után — csak a fixtúráé. */
export function randomVerdict(r: () => number): VerdictCase {
  for (let i = 0; i < 4; i++) r();
  const host = VERDICT_HOSTS[Math.floor(r() * VERDICT_HOSTS.length)];
  const blocked = VERDICT_BLOCKED[Math.floor(r() * VERDICT_BLOCKED.length)];
  const keywords = VERDICT_KEYWORDS[Math.floor(r() * VERDICT_KEYWORDS.length)];
  const runDraw = Math.floor(r() * 3);
  const packDraw = Math.floor(r() * 3);
  const syncDraw = r();
  const pack = packDraw === 0 ? null : VERDICT_PACKS[packDraw - 1];
  // Menet: nincs, fut (a vége a jövőben), vagy már lejárt (a vége a múltban).
  const run: FocusRun | null = runDraw === 0 || !pack ? null
    : { packId: pack.id, startedAt: 10, endsAt: runDraw === 1 ? VERDICT_NOW + 600_000 : VERDICT_NOW - 1 };
  return { host, blocked, keywords, run, pack, syncHost: syncDraw < 0.5 ? VERDICT_SYNC_HOST : null, now: VERDICT_NOW };
}

export type VerdictLabel = 'allow' | 'list' | 'keyword' | 'focus';

/** A referencia-döntés a gép közös darabjaiból — a telefonok `Focus.verdict`-jének sorrendjében. */
export function referenceVerdict(c: VerdictCase): VerdictLabel {
  const h = c.host.trim().toLowerCase().replace(/\.+$/, '');
  if (c.blocked.some((b) => h === b || h.endsWith(`.${b}`))) return 'list';
  const sh = (c.syncHost ?? '').trim().toLowerCase().replace(/\.+$/, '');
  const ownSync = sh !== '' && (h === sh || h.endsWith(`.${sh}`));
  if (c.keywords.length > 0 && !ownSync && keywordInHost(c.keywords, h) !== null) return 'keyword';
  if (!isRunning(c.run, c.now) || !c.pack) return 'allow';
  if (isSiteAllowed(c.pack, h)) return 'allow';
  if (ownSync) return 'allow';
  return 'focus';
}

// ------------------------------------------------------------ a menetrend
//
// A MENETREND az, ami a gépen és a telefonon EGYSZERRE dönt ugyanarról az
// oldalról: ha a sáv-számtan elcsúszik, az oldal a telefonon zárva, a gépen
// nyitva — vagy fordítva — ugyanabban a percben. A sávok helyi időben
// értékelődnek ki, ezért a fixtúra UTC-ben jár (a három teszt beállítja, vagy
// kimondva kihagy); az időpontok egy rögzített hét környékén szórnak, perc ÉS
// másodperc szinten, hogy a sávhatár és a hét fordulása is sorra kerüljön.

/** A menetrend-fixtúra hete: 2026-09-28, hétfő, 00:00 UTC. */
export const SCHEDULE_WEEK_START = Date.UTC(2026, 8, 28);

export interface ScheduleCase { schedule: Schedule; other: Schedule; now: number }

/**
 * Egy véletlen menetrend: mód (mindig / tiltó sávok / nyitó sávok), 1–3 sáv,
 * véletlen napok (akár egy sem), éjfélen átnyúló sáv a harmadában, és néha
 * egy ROSSZ sáv (hetedik nap, 1440-es kezdet, nullás vég), amit a
 * normalizálásnak mindhárom nyelven ki kell szűrnie — ha minden sáv rossz, a
 * menetrend „mindig tilt”. Csak a fixtúráé: a húzások száma nem szerződés.
 */
export function randomSchedule(r: () => number): Schedule {
  const modeDraw = r();
  const mode: ScheduleMode = modeDraw < 0.15 ? 'always' : modeDraw < 0.6 ? 'scheduled_block' : 'scheduled_allow';
  const count = 1 + Math.floor(r() * 3);
  const bands: Band[] = [];
  for (let i = 0; i < count; i++) {
    const days: Weekday[] = [];
    for (let d = 0; d < 7; d++) if (r() < 0.5) days.push(d as Weekday);
    const startMin = Math.floor(r() * 1440);
    const wrapDraw = r();
    const plainEnd = 1 + Math.floor(r() * 1440);
    const wrappedEnd = Math.max(1, Math.floor(r() * (startMin + 1)));
    const endMin = wrapDraw < 0.3 ? wrappedEnd : plainEnd;
    const brokenDraw = r();
    if (brokenDraw < 0.08) bands.push({ days: [...days, 7 as Weekday], startMin, endMin });
    else if (brokenDraw < 0.12) bands.push({ days, startMin: 1440, endMin });
    else if (brokenDraw < 0.16) bands.push({ days, startMin, endMin: 0 });
    else bands.push({ days, startMin, endMin });
  }
  return { mode, bands };
}

/** Egy eset: a menetrend, egy másik (a csere célja), és egy időpont két héten belül. */
export function randomScheduleCase(r: () => number): ScheduleCase {
  for (let i = 0; i < 4; i++) r();
  const schedule = randomSchedule(r);
  const other = randomSchedule(r);
  const now = SCHEDULE_WEEK_START + Math.floor(r() * 14 * 1440) * 60_000 + Math.floor(r() * 60_000);
  return { schedule, other, now };
}

// ------------------------------------------------------- a zárlat-ablakok
//
// A heti ablak minden eszközön UGYANAKKOR zár és ugyanakkor enged: a lista a
// munkamenet-blobon utazik, a döntést mindhárom mag maga hozza, helyi időben.
// Ha az előfordulás-számtan elcsúszik, az egyik eszköz zárlatot tart, a másik
// nem — vagy a kettő más zárlatot állít elő, és a szinkron kettőnek látja.
// UTC-ben, mint a menetrend.

export interface WindowsCase {
  windows: LockdownWindow[]; next: LockdownWindow[]; cur: Lockdown | null; now: number; within: number;
}

/**
 * Egy eset: ablakok (a menetrend sáv-generátorából, azonosítóval — rossz sáv
 * is lehet köztük), a csere célja (néha üres), egy futó, lejárt vagy hiányzó
 * zárlat, egy időpont két héten belül, és a közelgő ablak kerete (az alap tíz
 * perc ritkán talál; egy és hat óra is sorra kerül).
 */
export function randomWindowsCase(r: () => number): WindowsCase {
  for (let i = 0; i < 4; i++) r();
  const toWindows = (bands: Band[], prefix: string): LockdownWindow[] =>
    bands.map((b, i) => ({ id: `${prefix}${i + 1}`, ...b }));
  const windows = toWindows(randomSchedule(r).bands, 'w');
  const nextDraw = r();
  const next = nextDraw < 0.2 ? [] : toWindows(randomSchedule(r).bands, 'n');
  const curDraw = r();
  const now = SCHEDULE_WEEK_START + Math.floor(r() * 14 * 1440) * 60_000 + Math.floor(r() * 60_000);
  const cur: Lockdown | null = curDraw < 0.5 ? null
    : curDraw < 0.65 ? { startedAt: now - 3_600_000, until: now + 1_800_000 }
    : curDraw < 0.8 ? { startedAt: now - 3_600_000, until: now + 2 * 86_400_000 }
    : { startedAt: now - 3 * 3_600_000, until: now - 3_600_000 };
  const withinDraw = r();
  const within = withinDraw < 0.4 ? 600_000 : withinDraw < 0.7 ? 3_600_000 : 6 * 3_600_000;
  return { windows, next, cur, now, within };
}

// ------------------------------------------------------- a statisztika összegzője
//
// A statisztika képernyője ebből áll: ma, tegnap, hét, hónap, a mai és a heti
// toplisták, a hét az előző héthez. Ugyanabból az egyesített mérésből a három
// magnak ugyanazt kell mondania — különben a gép és a telefon más számot mutat
// ugyanarra a kérdésre. Az iPhone összegzője kevesebbet mond (ma, hét, a mai
// és a heti vegyes toplista); azt a Swift teszt a maga részén nézi.

export interface UsageSummaryParts {
  enabled: number; today: number; yday: number; w7: number; w30: number;
  topToday: string; weekSites: string; weekApps: string; weekMixed: string; wow: string; days: number;
}

/** Az összegző mezői szövegként: toplista `kulcs=címke=mp`, a trend `ez/múlt/századszázalék` (`-`, ha nincs előző hét). */
export function usageSummaryParts(state: UsageState, now: number): UsageSummaryParts {
  const s = summarize(state, now, 8);
  const tops = (rows: TargetTotal[]) => rows.map((t) => `${t.key}=${t.label}=${t.seconds}`).join(',');
  const wow = (rows: WeekDelta[]) => rows.map((w) =>
    `${w.key}=${w.label}=${w.thisWeek}/${w.lastWeek}/${w.deltaPct === null ? '-' : Math.floor(w.deltaPct * 100 + 0.5)}`).join(',');
  const weekMixed = rank(state, totalsForDays(state, dayKeysBack(now, 7)), { limit: 8 });
  return {
    enabled: s.enabled ? 1 : 0, today: s.todaySeconds, yday: s.yesterdaySeconds, w7: s.last7Seconds, w30: s.last30Seconds,
    topToday: tops(s.topToday), weekSites: tops(s.topWeekSites), weekApps: tops(s.topWeekApps), weekMixed: tops(weekMixed),
    wow: wow(s.weekOverWeek), days: s.daysTracked,
  };
}

// ------------------------------------------------------- a menetek összegzése
//
// A menetek naplója a szinkronon utazik; a statisztika és a heti mondat
// belőle számol: a hét és az előző hét összegzője, a menet-nap, a menet-óra,
// a sorozat és a leghosszabb sorozat, a napi rajz, az ablakból indult menetek
// csomagonként. Ugyanabból a naplóból a három magnak ugyanazt kell mondania.
// A napkulcs helyi időben jár — UTC-ben, mint a menetrend.

/** A menet-napló fixtúrájának időpontja: 2026-09-30, szerda, 15:30 UTC. */
export const FOCUS_LOG_NOW = Date.UTC(2026, 8, 30, 15, 30);

export interface FocusLogCase { log: FocusLogEntry[]; now: number }

/**
 * Egy véletlen napló: 0–12 sor, a napok a mai naphoz húzva (hogy sorozat is
 * legyen) vagy három hétre szórva (hogy az előző hét és a kieső is legyen),
 * néha a jövőben (nem számít) vagy nagyon régen; a hossz 5–120 perc; a terv
 * a hosszal egyenlő (időben), hosszabb (korai vég) vagy rövidebb (késői vég,
 * nem korai); ablakból indult a harmada; három csomag, holtversenyre is.
 */
export function randomFocusLogCase(r: () => number): FocusLogCase {
  for (let i = 0; i < 4; i++) r();
  const now = FOCUS_LOG_NOW;
  const n = Math.floor(r() * 13);
  const log: FocusLogEntry[] = [];
  for (let i = 0; i < n; i++) {
    const nearDraw = r();
    const daysAgo = nearDraw < 0.6 ? Math.floor(r() * 5) : Math.floor(r() * 22);
    const whenDraw = r();
    const endedAt = whenDraw < 0.08 ? now + 3_600_000
      : whenDraw < 0.14 ? now - 40 * 86_400_000
      : now - daysAgo * 86_400_000 - Math.floor(r() * 720) * 60_000;
    const minutes = 5 + Math.floor(r() * 115);
    const startedAt = endedAt - minutes * 60_000;
    const planDraw = r();
    const plannedMinutes = planDraw < 0.5 ? minutes : planDraw < 0.85 ? minutes + 10 : Math.max(1, minutes - 5);
    const id = ['p1', 'p2', 'p3'][Math.floor(r() * 3)];
    const stopped = r() < 0.4;
    const window = r() < 0.3;
    log.push({
      packId: id, packName: `csomag ${id}`, startedAt, endedAt, plannedEndsAt: startedAt + plannedMinutes * 60_000, stopped,
      ...(window ? { window: true } : {}),
    });
  }
  return { log, now };
}
