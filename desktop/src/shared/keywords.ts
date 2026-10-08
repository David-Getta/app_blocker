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
// próbatétel. A fésülés KULCSSZAVANKÉNT megy, a hosztnevek mintájára: minden
// felvétel és levétel jelet kap (a blob rev-je, amelyik vitte), és
// kulcsszavanként a nagyobb jel dönt; egyenlő — vagy hiányzó — jelnél az unió,
// a szigorúbb irány. A lista egészének jele csak a régi klienseknek utazik.
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

/** Ennél több kulcsszó-jelet nem hordunk: a jelen lévők jele mindig marad, a levettekből a legfrissebbek. */
export const MAX_KEYWORD_MARKS = 128;

/** A kulcsszó-jelek: kanonikus kulcsszó → a blob rev-je, amelyik utoljára felvette vagy levette. */
export type KeywordMarks = Record<string, number>;

/**
 * Egy kulcsszó jele a térképből — csak a SAJÁT, pozitív egész érték számít.
 * A „__proto__” is érvényes kulcsszó: egy sima objektumon az öröklött
 * tulajdonsága jelnek látszana.
 */
export function keywordMarkOf(marks: KeywordMarks | undefined, k: string): number {
  if (!marks || !Object.prototype.hasOwnProperty.call(marks, k)) return 0;
  const v = marks[k];
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
}

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A jelek plafonja — EGY szabály a fésülésre, a bemenetre és a léptetésre:
 * a jelen lévő kulcsszavak jele mindig marad, a levettekből a legnagyobb
 * jelűek férnek be (holtversenyben kódegység szerint). Üresen undefined. A
 * `capHostnameMarks` mintája; a Kotlin- és a Swift-tükör ugyanezt teszi.
 */
export function capKeywordMarks(marks: Map<string, number>, present: string[]): KeywordMarks | undefined {
  if (marks.size === 0) return undefined;
  const here = new Set(present);
  const kept = [...marks].filter(([k]) => here.has(k));
  const gone = [...marks].filter(([k]) => !here.has(k))
    .sort((x, y) => (y[1] - x[1]) || codeUnitCompare(x[0], y[0]));
  return Object.fromEntries([...kept, ...gone].slice(0, Math.max(kept.length, MAX_KEYWORD_MARKS)));
}

/**
 * A kívülről (dróton, lemezről) jött kulcsszó-jelek tisztán: csak kanonikus
 * kulcsszó, csak pozitív egész, legfeljebb a blob `rev`-je (a jel annak a
 * blobnak a rev-je, amelyik írta) — a plafonnal. Üresen undefined.
 */
export function cleanKeywordMarks(raw: unknown, keywords: string[], maxRev: number): KeywordMarks | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const marks = new Map<string, number>();
  for (const k of Object.keys(raw)) {
    const v = keywordMarkOf(raw as KeywordMarks, k);
    if (v === 0 || v > maxRev || normalizeKeyword(k) !== k) continue;
    marks.set(k, v);
  }
  return capKeywordMarks(marks, keywords);
}

/** A kulcsszavak egy eszközön: a lista és a kulcsszavankénti jelek. */
export interface KeywordSet {
  keywords?: string[];
  keywordMarks?: KeywordMarks;
}

/**
 * Két eszköz kulcsszavai KULCSSZAVANKÉNT fésülve, a jelük szerint.
 *
 * MIÉRT. Eddig a lista egészében a nagyobb jelet követte, és a jelet bármelyik
 * ingyenes felvétel lépteti: egy elavult eszközön egy új kulcsszó felvétele
 * felhúzta a jelet, és a régi listája mindenhol letörölte a máshol felvett
 * kulcsszavakat — ingyen, próbatétel nélkül.
 *
 * Most a jel a KULCSSZÓHOZ tartozik (a blob rev-je, amelyik utoljára felvette
 * vagy levette), és kulcsszavanként a nagyobb jel dönt: ami annál áll (benne
 * van vagy nincs), az marad. Egy kulcsszó jele csak akkor változik, ha ő maga
 * változik — tehát egy elavult eszköz más szerkesztése nem viszi el, levenni
 * pedig csak próbatétellel lehet, ami a levétel jelét írja. Egyenlő jelnél
 * (ide tartozik a jel nélküli is: a régi kliens, vagy a frissítés előtt
 * felvett kulcsszó) az UNIÓ — versenyhelyzet sosem old fel. Ennek ára: egy
 * régi kliens kifizetett levétele nem tartja meg magát egy frissített eszköz
 * jeltelen példányával szemben (a szigorúbb irány — ezért kell mindent
 * frissíteni).
 *
 * A sorrend a jelé (a régebben felvett elöl, a jeltelen legelöl), aztán
 * kódegység szerint — két eszköz bájtra ugyanazt kapja, a fésülés
 * sorrendjétől függetlenül. A plafon (40) is ebben a sorrendben vág: egy
 * frissen felvett szemét-tömeg nem szoríthatja ki a régi kulcsszavakat.
 */
export function mergeKeywordSets(a: KeywordSet, b: KeywordSet): { keywords: string[]; keywordMarks?: KeywordMarks } {
  const listA = cleanKeywords(a.keywords);
  const listB = cleanKeywords(b.keywords);
  const names = new Set<string>([...listA, ...listB]);
  for (const m of [a.keywordMarks, b.keywordMarks]) {
    for (const k of Object.keys(m ?? {})) if (normalizeKeyword(k) === k) names.add(k);
  }
  const present: { k: string; m: number }[] = [];
  const marks = new Map<string, number>();
  for (const k of names) {
    const ma = keywordMarkOf(a.keywordMarks, k);
    const mb = keywordMarkOf(b.keywordMarks, k);
    const inA = listA.includes(k);
    const inB = listB.includes(k);
    const here = ma > mb ? inA : mb > ma ? inB : inA || inB;
    const m = Math.max(ma, mb);
    if (here) present.push({ k, m });
    if (m > 0) marks.set(k, m);
  }
  const keywords = present.sort((x, y) => (x.m - y.m) || codeUnitCompare(x.k, y.k))
    .slice(0, MAX_KEYWORDS).map((p) => p.k);
  const keywordMarks = capKeywordMarks(marks, keywords);
  return { keywords, ...(keywordMarks ? { keywordMarks } : {}) };
}

/**
 * A kulcsszó-jelek a léptetésben: ami az előző léptetés óta bekerült vagy
 * kikerült, az ezt a blob-rev-et kapja; a többi jel marad. Egy fogópont, mint
 * a hosztneveknél (`markHostnames`) — egy jövőbeli harmadik szerkesztő út se
 * felejtheti el a jelet. Az első léptetés (nincs még eltett lista) jel nélkül
 * megy: a frissítés előtt felvett kulcsszavakra az unió áll.
 */
export function markKeywordChanges(
  marks: KeywordMarks | undefined, prev: string[], next: string[], rev: number,
): KeywordMarks | undefined {
  const out = new Map<string, number>();
  for (const k of Object.keys(marks ?? {})) {
    const v = keywordMarkOf(marks, k);
    if (v > 0) out.set(k, v);
  }
  const before = new Set(prev);
  const after = new Set(next);
  for (const k of after) if (!before.has(k)) out.set(k, rev);
  for (const k of before) if (!after.has(k)) out.set(k, rev);
  return capKeywordMarks(out, next);
}

/** A kulcsszó-jelek tartalmi kulcsa — rendezve, a különbség-vizsgálathoz. */
export function keywordMarksKey(marks: KeywordMarks | undefined): string {
  return Object.keys(marks ?? {}).sort(codeUnitCompare)
    .map((k) => `${k}=${keywordMarkOf(marks, k)}`).join('|');
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
