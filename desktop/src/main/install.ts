// One-time privileged install of the helper.
//
// macOS: writes a LaunchDaemon plist and bootstraps it — ONE admin password
//        prompt at install, then the helper runs as root at every boot with
//        no further prompts. (This is why the app never nags on startup.)
// Windows: registers a SYSTEM scheduled task that starts at boot — ONE UAC
//        prompt at install.

import { app } from 'electron';
import { execFile } from 'child_process';
import * as path from 'path';
import { launchdPlist, macInstallAppleScript, windowsLauncherCommand } from '../shared/install-script';
import { clientKeyHash } from '../shared/client-key';
import { ensureHelperKey } from './helper-key';

function helperEntryPath(): string {
  // Inside the packaged app this resolves into app.asar; Electron's node mode
  // (ELECTRON_RUN_AS_NODE=1) can require from asar just fine.
  return path.join(app.getAppPath(), 'dist', 'helper', 'index.js');
}

function runFile(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 180_000 }, (err, stdout, stderr) => {
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
  // Bake the installing user's uid into the daemon args so the root helper can
  // restrict its IPC socket to that account (see helper/server.ts).
  const ownerUid = process.getuid ? process.getuid() : -1;
  const plist = launchdPlist(process.execPath, helperEntryPath(), ownerUid);
  const { code, out } = await runFile('/usr/bin/osascript', ['-e', macInstallAppleScript(plist)]);
  if (code !== 0) throw new Error(`A telepítés nem sikerült: ${out.trim()}`);
}

async function installWindows(): Promise<void> {
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
