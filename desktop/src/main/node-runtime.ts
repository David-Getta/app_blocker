// A Node.js futtató a védett futtatókörnyezethez (#151, macOS): a felület tölti
// le a felhasználó gyorsítótárába (a rendszer proxyján át), a rögzített
// ujjlenyomat szerint ellenőrizve. A telepítő és a segéd a bemásolt példányt
// még egyszer ellenőrzi (aláíróval együtt) — ez a letöltés csak a rendelkezésre
// állásért felel.

import { app, net } from 'electron';
import { execFile } from 'child_process';
import * as path from 'path';
import { NODE_RUNTIME, nodeTarName, nodeTarUrls } from '../shared/helper-runtime';
import { cachedTarballOk, downloadVerified, type FetchFn } from '../shared/node-download';

/** A gép architektúrája — Rosetta alatt is a natív (a root héj is ezt választja). */
export function machineArch(): Promise<'arm64' | 'x64'> {
  return new Promise((resolve) => {
    execFile('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { timeout: 5000 }, (err, out) => {
      resolve(!err && String(out).trim() === '1' ? 'arm64' : 'x64');
    });
  });
}

export function nodeCacheDir(): string {
  return path.join(app.getPath('home'), 'Library', 'Caches', 'hu.breaker.app', 'node');
}

const netFetch: FetchFn = async (url) => {
  const res = await net.fetch(url);
  return { ok: res.ok, status: res.status, body: res.body as unknown as AsyncIterable<Uint8Array> | null };
};

let inFlight: Promise<string> | null = null;

/** A rögzített Node tarballja a gyorsítótárban — ha kell, letöltve. Az útját adja. */
export function ensureNodeTarball(): Promise<string> {
  inFlight ??= (async () => {
    const arch = await machineArch();
    const pin = NODE_RUNTIME[arch];
    const dest = path.join(nodeCacheDir(), nodeTarName(arch));
    if (!cachedTarballOk(dest, pin)) await downloadVerified(nodeTarUrls(arch), dest, pin, netFetch);
    return dest;
  })().finally(() => { inFlight = null; });
  return inFlight;
}
