// Fedőnév a blokkolt oldalakhoz.
//
// A lista MAGA is ingerforrás. Aki megnyitja az appot, és ott áll előtte a
// `youtube.com`, az már fél lépéssel közelebb van ahhoz, hogy feloldja — a név
// felidézi, mi van a másik oldalon. Ezért lehet minden oldalnak saját fedőnevet
// adni; olyat, ami neki jelent valamit, de nem hív.
//
// A valódi cím ettől nem tűnik el: egy gombbal RÖVID IDŐRE előhívható, mert
// néha tényleg tudni kell, melyik sor melyik. Csak épp nem ül ott állandóan.
//
// Ez nem biztonsági határ, és nem is akar az lenni: a hosts fájlban ott a cím,
// bárki megnézheti. Ez inger-eltávolítás, nem titkosítás — a doksik is így
// mondják, hogy senki ne higgye másnak.

/** Ennél hosszabb fedőnevet nem tárolunk (a soron sem férne el). */
export const MAX_ALIAS_LENGTH = 40;

/** Ennyi ideig látszik a valódi cím, ha a felhasználó előhívja. */
export const REVEAL_MS = 6_000;

export interface Aliasable {
  domain: string;
  alias?: string;
}

/** Vezérlőkarakterek: C0, DEL és C1. Ezeket szóközre cseréljük. */
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * MI A SZÓKÖZ. A tisztítás a JS `\s` készletét veszi szóköznek — pontosan
 * ez a huszonöt kódpont: a C0 szóközei (tab, soremelés, függőleges tab,
 * lapdobás, kocsi-vissza), a szóköz, a nem törő szóköz, az ogham-szóköz, a
 * tizenegy tipográfiai szóköz (U+2000–U+200A), a sor- és a bekezdés-
 * elválasztó, a keskeny és a matematikai nem törő szóköz, az ideografikus
 * szóköz és a BOM (U+FEFF). Kimondva azért, mert a három platform saját
 * fogalma eltér: a Java regex `\s`-e csak ASCII, a Kotlin és a Swift
 * szóköz-fogalma a BOM-ot nem ismeri. A Kotlin (TextLogic.SPACES) és a Swift
 * (TextLogic.isSpace) ugyanezt a listát hordozza; a gép tesztje bizonyítja,
 * hogy a `\s` tényleg ez a lista, és a `fixtures/text-cases.json` azt, hogy a
 * három mag ugyanúgy tisztít. A láthatatlan, de nem szóköz jelek (U+200B,
 * U+200D, U+2060) egyikben sem azok: maradnak.
 */
export const WHITESPACE_CODE_POINTS: readonly number[] = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

/**
 * Használható fedőnév, vagy undefined („nincs fedőnév”).
 *
 * A vezérlőkaraktereket kiszedjük: azok a soron láthatatlanok maradnának, de a
 * hosszkorlátba beleszámítanának, és a mentett állapotban is ott ülnének.
 */
export function normalizeAlias(value: string | undefined | null): string | undefined {
  return normalizeTo(value, MAX_ALIAS_LENGTH);
}

/**
 * Az INDOK hossza — miért tiltottad. Egy mondat, ami a kísértés pillanatában
 * elfér a tiltó lapon és a soron; nem esszé.
 */
export const MAX_REASON_LENGTH = 140;

/** Az indok tiszta alakja — ugyanaz a tisztítás, mint a fedőnévé, hosszabb plafonnal. */
export function normalizeReason(value: string | undefined | null): string | undefined {
  return normalizeTo(value, MAX_REASON_LENGTH);
}

function normalizeTo(value: string | undefined | null, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return undefined;
  // KÓDPONTBAN vágunk, nem UTF-16 egységben. A `slice` egy emodzsit félbe
  // vágott volna, és a maradék fél — egy párja nélküli helyettesítő — a
  // JSON-on át a telefonokig jutott volna, ahol az iPhone olvasója az ilyen
  // szöveget eldobja. A kulcsszó és a megbízott neve is kódpontban számol; a
  // Kotlin (TextLogic.takeCodePoints) és a Swift (TextLogic.takeScalars) is.
  return [...cleaned].slice(0, max).join('').trim();
}

/** Van-e elrejtve a valódi cím? */
export function isAliased(site: Aliasable): boolean {
  return normalizeAlias(site.alias) !== undefined;
}

/**
 * A FEDŐNÉV LEVÉTELE-e a változás: volt fedőnév, és a következő érték már nem az.
 * A levétel FELFED — onnantól a valódi cím áll a listán —, ezért a felület a
 * készülék azonosítását kéri hozzá; az átnevezés (név → másik név) nem fed fel.
 * Egy helyen, hogy a három felület ne három szabályt hordjon.
 */
export function isAliasRemoval(current: string | undefined | null, next: string | undefined | null): boolean {
  return normalizeAlias(current) !== undefined && normalizeAlias(next) === undefined;
}

/**
 * Amit a felületen KI SZABAD írni.
 *
 * Minden megjelenítés ezen megy át — a soron, a párbeszédek címében, a
 * próbatétel-ablakban és a statisztikában is. Ha bárhol kimaradna, a fedőnév
 * értelmét vesztené: elég egyetlen hely, ahol ott a valódi cím.
 */
export function displayName(site: Aliasable): string {
  return normalizeAlias(site.alias) ?? site.domain;
}

/**
 * Amit MOST kell kiírni, figyelembe véve az ideiglenes felfedést.
 *
 * @param revealedUntil mikorig látszik a valódi cím (ms), vagy undefined
 */
export function displayNameNow(
  site: Aliasable, now: number, revealedUntil?: number,
): string {
  if (revealedUntil !== undefined && now < revealedUntil) return site.domain;
  return displayName(site);
}
