import { contextBridge, ipcRenderer } from 'electron';
import type { OverlayShortcutInfo, OverlayShortcutResult } from './overlay-shortcut';

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'unsupported';
  version?: string;
  percent?: number;
  error?: string;
  /** the app applies the update itself (unsigned macOS build) */
  selfManaged?: boolean;
}

export interface TrackerState {
  /** the foreground probe has come back empty several times in a row */
  blocked: boolean;
  /** it has never once seen anything — the first-run / permission-denied case */
  neverWorked: boolean;
  /**
   * A segéd átveszi a mintákat, de sorozatban egyet sem rögzít.
   *
   * A `blocked` egy réteggel feljebb néz: ott a szonda nem lát semmit. Ez az
   * ellenkezője — a szonda LÁT, a mérés fut, és az idő mégis elveszik. A
   * felhasználó mindkettőből ugyanazt a nullát látja, a teendő viszont más.
   */
  samplesDropped: boolean;
  platform: string;
}

/** A gépen futó szinkron-kiszolgáló állapota. */
export interface SyncServerState {
  running: boolean;
  /** amit a másik eszközbe be kell írni */
  url?: string;
  /** ugyanez a saját gépről nézve (127.0.0.1) — a Wi-Fi váltásával sem változik */
  localUrl?: string;
  dataDir?: string;
  error?: string;
}

/** A böngésző-bővítménynek szóló helyi híd állapota. */
export interface RulesBridgeInfo {
  running: boolean;
  port?: number;
  /** amit a bővítmény beállításai közé kell bemásolni */
  token?: string;
  /**
   * Mikor húzta le a bővítmény utoljára a szabályokat (0 = még soha).
   *
   * A híd FUTÁSA és a bővítmény JELENLÉTE két külön dolog. A munkamenet
   * fehérlistáját a gépen kizárólag a bővítmény érvényesíti, tehát ha ez a
   * szám régi, a menet nem tiltana semmit a böngészőben.
   */
  lastPullAt?: number;
  error?: string;
}

export interface BreakerBridge {
  call(op: string, payload?: Record<string, unknown>): Promise<
    { ok: true; data: unknown } | { ok: false; error: string; code?: string }
  >;
  install(): Promise<{ ok: true } | { ok: false; error: string }>;
  checkUpdate(): Promise<{ ok: boolean; error?: string }>;
  installUpdate(): Promise<{ ok: boolean; opened?: boolean }>;
  getUpdateState(): Promise<UpdateState>;
  getTrackerState(): Promise<TrackerState>;
  getSyncServer(): Promise<SyncServerState>;
  getBridgeInfo(): Promise<RulesBridgeInfo>;
  getOverlayState(): Promise<{
    shortcutOk: boolean;
    warnApp?: string | null;
    /** igaz, ha a bővítmény két percnél régebben jelentkezett (vagy soha) */
    extensionStale?: boolean;
  }>;
  toggleOverlay(): Promise<void>;
  hideOverlay(): Promise<void>;
  showMain(): Promise<void>;
  startSyncServer(): Promise<SyncServerState>;
  stopSyncServer(): Promise<SyncServerState>;
  onUpdateState(cb: (s: UpdateState) => void): void;
  /** a futó app verziója — a fiók-panel mutatja, hogy látszódjon, MI fut */
  appVersion(): Promise<string>;
  /** kilépés a felületről; a tiltást nem érinti (az a segédé) */
  quitApp(): Promise<void>;
  /** a kiadási jegyzetek megnyitása a böngészőben */
  openReleases(): Promise<void>;
  /** a réteg gyorsbillentyűje — mi van beállítva, és tényleg a miénk-e */
  getOverlayShortcut(): Promise<OverlayShortcutInfo>;
  setOverlayShortcut(accelerator: string): Promise<OverlayShortcutResult>;
  resetOverlayShortcut(): Promise<OverlayShortcutResult>;
  platform: string;
}

const bridge: BreakerBridge = {
  call: (op, payload) => ipcRenderer.invoke('breaker:call', op, payload ?? {}),
  install: () => ipcRenderer.invoke('breaker:install'),
  checkUpdate: () => ipcRenderer.invoke('breaker:check-update'),
  installUpdate: () => ipcRenderer.invoke('breaker:install-update'),
  getUpdateState: () => ipcRenderer.invoke('breaker:update-state'),
  getTrackerState: () => ipcRenderer.invoke('breaker:tracker-state'),
  getSyncServer: () => ipcRenderer.invoke('breaker:sync-server-state'),
  getBridgeInfo: () => ipcRenderer.invoke('breaker:bridge-info'),
  getOverlayState: () => ipcRenderer.invoke('breaker:overlay-state'),
  toggleOverlay: () => ipcRenderer.invoke('breaker:overlay-toggle'),
  hideOverlay: () => ipcRenderer.invoke('breaker:overlay-hide'),
  showMain: () => ipcRenderer.invoke('breaker:show-main'),
  startSyncServer: () => ipcRenderer.invoke('breaker:sync-server-start'),
  stopSyncServer: () => ipcRenderer.invoke('breaker:sync-server-stop'),
  onUpdateState: (cb) => ipcRenderer.on('breaker:update-state', (_e, s: UpdateState) => cb(s)),
  appVersion: () => ipcRenderer.invoke('breaker:app-version'),
  quitApp: () => ipcRenderer.invoke('breaker:quit'),
  openReleases: () => ipcRenderer.invoke('breaker:open-releases'),
  getOverlayShortcut: () => ipcRenderer.invoke('breaker:overlay-shortcut'),
  setOverlayShortcut: (accelerator) => ipcRenderer.invoke('breaker:overlay-shortcut-set', accelerator),
  resetOverlayShortcut: () => ipcRenderer.invoke('breaker:overlay-shortcut-reset'),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('breaker', bridge);
