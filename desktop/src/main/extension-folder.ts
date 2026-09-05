// A bővítmény mappája az appban: hol a csomagolt forrás, hova kerül, IPC.
//
// A mag (lenyomat, másolás) az `extension-folder-core.ts`-ben él Electron
// nélkül; itt csak az app-specifikus rész van: a csomagolt forrás helye, a
// userData célmappa, és a felület két kérdése (hol van, nyisd meg).

import * as path from 'path';
import { app, ipcMain, shell } from 'electron';
import { readManifestVersion, syncExtensionFolder } from './extension-folder-core';

export interface ExtensionFolderInfo {
  path: string;
  /** a manifest verziója a mappában (null, ha nincs mappa) */
  version: string | null;
  /** ebben az indításban frissült-e a mappa */
  refreshed: boolean;
  error?: string;
}

/** Csomagolt appban a resources mellett (extraResources); fejlesztés közben a repó mappája. */
export function bundledExtensionDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.resolve(__dirname, '..', '..', '..', 'extension');
}

export function setupExtensionFolder(
  userDataDir: string, log: (m: string) => void = () => { /* néma */ },
): ExtensionFolderInfo {
  const dest = path.join(userDataDir, 'extension');
  let info: ExtensionFolderInfo;
  try {
    const refreshed = syncExtensionFolder(bundledExtensionDir(), dest);
    info = { path: dest, version: readManifestVersion(dest), refreshed };
    if (refreshed) log(`extension folder refreshed: ${dest} (${info.version ?? '?'})`);
  } catch (e) {
    // A mappa nélkül is minden más megy: a bővítmény kézzel, a zipből is
    // betölthető. A hibát a felület kimondja, nem nyeli le.
    info = { path: dest, version: readManifestVersion(dest), refreshed: false, error: String(e) };
    log(`extension folder sync failed: ${String(e)}`);
  }
  ipcMain.handle('breaker:extension-folder', () => info);
  ipcMain.handle('breaker:open-extension-folder', () => { void shell.openPath(info.path); });
  return info;
}
