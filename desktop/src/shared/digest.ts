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

import type { FocusSummary } from './focus.js';

/** Hétfőn ettől az órától esedékes (helyi idő). */
export const DIGEST_HOUR = 7;

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
  /** ez a hét az előzőhöz képest, célonként */
  weekOverWeek: { label: string; thisWeek: number; deltaPct: number | null }[];
  /** a munkamenetek összegzése az elmúlt 7 napra */
  focusWeek: FocusSummary;
  /** feloldások az elmúlt 7 napban */
  unlocks7d: number;
  /** van-e egyáltalán mért nap */
  daysTracked: number;
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
    const top = input.topWeekSites[0];
    if (top && top.seconds > 0) {
      const trend = input.weekOverWeek.find((w) => w.label === top.label);
      const delta = trend && trend.deltaPct !== null && Math.abs(trend.deltaPct) > 5
        ? ` (${trend.deltaPct > 0 ? '▲ +' : '▼ '}${Math.round(trend.deltaPct)}% az előző héthez képest)`
        : '';
      line += `; a legtöbb: ${labelOf(top.label)} ${hm(top.seconds)}${delta}`;
    }
    parts.push(`${line}.`);
  }
  const f = input.focusWeek;
  if (f.sessions > 0) {
    const early = f.stoppedEarly > 0 ? `, ${f.stoppedEarly} korán leállítva` : ', mind végigvive';
    parts.push(`${f.sessions} menet (${hm(f.totalMs / 1000)}${early}).`);
  }
  if (input.unlocks7d > 0) parts.push(`${input.unlocks7d} feloldás.`);
  else if (measured || f.sessions > 0) parts.push('Feloldás nélkül.');
  if (parts.length === 0) return null;
  return `Elmúlt 7 nap: ${parts.join(' ')}`;
}
