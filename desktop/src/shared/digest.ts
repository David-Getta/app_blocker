// Heti visszatekintés: hétfő reggel egy értesítés az elmúlt hét napról.
//
// MIÉRT. A statisztika ott van az appban — de oda be kell menni, és pont az
// nem megy be, akinek a legtöbbet mondaná. Egy hétfő reggeli mondat viszont
// magától jön: mennyi ment el, mire a legtöbb, hányszor ültél le dolgozni,
// hányszor oldottál fel. Nem ítélet, hanem tükör — ugyanaz a hang, mint a
// statisztikáé: a „korán leállítva” sor nem szégyenpad, a „feloldás nélkül”
// viszont igenis kimondható.
//
// ŐSZINTE KORLÁT. Csak akkor szól, ha az app fut — a háttérben ülő védelem
// magától nem tud értesíteni. Ha hétfő reggel nem futott, az első megnyitáskor
// szól, még azon a héten; a következő hétfőn már a következőről. Egy hétről
// EGYSZER, gépenként.
//
// A számok a mérés és a napló GÖRDÜLŐ hét napja (az elmúlt 7 nap), nem a
// naptári hét — pontosan az, amit a statisztika is mutat. A felirat ezt
// mondja, nem „múlt hét”-et.
//
// Pure: a felület adja az időt, a tárolt kulcsot és a címkézést (rejtett lista,
// fedőnév) — az értesítés sem szivárogtathat ki olyan címet, amit a lista elrejt.

import { focusWeekdayText, type FocusSummary } from './focus.js';
import { hourLabel, peakWeekdayText } from './browser-hits.js';

/** Hétfőn ettől az órától esedékes (helyi idő). */
export const DIGEST_HOUR = 7;

/**
 * Hány napja volt az utolsó feloldás — vagy null, ha még egy sem volt.
 *
 * NAPTÁRI napokban, nem huszonnégy órás egységekben: a tegnap esti feloldás
 * „tegnap”, akkor is, ha tíz órája volt — az ember napokban gondolkodik. A
 * „feloldás nélkül” ugyanúgy kimondható tény, mint a nehézségi szint: a
 * statisztika és a visszatekintés is ezt a hangot üti meg. Itt él, nem a
 * `challenges.ts`-ben, mert a felület is használja, az pedig a Node
 * `crypto`-t nem látja.
 */
export function daysSinceUnlock(unlockLog: number[], now: number): number | null {
  if (unlockLog.length === 0) return null;
  const last = Math.max(...unlockLog);
  const dayStart = (t: number): number => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  return Math.max(0, Math.round((dayStart(now) - dayStart(last)) / 86_400_000));
}

/** A hét kulcsa: a hétfő helyi dátuma, ÉÉÉÉ-HH-NN. */
export function weekKey(now: number): string {
  const d = new Date(now);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${monday.getFullYear()}-${p(monday.getMonth() + 1)}-${p(monday.getDate())}`;
}

/**
 * Esedékes-e a visszatekintés: ezen a héten még nem volt, és hétfő reggel
 * DIGEST_HOUR már elmúlt. Ha igen, a hét kulcsát adja — ezt kell eltenni.
 */
export function digestDue(lastKey: string | null | undefined, now: number): string | null {
  const key = weekKey(now);
  if (lastKey === key) return null;
  const [y, m, d] = key.split('-').map(Number);
  const dueAt = new Date(y, m - 1, d, DIGEST_HOUR, 0).getTime();
  return now >= dueAt ? key : null;
}

export interface DigestInput {
  /** az elmúlt 7 nap mért ideje, másodpercben */
  last7Seconds: number;
  /** a hét legtöbb idejét vivő oldalak, a legnagyobb elöl */
  topWeekSites: { label: string; seconds: number; blocked?: boolean }[];
  /**
   * A hét legtöbb idejét vivő appok, a legnagyobb elöl. Nem kötelező (régi
   * hívó). A mért idő az appokat is tartalmazza — ha a legnagyobb egy app,
   * a mondat enélkül hazudna: „7 óra; a legtöbb: youtube.com 40 perc”.
   */
  topWeekApps?: { label: string; seconds: number }[];
  /** ez a hét az előzőhöz képest, célonként */
  weekOverWeek: { label: string; thisWeek: number; deltaPct: number | null }[];
  /** a munkamenetek összegzése az elmúlt 7 napra */
  focusWeek: FocusSummary;
  /** az előző hét menetei — a hét az előző héthez képest; nem kötelező (régi hívó) */
  focusPrevWeek?: FocusSummary;
  /** feloldások az elmúlt 7 napban */
  unlocks7d: number;
  /** az előző hét feloldásai — a hét az előző héthez képest; nem kötelező (régi hívó) */
  unlocksPrev7d?: number;
  /**
   * Félbemaradt kísérletek az elmúlt 7 napban — feladva, lejárva, lecsúszva,
   * elszállva, újraindítva. Nem kötelező (régi hívó). A tükör másik fele a
   * feloldások mellett: hányszor indult el a lazítás, és nem vitte végig.
   */
  dropped7d?: number;
  /** a keret betelt napjai az elmúlt 7 napon (ezen a gépen mérve) — dolgozik-e a keret; nem kötelező */
  limitFullDays?: number;
  /** adag-betelések az elmúlt 7 napon, minden oldalon összesen (a könyvből) — a szabály dolgozik-e; nem kötelező */
  burstTripsWeek?: number;
  /**
   * A böngésző megakadásai az elmúlt 7 napban — hányszor vitt a tiltó lapra
   * a bővítmény. Nem kötelező (régi hívó, telefon). A tükör harmadik fele:
   * a tiltás akkor dolgozik, amikor az ember nem figyel — ez mondja, mennyit.
   */
  browserHits7d?: number;
  /** az azt megelőző 7 nap — a hét az előző héthez képest; nulla, ha nem volt (vagy a könyv akkor kezdődött) */
  browserHitsPrev7d?: number;
  /** a hét csúcs-órája a böngésző megakadásaira — mikor jár a kéz magától; null, ha nem volt */
  browserHitsPeak?: { hour: number; count: number } | null;
  /** a csomag neve, amelynek heti ablaka fedi a csúcs-órát — a menet magától indul, amikor a kéz indulna; null, ha egyik sem */
  browserHitsPeakPack?: string | null;
  /** a csúcs-órára LEHETNE ablakot tenni: van csomag ablak nélkül, és a csúcs-órát semmi nem fedi — a mondat kimondja */
  peakWindowOffer?: boolean;
  /** a négy hét csúcs-napja a böngésző megakadásaira (0 = vasárnap) — a statisztika sora a mondatban; null, ha nem volt */
  browserHitsWeekday?: { day: number; count: number } | null;
  /** a négy hét menet-napja (0 = vasárnap; szám) — melyik napon ülsz le a legtöbbször; null, ha nem volt */
  focusWeekday?: { day: number; count: number } | null;
  /** a hét csúcs-oldala (nyers név, a címkézés a mondaté) — melyik oldal akaszt meg a legtöbbször */
  browserHitsTop?: { label: string; count: number } | null;
  /** van-e egyáltalán mért nap */
  daysTracked: number;
  /**
   * A hét legnagyobb, NEM tiltott idővivői (a felvevő kártya javaslata), a
   * legnagyobb elöl. Nem kötelező: régi hívó vagy mérés nélkül üres.
   */
  unblockedTop?: { label: string; seconds: number }[];
}

/** „2 ó 40 p” / „58 p” — mint a statisztika csempéin. */
export function hm(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} ó ${m} p` : `${m} p`;
}

/**
 * A visszatekintés szövege — vagy null, ha nincs miről beszélni (se mérés, se
 * menet, se feloldás): egy üres értesítés zaj lenne, nem tükör.
 *
 * A `labelOf` a felület címkézése: rejtett listánál sorszám, fedőnévnél a
 * fedőnév — az értesítés ugyanazt a szabályt követi, mint a statisztika.
 */
export function digestText(input: DigestInput, labelOf: (label: string) => string): string | null {
  const parts: string[] = [];
  const measured = input.daysTracked > 0 && input.last7Seconds > 0;
  if (measured) {
    let line = `${hm(input.last7Seconds)} mért idő`;
    // A trend csak öt százalék fölött mondat: alatta zaj, nem irány.
    const trendOf = (label: string): string => {
      const trend = input.weekOverWeek.find((w) => w.label === label);
      return trend && trend.deltaPct !== null && Math.abs(trend.deltaPct) > 5
        ? ` (${trend.deltaPct > 0 ? '▲ +' : '▼ '}${Math.round(trend.deltaPct)}% az előző héthez képest)`
        : '';
    };
    const top = input.topWeekSites[0];
    if (top && top.seconds > 0) {
      line += `; a legtöbb: ${labelOf(top.label)} ${hm(top.seconds)}${trendOf(top.label)}`;
    }
    // Az app külön: a telefonon a legtöbb idő appban megy el, nem oldalon, és
    // a gépen is lehet, hogy a Slack vitte — a mért időben benne van.
    const app = input.topWeekApps?.[0];
    if (app && app.seconds > 0) {
      line += `; appban a legtöbb: ${labelOf(app.label)} ${hm(app.seconds)}${trendOf(app.label)}`;
    }
    parts.push(`${line}.`);
  }
  const f = input.focusWeek;
  const p = input.focusPrevWeek ?? null;
  // Az előző hét a menetek mellett — irány, nem ítélet. Üres előző hét nem
  // összehasonlítás; a menet nélküli hét viszont mondat, ha volt mihez mérni.
  const prevFocus = p && p.sessions > 0 ? `, az előző héten ${p.sessions} (${hm(p.totalMs / 1000)})` : '';
  if (f.sessions > 0) {
    const early = f.stoppedEarly > 0 ? `, ${f.stoppedEarly} korán leállítva` : ', mind végigvive';
    // A HETI ABLAKBÓL indult menetek: dolgozik-e az ablak — csak ha volt ilyen.
    const win = f.windowRuns > 0 ? `, ${f.windowRuns} ablakból` : '';
    parts.push(`${f.sessions} menet (${hm(f.totalMs / 1000)}${early}${win})${prevFocus}.`);
  } else if (prevFocus) {
    parts.push(`Menet nélkül${prevFocus}.`);
  }
  // A MENET-NAP: melyik napon ülsz le a legtöbbször — négy hétből, a statisztika
  // mondata szó szerint; a csúcs-nap tükre. Nincs nap, nincs mondat.
  const focusDay = input.focusWeekday ?? null;
  if (focusDay) parts.push(focusWeekdayText(focusDay));
  // A félbemaradt kísérlet a feloldások mellé kerül — vagy helyettük: egy
  // elindított és félbehagyott lazítás is történés, ha feloldás nem is lett.
  const dropped = input.dropped7d ?? 0;
  const droppedPart = dropped > 0 ? `, ${dropped} félbemaradt kísérlet` : '';
  // Az előző hét feloldásai a szám mellett, zárójelben — irány, nem ítélet;
  // üres előző hét nem összehasonlítás. A tükör harmadik mércéje is két hetet mond.
  const prevUnl = input.unlocksPrev7d ?? 0;
  const prevUnlPart = prevUnl > 0 ? ` (az előző héten ${prevUnl})` : '';
  if (input.unlocks7d > 0) parts.push(`${input.unlocks7d} feloldás${prevUnlPart}${droppedPart}.`);
  else if (dropped > 0) parts.push(`Feloldás nélkül${prevUnlPart}${droppedPart}.`);
  else if (measured || f.sessions > 0 || prevUnl > 0) parts.push(`Feloldás nélkül${prevUnlPart}.`);
  // A keret betelt napjai: dolgozik-e a keret — tény, nem ítélet. Nulla nem mondat.
  const fullDays = input.limitFullDays ?? 0;
  if (fullDays > 0) parts.push(`A napi keret ${fullDays} napon betelt.`);
  // Az adag a héten: hányszor telt be — a szabály dolgozik-e. Nulla nem mondat.
  const burstWeek = input.burstTripsWeek ?? 0;
  if (burstWeek > 0) parts.push(`Az adag a héten ${burstWeek}× telt be.`);
  // A megakadás: hányszor állította meg a böngésző — tény, nem ítélet.
  const hits = input.browserHits7d ?? 0;
  const prev = input.browserHitsPrev7d ?? 0;
  const peak = input.browserHitsPeak ?? null;
  const top = input.browserHitsTop ?? null;
  // Az előző hét a szám mellett, zárójelben — irány, nem ítélet. Nulla előző
  // hét nem összehasonlítás; a nulla hét viszont mondat, ha volt mihez mérni.
  const prevPart = prev > 0 ? ` (az előző héten ${prev})` : '';
  if (hits > 0) {
    // A lefedett csúcs-óra a csúcs mellett, zárójelben: a menet magától indul, amikor a kéz indulna.
    // Ha nem fedi semmi, de lehetne: „nincs rá ablak” — tükör, nem ítélet; a gomb a statisztikán vár.
    const covered = input.browserHitsPeakPack ? ` (magától indul: ${input.browserHitsPeakPack})`
      : (input.peakWindowOffer ? ' (nincs rá ablak)' : '');
    parts.push(`${hits} megakadás a böngészőben${prevPart}${peak ? `, a csúcs ${hourLabel(peak.hour)}${covered}` : ''}`
      + `${top ? `, a legtöbbször: ${labelOf(top.label)} (${top.count}×)` : ''}.`);
  } else if (prev > 0) {
    parts.push(`Megakadás nélkül a böngészőben${prevPart}.`);
  }
  // A csúcs-nap: melyik napon akad meg a kéz a legtöbbször — négy hétből, a
  // statisztika mondata szó szerint. Nincs nap, nincs mondat.
  const weekday = input.browserHitsWeekday ?? null;
  if (weekday) parts.push(peakWeekdayText(weekday));
  // A tükör másik fele: ami sokat vitt, és nincs a listán. Egy név, a
  // legnagyobb — a többi a felvevő kártyán vár, egy kattintásra.
  const open = input.unblockedTop?.[0];
  if (measured && open && open.seconds > 0) {
    parts.push(`Nincs tiltva, de sokat vitt: ${labelOf(open.label)} ${hm(open.seconds)}.`);
  }
  if (parts.length === 0) return null;
  return `Elmúlt 7 nap: ${parts.join(' ')}`;
}

// ------------------------------------------------------------------ NAPLÓ
//
// A hétfői mondat elszáll az értesítéssel; a napló megtartja. Fél év hetei
// egy-egy sorban: a pálya látszik, nem csak a pillanat — tükör, nem ítélet.
// Eszközönként, mint a hét kulcsa: a gép a saját hetét mondja, a telefon a
// magáét.

/** Egy hét a naplóban: a hét kulcsa (a hétfő dátuma) és a mondat. */
export interface DigestEntry { week: string; text: string }

/** Ennyi hetet őrzünk — fél év. Több már nem tükör, hanem archívum. */
export const MAX_DIGEST_LOG = 26;

const WEEK_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** A napló sora mondat, nem esszé; a mag mondata ennél jóval rövidebb. */
const MAX_DIGEST_TEXT = 500;

/**
 * Egy hét mondata a naplóba: a hétnek egy sora van (az újabb felülír), a
 * lista a legfrissebbel kezdődik, a plafonnál a legrégebbi esik. Üres mondat
 * (null) nem sor: egy hét, amiről nem volt mit mondani, a naplóban sem mond
 * semmit — de a hét régi sorát sem hagyja ott.
 */
export function recordDigest(log: DigestEntry[], week: string, text: string | null): DigestEntry[] {
  const kept = log.filter((e) => e.week !== week);
  if (text) kept.push({ week, text });
  return cleanDigestLog(kept);
}

/**
 * A tárból jött napló megtisztítva: csak a jó alakú sorok, hetenként egy (az
 * utolsó marad), a legfrissebb elöl, a plafonig. A tár bármit adhat — régi
 * verzió, kézi szerkesztés —, és ami nem sor, az nem sor.
 */
export function cleanDigestLog(value: unknown): DigestEntry[] {
  if (!Array.isArray(value)) return [];
  const byWeek = new Map<string, string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const { week, text } = raw as { week?: unknown; text?: unknown };
    if (typeof week !== 'string' || !WEEK_KEY.test(week)) continue;
    if (typeof text !== 'string' || text.trim() === '') continue;
    byWeek.set(week, text.trim().slice(0, MAX_DIGEST_TEXT));
  }
  return [...byWeek.entries()]
    .map(([week, text]) => ({ week, text }))
    .sort((a, b) => (a.week < b.week ? 1 : a.week > b.week ? -1 : 0))
    .slice(0, MAX_DIGEST_LOG);
}

/** A napló sorának feje: a hét kulcsa olvashatóan — „2026. 09. 07.” */
export function weekLabel(week: string): string {
  return `${week.replace(/-/g, '. ')}.`;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A napló sora a MOSTANI címkézéssel. Ami akkor a valódi címmel szólt, az a
 * fedőnév felvétele vagy a lista elrejtése után is a lista címkéjével jelenik
 * meg — a napló sem szivárogtathat ki olyan címet, amit a lista elrejt. A cím
 * társneveit (m., youtu.be) és az aloldalait is a listázott oldal címkéje
 * fedi; ami nincs a listán, az marad, ahogy volt.
 */
export function relabelDigest(
  text: string, sites: { domain: string; hostnames?: string[] }[], labelOf: (domain: string) => string,
): string {
  let out = text;
  for (const site of sites) {
    const label = labelOf(site.domain);
    if (label === site.domain) continue;
    for (const name of [site.domain, ...(site.hostnames ?? [])]) {
      if (!name) continue;
      const re = new RegExp(`(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\\.)*${escapeRe(name)}(?![A-Za-z0-9-])`, 'g');
      out = out.replace(re, () => label);
    }
  }
  return out;
}
