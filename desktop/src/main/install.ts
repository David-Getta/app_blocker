// One-time privileged install of the helper.
//
// macOS (#151): a védett futtatókörnyezetbe telepít (shared/runtime-shell.ts) —
//        EGY rendszergazdai jóváhagyás; utána a segéd rootként, a csak root által
//        írható helyről indul minden induláskor, és a későbbi kiadásokat csendben,
//        aláírva veszi át (helper/update.ts). Az app-csomagból már nem fut.
// Windows: registers a SYSTEM scheduled task that starts at boot — ONE UAC
//        prompt at install.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  appleScriptString, macInstallLocationProblem, windowsInstallLocationProblem, windowsLauncherCommand,
} from '../shared/install-script';
import { macGuardPlist, macGuardScript } from '../shared/guard-script';
import { UNSIGNED_KEY_ID } from '../shared/helper-manifest';
import { macosAtLeast, NODE_RUNTIME } from '../shared/helper-runtime';
import {
  MAC_INSTALL_ERRORS, MAC_INSTALL_PROMPT, macInstallError, macInstallScript, macRootCommand,
} from '../shared/runtime-shell';
import { ensureNodeTarball } from './node-runtime';
import { clientKeyHash } from '../shared/client-key';
import { ensureHelperKey } from './helper-key';

/**
 * Az app saját segéd-csomagja: a build írja (scripts/pack-helper-payload.js).
 * `signed`: a leírója alá van-e írva — aláíratlan csomagot a segéd csendben
 * nem vesz át, így felkínálni sincs értelme.
 */
export interface HelperPayloadInfo { sha256: string; size: number; appVersion: string; helperVersion: string; signed: boolean }

export function helperPayloadInfo(): HelperPayloadInfo | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'helper-payload.json'), 'utf8')) as Omit<HelperPayloadInfo, 'signed'>;
    if (!/^[0-9a-f]{64}$/.test(v.sha256) || !Number.isSafeInteger(v.size) || v.size <= 0) return null;
    return { sha256: v.sha256, size: v.size, appVersion: v.appVersion, helperVersion: v.helperVersion, signed: bundleSigned() };
  } catch {
    return null;
  }
}

/** A csomag leírója aláírt-e (a kulcsot nem itt ellenőrizzük — azt a segéd teszi). */
function bundleSigned(): boolean {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(helperBundleDir(), 'manifest.json'), 'utf8')) as { keyId?: unknown };
    return typeof m.keyId === 'string' && m.keyId !== UNSIGNED_KEY_ID
      && fs.statSync(path.join(helperBundleDir(), 'manifest.sig')).isFile();
  } catch {
    return false;
  }
}

/** A csomag mappája az app-csomagban (a segéd csendes frissítése is innen veszi). */
export function helperBundleDir(): string {
  return path.join(process.resourcesPath, 'helper');
}

function runFile(
  cmd: string, args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 180_000, env: opts.env }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
        ? Number((err as unknown as { code: number }).code)
        : err ? 1 : 0;
      resolve({ code, out: `${stdout}\n${stderr}` });
    });
  });
}

// AZ EMELT RÉSZ NEM FÁJLBÓL OLVAS (lásd shared/install-script.ts): a teljes
// parancs — macOS-en a plist is, base64-ben — az emelt folyamat
// parancssorában megy. Eddig egy temp-fájlt futtattunk rendszergazdaként, és
// a kiírás meg a futtatás közötti pillanatban a saját felhasználóként már
// kódot futtató támadó kicserélhette — root/SYSTEM jogért.

async function installMac(): Promise<void> {
  // Lemezképről vagy karanténból nem: a bemenetek a leválasztáskor eltűnnének
  // (shared/install-script.ts).
  const problem = macInstallLocationProblem(process.execPath);
  if (problem) throw new Error(problem);
  if (!macosAtLeast(process.getSystemVersion(), NODE_RUNTIME.minMacos)) throw new Error(MAC_INSTALL_ERRORS.macos);
  const info = helperPayloadInfo();
  const payloadTar = path.join(helperBundleDir(), 'payload.tar');
  if (!info || !fs.existsSync(payloadTar)) {
    throw new Error('Ebből az appból hiányzik a háttérszolgáltatás csomagja. Töltsd le újra az appot.');
  }
  // A Node: a gyorsítótárból vagy letöltve. Ha nem sikerül, a telepítő a már
  // telepített futtatót kölcsönözheti (javításnál) — ha az sincs, need-node.
  let nodeTar: string | null = null;
  try {
    nodeTar = await ensureNodeTarball();
  } catch {
    nodeTar = null;
  }
  // A telepítő felhasználó azonosítója a segéd kapcsolói közé kerül: a root
  // segéd a csatornáját erre a fiókra szűkíti (helper/server.ts).
  const ownerUid = process.getuid ? process.getuid() : -1;
  const script = macInstallScript({
    ownerUid, payloadTar, payloadSha256: info.sha256, payloadSize: info.size, nodeTar,
    guardScript: macGuardScript(), guardPlist: macGuardPlist(),
  });
  const appleScript = `do shell script ${appleScriptString(macRootCommand(script))}`
    + ` with prompt ${appleScriptString(MAC_INSTALL_PROMPT)} with administrator privileges`;
  // Tiszta, minimális környezet: a jelszóval induló külső héj se örököljön
  // semmit, amit a felhasználó beállíthat (runtime-shell.ts: macRootCommand).
  // Az időkorlát bő: a jelszóablak és a telepítő saját korlátai férjenek bele.
  const { code, out } = await runFile('/usr/bin/osascript', ['-e', appleScript], {
    timeout: 15 * 60_000, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  if (code !== 0) {
    if (/User canceled|\(-128\)/.test(out)) throw new Error('A telepítést megszakítottad.');
    throw new Error(macInstallError(out) ?? `A telepítés nem sikerült: ${out.trim()}`);
  }
}

async function installWindows(): Promise<void> {
  // Csak a Program Files alól: máshonnan egy sima felhasználó kicserélhetné,
  // amit a segéd SYSTEM-ként futtat (shared/install-script.ts).
  const problem = windowsInstallLocationProblem(process.execPath, process.env);
  if (problem) throw new Error(problem);
  // A KULCS LENYOMATA a feladat parancssorába (shared/client-key.ts): a segéd
  // ezzel ismeri fel a telepítő felhasználó appját — a pipe-ja enélkül
  // senkinek nem írható, vele bárkinek, de csak a kulcs birtokosa kap szót.
  const keyHash = clientKeyHash(ensureHelperKey());
  // The inner script must exit non-zero on any failure, and the outer
  // (unelevated) powershell must propagate the elevated child's exit code —
  // Start-Process -Wait alone always exits 0.
  const { code, out } = await runFile('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', windowsLauncherCommand(process.execPath, keyHash),
  ]);
  if (code !== 0) {
    throw new Error(`A telepítés nem sikerült (kód: ${code}). ${out.trim()}`.trim());
  }
}

export async function installHelper(): Promise<void> {
  if (process.platform === 'darwin') return installMac();
  if (process.platform === 'win32') return installWindows();
  throw new Error('Ezen a platformon kézzel indítsd a helpert: sudo npm run helper:dev');
}
