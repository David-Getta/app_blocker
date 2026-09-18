// KULCSSZÓ-SZABÁLYOK: bármely oldalon, ha a cím tartalmazza.
//
// A blokklista egész oldalakat lát (a DNS a hosztnévnél tovább nem lát), a
// részleges szabály egy oldal egy útvonalát. Ami eddig hiányzott:
// „bárhol, ahol a címben ez a szó szerepel” — shorts, reels, live, egy játék neve.
// Ezt csak a böngésző-bővítmény tudja érvényesíteni, mert csak ő látja a
// teljes címet; a gépen szerkeszthető, a telefonok hordozzák és fésülik, hogy
// a lista minden gépeden ugyanaz legyen.
//
// A SZABÁLY UGYANAZ, mint mindenhol: felvenni ingyen (szigorítás), levenni
// próbatétel. A fésülés a zárlat-ablakoké: a JEL dönt (a blob rev-je, amelyik
// a listát utoljára változtatta), azonos jelnél a bővebb lista — a szigorúbb
// irány. A jel nélküli blob (régi kliens) sosem törölhet listát.
//
// Ez a fájl TISZTA: a felület, a segéd és a bővítmény-tesztek is betöltik. A
// Kotlin (Keywords.kt) és a Swift (Keywords.swift) ugyanezt tükrözi; a
// bővítményben az illesztés a `keywords.js`-ben él, ugyanezzel a szabállyal.

import { CONTROL_CHARS } from './alias.js';

/** Legfeljebb ennyi kulcsszó — a felületen sem fér ki több, és a cím se végtelen. */
export const MAX_KEYWORDS = 40;
/** Egy kulcsszó hossza felülről — egy címrészlet, nem egy mondat. */
export const MAX_KEYWORD_LENGTH = 40;
/** …és alulról: egy-két betű mindenre illeszkedne, az nem szabály, hanem baleset. */
export const MIN_KEYWORD_LENGTH = 3;
/**
 * JAVASLATOK egy kattintásra: a leggyakoribb figyelem-csapdák, amik a
 * webcímben és a címsorban is ott vannak. Nem tiltanak maguktól — a
 * felhasználó veszi fel őket, ingyen; ami már fent van, azt a felület nem
 * kínálja újra. Ugyanez a lista a három magban.
 */
export const KEYWORD_SUGGESTIONS = ['shorts', 'reels', 'live', 'stream'];

/**
 * Egy kulcsszó KANONIKUS alakja — vagy null, ha nem az. Kisbetű, NFKC, a
 * szélek levágva, szóköz nélkül (egy cím sem tartalmaz szóközt), három és
 * negyven karakter között. A „shorts” és a „ Shorts ” ugyanaz a szabály.
 */
export function normalizeKeyword(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.normalize('NFKC').replace(CONTROL_CHARS, ' ').trim().toLowerCase();
  if (cleaned === '' || /\s/.test(cleaned)) return null;
  const len = [...cleaned].length;
  if (len < MIN_KEYWORD_LENGTH || len > MAX_KEYWORD_LENGTH) return null;
  return cleaned;
}

/** Egy lista tisztán: csak az érvényes, egyszer, a plafonig — a sorrend a felvételé. */
export function cleanKeywords(raw: unknown): string[] {
  const out: string[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const k = normalizeKeyword(item);
    if (k === null || out.includes(k)) continue;
    if (out.length >= MAX_KEYWORDS) break;
    out.push(k);
  }
  return out;
}

/** A lista tartalmi kulcsa a lenyomatokhoz — rendezve: a sorrend nem jelentés. */
export function keywordsKey(list: string[]): string {
  return [...list].sort().join('|');
}

/** Ugyanaz a két lista tartalom szerint. */
export function sameKeywords(a: string[], b: string[]): boolean {
  return keywordsKey(cleanKeywords(a)) === keywordsKey(cleanKeywords(b));
}

/**
 * Lazítás-e a csere: ha a mostani listából bármi hiányzik az újból, az
 * levétel — próbatétel. Csak felvenni (bővíteni) ingyen van.
 */
export function isKeywordsLoosening(current: string[], next: string[]): boolean {
  const have = new Set(cleanKeywords(next));
  return cleanKeywords(current).some((k) => !have.has(k));
}

/**
 * Két eszköz listája EGGYÉ fésülve, a JELÜK szerint: nagyobb jel nyer (a
 * levétel próbatétellel jár, ami lépteti), azonos jelnél a bővebb — a kettő
 * uniója. A jeltelen blob (régi kliens) jele nulla: az ilyen sosem törölhet.
 * A `mergeWindows` tükre.
 */
export function mergeKeywords(
  localMark: number, local: string[], incomingMark: number, incoming: string[],
): string[] {
  if (localMark > incomingMark) return cleanKeywords(local);
  if (incomingMark > localMark) return cleanKeywords(incoming);
  return cleanKeywords([...local, ...incoming]);
}

/**
 * A cím szövege, amiben a kulcsszót keressük: a séma nélkül, a százalék-
 * kódolást feloldva (a „%20”-tól a „shorts” még shorts), kisbetűvel. A
 * hosztnév is benne van: a „tiktok” a tiktok.com-ra is illik — ez a lényeg.
 */
export function keywordHaystack(url: string): string {
  const s = String(url ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  let decoded = s;
  try { decoded = decodeURIComponent(s); } catch { /* rossz kódolás: marad, ahogy jött */ }
  return decoded.normalize('NFKC').toLowerCase();
}

/**
 * A cím HOSZTNEVE — a telefon ennyit lát a címből: a séma után, az első
 * perjelig, a felhasználónév és a port nélkül, kisbetűvel, a záró pont nélkül.
 */
export function urlHost(url: string): string {
  const s = String(url ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  let host = s.split(/[/?#]/)[0] ?? '';
  host = host.replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host.normalize('NFKC').toLowerCase();
}

/**
 * A TELEFON ítélete: melyik kulcsszó illik a HOSZTNÉVRE — a DNS-szűrő ennyit
 * lát —, vagy null. Az androidos és az iOS-es `keywordInHost` tükre: a gépi
 * próbamező ezzel mondja meg, a telefon fogná-e ugyanazt a címet.
 */
export function keywordInHost(keywords: string[], host: string): string | null {
  let h = String(host ?? '').trim();
  while (h.endsWith('.')) h = h.slice(0, -1);
  const hay = h.normalize('NFKC').toLowerCase();
  if (!hay) return null;
  for (const k of keywords) {
    const key = normalizeKeyword(k);
    if (key !== null && hay.includes(key)) return key;
  }
  return null;
}

/** Melyik kulcsszó illik a címre — az első a lista sorrendjében —, vagy null. */
export function keywordHit(keywords: string[], url: string): string | null {
  const hay = keywordHaystack(url);
  if (!hay) return null;
  for (const k of keywords) {
    const key = normalizeKeyword(k);
    if (key !== null && hay.includes(key)) return key;
  }
  return null;
}
