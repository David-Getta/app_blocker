// Fut-e a bővítmény inkognitóban — TÜKÖR, nem szabályismétlés.
//
// A beállítás-lap és a felugró lap eddig általánosságban mondta, hogy
// inkognitóban csak engedéllyel fut. Azt nem, hogy NÁLAD most fut-e. Pedig a
// böngésző megmondja, és ha nem fut, ott a részleges szabályok, a kulcsszavak
// és a munkamenet nem érvényesülnek (az egész oldal tiltása, a DNS, igen).

/** A böngésző válasza: igaz, hamis — vagy null, ha nem tudja megmondani. */
export async function incognitoAllowed() {
  try {
    const v = await globalThis.chrome?.extension?.isAllowedIncognitoAccess?.();
    return typeof v === 'boolean' ? v : null;
  } catch {
    return null;
  }
}

/** A mondat a mostani állapotról — null, ha nem tudni (akkor hallgatunk). */
export function incognitoText(allowed) {
  if (allowed === true) return 'Inkognitóban most: engedélyezve — a bővítmény ott is fut.';
  if (allowed === false) {
    return 'Inkognitóban most NEM fut: ott a részleges szabályok, a kulcsszavak és a munkamenet '
      + 'nem érvényesülnek — az egész oldal tiltása (DNS) igen. Bekapcsolni a bővítmény '
      + 'beállításainál lehet: „Engedélyezés inkognitó módban”.';
  }
  return null;
}

/**
 * A bővítmény saját oldala a böngésző bővítmény-kezelőjében — csak
 * Chromium-alapú böngészőben nyitható innen; máshol null (a mondat elmondja,
 * hol a kapcsoló).
 */
export function extensionSettingsUrl() {
  const id = globalThis.chrome?.runtime?.id;
  const ua = String(globalThis.navigator?.userAgent ?? '');
  return id && !/Firefox\//.test(ua) ? `chrome://extensions/?id=${id}` : null;
}
