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

export interface LakatBridge {
  call(op: string, payload?: Record<string, unknown>): Promise<
    { ok: true; data: unknown } | { ok: false; error: string; code?: string }
  >;
  install(): Promise<{ ok: true } | { ok: false; error: string }>;
  checkUpdate(): Promise<{ ok: boolean; error?: string }>;
  installUpdate(): Promise<{ ok: boolean; opened?: boolean }>;
  getUpdateState(): Promise<UpdateState>;
  getTrackerState(): Promise<TrackerState>;
  onUpdateState(cb: (s: UpdateState) => void): void;
  platform: string;
}

const bridge: LakatBridge = {
  call: (op, payload) => ipcRenderer.invoke('lakat:call', op, payload ?? {}),
  install: () => ipcRenderer.invoke('lakat:install'),
  checkUpdate: () => ipcRenderer.invoke('lakat:check-update'),
  installUpdate: () => ipcRenderer.invoke('lakat:install-update'),
  getUpdateState: () => ipcRenderer.invoke('lakat:update-state'),
  getTrackerState: () => ipcRenderer.invoke('lakat:tracker-state'),
  onUpdateState: (cb) => ipcRenderer.on('lakat:update-state', (_e, s: UpdateState) => cb(s)),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('lakat', bridge);
