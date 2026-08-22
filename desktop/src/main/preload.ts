import { contextBridge, ipcRenderer } from 'electron';

export interface LakatBridge {
  call(op: string, payload?: Record<string, unknown>): Promise<
    { ok: true; data: unknown } | { ok: false; error: string; code?: string }
  >;
  install(): Promise<{ ok: true } | { ok: false; error: string }>;
  platform: string;
}

const bridge: LakatBridge = {
  call: (op, payload) => ipcRenderer.invoke('lakat:call', op, payload ?? {}),
  install: () => ipcRenderer.invoke('lakat:install'),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('lakat', bridge);
