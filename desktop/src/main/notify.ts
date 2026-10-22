// A gépi értesítés a fő folyamatból megy (shared/notify-delivery.ts).
//
// A felület böngészős `new Notification` útja kényelmes volt, de vak: az
// Electron a webes értesítés hibáját nem adja tovább a lapnak, így ha a
// rendszer egy értesítést visszautasított (macOS-en nincs engedély, vagy az
// aláírás nem felel meg a UNNotification-nek), az app nem tudott róla. Az
// Electron saját Notification-jének viszont van `failed` eseménye — ezért a
// felület kér, itt küldünk, és az eseményeket az azonosítóval visszaadjuk.
//
// MINDEN értesítés itt megy ki — a fő folyamat sajátja (a háttérben futás
// egyszeri jelzése) is —, és a sorsa (átvette / visszautasította) ugyanúgy a
// felületre jut: a beállítások lapjának kézbesítési sora mindegyikről tud.

import { ipcMain, Notification, type WebContents } from 'electron';
import { NotifyMemory, parseNotifyRequest, type NotifyEvent, type NotifySendResult } from '../shared/notify-delivery';

// Az értesítés-objektumot életben kell tartani: ha a szemétgyűjtő elviszi, az
// eseményei is elvesznek. Egy kattintás órákkal később is jöhet (a Windows
// értesítési központjából is, a felugró bezárulta után) — ezért a `close` sem
// enged el, csak a korlát és a visszautasítás.
const alive = new NotifyMemory<Notification>();
let mainSeq = 0;

/** Amit egy értesítés sorsára tenni kell a fő folyamatban. */
export interface MainNotifyHandlers {
  shown?: () => void;
  failed?: (error: string) => void;
  click?: () => void;
}

/**
 * Egy értesítés küldése. A sorsa a `report` felületére is megy, az `id`-vel
 * (onNotifyEvent a rendererben) — így a kézbesítési sor akkor is tud róla, ha
 * nem a felület kérte. Hamis, ha a rendszer nem tud értesíteni.
 */
export function sendNotification(
  id: string, title: string, body: string, report: WebContents | null, on: MainNotifyHandlers = {},
): boolean {
  // macOS-en az első kérdés nyitja a rendszer értesítési kapcsolatát (és
  // kéri az engedélyt) — ha a látható ablak még nem tette meg
  // (primeNotifications), akkor itt.
  if (!Notification.isSupported()) return false;
  const tell = (kind: NotifyEvent['kind']) => {
    if (report && !report.isDestroyed()) report.send('breaker:notify-event', { id, kind } satisfies NotifyEvent);
  };
  const n = new Notification({ title, body });
  n.on('show', () => {
    on.shown?.();
    tell('shown');
  });
  n.on('failed', (_ev, error) => {
    alive.delete(id);
    on.failed?.(error);
    tell('failed');
  });
  n.on('click', () => {
    on.click?.();
    tell('click');
  });
  alive.add(id, n);
  n.show();
  return true;
}

/** A fő folyamat saját értesítéseinek azonosítója (a felületéi `n…`, ezek `m…`). */
export function mainNotifyId(): string {
  return `m${++mainSeq}`;
}

/**
 * @param showMain a fő ablak előhozása — egy értesítésre kattintás az apphoz
 *   visz (a felület teendője, ha van, utána fut)
 * @param log napló (a visszautasítás oka ide megy, a felületre csak a tény)
 */
export function registerNotifyIpc(showMain: () => void, log: (line: string) => void): void {
  ipcMain.handle('breaker:notify', (e, raw: unknown): NotifySendResult => {
    const req = parseNotifyRequest(raw);
    if (!req) return 'invalid';
    const sent = sendNotification(req.id, req.title, req.body, e.sender, {
      failed: (error) => log(`notification failed: ${error}`),
      click: showMain,
    });
    return sent ? 'sent' : 'unsupported';
  });
}

let primed = false;

/**
 * macOS-en az értesítési kapcsolatot (és vele a rendszer engedély-kérdését)
 * az Electron lustán, az első használatkor nyitja. Ha ez egy valódi
 * figyelmeztetés — szünet vége, betelő keret — lenne, épp az veszne el, amíg
 * a kérdés kint van. Ezért akkor nyitjuk, amikor a felhasználó maga hozza elő
 * az ablakot: ott van, látja a kérdést. Egyszer; ha már döntött, a rendszer
 * nem kérdez újra. Bejelentkezéskori rejtett indulásnál nem: ha nem kéred,
 * csendben marad.
 */
export function primeNotifications(): void {
  if (primed || process.platform !== 'darwin') return;
  primed = true;
  Notification.isSupported();
}
