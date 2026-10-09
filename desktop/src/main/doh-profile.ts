// A böngésző-DoH zár profil mentése és megnyitása (csak macOS).
//
// A profil szövege a segéd adatából készül (helper/doh-policy.ts), hogy a
// gépszintű beállítás és a profil ugyanazokat a böngészőket fedje. Itt csak
// a mentés és a megnyitás van: a telepítés a felhasználó lépése a
// Rendszerbeállításokban — az app nem tud és nem is akar profilt csendben
// feltenni.

import * as fs from 'fs';
import * as path from 'path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { dohProfileXml } from '../helper/doh-policy';
import { dohLockState, type DohLockState } from './doh-lock-state';

export type DohProfileOutcome =
  | { ok: true; path: string }
  | { ok: false; canceled: true }
  | { ok: false; error: string };

export function registerDohProfileIpc(): void {
  // Mi áll most a kezelt beállítások között — a felület ebből mondja, hogy a
  // tilalom kötelező-e (és melyik böngészőben). Nem Macen: nincs mit nézni.
  ipcMain.handle('breaker:doh-lock-state', async (): Promise<DohLockState | null> =>
    (process.platform === 'darwin' ? dohLockState() : null));
  ipcMain.handle('breaker:save-doh-profile', async (e): Promise<DohProfileOutcome> => {
    if (process.platform !== 'darwin') return { ok: false, error: 'a profil csak macOS-en kell' };
    const options = {
      title: 'A böngésző-DoH zár profil mentése',
      defaultPath: path.join(app.getPath('downloads'), 'Breaker-DoH.mobileconfig'),
      filters: [{ name: 'Konfigurációs profil', extensions: ['mobileconfig'] }],
    };
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(res.filePath, dohProfileXml());
    } catch (err) {
      return { ok: false, error: `a mentés nem sikerült: ${String(err)}` };
    }
    // A megnyitás a rendszert kéri meg, hogy vegye fel a profilt a
    // telepítendők közé; a telepítést a felhasználó hagyja jóvá.
    const openError = await shell.openPath(res.filePath);
    if (openError) return { ok: false, error: `elmentve (${res.filePath}), de nem nyílt meg: ${openError}` };
    return { ok: true, path: res.filePath };
  });
}
