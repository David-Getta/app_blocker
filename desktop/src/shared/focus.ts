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
  return {
    id: p.id,
    name,
    allowSites: sites,
    allowApps: apps,
    defaultMinutes: normalizeMinutes(p.defaultMinutes) ?? 25,
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
