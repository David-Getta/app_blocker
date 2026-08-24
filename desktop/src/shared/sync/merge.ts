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

import type { Schedule, Band, Weekday } from '../schedule.js';
import { ALWAYS, normalizeSchedule } from '../schedule.js';
import { normalizeAlias } from '../alias.js';

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
  addedAt: number;
  pauseUntil: number | null;
  pendingDeleteAt: number | null;
  schedule?: Schedule;
  dailyLimitSeconds?: number;
  alias?: string;
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
    return carryPendingDelete(newer, older);
  }

  // Egyenlő rev: senki nem „újabb”. Ilyenkor a szigorúbb nyer — egy
  // versenyhelyzet sosem oldhat fel semmit.
  const strict = compareStrictness(a, b);
  if (strict !== 0) return carryPendingDelete(strict < 0 ? a : b, strict < 0 ? b : a);

  // Teljesen egyforma szigorúság: a döntetlent az idő, majd az eszközazonosító
  // töri el, hogy determinisztikus legyen. (A fedőnév és a hosztnevek térhetnek
  // el; ezek nem befolyásolják a blokkolást.)
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.updatedBy <= b.updatedBy ? a : b;
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

/**
 * Egy helyi rekordból szinkron-rekord.
 *
 * A fedőnevet itt is normalizáljuk: a szinkronon át érkező adat ugyanolyan
 * megbízhatatlan, mint bármi más, ami kívülről jön.
 */
export function toSyncSite(
  site: Omit<SyncSite, 'rev' | 'updatedAt' | 'updatedBy'>,
  rev: number, updatedAt: number, updatedBy: string,
): SyncSite {
  return {
    ...site,
    alias: normalizeAlias(site.alias),
    rev, updatedAt, updatedBy,
  };
}
