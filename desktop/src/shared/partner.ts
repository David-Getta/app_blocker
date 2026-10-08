// PÁRBAN ZÁROLÁS: a lazítás végén egy MEGBÍZOTT jelmondata is kell.
//
// MIÉRT. A próbatétel a saját impulzusod ellen véd: munkába kerül, de egyedül
// is meg lehet csinálni. Van, akinek ez kevés — neki az kell, hogy a lazítás
// ne csak drága legyen, hanem MÁS EMBER döntése is. A párban zárolás ezt
// adja: kiválasztasz egy megbízottat (társ, barát, szülő), aki egy jelmondatot
// kap; és minden lazító próbatétel UTOLSÓ lépése az, hogy ő beírja. Nem
// helyetted csinálja végig — a munka a tiéd —, csak az utolsó szót ő mondja ki.
//
// A SZABÁLY UGYANAZ, mint mindenhol: felvenni ingyen (szigorítás), levenni
// próbatétel — a megbízott jelmondatával a végén, tehát a levételhez is ő
// kell. A jelmondatot az app sorsolja, egyszer mutatja meg, és csak a
// lenyomatát (scrypt) tárolja: a gépről és a szinkronból nem olvasható ki.
//
// ŐSZINTE HATÁR, kimondva: ez nem gépzár. Aki rendszergazdaként a segéd
// állapotfájljába nyúl, az a lenyomatot is le tudja venni — ahogy a zárlatot
// is. Az impulzus ellen véd, nem a szándék ellen; és a megbízott a
// jelmondatot bármikor átadhatja — az ő döntése, pont ez a lényeg.
//
// Ez a fájl TISZTA (nincs Node-függőség): a felület is betölti. A lenyomat
// számolása a segédben van (helper/partner-crypto.ts), mert az scrypt a Node
// `crypto`-ja. A Kotlin és a Swift oldal ugyanezt tükrözi (Partner.kt,
// Partner.swift), a lenyomat pedig nyelvfüggetlen: a jelmondat egy eszközön
// születik, és bármelyik másikon ellenőrizhető.

import { CONTROL_CHARS } from './alias.js';

/** A jelmondat szavainak száma — a próbatételek szólistájából. */
export const PARTNER_PHRASE_WORDS = 4;
/** A megbízott nevének hossza felülről kötve — a felületen is ki kell férnie. */
export const MAX_PARTNER_NAME = 40;
/** Ennyi rossz jelmondat után a kísérlet érvénytelen: elölről, minden lépéssel. */
export const MAX_PARTNER_TRIES = 5;

export interface PartnerLock {
  /** a megbízott neve, ahogy a felület mondja: „Kérd meg Annát” */
  name: string;
  /** a lenyomat sója, base64 — eszközönként más, ha újra felveszik */
  salt: string;
  /** a jelmondat scrypt-lenyomata, base64 — a jelmondat maga sehol nincs */
  hash: string;
  /** mikor vették fel */
  setAt: number;
}

/**
 * A jelmondat KANONIKUS alakja — ezt hasoljuk, és ezt hasonlítjuk. Kis-nagybetű,
 * dupla szóköz, sorvégi szóköz nem számít: a megbízott nem gépíró, a jelmondat
 * meg nem jelszó, hanem négy szó. NFKC, hogy ugyanaz a leütött szöveg ugyanaz
 * a bájtsor legyen minden platformon (ékezetes szónál ez nem elmélet).
 */
export function normalizePhrase(raw: string): string {
  return raw.normalize('NFKC').replace(CONTROL_CHARS, ' ').trim().toLowerCase().split(/\s+/).join(' ');
}

/** A megbízott neve tisztán — vagy null, ha nem maradt belőle semmi. */
export function normalizePartnerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.normalize('NFKC').replace(CONTROL_CHARS, ' ').trim().split(/\s+/).join(' ');
  if (cleaned === '') return null;
  // Kódpontban vágva; a vágás szóköz elé eshet, és a lógó szóköz nélkül a
  // tiszta alak tiszta alakja is ugyanaz (a fixtúra ezt számon kéri).
  return [...cleaned].slice(0, MAX_PARTNER_NAME).join('').trim();
}

/** A tárból vagy a szinkronból jött rekord, ha jó alakú — különben semmi. */
export function normalizePartnerLock(raw: unknown): PartnerLock | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<PartnerLock>;
  const name = normalizePartnerName(o.name);
  if (!name) return null;
  if (typeof o.salt !== 'string' || !/^[A-Za-z0-9+/=]{16,64}$/.test(o.salt)) return null;
  if (typeof o.hash !== 'string' || !/^[A-Za-z0-9+/=]{32,96}$/.test(o.hash)) return null;
  const setAt = typeof o.setAt === 'number' && Number.isFinite(o.setAt) ? o.setAt : 0;
  return { name, salt: o.salt, hash: o.hash, setAt };
}

/** A rekord tartalmi kulcsa a lenyomatokhoz és az összevetéshez. */
export function partnerKey(p: PartnerLock | null | undefined): string {
  return p ? [p.salt, p.hash, p.name, p.setAt].join('|') : '';
}

/** Ennél több élő megbízott nem lehet egyszerre (a fésülés plafonja). */
export const MAX_PARTNERS = 8;
/** Ennyi levett megbízott nyomát hordozzuk — a legutóbb levettekét. */
export const MAX_PARTNERS_GONE = 32;

/**
 * A megbízott AZONOSSÁGA: a só és a lenyomat. Minden felvételnél új (a só
 * véletlen), tehát két felvétel sosem ugyanaz — akkor sem, ha a név egyezik.
 */
export function partnerId(p: PartnerLock): string {
  return `${p.salt}|${p.hash}`;
}

/** Egy levett megbízott nyoma: az azonossága, és mikor vették le (csak a plafon sorrendjéhez). */
export interface PartnerGone {
  /** a levett megbízott azonossága (`partnerId`: só|lenyomat) */
  id: string;
  /** mikor vették le — csak a plafon sorrendjéhez, a biztonság nem múlik rajta */
  at: number;
}

const GONE_ID = /^[A-Za-z0-9+/=]{16,64}\|[A-Za-z0-9+/=]{32,96}$/;

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A levett megbízottak nyoma tisztán: jó alakú azonosság, egyszer (a később
 * levett időpontjával), a legutóbb levettek elöl, a plafonig.
 */
export function cleanPartnersGone(raw: unknown): PartnerGone[] {
  if (!Array.isArray(raw)) return [];
  const at = new Map<string, number>();
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Partial<PartnerGone>;
    if (typeof o.id !== 'string' || !GONE_ID.test(o.id)) continue;
    const t = typeof o.at === 'number' && Number.isSafeInteger(o.at) && o.at >= 0 ? o.at : 0;
    at.set(o.id, Math.max(at.get(o.id) ?? 0, t));
  }
  return [...at.entries()].map(([id, t]) => ({ id, at: t }))
    .sort((x, y) => (y.at - x.at) || codeUnitCompare(x.id, y.id))
    .slice(0, MAX_PARTNERS_GONE);
}

/** A társ-megbízottak (a fő mellett élők) tisztán: csak a jó alakúak. */
export function cleanPartnerList(raw: unknown): PartnerLock[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizePartnerLock).filter((p): p is PartnerLock => p !== null);
}

/**
 * A megbízottak egy eszközön: a FŐ megbízott (a legkorábban felvett), a
 * mellette élő TÁRSAK, és a levettek nyoma.
 */
export interface PartnerSet {
  partner?: PartnerLock;
  partnerCo?: PartnerLock[];
  partnersGone?: PartnerGone[];
}

/** Az összes élő megbízott: a fő, aztán a társak. */
export function livePartners(s: PartnerSet): PartnerLock[] {
  return [...(s.partner ? [s.partner] : []), ...(s.partnerCo ?? [])];
}

/**
 * A megbízottak fésülése két eszköz között — AZONOSSÁG szerint, nem jel
 * szerint.
 *
 * MIÉRT. Eddig a nagyobb jel nyert, és a jelet bármelyik ingyenes szerkesztés
 * lépteti: egy friss (vagy a felvétel előtti, elavult) eszközön pár
 * csomag-átnevezés után a saját magad választotta megbízott, felhúzott jellel,
 * minden eszközön leváltotta a valódit — és onnantól minden lazítás végén a
 * te jelmondatod kellett. A megbízott pont attól ér valamit, hogy NEM a te
 * döntésed.
 *
 * Ezért most:
 *
 *   - élő megbízottat csak a NYOMA visz el (`partnersGone`): az pedig csak a
 *     levétel próbatételéből születik, aminek a végén az ő jelmondata állt —
 *     tehát ő bólintott rá;
 *   - ha két eszközön KÜLÖNBÖZŐ élő megbízott van (két eszközön egymástól
 *     függetlenül felvéve — vagy a fenti trükkel), mindkettő megmarad: a
 *     legkorábban felvett a fő, a többi TÁRS, és a lazítás végén mindegyik
 *     jelmondata kell. Egy friss eszközön felvett saját megbízott így semmit
 *     nem ér: a valódi jelmondata ugyanúgy kell.
 *
 * A sorrend (felvétel ideje, aztán az azonosság) csak a megjelenítésé — a
 * biztonság nem múlik rajta. Ugyanaz az azonosság két alakban (csak sérült
 * adatból): a kisebb kulcsú. Plafon: legfeljebb nyolc élő (a legkorábban
 * felvettek), és a legutóbb levett harminckettő nyoma; a nyom kiesése
 * legfeljebb feltámaszt egy levettet (szigorúbb irány).
 */
export function mergePartners(a: PartnerSet, b: PartnerSet): PartnerSet {
  const both = [...(a.partnersGone ?? []), ...(b.partnersGone ?? [])];
  const allGone = cleanPartnersGone(both);
  // A nyom a plafon ELŐTT öl: ami ebben a fésülésben levett, az nem él — a
  // tárolt lista vágása legfeljebb egy későbbi fésülésben támaszthat fel.
  const dead = new Set(both.filter((g) => GONE_ID.test(g.id)).map((g) => g.id));
  const byId = new Map<string, PartnerLock>();
  for (const p of [...livePartners(a), ...livePartners(b)]) {
    const id = partnerId(p);
    if (dead.has(id)) continue;
    const had = byId.get(id);
    if (!had || codeUnitCompare(partnerKey(p), partnerKey(had)) < 0) byId.set(id, p);
  }
  const live = [...byId.values()]
    .sort((x, y) => (x.setAt - y.setAt) || codeUnitCompare(partnerId(x), partnerId(y)))
    .slice(0, MAX_PARTNERS);
  return {
    ...(live.length > 0 ? { partner: live[0] } : {}),
    ...(live.length > 1 ? { partnerCo: live.slice(1) } : {}),
    ...(allGone.length > 0 ? { partnersGone: allGone } : {}),
  };
}

/**
 * A megbízottak a levétel után: akiknek a jelmondata ebben a próbatételben
 * elhangzott (`ids`), azok nyomot kapnak és kiesnek; aki közben (a
 * szinkronból) érkezett, és nem bólintott, marad.
 */
export function removePartners(s: PartnerSet, ids: string[], at: number): PartnerSet {
  const gone = [...(s.partnersGone ?? []), ...ids.map((id) => ({ id, at: Math.max(0, Math.floor(at)) }))];
  return mergePartners({ ...s, partnersGone: gone }, {});
}

/**
 * A megbízottak tartalmi kulcsa — a lenyomathoz és az összevetéshez. Társ és
 * nyom nélkül PONTOSAN a régi (`partnerKey`): a frissítés után a lenyomat nem
 * változik, tehát egy eszköz sem léptet fölöslegesen.
 */
export function partnersKey(s: PartnerSet): string {
  const co = s.partnerCo ?? [];
  const gone = s.partnersGone ?? [];
  if (co.length === 0 && gone.length === 0) return partnerKey(s.partner);
  return `${[partnerKey(s.partner), ...co.map(partnerKey)].join(';')}#${gone.map((g) => `${g.id}@${g.at}`).join(';')}`;
}
