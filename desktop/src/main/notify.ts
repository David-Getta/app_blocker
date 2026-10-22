// A gépi értesítés a fő folyamatból megy (shared/notify-delivery.ts).
//
// A felület böngészős `new Notification` útja kényelmes volt, de vak: az
// Electron a webes értesítés hibáját nem adja tovább a lapnak, így ha a
// rendszer egy értesítést visszautasított (macOS-en nincs engedély, vagy az
// aláírás nem felel meg a UNNotification-nek), az app nem tudott róla. Az
// Electron saját Notification-jének viszont van `failed` eseménye — ezért a
// felület kér, itt küldünk, és az eseményeket az azonosítóval visszaadjuk.

import { ipcMain, Notification } from 'electron';
import { NotifyMemory, parseNotifyRequest, type NotifyEvent, type NotifySendResult } from '../shared/notify-delivery';

/**
 * @param showMain a fő ablak előhozása — egy értesítésre kattintás az apphoz
 *   visz (a felület teendője, ha van, utána fut)
 * @param log napló (a visszautasítás oka ide megy, a felületre csak a tény)
 */
export function registerNotifyIpc(showMain: () => void, log: (line: string) => void): void {
  // Az értesítés-objektumot életben kell tartani: ha a szemétgyűjtő elviszi,
  // az eseményei is elvesznek. Egy kattintás órákkal később is jöhet (a
  // Windows értesítési központjából is, a felugró bezárulta után) — ezért a
  // `close` sem enged el, csak a korlát és a visszautasítás.
  const alive = new NotifyMemory<Notification>();

  ipcMain.handle('breaker:notify', (e, raw: unknown): NotifySendResult => {
    const req = parseNotifyRequest(raw);
    if (!req) return 'invalid';
    // macOS-en az első kérdés nyitja a rendszer értesítési kapcsolatát (és
    // kéri az engedélyt) — ha a látható ablak még nem tette meg
    // (primeNotifications), akkor itt.
    if (!Notification.isSupported()) return 'unsupported';
    const sender = e.sender;
    const send = (kind: NotifyEvent['kind']) => {
      if (!sender.isDestroyed()) sender.send('breaker:notify-event', { id: req.id, kind } satisfies NotifyEvent);
    };
    const n = new Notification({ title: req.title, body: req.body });
    n.on('show', () => send('shown'));
    n.on('failed', (_ev, error) => {
      log(`notification failed: ${error}`);
      alive.delete(req.id);
      send('failed');
    });
    n.on('click', () => {
      showMain();
      send('click');
    });
    alive.add(req.id, n);
    n.show();
    return 'sent';
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
