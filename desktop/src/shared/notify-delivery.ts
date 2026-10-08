// Ha a rendszer nem jelenít meg egy értesítést, azt nem nyeljük el.
//
// Az app sok mindent értesítésben mond el: a szünet végét, a betelő keretet, a
// közelgő heti ablakot, a hétfői visszatekintést. Ha a rendszer egyet
// visszautasít — macOS-en az Electron 42-től a UNNotification, ha nincs
// engedély, vagy az app aláírása nem felel meg neki; Windowson, ha a rendszer
// nem tudja feldobni —, az app eddig semmit nem tudott róla, és a felhasználó
// sem: a figyelmeztetés egyszerűen elmaradt.
//
// Az értesítés `error` eseménye ezt elárulja. A beállítások lapja kimondja,
// csendben — nem nógat, nem ugrik fel semmi: ha valaki szándékosan kapcsolta
// ki, annak ez csak egy tény. Ha a következő értesítést a rendszer átveszi, a
// sor eltűnik.
//
// AMIT NEM LÁT. Az `error` csak azt jelzi, amit a rendszer visszautasít. Hogy
// egy átvett értesítés tényleg látszott-e, azt az app nem tudja: ha a
// Breakernek a rendszerben ki van kapcsolva az értesítése, vagy egy fókusz-mód
// elnémítja, a rendszer ezt nem feltétlenül jelzi vissza — a mostani Electron
// (31) macOS-en egyáltalán nem: ott az értesítésnek nincs hibaútja. Ezért van a
// próba-gomb (notifyTestText): egy kattintás, és a felhasználó a saját szemével
// látja. A `show` esemény ezért „a rendszer átvette”, nem „megjelent”.

/** Hol kapcsolható be a rendszerben — platformonként a menü útja. */
function settingsPath(platform: string): string {
  if (platform === 'darwin') return 'Rendszerbeállítások › Értesítések › Breaker';
  if (platform === 'win32') return 'Gépház › Rendszer › Értesítések › Breaker';
  return 'a rendszer értesítési beállításaiban';
}

/**
 * A beállítások lapjának mondata, ha a legutóbbi értesítés nem jelent meg.
 * @param clock a sikertelen értesítés ideje, „óó:pp” alakban
 */
export function notifyFailText(platform: string, clock: string): string {
  return `A rendszer nem jelenítette meg a Breaker legutóbbi értesítését (${clock}). `
    + 'Ha szeretnéd, hogy szóljon — szünet vége, betelő keret, közelgő heti ablak —, '
    + `engedélyezd: ${settingsPath(platform)}.`;
}

/** A tárolt időpont olvasása: csak véges, pozitív szám számít, minden más „nincs hiba”. */
export function parseFailedAt(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A próba-gomb kimenetele: elküldve, a rendszer átvette, visszautasította, vagy az app nem küldhet. */
export type NotifyTestOutcome = 'sent' | 'accepted' | 'failed' | 'off';

/**
 * A próba-gomb sora. Átvételkor sem állítja, hogy az értesítés megjelent —
 * azt csak a felhasználó látja —, de megmondja, hol keresse, ha mégsem.
 */
export function notifyTestText(platform: string, outcome: NotifyTestOutcome): string {
  switch (outcome) {
    case 'off': return 'Az értesítések ebben az appban nincsenek engedélyezve.';
    case 'sent': return 'Elküldve — a rendszer válaszára vár.';
    case 'failed': return 'A rendszer visszautasította a próbát — alatta, hol kapcsolható be.';
    case 'accepted': return 'A rendszer átvette. Ha mégsem láttad, a Breaker értesítései ki vannak '
      + `kapcsolva, vagy egy fókusz-mód elnémítja őket — bekapcsolható: ${settingsPath(platform)}.`;
  }
}
