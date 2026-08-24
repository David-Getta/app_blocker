import { contextBridge, ipcRenderer } from 'electron';

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
  getOverlayState(): Promise<{ shortcutOk: boolean }>;
  toggleOverlay(): Promise<void>;
  hideOverlay(): Promise<void>;
  showMain(): Promise<void>;
  startSyncServer(): Promise<SyncServerState>;
  stopSyncServer(): Promise<SyncServerState>;
  onUpdateState(cb: (s: UpdateState) => void): void;
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
  platform: process.platform,
};

contextBridge.exposeInMainWorld('breaker', bridge);
