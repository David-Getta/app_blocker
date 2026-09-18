// A BÖNGÉSZŐ MEGAKADÁSAI az appban: hányszor vitt a tiltó lapra a bővítmény.
//
// A bővítmény könyveli (extension/hits.js), a hídon adja át (POST /hits, a
// kóddal), a segéd tartja — a heti mondat és a statisztika sora mondja. Két
// böngésző (vagy két profil) két könyv: forrásonként tároljuk, és összeadjuk.
// Nem szinkronizál: a gép saját tükre, mint a heti napló.
//
// Pure: a segéd és a felület is betölti.

/** Egy nap egy forrásból: nap (ÉÉÉÉ-HH-NN, helyi), összeg, okonként. */
export interface BrowserHitDay { day: string; total: number; byReason: Record<string, number>; byHour?: number[] }
/** Forrásonként (böngésző-profilonként) egy lista. */
export type BrowserHits = Record<string, BrowserHitDay[]>;

/** Ennyi napot tartunk forrásonként — a bővítmény hetet küld, ez a plafon a szemét ellen. */
export const MAX_HIT_DAYS = 31;
/** Ennyi forrást — böngésző-profilt — tartunk; a többi nem fér, és nem is valós. */
export const MAX_HIT_SOURCES = 8;
/** Egy nap legfeljebb ennyi megakadás — fölötte nem mérés, hanem hiba. */
export const MAX_HITS_PER_DAY = 10_000;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REASONS = ['closed', 'focus', 'channel', 'rule', 'keyword', 'other'];

/** A hídról jött napok tisztán: jó nap, egész szám a plafonig, naponként egyszer (az utolsó marad), a legrégebbi elöl. */
export function cleanBrowserHitDays(raw: unknown): BrowserHitDay[] {
  const byDay = new Map<string, BrowserHitDay>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const { day, total, byReason, byHour } = item as { day?: unknown; total?: unknown; byReason?: unknown; byHour?: unknown };
    if (typeof day !== 'string' || !DAY_KEY.test(day)) continue;
    if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) continue;
    const t = Math.min(MAX_HITS_PER_DAY, Math.floor(total));
    const reasons: Record<string, number> = {};
    if (byReason && typeof byReason === 'object') {
      for (const r of REASONS) {
        const n = (byReason as Record<string, unknown>)[r];
        if (typeof n === 'number' && Number.isFinite(n) && n > 0) reasons[r] = Math.min(t, Math.floor(n));
      }
    }
    // Az órák: huszonnégy szám, mindegyik legfeljebb a napi összeg — a rekesz nem hazudhat többet a napnál.
    const hours = Array.isArray(byHour) && byHour.length === 24
      ? byHour.map((n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(t, Math.floor(n)) : 0))
      : undefined;
    byDay.set(day, hours && hours.some((n) => n > 0) ? { day, total: t, byReason: reasons, byHour: hours } : { day, total: t, byReason: reasons });
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)).slice(-MAX_HIT_DAYS);
}

/** A tárból jött könyv tisztán: csak a jó forrás-azonosítók, a plafonig. */
export function cleanBrowserHits(raw: unknown): BrowserHits {
  const out: BrowserHits = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [source, days] of Object.entries(raw as Record<string, unknown>)) {
    if (!SOURCE_ID.test(source)) continue;
    if (Object.keys(out).length >= MAX_HIT_SOURCES) break;
    const clean = cleanBrowserHitDays(days);
    if (clean.length > 0) out[source] = clean;
  }
  return out;
}

/**
 * Egy forrás jelentése a könyvbe — a forrás sorai cserélődnek (a bővítmény
 * mindig a teljes hetét küldi), a többi forrásé marad. Rossz azonosító vagy
 * betelt könyv (új forrásnak): nincs változás. Új könyvet ad vissza.
 */
export function putBrowserHits(book: BrowserHits | undefined, source: string, days: unknown): BrowserHits {
  const out = cleanBrowserHits(book);
  if (!SOURCE_ID.test(source)) return out;
  if (out[source] === undefined && Object.keys(out).length >= MAX_HIT_SOURCES) return out;
  const clean = cleanBrowserHitDays(days);
  if (clean.length === 0) delete out[source];
  else out[source] = clean;
  return out;
}

/** A nap kulcsa helyi idő szerint — ugyanaz, mint a bővítményé és a mérésé. */
export function hitDayKey(t: number): string {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Megakadások a két nap között (mindkettő beleértve), minden forrásból. */
export function browserHitsBetween(book: BrowserHits | undefined, fromDay: string, toDay: string): number {
  let sum = 0;
  for (const days of Object.values(book ?? {})) {
    for (const d of days) if (d.day >= fromDay && d.day <= toDay) sum += d.total;
  }
  return sum;
}

/** Az elmúlt 7 nap (a mai nappal) — a statisztika és a visszatekintés ablaka. */
export function browserHits7d(book: BrowserHits | undefined, now: number): number {
  return browserHitsBetween(book, hitDayKey(now - 6 * 86_400_000), hitDayKey(now));
}

/** A mai nap. */
export function browserHitsToday(book: BrowserHits | undefined, now: number): number {
  const today = hitDayKey(now);
  return browserHitsBetween(book, today, today);
}

/** A csúcs-óra az elmúlt 7 napon, minden forrásból: { hour, count } — vagy null. Holtversenynél a korábbi óra. */
export function browserHitsPeakHour(book: BrowserHits | undefined, now: number): { hour: number; count: number } | null {
  const from = hitDayKey(now - 6 * 86_400_000);
  const to = hitDayKey(now);
  const by = new Array<number>(24).fill(0);
  for (const days of Object.values(book ?? {})) {
    for (const d of days) {
      if (d.day < from || d.day > to || !d.byHour) continue;
      for (let i = 0; i < 24; i++) by[i] += d.byHour[i] ?? 0;
    }
  }
  let best = -1;
  for (let i = 0; i < 24; i++) if (by[i] > 0 && (best < 0 || by[i] > by[best])) best = i;
  return best < 0 ? null : { hour: best, count: by[best] };
}

/**
 * A SOKADIK megakadás lépcsői: ezeknél a mai számoknál egyszer szól a gép
 * (értesítés), hogy egy munkamenet vagy egy rövid zárlat most segítene.
 * Nem ítélet, és nem tilt semmit — egy lépést javasol, a döntés az emberé.
 */
export const HIT_NUDGE_STEPS = [5, 10, 20];

/** A legmagasabb lépcső, amit a mai szám elért — 0, ha egyet sem. */
export function hitNudgeStep(today: number, steps: number[] = HIT_NUDGE_STEPS): number {
  let best = 0;
  for (const s of steps) if (today >= s && s > best) best = s;
  return best;
}

/** A javaslat mondata egy lépcsőnél. */
export function hitNudgeText(step: number): string {
  return `Ma már ${step} megakadás a böngészőben. Egy munkamenet vagy egy rövid zárlat most segítene — te döntesz.`;
}

/** „21–22 óra” — a csúcs-óra felirata. */
export function hourLabel(hour: number): string {
  return `${hour}–${(hour + 1) % 24} óra`;
}

/**
 * ELŐJELZÉS a csúcs-óra előtt: ennyivel a hét csúcs-órájának kezdete előtt
 * egyszer szól a gép — naponta egyszer, és csak ha a csúcs legalább ennyi.
 * Tükör időzítéssel: „ilyenkor jár a kéz magától” — nem tilt, nem ítél.
 */
export const PEAK_WARN_LEAD_MS = 10 * 60_000;
export const PEAK_WARN_MIN_COUNT = 3;

/**
 * A mai előjelzés kulcsa („nap:óra”), ha most esedékes — különben null. A
 * nulla órás csúcs ablaka az előző estén van: a kulcs a csúcs napjáé.
 */
export function peakWarnKey(peak: { hour: number; count: number } | null, now: number): string | null {
  if (!peak || peak.count < PEAK_WARN_MIN_COUNT) return null;
  const d = new Date(now);
  for (const offset of [0, 1]) {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, peak.hour).getTime();
    if (now >= start - PEAK_WARN_LEAD_MS && now < start) return `${hitDayKey(start)}:${peak.hour}`;
  }
  return null;
}

/** Az előjelzés mondata. */
export function peakWarnText(peak: { hour: number; count: number }): string {
  return `Mindjárt ${peak.hour} óra — a héten ilyenkor akadt meg a kéz a legtöbbször (${peak.count}×). Egy munkamenet most segítene — te döntesz.`;
}

/**
 * Az utolsó `count` nap sora, a legrégebbi elöl, minden forrásból összeadva
 * — a hét alakja a megakadásokra, ahogy a mért időé és a meneteké. Naptári
 * napokban lépünk vissza, nem huszonnégy órában: az óraátállítás napja is nap.
 */
export function browserHitsSeries(
  book: BrowserHits | undefined, now: number, count: number,
): { day: string; total: number }[] {
  const base = new Date(now);
  const out: { day: string; total: number }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const day = hitDayKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() - i).getTime());
    out.push({ day, total: browserHitsBetween(book, day, day) });
  }
  return out;
}
