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
import { isCoolingDown, type BurstState } from './burst.js';
import { isBlockedNow, nextOpenAt, type Blockable, type Schedule } from './schedule.js';
import { dayKey, dayKeysBack, siteKey, type UsageState } from './usage.js';

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
  // Ugyanaz a mérce, mint a lazítás-kérdésnél és a két telefonon: a keret
  // kerekítve, egy napra vágva. A nyers szám egy napnál nagyobb keretet is
  // komolyan vett volna — több eszköz összeadott ideje mellett az a telefonon
  // már zárt, a gépen még nem.
  const limit = normalizeLimit(site.dailyLimitSeconds);
  if (limit === null) return false;
  return usedTodayEverywhere(usage, shared, site.domain, now) >= limit;
}

/**
 * MIÉRT zár az oldal — a tiltás oka, nem csak a ténye.
 *
 * `always`: nincs menetrend, az oldal sima blokklistás. `schedule`: van
 * menetrend, és az most zárva tart. `cooldown`: a futó adag-hűtés.
 * `limit`: a mai keret betelt.
 */
export type BlockReason = 'always' | 'schedule' | 'cooldown' | 'limit';

/** A KÖVETKEZŐ helyi éjfél — a napi keret ekkor kezd újra. */
export function nextDayStartMs(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * The whole blocking decision: pause, pending delete, weekly schedule, the
 * daily budget AND the burst cooldown — plus WHY, and until when.
 *
 * Order matters. An active pause still wins over everything — it was paid for
 * with a challenge, and having it silently overridden by a budget (or a
 * cooldown) would make the unlock the user just earned worthless. Everything
 * else blocks.
 *
 * A `burst` az adag-számláló EZEN a gépen (shared/burst.ts) — a hívó adja át,
 * mert az nem a rekordon él, hanem a segéd állapotában.
 *
 * Az `until` csak ott van kitöltve, ahol az idő TÉNY, nem becslés: a hűtés
 * vége, a keret napfordulója, és a menetrend következő nyitása (nextOpenAt —
 * nulla, ha a menetrend sosem nyit). A sima tiltásnál nulla: annak nincs
 * lejárata, és a hívónak ott nem szabad visszaszámlálót mutatnia.
 */
export function blockReasonNow(
  site: Limitable, usage: UsageState, now: number, shared?: SharedToday | null,
  burst?: BurstState | null,
): { reason: BlockReason; until: number } | null {
  if (site.pauseUntil !== null && site.pauseUntil > now) return null;
  if (isBlockedNow(site, now)) {
    // A törlésre váró oldal a menetrendjétől FÜGGETLENÜL zár — az nem
    // időzítés, hanem sima tiltás, tehát a címkéje is az.
    const scheduled = site.pendingDeleteAt === null && !!site.schedule;
    if (!scheduled) return { reason: 'always', until: 0 };
    // A menetrend nyitása kiszámolható tény — hadd számoljon vissza a lap.
    const open = nextOpenAt(site.schedule as Schedule, now);
    return { reason: 'schedule', until: open > now ? open : 0 };
  }
  if (isCoolingDown(burst, now)) return { reason: 'cooldown', until: burst!.cooldownUntil };
  if (isLimitExhausted(site, usage, now, shared)) {
    return { reason: 'limit', until: nextDayStartMs(now) };
  }
  return null;
}

/**
 * Tilt-e MOST az oldal. Az ok-kereső DÖNT, ez csak megkérdezi — így a kettő
 * fogalmilag nem tud szétcsúszni: nem lehet olyan tiltás, aminek nincs oka,
 * és olyan ok sem, ami nem tilt.
 */
export function isBlockedNowWithLimit(
  site: Limitable, usage: UsageState, now: number, shared?: SharedToday | null,
  burst?: BurstState | null,
): boolean {
  return blockReasonNow(site, usage, now, shared, burst) !== null;
}

/**
 * Zár-e az oldal a szünete VÉGÉN — a szünetet nem számítva: a menetrend és a
 * törlésre várás az akkori időpontban, a hűtés, és a napi keret a mostani
 * mérésből (ha a vég már a következő napra esik, a keret nulláról indul).
 *
 * MIÉRT. A szünet vége előtti szó azt mondja: „újra zárva”. De egy nyitott
 * menetrend-sávban véget érő szünet után (16:30-kor feloldva egy órára, a
 * munkaidő-tiltás 17-kor véget ér) az oldal nyitva marad — a szó hamis
 * volna. Ugyanez a döntés, mint mindenhol (`isBlockedNowWithLimit`), csak a
 * szünet végének pillanatában.
 *
 * Nincs szünet (vagy nem szám): hamis — nincs miről szólni.
 */
export function closesAfterPause(
  site: Limitable, usage: UsageState, shared?: SharedToday | null, burst?: BurstState | null,
): boolean {
  const until = site.pauseUntil;
  if (until === null || until === undefined || !Number.isFinite(until)) return false;
  return isBlockedNowWithLimit({ ...site, pauseUntil: null }, usage, until, shared, burst);
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

/** Egy célra egy nap legfeljebb egy nap lehet. */
const DIGEST_MAX_SECONDS = 24 * 3600;

/**
 * Amit a kiszolgálóról kaptunk -> használható összegzés, vagy null.
 *
 * A `deviceId` KÍVÜLRŐL jön (a kiszolgáló mondja meg, kié a sor), nem a blob
 * belsejéből: különben egy eszköz a másik nevében beszélhetne, és a saját
 * sorunkat is kihagyhatatlanná tehetné.
 *
 * A SZABÁLY KIMONDVA, mert három mag olvassa ugyanazt a blobot: a nap
 * `YYYY-MM-DD` ASCII számjegyekkel; a másodperc csak JSON-SZÁM lehet (nem
 * szöveg, nem igaz/hamis, nem null), kerekítve, egy napra vágva, és csak ha
 * így is pozitív; a `seconds` csak objektum lehet (tömb nem). Ha több cél jön,
 * mint a plafon, a LEGNAGYOBBAK maradnak, holtversenyben a kulcs kódegység
 * szerint — nem a beérkezés sorrendje, mert azt a három JSON-olvasó nem
 * egyformán őrzi meg. A legnagyobbak megtartása a szigorúbb irány: a keret
 * hamarabb fogy, nem később. A közös fixtúra (fixtures/limit-cases.json)
 * kimondja; eddig a gép a tömböt, az Android a szövegként írt számot, az
 * iPhone az igaz/hamisat is elfogadta.
 */
export function normalizeTodayDigest(parsed: unknown, deviceId: string): TodayDigest | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = parsed as Partial<TodayDigest>;
  if (typeof raw.day !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(raw.day)) return null;
  const src = raw.seconds && typeof raw.seconds === 'object' && !Array.isArray(raw.seconds) ? raw.seconds : {};
  const valid: [string, number][] = [];
  for (const [k, v] of Object.entries(src)) {
    if (k === '' || typeof v !== 'number' || !Number.isFinite(v)) continue;
    // Egy nap egy célra legfeljebb egy nap lehet. Ennél nagyobb szám nem
    // mérésből származik, és az egész keretet azonnal elégetné.
    const s = Math.min(Math.round(v), DIGEST_MAX_SECONDS);
    if (s > 0) valid.push([k, s]);
  }
  valid.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // `fromEntries`, nem értékadás: a `__proto__` kulcs értékadással a prototípust
  // írná át, és a sor csendben eltűnne — a két telefon megtartja.
  const seconds: Record<string, number> = Object.fromEntries(valid.slice(0, MAX_DIGEST_TARGETS));
  return { deviceId, day: raw.day, seconds };
}

/** A visszafejtett blob SZÖVEGE -> összegzés, vagy null (a hibás JSON is null, nem kivétel). */
export function parseTodayDigest(text: string, deviceId: string): TodayDigest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return normalizeTodayDigest(parsed, deviceId);
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

/** A keret betelt napjai: hány napon, és oldalanként hányszor — a legtöbb elöl, holtversenyben ábécé. */
export interface LimitFullDays {
  days: number;
  bySite: { domain: string; days: number }[];
}

/**
 * A KERET BETELT NAPJAI az elmúlt 7 napon — ezen a gépen mérve: hány napon
 * érte el a mért idő valamelyik oldal napi keretét, és melyik oldalé hányszor.
 * A múlt napokra csak a helyi mérés van: a többi eszköz mai összegzése nem
 * marad meg napokra. Tükör, nem ítélet: azt mutatja, dolgozik-e a keret.
 */
export function limitFullDays(usage: UsageState, sites: Limitable[], now: number): LimitFullDays {
  const keys = dayKeysBack(now, 7);
  const full = new Set<string>();
  const bySite: { domain: string; days: number }[] = [];
  for (const site of sites) {
    const limit = normalizeLimit(site.dailyLimitSeconds);
    if (limit === null) continue;
    let n = 0;
    for (const day of keys) {
      const bucket = usage.days.find((d) => d.day === day);
      const seconds = bucket?.seconds[siteKey(site.domain)] ?? 0;
      if (Number.isFinite(seconds) && seconds >= limit) { n += 1; full.add(day); }
    }
    if (n > 0) bySite.push({ domain: site.domain, days: n });
  }
  // Holtversenyben a domain KÓDEGYSÉG szerint — nem `localeCompare`: az a gép
  // nyelvi beállítását követi (magyarul a „cz.hu” a „csak.hu” elé kerül, mert
  // a „cs” külön betű), a két telefon pedig kódegység szerint rendez. Ugyanaz
  // a hét ugyanazt a sort mondja minden eszközön.
  bySite.sort((a, b) => b.days - a.days || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
  return { days: full.size, bySite };
}

/** A sor: „A napi keret a héten 2 napon betelt: reddit.com 1× · youtube.com 1×.” — vagy üres, ha egyszer sem. */
export function limitFullLine(r: LimitFullDays, labelOf: (domain: string) => string): string {
  if (r.days <= 0) return '';
  const per = r.bySite.map((x) => `${labelOf(x.domain)} ${x.days}×`).join(' · ');
  return `A napi keret a héten ${r.days} napon betelt${per ? `: ${per}` : ''}.`;
}

/** A KERET KÖZELSÉGE: ennyi másodpercen belül szólunk, mielőtt a mai keret betelik. */
export const LIMIT_SOON_SECONDS = 10 * 60;

/** Hány másodperc van hátra a mai keretből — null, ha nincs keret. Nem megy nulla alá. */
export function limitRemaining(dailyLimitSeconds: number | null | undefined, usedSeconds: number): number | null {
  const limit = normalizeLimit(dailyLimitSeconds);
  if (limit === null) return null;
  return Math.max(0, limit - usedSeconds);
}

/**
 * KÖZELEG A NAPI KERET: a legsürgősebb oldal — amelyiknek a mai keretéből a
 * legkevesebb van hátra, de még nem telt be, és a küszöbön belül van (az
 * utolsó tíz perc, de legfeljebb a keret fele). Például:
 * „Ma még 8 perc a kereted: youtube.com.”
 * Tény, nem tiltás: szól, mielőtt a keret betelne, hogy ne meglepetés legyen.
 * Üres, ha egyik oldal sincs a küszöbön belül. A címkét a hívó adja (fedőnév,
 * rejtés — az övé), a mag csak a számot nézi.
 */
export function limitSoonLine(
  candidates: { label: string; dailyLimitSeconds: number | null | undefined; usedSeconds: number }[],
): string {
  let best: { label: string; rem: number } | null = null;
  for (const c of candidates) {
    const limit = normalizeLimit(c.dailyLimitSeconds);
    if (limit === null) continue;
    const rem = Math.max(0, limit - c.usedSeconds);
    // A küszöb az utolsó tíz perc, de legfeljebb a keret FELE — így egy kis
    // keret (pl. öt perc) nem szólal meg már a legelső perctől, hanem a hátsó
    // felében. Nagy keretnél (húsz perctől) a tíz perc a mérvadó.
    const threshold = Math.min(LIMIT_SOON_SECONDS, limit / 2);
    if (rem <= 0 || rem > threshold) continue;
    if (best === null || rem < best.rem) best = { label: c.label, rem };
  }
  if (best === null) return '';
  return `Ma még ${Math.ceil(best.rem / 60)} perc a kereted: ${best.label}.`;
}

// ------------------------------------------------- A KERET VÉGE ELŐRE (értesítés)
//
// A „ma még N perc” sor a kártyán áll — de aki épp az oldalon van, az nem az
// appot nézi, és a keret vége félbehagyott videó közepén jön (a nyitott lap
// is bezárul). Ezért amikor egy oldal mai keretéből a küszöbnyi idő marad (az
// utolsó tíz perc, de legfeljebb a keret fele — ugyanaz, mint a soré), az app
// egyszer szól. Két hallgatási szabály, mint a szünet végénél:
//
// - csak akkor, ha ma már a küszöb FÖLÖTT is láttuk (élesítve): az app
//   indulásakor már fogyóban lévő keretre nem — az nem most lépte át;
// - naponta oldalanként egyszer;
// - SZÜNET ALATT nem: a kifizetett szünet a keretet is legyőzi, tehát a
//   keret fogyása akkor nem zárást jelent (arról a szünet vége szól). A
//   figyelés megmarad: ha a szünet után még fogyóban van, akkor szól.
//
// Ugyanez a Kotlin `LimitLogic.stepNotices`-ban; iPhone-on nincs saját mérés.

/** Egy figyelt keret: melyik napra élesítettük, és szóltunk-e már aznap. */
export interface LimitWatch {
  day: string;
  armed: boolean;
  told: boolean;
}

export interface LimitNotice {
  label: string;
  text: string;
}

/**
 * Egy kör: a figyelt keretek (`prev`) és a mostani oldalak alapján megmondja,
 * miről kell most szólni. A `day` a mai napkulcs (`dayKey`); új napon a
 * figyelés tiszta lappal indul. A mondat ugyanaz, mint a soré (`limitSoonLine`).
 */
export function stepLimitNotices(
  prev: Record<string, LimitWatch>,
  sites: {
    id: string; label: string; dailyLimitSeconds: number | null | undefined; usedSeconds: number;
    /** él-e most szünet az oldalon — akkor a keret fogyása nem zárás */
    paused?: boolean;
  }[],
  day: string,
): { watches: Record<string, LimitWatch>; notices: LimitNotice[] } {
  const watches: Record<string, LimitWatch> = {};
  const notices: LimitNotice[] = [];
  for (const s of sites) {
    const limit = normalizeLimit(s.dailyLimitSeconds);
    if (limit === null) continue;
    const old = prev[s.id];
    const w: LimitWatch = old && old.day === day ? { ...old } : { day, armed: false, told: false };
    const rem = Math.max(0, limit - s.usedSeconds);
    const threshold = Math.min(LIMIT_SOON_SECONDS, limit / 2);
    if (rem > threshold) {
      w.armed = true;
    } else if (rem > 0 && w.armed && !w.told && s.paused !== true) {
      w.told = true;
      notices.push({
        label: s.label,
        text: limitSoonLine([{ label: s.label, dailyLimitSeconds: s.dailyLimitSeconds, usedSeconds: s.usedSeconds }]),
      });
    }
    watches[s.id] = w;
  }
  return { watches, notices };
}

/** Az értesítés címe — ugyanaz a gépen és Androidon. */
export const LIMIT_SOON_TITLE = 'Breaker — fogy a mai keret';
