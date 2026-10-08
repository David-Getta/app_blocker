// Zárlat: az az időszak, amikor a lazítás nem drága, hanem NEM LÉTEZIK.
//
// MIÉRT KELL. Eddig minden lazításnak volt ára — próbatétel —, de ára volt,
// tehát útja is. Aki hajnali kettőkor elhatározza, hogy átrágja magát rajta,
// az átrágja magát rajta; a nehezebb feladat csak drágítja az utat, nem zárja
// le. A zárlat az a válasz, ami tényleg lezárja: amíg tart, a segéd EL SEM
// INDÍT próbatételt lazításra. Nincs mit teljesíteni, nincs mit megpróbálni.
//
// MIT NEM CSINÁL. Nem lakatolja le a gépet, és nem is állítjuk, hogy
// megtenné: rendszergazdaként a segéd leállítható, az app letörölhető. A
// zárlat az APPON BELÜL zár le mindent — az impulzus ellen véd, nem a
// megfontolt, tíz perces kerülőút ellen. Ezt a felület is kimondja.
//
// AZ IRÁNY. Zárlatot indítani ingyen van, HOSSZABBÍTANI is ingyen van.
// Rövidíteni, visszavonni, kivételt tenni sehogy sem lehet — se gombbal, se
// próbatétellel. Ez az egyetlen művelet az egész appban, aminek nincs
// visszaútja, és pont ettől ér valamit.
//
// Tiszta és függőség nélküli, mint a megosztott mag többi része; a Kotlin és a
// Swift tükrözi. Lásd docs/feature-lockdown.md.

import { inAnyBand, isLoosening, isValidBand, type Band, type Weekday } from './schedule.js';
import {
  MAX_WINDOW_OCCURRENCES, nextOccurrence, occurrenceAt, occurrencesAhead, WINDOW_LOOKAHEAD_DAYS, type Occurrence,
} from './focus.js';

/** Egy zárlat legfeljebb ennyi lehet. Ami ennél hosszabb, az már nem döntés. */
export const MAX_LOCKDOWN_DAYS = 30;
export const MAX_LOCKDOWN_MS = MAX_LOCKDOWN_DAYS * 24 * 3600_000;

/** A felület gyorsgombjai, percben. A leghosszabb szándékosan egy hét. */
export const LOCKDOWN_CHOICES_MIN = [60, 180, 8 * 60, 24 * 60, 3 * 24 * 60, 7 * 24 * 60];

/**
 * A futó zárlat.
 *
 * A `startedAt` nem dísz: ebből látszik a felületen, hogy mennyi telt el és
 * mennyi van hátra — egy puszta határidő mellett a hosszú zárlat első napja
 * ugyanúgy néz ki, mint az utolsó.
 */
export interface Lockdown {
  /** mikortól tart (epoch ms) */
  startedAt: number;
  /** meddig tart (epoch ms) */
  until: number;
}

/** Tart-e most zárlat. */
export function isLocked(l: Lockdown | null | undefined, now: number): boolean {
  return !!l && Number.isFinite(l.until) && l.until > now;
}

/**
 * Csak az ÉLŐ zárlat — a lejárt nincs.
 *
 * A szinkron határán kell: a lejárt zárlatot a helyi oldal nem viszi fel, a
 * kiszolgálóról jövőt viszont a fésülés hűen átvenné, és a kettő minden
 * körben különbözne — a segéd minden tíz percben „változást” látna, mentene
 * és újraírná a hosts fájlt, örökké. Ha mindkét oldalon csak az élő számít,
 * a kettő ugyanazt látja, és a kör megnyugszik.
 */
export function liveLockdown(l: Lockdown | null | undefined, now: number): Lockdown | undefined {
  return isLocked(l, now) ? l! : undefined;
}

/** Mennyi van még hátra, ms-ben. Nulla, ha nincs zárlat. */
export function lockdownRemainingMs(l: Lockdown | null | undefined, now: number): number {
  return isLocked(l, now) ? l!.until - now : 0;
}

/**
 * Zárlat indítása vagy hosszabbítása `ms` időre MOSTTÓL.
 *
 * Az eredmény SOSEM rövidebb a mostaninál: ez a függvény az egyetlen út a
 * mezőhöz, és így a rövidítés nem elfelejtett ellenőrzés kérdése, hanem
 * megfogalmazhatatlan. Ha a kért idő rövidebb, mint ami már fut, a futó marad
 * — a hívó nem hibázott, csak nem ért el vele semmit.
 *
 * Az értelmetlen hossz (nem szám, nulla, negatív) null-t ad: nem indul zárlat.
 */
export function startLockdown(
  cur: Lockdown | null | undefined, ms: number, now: number,
): Lockdown | null {
  if (!Number.isFinite(ms) || ms <= 0 || !Number.isFinite(now)) return cur ?? null;
  const want = now + Math.min(Math.round(ms), MAX_LOCKDOWN_MS);
  if (isLocked(cur, now)) {
    return want > cur!.until ? { startedAt: cur!.startedAt, until: want } : cur!;
  }
  return { startedAt: now, until: want };
}

/**
 * Két eszköz zárlata EGGYÉ fésülve: a KÉSŐBBI vég nyer.
 *
 * Nem versenyhelyzet-feloldás, hanem maga a szabály: a zárlat szigorítás,
 * tehát a szinkron sosem viheti vissza. Egy hálózat nélküli gép nem tud
 * feloldani semmit azzal, hogy a régi állapotát tolja fel; a másik eszközön
 * indított zárlat pedig percek múlva itt is él.
 */
export function mergeLockdown(
  a: Lockdown | null | undefined, b: Lockdown | null | undefined,
): Lockdown | null {
  if (!a) return b ?? null;
  if (!b) return a;
  if (b.until > a.until) return b;
  if (a.until > b.until) return a;
  // Azonos vég: a korábbi kezdés az igaz — az mutatja a teljes hosszt.
  return a.startedAt <= b.startedAt ? a : b;
}

/**
 * A dróton érkezett zárlat beolvasása. Minden mező gyanús: másik eszköz írta.
 *
 * Ami nem értelmes, az nincs — egy hibás rekord nem indíthat harminc napos
 * zárlatot, és nem is takarhat el egy futót.
 */
export function parseLockdown(raw: unknown): Lockdown | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const until = typeof o.until === 'number' ? o.until : NaN;
  const startedAt = typeof o.startedAt === 'number' ? o.startedAt : NaN;
  if (!Number.isFinite(until) || until <= 0) return null;
  const start = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : until;
  return { startedAt: Math.min(start, until), until };
}

/**
 * Magyar, olvasható hátralévő idő: „6 nap 3 óra”, „2 ó 15 p”, „4 perc”.
 *
 * A zárlat hossza napokban is mérhető, ezért nem a percre pontos alak kell —
 * aki hét napot zárt le, annak a másodpercek csak nézegetnivalót adnának.
 */
export function formatLockdownRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days} nap ${hours} óra` : `${days} nap`;
  if (hours > 0) return mins > 0 ? `${hours} ó ${mins} p` : `${hours} óra`;
  return `${Math.max(1, mins)} perc`;
}

// ------------------------------------------------------------- ZÁRLAT-ABLAK
//
// Heti ablak, amiben a zárlat MAGÁTÓL él: például hétköznap 9-től 17-ig.
// Ugyanaz az alak, mint a csomag heti ablaka — napok, kezdés, vég —, csak
// nem egy csomag indul tőle, hanem a zárlat. Az ablak nem új érvényesítés,
// hanem egy időzítő a meglévő elé: a kör az ablak végéig szóló zárlatot
// indít, és onnantól minden ugyanaz (kapu, sáv, szinkron, tiltó lap).
// Lásd docs/feature-lockdown-windows.md.

/** Ennél több ablak nem fér ki — és nem is kell: hét nap van. */
export const MAX_LOCKDOWN_WINDOWS = 7;
/**
 * Legalább ennyi szabad perc kell a héten az ablakok mellett. Enélkül az
 * ablakot sosem lehetne levenni (bent zárlat van, és zárlat alatt nem indul
 * próbatétel) — az nem döntés lenne, hanem csapda.
 */
export const MIN_FREE_MINUTES_PER_WEEK = 60;
/** Ennyivel a heti ablak beérése előtt szólunk egyszer — ami nyitva van, mentsd el. */
export const WINDOW_PRE_WARN_MS = 10 * 60_000;
/** Az ablak azonosítója legfeljebb ennyi karakter — kívülről jött szöveg. */
const MAX_WINDOW_ID = 40;

/**
 * Egy zárlat-ablak. A mezők a `Band`-éi (a menetrendé és a csomag ablakáé),
 * KIÍRVA, nem örökölve: a drót-nevek őre (scripts/check-wire-names.js) a
 * deklarációt keresi ebben a fájlban, és egy örökölt mezőt nem találna meg.
 */
export interface LockdownWindow {
  id: string;
  days: Weekday[];
  /** helyi perc éjféltől, 0..1439 */
  startMin: number;
  /** helyi perc éjféltől, 1..1440; ha <= startMin, éjfélen átnyúlik */
  endMin: number;
}

/** Az ablak tartalmi kulcsa: napok (rendezve), kezdés, vég. */
export function windowKey(w: Band): string {
  return `${[...w.days].sort((a, b) => a - b).join(',')}/${w.startMin}/${w.endMin}`;
}

/** Egy kívülről jött ablak használható alakja, vagy undefined. */
/** A dróton jött szám — csak ha valóban JSON-szám; különben NaN (érvénytelen). */
function numberOnly(v: unknown): number {
  return typeof v === 'number' ? v : NaN;
}

export function normalizeWindow(raw: unknown): LockdownWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const w = raw as Partial<LockdownWindow>;
  if (typeof w.id !== 'string' || !w.id || w.id.length > MAX_WINDOW_ID) return undefined;
  const rawDays: unknown[] = Array.isArray(w.days) ? w.days : [];
  const days = [...new Set(rawDays.filter((d): d is Weekday =>
    typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6))].sort((x, y) => x - y);
  // Csak JSON-szám: a `Number()` a „540” szöveget, a `null`-t (0) és az igazat
  // (1) is percnek vette volna — a két telefon dekódolója nem.
  const band: Band = { days, startMin: numberOnly(w.startMin), endMin: numberOnly(w.endMin) };
  if (!isValidBand(band)) return undefined;
  return { id: w.id, ...band };
}

/**
 * Egy lista használható alakja: csak érvényes ablakok, azonosító és tartalom
 * szerint is egyszer, legfeljebb a plafonig. Az azonosító szerinti duplát az
 * első nyeri; az azonos tartalmút szintén — két azonos ablak nem két ablak.
 */
export function normalizeWindows(raw: unknown): LockdownWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: LockdownWindow[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const item of raw) {
    const w = normalizeWindow(item);
    if (!w || ids.has(w.id) || keys.has(windowKey(w))) continue;
    if (out.length >= MAX_LOCKDOWN_WINDOWS) break;
    ids.add(w.id);
    keys.add(windowKey(w));
    out.push(w);
  }
  return out;
}

/** Ugyanaz-e a két lista tartalmilag (azonosító nem számít — a tartalom dönt). */
export function sameWindows(a: Band[], b: Band[]): boolean {
  const ka = a.map(windowKey).sort().join('|');
  const kb = b.map(windowKey).sort().join('|');
  return ka === kb;
}

/**
 * Marad-e szabad idő a héten az ablakok mellett — percenkénti mintavétellel,
 * ugyanúgy, ahogy a menetrend lazítás-vizsgálata jár.
 */
export function weekHasFreeTime(windows: Band[], now: number): boolean {
  if (windows.length === 0) return true;
  const STEP = 60_000;
  const SAMPLES = 7 * 24 * 60;
  let free = 0;
  for (let i = 0; i < SAMPLES; i++) {
    if (!inAnyBand(windows, now + i * STEP)) {
      free++;
      if (free >= MIN_FREE_MINUTES_PER_WEEK) return true;
    }
  }
  return false;
}

/**
 * LAZÍTÁS-e a lista cseréje: van-e olyan perc a következő héten, amikor a
 * régi lista zárlatot tartana, az új nem. A levétel mindig az; a felvétel
 * sosem. Az üres lista külön eset: a menetrend normalizálója az üres
 * sávlistát „mindig tiltva”-ként érti, ami itt pont a fordítottja lenne.
 */
export function isWindowsLoosening(current: Band[], next: Band[], now: number): boolean {
  if (current.length === 0) return false;
  if (next.length === 0) return true;
  return isLoosening(
    { mode: 'scheduled_block', bands: current },
    { mode: 'scheduled_block', bands: next },
    now,
  );
}

/**
 * Az ÉLŐ ablak MOSTANI előfordulása — vagy null. Több élő ablak közül a
 * legkésőbb végződő: a zárlat addig szól, ameddig bármelyik ablak tart.
 */
export function dueLockdownWindow(windows: Band[], now: number): Occurrence | null {
  let best: Occurrence | null = null;
  for (const w of windows) {
    if (!isValidBand(w)) continue;
    const occ = occurrenceAt(w, now);
    if (!occ) continue;
    if (!best || occ.endsAt > best.endsAt
      || (occ.endsAt === best.endsAt && occ.startsAt < best.startsAt)) best = occ;
  }
  return best;
}

/**
 * A zárlat, amit az ablakok MOST megkövetelnek — vagy null, ha a meglévő
 * elég (nincs élő ablak, vagy a futó zárlat vége az ablak végénél nem
 * korábbi). A kör ezt írja az állapotba; a kapu ezt nézi a kör előtt is.
 *
 * A kezdés az ablak kezdése, ha nem futott zárlat — így két eszköz, ami más
 * másodpercben ér a körhöz, UGYANAZT a zárlatot állítja elő, és a szinkron
 * a kettőt egynek látja. Futó zárlat mellett a kezdés a futóé marad: az
 * ablak csak a végét tolja ki, mint a kézi hosszabbítás.
 */
export function windowLockdown(
  cur: Lockdown | null | undefined, windows: Band[], now: number,
): Lockdown | null {
  const occ = dueLockdownWindow(windows, now);
  if (!occ) return null;
  if (isLocked(cur, now) && cur!.until >= occ.endsAt) return null;
  return { startedAt: isLocked(cur, now) ? cur!.startedAt : occ.startsAt, until: occ.endsAt };
}

/**
 * Ablak-zárlat-e ez: a vége pontosan egy ablak-előfordulás vége. Az ilyet
 * az óra-ugrás elnyelése nem tolja el — az ablak vége az ablak vége, mint
 * az ablak-menetnél; a laptop alvása nem hosszabbítja a hétköznapot. A
 * kézzel meghosszabbított már nem az; a kézi zárlat tolódik.
 *
 * A VÉG dönt, nem a kezdés, mert a kezdés nem az ablaké: egy ablak előtt
 * indított kézi zárlatot az ablak csak kitol, és a kezdése a kézié marad;
 * két egymásba érő ablakból a második az elsőét tolja ki. Mindkettő az
 * ablak ígérete, és mindkettő vége egy ablak vége. Amelyik kézi zárlat
 * véletlenül épp egy ablak végén ér véget, az is az ablak szabálya alá
 * esik — az ablak nélkül is pont eddig tartana a zárlat, tehát ez nem
 * nyit semmit.
 */
export function isWindowLockdown(l: Lockdown, windows: Band[]): boolean {
  for (const w of windows) {
    if (!isValidBand(w)) continue;
    // Egy ezredmásodperccel a vég előtt még az ablakban vagyunk — ha ez a
    // vég az ablak vége. A vég perce már nincs benne, ezért nem a vég maga.
    const occ = occurrenceAt(w, l.until - 1);
    if (occ && occ.endsAt === l.until) return true;
  }
  return false;
}

/**
 * Most tűnt-e fel egy ABLAK szerinti zárlat — a felület ebből értesít. Akkor
 * is, ha az app később nyílt meg, mint ahogy az ablak beért: aki nem maga
 * indította, tudja meg, miért van minden zárva. Ugyanaz a zárlat kétszer nem
 * szól; a kézzel indított nem szól, azt a felhasználó indította. A kézi
 * zárlat, amit az ablak kitolt, szól: onnantól az ablak tartja.
 */
export function windowLockdownStarted(
  prev: Lockdown | null | undefined, next: Lockdown | null | undefined,
  windows: Band[], now: number,
): Lockdown | null {
  if (!next || !isLocked(next, now)) return null;
  if (prev && prev.startedAt === next.startedAt && prev.until === next.until) return null;
  return isWindowLockdown(next, windows) ? next : null;
}

/** Ennél több ablak-jelet nem hordunk: a jelen lévőké mindig marad, a levettekből a legfrissebbek. */
export const MAX_WINDOW_MARKS = 64;

/**
 * Az ablak-jelek: TARTALMI kulcs (`windowKey`) → a blob rev-je, amelyik az
 * ilyen tartalmú ablakot utoljára felvette vagy levette. A tartalom az
 * azonosság, nem az azonosító: a módosítás a régi tartalom levétele és az új
 * felvétele — a kettő külön jelet kap.
 */
export type WindowMarks = Record<string, number>;

/** Az ablakok egy eszközön: a lista és a tartalmi kulcsonkénti jelek. */
export interface WindowSet {
  lockdownWindows?: LockdownWindow[];
  lockdownWindowMarks?: WindowMarks;
}

const WINDOW_KEY = /^([0-6](?:,[0-6])*)\/(\d{1,4})\/(\d{1,4})$/;

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Kanonikus tartalmi kulcs-e: érvényes sáv, a napok szigorúan növekvő sorrendben, vezető nulla nélkül. */
export function isWindowKey(k: string): boolean {
  const m = WINDOW_KEY.exec(k);
  if (!m) return false;
  const days = m[1].split(',').map(Number);
  for (let i = 1; i < days.length; i++) if (days[i] <= days[i - 1]) return false;
  const band: Band = { days: days as Weekday[], startMin: Number(m[2]), endMin: Number(m[3]) };
  return isValidBand(band) && windowKey(band) === k;
}

/** Egy ablak-jel a térképből — csak a SAJÁT, pozitív egész érték számít. */
export function windowMarkOf(marks: WindowMarks | undefined, k: string): number {
  if (!marks || !Object.prototype.hasOwnProperty.call(marks, k)) return 0;
  const v = marks[k];
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
}

/**
 * A jelek plafonja — EGY szabály a fésülésre, a bemenetre és a léptetésre:
 * a jelen lévő ablakok jele mindig marad, a levettekből a legnagyobb jelűek
 * (holtversenyben kódegység szerint). Üresen undefined.
 */
export function capWindowMarks(marks: Map<string, number>, present: string[]): WindowMarks | undefined {
  if (marks.size === 0) return undefined;
  const here = new Set(present);
  const kept = [...marks].filter(([k]) => here.has(k));
  const gone = [...marks].filter(([k]) => !here.has(k))
    .sort((x, y) => (y[1] - x[1]) || codeUnitCompare(x[0], y[0]));
  return Object.fromEntries([...kept, ...gone].slice(0, Math.max(kept.length, MAX_WINDOW_MARKS)));
}

/**
 * A kívülről (dróton, lemezről) jött ablak-jelek tisztán: kanonikus tartalmi
 * kulcs, pozitív egész, legfeljebb a blob `rev`-je — a plafonnal.
 */
export function cleanWindowMarks(raw: unknown, windows: LockdownWindow[], maxRev: number): WindowMarks | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const marks = new Map<string, number>();
  for (const k of Object.keys(raw)) {
    const v = windowMarkOf(raw as WindowMarks, k);
    if (v === 0 || v > maxRev || !isWindowKey(k)) continue;
    marks.set(k, v);
  }
  return capWindowMarks(marks, windows.map(windowKey));
}

/** Egy sáv heti percei SZERKEZET szerint — az óraátállítás nélkül. */
function bandMinutes(b: Band): number {
  return b.days.length * (b.endMin > b.startMin ? b.endMin - b.startMin : 1440 - b.startMin + b.endMin);
}

/**
 * A hét szabad percei az ablakok mellett — SZERKEZET szerint: a hét 7×1440
 * perce, óraátállítás és időzóna nélkül. A fésülés ezzel dönt, mert annak
 * minden eszközön, minden pillanatban ugyanazt kell adnia (a bíró a valódi
 * órával mér, a következő héten — `weekHasFreeTime`). Az érvénytelen sáv
 * nem fed le semmit.
 */
export function freeMinutesPerWeek(windows: Band[]): number {
  const covered = new Uint8Array(7 * 1440);
  for (const b of windows) {
    if (!isValidBand(b)) continue;
    for (const d of b.days) {
      const base = d * 1440;
      if (b.endMin > b.startMin) {
        covered.fill(1, base + b.startMin, base + b.endMin);
      } else {
        covered.fill(1, base + b.startMin, base + 1440);
        const next = ((d + 1) % 7) * 1440;
        covered.fill(1, next, next + b.endMin);
      }
    }
  }
  let free = 0;
  for (const c of covered) if (c === 0) free++;
  return free;
}

/**
 * Két eszköz ablakai TARTALMI KULCSONKÉNT fésülve, a jelük szerint.
 *
 * MIÉRT. Eddig a lista egészében a nagyobb jelet követte, és a jelet az
 * ingyenes szigorítás (ablak felvétele, bővítése) is lépteti: egy elavult
 * eszközön egy új ablak felvétele felhúzta a jelet, és a régi listája
 * mindenhol letörölte a máshol felvett ablakot — próbatétel nélkül.
 *
 * Most a jel a TARTALOMHOZ tartozik (napok, kezdés, vég), és tartalmanként a
 * nagyobb jel dönt; egyenlő (vagy hiányzó) jelnél az unió. A módosítás a régi
 * tartalom levétele és az új felvétele: a bővítés így sem lazít (az új
 * lefedi a régit), a szűkítés pedig próbatétel volt, a levétel jele azt viszi.
 * Azonos tartalomnál a kisebb azonosító marad; ha egy azonosító két
 * tartalomhoz is tartozna (két eszköz ugyanazt az ablakot másképp bővítette),
 * a későbbi a tartalmi kulcsát kapja azonosítónak.
 *
 * A sorrend a régebbi ígéreté: a jel szerint (a jeltelen elöl), egyenlő
 * jelnél a kisebb ablak, aztán a kulcs. A hetes plafon és a heti egy szabad
 * óra ebben a sorrendben vág — a legfrissebb esik ki, nem a régi: egy
 * frissen felvett ablak-tömeg nem szoríthat ki régi ablakot, és két eszköz
 * ablakainak uniója sem zárhatja le az egész hetet (akkor az ablakot sosem
 * lehetne levenni — az csapda, nem döntés). A kiesett ablak jele marad.
 */
export function mergeWindowSets(
  a: WindowSet, b: WindowSet,
): { lockdownWindows: LockdownWindow[]; lockdownWindowMarks?: WindowMarks } {
  const listA = normalizeWindows(a.lockdownWindows);
  const listB = normalizeWindows(b.lockdownWindows);
  const byKey = new Map<string, LockdownWindow>();
  for (const w of [...listA, ...listB]) {
    const k = windowKey(w);
    const had = byKey.get(k);
    if (!had || codeUnitCompare(w.id, had.id) < 0) byKey.set(k, w);
  }
  const keysA = new Set(listA.map(windowKey));
  const keysB = new Set(listB.map(windowKey));
  const names = new Set<string>([...keysA, ...keysB]);
  for (const m of [a.lockdownWindowMarks, b.lockdownWindowMarks]) {
    for (const k of Object.keys(m ?? {})) if (isWindowKey(k)) names.add(k);
  }
  const present: { w: LockdownWindow; k: string; m: number; size: number }[] = [];
  const marks = new Map<string, number>();
  for (const k of names) {
    const ma = windowMarkOf(a.lockdownWindowMarks, k);
    const mb = windowMarkOf(b.lockdownWindowMarks, k);
    const inA = keysA.has(k);
    const inB = keysB.has(k);
    const here = ma > mb ? inA : mb > ma ? inB : inA || inB;
    const m = Math.max(ma, mb);
    if (here) {
      const w = byKey.get(k)!;
      present.push({ w, k, m, size: bandMinutes(w) });
    }
    if (m > 0) marks.set(k, m);
  }
  present.sort((x, y) => (x.m - y.m) || (x.size - y.size) || codeUnitCompare(x.k, y.k));
  const kept: LockdownWindow[] = [];
  const ids = new Set<string>();
  for (const p of present) {
    if (kept.length >= MAX_LOCKDOWN_WINDOWS) break;
    if (freeMinutesPerWeek([...kept, p.w]) < MIN_FREE_MINUTES_PER_WEEK) continue;
    let id = p.w.id;
    for (let n = 1; ids.has(id); n++) id = n === 1 ? p.k : `${p.k}#${n}`;
    ids.add(id);
    kept.push({ ...p.w, id });
  }
  const lockdownWindowMarks = capWindowMarks(marks, kept.map(windowKey));
  return { lockdownWindows: kept, ...(lockdownWindowMarks ? { lockdownWindowMarks } : {}) };
}

/**
 * Az ablak-jelek a léptetésben: ami tartalom az előző léptetés óta bekerült
 * vagy kikerült, az ezt a blob-rev-et kapja; a többi jel marad. Az előző
 * tartalmak a léptetés eltett kulcsából jönnek (`focusRevWindows`).
 */
export function markWindowChanges(
  marks: WindowMarks | undefined, prevKeys: string[], next: LockdownWindow[], rev: number,
): WindowMarks | undefined {
  const out = new Map<string, number>();
  for (const k of Object.keys(marks ?? {})) {
    const v = windowMarkOf(marks, k);
    if (v > 0) out.set(k, v);
  }
  const nextKeys = next.map(windowKey);
  const before = new Set(prevKeys);
  const after = new Set(nextKeys);
  for (const k of nextKeys) if (!before.has(k)) out.set(k, rev);
  for (const k of prevKeys) if (!after.has(k) && isWindowKey(k)) out.set(k, rev);
  return capWindowMarks(out, nextKeys);
}

/** Az ablak-jelek tartalmi kulcsa — rendezve, a különbség-vizsgálathoz. */
export function windowMarksKey(marks: WindowMarks | undefined): string {
  return Object.keys(marks ?? {}).sort(codeUnitCompare)
    .map((k) => `${k}=${windowMarkOf(marks, k)}`).join(';');
}

/**
 * A legközelebb beérő ablak-előfordulás, ha `withinMs`-en belül kezdődik —
 * a jelzéshez. Nem közelgő, ami már él (arról a zárlat beszél), és nincs
 * miről szólni, ha egy futó zárlat úgyis túlér rajta: az érkezése semmin nem
 * változtat. Két eszköz ugyanazt találja: ugyanaz a lista, ugyanaz az óra.
 */
export function windowStartingSoon(
  cur: Lockdown | null | undefined, windows: Band[], now: number, withinMs = WINDOW_PRE_WARN_MS,
): Occurrence | null {
  let soonest: Occurrence | null = null;
  for (const w of windows) {
    if (!isValidBand(w)) continue;
    const occ = nextOccurrence(w, now);
    if (!occ || occ.startsAt <= now) continue;
    if (!soonest || occ.startsAt < soonest.startsAt) soonest = occ;
  }
  if (!soonest || soonest.startsAt - now > withinMs) return null;
  if (isLocked(cur, now) && cur!.until >= soonest.endsAt) return null;
  return soonest;
}

/**
 * A zárlat-ablakok előfordulásai MOSTANTÓL `days` napig (a még tartó is),
 * kezdés, aztán vég szerint, az azonos előfordulás egyszer.
 *
 * MIÉRT. A zárlatot az ablakban a segéd az app nélkül is elindítja — a
 * böngésző tiltó lapja viszont csak a hídon, a futó apptól tudott róla.
 * Zárva lévő app mellett a lap így olyan feloldási utat ígért (próbatétel
 * az appban), ami a zárlat alatt nincs. Ezzel a listával a bővítmény előre
 * tudja, mikor tart az ablak zárlata (lásd extension/app-link.js
 * `effectiveLockdown`).
 */
export function upcomingLockdownWindows(
  windows: Band[], now: number, days = WINDOW_LOOKAHEAD_DAYS,
): Occurrence[] {
  const seen = new Set<string>();
  const out: Occurrence[] = [];
  for (const w of windows) {
    for (const occ of occurrencesAhead(w, now, days)) {
      const key = `${occ.startsAt}/${occ.endsAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(occ);
    }
  }
  out.sort((a, b) => a.startsAt - b.startsAt || a.endsAt - b.endsAt);
  return out.slice(0, MAX_WINDOW_OCCURRENCES);
}
