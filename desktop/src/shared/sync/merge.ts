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
// A gyakorlatban:
//
//   1. Alap: utolsó író nyer (`rev`, majd `updatedAt`, majd eszközazonosító).
//      A döntetlent azért az azonosító töri el, hogy MINDEN eszköz ugyanarra az
//      eredményre jusson — enélkül két gép örökké oda-vissza írná egymást.
//   2. Egyenlő `rev` esetén a SZIGORÚBB nyer. Két eszköz egyszerre módosít, az
//      egyik szigorít, a másik lazít: a szigorúbb marad.
//   3. Lazítást csak NAGYOBB `rev` hozhat. A `rev` csak akkor nő, ha valaki
//      ténylegesen végigcsinálta a próbatételt. Egy régi, lazább rekord —
//      hálózati késés, órabaki, visszajátszás — nem lazíthat.
//
// A doksi: docs/feature-accounts-sync.md

import { normalizeBurst } from '../burst.js';
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
  /**
   * Részleges szabályok (`youtube.com/@valaki`).
   *
   * `undefined` és `[]` KÉT KÜLÖNBÖZŐ dolog, és ezen múlik, hogy egy régi
   * kliens le tudja-e törölni a szabályokat. Az `undefined` jelentése: nem
   * tudok erről a mezőről. Az `[]` jelentése: volt, és el lett távolítva.
   * Lásd `mergeRules`.
   */
  rules?: UrlRule[];
  /** hányszor módosult ez a rekord; csak nő */
  rev: number;
  /** mikor módosult utoljára (ms) */
  updatedAt: number;
  /** melyik eszköz írta utoljára — a döntetlen eltörésére */
  updatedBy: string;
}

// ------------------------------------------------------------- szigorúság

/**
 * Blokkol-e a menetrend a hét adott percében.
 *
 * SZERKEZET szerint néz, nem időbélyeg szerint. Ez nem szőrözés: az
 * `isBlockedBySchedule` a gép helyi idejét használja, két eszköz pedig lehet más
 * időzónában — akkor ugyanaz a két menetrend máshogy hasonlítana össze a két
 * gépen, és a szinkron sosem konvergálna. A sávok amúgy is helyi-óra percekben
 * vannak megadva, tehát a szerkezeti összevetés az egyetlen, ami mindenhol
 * ugyanazt adja.
 */
function blocksAtGrid(s: Schedule, day: Weekday, minute: number): boolean {
  const sch = normalizeSchedule(s);
  if (sch.mode === 'always') return true;
  const inBand = anyBandAtGrid(sch.bands, day, minute);
  return sch.mode === 'scheduled_block' ? inBand : !inBand;
}

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

const minutesCache = new Map<string, number>();

/**
 * Hány percet tilt a menetrend egy héten (0..10080).
 *
 * Ez a menetrendek RENDEZÉSE: több tiltott perc = szigorúbb. Két olyan
 * menetrend, amelyik egymáshoz képest se nem szigorúbb, se nem lazább (az egyik
 * délelőtt tilt, a másik délután), így is összehasonlítható marad, és minden
 * eszköz ugyanazt a számot kapja.
 */
export function blockedMinutesPerWeek(s: Schedule | undefined): number {
  const sch = normalizeSchedule(s ?? ALWAYS);
  if (sch.mode === 'always') return 7 * 1440;
  // 10 080 kiértékelés menetrendenként. Egy összefésülés kettőt kér, egy lista
  // sok rekordot — a gyorsítótár nélkül ez percenként milliós nagyságrend lenne
  // a semmiért, hiszen ugyanaz a néhány menetrend ismétlődik.
  const key = JSON.stringify(sch);
  const hit = minutesCache.get(key);
  if (hit !== undefined) return hit;
  let n = 0;
  for (let day = 0; day < 7; day++) {
    for (let minute = 0; minute < 1440; minute++) {
      if (blocksAtGrid(sch, day as Weekday, minute)) n++;
    }
  }
  minutesCache.set(key, n);
  return n;
}

/** A napi keret „szigorúsága”: kisebb keret szigorúbb, keret nélkül a leglazább. */
function limitRank(seconds: number | undefined): number {
  return seconds === undefined ? Number.POSITIVE_INFINITY : seconds;
}

/**
 * Melyik oldal-rekord szigorúbb: -1 = `a`, 1 = `b`, 0 = egyforma.
 *
 * Mezőnként dönt, és a mezők sorrendje számít: ami többet tilt, az előbbre való.
 */
export function compareStrictness(a: SyncSite, b: SyncSite): number {
  // Törlésre várás: aki nem vár törlésre, az szigorúbb (a másik el fog tűnni).
  const aDel = a.pendingDeleteAt !== null;
  const bDel = b.pendingDeleteAt !== null;
  if (aDel !== bDel) return aDel ? 1 : -1;

  // Szünet: a korábban lejáró szigorúbb; a szünet nélküli a legszigorúbb.
  const aPause = a.pauseUntil ?? 0;
  const bPause = b.pauseUntil ?? 0;
  if (aPause !== bPause) return aPause < bPause ? -1 : 1;

  // Menetrend: több tiltott perc = szigorúbb.
  const aMin = blockedMinutesPerWeek(a.schedule);
  const bMin = blockedMinutesPerWeek(b.schedule);
  if (aMin !== bMin) return aMin > bMin ? -1 : 1;

  // Napi keret: kisebb = szigorúbb.
  const aLim = limitRank(a.dailyLimitSeconds);
  const bLim = limitRank(b.dailyLimitSeconds);
  if (aLim !== bLim) return aLim < bLim ? -1 : 1;

  // Adag-szabály: kisebb adag szigorúbb; azonos adagnál a hosszabb szünet.
  // A szabály nélküli rekord a legmegengedőbb — mint a keretnél.
  const aBurst = limitRank(normalizeBurst(a.burstSeconds, a.cooldownSeconds)?.burstSeconds);
  const bBurst = limitRank(normalizeBurst(b.burstSeconds, b.cooldownSeconds)?.burstSeconds);
  if (aBurst !== bBurst) return aBurst < bBurst ? -1 : 1;
  const aCool = normalizeBurst(a.burstSeconds, a.cooldownSeconds)?.cooldownSeconds ?? 0;
  const bCool = normalizeBurst(b.burstSeconds, b.cooldownSeconds)?.cooldownSeconds ?? 0;
  if (aCool !== bCool) return aCool > bCool ? -1 : 1;

  return 0;
}

// ------------------------------------------------------------ összefésülés

/**
 * Két azonos azonosítójú rekord összefésülése.
 *
 * A hívónak mindegy, melyik a „helyi” és melyik a „távoli”: a függvény
 * szimmetrikus, tehát minden eszköz ugyanazt kapja.
 */
export function mergeSite(a: SyncSite, b: SyncSite): SyncSite {
  if (a.rev !== b.rev) {
    const newer = a.rev > b.rev ? a : b;
    const older = a.rev > b.rev ? b : a;
    // Nagyobb rev: a változtatás mögött ott a munka (próbatétel), tehát lazítás
    // is átmehet. A törlésre várást viszont NEM ejtjük el csendben: lásd lent.
    // A hosztnevek itt is nevenként, a jelük szerint fésülődnek: a régebbi
    // rekord kifizetett levétele vagy ingyenes felvétele sem veszhet el attól,
    // hogy a másik eszköz közben kétszer írt ugyanarra a rekordra.
    return withHostnames(withRules(carryPendingDelete(newer, older), newer, older), a, b);
  }

  // Egyenlő rev: senki nem „újabb”. Ilyenkor a szigorúbb nyer — egy
  // versenyhelyzet sosem oldhat fel semmit.
  const strict = compareStrictness(a, b);
  if (strict !== 0) {
    return withHostnames(withRules(carryPendingDelete(strict < 0 ? a : b, strict < 0 ? b : a), a, b), a, b);
  }

  // Teljesen egyforma szigorúság: a döntetlent az idő, majd az eszközazonosító
  // töri el, hogy determinisztikus legyen. (A fedőnév térhet el; a hosztnevek
  // egyesülnek — lásd withHostnames.)
  const winner = a.updatedAt !== b.updatedAt
    ? (a.updatedAt > b.updatedAt ? a : b)
    : (a.updatedBy <= b.updatedBy ? a : b);
  return withHostnames(withRules(winner, a, b), a, b);
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
    const present = ma > mb ? inA : mb > ma ? inB
      : a.rev !== b.rev ? (a.rev > b.rev ? inA : inB) : inA || inB;
    if (present) hostnames.push(h);
    if (Math.max(ma, mb) > 0) marks[h] = Math.max(ma, mb);
  }
  const out: SyncSite = { ...merged, hostnames };
  if (Object.keys(marks).length > 0) out.hostnameMarks = marks;
  else delete out.hostnameMarks;
  return out;
}

function withRules(winner: SyncSite, a: SyncSite, b: SyncSite): SyncSite {
  const rules = mergeRules(a, b);
  if (rules === undefined) {
    if (winner.rules === undefined) return winner;
    const { rules: _drop, ...rest } = winner;
    return rest;
  }
  return { ...winner, rules };
}

/**
 * A részleges szabályok összefésülése — a rekord többi mezőjétől KÜLÖN.
 *
 * Miért nem elég a nyertes rekord szabálylistája:
 *
 *   1. **Egyenlő revnél EGYESÍTÜNK.** A szabály tisztán hozzáadás: egy szabály
 *      felvétele szigorítás. Ha ilyenkor egy egész listát választanánk, két
 *      eszközön egyszerre felvett két szabályból az egyik némán elveszne — a
 *      felhasználó pedig azt hinné, hogy felvette.
 *   2. **Nagyobb rev nyer** — ott van mögötte a próbatétel, tehát az eltávolítás
 *      is átmegy. Egyesítés itt feltámasztaná a kifizetett törlést.
 *   3. **A `undefined` NEM ugyanaz, mint az `[]`.** Egy RÉGI app-verzió nem
 *      ismeri ezt a mezőt: ha egyszer átmegy rajta egy rekord, a mező eltűnik
 *      belőle. Ha ezt „minden szabály törölve”-ként értenénk, elég lenne egy
 *      frissítetlen telefon a fiókban, és a gépen felvett összes szabály
 *      csendben eltűnne. Ezért a „nem tudok a mezőről” nem törölhet: olyankor a
 *      másik oldal listája marad.
 */
function mergeRules(a: SyncSite, b: SyncSite): UrlRule[] | undefined {
  const ar = cleanRules(a.rules);
  const br = cleanRules(b.rules);
  if (ar === undefined) return br;
  if (br === undefined) return ar;
  if (a.rev === b.rev) return unionRules(ar, br);
  return a.rev > b.rev ? ar : br;
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

function unionRules(a: UrlRule[], b: UrlRule[]): UrlRule[] {
  const out = [...a];
  for (const r of b) {
    if (out.some((x) => sameRule(x, r))) continue;
    if (out.length >= MAX_RULES_PER_SITE) break;
    out.push(r);
  }
  // Stabil sorrend, hogy két eszköz bájtra ugyanazt a listát kapja — különben
  // örökké oda-vissza írnák egymást, mert a tartalom „változott”.
  return out.sort((x, y) => (x.host + x.path < y.host + y.path ? -1 : 1));
}

/**
 * A törlésre várás nem tűnhet el csendben.
 *
 * Ha az egyik eszközön elindult a törlés (végigcsinált próbatételek + 24 óra),
 * a másik eszköz nem dobhatja el csak azért, mert a saját rekordja frissebb: az
 * a munkát törölné el. Viszont a türelmi idő MEGMARAD — a másik eszközön is
 * ugyanaddig a határidőig blokkol az oldal, és ott is visszavonható. A
 * visszavonás szigorítás, tehát ingyen van.
 *
 * Csak akkor NEM visszük át, ha a nyertes rekord egy KÉSŐBBI körben szüntette
 * meg (nagyobb rev, és nála már nincs törlésre várás → valaki visszavonta).
 */
function carryPendingDelete(winner: SyncSite, loser: SyncSite): SyncSite {
  if (loser.pendingDeleteAt === null) return winner;
  if (winner.pendingDeleteAt !== null) {
    // Mindkettő törlésre vár: a korábbi határidő az erősebb (az van előrébb a
    // folyamatban), de a rekord többi mezője a nyertesé marad.
    const at = Math.min(winner.pendingDeleteAt, loser.pendingDeleteAt);
    return at === winner.pendingDeleteAt ? winner : { ...winner, pendingDeleteAt: at };
  }
  if (winner.rev > loser.rev) return winner; // visszavonták egy későbbi körben
  return { ...winner, pendingDeleteAt: loser.pendingDeleteAt };
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
 */
export function mergeSiteLists(local: SyncSite[], incoming: SyncSite[]): SyncSite[] {
  const byId = new Map<string, SyncSite>();
  for (const s of local) byId.set(s.id, s);
  for (const s of incoming) {
    const mine = byId.get(s.id);
    byId.set(s.id, mine ? mergeSite(mine, s) : s);
  }
  // Ugyanaz a domain kétszer, két eszközről külön felvéve: egy rekordba
  // fésüljük. Enélkül a hosts fájlban kétszer szerepelne, és a felületen két
  // sorban ugyanaz állna — a felhasználó pedig az egyiket feloldva azt hinné,
  // feloldotta.
  const byDomain = new Map<string, SyncSite>();
  for (const s of [...byId.values()].sort(bySortKey)) {
    const mine = byDomain.get(s.domain);
    if (!mine) { byDomain.set(s.domain, s); continue; }
    // A régebben felvett azonosítót tartjuk meg: arra hivatkozhat egy futó
    // próbatétel a másik eszközön.
    const keep = mine.addedAt <= s.addedAt ? mine : s;
    const drop = keep === mine ? s : mine;
    byDomain.set(s.domain, {
      ...mergeSite({ ...keep }, { ...drop, id: keep.id }),
      id: keep.id,
      addedAt: Math.min(keep.addedAt, drop.addedAt),
      // A hosztneveket EGYESÍTJÜK, nem választunk: ha az egyik eszközön a
      // társoldalak is fel voltak véve, a másikon meg nem, akkor az egyesítés
      // a szigorúbb — és pont az kell.
      hostnames: [...new Set([...keep.hostnames, ...drop.hostnames])].sort(),
    });
  }
  return [...byDomain.values()].sort(bySortKey);
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
