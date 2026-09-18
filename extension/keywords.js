// KULCSSZÓ-SZABÁLYOK a bővítményben — a desktop/src/shared/keywords.ts párja.
//
// Bármely oldalon, ha a cím tartalmazza: shorts, reels, egy játék neve. Csak
// a böngésző látja a teljes címet, ezért csak itt lehet érvényesíteni; a
// listát az app adja a hídon (`keywords`), tisztítva tároljuk, és a döntés a
// háttérben megy — az egész oldal zárása (closed) után, a csatorna és a
// részleges szabály előtt, mert tágabb, mint azok.

/** Legfeljebb ennyi kulcsszó — az app plafonja. */
export const MAX_KEYWORDS = 40;
export const MAX_KEYWORD_LENGTH = 40;
export const MIN_KEYWORD_LENGTH = 3;

/** Egy kulcsszó kanonikus alakja — vagy null, ha nem az (a mag szabálya). */
export function normalizeKeyword(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.normalize('NFKC').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().toLowerCase();
  if (cleaned === '' || /\s/.test(cleaned)) return null;
  const len = [...cleaned].length;
  if (len < MIN_KEYWORD_LENGTH || len > MAX_KEYWORD_LENGTH) return null;
  return cleaned;
}

/** A hídról vagy a tárból jött lista tisztán: csak az érvényes, egyszer, a plafonig. */
export function cleanKeywords(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const k = normalizeKeyword(item);
    if (k === null || out.includes(k)) continue;
    if (out.length >= MAX_KEYWORDS) break;
    out.push(k);
  }
  return out;
}

/** A cím szövege, amiben keresünk: séma nélkül, százalék-kódolás feloldva, kisbetűvel. */
export function keywordHaystack(url) {
  const s = String(url ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  let decoded = s;
  try { decoded = decodeURIComponent(s); } catch { /* rossz kódolás: marad, ahogy jött */ }
  return decoded.normalize('NFKC').toLowerCase();
}

/** Melyik kulcsszó illik a címre — az első a lista sorrendjében —, vagy null. */
export function keywordHit(keywords, url) {
  const hay = keywordHaystack(url);
  if (!hay) return null;
  for (const k of Array.isArray(keywords) ? keywords : []) {
    const key = normalizeKeyword(k);
    if (key !== null && hay.includes(key)) return key;
  }
  return null;
}
