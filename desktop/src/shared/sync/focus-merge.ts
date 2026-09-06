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
  /**
   * A csomagok JELEI: csomag-azonosító → a blob `rev`-je, amelyik a csomagot
   * utoljára felvette, szerkesztette vagy törölte (a törölt csomag jele
   * marad, a csomag nincs a listán). Csomagonként a nagyobb jel dönt; jel
   * nélkül az újabb blob — ahogy eddig. Lásd `mergePacks`.
   */
  packMarks?: Record<string, number>;
  rev: number;
  updatedAt: number;
  updatedBy: string;
}

/** Ennél több csomag-jelet nem hordunk; a törölt csomagok legrégebbi jelei esnek ki. */
export const MAX_PACK_MARKS = 64;

/** A csomag-jelek kiegyenesítése: csak azonosító → pozitív egész; üresen nincs mező. */
export function cleanPackMarks(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || typeof v !== 'number' || !Number.isInteger(v) || v <= 0) continue;
    out[k] = v;
    if (Object.keys(out).length >= MAX_PACK_MARKS) break;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  const packMarks = cleanPackMarks(o.packMarks);
  return {
    packs,
    run: normalizeRun(o.run, packs),
    // A naplót NEM kötjük a csomagokhoz: egy menet naplósora akkor is igaz
    // marad, ha a csomagot azóta törölték. Épp ezért van benne a NÉV is, nem
    // csak az azonosító.
    log: normalizeLog(o.log),
    ...(packMarks ? { packMarks } : {}),
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

/**
 * Két változat UGYANARRÓL a menetről — melyik marad.
 *
 * TELJES rendezés kell, nem „elég jó”: ha a végén marad döntetlen, a válasz a
 * hívás sorrendjétől függ, az pedig a két eszközön szükségszerűen más. Onnantól
 * ugyanazt a menetet másképp sorosítják, a `sameFocus` örökre „különbözőt”
 * mond, és minden körben feltöltenek — nem hibás adat, hanem NEM KONVERGÁLÓ
 * szinkron.
 *
 * A tervezett vég is holtverseny lehet, és ez nem elméleti: az egyik eszköz még
 * a hosszabbítás előtti tervet ismerte, a másik már a hosszabbítottat. Ilyenkor
 * a KÉSŐBBI terv marad, mert az a frissebb tudás.
 */
function better(x: FocusLogEntry, y: FocusLogEntry): FocusLogEntry {
  if (x.endedAt !== y.endedAt) return x.endedAt < y.endedAt ? x : y;
  if (x.stopped !== y.stopped) return x.stopped ? x : y;
  if (x.plannedEndsAt !== y.plannedEndsAt) return x.plannedEndsAt > y.plannedEndsAt ? x : y;
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
    // A `startedAt` a HARMADIK kulcs, és nem díszítés: a `packId` + `startedAt`
    // pár egyedi, tehát ettől lesz a rendezés TELJES. Enélkül két azonos időben
    // végződő, azonos csomagú sor sorrendje a bemenet sorrendjétől függne — az
    // meg a két eszközön más, és a szinkron sosem konvergálna.
    .sort((p, q) => (p.endedAt - q.endedAt)
      || (p.packId < q.packId ? -1 : p.packId > q.packId ? 1 : 0)
      || (p.startedAt - q.startedAt))
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
  const { packs, packMarks } = mergePacks(newer, older);
  return {
    packs,
    run: mergeRun(local, incoming),
    // EGYESÍTÉS, nem választás: lásd a `SyncFocus.log` magyarázatát.
    log: mergeLog(local.log, incoming.log),
    ...(packMarks ? { packMarks } : {}),
    rev: Math.max(local.rev, incoming.rev),
    updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
    // Az eszközazonosító a győztesé: enélkül a döntetlen-eltörés nem lenne
    // stabil, és a két eszköz felváltva írná felül egymást.
    updatedBy: newer.updatedBy || older.updatedBy,
  };
}

/**
 * A csomagok CSOMAGONKÉNT fésülődnek, a jelük szerint.
 *
 * A csomag jele a blob `rev`-je, amelyik utoljára felvette, szerkesztette
 * vagy törölte. Csomagonként a NAGYOBB jel dönt — ami annál áll (ez a
 * változat, vagy nincs), az marad. Egyenlő jelnél (a jel nélküli csomag is
 * ilyen: régi kliens) az újabb blob állapota, ahogy eddig. A sorrend az
 * újabb blobé, a csak a régebbin élő csomagok a végére.
 *
 * Miért kell. A csomaglista egy blobban utazik, és a blob `rev`-jét a
 * telefon egy menet indításával is lépteti. Ha a gépen most vettél fel egy
 * ablakot, és a telefon ugyanabban a körben — a régi listával — elindított
 * egy menetet, azonos rev és frissebb idő mellett a telefon listája nyert,
 * és az ablak csendben eltűnt. A jel a CSOMAGHOZ tartozik, nem a blobhoz.
 * A telefonok jelet nem írnak, csak hordozzák és fésülik. A Kotlin- és
 * Swift-tükör ugyanezt teszi.
 */
function mergePacks(
  newer: SyncFocus, older: SyncFocus,
): { packs: FocusPack[]; packMarks: Record<string, number> | undefined } {
  const nm = newer.packMarks ?? {};
  const om = older.packMarks ?? {};
  const ids = [
    ...newer.packs.map((p) => p.id),
    ...older.packs.map((p) => p.id),
    ...Object.keys(nm), ...Object.keys(om),
  ].filter((id, i, all) => all.indexOf(id) === i);
  const packs: FocusPack[] = [];
  const marks: Record<string, number> = {};
  for (const id of ids) {
    const mn = nm[id] ?? 0;
    const mo = om[id] ?? 0;
    const pn = newer.packs.find((p) => p.id === id);
    const po = older.packs.find((p) => p.id === id);
    const chosen = mo > mn ? po : pn;
    if (chosen && packs.length < MAX_PACKS) packs.push(chosen);
    if (Math.max(mn, mo) > 0) marks[id] = Math.max(mn, mo);
  }
  return { packs, packMarks: Object.keys(marks).length > 0 ? marks : undefined };
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
        // Az ismétlődés is beállítás: ha kimaradna, egy gépen felvett ablak
        // sosem érne fel, mert a kör azt látná, hogy „nincs mit feltölteni”.
        recurrence: p.recurrence
          ? [[...p.recurrence.days].sort(), p.recurrence.startMin, p.recurrence.endMin] : null,
      })),
    run: f.run ? { packId: f.run.packId, startedAt: f.run.startedAt, endsAt: f.run.endsAt } : null,
    // A NAPLÓ IS BENNE VAN — enélkül egy telefonon lezárult menet sosem érne
    // fel a kiszolgálóra: a kör azt látná, hogy „nincs mit feltölteni”.
    //
    // Ez NEM ugyanaz, mint a `rev` lenyomata (`revisions.ts`), és a kettőt nem
    // szabad összevonni: ez azt méri, van-e mit FELTÖLTENI, az meg azt, hogy
    // ki DÖNTHET. Egy naplósor az elsőre igen, a másodikra nem.
    log: f.log.map((e) => [e.packId, e.startedAt, e.endedAt, e.plannedEndsAt, e.stopped]),
    // A jelek is: ha csak ők különböznek (egy régi kliens blobja jel nélkül),
    // akkor is fel kell menniük.
    packMarks: f.packMarks ? Object.entries(f.packMarks).sort() : null,
    rev: f.rev,
  };
}
