// A réteg gyorsbillentyűjének átállítása: betöltés, regisztrálás, IPC.
//
// A kombináció eddig be volt égetve. Ha egy másik program elvette, a réteg
// némán nem nyílt, és a felhasználó legfeljebb annyit tudott meg, hogy
// „foglalt” — tenni nem tudott ellene. Mostantól a Munkamenetek kártyán
// átállítható, és ez a modul felel azért, hogy amit a felület mond, az a
// rendszerben is úgy legyen: a mentett kombináció induláskor regisztrálódik,
// az átállítás csak akkor marad meg, ha a regisztráció tényleg sikerült, és
// sikertelen kísérlet után a RÉGI kombináció áll vissza, nem a semmi.
//
// A szabályokat (mi számít kombinációnak, hogyan íródik le) a tiszta
// `shared/shortcut.ts` mondja meg — itt csak alkalmazzuk őket.

import * as fs from 'fs';
import * as path from 'path';
import { ipcMain } from 'electron';
import { DEFAULT_OVERLAY_SHORTCUT, normalizeAccelerator } from '../shared/shortcut';
import { registerOverlayShortcut, releaseOverlayShortcut } from './overlay';

export interface OverlayShortcutInfo {
  accelerator: string;
  /** tényleg a miénk-e most — hamis, ha egy másik program elvette */
  registered: boolean;
  isDefault: boolean;
}

export type OverlayShortcutResult =
  | { ok: true; info: OverlayShortcutInfo }
  | { ok: false; error: string; info: OverlayShortcutInfo };

const BUSY = 'A kombináció foglalt — egy másik program használja. Válassz másikat.';

function prefFile(userDataDir: string): string {
  return path.join(userDataDir, 'overlay-shortcut.json');
}

/**
 * A mentett kombináció — vagy az alapértelmezés, ha nincs, vagy nem
 * fogadható el. Az elmentett szöveg is bemenet: egy kézzel átírt vagy sérült
 * érték ne dönthesse el, hogy a réteg egyáltalán nyílik-e.
 */
export function loadOverlayShortcut(userDataDir: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(prefFile(userDataDir), 'utf8')) as { accelerator?: unknown };
    return normalizeAccelerator(String(raw?.accelerator ?? '')) ?? DEFAULT_OVERLAY_SHORTCUT;
  } catch {
    return DEFAULT_OVERLAY_SHORTCUT;
  }
}

export function saveOverlayShortcut(userDataDir: string, accelerator: string): void {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(prefFile(userDataDir), JSON.stringify({ accelerator }));
  } catch { /* a beállítás a futó példányban él, legfeljebb újraindításkor nem */ }
}

/**
 * Regisztrálja a mentett kombinációt, és beköti az IPC-t.
 *
 * @returns lekérdezők a fő folyamatnak: a réteg-állapot (`shortcutOk`) innen
 * tudja, hogy a kombináció MOST a miénk-e — nem az indításkori pillanatkép.
 */
export function setupOverlayShortcut(
  userDataDir: string,
): { registered(): boolean; current(): string } {
  let current = loadOverlayShortcut(userDataDir);
  let registered = registerOverlayShortcut(current);

  const info = (): OverlayShortcutInfo => ({
    accelerator: current, registered, isDefault: current === DEFAULT_OVERLAY_SHORTCUT,
  });

  const apply = (raw: unknown): OverlayShortcutResult => {
    const next = normalizeAccelerator(String(raw ?? ''));
    if (!next) return { ok: false, error: 'Ez a kombináció nem fogadható el.', info: info() };
    if (next === current) {
      // Ugyanaz, mint ami van: ha induláskor foglalt volt, ez az újrapróbálás.
      if (!registered) registered = registerOverlayShortcut(current);
      return registered ? { ok: true, info: info() } : { ok: false, error: BUSY, info: info() };
    }
    releaseOverlayShortcut(current);
    if (registerOverlayShortcut(next)) {
      current = next;
      registered = true;
      saveOverlayShortcut(userDataDir, next);
      return { ok: true, info: info() };
    }
    // Nem sikerült: a régi kombináció álljon vissza — ha az sem megy, az
    // info kimondja (registered: false), a felület pedig azt írja ki.
    registered = registerOverlayShortcut(current);
    return { ok: false, error: BUSY, info: info() };
  };

  ipcMain.handle('breaker:overlay-shortcut', () => info());
  ipcMain.handle('breaker:overlay-shortcut-set', (_e, raw: unknown) => apply(raw));
  ipcMain.handle('breaker:overlay-shortcut-reset', () => apply(DEFAULT_OVERLAY_SHORTCUT));

  return { registered: () => registered, current: () => current };
}
