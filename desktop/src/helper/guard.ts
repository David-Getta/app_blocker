// Az őr telepítése (shared/guard-script.ts) — a segéd maga végzi, root/SYSTEM-
// ként, minden induláskor, újabb jóváhagyás nélkül. (Egy régebbi segéd ezt nem
// teszi: a meglévő gépeken az őr a segéd első új indulásakor kerül fel — a
// HELPER_VERSION ezért lépett.) Mellé teszi a teljes eltávolító szkript
// másolatát is: a szigorú blokk magyarázata erre mutat.
//
// Sosem dob, és a segédet sosem állítja meg: ha valami nem sikerül, naplózza,
// és tíz perc múlva még egyszer próbálja.

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  GUARD_LABEL, MAC_GUARD_SCRIPT, macGuardPlist, macGuardScript, windowsGuardRegisterEncoded, windowsGuardScript,
} from '../shared/guard-script';
import { guardDir, uninstallCopyPath } from './paths';

/** Ír, ha a tartalom más — véletlen nevű, kizárólagos ideiglenes fájlon át. Igaz, ha írt. */
export function writeIfDifferent(file: string, content: string | Buffer, mode: number): boolean {
  const want = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  let have: Buffer | null = null;
  try { have = fs.readFileSync(file); } catch { /* még nincs */ }
  if (have && have.equals(want)) {
    fs.chmodSync(file, mode);
    return false;
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, want, { mode, flag: 'wx' });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  return true;
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : 1) : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      });
    } catch (e) {
      resolve({ code: 1, out: String(e) });
    }
  });
}

/** Az eltávolító másolata (a csomag dist/uninstall mappájából). */
export function ensureUninstallCopy(): void {
  const name = path.basename(uninstallCopyPath());
  const src = path.join(__dirname, '..', 'uninstall', name);
  fs.mkdirSync(guardDir(), { recursive: true });
  writeIfDifferent(uninstallCopyPath(), fs.readFileSync(src), 0o755);
}

async function ensureGuardMac(): Promise<void> {
  writeIfDifferent(MAC_GUARD_SCRIPT, macGuardScript(), 0o755);
  const plistPath = `/Library/LaunchDaemons/${GUARD_LABEL}.plist`;
  const changed = writeIfDifferent(plistPath, macGuardPlist(), 0o644);
  const loaded = (await run('/bin/launchctl', ['print', `system/${GUARD_LABEL}`])).code === 0;
  if (loaded && !changed) return;
  if (loaded) await run('/bin/launchctl', ['bootout', `system/${GUARD_LABEL}`]);
  const r = await run('/bin/launchctl', ['bootstrap', 'system', plistPath]);
  if (r.code !== 0) throw new Error(`launchctl bootstrap: ${r.out.trim()}`);
}

async function ensureGuardWin(): Promise<void> {
  const dir = guardDir();
  // Egy idegen helyre mutató csatolási pont alá nem írunk (a Program Files alá
  // sima felhasználó nem tehet ilyet, de olcsó megnézni).
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} csatolási pont — nem írok bele`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  fs.mkdirSync(dir, { recursive: true });
  const guardPath = path.join(dir, 'guard.ps1');
  writeIfDifferent(guardPath, windowsGuardScript(), 0o644);
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', windowsGuardRegisterEncoded(guardPath)]);
  if (r.code !== 0) throw new Error(`az őr feladata nem jött létre (${r.code}) ${r.out.trim()}`.trim());
}

/** Csak a becsomagolt, root/SYSTEM-ként futó segédnél — a fejlesztői futás nem telepít őrt. */
export function guardApplies(): boolean {
  if (process.env.BREAKER_STATE) return false;
  if (!__dirname.includes('app.asar')) return false;
  if (process.platform === 'darwin') return typeof process.getuid === 'function' && process.getuid() === 0;
  return process.platform === 'win32';
}

export function setupGuard(log: (m: string) => void): void {
  if (!guardApplies()) return;
  const attempt = async (): Promise<boolean> => {
    try {
      // Előbb az eltávolító: a szigorú blokk magyarázata ide mutat.
      ensureUninstallCopy();
      if (process.platform === 'darwin') await ensureGuardMac();
      else await ensureGuardWin();
      log('az őr a helyén (ha az app eltűnik, a szigorú blokk áll be)');
      return true;
    } catch (e) {
      log(`az őr nem települt: ${(e as Error).message}`);
      return false;
    }
  };
  void attempt().then((ok) => {
    if (!ok) setTimeout(() => { void attempt(); }, 10 * 60_000);
  });
}
