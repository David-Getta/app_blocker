// A csatorna-szűrők összefésülése két eszköz között.
//
// MIÉRT KÜLÖN FÁJL. A blokklista (merge.ts) rekordonként egyeztet, a
// munkamenet (focus-merge.ts) egy futó állapotot véd. A csatorna-szűrők
// szerkeszthető beállítás-lista, amin a súrlódást a HELYI kapu (referee)
// tartja — lazítani csak próbatétellel lehet.
//
// GAZDAGÉPENKÉNT, NEM EGYBEN. Eddig az egész lista egyben utazott, és a
// frissebb oldal nyert (`rev`, majd idő, majd eszköz). Csakhogy a `rev`-et az
// ingyenes szigorítás is lépteti (új szűrő, bekapcsolás, csatorna levétele):
// egy friss telepítés vagy egy régóta nem szinkronizált gép néhány ingyenes
// szerkesztéssel felhúzta a számlálóját, és a régi (vagy üres) listája
// mindenhol letörölte a máshol felvett szűrőket — próbatétel nélkül.
//
// Most a gazdagép az azonosság (oldalanként egy szűrő), és gazdagépenként két
// szám utazik: a JEL (annak a blobnak a `rev`-je, amelyik a szűrőt utoljára
// felvette, módosította vagy levette — a levett gazdagépé a sírkő) és a
// KIFIZETETT LAZÍTÁSOK száma (kikapcsolás, új csatorna bekapcsolt szűrőn,
// törlés vagy gazdagép-csere bekapcsoltan — ezekhez próbatétel kellett). A
// fésülés gazdagépenként:
//   - a több kifizetett lazítás nyer, egészében (a kifizetett lazítás átmegy);
//   - egyenlő számnál a SZIGORÚBB: bekapcsolva, ha bárhol be van; az
//     engedélylista a kettő metszete; a bekapcsolt szűrőt egy ingyenes
//     (kikapcsolt szűrőn végzett) törlés nem viszi el.
// Így egy elavult gép ingyenes szerkesztése semmit nem lazíthat a többin.
//
// A doksi: docs/feature-channel-filter.md

import {
  MAX_ALLOW_PER_FILTER, MAX_CHANNEL_FILTERS, isFilterLoosening, normalizeFilterHost, sanitizeFilter,
  type ChannelFilter,
} from '../channels.js';

/** Egy szűrő-azonosító legnagyobb hossza — kívülről jött szöveg. */
const MAX_FILTER_ID_LENGTH = 64;

/**
 * Ennél több gazdagép jelét nem hordjuk: a jelen lévő szűrőké mindig marad,
 * a levettekből (sírkövek) a legfrissebbek.
 */
export const MAX_CHANNEL_MARKS = 64;

/** Gazdagép → szám (jel vagy kifizetett lazítások). */
export type ChannelMarks = Record<string, number>;

export interface SyncChannels {
  filters: ChannelFilter[];
  rev: number;
  updatedAt: number;
  updatedBy: string;
  /**
   * GAZDAGÉPENKÉNT a jel: annak a blobnak a `rev`-je, amelyik az oldal
   * szűrőjét utoljára felvette, módosította vagy levette. Ha jel van, szűrő
   * nincs, az a levétel nyoma (sírkő). Üresen nincs mező.
   */
  marks?: ChannelMarks;
  /**
   * GAZDAGÉPENKÉNT a kifizetett lazítások száma — csak próbatétel után nő
   * (lásd `markChannelChanges`). A fésülésben a több nyer, egészében. Üresen
   * nincs mező.
   */
  loosens?: ChannelMarks;
}

export function emptyChannels(deviceId: string): SyncChannels {
  return { filters: [], rev: 0, updatedAt: 0, updatedBy: deviceId };
}

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Egy gazdagép száma a térképből — csak a SAJÁT, pozitív egész érték számít. */
export function channelMarkOf(marks: ChannelMarks | undefined, host: string): number {
  if (!marks || !Object.prototype.hasOwnProperty.call(marks, host)) return 0;
  const v = marks[host];
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
}

/**
 * A jelek plafonja: a jelen lévő szűrők jele mindig marad, a levettekből a
 * legnagyobb jelűek (holtversenyben kódegység szerint). Üresen undefined.
 */
export function capChannelMarks(marks: Map<string, number>, present: string[]): ChannelMarks | undefined {
  if (marks.size === 0) return undefined;
  const here = new Set(present);
  const kept = [...marks].filter(([h]) => here.has(h));
  const gone = [...marks].filter(([h]) => !here.has(h))
    .sort((x, y) => (y[1] - x[1]) || codeUnitCompare(x[0], y[0]));
  return Object.fromEntries([...kept, ...gone].slice(0, Math.max(kept.length, MAX_CHANNEL_MARKS)));
}

/** A lazítás-számlálók azokra a gazdagépekre, amiknek szűrője vagy jele van. Üresen undefined. */
function keepLoosens(loosens: Map<string, number>, keep: Set<string>): ChannelMarks | undefined {
  const out = [...loosens].filter(([h, v]) => v > 0 && keep.has(h));
  return out.length > 0 ? Object.fromEntries(out) : undefined;
}

/** Egy kívülről jött térkép tisztán: kanonikus gazdagép, pozitív egész, legfeljebb `maxRev`. */
function marksIn(raw: unknown, maxRev: number): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const h of Object.keys(raw)) {
    const v = channelMarkOf(raw as ChannelMarks, h);
    if (v === 0 || v > maxRev || normalizeFilterHost(h) !== h) continue;
    out.set(h, v);
  }
  return out;
}

/**
 * A kívülről (dróton, lemezről) jött jelek és lazítás-számlálók tisztán: a
 * kulcs kanonikus gazdagép, az érték pozitív egész, legfeljebb a blob
 * `rev`-je (egy jelet vagy egy kifizetett lazítást csak léptetés írhat) — a
 * plafonnal. A számláló csak olyan gazdagépé maradhat, aminek szűrője vagy
 * jele van.
 */
export function cleanChannelMarks(
  rawMarks: unknown, rawLoosens: unknown, filters: ChannelFilter[], maxRev: number,
): { marks?: ChannelMarks; loosens?: ChannelMarks } {
  const present = filters.map((f) => f.host);
  const marks = capChannelMarks(marksIn(rawMarks, maxRev), present);
  const loosens = keepLoosens(marksIn(rawLoosens, maxRev), new Set([...present, ...Object.keys(marks ?? {})]));
  return { ...(marks ? { marks } : {}), ...(loosens ? { loosens } : {}) };
}

/**
 * Egy kívülről jött csatorna-blob használható alakja.
 *
 * A szinkronon át érkező JSON ugyanolyan megbízhatatlan, mint bármi más: a
 * rekordokat UGYANAZ a tisztító nézi át, mint a helyi mentést (sanitizeFilter)
 * — ami ott nem menne át, az innen sem jöhet be. Egy rossz rekord kiesik, a
 * blob egésze nem hasal el tőle. Oldalanként egy szűrő, mint a helyi kapunál.
 */
export function normalizeSyncChannels(raw: unknown, fallbackDevice: string): SyncChannels {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<SyncChannels>;
  const filters: ChannelFilter[] = [];
  for (const f of Array.isArray(o.filters) ? o.filters : []) {
    if (!f || typeof f !== 'object') continue;
    const id = typeof (f as ChannelFilter).id === 'string'
      ? (f as ChannelFilter).id.slice(0, MAX_FILTER_ID_LENGTH) : '';
    const clean = sanitizeFilter(f as ChannelFilter);
    if (!id || !clean) continue;
    if (filters.some((x) => x.id === id || x.host === clean.host)) continue;
    filters.push({ id, ...clean });
    if (filters.length >= MAX_CHANNEL_FILTERS) break;
  }
  const rev = numberOr(o.rev, 0);
  return {
    filters,
    rev,
    updatedAt: numberOr(o.updatedAt, 0),
    updatedBy: typeof o.updatedBy === 'string' && o.updatedBy ? o.updatedBy : fallbackDevice,
    ...cleanChannelMarks(o.marks, o.loosens, filters, rev),
  };
}

/** A két engedélylista metszete, kódegység szerint rendezve. */
function intersectAllow(a: string[], b: string[]): string[] {
  const other = new Set(b);
  return [...new Set(a)].filter((k) => other.has(k)).sort(codeUnitCompare);
}

/**
 * A szigorúbb engedélylista két, egyformán érvényes közül: a metszet, ha nem
 * üres. Ha üres, a kettő nem vethető össze (mindkettő enged valamit, amit a
 * másik nem) — és üres engedélylista nem lehet (az az egész oldalt tiltaná,
 * amit senki nem kért): a rövidebb marad, holtversenyben kódegység szerint.
 */
function stricterAllow(a: string[], b: string[]): string[] {
  const both = intersectAllow(a, b);
  if (both.length > 0) return both;
  const sa = [...a].sort(codeUnitCompare);
  const sb = [...b].sort(codeUnitCompare);
  if (sa.length !== sb.length) return sa.length < sb.length ? sa : sb;
  return codeUnitCompare(sa.join('\n'), sb.join('\n')) <= 0 ? sa : sb;
}

/**
 * Ugyanannak az oldalnak két változata, EGYENLŐ kifizetett lazítással — a
 * szigorúbb: bekapcsolva, ha bárhol be van; az engedélylista a metszet. Ha
 * csak az egyik bekapcsolt, a metszet üressége esetén az övé marad: a másik
 * oldal a kikapcsolt szűrőn ingyen bővíthette a listáját, és az nem nyithat
 * meg semmit egy bekapcsolt szűrőn. Ha egyik sincs bekapcsolva, semmit nem
 * tiltanak — a frissebb jelű változat marad.
 */
function combine(a: ChannelFilter, b: ChannelFilter, ma: number, mb: number): ChannelFilter {
  const id = codeUnitCompare(a.id, b.id) <= 0 ? a.id : b.id;
  if (a.enabled && b.enabled) return { id, host: a.host, allow: stricterAllow(a.allow, b.allow), enabled: true };
  if (a.enabled || b.enabled) {
    const on = a.enabled ? a : b;
    const off = a.enabled ? b : a;
    const both = intersectAllow(on.allow, off.allow);
    return { id, host: a.host, allow: both.length > 0 ? both : [...on.allow], enabled: true };
  }
  const allow = ma > mb ? [...a.allow] : mb > ma ? [...b.allow] : stricterAllow(a.allow, b.allow);
  return { id, host: a.host, allow, enabled: false };
}

/**
 * Egy oldal sorsa EGYENLŐ kifizetett lazítás mellett. Ha csak az egyik
 * oldalon van szűrő: a másik vagy nem is tudott róla (felvétel — marad), vagy
 * levette (jel van, szűrő nincs). Egyenlő számlálónál a levétel ingyen volt —
 * tehát az ő példánya kikapcsolt volt —, és egy bekapcsolt szűrőt nem vihet
 * el. Kikapcsolt szűrőnél semmi nem múlik rajta: a frissebb jel dönt.
 */
function mergeHost(
  fa: ChannelFilter | undefined, fb: ChannelFilter | undefined, ma: number, mb: number,
): ChannelFilter | undefined {
  if (fa && fb) return combine(fa, fb, ma, mb);
  const f = fa ?? fb;
  if (!f) return undefined;
  const mine = fa ? ma : mb;
  const other = fa ? mb : ma;
  if (other === 0 || f.enabled) return f;
  return mine >= other ? f : undefined;
}

/**
 * Két csatorna-állapot összefésülése GAZDAGÉPENKÉNT (lásd a fájl elejét).
 *
 * A sorrend a régebbi ígéreté: jel szerint, aztán gazdagép szerint. Ha a
 * kettő együtt több szűrő, mint a plafon, előbb a kikapcsoltak esnek ki (nem
 * tiltanak semmit), aztán a legfrissebbek; a kiesett jele marad. Azonos
 * oldalnál a kisebb azonosító marad; ha egy azonosító két oldalhoz is
 * tartozna, a későbbi `#2`-t kap.
 *
 * A RÉGI KLIENS miatt: ő a frissebb blobot veszi át egészében. Ha a fésült
 * tartalom eltér a bejövőtől, és a bejövő `rev`-je a nagyobb, a fésült eggyel
 * nagyobb `rev`-et kap — különben a régi kliens a saját listáját tartaná meg,
 * és a kettő körönként egymást írná felül.
 */
export function mergeChannels(local: SyncChannels, incoming: SyncChannels): SyncChannels {
  const newer = pickNewer(local, incoming);
  const older = newer === local ? incoming : local;
  const byHostA = new Map(local.filters.map((f) => [f.host, f]));
  const byHostB = new Map(incoming.filters.map((f) => [f.host, f]));
  const hosts = new Set<string>([...byHostA.keys(), ...byHostB.keys()]);
  for (const m of [local.marks, incoming.marks, local.loosens, incoming.loosens]) {
    for (const h of Object.keys(m ?? {})) if (normalizeFilterHost(h) === h) hosts.add(h);
  }
  const present: { f: ChannelFilter; m: number }[] = [];
  const marks = new Map<string, number>();
  const loosens = new Map<string, number>();
  for (const h of [...hosts].sort(codeUnitCompare)) {
    const fa = byHostA.get(h);
    const fb = byHostB.get(h);
    const ma = channelMarkOf(local.marks, h);
    const mb = channelMarkOf(incoming.marks, h);
    const ca = channelMarkOf(local.loosens, h);
    const cb = channelMarkOf(incoming.loosens, h);
    // A több kifizetett lazítás nyer, egészében — a szűrő vagy a levétele.
    const f = ca !== cb ? (ca > cb ? fa : fb) : mergeHost(fa, fb, ma, mb);
    const m = Math.max(ma, mb);
    if (m > 0) marks.set(h, m);
    if (Math.max(ca, cb) > 0) loosens.set(h, Math.max(ca, cb));
    if (f) present.push({ f, m });
  }
  // A plafon: előbb a kikapcsoltak esnek ki, aztán a legfrissebbek.
  const kept = new Set(
    [...present]
      .sort((x, y) => (Number(y.f.enabled) - Number(x.f.enabled)) || (x.m - y.m) || codeUnitCompare(x.f.host, y.f.host))
      .slice(0, MAX_CHANNEL_FILTERS)
      .map((p) => p.f.host),
  );
  const filters: ChannelFilter[] = [];
  const ids = new Set<string>();
  for (const p of present.sort((x, y) => (x.m - y.m) || codeUnitCompare(x.f.host, y.f.host))) {
    if (!kept.has(p.f.host)) continue;
    let id = p.f.id;
    for (let n = 2; ids.has(id); n++) id = `${p.f.id.slice(0, MAX_FILTER_ID_LENGTH - 4)}#${n}`;
    ids.add(id);
    filters.push({ ...p.f, id, allow: p.f.allow.slice(0, MAX_ALLOW_PER_FILTER) });
  }
  const outMarks = capChannelMarks(marks, filters.map((f) => f.host));
  const outLoosens = keepLoosens(loosens, new Set([...filters.map((f) => f.host), ...Object.keys(outMarks ?? {})]));
  const merged: SyncChannels = {
    filters,
    rev: Math.max(local.rev, incoming.rev),
    updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
    // Az eszközazonosító a győztesé — a döntetlen-eltörés stabilitása múlik
    // rajta, mint a munkamenetnél.
    updatedBy: newer.updatedBy || older.updatedBy,
    ...(outMarks ? { marks: outMarks } : {}),
    ...(outLoosens ? { loosens: outLoosens } : {}),
  };
  if (incoming.rev >= local.rev && !sameContent(merged, incoming)) merged.rev = incoming.rev + 1;
  return merged;
}

/**
 * Melyik oldal FRISSEBB. Sorrend: `rev`, majd idő, majd eszközazonosító —
 * már csak az időbélyeg és a szerző múlik rajta, a tartalom nem.
 */
function pickNewer(a: SyncChannels, b: SyncChannels): SyncChannels {
  if (a.rev !== b.rev) return a.rev > b.rev ? a : b;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.updatedBy >= b.updatedBy ? a : b;
}

/**
 * Az ingyenes és a fizetett szerkesztés könyvelése a léptetésben: ami oldal
 * az előző léptetés óta megváltozott (felvétel, módosítás, levétel), az ezt
 * a blob-rev-et kapja jelnek; és ha a változás bekapcsolt szűrőn lazított —
 * kikapcsolás, új csatorna, törlés vagy gazdagép-csere —, a kifizetett
 * lazítások száma eggyel nő. Ilyen változás csak próbatétel után történhet
 * (a kapu, `isFilterLoosening`), tehát a számláló a kifizetett munkát
 * számolja. Az azonosító cseréje nem változás.
 */
export function markChannelChanges(
  marks: ChannelMarks | undefined, loosens: ChannelMarks | undefined,
  prev: ChannelFilter[], next: ChannelFilter[], rev: number,
): { marks?: ChannelMarks; loosens?: ChannelMarks } {
  const m = new Map<string, number>();
  for (const h of Object.keys(marks ?? {})) if (channelMarkOf(marks, h) > 0) m.set(h, channelMarkOf(marks, h));
  const c = new Map<string, number>();
  for (const h of Object.keys(loosens ?? {})) if (channelMarkOf(loosens, h) > 0) c.set(h, channelMarkOf(loosens, h));
  const before = new Map(prev.map((f) => [f.host, f]));
  const after = new Map(next.map((f) => [f.host, f]));
  for (const h of new Set([...before.keys(), ...after.keys()])) {
    const p = before.get(h);
    const n = after.get(h);
    if (sameFilter(p, n)) continue;
    m.set(h, rev);
    if (p && p.enabled && (!n || isFilterLoosening(p, n))) c.set(h, (c.get(h) ?? 0) + 1);
  }
  const present = next.map((f) => f.host);
  const outMarks = capChannelMarks(m, present);
  const outLoosens = keepLoosens(c, new Set([...present, ...Object.keys(outMarks ?? {})]));
  return { ...(outMarks ? { marks: outMarks } : {}), ...(outLoosens ? { loosens: outLoosens } : {}) };
}

/** Ugyanaz-e egy oldal szűrője tartalmilag (bekapcsolás, engedélylista halmazként). */
function sameFilter(a: ChannelFilter | undefined, b: ChannelFilter | undefined): boolean {
  if (!a || !b) return a === b;
  return a.enabled === b.enabled && sortedKey(a.allow) === sortedKey(b.allow);
}

function sortedKey(allow: string[]): string {
  return [...new Set(allow)].sort(codeUnitCompare).join('\n');
}

/** Ugyanaz-e a két állapot (nincs mit feltölteni). */
export function sameChannels(a: SyncChannels, b: SyncChannels): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

/** Ugyanaz-e a két állapot TARTALMA — a `rev` nélkül. */
function sameContent(a: SyncChannels, b: SyncChannels): boolean {
  return JSON.stringify(stable(a, false)) === JSON.stringify(stable(b, false));
}

function stable(c: SyncChannels, withRev = true): unknown {
  const entries = (m: ChannelMarks | undefined) => Object.keys(m ?? {}).sort(codeUnitCompare)
    .map((h) => [h, channelMarkOf(m, h)]);
  return {
    filters: [...c.filters]
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .map((f) => ({
        id: f.id,
        host: f.host,
        // Az engedélylista HALMAZ, nem sorrend: rendezve hasonlítjuk, hogy egy
        // átrendeződés ne látsszon változásnak, és ne induljon tőle feltöltés.
        allow: [...f.allow].sort().slice(0, MAX_ALLOW_PER_FILTER),
        enabled: f.enabled,
      })),
    // A jelek és a számlálók is: egy levétel nyoma nélkül a levétel sosem érne át.
    marks: entries(c.marks),
    loosens: entries(c.loosens),
    ...(withRev ? { rev: c.rev } : {}),
  };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
