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

/**
 * Ennél több csomag-jelet nem hordunk; a törölt csomagok legrégebbi jelei
 * esnek ki. A plafon SZÁNDÉKOSAN magas: egy eldobott sírkő feltámaszthatja a
 * csomagot a másik eszközön, tehát a vágás nem lehet mindennapos — 256 jel
 * több mint kétszáz valaha törölt csomagot jelent, a lista maga 30-as.
 */
export const MAX_PACK_MARKS = 256;

/**
 * A jelek plafonja — EGY szabály mindenhol (fésülés, bemenet, léptetés, a
 * három nyelvben): a jelen lévő csomagok jele mindig marad, a törölt
 * csomagokéból a legnagyobb jelűek férnek be, holtversenyben az azonosító
 * szerint. Üresen nincs mező. Ha négy helyen négyféle plafon vágna, 64
 * fölött a gép, a telefon és a kiszolgáló három különböző listát tartana,
 * és minden körben feltöltenének — nem hibás adat, hanem nem konvergáló
 * szinkron. A `capHostnameMarks` párja.
 */
export function capPackMarks(
  marks: Record<string, number>, presentIds: string[],
): Record<string, number> | undefined {
  const entries = Object.entries(marks);
  if (entries.length === 0) return undefined;
  if (entries.length <= MAX_PACK_MARKS) return marks;
  const present = new Set(presentIds);
  const out: Record<string, number> = {};
  for (const [id, v] of entries) if (present.has(id)) out[id] = v;
  const gone = entries.filter(([id]) => !present.has(id))
    .sort((x, y) => (y[1] - x[1]) || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  for (const [id, v] of gone) {
    if (Object.keys(out).length >= MAX_PACK_MARKS) break;
    out[id] = v;
  }
  return out;
}

/**
 * A csomag-jelek kiegyenesítése: csak azonosító → pozitív egész, legfeljebb a
 * blob `rev`-je (a jel annak a blobnak a rev-je, amelyik írta — nagyobb nem
 * lehet, és a fésülés erre épít), a plafonnal (a jelen lévő csomagok jele
 * marad). Üresen nincs mező.
 */
export function cleanPackMarks(
  raw: unknown, presentIds: string[] = [], maxRev = Number.MAX_SAFE_INTEGER,
): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > maxRev) continue;
    out[k] = v;
  }
  return capPackMarks(out, presentIds);
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
  const seenIds: string[] = [];
  for (const p of Array.isArray(o.packs) ? o.packs : []) {
    const n = normalizePack(p);
    if (n && !packs.some((x) => x.id === n.id) && packs.length < MAX_PACKS) packs.push(n);
    const rawId = p && typeof p === 'object' ? (p as { id?: unknown }).id : undefined;
    if (typeof rawId === 'string' && rawId) seenIds.push(rawId);
  }
  // A KIESETT csomag jele is kiesik. Ami a listán volt, de itt nem
  // értelmezhető (vagy a plafon fölött van), az nem törölt csomag: a jele
  // meg a hiánya együtt sírkőnek látszana a fésülésben, és a csomag
  // MINDENHOL törlődne — a gazdája is elveszítené. A valódi törlés jele
  // (nincs ilyen csomag a listán) megmarad.
  // A rev nemnegatív EGÉSZ: egy tört rev-ből a hatásos jel tört jelet írna,
  // amit a visszaolvasás eldob — és a kör sosem érne össze. A Kotlin és a
  // Swift ugyanígy csonkol.
  const rev = Math.max(0, Math.floor(numberOr(o.rev, 0)));
  const rawMarks = cleanPackMarks(o.packMarks, packs.map((p) => p.id), rev);
  const kept = rawMarks && Object.fromEntries(
    Object.entries(rawMarks).filter(([id]) => !seenIds.includes(id) || packs.some((p) => p.id === id)),
  );
  const packMarks = kept && Object.keys(kept).length > 0 ? kept : undefined;
  return {
    packs,
    run: normalizeRun(o.run, packs),
    // A naplót NEM kötjük a csomagokhoz: egy menet naplósora akkor is igaz
    // marad, ha a csomagot azóta törölték. Épp ezért van benne a NÉV is, nem
    // csak az azonosító.
    log: normalizeLog(o.log),
    ...(packMarks ? { packMarks } : {}),
    rev,
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
  const run = mergeRun(local, incoming);
  const { packs, packMarks } = mergePacks(newer, older, run?.packId);
  return {
    packs,
    run,
    // EGYESÍTÉS, nem választás: lásd a `SyncFocus.log` magyarázatát.
    log: mergeLog(local.log, incoming.log),
    ...(packMarks ? { packMarks } : {}),
    rev: Math.max(local.rev, incoming.rev),
    // Az idő a GYŐZTESÉ, nem a nagyobb: így az eredmény kulcsa (rev, idő,
    // eszköz) pontosan az újabb blobé, és három eszköz bármilyen sorrendben
    // ugyanoda jut a jel nélküli csomagokkal is. A nagyobb idő egy olyan
    // blobot állítana elő, ami egyik eszközön sem létezett, és a harmadik
    // eszközzel szemben másképp dőlne el, mint a részei.
    updatedAt: newer.updatedAt,
    // Az eszközazonosító a győztesé: enélkül a döntetlen-eltörés nem lenne
    // stabil, és a két eszköz felváltva írná felül egymást. A bemenet
    // tisztítása garantálja, hogy nem üres — a tükrök is pontosan ezt teszik.
    updatedBy: newer.updatedBy,
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
  newer: SyncFocus, older: SyncFocus, runPackId?: string,
): { packs: FocusPack[]; packMarks: Record<string, number> | undefined } {
  const en = effectiveMarks(newer);
  const eo = effectiveMarks(older);
  const rn = newer.packMarks ?? {};
  const ro = older.packMarks ?? {};
  // A MENET CSOMAGJA ELÖL: a 30-as plafon vágásából sem eshet ki — csomag
  // nélküli menet a vágásból sem születhet.
  const ids = [
    ...(runPackId ? [runPackId] : []),
    ...newer.packs.map((p) => p.id),
    ...older.packs.map((p) => p.id),
    ...Object.keys(en), ...Object.keys(eo),
  ].filter((id, i, all) => all.indexOf(id) === i);
  const chosen: { pack: FocusPack; marked: boolean }[] = [];
  const marks: Record<string, number> = {};
  for (const id of ids) {
    const mn = en[id] ?? 0;
    const mo = eo[id] ?? 0;
    const pn = newer.packs.find((p) => p.id === id);
    const po = older.packs.find((p) => p.id === id);
    // Egyenlő POZITÍV jelnél a jelenlét nyer; két változat közül a VALÓDI
    // jel dönt (a szerkesztés erősebb a menet indításánál — a menet jele
    // csak hatásos), egyenlő valódi jelnél a `preferPack`, ami a két
    // változatból jön, nem a hordozó blobból; jel nélkül az újabb blob.
    let pick: FocusPack | undefined;
    if (mo > mn) pick = po;
    else if (mn > mo) pick = pn;
    else if (mn > 0) {
      if (pn && po) {
        const vn = rn[id] ?? 0;
        const vo = ro[id] ?? 0;
        pick = vn !== vo ? (vn > vo ? pn : po) : preferPack(pn, po);
      } else pick = pn ?? po;
    } else pick = pn;
    if (pick) chosen.push({ pack: pick, marked: id === runPackId || Math.max(mn, mo) > 0 });
    if (Math.max(mn, mo) > 0) marks[id] = Math.max(mn, mo);
  }
  const packs = capPacks(chosen);
  // Ugyanaz a plafon, mint a bemeneten és a léptetésnél — különben a három
  // hely három listát tartana, és sosem érnének össze.
  return { packs, packMarks: capPackMarks(marks, packs.map((p) => p.id)) };
}

/**
 * A csomagok plafonja (30): ha a két lista együtt több, a JELES csomag marad
 * (és a menet csomagja), a jel nélküli esik ki előbb — egy frissen felvett,
 * jeles ablak nem tűnhet el egy régi, jeltelen csomag mögött. A sorrend a
 * fésülésé marad.
 */
function capPacks(chosen: { pack: FocusPack; marked: boolean }[]): FocusPack[] {
  if (chosen.length <= MAX_PACKS) return chosen.map((c) => c.pack);
  const keep = new Set<FocusPack>();
  for (const c of chosen) if (c.marked && keep.size < MAX_PACKS) keep.add(c.pack);
  for (const c of chosen) if (!c.marked && keep.size < MAX_PACKS) keep.add(c.pack);
  return chosen.filter((c) => keep.has(c.pack)).map((c) => c.pack);
}

/**
 * A blob HATÁSOS jelei: a jelei, és a futó menet csomagján legalább a blob
 * `rev`-je.
 *
 * A menet és a csomagja együtt jár. A csomagok és a menet külön dőlnek el,
 * és a kettő össze tud akadni: az egyik eszköz törölte a csomagot (jellel),
 * a másik ugyanabban a körben menetet indított rá. A törlés jele elvinné a
 * csomagot, a menet meg maradna — csomag nélkül, amit a fogadó eldob, a
 * menetet tartó eszközök viszont minden körben újra feltöltenének, mert a
 * kiszolgálón sosem az áll, amit ők látnak. A menet a szigorúbb, tehát a
 * csomagjának maradnia kell; a másik út — a menet dobása — egy ingyenes
 * törléssel állítana le menetet, próbatétel nélkül.
 *
 * Miért JEL, és nem utólagos mentés: a jel a bemenet tulajdonsága, a mentés
 * a köztes eredményé lenne, és három eszköznél a sorrendtől függene, melyik
 * köztes menet mentett meg mit. A jel egyszerű: a sírkő csak akkor nyer a
 * menet csomagja fölött, ha a jele nagyobb a menetes blob `rev`-jénél — de
 * a jel sosem nagyobb a saját blobja `rev`-jénél, tehát ilyenkor a másik blob
 * `rev`-je is nagyobb, és a menet is elveszett volna. Csomag nélküli menet
 * így nem születik. A Kotlin- és Swift-tükör ugyanezt teszi.
 */
function effectiveMarks(f: SyncFocus): Record<string, number> {
  const marks = { ...(f.packMarks ?? {}) };
  if (f.run && f.rev > 0 && f.packs.some((p) => p.id === f.run!.packId)) {
    marks[f.run.packId] = Math.max(marks[f.run.packId] ?? 0, f.rev);
  }
  return marks;
}

/**
 * Egyenlő jelű két változat közül melyik: az ablakos, aztán a szűkebb lista
 * (kevesebb engedett tétel = szigorúbb), végül a tartalom kulcsa szerint.
 * A döntés a két VÁLTOZATBÓL jön, nem a hordozó blobból — így három eszköz
 * bármilyen sorrendben ugyanazt választja. A Kotlin- és Swift-tükör ugyanezt.
 */
function preferPack(x: FocusPack, y: FocusPack): FocusPack {
  const rx = x.recurrence ? 1 : 0;
  const ry = y.recurrence ? 1 : 0;
  if (rx !== ry) return rx > ry ? x : y;
  const nx = x.allowSites.length + x.allowApps.length;
  const ny = y.allowSites.length + y.allowApps.length;
  if (nx !== ny) return nx < ny ? x : y;
  return packOrderKey(x) <= packOrderKey(y) ? x : y;
}

/** A változat kulcsa a sorrendhez — bájtra ugyanez a három nyelvben. */
function packOrderKey(p: FocusPack): string {
  const rec = p.recurrence
    ? `${[...p.recurrence.days].sort((a, b) => a - b).join(',')}/${p.recurrence.startMin}/${p.recurrence.endMin}`
    : '';
  return [
    p.name, String(p.defaultMinutes),
    [...p.allowSites].sort().join(','), [...p.allowApps].sort().join(','), rec,
  ].join('\u0001');
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
  if (a.updatedBy !== b.updatedBy) return a.updatedBy > b.updatedBy ? a : b;
  // AZONOS KULCS, más tartalom. Nem elméleti: egy fésülés után minden eszköz
  // a győztes kulcsát veszi át, a tartalma viszont a saját fésülése — két
  // ilyen blob kulcsa egyezik. Ha itt az első argumentum nyerne, a két eszköz
  // egymást választaná győztesnek, és örökké egymást írná felül. A TARTALOM
  // dönt, ugyanazzal a kulccsal mindhárom nyelvben.
  return contentKey(a) <= contentKey(b) ? a : b;
}

/**
 * A blob tartalmának kulcsa a döntetlenhez — bájtra ugyanez a három nyelvben
 * (csak a csomagok, a menet és a jelek; a napló egyesül, nem dönt).
 */
function contentKey(f: SyncFocus): string {
  const packs = [...f.packs]
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map((p) => `${p.id}\u0001${packOrderKey(p)}`)
    .join('\u0002');
  const run = f.run ? `${f.run.packId}/${f.run.startedAt}/${f.run.endsAt}` : '-';
  const marks = Object.entries(f.packMarks ?? {})
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join(',');
  return `${packs}\u0003${run}\u0003${marks}`;
}

/**
 * A FUTÓ munkamenet összefésülése — a kockázatos fele.
 *
 *   - nagyobb `rev` -> az övé a döntés, akár leállítás is (megcsinálta a
 *     próbatételt);
 *   - azonos `rev` -> a SZIGORÚBB nyer: a futó erősebb a nem futónál, két futó
 *     közül a később végződő; azonos lejáratnál a korábban indult (a
 *     hosszabb), és ha az is egyezik, a kisebb csomagazonosítójú.
 *
 * Így egy régi, „nem fut” állapot visszajátszása nem kapcsol ki semmit, egy
 * hosszabbítás viszont próbatétel nélkül is átmegy — pontosan úgy, ahogy az
 * appban. A döntetlen-lánc teljes rendezés: két azonos lejáratú menet közül
 * nem az nyer, amelyik ELŐBB ért a kiszolgálóra, hanem mindig ugyanaz — így
 * három eszköz bármilyen sorrendben ugyanoda jut (lásd a fuzz-tesztet).
 */
function mergeRun(a: SyncFocus, b: SyncFocus): FocusRun | null {
  if (a.rev !== b.rev) return (a.rev > b.rev ? a : b).run;
  if (!a.run) return b.run;
  if (!b.run) return a.run;
  return stricterRun(a.run, b.run);
}

/** A szigorúbb menet, teljes rendezéssel — döntetlen nincs. */
function stricterRun(x: FocusRun, y: FocusRun): FocusRun {
  if (x.endsAt !== y.endsAt) return x.endsAt > y.endsAt ? x : y;
  if (x.startedAt !== y.startedAt) return x.startedAt < y.startedAt ? x : y;
  return x.packId <= y.packId ? x : y;
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
