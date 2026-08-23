// One-time privileged install of the helper.
//
// macOS: writes a LaunchDaemon plist and bootstraps it — ONE admin password
//        prompt at install, then the helper runs as root at every boot with
//        no further prompts. (This is why the app never nags on startup.)
// Windows: registers a SYSTEM scheduled task that starts at boot — ONE UAC
//        prompt at install.

import { app } from 'electron';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DAEMON_LABEL = 'hu.lakat.helper';
const TASK_NAME = 'LakatHelper';

function helperEntryPath(): string {
  // Inside the packaged app this resolves into app.asar; Electron's node mode
  // (ELECTRON_RUN_AS_NODE=1) can require from asar just fine.
  return path.join(app.getAppPath(), 'dist', 'helper', 'index.js');
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function launchdPlist(): string {
  // Bake the installing user's uid into the daemon args so the root helper can
  // restrict its IPC socket to that account (see helper/server.ts).
  const ownerUid = process.getuid ? process.getuid() : -1;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(helperEntryPath())}</string>
    <string>--owner-uid=${ownerUid}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Library/Logs/Lakat/helper.log</string>
  <key>StandardErrorPath</key><string>/Library/Logs/Lakat/helper.log</string>
</dict>
</plist>
`;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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

/**
 * Egy csak-nekünk-szóló, kitalálhatatlan nevű, 0700-as könyvtár a temp alatt.
 *
 * Ami ide kerül, azt EMELT joggal olvassa be a rendszer (a plist mondja meg,
 * mit futtasson a root minden bootnál). Kitalálható néven — mint eddig a
 * `lakat-install.sh` — egy előre odakészített fájl a mienk helyére léphet.
 * A véletlen név és a szűk mód ezt a fajta „várom, hogy megjelenj” támadást
 * kizárja.
 *
 * Amit NEM zár ki: a SAJÁT felhasználóként már kódot futtató támadó a saját
 * könyvtárába továbbra is beleír, tehát a kiírás és az emelt futtatás közötti
 * pillanatban elvileg kicserélheti a tartalmat. Ez a maradék rés a
 * docs/architecture.md korlátai közt is szerepel; a teljes megoldás az, hogy a
 * privilegizált rész ne fájlból olvasson.
 */
function privateTempDir(): string {
  return fs.mkdtempSync(path.join(app.getPath('temp'), 'lakat-'));
}

async function installMac(): Promise<void> {
  const dir = privateTempDir();
  const plistTmp = path.join(dir, 'hu.lakat.helper.plist');
  fs.writeFileSync(plistTmp, launchdPlist(), { mode: 0o600 });
  const script = [
    'set -e',
    'mkdir -p "/Library/Application Support/Lakat" /Library/Logs/Lakat',
    `cp ${shQuote(plistTmp)} /Library/LaunchDaemons/${DAEMON_LABEL}.plist`,
    `chown root:wheel /Library/LaunchDaemons/${DAEMON_LABEL}.plist`,
    `chmod 644 /Library/LaunchDaemons/${DAEMON_LABEL}.plist`,
    `launchctl bootout system/${DAEMON_LABEL} 2>/dev/null || true`,
    `launchctl bootstrap system /Library/LaunchDaemons/${DAEMON_LABEL}.plist`,
  ].join('\n');
  const scriptTmp = path.join(dir, 'install.sh');
  fs.writeFileSync(scriptTmp, script, { mode: 0o700 });
  const { code, out } = await runFile('/usr/bin/osascript', [
    '-e',
    `do shell script "/bin/sh ${scriptTmp.replace(/"/g, '\\"')}" with administrator privileges`,
  ]);
  // A takarítás sosem buktathatja meg a telepítést: ha a démon már fut, a
  // felhasználó szempontjából kész vagyunk.
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nem baj */ }
  if (code !== 0) throw new Error(`A telepítés nem sikerült: ${out.trim()}`);
}

async function installWindows(): Promise<void> {
  const exe = process.execPath;
  // The inner script must exit non-zero on any failure, and the outer
  // (unelevated) powershell must propagate the elevated child's exit code —
  // Start-Process -Wait alone always exits 0.
  const ps = [
    `try {`,
    `  schtasks /Create /F /TN "${TASK_NAME}" /SC ONSTART /RU SYSTEM /RL HIGHEST /TR '"${exe}" --helper'`,
    `  if ($LASTEXITCODE -ne 0) { exit 1 }`,
    `  schtasks /Run /TN "${TASK_NAME}"`,
    `  if ($LASTEXITCODE -ne 0) { exit 2 }`,
    `  exit 0`,
    `} catch { exit 3 }`,
  ].join('\n');
  // Ugyanaz, mint macOS-en: ezt a fájlt EMELT joggal (SYSTEM) futtatja le a
  // rendszer, tehát a neve ne legyen kitalálható.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lakat-'));
  const psTmp = path.join(dir, 'install.ps1');
  fs.writeFileSync(psTmp, ps);
  const { code, out } = await runFile('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${psTmp}'; exit $p.ExitCode`,
  ]);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nem baj */ }
  if (code !== 0) {
    throw new Error(`A telepítés nem sikerült (kód: ${code}). ${out.trim()}`.trim());
  }
}

export async function installHelper(): Promise<void> {
  if (process.platform === 'darwin') return installMac();
  if (process.platform === 'win32') return installWindows();
  throw new Error('Ezen a platformon kézzel indítsd a helpert: sudo npm run helper:dev');
}
