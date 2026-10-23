// A Node.js tarball letöltése és ellenőrzése (#151, macOS): a felület tölti le
// a felhasználó gyorsítótárába, és csak a rögzített SHA-256 és méret szerint
// fogadja el. A forrás csak a rendelkezésre állást számít, a bizalmat nem — a
// telepítő és a segéd a bemásolt példányt még egyszer ellenőrzi.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { NodePin } from './helper-manifest';

/**
 * A letöltő: egy WHATWG fetch-szerű hívás (Electronban a net.fetch — a
 * rendszer proxyját is). A `signal` megszakítja; aki nem figyel rá, attól a
 * letöltő akkor is továbblép (lásd withAbort).
 */
export type FetchFn = (url: string, signal: AbortSignal) => Promise<{ ok: boolean; status: number; body: AsyncIterable<Uint8Array> | null }>;

/**
 * Egy forrás korlátai: ha ennyi ideig egy bájt sem jön (`idleMs`), vagy az
 * egész tovább tart (`totalMs`), a következő forrás jön. Egy elakadt kapcsolat
 * (fogva tartó portál, pufferelő proxy) különben a telepítést és a csendes
 * frissítést is az app újraindításáig fogná.
 */
export interface DownloadLimits { idleMs: number; totalMs: number }
export const DOWNLOAD_LIMITS: DownloadLimits = { idleMs: 60_000, totalMs: 15 * 60_000 };

/** Egy ígéret, ami a jelzésre elutasul — akkor is, ha a mögötte lévő munka nem áll le. */
function withAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** A gyorsítótárban lévő tarball jó-e; ha nem, töröljük. */
export function cachedTarballOk(file: string, pin: Pick<NodePin, 'tarSha256' | 'tarSize'>): boolean {
  try {
    const st = fs.lstatSync(file);
    if (st.isFile() && st.size === pin.tarSize && sha256File(file) === pin.tarSha256) return true;
  } catch {
    return false;
  }
  fs.rmSync(file, { force: true });
  return false;
}

/**
 * Letöltés a felsorolt címek egyikéről: legfeljebb `pin.tarSize` bájt (több
 * már hiba), ideiglenes fájlba, ellenőrzés, aztán átnevezés. Az első jó
 * forrásnál megáll; ha egyik sem jó, dob. Egy forrás sem tarthat tovább a
 * korlátainál (DOWNLOAD_LIMITS).
 */
export async function downloadVerified(
  urls: string[], dest: string, pin: Pick<NodePin, 'tarSha256' | 'tarSize'>, fetchFn: FetchFn,
  limits: DownloadLimits = DOWNLOAD_LIMITS,
): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const errors: string[] = [];
  for (const url of urls) {
    const tmp = `${dest}.${crypto.randomBytes(6).toString('hex')}.part`;
    const ac = new AbortController();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => ac.abort(new Error('elakadt')), limits.idleMs);
    };
    const overall = setTimeout(() => ac.abort(new Error('túl lassú')), limits.totalMs);
    let it: AsyncIterator<Uint8Array> | null = null;
    try {
      arm();
      const res = await withAbort(fetchFn(url, ac.signal), ac.signal);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const hash = crypto.createHash('sha256');
      const fd = fs.openSync(tmp, 'wx', 0o600);
      let total = 0;
      try {
        it = res.body[Symbol.asyncIterator]();
        for (;;) {
          arm();
          const { value, done } = await withAbort(it.next(), ac.signal);
          if (done) break;
          total += value.length;
          if (total > pin.tarSize) throw new Error('túl nagy');
          hash.update(value);
          fs.writeSync(fd, value);
        }
        it = null;
      } finally {
        fs.closeSync(fd);
      }
      if (total !== pin.tarSize) throw new Error(`a méret nem egyezik (${total})`);
      if (hash.digest('hex') !== pin.tarSha256) throw new Error('az ujjlenyomat nem egyezik');
      fs.renameSync(tmp, dest);
      return;
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      errors.push(`${url}: ${(e as Error).message}`);
    } finally {
      if (idle) clearTimeout(idle);
      clearTimeout(overall);
      ac.abort(new Error('kész'));
      // Egy félbehagyott olvasó elengedése (a hálózati kapcsolat is záruljon).
      if (it?.return) void Promise.resolve(it.return()).catch(() => undefined);
    }
  }
  throw new Error(`A Node.js letöltése nem sikerült — ${errors.join('; ')}`);
}
