// Munkamenetek: „most csak EZ mehet”.
//
// A blokklista arról szól, mi NE menjen. Van azonban egy másik igény, ami
// ellentétes irányból közelít: leülök nyelvet tanulni, és a következő ötven
// percben CSAK a szótár és a jegyzetfüzet kell. Mindent felsorolni, ami
// zavarhat, reménytelen — a világon minden zavarhat. Felsorolni, ami kell:
// öt tétel.
//
//   „Nyelvtanulás”  ->  engedve: fordito.hu, quizlet.com, Word
//                       minden más: tiltva, ötven percig
//
// EZ MEGFORDÍTJA A LOGIKÁT, és ezért külön fájl: a blokklista feketelista, a
// munkamenet FEHÉRLISTA. A kettő együtt él: a munkamenet sosem old fel semmit,
// amit a blokklista tilt — csak hozzátesz.
//
// AMIT A KÜLÖNBÖZŐ RÉTEGEK TUDNAK, és amit a felület ki is mond:
//
//   - a böngészőben a bővítmény érvényesíti (ott látszik a teljes cím);
//   - az appoknál a mérés látja, mi van előtérben, és a réteg figyelmeztet —
//     bezárni egy appot nem tudunk, és nem is állítjuk, hogy tudunk.
//
// Pure és függőségmentes, hogy a Kotlin/Swift oldal pontosan tükrözhesse.

import { normalizeDomain } from './blocklist.js';
import { isLoosening, isValidBand, type Band, type Weekday } from './schedule.js';

/** Egy csomagban ennyi engedélyezett tétel lehet. */
export const MAX_ALLOW_ENTRIES = 40;
/** A csomag nevének felső hossza — a rétegen is ki kell férnie. */
export const MAX_PACK_NAME = 40;
/** Egy munkamenet leghosszabb hossza. Ennél tovább nem tervez az ember. */
export const MAX_SESSION_MINUTES = 8 * 60;
/** A felületen felkínált hosszak. */
export const SESSION_CHOICES_MIN = [15, 25, 50, 90, 120];

export interface FocusPack {
  id: string;
  /** amit a felhasználó ír: „Nyelvtanulás” */
  name: string;
  /**
   * Engedélyezett hosztok. MINDEN MÁS tiltva a munkamenet alatt.
   *
   * Aldomainek is átmennek: a `google.com` engedése a `translate.google.com`-ot
   * is engedi. Enélkül minden oldalnál külön ki kellene találni, melyik
   * aldomain kell — és a felhasználó azt látná, hogy a beállítása nem működik.
   */
  allowSites: string[];
  /**
   * Engedélyezett appok, a mérésből ismert néven („Microsoft Word”).
   *
   * Kis-nagybetű nem számít. Részleges egyezés IGEN: a „word” engedi a
   * „Microsoft Word”-öt is — az ablakcímek gépenként eltérnek, és egy
   * pontos egyezésre épülő lista mindenkinél máshogy viselkedne.
   */
  allowApps: string[];
  /** amit induláskor felkínálunk, percben */
  defaultMinutes: number;
  /**
   * Ismétlődés: ezeken a napokon, ebben az ablakban a menet MAGÁTÓL indul,
   * és az ablak végéig tart. Nincs = csak kézzel indul. Ugyanaz a sáv-alak,
   * mint az oldalak menetrendjében (napok, kezdés, vég; éjfélen átnyúlhat).
   */
  recurrence?: Band;
}

export interface FocusRun {
  packId: string;
  startedAt: number;
  /** mikor jár le magától */
  endsAt: number;
}

/** Fut-e most munkamenet. */
export function isRunning(run: FocusRun | null | undefined, now: number): boolean {
  return !!run && run.endsAt > now;
}

/** Mennyi van hátra (0, ha nem fut). */
export function remainingMs(run: FocusRun | null | undefined, now: number): number {
  if (!isRunning(run, now)) return 0;
  return (run as FocusRun).endsAt - now;
}

/** Percek -> használható hossz, vagy null. */
export function normalizeMinutes(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 1) return null;
  return Math.min(rounded, MAX_SESSION_MINUTES);
}

/**
 * Egy engedélyezett tétel megtisztítása.
 *
 * Az oldalaknál ugyanazon a magon megy át, mint a blokklista: így ami itt
 * engedve van, az ugyanazt a hosztot jelenti, mint amit ott tiltunk.
 */
export function normalizeAllowSite(input: string): string | null {
  return normalizeDomain(input);
}

export function normalizeAllowApp(input: string): string | null {
  const s = (input ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.slice(0, 64);
}

/** Egy kívülről jött csomag használható alakja, vagy null. */
export function normalizePack(raw: unknown): FocusPack | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<FocusPack>;
  if (typeof p.id !== 'string' || !p.id) return null;
  const name = (typeof p.name === 'string' ? p.name : '').trim().slice(0, MAX_PACK_NAME);
  if (!name) return null;

  const sites: string[] = [];
  for (const s of Array.isArray(p.allowSites) ? p.allowSites : []) {
    const n = typeof s === 'string' ? normalizeAllowSite(s) : null;
    if (n && !sites.includes(n) && sites.length < MAX_ALLOW_ENTRIES) sites.push(n);
  }
  const apps: string[] = [];
  for (const a of Array.isArray(p.allowApps) ? p.allowApps : []) {
    const n = typeof a === 'string' ? normalizeAllowApp(a) : null;
    if (n && !apps.includes(n) && apps.length < MAX_ALLOW_ENTRIES) apps.push(n);
  }
  const recurrence = normalizeRecurrence(p.recurrence);
  return {
    id: p.id,
    name,
    allowSites: sites,
    allowApps: apps,
    defaultMinutes: normalizeMinutes(p.defaultMinutes) ?? 25,
    ...(recurrence ? { recurrence } : {}),
  };
}

/**
 * Átmehet-e ez a hoszt a munkamenet alatt.
 *
 * Egyezés vagy ALDOMAIN. A `translate.google.com` átmegy, ha a `google.com`
 * engedve van; a `notgoogle.com` NEM — a végén hasonlító tartománynév a
 * leggyakoribb megtévesztés.
 */
export function isSiteAllowed(pack: FocusPack, host: string): boolean {
  const h = (host ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return false;
  return pack.allowSites.some((a) => h === a || h.endsWith(`.${a}`));
}

/**
 * Átmehet-e ez az app.
 *
 * Részleges, kis-nagybetűtől független egyezés MINDKÉT irányban: a beírt
 * „word” engedi a „Microsoft Word” ablakot, és a beírt „Microsoft Word” is
 * engedi a „Word” néven jelentkezőt. Az ablakcímek és a folyamatnevek
 * gépenként és nyelvenként eltérnek — egy pontos egyezésre épülő lista
 * mindenkinél máshogy viselkedne, és senki nem értené, miért.
 */
export function isAppAllowed(pack: FocusPack, app: string): boolean {
  const a = (app ?? '').trim().toLowerCase();
  if (!a) return false;
  return pack.allowApps.some((x) => {
    const y = x.toLowerCase();
    return a === y || a.includes(y) || y.includes(a);
  });
}

/**
 * A munkamenet meghosszabbítása INGYEN van, a rövidítése nem.
 *
 * Ugyanaz a szabály, mint mindenhol az appban: a szigorítás irányába szabad az
 * út. Aki ötven perc helyett hatvanat akar, azt nem akadályozzuk; aki
 * negyvenre rövidítené, az ugyanazt a próbatételt kapja, mint egy feloldásnál.
 */
export function isSessionLoosening(currentEndsAt: number, nextEndsAt: number): boolean {
  return nextEndsAt < currentEndsAt;
}

/** Ahogy a felületen áll: „Nyelvtanulás — 42 perc van hátra”. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 60000));
  if (total >= 60) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m === 0 ? `${h} óra` : `${h} ó ${m} p`;
  }
  return total <= 1 ? 'kevesebb mint egy perc' : `${total} perc`;
}

/**
 * Figyelmeztessünk-e erre az előtérben lévő appra.
 *
 * A munkamenet alatt az appokat NEM tudjuk letiltani — egy futó programot nem
 * lövünk ki, mert az adatot veszíthet, és a Breaker sosem tesz olyat, amit a
 * felhasználó nem kért. Amit tudunk: szólni, hogy ez most nincs a listán.
 *
 * A SAJÁT appunk mindig átmegy. Ha a Breaker ablaka is figyelmeztetést váltana
 * ki, a réteg önmagát hívná elő, és a képernyő használhatatlan lenne.
 */
export function shouldWarnAboutApp(
  pack: FocusPack, appId: string, appName: string,
): boolean {
  const id = (appId ?? '').toLowerCase();
  const name = (appName ?? '').toLowerCase();
  if (!id && !name) return false;
  if (id.includes('breaker') || name.includes('breaker')) return false;
  return !isAppAllowed(pack, appName) && !isAppAllowed(pack, appId);
}

/**
 * Ennél sűrűbben ugyanarra az appra nem szólunk.
 *
 * Egy réteg, ami minden ötödik másodpercben felugrik, nem figyelmeztetés,
 * hanem büntetés — és a felhasználó a munkamenetet fogja kikapcsolni, nem az
 * appot bezárni.
 */
export const APP_WARN_COOLDOWN_MS = 3 * 60_000;

// ---------------------------------------------------------------------------
// A lezárult munkamenetek naplója
// ---------------------------------------------------------------------------
//
// MIÉRT KELL. Az app méri, mire megy el az idő — a munkamenetről viszont eddig
// SEMMI nem maradt. Pedig pont ez az a szám, ami a felhasználóról szól: nem az,
// hogy mennyit volt fenn a YouTube-on, hanem hogy hányszor ült le dolgozni, és
// hányszor állt fel a végénél korábban.
//
// A korán leállítás nem szégyenpad: az adat maga a visszajelzés. Aki látja,
// hogy ötből négyszer leállt, az nem a csomagot fogja hibáztatni, hanem
// rövidebb menetet fog indítani — és az működni fog.

/** Egy lezárult munkamenet. */
export interface FocusLogEntry {
  packId: string;
  /** a csomag neve AKKOR — a csomag azóta átnevezhető vagy törölhető */
  packName: string;
  startedAt: number;
  /** mikor ért véget ténylegesen */
  endedAt: number;
  /** mikorra volt tervezve — ebből látszik, hogy korábban ért-e véget */
  plannedEndsAt: number;
  /** próbatétellel leállítva (igaz), vagy magától lejárt (hamis) */
  stopped: boolean;
}

/** Ennyi lezárult menetet tartunk meg. A statisztika úgyis hetekben gondolkodik. */
export const MAX_FOCUS_LOG = 200;

/** Egy naplósor a futó menetből. */
export function closeRun(
  run: FocusRun, packName: string, endedAt: number, stopped: boolean,
): FocusLogEntry {
  return {
    packId: run.packId,
    packName,
    startedAt: run.startedAt,
    endedAt,
    plannedEndsAt: run.endsAt,
    stopped,
  };
}

/**
 * Egy LEJÁRT menet lezárása a naplóba.
 *
 * A magban van, nem a segédben, mert mind a három platformnak ugyanez kell: a
 * menetet a telefonon is lehet indítani, tehát ott is le kell zárulnia. Ha csak
 * a gép naplózna, aki a telefonján dolgozik, azt látná, hogy a héten le sem ült.
 *
 * @returns az új napló és futás, vagy null, ha nincs teendő
 */
export function closeIfEnded(
  run: FocusRun | null | undefined,
  packs: FocusPack[],
  log: FocusLogEntry[] | undefined,
  now: number,
): { run: null; log: FocusLogEntry[] } | null {
  if (!run || run.endsAt > now) return null;
  const pack = packs.find((p) => p.id === run.packId);
  // A csomag NEVÉT is elmentjük, nem csak az azonosítóját: a csomag azóta
  // átnevezhető vagy törölhető, és egy statisztika, ami „ismeretlen csomag”-ot
  // ír ki a múlt hétre, semmit nem ér.
  const entry = closeRun(run, pack?.name ?? 'Ismeretlen csomag', run.endsAt, false);
  return { run: null, log: [...(log ?? []), entry].slice(-MAX_FOCUS_LOG) };
}

export interface FocusSummary {
  /** hány menet zárult le az ablakban */
  sessions: number;
  /** összesen ennyi ideig tartottak, ezredmásodpercben */
  totalMs: number;
  /** ennyit állítottál le a tervezettnél korábban */
  stoppedEarly: number;
  /** a leggyakoribb csomag neve, ha van */
  topPack: string | null;
}

/**
 * Összegzés egy időablakra.
 *
 * A „korán leállítva” az a sor, amit érdemes nézni: nem a menetek száma
 * mond valamit rólad, hanem az, hányat vittél végig.
 */
export function summarizeFocus(
  log: FocusLogEntry[] | undefined, since: number, now: number,
): FocusSummary {
  const rows = (log ?? []).filter((e) => e.endedAt >= since && e.endedAt <= now);
  let totalMs = 0;
  let stoppedEarly = 0;
  const byPack = new Map<string, number>();
  for (const e of rows) {
    totalMs += Math.max(0, e.endedAt - e.startedAt);
    // Nem a `stopped` jelző dönt, hanem a TÉNY: a próbatétel utáni rövidítés is
    // korai vég, akkor is, ha utána még futott egy darabig.
    if (e.endedAt < e.plannedEndsAt) stoppedEarly++;
    byPack.set(e.packName, (byPack.get(e.packName) ?? 0) + 1);
  }
  let topPack: string | null = null;
  let best = 0;
  for (const [name, count] of byPack) {
    if (count > best) { best = count; topPack = name; }
  }
  return { sessions: rows.length, totalMs, stoppedEarly, topPack };
}

/** Esedékes-e a figyelmeztetés (az előző óta eltelt-e a türelmi idő). */
export function warnDue(lastWarnAt: number | null, now: number): boolean {
  if (lastWarnAt === null) return true;
  return now - lastWarnAt >= APP_WARN_COOLDOWN_MS;
}

// ---------------------------------------------------------------------------
// Ismétlődő munkamenet: a csomag magától indul egy heti ablakban
// ---------------------------------------------------------------------------
//
// MIÉRT. A munkamenet egy mozdulattal indul — de a mozdulatot az embernek kell
// megtennie, és pont a nehéz reggeleken nem teszi meg. Egy ablak
// („hétköznap 9-től 12-ig”) ezt leveszi róla: az idő jön, a menet indul, a
// gépen és a telefonon is.
//
// A SÚRLÓDÁS IRÁNYA ugyanaz, mint mindenhol: felvenni és bővíteni ingyen
// (szigorítás), szűkíteni vagy levenni próbatétel (lazítás) — ez a referee
// dolga, itt csak a kérdés van: lazítás-e.
//
// AZ ABLAK AZ ÍGÉRET, nem a hossz. A menet kezdése mindig az ablak kezdete,
// akkor is, ha az eszköz később ébredt: így minden eszköz UGYANAZT a menetet
// állítja elő (csomag + kezdés), a szinkron nem duplázza, a napló egy sort
// kap. Az óra-ugrás elnyelése ezt a menetet nem tolja el (lásd a referee-t):
// a délben végződő ablak délben végződik, nem tolódik a laptop alvásával.
//
// A NAPLÓ AZ ŐR az újraindítás ellen. Ha a menetet próbatétellel leállítod
// (vagy lerövidíted), a naplóban marad egy sor, ami EBBEN az ablakban
// kezdődött — és amíg ilyen sor van, az ablak nem indít újra. Enélkül a
// következő kör egy perc múlva újraindítaná, és a leállítás próbatétele
// semmit sem érne. A napló szinkronizál, tehát a másik eszköz sem indít újra.
//
// ŐSZINTE KORLÁT: egy eszköz, ami a leállítás idején nem volt hálózaton, a
// szinkron megérkezéséig újraindíthatja a menetet az ablak hátralévő részére.
// A hiba iránya a szigorúbb, és a leállítás ott is ugyanaz a próbatétel.

/** Ennél kevesebb hátralévő idővel már nem indul menetrend szerinti menet. */
export const RECURRENCE_MIN_REMAINING_MS = 60_000;

/** Egy ablak-előfordulás: mikor kezdődik és mikor ér véget (epoch ms). */
export interface Occurrence { startsAt: number; endsAt: number }

/** A sáv hossza percben (éjfélen átnyúlva is). */
export function bandMinutes(b: Band): number {
  return b.endMin > b.startMin ? b.endMin - b.startMin : 1440 - b.startMin + b.endMin;
}

/**
 * Kívülről jött ismétlődés használható alakja, vagy undefined.
 *
 * Érvényes sáv (legalább egy nap, 0–1439 kezdés, 1–1440 vég), és nem hosszabb
 * egy menet plafonjánál: nyolc óránál tovább az ember nem tervez — egy
 * huszonnégy órás „ablak” nem munkamenet lenne, hanem egy kikapcsolhatatlan
 * fehérlista.
 */
export function normalizeRecurrence(raw: unknown): Band | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const b = raw as Partial<Band>;
  const rawDays: unknown[] = Array.isArray(b.days) ? b.days : [];
  const days = [...new Set(rawDays.filter((d): d is Weekday =>
    typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6))].sort((x, y) => x - y);
  const band: Band = { days, startMin: Number(b.startMin), endMin: Number(b.endMin) };
  if (!isValidBand(band)) return undefined;
  if (bandMinutes(band) > MAX_SESSION_MINUTES) return undefined;
  return band;
}

/** Ugyanaz-e a két ismétlődés (vagy egyik sincs). */
export function sameRecurrence(a: Band | null | undefined, b: Band | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const key = (x: Band): string => JSON.stringify([[...x.days].sort(), x.startMin, x.endMin]);
  return key(a) === key(b);
}

/**
 * Lazítás-e az ismétlődés cseréje: van-e olyan perc a következő héten, amikor
 * a régi ablak indítana, az új nem. A levétel mindig az; a felvétel sosem.
 * Ugyanaz a percenkénti mintavétel, mint az oldalak menetrendjénél.
 */
export function isRecurrenceLoosening(
  current: Band | null | undefined, next: Band | null | undefined, now: number,
): boolean {
  if (!current) return false;
  if (!next) return true;
  return isLoosening(
    { mode: 'scheduled_block', bands: [current] },
    { mode: 'scheduled_block', bands: [next] },
    now,
  );
}

/** Egy helyi időpont: a `now` napjától `dayOffset` nappal, `min` perccel éjfél után. */
function localAt(now: number, dayOffset: number, min: number): number {
  const d = new Date(now);
  // A Date konstruktor a túlcsordulást normalizálja (32-e a következő hónap
  // elseje, a 24:00 a következő nap nulla órája), és mezőkkel számol: az
  // óraátállás napján a 9:00 az a 9:00, nem éjfél plusz ötszáznegyven perc.
  return new Date(
    d.getFullYear(), d.getMonth(), d.getDate() + dayOffset + Math.floor(min / 1440),
    Math.floor((min % 1440) / 60), min % 60,
  ).getTime();
}

/**
 * A sáv MOSTANI előfordulása — vagy null, ha `now` nincs benne.
 *
 * Ugyanaz a három eset, mint a menetrend `inAnyBand`-jében: aznapi sáv;
 * éjfélen átnyúló sáv a kezdőnapon; és a kezdőnap utáni hajnal.
 */
export function occurrenceAt(band: Band, now: number): Occurrence | null {
  const d = new Date(now);
  const day = d.getDay() as Weekday;
  const minute = d.getHours() * 60 + d.getMinutes();
  const prevDay = ((day + 6) % 7) as Weekday;
  if (band.endMin > band.startMin) {
    if (band.days.includes(day) && minute >= band.startMin && minute < band.endMin) {
      return { startsAt: localAt(now, 0, band.startMin), endsAt: localAt(now, 0, band.endMin) };
    }
    return null;
  }
  if (band.days.includes(day) && minute >= band.startMin) {
    return { startsAt: localAt(now, 0, band.startMin), endsAt: localAt(now, 1, band.endMin) };
  }
  if (band.days.includes(prevDay) && minute < band.endMin) {
    return { startsAt: localAt(now, -1, band.startMin), endsAt: localAt(now, 0, band.endMin) };
  }
  return null;
}

/**
 * A sáv KÖVETKEZŐ előfordulása: a mostani, ha `now` benne van, különben a
 * legközelebbi kezdés a következő héten. A felület ebből mondja ki, mikor
 * indul legközelebb a csomag — egy ablak, amiről nem tudni, mikor jön, nem
 * megnyugtató, hanem meglepetés. Naponta egy jelölt: a kezdőnap sáv-napja.
 */
export function nextOccurrence(band: Band, now: number): Occurrence | null {
  const current = occurrenceAt(band, now);
  if (current) return current;
  for (let d = 0; d <= 7; d++) {
    const start = localAt(now, d, band.startMin);
    if (start < now) continue;
    if (!band.days.includes(new Date(start).getDay() as Weekday)) continue;
    const occ = occurrenceAt(band, start);
    if (occ) return occ;
  }
  return null;
}

/**
 * Most tűnt-e fel egy ABLAK szerint indult menet — a felület ebből értesít.
 * Akkor is, ha az app később nyílt meg, mint ahogy a menet indult: aki nem
 * maga indította, tudja meg, miért van minden zárva. Ugyanaz a menet kétszer
 * nem szól; a kézzel indított menet nem szól, azt a felhasználó indította.
 */
export function windowRunStarted(
  prev: FocusRun | null | undefined,
  next: FocusRun | null | undefined,
  packs: FocusPack[],
  now: number,
): FocusRun | null {
  if (!next || next.endsAt <= now) return null;
  if (prev && prev.packId === next.packId && prev.startedAt === next.startedAt) return null;
  return isWindowRun(next, packs) ? next : null;
}

export interface DueRecurrence extends Occurrence { pack: FocusPack }

/**
 * Melyik csomag ablaka esedékes MOST — vagy null.
 *
 * Nem indul, ha fut valami (egyszerre egy menet); ha a naplóban van EBBEN az
 * ablakban kezdődött menet ebből a csomagból (leállítva vagy lerövidítve — a
 * próbatétel ára ki van fizetve); vagy ha egy percnél kevesebb van hátra.
 * Több esedékes ablak közül a korábban kezdődő, azonos kezdésnél a kisebb
 * azonosítójú — hogy minden eszköz ugyanazt válassza.
 */
export function dueRecurrence(
  packs: FocusPack[],
  run: FocusRun | null | undefined,
  log: FocusLogEntry[] | undefined,
  now: number,
): DueRecurrence | null {
  if (isRunning(run, now)) return null;
  let best: DueRecurrence | null = null;
  for (const pack of packs) {
    const band = pack.recurrence;
    if (!band || !isValidBand(band)) continue;
    const occ = occurrenceAt(band, now);
    if (!occ) continue;
    if (occ.endsAt - now < RECURRENCE_MIN_REMAINING_MS) continue;
    const spent = (log ?? []).some((e) =>
      e.packId === pack.id && e.startedAt >= occ.startsAt && e.startedAt < occ.endsAt);
    if (spent) continue;
    if (!best || occ.startsAt < best.startsAt
      || (occ.startsAt === best.startsAt && pack.id < best.pack.id)) {
      best = { pack, ...occ };
    }
  }
  return best;
}

/**
 * Ablak-menet-e ez a futás: a csomag ismétlődésének egy előfordulása, pontosan
 * annak kezdésével és végével. Az ilyen menetet az óra-ugrás elnyelése nem
 * tolja el — az ablak vége az ablak vége. A meghosszabbított menet már nem az.
 */
export function isWindowRun(run: FocusRun, packs: FocusPack[]): boolean {
  const band = packs.find((p) => p.id === run.packId)?.recurrence;
  if (!band) return false;
  const occ = occurrenceAt(band, run.startedAt);
  return !!occ && occ.startsAt === run.startedAt && occ.endsAt === run.endsAt;
}
