// Daily active-time budget per site.
//
// The blocking decision so far was binary (blocked / not blocked) plus a weekly
// schedule. The tracker already knows how much active time went into a site
// today, so the two can be combined: "not banned outright, but at most 20
// minutes a day". Once today's budget is spent, the site blocks itself for the
// rest of the day and starts over at midnight.
//
// See docs/feature-daily-limit.md. Pure and dependency-free, like the rest of
// the shared core, so Kotlin/Swift can mirror it exactly.

// A .js kiterjesztés kötelező: ez a fájl a felületre is bekerül, és a böngésző
// natív ESM-betöltője kiterjesztés nélkül nem oldja fel a hivatkozást.
import { isBlockedNow, type Blockable } from './schedule.js';
import { dayKey, siteKey, type UsageState } from './usage.js';

export interface Limitable extends Blockable {
  /** the registrable domain, i.e. how the tracker keys this site */
  domain: string;
  /** daily active-time budget in seconds; absent = no budget */
  dailyLimitSeconds?: number;
}

/** Active seconds recorded for this site today (0 when nothing is tracked). */
export function usedTodaySeconds(usage: UsageState, domain: string, now: number): number {
  const today = dayKey(now);
  const bucket = usage.days.find((d) => d.day === today);
  if (!bucket) return 0;
  const seconds = bucket.seconds[siteKey(domain)];
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/**
 * Whether today's budget is used up. No budget = never exhausted.
 *
 * A `shared` a többi eszköz mai összegzése. Ha nincs (nincs szinkron, vagy még
 * nem jött le), a helyi mérés dönt — vagyis pontosan úgy viselkedik, mint
 * korábban. A távoli másodpercek csak hozzáadnak, tehát ettől a keret sosem
 * lesz bővebb.
 */
export function isLimitExhausted(
  site: Limitable, usage: UsageState, now: number, shared?: SharedToday | null,
): boolean {
  const limit = site.dailyLimitSeconds;
  if (!Number.isFinite(limit) || (limit as number) <= 0) return false;
  return usedTodayEverywhere(usage, shared, site.domain, now) >= (limit as number);
}

/**
 * The whole blocking decision: pause, pending delete, weekly schedule AND the
 * daily budget.
 *
 * Order matters. An active pause still wins over everything — it was paid for
 * with a challenge, and having it silently overridden by a budget would make
 * the unlock the user just earned worthless. Everything else blocks.
 */
export function isBlockedNowWithLimit(
  site: Limitable, usage: UsageState, now: number, shared?: SharedToday | null,
): boolean {
  if (site.pauseUntil !== null && site.pauseUntil > now) return false;
  if (isBlockedNow(site, now)) return true;
  return isLimitExhausted(site, usage, now, shared);
}

/**
 * Is changing the budget a loosening (i.e. does it need the unlock challenges)?
 *
 * Raising it or taking it away buys more time on the site, so it goes through
 * the same friction as a pause. Lowering it or introducing one is a tightening
 * and applies immediately — the direction that helps is always free.
 */
export function isLimitLoosening(
  current: number | undefined | null, next: number | undefined | null,
): boolean {
  const cur = normalizeLimit(current);
  const nxt = normalizeLimit(next);
  if (cur === null) return false;        // there was no budget; any budget is stricter
  if (nxt === null) return true;         // removing the budget frees the whole day
  return nxt > cur;
}

/**
 * The ceiling on a daily budget, in minutes.
 *
 * A day is the most a daily budget can ever mean, so this is where the free
 * minute field stops. It lives next to normalizeLimit so the surface and the
 * referee cannot drift apart on what "too much" is.
 */
export const MAX_LIMIT_MINUTES = 24 * 60;

/** A usable budget, or null for "no budget". Nonsense values mean no budget. */
export function normalizeLimit(value: number | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  // A day is the ceiling: a bigger "budget" is the same as having none.
  return Math.min(Math.round(value), MAX_LIMIT_MINUTES * 60);
}

// ---------------------------------------------------------------------------
// A napi keret eszközök között közös
// ---------------------------------------------------------------------------
//
// A keret eddig eszközönként külön ketyegett: „napi 20 perc YouTube” a gépen
// húsz percet jelentett, a telefonon még húszat. Aki a keretet komolyan
// gondolja, annak ez nem keret, hanem javaslat — és pont az a fajta kiskapu,
// amit az app egyébként mindenhol zár.
//
// Ezért minden eszköz feltölti, mennyit mért MA, és mindegyik hozzáadja a
// többiét a sajátjához.
//
// MIÉRT BIZTONSÁGOS. A távoli számok csak HOZZÁADNAK. Bármit is küld a másik
// eszköz, attól a keret csak hamarabb fogy el, sosem később — a szigorítás
// pedig mindig ingyen van. Ha a szinkron áll, marad a helyi mérés: az app
// olyan lesz, mint eddig, nem lazább.

/** Amit egy eszköz ma mért. Csak a mai nap, csak a számok — pár száz bájt. */
export interface TodayDigest {
  deviceId: string;
  /** az ADOTT eszköz helyi naptári napja, YYYY-MM-DD */
  day: string;
  /** cél kulcsa ("site:…" / "app:…") -> másodperc */
  seconds: Record<string, number>;
}

/** A többi eszköz mai összegzése, és hogy közülük melyik vagyunk mi. */
export interface SharedToday {
  /** a saját eszközazonosítónk — az ő sorát KI KELL hagyni */
  selfDeviceId: string;
  devices: TodayDigest[];
}

/** Ennél több célt egy összegzésbe nem teszünk (és nem is fogadunk el). */
export const MAX_DIGEST_TARGETS = 200;

/** A saját mai összegzésünk, feltöltésre kész. */
export function makeTodayDigest(usage: UsageState, deviceId: string, now: number): TodayDigest {
  const day = dayKey(now);
  const bucket = usage.days.find((d) => d.day === day);
  const seconds: Record<string, number> = {};
  if (bucket) {
    // A legnagyobbak maradnak: a keret szempontjából a hosszú tételek
    // számítanak, a néhány másodperces szemét nem.
    const entries = Object.entries(bucket.seconds)
      .filter(([, s]) => Number.isFinite(s) && s > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_DIGEST_TARGETS);
    for (const [k, s] of entries) seconds[k] = Math.round(s);
  }
  return { deviceId, day, seconds };
}

/**
 * Amit a kiszolgálóról kaptunk -> használható összegzés, vagy null.
 *
 * A `deviceId` KÍVÜLRŐL jön (a kiszolgáló mondja meg, kié a sor), nem a blob
 * belsejéből: különben egy eszköz a másik nevében beszélhetne, és a saját
 * sorunkat is kihagyhatatlanná tehetné.
 */
export function normalizeTodayDigest(parsed: unknown, deviceId: string): TodayDigest | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as Partial<TodayDigest>;
  if (typeof raw.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.day)) return null;
  const seconds: Record<string, number> = {};
  const src = raw.seconds && typeof raw.seconds === 'object' ? raw.seconds : {};
  let kept = 0;
  for (const [k, v] of Object.entries(src)) {
    if (kept >= MAX_DIGEST_TARGETS) break;
    if (typeof k !== 'string' || k === '') continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
    // Egy nap egy célra legfeljebb egy nap lehet. Ennél nagyobb szám nem
    // mérésből származik, és az egész keretet azonnal elégetné.
    seconds[k] = Math.min(Math.round(v), 24 * 3600);
    kept++;
  }
  return { deviceId, day: raw.day, seconds };
}

/**
 * A TÖBBI eszköz mai másodpercei egy oldalra.
 *
 * Két dolog marad ki, és mindkettő hibából származna:
 *   - a saját sorunk (a szinkron a mi összegzésünket is visszaadja) — enélkül
 *     minden percünk kétszer számítana, és a keret feleannyi lenne;
 *   - a nem mai nap — a másik eszköz más időzónában más napot ír, és a tegnapi
 *     perceit ma nem szabad felszámolni.
 */
export function sharedTodaySeconds(
  shared: SharedToday | null | undefined, domain: string, now: number,
): number {
  if (!shared || !Array.isArray(shared.devices)) return 0;
  const today = dayKey(now);
  const key = siteKey(domain);
  let total = 0;
  for (const d of shared.devices) {
    if (!d || d.deviceId === shared.selfDeviceId || d.day !== today) continue;
    const s = d.seconds?.[key];
    if (typeof s === 'number' && Number.isFinite(s) && s > 0) total += s;
  }
  return total;
}

/** Ma elhasznált idő MINDEN eszközön együtt. */
export function usedTodayEverywhere(
  usage: UsageState, shared: SharedToday | null | undefined, domain: string, now: number,
): number {
  return usedTodaySeconds(usage, domain, now) + sharedTodaySeconds(shared, domain, now);
}
