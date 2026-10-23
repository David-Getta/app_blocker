// A Node.js tarball letöltése és ellenőrzése (#151, macOS): a felület tölti le
// a felhasználó gyorsítótárába, és csak a rögzített SHA-256 és méret szerint
// fogadja el. A forrás csak a rendelkezésre állást számít, a bizalmat nem — a
// telepítő és a segéd a bemásolt példányt még egyszer ellenőrzi.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { NodePin } from './helper-manifest';

/** A letöltő: egy WHATWG fetch-szerű hívás (Electronban a net.fetch — a rendszer proxyját is). */
export type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; body: AsyncIterable<Uint8Array> | null }>;

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
 * forrásnál megáll; ha egyik sem jó, dob.
 */
export async function downloadVerified(
  urls: string[], dest: string, pin: Pick<NodePin, 'tarSha256' | 'tarSize'>, fetchFn: FetchFn,
): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const errors: string[] = [];
  for (const url of urls) {
    const tmp = `${dest}.${crypto.randomBytes(6).toString('hex')}.part`;
    try {
      const res = await fetchFn(url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const hash = crypto.createHash('sha256');
      const fd = fs.openSync(tmp, 'wx', 0o600);
      let total = 0;
      try {
        for await (const chunk of res.body) {
          total += chunk.length;
          if (total > pin.tarSize) throw new Error('túl nagy');
          hash.update(chunk);
          fs.writeSync(fd, chunk);
        }
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
    }
  }
  throw new Error(`A Node.js letöltése nem sikerült — ${errors.join('; ')}`);
}
