// Ha a rendszer nem jelenít meg egy értesítést, azt nem nyeljük el.
//
// Az app sok mindent értesítésben mond el: a szünet végét, a betelő keretet, a
// közelgő heti ablakot, a hétfői visszatekintést. Ha a rendszer ezeket nem
// jeleníti meg — a felhasználó letiltotta, a fókusz-mód elnyeli, vagy macOS-en
// az Electron 42-től az app aláírása nem felel meg a UNNotification-nek —, az
// app eddig semmit nem tudott róla, és a felhasználó sem: a figyelmeztetés
// egyszerűen elmaradt.
//
// Az értesítés `error` eseménye ezt elárulja. A beállítások lapja kimondja,
// csendben — nem nógat, nem ugrik fel semmi: ha valaki szándékosan kapcsolta
// ki, annak ez csak egy tény. Ha a következő értesítés megjelenik, a sor eltűnik.

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
