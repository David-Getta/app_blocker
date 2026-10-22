// Ha a rendszer nem jelenít meg egy értesítést, azt nem nyeljük el.
//
// Az app sok mindent értesítésben mond el: a szünet végét, a betelő keretet, a
// közelgő heti ablakot, a hétfői visszatekintést. Ha a rendszer egyet
// visszautasít — macOS-en (az Electron 42-től UNNotification) ha nincs
// engedély, vagy az app aláírása nem felel meg neki; Windowson, ha a rendszer
// nem tudja feldobni —, a felhasználó erről magától nem tudna: a
// figyelmeztetés egyszerűen elmaradna.
//
// HONNAN TUDJUK. Az értesítést a FŐ FOLYAMAT küldi (main/notify.ts), az
// Electron saját Notification-jével, és annak `failed` eseménye mondja meg, ha
// a rendszer nem vette át. A felület böngészős `new Notification` útja ezt nem
// tudja: az Electron a webes értesítés hibáját nem adja tovább a lapnak (a
// webes értesítés delegáltja a hibát nem írja felül — se a 31-es, se a 44-es
// forrásban), így a lap `error` eseménye sosem jött meg, és ez a sor sosem
// jelent meg. A beállítások lapja kimondja, csendben — nem nógat, nem ugrik
// fel semmi: ha valaki szándékosan kapcsolta ki, annak ez csak egy tény. Ha a
// következő értesítést a rendszer átveszi, a sor eltűnik.
//
// AMIT NEM LÁT. A `failed` csak azt jelzi, amit a rendszer visszautasít. Hogy
// egy átvett értesítés tényleg látszott-e, azt az app nem tudja: egy fókusz-mód
// elnémítását a rendszer nem jelzi vissza, és Windowson a kikapcsolt értesítést
// sem feltétlenül. macOS-en a megtagadott engedély és az el nem fogadott
// aláírás visszautasításként jön — a kettőt viszont a rendszer nem különbözteti
// meg az app előtt, ezért a mondat a bekapcsolás helyét adja, és nem állítja,
// hogy az az ok. Ezért van a próba-gomb (notifyTestText): egy kattintás, és a
// felhasználó a saját szemével látja. A `show` esemény ezért
// „a rendszer átvette”, nem „megjelent”.

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

/**
 * A próba-gomb kimenetele: elküldve, a rendszer átvette, visszautasította, a
 * rendszeren nem küldhető — vagy az app maga nem jutott el a küldésig (a híd
 * hibázott). Az utolsó az app hibája, nem a rendszeré: a füstpróba bukik rajta.
 */
export type NotifyTestOutcome = 'sent' | 'accepted' | 'failed' | 'off' | 'error';

/**
 * A próba-gomb sora. Átvételkor sem állítja, hogy az értesítés megjelent —
 * azt csak a felhasználó látja —, de megmondja, hol keresse, ha mégsem.
 */
export function notifyTestText(platform: string, outcome: NotifyTestOutcome): string {
  switch (outcome) {
    case 'off': return 'Ezen a rendszeren az app nem tud értesítést küldeni.';
    case 'sent': return 'Elküldve — a rendszer válaszára vár.';
    // macOS-en az ELSŐ értesítés előtt a rendszer engedélyt kér; ha a próba
    // közben jön a kérdés, a próba még visszautasítva jöhet vissza.
    case 'failed': return platform === 'darwin'
      ? 'A rendszer nem vette át a próbát. Ha most kért engedélyt, add meg, és próbáld újra; '
        + 'különben alatta, hol kapcsolható be.'
      : 'A rendszer nem vette át a próbát — alatta, hol kapcsolható be.';
    // macOS-en a kikapcsolt értesítés visszautasításként jön (failed), tehát
    // átvételkor nem az a valószínű ok: egy fókusz-mód, vagy hogy a Breaker
    // figyelmeztetési stílusa Nincs (akkor csak az Értesítési központba kerül).
    case 'accepted': return platform === 'darwin'
      ? 'A rendszer átvette. Ha mégsem láttad, egy fókusz-mód elnémítja, vagy a Breaker '
        + `figyelmeztetési stílusa Nincs (akkor csak az Értesítési központba kerül) — beállítható: ${settingsPath(platform)}.`
      : 'A rendszer átvette. Ha mégsem láttad, a Breaker értesítései ki vannak '
        + `kapcsolva, vagy egy fókusz-mód elnémítja őket — bekapcsolható: ${settingsPath(platform)}.`;
    case 'error': return 'Az app nem jutott el a küldésig — ez a Breaker hibája, nem a rendszer beállítása.';
  }
}

// ------------------------------------------------------------ A KÉRÉS ÚTJA
//
// A felület a hídon át kér értesítést (breaker:notify), a fő folyamat küldi,
// és az eseményeit (átvette / visszautasította / rákattintottak) az azonosító
// szerint visszaküldi. A kérést a fő folyamat itt ellenőrzi: a felület egy
// másik folyamat, és a híd egyetlen bemenete sem lehet tetszőleges.

/** Egy értesítés-kérés a felülettől. */
export interface NotifyRequest {
  /** a felület adja; ezzel jön vissza az esemény */
  id: string;
  title: string;
  body: string;
}

/** Ami egy értesítésről visszajön: a rendszer átvette, visszautasította, vagy rákattintottak. */
export interface NotifyEvent {
  id: string;
  kind: 'shown' | 'failed' | 'click';
}

/** A küldés azonnali válasza: elküldve; a rendszer nem tud értesíteni; vagy rossz a kérés. */
export type NotifySendResult = 'sent' | 'unsupported' | 'invalid';

export const NOTIFY_TITLE_MAX = 120;
export const NOTIFY_BODY_MAX = 1000;
/** Ennyi értesítésre emlékszik a fő folyamat és a felület (az eseményeikhez); a régebbiek kiesnek. */
export const NOTIFY_KEEP = 50;

const NOTIFY_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** Kódpontban vág, hogy egy emodzsi ne törjön félbe. */
function clip(s: string, max: number): string {
  const cps = [...s];
  return cps.length > max ? cps.slice(0, max).join('') : s;
}

/** A felülettől jött kérés ellenőrzése; minden más alak null. */
export function parseNotifyRequest(raw: unknown): NotifyRequest | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !NOTIFY_ID.test(r.id)) return null;
  if (typeof r.title !== 'string' || typeof r.body !== 'string') return null;
  if (r.title.trim() === '') return null;
  return { id: r.id, title: clip(r.title, NOTIFY_TITLE_MAX), body: clip(r.body, NOTIFY_BODY_MAX) };
}

/** A fő folyamattól jött esemény ellenőrzése a felületen; minden más alak null. */
export function parseNotifyEvent(raw: unknown): NotifyEvent | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !NOTIFY_ID.test(r.id)) return null;
  if (r.kind !== 'shown' && r.kind !== 'failed' && r.kind !== 'click') return null;
  return { id: r.id, kind: r.kind };
}

/**
 * Korlátos emlékezet az értesítésekről, beszúrási sorrendben: a legrégebbi
 * esik ki. A fő folyamatban az értesítés-objektumot tartja életben (a
 * szemétgyűjtő különben az eseményeivel együtt eltüntetné), a felületen a
 * hozzá tartozó teendőt.
 */
export class NotifyMemory<T> {
  private readonly items = new Map<string, T>();
  constructor(private readonly keep: number = NOTIFY_KEEP) {}
  /** Felvesz; ami a korláton felül marad, a legrégebbi, azt visszaadja (hogy el lehessen engedni). */
  add(id: string, item: T): T[] {
    this.items.delete(id);
    this.items.set(id, item);
    const dropped: T[] = [];
    while (this.items.size > this.keep) {
      const oldest = this.items.keys().next().value as string;
      dropped.push(this.items.get(oldest) as T);
      this.items.delete(oldest);
    }
    return dropped;
  }
  get(id: string): T | undefined { return this.items.get(id); }
  delete(id: string): void { this.items.delete(id); }
  get size(): number { return this.items.size; }
}
