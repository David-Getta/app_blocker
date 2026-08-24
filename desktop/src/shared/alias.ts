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
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Használható fedőnév, vagy undefined („nincs fedőnév”).
 *
 * A vezérlőkaraktereket kiszedjük: azok a soron láthatatlanok maradnának, de a
 * hosszkorlátba beleszámítanának, és a mentett állapotban is ott ülnének.
 */
export function normalizeAlias(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return undefined;
  return cleaned.slice(0, MAX_ALIAS_LENGTH).trim();
}

/** Van-e elrejtve a valódi cím? */
export function isAliased(site: Aliasable): boolean {
  return normalizeAlias(site.alias) !== undefined;
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
