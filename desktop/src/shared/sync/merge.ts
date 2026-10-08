// Két eszköz blokklistájának összefésülése.
//
// Ez a fájl az egész szinkron kockázatos fele. Egy blokkoló appnál minden új
// funkció egyben egy lehetséges KIBÚVÓ is, és a szinkron a legcsábítóbb: ha az
// összefésülés bármikor a lazább oldal felé dől, akkor elég két eszköz és egy
// jól időzített művelet ahhoz, hogy próbatétel nélkül oldódjon fel valami.
//
// Ezért a szabály itt is ugyanaz, ami az app többi részében:
//
//   szigorítás ingyen van, lazítás munkába kerül.
//
// A gyakorlatban MEZŐNKÉNT dől el, nem rekordonként:
//
//   1. A négy tiltó mező (törlés, menetrend, napi keret, adag-szabály) a saját
//      KIFIZETETT LAZÍTÁS-számlálóját hordja. A bíró írja, a próbatétel
//      teljesítésekor — máshol semmi. Mezőnként a több kifizetett lazítás nyer
//      — a lazítás így átmegy; ami kapun kívül lazulna, azt nem hitelesíti.
//   2. Egyenlő számnál a mező SZIGORÚBB alakja jön ki — nem az egyik rekordé,
//      hanem a kettő együtt: a menetrendek uniója (minden perc tiltva, amit
//      bármelyik tilt), a kisebb keret, a kisebb adag és a hosszabb szünet, a
//      törlésre várás csak ha mindkettő vár.
//   3. A `rev` NEM hitelesít lazítást. Az ingyenes szigorítás is lépteti: egy
//      régóta nem szinkronizált eszköz néhány ingyenes szerkesztéssel felhúzta,
//      és eddig a régi, lazább rekordja egészében nyert (a máshol lecsökkentett
//      keret visszanőtt). A rev ma már csak a fedőnév és az indok frissességét
//      dönti el — azok nem tiltanak.
//
// A doksi: docs/feature-accounts-sync.md

import { normalizeBurst } from '../burst.js';
import { normalizeLimit } from '../limits.js';
import type { Schedule, Band, Weekday } from '../schedule.js';
import { ALWAYS, normalizeSchedule } from '../schedule.js';
import { MAX_RULES_PER_SITE, normalizeRule, sameRule, type UrlRule } from '../urlrules.js';

/**
 * Egy oldal a szinkronban.
 *
 * Ugyanaz, mint a helyi `SiteRec`, két mezővel bővítve: a `rev` a módosítások
 * száma, az `updatedAt` az utolsó módosítás ideje. Ez a kettő adja az
 * összefésülés sorrendjét.
 */
export interface SyncSite {
  id: string;
  domain: string;
  hostnames: string[];
  /**
   * A hosztnevek JELEI: név → a rekord `rev`-je, amelyik a nevet utoljára
   * felvette vagy levette (hogy melyik történt, azt a `hostnames` mondja
   * meg). Az összefésülésnél a nagyobb jel dönt; jel nélkül — régi kliens,
   * vagy az oldal felvételekor kapott nevek — a bővebb lista nyer. Lásd
   * `withHostnames`.
   */
  hostnameMarks?: Record<string, number>;
  addedAt: number;
  pauseUntil: number | null;
  pendingDeleteAt: number | null;
  schedule?: Schedule;
  dailyLimitSeconds?: number;
  /** adag-szabály: ennyi használat után… (a kettő csak együtt értelmes) */
  burstSeconds?: number;
  /** …ennyi szünet. A SZÁMLÁLÓ nem utazik — az eszköz-helyi (shared/burst.ts). */
  cooldownSeconds?: number;
  alias?: string;
  /** indok: miért tiltottad — a nyertes rekorddal jön, mint a fedőnév */
  reason?: string;
  /**
   * Részleges szabályok (`youtube.com/@valaki`).
   *
   * `undefined` és `[]` KÉT KÜLÖNBÖZŐ dolog, és ezen múlik, hogy egy régi
   * kliens le tudja-e törölni a szabályokat. Az `undefined` jelentése: nem
   * tudok erről a mezőről. Az `[]` jelentése: volt, és el lett távolítva.
   * Lásd `mergeRules`.
   */
  rules?: UrlRule[];
  /**
   * A szabálylista JELE: a rekord `rev`-je, amelyik a listát utoljára
   * változtatta. Már csak a RÉGI klienseknek szól (ők ebből fésülnek); az új
   * fésülés a szabályonkénti jeleket nézi, ezt csak továbbviszi. Lásd
   * `mergeRules`.
   */
  rulesRev?: number;
  /**
   * A szabályok JELEI: szabály-kulcs (`hoszt` + `út`) → a rekord `rev`-je,
   * amelyik a szabályt utoljára felvette vagy levette (melyik történt, azt a
   * `rules` mondja: a levett szabály jele sírkő). Szabályonként a nagyobb jel
   * dönt; egyenlőnél (a jel nélküli is ilyen) a jelenlét. A gép a léptetésben
   * írja, az Android a bírónál (felvétel, kifizetett levétel), az iPhone
   * hordozza. Lásd `mergeRules`.
   */
  ruleMarks?: Record<string, number>;
  /**
   * A KIFIZETETT LAZÍTÁSOK száma mezőnként — csak próbatétel után nő (a bíró
   * írja, a teljesítéskor). A fésülésben a több nyer, egyenlőnél a szigorúbb
   * alak. Hiányzó mező = nulla (régi kliens).
   */
  /** a törlés kérése (próbatétel és 24 óra) */
  deleteLoosens?: number;
  /** a menetrend lazítása (`isLoosening`) */
  scheduleLoosens?: number;
  /** a napi keret emelése vagy levétele */
  limitLoosens?: number;
  /** az adag-szabály lazítása: nagyobb adag, rövidebb szünet, levétel */
  burstLoosens?: number;
  /**
   * A BEFEJEZETT törlés jele: annak a törlés-kérésnek a számlálója
   * (`deleteLoosens`), amelyik valahol végigment — a rekord ott eltűnt. A
   * fésülésben a nagyobb marad. A rekord HALOTT (`isGone`), ha ez a kérés még
   * mindig az utolsó, és senki nem vonta vissza: egy régi, a kérést sem látott
   * eszköz rekordja így nem támasztja fel az oldalt. Lásd `mergeSiteLists`.
   */
  goneLoosens?: number;
  /** hányszor módosult ez a rekord; csak nő */
  rev: number;
  /** mikor módosult utoljára (ms) */
  updatedAt: number;
  /** melyik eszköz írta utoljára — a döntetlen eltörésére */
  updatedBy: string;
}

// ------------------------------------------------------------- szigorúság

/*
 * A menetrend SZERKEZET szerint néz, nem időbélyeg szerint. Ez nem szőrözés:
 * az `isBlockedBySchedule` a gép helyi idejét használja, két eszköz pedig
 * lehet más időzónában — akkor ugyanaz a két menetrend máshogy fésülődne a két
 * gépen, és a szinkron sosem konvergálna. A sávok amúgy is helyi-óra
 * percekben vannak megadva, tehát a szerkezeti összevetés az egyetlen, ami
 * mindenhol ugyanazt adja.
 */

/** Az `inAnyBand` szerkezeti párja — ugyanaz az éjfél-átfordulás. */
function anyBandAtGrid(bands: Band[], day: Weekday, minute: number): boolean {
  const prevDay = ((day + 6) % 7) as Weekday;
  for (const b of bands) {
    if (b.endMin > b.startMin) {
      if (b.days.includes(day) && minute >= b.startMin && minute < b.endMin) return true;
    } else {
      if (b.days.includes(day) && minute >= b.startMin) return true;
      if (b.days.includes(prevDay) && minute < b.endMin) return true;
    }
  }
  return false;
}

/** A heti rács: 7×1440 perc, 1 ahol a menetrend tilt — szerkezet szerint (lásd fent). */
function scheduleGrid(s: Schedule | undefined): Uint8Array {
  const sch = normalizeSchedule(s ?? ALWAYS);
  const g = new Uint8Array(7 * 1440);
  if (sch.mode === 'always') return g.fill(1);
  const block = sch.mode === 'scheduled_block';
  for (let day = 0; day < 7; day++) {
    for (let minute = 0; minute < 1440; minute++) {
      if (anyBandAtGrid(sch.bands, day as Weekday, minute) === block) g[day * 1440 + minute] = 1;
    }
  }
  return g;
}

/**
 * Egy rács menetrendként: a tiltott percek napon belüli szakaszai, az azonos
 * szakaszú napok egy sávban — kezdés, aztán vég szerint rendezve. Az éjfélen
 * átnyúló tiltás két sáv (este és hajnal). Ha minden perc tiltva: mindig.
 */
function scheduleFromGrid(g: Uint8Array): Schedule {
  if (g.every((v) => v === 1)) return { mode: 'always', bands: [] };
  const runs = new Map<string, { startMin: number; endMin: number; days: Weekday[] }>();
  for (let day = 0; day < 7; day++) {
    let minute = 0;
    while (minute < 1440) {
      if (g[day * 1440 + minute] !== 1) { minute++; continue; }
      const start = minute;
      while (minute < 1440 && g[day * 1440 + minute] === 1) minute++;
      const key = `${start}/${minute}`;
      const run = runs.get(key) ?? { startMin: start, endMin: minute, days: [] };
      run.days.push(day as Weekday);
      runs.set(key, run);
    }
  }
  const bands = [...runs.values()]
    .sort((x, y) => (x.startMin - y.startMin) || (x.endMin - y.endMin))
    .map((r) => ({ days: r.days, startMin: r.startMin, endMin: r.endMin }));
  return { mode: 'scheduled_block', bands };
}

/**
 * Egy menetrend NYERS kulcsa: a mód és a sávok a tárolt sorrendben; a
 * hiányzó menetrend az üres szöveg. Csak a döntetlen eltörésére — két,
 * ugyanannyit tiltó, de másképp leírt menetrend közül minden eszköz
 * ugyanazt válassza.
 */
function scheduleRawKey(s: Schedule | undefined): string {
  if (s === undefined) return '';
  const bands = (Array.isArray(s.bands) ? s.bands : [])
    .map((b) => `${[...new Set(b.days ?? [])].sort((x, y) => x - y).join(',')}/${b.startMin}/${b.endMin}`).join(';');
  return `${s.mode}|${bands}`;
}

/** A rácsból épített (kanonikus) alakban van-e a menetrend. */
function isGridForm(s: Schedule | undefined, g: Uint8Array): boolean {
  return s !== undefined && scheduleRawKey(s) === scheduleRawKey(scheduleFromGrid(g));
}

/**
 * Két menetrend SZIGORÚBB alakja: minden perc tiltva, amit bármelyik tilt. Ha
 * az egyik lefedi a másikat, változatlanul az marad (nincs újraírás);
 * különben a rácsból épül. Ha a kettő ugyanannyit tilt, a felhasználó saját
 * alakja nyer a rácsból épített ellen (az esti sáv ne essen szét kettőre),
 * két saját alak közül a kisebb nyers kulcsú. Ettől a fésülés sorrendje sem
 * számít: három eszköz bármilyen sorrendben ugyanazt az alakot kapja.
 */
export function joinSchedule(a: Schedule | undefined, b: Schedule | undefined): Schedule | undefined {
  // A gyakori eset: ugyanaz a menetrend mindkét oldalon — nincs mit számolni.
  if (scheduleRawKey(a) === scheduleRawKey(b)) return a;
  const ga = scheduleGrid(a);
  const gb = scheduleGrid(b);
  let aCovers = true;
  let bCovers = true;
  for (let i = 0; i < ga.length; i++) {
    if (gb[i] === 1 && ga[i] !== 1) aCovers = false;
    if (ga[i] === 1 && gb[i] !== 1) bCovers = false;
  }
  if (aCovers && bCovers) {
    const fa = isGridForm(a, ga);
    const fb = isGridForm(b, gb);
    if (fa !== fb) return fa ? b : a;
    return scheduleRawKey(a) <= scheduleRawKey(b) ? a : b;
  }
  if (aCovers) return a;
  if (bCovers) return b;
  const union = new Uint8Array(ga.length);
  for (let i = 0; i < ga.length; i++) union[i] = ga[i] | gb[i];
  return scheduleFromGrid(union);
}

/** A szigorúbb napi keret: a kisebb; a keret nélküli (vagy értelmetlen) a leglazább. */
export function joinLimit(a: number | undefined, b: number | undefined): number | undefined {
  const na = normalizeLimit(a);
  const nb = normalizeLimit(b);
  if (na === null) return nb === null ? undefined : b;
  if (nb === null) return a;
  if (na !== nb) return na < nb ? a : b;
  return Math.min(a as number, b as number);
}

/** Az adag-szabály egy rekordon — a két mező csak együtt értelmes. */
interface BurstPair { burstSeconds?: number; cooldownSeconds?: number }

/**
 * A szigorúbb adag-szabály: a kisebb adag ÉS a hosszabb szünet. Ha az egyik
 * mindkettőben legalább olyan szigorú, változatlanul az marad; a szabály
 * nélküli a leglazább.
 */
export function joinBurst(a: BurstPair, b: BurstPair): BurstPair {
  const na = normalizeBurst(a.burstSeconds, a.cooldownSeconds);
  const nb = normalizeBurst(b.burstSeconds, b.cooldownSeconds);
  if (na === null) return nb === null ? {} : b;
  if (nb === null) return a;
  const aStricter = na.burstSeconds <= nb.burstSeconds && na.cooldownSeconds >= nb.cooldownSeconds;
  const bStricter = nb.burstSeconds <= na.burstSeconds && nb.cooldownSeconds >= na.cooldownSeconds;
  if (aStricter && bStricter) {
    // Ugyanaz a szabály — a nyers alakok közül a kisebb, hogy a döntés ne függjön a sorrendtől.
    const ka = [a.burstSeconds ?? 0, a.cooldownSeconds ?? 0];
    const kb = [b.burstSeconds ?? 0, b.cooldownSeconds ?? 0];
    return ka[0] !== kb[0] ? (ka[0] < kb[0] ? a : b) : (ka[1] <= kb[1] ? a : b);
  }
  if (aStricter) return a;
  if (bStricter) return b;
  return {
    burstSeconds: Math.min(na.burstSeconds, nb.burstSeconds),
    cooldownSeconds: Math.max(na.cooldownSeconds, nb.cooldownSeconds),
  };
}

/** A törlésre várás szigorúbb alakja: csak ha mindkettő vár — akkor a későbbi határidő. */
function joinDelete(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return Math.max(a, b);
}

/** Egy kifizetett-lazítás számláló: csak pozitív egész számít. */
function loosensOf(v: number | undefined): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
}

/**
 * Egy mező a fésülésben: a több kifizetett lazítás nyer (a lazítás mögött ott
 * a munka); egyenlőnél a szigorúbb alak.
 */
function byLoosens<T>(ca: number, cb: number, va: T, vb: T, join: (x: T, y: T) => T): T {
  if (ca !== cb) return ca > cb ? va : vb;
  return join(va, vb);
}

/**
 * A FRISSEBB rekord — `rev`, majd idő, majd eszközazonosító. Már csak a
 * fedőnév és az indok múlik rajta (azok nem tiltanak), meg a hosztnevek
 * és a szabályok jel nélküli döntése.
 */
function newerSite(a: SyncSite, b: SyncSite): SyncSite {
  if (a.rev !== b.rev) return a.rev > b.rev ? a : b;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.updatedBy <= b.updatedBy ? a : b;
}

// ------------------------------------------------------------ összefésülés

/**
 * Két azonos azonosítójú rekord összefésülése — MEZŐNKÉNT (lásd a fájl
 * elejét).
 *
 * A hívónak mindegy, melyik a „helyi” és melyik a „távoli”: a függvény
 * szimmetrikus, tehát minden eszköz ugyanazt kapja. A szünet nem utazik
 * (eszközfüggő); ha mégis érkezne, a rövidebb marad.
 */
export function mergeSite(a: SyncSite, b: SyncSite): SyncSite {
  const newer = newerSite(a, b);
  const ca = { del: loosensOf(a.deleteLoosens), sch: loosensOf(a.scheduleLoosens), lim: loosensOf(a.limitLoosens), bur: loosensOf(a.burstLoosens) };
  const cb = { del: loosensOf(b.deleteLoosens), sch: loosensOf(b.scheduleLoosens), lim: loosensOf(b.limitLoosens), bur: loosensOf(b.burstLoosens) };
  // A törlésre várás nem tűnhet el csendben: a kérése próbatétel (a számláló
  // nő), a visszavonása ingyen — egyenlő számnál a nem váró nyer.
  const pendingDeleteAt = byLoosens(ca.del, cb.del, a.pendingDeleteAt, b.pendingDeleteAt, joinDelete);
  const schedule = byLoosens(ca.sch, cb.sch, a.schedule, b.schedule, joinSchedule);
  const dailyLimitSeconds = byLoosens(ca.lim, cb.lim, a.dailyLimitSeconds, b.dailyLimitSeconds, joinLimit);
  const burst = byLoosens<BurstPair>(ca.bur, cb.bur,
    { burstSeconds: a.burstSeconds, cooldownSeconds: a.cooldownSeconds },
    { burstSeconds: b.burstSeconds, cooldownSeconds: b.cooldownSeconds }, joinBurst);
  const out: SyncSite = {
    ...newer,
    pauseUntil: a.pauseUntil === null || b.pauseUntil === null ? null : Math.min(a.pauseUntil, b.pauseUntil),
    pendingDeleteAt,
    rev: Math.max(a.rev, b.rev),
  };
  if (schedule === undefined) delete out.schedule; else out.schedule = schedule;
  if (dailyLimitSeconds === undefined) delete out.dailyLimitSeconds; else out.dailyLimitSeconds = dailyLimitSeconds;
  if (burst.burstSeconds === undefined) delete out.burstSeconds; else out.burstSeconds = burst.burstSeconds;
  if (burst.cooldownSeconds === undefined) delete out.cooldownSeconds; else out.cooldownSeconds = burst.cooldownSeconds;
  const counts: [keyof SyncSite, number][] = [
    ['deleteLoosens', Math.max(ca.del, cb.del)], ['scheduleLoosens', Math.max(ca.sch, cb.sch)],
    ['limitLoosens', Math.max(ca.lim, cb.lim)], ['burstLoosens', Math.max(ca.bur, cb.bur)],
    ['goneLoosens', Math.max(loosensOf(a.goneLoosens), loosensOf(b.goneLoosens))],
  ];
  for (const [k, v] of counts) {
    if (v > 0) (out as unknown as Record<string, number>)[k] = v;
    else delete (out as unknown as Record<string, unknown>)[k];
  }
  // A hosztnevek nevenként, a jelük szerint; a szabályok a listájuk jele szerint.
  return withHostnames(withRules(out, a, b), a, b);
}

/**
 * A hosztnevek NEVENKÉNT fésülődnek, a jelük szerint.
 *
 * A hosztnév-lista a tiltás része (ezek a nevek mennek a hosts fájlba). Egy
 * név levétele lazítás, ami csak próbatétel után mehet át; egy név felvétele
 * ingyenes szigorítás. Minden ilyen lépés jelet kap: a rekord `rev`-jét,
 * amelyik vitte (`hostnameMarks`). Nevenként a NAGYOBB jel dönt — ami annál
 * áll (benne van vagy nincs), az marad. Egyenlő jelnél (ide tartozik a jel
 * nélküli név is: régi kliens, az oldal felvételekor kapott nevek) a rekord
 * dönt, ahogy eddig: eltérő revnél az újabb rekord állapota, egyenlő revnél a
 * bővebb — versenyhelyzet sosem old fel.
 *
 * Miért nem elég a rekord rev-je. Egyenlő revnél az egyesítés visszahozná a
 * kifizetett levételt, ha a másik eszköz ugyanabban a körben bármi mást írt
 * a rekordra; nagyobb revnél a nyertes rekord egyben vinné a régi listáját,
 * ha kétszer írt. A jel a NÉVHEZ tartozik, nem a rekordhoz — ezért egyik sem
 * történhet meg. Rendezve, hogy két eszköz bájtra ugyanazt kapja. A Kotlin-
 * és Swift-tükör ugyanezt teszi.
 */
function withHostnames(merged: SyncSite, a: SyncSite, b: SyncSite): SyncSite {
  const names = new Set([
    ...a.hostnames, ...b.hostnames,
    ...Object.keys(a.hostnameMarks ?? {}), ...Object.keys(b.hostnameMarks ?? {}),
  ]);
  const hostnames: string[] = [];
  const marks: Record<string, number> = {};
  for (const h of [...names].sort()) {
    const ma = a.hostnameMarks?.[h] ?? 0;
    const mb = b.hostnameMarks?.[h] ?? 0;
    const inA = a.hostnames.includes(h);
    const inB = b.hostnames.includes(h);
    // Egyenlő POZITÍV jelnél a jelenlét nyer (szigorúbb, és a sorrendtől
    // független); jel nélkül a rekord dönt, ahogy eddig.
    const present = ma > mb ? inA : mb > ma ? inB
      : ma > 0 ? (inA || inB)
        : a.rev !== b.rev ? (a.rev > b.rev ? inA : inB) : inA || inB;
    if (present) hostnames.push(h);
    if (Math.max(ma, mb) > 0) marks[h] = Math.max(ma, mb);
  }
  const out: SyncSite = { ...merged, hostnames };
  const capped = capHostnameMarks(marks, hostnames);
  if (capped) out.hostnameMarks = capped;
  else delete out.hostnameMarks;
  return out;
}

/** Ennél több hosztnév-jelet nem hordunk egy oldalon. */
export const MAX_HOSTNAME_MARKS = 64;

/**
 * A jelek plafonja — EGY szabály a fésülésre, a bemenetre és a léptetésre:
 * a jelen lévő nevek jele mindig marad (az oldal névlistája amúgy is
 * korlátos), a levett nevekből a legnagyobb jelűek férnek be. Üresen
 * undefined. A Kotlin- és Swift-tükör ugyanezt teszi.
 */
export function capHostnameMarks(
  marks: Record<string, number>, hostnames: string[],
): Record<string, number> | undefined {
  const entries = Object.entries(marks);
  if (entries.length === 0) return undefined;
  if (entries.length <= MAX_HOSTNAME_MARKS) return { ...marks };
  const present = new Set(hostnames);
  const kept = entries.filter(([h]) => present.has(h));
  const gone = entries.filter(([h]) => !present.has(h))
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  const out: Record<string, number> = {};
  for (const [h, v] of kept) out[h] = v;
  for (const [h, v] of gone) {
    if (Object.keys(out).length >= MAX_HOSTNAME_MARKS) break;
    out[h] = v;
  }
  return out;
}

function withRules(winner: SyncSite, a: SyncSite, b: SyncSite): SyncSite {
  const { rules, marks, mark } = mergeRules(a, b);
  const out: SyncSite = { ...winner };
  if (rules === undefined) delete out.rules; else out.rules = rules;
  if (rules !== undefined && marks && Object.keys(marks).length > 0) out.ruleMarks = marks; else delete out.ruleMarks;
  if (rules !== undefined && mark > 0) out.rulesRev = mark; else delete out.rulesRev;
  return out;
}

/** Egy szabály kulcsa a jelekhez: a kanonikus `hoszt` + `út`. */
export function ruleKey(r: UrlRule): string {
  return `${r.host}${r.path}`;
}

/** Egy jel értéke: csak pozitív egész számít. */
function markOf(v: number | undefined): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
}

/**
 * A részleges szabályok összefésülése — a rekord többi mezőjétől KÜLÖN,
 * SZABÁLYONKÉNT.
 *
 *   1. **A szabály jele dönt.** Minden felvétel és levétel jelet kap: a rekord
 *      rev-jét, amelyik vitte (`ruleMarks`). Szabályonként a nagyobb jelnél
 *      álló állapot (benne van vagy nincs) marad — a kifizetett levétel így
 *      átmegy, és egy régebbi eszköz ingyenes szerkesztése sem hozza vissza.
 *   2. **Egyenlő jelnél a jelenlét** — a jel nélküli szabály is ilyen. Két
 *      eszközön egyszerre felvett két szabály mindkettő megmarad.
 *   3. **A lista-jel (`rulesRev`) már nem dönt.** Eddig az egész lista egy
 *      jellel utazott: egy ingyenes felvétel nagyobb jellel EGÉSZÉBEN vitte a
 *      listáját, és a másik eszközön közben felvett szabály csendben eltűnt;
 *      egyenlő jelnél pedig a rekord rev-je döntött, ami más mezőtől is nő —
 *      három eszköznél a sorrendtől függött, melyik lista marad. A lista-jelet
 *      csak továbbvisszük (a nagyobbat), a régi kliensek abból fésülnek.
 *   4. **A `undefined` NEM ugyanaz, mint az `[]`.** Egy RÉGI app-verzió nem
 *      ismeri ezt a mezőt: ha egyszer átmegy rajta egy rekord, a mező eltűnik
 *      belőle. Ha ezt „minden szabály törölve”-ként értenénk, elég lenne egy
 *      frissítetlen telefon a fiókban, és a gépen felvett összes szabály
 *      csendben eltűnne. Ezért a „nem tudok a mezőről” nem törölhet: olyankor a
 *      másik oldal listája, jelei és lista-jele marad.
 *
 * A plafon: legfeljebb 50 szabály marad (a nagyobb jelűek, egyenlőnél kulcs
 * szerint); a kiesett szabály jele is kiesik — különben a hiánya a jelével
 * együtt kifizetett levételnek látszana. A jelek plafonja a hosztneveké.
 */
function mergeRules(a: SyncSite, b: SyncSite): {
  rules: UrlRule[] | undefined; marks: Record<string, number> | undefined; mark: number;
} {
  const ar = cleanRules(a.rules);
  const br = cleanRules(b.rules);
  if (ar === undefined && br === undefined) return { rules: undefined, marks: undefined, mark: 0 };
  if (ar === undefined) return { rules: br, marks: b.ruleMarks, mark: markOf(b.rulesRev) };
  if (br === undefined) return { rules: ar, marks: a.ruleMarks, mark: markOf(a.rulesRev) };
  const am = a.ruleMarks ?? {};
  const bm = b.ruleMarks ?? {};
  const byKey = new Map<string, UrlRule>();
  for (const r of [...ar, ...br]) byKey.set(ruleKey(r), r);
  const inA = new Set(ar.map(ruleKey));
  const inB = new Set(br.map(ruleKey));
  const marks: Record<string, number> = {};
  const present: string[] = [];
  for (const k of new Set([...byKey.keys(), ...Object.keys(am), ...Object.keys(bm)])) {
    const ma = markOf(am[k]);
    const mb = markOf(bm[k]);
    const here = ma > mb ? inA.has(k) : mb > ma ? inB.has(k) : inA.has(k) || inB.has(k);
    if (Math.max(ma, mb) > 0) marks[k] = Math.max(ma, mb);
    if (here) present.push(k);
  }
  present.sort((x, y) => (markOf(marks[y]) - markOf(marks[x])) || (x < y ? -1 : x > y ? 1 : 0));
  for (const k of present.slice(MAX_RULES_PER_SITE)) delete marks[k];
  const kept = present.slice(0, MAX_RULES_PER_SITE);
  // Stabil sorrend, hogy két eszköz bájtra ugyanazt a listát kapja — különben
  // örökké oda-vissza írnák egymást, mert a tartalom „változott”.
  const rules = kept.map((k) => byKey.get(k)!).sort((x, y) => (ruleKey(x) < ruleKey(y) ? -1 : ruleKey(x) > ruleKey(y) ? 1 : 0));
  return { rules, marks: capHostnameMarks(marks, kept), mark: Math.max(markOf(a.rulesRev), markOf(b.rulesRev)) };
}

/** Szemétszűrés: a szinkronon át érkező szabály ugyanolyan megbízhatatlan, mint bármi más. */
function cleanRules(rules: UrlRule[] | undefined): UrlRule[] | undefined {
  if (rules === undefined || rules === null) return undefined;
  if (!Array.isArray(rules)) return undefined;
  const out: UrlRule[] = [];
  for (const r of rules) {
    if (!r || typeof r.host !== 'string' || typeof r.path !== 'string') continue;
    // Ugyanazon a maganon megy át, mint a kézzel beírt szabály: így a másik
    // eszközről érkező alak nem lehet olyan, amit itt sosem fogadnánk el.
    const norm = normalizeRule(`${r.host}${r.path}`);
    if (!norm) continue;
    if (out.some((x) => sameRule(x, norm))) continue;
    if (out.length >= MAX_RULES_PER_SITE) break;
    out.push(norm);
  }
  return out;
}

/**
 * HALOTT-e a rekord: a törlése végigment valahol (`goneLoosens`), és azóta
 * senki nem vonta vissza (a kérés ugyanaz, és még vár) — és új kérés sem
 * jött. A visszavonás (egyenlő számláló, várakozás nélkül) és az újabb kérés
 * (nagyobb számláló) élő rekordot ad. A halott rekord nem tilt semmit, de
 * UTAZIK: egy régi eszköz rekordja vele fésülődve maga is halott lesz, nem
 * támasztja fel az oldalt.
 */
export function isGone(s: SyncSite): boolean {
  const g = loosensOf(s.goneLoosens);
  return g > 0 && loosensOf(s.deleteLoosens) === g && s.pendingDeleteAt !== null;
}

/** Ennél több halott rekordot nem hordunk: a legutóbb töröltek maradnak. */
export const MAX_GONE_SITES = 64;

/**
 * A végigment törlés SÍRKÖVE: a rekord, a kérés számlálójával megjelölve
 * (`goneLoosens`). Csak kifizetett — számlálós — törlésnek van: a régi,
 * számláló nélküli kérést a fésülés nem tudja megkülönböztetni egy
 * visszavonástól, a sírköve hazudna. A rekord minden mezője marad: ha egy
 * visszavonás feltámasztja, a menetrendje és a kerete ne vesszen el.
 */
export function tombstoneOf(s: SyncSite): SyncSite | null {
  const del = loosensOf(s.deleteLoosens);
  if (del === 0 || s.pendingDeleteAt === null) return null;
  return { ...s, pauseUntil: null, goneLoosens: del };
}

/** Esedékes-e a törlés EZEN az eszközön: vár, és a határideje itt lejárt. */
function isDue(s: SyncSite, now: number): boolean {
  return s.pendingDeleteAt !== null && s.pendingDeleteAt <= now;
}

/**
 * A beérkezett lista előkészítése ezen az eszközön, a fésülés ELŐTT.
 *
 * Ami nincs a helyi tiltólistán (`localIds`), és a törlése itt már esedékes,
 * az ezen az eszközön végrehajtott törlés: kifizetett kérésnél sírkő lesz
 * belőle. Ez a frissítés előtti „zombi” — a végigment törlés, ami a fiókban
 * eddig örökre ott maradt, és minden körben visszajött. Azért a fésülés
 * előtt, mert sírkőként kimarad a domain szerinti összevonásból: egy újra
 * felvett, ugyanolyan domainű oldalt nem visz magával.
 */
export function settleIncoming(incoming: SyncSite[], localIds: ReadonlySet<string>, now: number): SyncSite[] {
  return incoming.map((s) => (localIds.has(s.id) || !isDue(s, now) || isGone(s) ? s : tombstoneOf(s) ?? s));
}

/**
 * A fésült lista szétosztása ezen az eszközön: mi tilt, és mi sírkő.
 *
 * - A HELYI rekord a listán marad, akkor is, ha a fésülés halottnak mondja:
 *   a sorsát a bíró dönti el, ahogy eddig — végrehajtja, vagy zárlat alatt
 *   visszaveszi. Egy eszköz így semmit nem enged el, amit tiltott, csak a
 *   saját bírója kezéből.
 * - Ami még NEM ESEDÉKES itt, az is a listára kerül, akkor is, ha máshol
 *   már végigment: ezen az eszközön a saját órája szerint tilt a határidőig.
 *   Egy előreállított óra így nem viszi szét a korai törlést.
 * - Az esedékes halott a sírkövek közé kerül.
 * - Az esedékes, számlálós, de nem halott rekord a listára (a bíró
 *   végrehajtja); a számláló nélküli — a régi, végigment törlés — egyik
 *   közé sem: nem vesszük át, de a fiókban marad, nem a miénk.
 */
export function splitMerged(
  merged: SyncSite[], localIds: ReadonlySet<string>, now: number,
): { sites: SyncSite[]; gone: SyncSite[] } {
  const sites: SyncSite[] = [];
  const gone: SyncSite[] = [];
  for (const m of merged) {
    if (localIds.has(m.id) || !isDue(m, now)) sites.push(m);
    else if (isGone(m)) gone.push(m);
    else if (loosensOf(m.deleteLoosens) > 0) sites.push(m);
  }
  return { sites, gone };
}

/** A sírkövek sorrendje és plafonja: a legkésőbbi határidejűek maradnak, holtversenyben azonosító szerint. */
export function capGone<T extends { id: string; pendingDeleteAt: number | null }>(gone: T[]): T[] {
  return [...gone]
    .sort((x, y) => (y.pendingDeleteAt ?? 0) - (x.pendingDeleteAt ?? 0) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .slice(0, MAX_GONE_SITES);
}

/**
 * Két lista összefésülése.
 *
 * Ami csak az egyik oldalon van, az bekerül — ez SZIGORÍTÁS, tehát ingyen van,
 * és pont ez az, amiért a szinkron kell: az új eszközön ott legyen minden.
 *
 * Egy oldal csak úgy tűnhet el, hogy a törlési folyamat végigment: a rekord
 * addig ott marad `pendingDeleteAt`-tel. Egy hiányzó rekord tehát SOSEM jelent
 * törlést — különben elég lenne egy üres fiókkal belépni, és a lista eltűnne.
 *
 * A végigment törlés viszont HALOTT rekordként marad a listában (`isGone`):
 * azonosító szerint ugyanúgy fésülődik, mint az élők — ezért egy régi, a
 * kérést sem látott eszköz rekordja vele fésülődve szintén halott lesz, és
 * nem támasztja fel az oldalt. Előbb minden rekord azonosító szerint
 * fésülődik, élő és halott együtt; csak utána dől el, melyik él — azonosítónként
 * így a sorrend nem számít. A domain szerinti összevonás csak az élőkre áll (egy
 * újra felvett oldal ne haljon meg a régi azonosító sírkövétől), és az ÚJABBAN
 * felvett azonosítót tartja meg (`foldInto`). A halottak plafonja
 * `MAX_GONE_SITES` (a legkésőbbi határidejűek). A halott rekord a dróton rendes
 * rekord: egy frissítés előtti kliens végigment törlésnek látja (lejárt
 * határidő), ahogy eddig.
 *
 * KIMONDOTT KORLÁT: az összevonás a beolvasztott azonosítót eldobja. Ahol egy
 * domainre két azonosító szól, és valamelyiknek sírköve van, ott az eredmény
 * attól függhet, hogy a kettő a sírkő előtt vagy után vonódott össze — három
 * eszköz más sorrendben más listára juthat. Ilyenkor is áll, hogy a domain
 * legújabban felvett példányát csak a saját sírköve viheti el; a régebbit
 * viszont, ha addigra beleolvadt, az újabb kifizetett törlése is. Ahol nincs
 * ilyen pár, ott három eszköz bármilyen sorrendben ugyanoda jut. Mindhármat a
 * véletlen-teszt őrzi (`list-fuzz.test.ts`).
 */
export function mergeSiteLists(local: SyncSite[], incoming: SyncSite[]): SyncSite[] {
  const byId = new Map<string, SyncSite>();
  for (const s of local) byId.set(s.id, s);
  for (const s of incoming) {
    const mine = byId.get(s.id);
    byId.set(s.id, mine ? mergeSite(mine, s) : s);
  }
  const gone = capGone([...byId.values()].filter(isGone));
  // Ugyanaz a domain kétszer, két eszközről külön felvéve: egy rekordba
  // fésüljük. Enélkül a hosts fájlban kétszer szerepelne, és a felületen két
  // sorban ugyanaz állna — a felhasználó pedig az egyiket feloldva azt hinné,
  // feloldotta.
  const byDomain = new Map<string, SyncSite>();
  for (const s of [...byId.values()].filter((x) => !isGone(x)).sort(bySortKey)) {
    const mine = byDomain.get(s.domain);
    // A rendezés miatt `s` az újabban felvett: az ő azonosítója marad.
    byDomain.set(s.domain, mine ? foldInto(s, mine) : s);
  }
  return [...[...byDomain.values()].sort(bySortKey), ...gone.sort(bySortKey)];
}

/**
 * Egy MÁSIK azonosítójú, ugyanolyan domainű rekord beolvasztása — a domain
 * szerinti összevonás egy lépése. Az ÚJABBAN felvett azonosító marad (`keep`).
 *
 * Miért az újabb. Az összevont sort csak a megtartott azonosító sírköve
 * viheti el: a beolvasztotté később már nem talál rá. Eddig a régebbi
 * maradt, és egy régi törlés — ami hálózat nélkül ment végig, és csak
 * később ért át — az újra felvett oldalt is magával vitte, ha egy elavult
 * eszköz addigra a kettőt egybe fésülte. Most a legújabban felvett példányt
 * csak a SAJÁT, kifizetett törlése viheti el; azt pedig valaki a felvétele
 * után kérte, vagyis a régebbi felvételek után is. (Az ára: annak az
 * eszköznek, amelyik a régebbit ismerte, a sora az új azonosítót és felvételi
 * időt kapja; ami nála azonosító szerint állt — szünet, adag-számláló, a
 * próbatétel adóssága —, azt a hívó viszi át, lásd `foldedIds`.)
 *
 * A mezők a `mergeSite` szabályával fésülődnek, mintha egy rekord két
 * másolata volna — így a lista fésülése sírkövek nélkül sorrendfüggetlen.
 * A felvétel ideje a megtartotté: a következő összevonás ebből tudja, melyik
 * az újabb. A JEL NÉLKÜLI hosztneveket egyesítjük: azokról a `mergeSite` a
 * frissebb rekord szerint döntene, itt viszont mindkét felvétel nevei
 * tiltanak — az egyesítés a szigorúbb. A Kotlin- és a Swift-tükör ugyanezt
 * teszi.
 */
function foldInto(keep: SyncSite, drop: SyncSite): SyncSite {
  const merged = mergeSite({ ...keep }, { ...drop, id: keep.id });
  const marks = merged.hostnameMarks ?? {};
  const extra = [...keep.hostnames, ...drop.hostnames].filter((h) => !(h in marks));
  return {
    ...merged,
    id: keep.id,
    addedAt: keep.addedAt,
    hostnames: [...new Set([...merged.hostnames, ...extra])].sort(),
  };
}

/**
 * Az összevonás nyoma EZEN az eszközön: melyik helyi azonosító olvadt bele
 * egy másikba (régi → új).
 *
 * Ami a helyi listán állt, a fésült listán viszont nincs, miközben ugyanarra
 * a domainre ott él egy másik azonosító, az beleolvadt (`foldInto`). A sor
 * ugyanaz maradt, csak más azonosítót visel — ezért a hívó ezzel viszi át,
 * ami nála azonosító szerint állt: a kifizetett szünetet, az adag-számlálót,
 * a próbatétel adósságát. Különben az összevonás egy futó hűtést ingyen
 * levenne, egy kifizetett szünetet pedig elvenne. A futó próbatétel NEM
 * megy át: a beolvasztott sor más tartalmú lehet, mint amire a próbatételt
 * kérték. A Kotlin- és a Swift-tükör ugyanezt teszi.
 */
export function foldedIds(
  local: readonly { id: string; domain: string }[], merged: readonly SyncSite[],
): Map<string, string> {
  const ids = new Set(merged.map((s) => s.id));
  const liveByDomain = new Map<string, string>();
  for (const s of merged) if (!isGone(s)) liveByDomain.set(s.domain, s.id);
  const out = new Map<string, string>();
  for (const l of local) {
    const into = liveByDomain.get(l.domain);
    if (!ids.has(l.id) && into !== undefined) out.set(l.id, into);
  }
  return out;
}

/** Stabil sorrend: minden eszközön ugyanaz a lista, ugyanabban a sorrendben. */
function bySortKey(a: SyncSite, b: SyncSite): number {
  if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// HOL NORMALIZÁLÓDIK A FEDŐNÉV — mert itt régen egy nem hívott függvény állt.
//
// Volt itt egy `toSyncSite`, ami feltöltéskor normalizálta volna a fedőnevet.
// Soha senki nem hívta: a segéd kézzel építi a szinkron-rekordot. Egy nem
// hívott függvény a legrosszabb fajta dokumentáció — úgy néz ki, mint a
// szabály, közben nem az.
//
// A szabály valójában két helyen áll, és mindkettő ÉL:
//
//   - MENTÉSKOR, a bejáratnál, MIND A HÁROM platformon: `helper/server.ts`,
//     `ui/AppUi.kt` és `App/ContentView.swift` a felvitt fedőnevet
//     normalizáláson engedi át, tehát a tárolt érték már tiszta;
//   - MEGJELENÍTÉSKOR, minden platformon: `displayName` (TS), `AliasLogic`
//     (Kotlin, Swift) újra normalizál. Ez a hálónk arra, ami mégis kívülről
//     érkezne — a vezérlőkarakterek és a túl hosszú név nem jut a képernyőre.
//
// Ezért nem hiányzik itt semmi. Aki mégis ide nyúlna, előbb nézze meg azt a
// kettőt.
