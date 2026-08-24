// A híd huzalozása az Electronhoz.
//
// Külön fájl, mert a `rules-bridge.ts` szándékosan nem tud az Electronról: azt
// egy sima node-teszt is be tudja tölteni, és a lényegi részei ott vannak
// megvizsgálva. Ami itt marad, az a ragasztó — a kód tárolása és az IPC.

import * as fs from 'fs';
import * as path from 'path';
import { ipcMain } from 'electron';
import {
  newBridgeToken, startRulesBridge, type BridgeFocus, type BridgeHandle, type BridgeRule,
} from './rules-bridge';

export interface BridgeInfo {
  running: boolean;
  port?: number;
  /** amit a bővítmény beállításai közé kell bemásolni */
  token?: string;
  error?: string;
}

let handle: BridgeHandle | null = null;
let info: BridgeInfo = { running: false };

function tokenFile(userDataDir: string): string {
  return path.join(userDataDir, 'extension-bridge.json');
}

/**
 * A kód MEGMARAD két indítás között.
 *
 * Ha minden indításnál újat gyártanánk, a bővítmény minden reggel elveszítené a
 * kapcsolatot, és a felhasználónak újra be kellene másolnia. Ami naponta kell,
 * azt egy hét után senki nem csinálja meg.
 */
export function loadOrCreateToken(userDataDir: string): string {
  const file = tokenFile(userDataDir);
  try {
    const got = JSON.parse(fs.readFileSync(file, 'utf8')).token;
    if (typeof got === 'string' && got.length >= 8) return got;
  } catch { /* nincs még, vagy sérült: csinálunk újat */ }
  const token = newBridgeToken();
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    // 0600: ez a kód nyitja a szabálylistát a gépen belül. Más felhasználó
    // fiókjának semmi köze hozzá.
    fs.writeFileSync(file, JSON.stringify({ token }), { mode: 0o600 });
  } catch { /* ha nem tudjuk elmenteni, a mostani munkamenetre akkor is jó */ }
  return token;
}

export function bridgeInfo(): BridgeInfo {
  return info;
}

export function registerRulesBridge(
  userDataDir: string,
  getRules: () => Promise<BridgeRule[]>,
  getFocus?: () => Promise<BridgeFocus>,
): void {
  ipcMain.handle('breaker:bridge-info', () => bridgeInfo());
  if (handle) return;
  const token = loadOrCreateToken(userDataDir);
  void startRulesBridge({ token, getRules, getFocus }).then(
    (h) => { handle = h; info = { running: true, port: h.port, token }; },
    // A híd elmaradása nem hiba, amitől bármi más ne menne: a bővítmény ilyenkor
    // az utoljára letöltött listát használja, vagyis TOVÁBB TILT.
    (e: Error) => { info = { running: false, error: e.message }; },
  );
}

export function stopRulesBridge(): void {
  handle?.close();
  handle = null;
  info = { running: false };
}
