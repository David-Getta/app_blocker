// A gyorsbillentyűs réteg.
//
// MIÉRT VAN. A munkamenet akkor ér valamit, ha egy mozdulattal indul. Aki
// leül tanulni, az nem fog előbb ablakot keresni, appot előhozni és fület
// váltani — addigra már a YouTube-on van. Egy billentyűkombináció viszont
// beleesik abba a másodpercbe, amíg a szándék tart.
//
// AMI EZ NEM: nem egy második felület. Csak azt tudja, amit ebben a pillanatban
// tudni kell — mi fut, mennyi van hátra, és mit lehet elindítani. Minden más az
// appban van.
//
// A réteg SEMMIT NEM OLD FEL. A leállítás innen is ugyanabba a próbatételbe
// kerül, mint bárhonnan: a gomb csak megnyitja az appot, ahol a próbatétel van.

import * as path from 'path';
import { BrowserWindow, globalShortcut, screen } from 'electron';

/**
 * Az alapértelmezett kombináció.
 *
 * A `CommandOrControl+Alt+B` macOS-en ⌘⌥B, Windowson Ctrl+Alt+B. Egyik
 * rendszerben sem foglalt, és a Breaker kezdőbetűje.
 */
export const OVERLAY_SHORTCUT = 'CommandOrControl+Alt+B';

let win: BrowserWindow | null = null;

function build(): BrowserWindow {
  // A teljes képernyőt lefedjük, de átlátszóan: a réteg RÁÜL arra, amit épp
  // csinálsz, és nem tünteti el. Egy külön ablak elrejtené a kontextust, és
  // pont az veszne el, amiért a réteg egyáltalán van.
  const area = screen.getPrimaryDisplay().workAreaSize;
  const w = new BrowserWindow({
    width: area.width,
    height: area.height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    // Fókusz KELL: a rétegen billentyűzettel is lehet választani, és az Esc
    // zárja. Fókusz nélkül a kezelése egérre korlátozódna.
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  w.setMenuBarVisibility(false);
  // A teljes képernyős appok (játék, prezentáció) fölé is: ott a legnagyobb a
  // kísértés, és ott lenne a leghaszontalanabb egy alá csúszó ablak.
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void w.loadFile(path.join(__dirname, '..', 'ui', 'renderer', 'overlay.html'));
  // A fókusz elvesztése bezárja. Egy ottfelejtett, átlátszó, mindig felül lévő
  // ablak a legrosszabb, amit egy ilyen réteg tehet.
  w.on('blur', () => w.hide());
  w.on('closed', () => { win = null; });
  return w;
}

export function toggleOverlay(): void {
  if (!win || win.isDestroyed()) win = build();
  if (win.isVisible()) {
    win.hide();
    return;
  }
  win.showInactive();
  win.focus();
}

export function hideOverlay(): void {
  if (win && !win.isDestroyed()) win.hide();
}

/**
 * A kombináció regisztrálása.
 *
 * @returns igaz, ha sikerült. Nem hiba, ha nem: egy másik program elveheti,
 * és ilyenkor a felület megmondja, hogy a réteg csak az appból nyitható.
 */
export function registerOverlayShortcut(accelerator = OVERLAY_SHORTCUT): boolean {
  try {
    if (globalShortcut.isRegistered(accelerator)) return true;
    return globalShortcut.register(accelerator, () => toggleOverlay());
  } catch {
    return false;
  }
}

export function unregisterOverlayShortcut(): void {
  try {
    globalShortcut.unregisterAll();
  } catch { /* kilépéskor ez már nem számít */ }
}
