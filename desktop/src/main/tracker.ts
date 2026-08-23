// Active-time tracker (user session).
//
// Why it lives in the GUI process and not in the privileged helper: on macOS a
// root LaunchDaemon has no access to the user's Aqua session, and on Windows a
// SYSTEM service sits in session 0 — neither can see which window is focused.
// Foreground detection therefore has to run as the logged-in user. The helper
// still owns persistence; this module only measures and ships samples.
//
// Measurement rule (see docs/feature-usage-stats.md): a slice counts only when
// a window is focused AND the user is not idle. Browser time is attributed to
// the active tab's domain, everything else to the application.

import { powerMonitor } from 'electron';
import { execFile, spawn } from 'child_process';
import { normalizeDomain } from '../shared/blocklist';
import { decideSample, SAMPLE_INTERVAL_MS, type Foreground } from '../shared/usage';
import { SampleBuffer } from '../shared/sample-buffer';
import type { UsageSampleMsg } from '../shared/protocol';

/** Bundle ids / process names whose active tab we know how to read. */
const MAC_BROWSERS: Record<string, 'chromium' | 'safari'> = {
  'com.google.Chrome': 'chromium',
  'com.google.Chrome.canary': 'chromium',
  'com.microsoft.edgemac': 'chromium',
  'com.brave.Browser': 'chromium',
  'org.chromium.Chromium': 'chromium',
  'company.thebrowser.Browser': 'chromium', // Arc
  'com.vivaldi.Vivaldi': 'chromium',
  'com.apple.Safari': 'safari',
};

const WIN_BROWSERS = new Set(['chrome', 'msedge', 'brave', 'vivaldi', 'firefox', 'opera']);

const FLUSH_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 4_000;

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

// ------------------------------------------------------------------ macOS

async function macForeground(): Promise<Foreground | null> {
  const out = await run('/usr/bin/osascript', ['-e',
    'tell application "System Events" to tell (first application process whose frontmost is true) ' +
    'to return (name as text) & "\\n" & (bundle identifier as text)']);
  if (!out) return null;
  const [appName, appId] = out.split('\n').map((s) => s.trim());
  if (!appName) return null;
  const fg: Foreground = { appId: appId || appName, appName };

  const flavour = MAC_BROWSERS[fg.appId];
  if (!flavour) return fg;

  const script = flavour === 'safari'
    ? `tell application id "${fg.appId}" to return URL of front document`
    : `tell application id "${fg.appId}" to return URL of active tab of front window`;
  const url = await run('/usr/bin/osascript', ['-e', script]);
  if (url) {
    const domain = normalizeDomain(url);
    if (domain) fg.domain = domain;
  }
  return fg;
}

// ---------------------------------------------------------------- Windows

// One long-lived PowerShell child does the probing in a loop and prints a line
// per sample. Spawning a fresh powershell.exe every 5s — each one JIT-compiling
// the P/Invoke shim with Add-Type — costs real CPU and battery, and on a slow
// machine takes longer than the probe timeout, so nothing would ever be
// recorded. The types are compiled once here instead.
const WIN_PROBE_LOOP = `
$ErrorActionPreference='SilentlyContinue'
Add-Type @"
using System;using System.Runtime.InteropServices;
public class LakatW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
}
"@
try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  $uia = $true
} catch { $uia = $false }

while ($true) {
  $line = ''
  $h = [LakatW]::GetForegroundWindow()
  if ($h -ne [IntPtr]::Zero) {
    $procId = 0
    [void][LakatW]::GetWindowThreadProcessId($h, [ref]$procId)
    $p = Get-Process -Id $procId
    if ($p) {
      $name = $p.ProcessName
      $desc = $p.Description
      if (-not $desc) { $desc = $name }
      $url = ''
      # Chromium/Firefox expose the address bar as an Edit control with a ValuePattern.
      if ($uia) {
        try {
          $ae = [System.Windows.Automation.AutomationElement]::FromHandle($h)
          if ($ae) {
            $cond = New-Object System.Windows.Automation.PropertyCondition(
              [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
              [System.Windows.Automation.ControlType]::Edit)
            $edit = $ae.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
            if ($edit) {
              $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
              if ($vp) { $url = $vp.Current.Value }
            }
          }
        } catch { }
      }
      $line = "$name|$desc|$url"
    }
  }
  Write-Output $line
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds __SLEEP_MS__
}
`;

/** Latest line from the Windows probe loop, refreshed in the background. */
let winLatest: Foreground | null = null;
let winProc: ReturnType<typeof spawn> | null = null;

function startWindowsProbe(intervalMs: number, log: (m: string) => void): void {
  if (winProc) return;
  const script = WIN_PROBE_LOOP.replace('__SLEEP_MS__', String(intervalMs));
  const child = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  winProc = child;
  let buffer = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      winLatest = parseWinLine(line);
    }
  });
  child.on('exit', () => {
    winProc = null;
    winLatest = null;
    log('windows probe exited; will restart on the next tick');
  });
  child.on('error', (e) => log(`windows probe failed to start: ${String(e)}`));
}

function parseWinLine(line: string): Foreground | null {
  if (!line) return null;
  const [name, desc, url] = line.split('|');
  if (!name) return null;
  const fg: Foreground = { appId: name, appName: desc || name };
  if (url && WIN_BROWSERS.has(name.toLowerCase())) {
    const domain = normalizeDomain(url);
    if (domain) fg.domain = domain;
  }
  return fg;
}

function stopWindowsProbe(): void {
  winProc?.kill();
  winProc = null;
  winLatest = null;
}

async function probeForeground(log: (m: string) => void): Promise<Foreground | null> {
  if (process.platform === 'darwin') return macForeground();
  if (process.platform === 'win32') {
    startWindowsProbe(SAMPLE_INTERVAL_MS, log); // no-op once running; restarts if it died
    return winLatest;
  }
  return null;
}

// ---------------------------------------------------------------- sampler

export interface TrackerDeps {
  /** ship a batch of samples to the helper; resolves false when it could not be sent */
  send: (samples: UsageSampleMsg[]) => Promise<boolean>;
  /** measurement is skipped entirely while this returns false */
  isEnabled: () => boolean;
  log: (m: string) => void;
}

export class UsageTracker {
  private timer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastAt = Date.now();
  private buffer = new SampleBuffer();
  private probing = false;
  private flushing = false;

  constructor(private deps: TrackerDeps) {}

  start(): void {
    if (this.timer) return;
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      this.deps.log('usage tracking not supported on this platform');
      return;
    }
    this.lastAt = Date.now();
    this.timer = setInterval(() => void this.tick(), SAMPLE_INTERVAL_MS);
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    // Sleep/wake and lock must not accumulate a huge gap into the next sample.
    powerMonitor.on('suspend', () => { this.lastAt = Date.now(); });
    powerMonitor.on('resume', () => { this.lastAt = Date.now(); });
    powerMonitor.on('lock-screen', () => { this.lastAt = Date.now(); });
    powerMonitor.on('unlock-screen', () => { this.lastAt = Date.now(); });
    this.deps.log('usage tracking started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.timer = null;
    this.flushTimer = null;
    stopWindowsProbe();
    void this.flush();
  }

  private async tick(): Promise<void> {
    if (this.probing) return; // a slow probe must not queue up behind itself
    if (!this.deps.isEnabled()) { this.lastAt = Date.now(); return; }
    this.probing = true;
    try {
      const idleSeconds = powerMonitor.getSystemIdleTime();
      const fg = await probeForeground(this.deps.log);
      const now = Date.now();
      const decision = decideSample({ lastAt: this.lastAt, now, idleSeconds, fg });
      this.lastAt = now;
      if (!decision) return;
      this.buffer.add(decision.key, decision.label, decision.seconds, now);
    } catch (e) {
      this.deps.log(`usage probe failed: ${String(e)}`);
      this.lastAt = Date.now();
    } finally {
      this.probing = false;
    }
  }

  /**
   * Ships buffered samples. Delivery is at-least-once: if the send fails we keep
   * the buffer and retry, which can double-count in the rare case where the
   * helper stored the batch but the reply was lost. Losing measured time is the
   * worse failure, so the retry wins.
   */
  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.size === 0) return;
    this.flushing = true;
    const inFlight = this.buffer.take();
    try {
      const ok = await this.deps.send(inFlight.map((b) => b.sample)).catch(() => false);
      if (!ok) this.buffer.restore(inFlight);
    } finally {
      this.flushing = false;
    }
  }
}
