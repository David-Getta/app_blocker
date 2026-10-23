// A segéd csendes frissítése (#151, macOS): a felület felkínálja a saját
// csomagját, a segéd — rootként, a védett futtatókörnyezetből — átveszi, ha a
// projekt kiadási kulcsa aláírta, és újabb, mint ami fut. Jelszó nem kell.
//
// A SORREND:
//   1. Zár ($RT/.lock, a segéd azonosítójával): egyszerre egy frissítés vagy
//      telepítés; amíg tartjuk, az őr nem állít vissza.
//   2. Bemásolás (runtime-shell.ts, macFetchScript): a felhasználó helyéről egy
//      `$RT/.in.*` mappába, időkorláttal és mérethatárral, külön folyamatban —
//      egy FIFO vagy egy lassú kötet nem akaszthatja meg a segéd körét.
//   3. Ellenőrzés: az aláírás a FUTÓ segéd kulcslistájával (shared/helper-keys.ts
//      és, csak a CI próbájában, a futtatókörnyezet saját test-keys.json-ja); az
//      app-verzió szigorúan újabb; a csomag ujjlenyomata és mérete a leíróé; egy
//      egyszer már el nem indult csomag (.bad) nem jöhet újra.
//   4. Összeállítás (macStageScript): ugyanaz, mint a telepítésé — a Node a futó
//      változatból kölcsönözve, ha a leíró ugyanazt rögzíti, különben a
//      felkínált tarballból, a leíró ujjlenyomataival és a Team ID-val.
//   5. Váltás: előbb a .pending (az új és az előző változat neve), aztán a
//      current link egy átnevezéssel. A segéd válaszol, kilép, és a launchd az új
//      változatot indítja. Ha az nem jelentkezik (.ok-<név>), az őr pár perc
//      múlva visszaállít, és a csomagot a .bad-be írja.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isNewer, verifyManifest, type HelperManifest, type ReleaseKey } from '../shared/helper-manifest';
import { NODE_RUNTIME, RUNTIME_ID_RE } from '../shared/helper-runtime';
import { macFetchScript, macStageScript, type MacRuntimeShellOptions } from '../shared/runtime-shell';

export type UpdateError =
  | 'unsupported' | 'busy' | 'cooldown' | 'path' | 'copy' | 'unsigned' | 'not-newer' | 'bad'
  | 'mismatch' | 'need-node' | 'stage' | 'activate';

export type UpdateResult =
  | { ok: true; id: string; appVersion: string; payloadSha256: string }
  | { ok: false; error: UpdateError; detail?: string };

export interface UpdateOffer {
  /** a csomag mappája az app-csomagban: …/Contents/Resources/helper */
  bundle: string;
  /** a letöltött Node tarball, ha a frissítés új Node-ot kér */
  nodeTar?: string;
}

export interface UpdateDeps {
  /** a védett futtatókörnyezet */
  root: string;
  /** a futó változat */
  ownId: string;
  ownAppVersion: string;
  ownBinSha256: string;
  arch: 'arm64' | 'x64';
  /** a megbízható kiadási kulcsok */
  keys: () => readonly ReleaseKey[];
  /** egy héjszkript futtatása (tiszta környezetben, időkorláttal) */
  runShell: (script: string) => Promise<{ code: number; out: string; err: string }>;
  shellOptions: MacRuntimeShellOptions;
  log: (m: string) => void;
  now: () => number;
  pid: number;
  /** a pid él-e (egy halott tartó zárját átvesszük) */
  alive: (pid: number) => boolean;
  /** a felkínáló (a socket gazdája): a bemeneteket az ő jogaival olvassuk */
  readAs: number;
}

/** A felkínált utak alakja: a csomag mappája és a Node tarball neve kötött. */
export function offerPathProblem(offer: UpdateOffer): string | null {
  const ok = (p: unknown): p is string => typeof p === 'string' && p.startsWith('/') && p.length < 1024 && !/[\0\n\r]/.test(p)
    && !p.split('/').some((seg) => seg === '..' || seg === '.');
  if (!ok(offer.bundle) || !/\.app\/Contents\/Resources\/helper$/.test(offer.bundle)) return 'a csomag mappája';
  if (offer.nodeTar !== undefined && (!ok(offer.nodeTar) || !/\/node-v\d+\.\d+\.\d+-darwin-(arm64|x64)\.tar\.xz$/.test(offer.nodeTar))) {
    return 'a Node tarball';
  }
  return null;
}

const LOCK_STALE_MS = 10 * 60_000;

/** A futtatókörnyezet zárja: egy mappa, benne a tartó azonosítója. Igaz, ha megvan. */
export function takeLock(root: string, pid: number, alive: (pid: number) => boolean, now: number): boolean {
  const lock = path.join(root, '.lock');
  const mine = (): boolean => {
    fs.writeFileSync(path.join(lock, 'pid'), `${pid}\n`, { mode: 0o600 });
    return true;
  };
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
    return mine();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
  }
  let holder = NaN;
  try { holder = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim()); } catch { /* nincs */ }
  let age = 0;
  try { age = now - fs.statSync(lock).mtimeMs; } catch { /* eltűnt közben */ }
  // Üres vagy rossz azonosító: a tartó lehet, hogy épp most hozta létre — csak
  // egy perc után vesszük elavultnak.
  const fresh = age < 60_000;
  const badHolder = !Number.isSafeInteger(holder) || holder <= 0;
  const stale = (badHolder && !fresh) || (!badHolder && !alive(holder)) || age > LOCK_STALE_MS;
  if (!stale) return false;
  fs.rmSync(lock, { recursive: true, force: true });
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
    return mine();
  } catch {
    return false;
  }
}

export function releaseLock(root: string, pid: number): void {
  const lock = path.join(root, '.lock');
  try {
    if (fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim() !== String(pid)) return;
  } catch {
    return;
  }
  fs.rmSync(lock, { recursive: true, force: true });
}

/** Az egyszer már el nem indult csomagok (az őr írja). */
export function badPayloads(root: string): Set<string> {
  try {
    return new Set(fs.readFileSync(path.join(root, '.bad'), 'utf8').split('\n').filter((l) => /^[0-9a-f]{64}$/.test(l)));
  } catch {
    return new Set();
  }
}

/** A futó változat megbízható kulcsai: a kódba fordítottak, és (csak a CI-próbában) a futtatókörnyezet saját listája. */
export function trustedKeys(base: readonly ReleaseKey[], root: string, ownId: string): ReleaseKey[] {
  const keys = [...base];
  try {
    const extra = JSON.parse(fs.readFileSync(path.join(root, ownId, 'app', 'test-keys.json'), 'utf8')) as unknown;
    if (Array.isArray(extra)) {
      for (const k of extra) {
        if (k && typeof k === 'object' && typeof k.id === 'string' && typeof k.spki === 'string' && !keys.some((x) => x.id === k.id)) {
          keys.push({ id: k.id, spki: k.spki });
        }
      }
    }
  } catch { /* nincs: a kiadott csomagban sosincs */ }
  return keys;
}

function sha256File(file: string): { sha: string; size: number } {
  const buf = fs.readFileSync(file);
  return { sha: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
}

function token(err: string): string {
  const m = [...err.matchAll(/BRK:([a-z-]+)/g)];
  return m.length ? m[m.length - 1][1] : 'fail';
}

/**
 * Egy felkínált frissítés végig: zár, bemásolás, ellenőrzés, összeállítás,
 * váltás. Siker után a hívó válaszol, és kilép (a launchd az új változatot
 * indítja). A zárat a hívó engedi el (releaseLock) — sikernél a kilépés előtt.
 */
export async function runUpdate(offer: UpdateOffer, d: UpdateDeps): Promise<UpdateResult> {
  const why = offerPathProblem(offer);
  if (why) return { ok: false, error: 'path', detail: why };
  if (!takeLock(d.root, d.pid, d.alive, d.now())) return { ok: false, error: 'busy' };
  let inDir: string | null = null;
  let keepLock = false;
  try {
    // 2. Bemásolás.
    const fetched = await d.runShell(macFetchScript({ bundle: offer.bundle, nodeTar: offer.nodeTar ?? null, readAs: d.readAs }, d.shellOptions));
    const m = /^in (\/.+)$/m.exec(fetched.out);
    if (fetched.code !== 0 || !m) return { ok: false, error: 'copy', detail: token(fetched.err) };
    inDir = m[1];
    if (path.dirname(inDir) !== d.root || !/^\.in\.[A-Za-z0-9]+$/.test(path.basename(inDir))) {
      return { ok: false, error: 'copy', detail: 'váratlan mappa' };
    }

    // 3. Ellenőrzés.
    let manifest: HelperManifest;
    try {
      manifest = verifyManifest(
        fs.readFileSync(path.join(inDir, 'manifest.json')),
        fs.readFileSync(path.join(inDir, 'manifest.sig'), 'utf8'),
        d.keys(),
      );
    } catch (e) {
      // A részlet (a leíró hibája) csak a naplóba: a felkínálónak nem mondunk
      // többet a bemásolt fájlról, mint hogy nem fogadtuk el.
      d.log(`csendes frissítés: a leíró nem fogadható el (${(e as Error).message})`);
      return { ok: false, error: 'unsigned' };
    }
    if (!isNewer(manifest.appVersion, d.ownAppVersion)) {
      return { ok: false, error: 'not-newer', detail: `${manifest.appVersion} ≤ ${d.ownAppVersion}` };
    }
    const payload = sha256File(path.join(inDir, 'payload.tar'));
    if (payload.sha !== manifest.payload.sha256 || payload.size !== manifest.payload.size) {
      return { ok: false, error: 'mismatch' };
    }
    if (badPayloads(d.root).has(payload.sha)) return { ok: false, error: 'bad' };
    const pin = manifest.node[d.arch];
    const nodeTar = path.join(inDir, 'node.tar.xz');
    const haveTar = fs.existsSync(nodeTar);
    if (pin.binSha256 !== d.ownBinSha256 && !haveTar) return { ok: false, error: 'need-node', detail: manifest.node.version };

    // 4. Összeállítás: a Node rögzítése az aláírt leíróból, a Team ID és az
    // azonosító a futó kódból (azt a leíró sem írhatja felül).
    const staged = await d.runShell(macStageScript({
      payloadTar: path.join(inDir, 'payload.tar'),
      payloadSha256: manifest.payload.sha256,
      payloadSize: manifest.payload.size,
      nodeTar: pin.binSha256 === d.ownBinSha256 ? null : nodeTar,
    }, {
      ...d.shellOptions,
      pin: { ...NODE_RUNTIME, ...d.shellOptions.pin, version: manifest.node.version, arm64: manifest.node.arm64, x64: manifest.node.x64 },
    }));
    const s = /^ok ([0-9a-f]{16})$/m.exec(staged.out);
    if (staged.code !== 0 || !s) return { ok: false, error: 'stage', detail: token(staged.err) };
    const id = s[1];
    if (!RUNTIME_ID_RE.test(id) || id === d.ownId) return { ok: false, error: 'stage', detail: 'ugyanaz a változat' };

    // 5. Váltás: előbb a .pending (az őr ebből áll vissza), aztán a link.
    try {
      fs.writeFileSync(path.join(d.root, '.pending'), `${id}\n${d.ownId}\n`, { mode: 0o600 });
      const tmp = path.join(d.root, '.current.new');
      fs.rmSync(tmp, { force: true });
      fs.symlinkSync(id, tmp);
      fs.renameSync(tmp, path.join(d.root, 'current'));
    } catch (e) {
      fs.rmSync(path.join(d.root, '.pending'), { force: true });
      return { ok: false, error: 'activate', detail: (e as Error).message };
    }
    keepLock = true;
    d.log(`csendes frissítés: ${d.ownAppVersion} → ${manifest.appVersion} (${id}); újraindulok`);
    return { ok: true, id, appVersion: manifest.appVersion, payloadSha256: manifest.payload.sha256 };
  } finally {
    if (inDir) fs.rmSync(inDir, { recursive: true, force: true });
    if (!keepLock) releaseLock(d.root, d.pid);
  }
}
