// A böngésző-DoH zár állapotának sora (csak macOS) — tiszta függvény, hogy a
// teszt is lássa. Tükör, nem ítélet: azt mondja, ami a gépen most áll,
// böngészőnként, és nem állítja, honnan jön (egy telepített profil és egy
// szervezeti felügyelet ugyanúgy látszik).
//
// Három fokozat, mert a két böngészőcsalád másképp olvassa ugyanazt:
//   • KÖTELEZŐ: kezelt beállítás (/Library/Managed Preferences — profil vagy
//     felügyelet). A felhasználó sehonnan nem bírálhatja felül.
//   • ZÁROLVA A BÖNGÉSZŐBEN: a Firefox a segéd gépszintű házirendjét is
//     házirendnek veszi — a beállítása szürke —, de a felhasználó saját
//     beállítás-tartománya (egy `defaults write` a Terminálban) erősebb nála.
//   • VISSZAKAPCSOLHATÓ: a Chromium-család a gépszintű értéket csak ajánlásnak
//     veszi; és ide tartozik minden böngésző, amelyiknél nincs is semmi.

export interface DohLockState {
  /** a vizsgált böngészők, sorrendben */
  browsers: string[];
  /** ahol a tilalom KÖTELEZŐ (kezelt beállítás) */
  forcedOff: string[];
  /** ahol a böngésző beállításaiban zárolva, de a felhasználó saját beállításával felülírható */
  lockedInBrowser: string[];
}

export function dohLockLine(st: DohLockState): string {
  const forced = st.browsers.filter((b) => st.forcedOff.includes(b));
  const locked = st.browsers.filter((b) => !forced.includes(b) && st.lockedInBrowser.includes(b));
  const open = st.browsers.filter((b) => !forced.includes(b) && !locked.includes(b));
  if (locked.length === 0 && open.length === 0) {
    return `Most érvényben: a DoH-tilalom mindegyik böngészőben kötelező (${forced.join(', ')}; a gép `
      + 'kezelt beállításaiból). Ha a Breaker profilja adja, a Rendszerbeállításokban eltávolíthatod; '
      + 'egy szervezeti felügyelet beállítását innen nem.';
  }
  const parts = [forced.length > 0 ? `Részben érvényben — kötelező: ${forced.join(', ')}.` : 'Most nincs kötelező DoH-tilalom.'];
  if (open.length > 0) parts.push(`A böngésző beállításaiban visszakapcsolható: ${open.join(', ')}.`);
  if (locked.length > 0) {
    parts.push(`A böngészőben zárolva, de a saját felhasználói beállításoddal (Terminálból) felülírható: ${locked.join(', ')}.`);
  }
  return parts.join(' ');
}

/**
 * Hol telepíti (és veszi le) a felhasználó a profilt — a hely macOS-enként
 * más: a 13-as előtt a Rendszerbeállítások külön Profilok tábla volt, aztán az
 * Adatvédelem és biztonság alá került, az újabbakon az Eszközkezelés alatt van.
 */
export const DOH_PROFILE_WHERE = 'Telepítés: Rendszerbeállítások › Általános › Eszközkezelés (régebbi '
  + 'macOS-en: Adatvédelem és biztonság › Profilok; macOS 12-n és előtte: Rendszerbeállítások › Profilok)';
