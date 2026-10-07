// A felület frissítési üteme: látható ablaknál sűrű, rejtettnél ritka.
//
// MIÉRT. Az app a háttérben fut tovább (lásd shared/background.ts), az ablaka
// rejtve. A felület eddig két másodpercenként kérte le a TELJES állapotot — a
// segéd minden kérésre kiszámolja a heti ablakokat, az összegzőket —, és
// rajzolta újra az egészet, akkor is, ha senki nem nézte. Laptopon ez
// akkumulátor. Rejtve csak az értesítések kellenek (a heti ablak beérése, az
// adag, az előjelzések), azokhoz bőven elég tíz másodperc — és rajzolni sem
// kell semmit.

/** Látható ablaknál ilyen sűrűn kérdez — a felület élőnek hat tőle. */
export const VISIBLE_REFRESH_MS = 2000;
/** Rejtett ablaknál ilyen sűrűn: az értesítéseknek ez is bőven elég. */
export const HIDDEN_REFRESH_MS = 10_000;

/**
 * Esedékes-e a következő lekérdezés. A kör a sűrűbb ütemben jár; rejtve csak
 * minden ötödik kör kérdez. Egy előrefelé ugró óra (vagy alvás) sem akasztja
 * meg: a régi időpont csak még esedékesebb.
 */
export function refreshDue(visible: boolean, lastAt: number, now: number): boolean {
  if (visible) return true;
  return now - lastAt >= HIDDEN_REFRESH_MS || now < lastAt;
}
