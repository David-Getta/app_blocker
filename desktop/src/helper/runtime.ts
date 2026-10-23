// A segéd és a védett futtatókörnyezet (#151, macOS): honnan fut, melyik
// változat, és mikor mondja, hogy rendben elindult.
//
// A futtatókörnyezetben (helper-runtime.ts: RUNTIME_ROOT) minden változat egy
// 16 hexa jegyű nevű mappa; a `current` link mutat a futóra. A segéd a saját
// útjából tudja, melyikből fut (a Node a belépési pont valódi útját adja, a
// linket feloldva). Amikor elindult, a csatornája nyitva van, és a tiltás egyszer
// már érvényesült, leteszi a `.ok-<név>` jelet: a telepítő (runtime-shell.ts)
// és az őr (guard-script.ts) ebből tudja, hogy az új változat rendben van.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PAYLOAD_ENTRY, RUNTIME_ID_RE, RUNTIME_ROOT } from '../shared/helper-runtime';

export type HelperLayout = 'root' | 'bundle' | 'dev';

export interface RuntimeInfo {
  layout: HelperLayout;
  /** a változat neve (csak a védett futtatókörnyezetben) */
  id?: string;
  /** a csomag ujjlenyomata (runtime.json) */
  payloadSha256?: string;
  /** a Node verziója (runtime.json) */
  nodeVersion?: string;
  binSha256?: string;
  /** az app verziója, amivel a csomag készült (app/package.json) */
  appVersion?: string;
}

const ENTRY_DIR = path.posix.dirname(PAYLOAD_ENTRY); // app/dist/helper

/** A segéd mappájából (__dirname) a változat neve — vagy null, ha nem a futtatókörnyezetből fut. */
export function runtimeIdOf(dir: string, root: string = RUNTIME_ROOT): string | null {
  if (!dir.startsWith(`${root}/`)) return null;
  const rest = dir.slice(root.length + 1);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const id = rest.slice(0, slash);
  if (!RUNTIME_ID_RE.test(id) || rest.slice(slash + 1) !== ENTRY_DIR) return null;
  return id;
}

/** Az elrendezés: a futtatókörnyezetből, az app-csomagból, vagy fejlesztői futás. */
export function layoutOf(dir: string, root: string = RUNTIME_ROOT): HelperLayout {
  if (runtimeIdOf(dir, root)) return 'root';
  return dir.includes('/app.asar/') || dir.includes('\\app.asar\\') ? 'bundle' : 'dev';
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const str = (v: unknown, re: RegExp): string | undefined => (typeof v === 'string' && re.test(v) ? v : undefined);

/** A futó változat adatai — a futtatókörnyezet saját (rootnak írható) fájljaiból. */
export function runtimeInfo(dir: string, root: string = RUNTIME_ROOT): RuntimeInfo {
  const id = runtimeIdOf(dir, root);
  if (!id) return { layout: layoutOf(dir, root) };
  const base = path.join(root, id);
  const rt = readJson(path.join(base, 'runtime.json')) ?? {};
  const pkg = readJson(path.join(base, 'app', 'package.json')) ?? {};
  return {
    layout: 'root',
    id,
    payloadSha256: str(rt.payloadSha256, /^[0-9a-f]{64}$/),
    binSha256: str(rt.binSha256, /^[0-9a-f]{64}$/),
    nodeVersion: str(rt.nodeVersion, /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/),
    appVersion: str(pkg.version, /^\d{1,4}\.\d{1,5}\.\d{1,6}$/),
  };
}

/** A `current` link célja — vagy null. */
export function currentTarget(root: string = RUNTIME_ROOT): string | null {
  try {
    const t = fs.readlinkSync(path.join(root, 'current'));
    return RUNTIME_ID_RE.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * A jel: ez a változat elindult, a csatornája nyitva, a tiltás érvényesült. Ha
 * egy csendes frissítés erre a változatra várt (.pending), az is lezárul.
 */
export function markHealthy(id: string, log: (m: string) => void, root: string = RUNTIME_ROOT): void {
  try {
    fs.writeFileSync(path.join(root, `.ok-${id}`), `${new Date().toISOString()}\n`, { mode: 0o600 });
    const pf = path.join(root, '.pending');
    let first = '';
    try { first = fs.readFileSync(pf, 'utf8').split('\n')[0]; } catch { /* nincs */ }
    if (first === id) {
      fs.rmSync(pf, { force: true });
      log(`a frissítés rendben: ${id}`);
    }
  } catch (e) {
    log(`a futtatókörnyezet jele nem íródott ki: ${(e as Error).message}`);
  }
}

/**
 * Az önellenőrzés (`--selfcheck`): a telepítő a stage-ben, a beállított Node-dal
 * futtatja, MIELŐTT bármit átállítana. A segéd teljes kódja ekkor már betöltődött
 * (a belépési pont importjai); itt a futtató képességeit nézzük, amire a segéd
 * épít. Fájlhoz, hálózathoz, állapothoz nem nyúl.
 */
export function selfCheck(): boolean {
  try {
    const major = Number(process.versions.node.split('.')[0]);
    if (!(major >= 20)) return false;
    if (crypto.createHash('sha256').update('breaker').digest('hex').length !== 64) return false;
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const sig = crypto.sign(null, Buffer.from('breaker'), privateKey);
    if (!crypto.verify(null, Buffer.from('breaker'), publicKey, sig)) return false;
    // A szinkron kulcsa scrypt-tel készül (shared/sync/crypto.ts).
    if (crypto.scryptSync('a', 'b', 16, { N: 1024, r: 8, p: 1 }).length !== 16) return false;
    return true;
  } catch {
    return false;
  }
}
