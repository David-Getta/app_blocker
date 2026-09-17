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
import { occurrenceAt, type Occurrence } from './focus.js';

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
export function normalizeWindow(raw: unknown): LockdownWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const w = raw as Partial<LockdownWindow>;
  if (typeof w.id !== 'string' || !w.id || w.id.length > MAX_WINDOW_ID) return undefined;
  const rawDays: unknown[] = Array.isArray(w.days) ? w.days : [];
  const days = [...new Set(rawDays.filter((d): d is Weekday =>
    typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6))].sort((x, y) => x - y);
  const band: Band = { days, startMin: Number(w.startMin), endMin: Number(w.endMin) };
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
 * Két eszköz ablak-listája EGGYÉ fésülve, a JELÜK szerint.
 *
 * A jel a blob `rev`-je, amelyik a listát utoljára változtatta (lásd
 * revisions.ts). Nagyobb jel nyer: a levétel próbatétellel jár, ami lépteti
 * a blobot és a jelet, tehát a levétel átmegy, és egy elmaradt eszköz régi
 * listája nem támaszthatja fel — de egy csomag-szerkesztés vagy egy menet
 * indítása a másik eszközön (ami a blob `rev`-jét lépteti, a jelet nem) sem
 * viszi el. Azonos jelnél a BŐVEBB lista (a kettő uniója tartalom szerint):
 * a szigorúbb irány. A jel nélküli blob (régi kliens) jele nulla — az ilyen
 * sosem törölhet listát.
 *
 * Őszinte határ: ha két eszköz egy körben egyszerre vesz fel és le egy-egy
 * ablakot azonos jellel, a levett visszajön; a próbatételt újra kell tenni.
 */
export function mergeWindows(
  localMark: number, local: LockdownWindow[], incomingMark: number, incoming: LockdownWindow[],
): LockdownWindow[] {
  if (localMark > incomingMark) return normalizeWindows(local);
  if (incomingMark > localMark) return normalizeWindows(incoming);
  // Unió TARTALOM szerint: a helyi azonosítója marad, ahol a tartalom azonos.
  return normalizeWindows([...local, ...incoming]);
}
