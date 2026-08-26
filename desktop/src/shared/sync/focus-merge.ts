// A munkamenet összefésülése két eszköz között.
//
// MIÉRT KÜLÖN FÁJL. A blokklista összefésülése (merge.ts) LISTÁT egyeztet,
// rekordonként. A munkamenetnél két nagyon különböző dolog utazik együtt:
//
//   - a CSOMAGOK: szerkeszthető beállítás, olyan, mint a blokklista;
//   - a FUTÓ munkamenet: EGY állapot, ami épp most tilt mindent.
//
// A kettőnek más a helyes összefésülése, és ha egy fájlban lennének, a kettő
// szabálya összekeveredne. A futó munkameneté a kockázatos: ott dől el, hogy a
// szinkron ki tudja-e kapcsolni azt, amit a felhasználó próbatétellel indított.
//
// A SZABÁLY UGYANAZ, MINT MINDENHOL:
//
//   szigorítás ingyen van, lazítás munkába kerül.
//
// A munkamenetnél a szigorítás iránya:
//
//   - INDÍTANI és HOSSZABBÍTANI szigorítás  -> azonos `rev` mellett is nyer;
//   - RÖVIDÍTENI és LEÁLLÍTANI lazítás      -> csak NAGYOBB `rev`-vel nyer.
//
// A `rev` csak akkor nő, ha valaki ténylegesen végigcsinálta a próbatételt.
// Enélkül a leállítás így nézne ki: a telefonon van egy régi, „nem fut”
// állapot, feltölti, és a gépen próbatétel nélkül eltűnik a munkamenet. Két
// eszköz és egy jól időzített szinkron elég lenne a kibúvóhoz.
//
// A doksi: docs/feature-focus-sessions.md

import {
  MAX_ALLOW_ENTRIES, MAX_FOCUS_LOG, normalizePack,
  type FocusLogEntry, type FocusPack, type FocusRun,
} from '../focus.js';

/** Legfeljebb ennyi csomag utazhat — a felületen sem fér ki több. */
export const MAX_PACKS = 30;

/**
 * A munkamenet a szinkronban.
 *
 * A `rev`/`updatedAt`/`updatedBy` hármas ugyanaz, mint a blokklistánál: a `rev`
 * a döntő, döntetlennél az idő, végül az eszközazonosító — hogy MINDEN eszköz
 * ugyanarra az eredményre jusson, különben két gép örökké oda-vissza írná
 * egymást.
 */
export interface SyncFocus {
  packs: FocusPack[];
  /** a futó munkamenet, vagy null, ha nem fut */
  run: FocusRun | null;
  /**
   * A LEZÁRULT menetek naplója — ebből lesz a statisztika.
   *
   * Szándékosan MÁS a szabálya, mint a fenti kettőnek, és ez nem
   * következetlenség. A csomagok és a futás ENGEDÉLYEK: azt mondják meg, mi
   * történhet, tehát rájuk vonatkozik a súrlódás iránya, és a `rev` őrzi őket.
   * A napló a MÚLT feljegyzése: nem enged meg semmit, nem old fel semmit, és
   * egy elveszett sora nem kibúvó, csak pontatlan statisztika.
   *
   * Ezért a napló EGYESÍTÉS, nem döntés: minden eszköz sora bekerül, és a
   * `rev`-hez semmi köze. Aki később egységesíteni akarja a hármat, ezt a
   * bekezdést olvassa el előbb: a `rev` léptetése egy naplósorért azt
   * jelentené, hogy egy statisztika-bejegyzés le tud állítani egy futó
   * menetet a másik eszközön.
   */
  log: FocusLogEntry[];
  rev: number;
  updatedAt: number;
  updatedBy: string;
}

export function emptyFocus(deviceId: string): SyncFocus {
  return { packs: [], run: null, log: [], rev: 0, updatedAt: 0, updatedBy: deviceId };
}

/**
 * Egy kívülről jött munkamenet-blob használható alakja.
 *
 * Kívülről jött adat: a szinkronon át érkező JSON ugyanolyan megbízhatatlan,
 * mint bármi más. Ami nem értelmezhető, az kiesik — de a blob EGÉSZE nem
 * hasalhat el egyetlen rossz csomagtól, mert akkor egy elrontott sor a futó
 * munkamenetet is eltüntetné.
 */
export function normalizeSyncFocus(raw: unknown, fallbackDevice: string): SyncFocus {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<SyncFocus>;
  const packs: FocusPack[] = [];
  for (const p of Array.isArray(o.packs) ? o.packs : []) {
    const n = normalizePack(p);
    if (n && !packs.some((x) => x.id === n.id) && packs.length < MAX_PACKS) packs.push(n);
  }
  return {
    packs,
    run: normalizeRun(o.run, packs),
    // A naplót NEM kötjük a csomagokhoz: egy menet naplósora akkor is igaz
    // marad, ha a csomagot azóta törölték. Épp ezért van benne a NÉV is, nem
    // csak az azonosító.
    log: normalizeLog(o.log),
    rev: numberOr(o.rev, 0),
    updatedAt: numberOr(o.updatedAt, 0),
    updatedBy: typeof o.updatedBy === 'string' && o.updatedBy ? o.updatedBy : fallbackDevice,
  };
}

/**
 * A futó munkamenet megtisztítása.
 *
 * Ha a csomagja nincs meg, a futás ÉRTELMEZHETETLEN: nem tudnánk megmondani,
 * mi mehet alatta. Ilyenkor nem tippelünk — a fehérlista tartalma nem az a
 * dolog, amit kitalálni szabad —, hanem eldobjuk a futást.
 */
function normalizeRun(raw: unknown, packs: FocusPack[]): FocusRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<FocusRun>;
  if (typeof r.packId !== 'string' || !packs.some((p) => p.id === r.packId)) return null;
  const startedAt = numberOr(r.startedAt, 0);
  const endsAt = numberOr(r.endsAt, 0);
  if (endsAt <= 0) return null;
  return { packId: r.packId, startedAt, endsAt };
}

/**
 * Kívülről jött naplósorok használható alakja.
 *
 * Ami nem értelmezhető, az kiesik — egyesével, nem az egész napló. Egy rossz
 * sor miatt elveszíteni a többit ugyanaz a hiba lenne, mint egy rossz csomag
 * miatt eldobni a futó menetet.
 */
function normalizeLog(raw: unknown): FocusLogEntry[] {
  const out: FocusLogEntry[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const e = normalizeLogEntry(item);
    if (e) out.push(e);
  }
  return capLog(out);
}

export function normalizeLogEntry(raw: unknown): FocusLogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Partial<FocusLogEntry>;
  if (typeof e.packId !== 'string' || !e.packId) return null;
  const endedAt = numberOr(e.endedAt, 0);
  if (endedAt <= 0) return null;
  const startedAt = numberOr(e.startedAt, 0);
  return {
    packId: e.packId,
    packName: typeof e.packName === 'string' && e.packName
      ? e.packName.slice(0, MAX_PACK_NAME_IN_LOG) : 'Ismeretlen csomag',
    startedAt,
    endedAt,
    plannedEndsAt: numberOr(e.plannedEndsAt, endedAt),
    stopped: e.stopped === true,
  };
}

/** A naplóban tárolt névnek is van felső határa — kívülről jött szöveg. */
const MAX_PACK_NAME_IN_LOG = 40;

/**
 * Két napló egyesítése.
 *
 * A sor AZONOSSÁGA a `packId` + `startedAt` pár. Egyszerre egy menet fut az
 * egész fiókban, tehát ez a pár egyértelmű — és pont ezért fésülődik össze
 * helyesen az a gyakori eset, amikor UGYANAZT a menetet két eszköz is lezárja:
 * a telefon próbatétellel, a gép meg később, a szinkronból véve észre.
 *
 * Ütközésnél a KORÁBBI vég nyer, mert az van közelebb a valósághoz: a menet
 * akkor ért véget, amikor véget ért, nem akkor, amikor a másik eszköz észbe
 * kapott. Azonos végnél a próbatételes leállítás nyer — azt az egyik oldal
 * láthatta, a másik nem.
 */
export function mergeLog(a: FocusLogEntry[], b: FocusLogEntry[]): FocusLogEntry[] {
  const byKey = new Map<string, FocusLogEntry>();
  for (const e of [...a, ...b]) {
    const key = `${e.packId}|${e.startedAt}`;
    const prev = byKey.get(key);
    byKey.set(key, prev ? better(prev, e) : e);
  }
  return capLog([...byKey.values()]);
}

function better(x: FocusLogEntry, y: FocusLogEntry): FocusLogEntry {
  if (x.endedAt !== y.endedAt) return x.endedAt < y.endedAt ? x : y;
  if (x.stopped !== y.stopped) return x.stopped ? x : y;
  return x;
}

/**
 * Idősorrend, és a LEGÚJABBAK maradnak.
 *
 * A statisztika a mai napot és a hetet nézi; ha valamit el kell dobni, az a
 * legrégebbi sor. Fordítva a mai menetek esnének ki, és a képernyő, amit a
 * felhasználó néz, pont az lenne üres.
 */
function capLog(rows: FocusLogEntry[]): FocusLogEntry[] {
  return rows
    .sort((p, q) => (p.endedAt - q.endedAt) || (p.packId < q.packId ? -1 : 1))
    .slice(-MAX_FOCUS_LOG);
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Két munkamenet-állapot összefésülése.
 *
 * A csomagok és a futás KÜLÖN dőlnek el, mert más a szabályuk:
 *
 *   - a csomagoknál az utolsó író nyer (ez beállítás, nem tiltás — egy régi
 *     lista visszatérése bosszantó, de nem kibúvó);
 *   - a futásnál a SZIGORÚBB nyer, és lazítani csak nagyobb `rev` tud.
 */
export function mergeFocus(local: SyncFocus, incoming: SyncFocus): SyncFocus {
  const newer = pickNewer(local, incoming);
  const older = newer === local ? incoming : local;
  return {
    packs: newer.packs,
    run: mergeRun(local, incoming),
    // EGYESÍTÉS, nem választás: lásd a `SyncFocus.log` magyarázatát.
    log: mergeLog(local.log, incoming.log),
    rev: Math.max(local.rev, incoming.rev),
    updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
    // Az eszközazonosító a győztesé: enélkül a döntetlen-eltörés nem lenne
    // stabil, és a két eszköz felváltva írná felül egymást.
    updatedBy: newer.updatedBy || older.updatedBy,
  };
}

/**
 * Melyik oldal FRISSEBB. Sorrend: `rev`, majd idő, majd eszközazonosító.
 *
 * Az azonosító nem esztétika: ez teszi a döntést determinisztikussá. Enélkül
 * két eszköz ugyanabban a másodpercben írva örökké oda-vissza cserélgetné a
 * listát, és mindkettő azt látná, hogy „a másik elrontja”.
 */
function pickNewer(a: SyncFocus, b: SyncFocus): SyncFocus {
  if (a.rev !== b.rev) return a.rev > b.rev ? a : b;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.updatedBy >= b.updatedBy ? a : b;
}

/**
 * A FUTÓ munkamenet összefésülése — a kockázatos fele.
 *
 *   - nagyobb `rev` -> az övé a döntés, akár leállítás is (megcsinálta a
 *     próbatételt);
 *   - azonos `rev` -> a SZIGORÚBB nyer: a futó erősebb a nem futónál, két futó
 *     közül a később végződő.
 *
 * Így egy régi, „nem fut” állapot visszajátszása nem kapcsol ki semmit, egy
 * hosszabbítás viszont próbatétel nélkül is átmegy — pontosan úgy, ahogy az
 * appban.
 */
function mergeRun(a: SyncFocus, b: SyncFocus): FocusRun | null {
  if (a.rev !== b.rev) return (a.rev > b.rev ? a : b).run;
  if (!a.run) return b.run;
  if (!b.run) return a.run;
  return a.run.endsAt >= b.run.endsAt ? a.run : b.run;
}

/** Ugyanaz-e a két állapot (nincs mit feltölteni). */
export function sameFocus(a: SyncFocus, b: SyncFocus): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function stable(f: SyncFocus): unknown {
  return {
    packs: [...f.packs]
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .map((p) => ({
        id: p.id,
        name: p.name,
        allowSites: [...p.allowSites].sort().slice(0, MAX_ALLOW_ENTRIES),
        allowApps: [...p.allowApps].sort().slice(0, MAX_ALLOW_ENTRIES),
        defaultMinutes: p.defaultMinutes,
      })),
    run: f.run ? { packId: f.run.packId, startedAt: f.run.startedAt, endsAt: f.run.endsAt } : null,
    // A NAPLÓ IS BENNE VAN — enélkül egy telefonon lezárult menet sosem érne
    // fel a kiszolgálóra: a kör azt látná, hogy „nincs mit feltölteni”.
    //
    // Ez NEM ugyanaz, mint a `rev` lenyomata (`revisions.ts`), és a kettőt nem
    // szabad összevonni: ez azt méri, van-e mit FELTÖLTENI, az meg azt, hogy
    // ki DÖNTHET. Egy naplósor az elsőre igen, a másodikra nem.
    log: f.log.map((e) => [e.packId, e.startedAt, e.endedAt, e.plannedEndsAt, e.stopped]),
    rev: f.rev,
  };
}
