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
import { execFile } from 'child_process';
import { normalizeDomain } from '../shared/blocklist';
import { decideSample, dayKey, SAMPLE_INTERVAL_MS, type Foreground } from '../shared/usage';
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

const WIN_PROBE = `
$ErrorActionPreference='SilentlyContinue'
Add-Type @"
using System;using System.Runtime.InteropServices;
public class LakatW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
}
"@
$h = [LakatW]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { exit }
$procId = 0
[void][LakatW]::GetWindowThreadProcessId($h, [ref]$procId)
$p = Get-Process -Id $procId
$name = $p.ProcessName
$desc = $p.Description
if (-not $desc) { $desc = $name }
$url = ''
# Chromium/Firefox expose the address bar as an Edit control with a ValuePattern.
try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
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
Write-Output $name
Write-Output $desc
Write-Output $url
`;

async function winForeground(): Promise<Foreground | null> {
  const out = await run('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_PROBE]);
  if (!out) return null;
  const [name, desc, url] = out.split(/\r?\n/).map((s) => s.trim());
  if (!name) return null;
  const fg: Foreground = { appId: name, appName: desc || name };
  if (url && WIN_BROWSERS.has(name.toLowerCase())) {
    const domain = normalizeDomain(url);
    if (domain) fg.domain = domain;
  }
  return fg;
}

async function probeForeground(): Promise<Foreground | null> {
  if (process.platform === 'darwin') return macForeground();
  if (process.platform === 'win32') return winForeground();
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
  private pending = new Map<string, UsageSampleMsg>();
  private probing = false;

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
    void this.flush();
  }

  private async tick(): Promise<void> {
    if (this.probing) return; // a slow probe must not queue up behind itself
    if (!this.deps.isEnabled()) { this.lastAt = Date.now(); return; }
    this.probing = true;
    try {
      const idleSeconds = powerMonitor.getSystemIdleTime();
      const fg = await probeForeground();
      const now = Date.now();
      const decision = decideSample({ lastAt: this.lastAt, now, idleSeconds, fg });
      this.lastAt = now;
      if (!decision) return;
      // Buffer per (target, local day): a batch that spans midnight must not
      // dump the earlier day's seconds into the later day's bucket.
      const bucket = `${decision.key}@${dayKey(now)}`;
      const existing = this.pending.get(bucket);
      if (existing) {
        existing.seconds += decision.seconds;
      } else {
        this.pending.set(bucket, {
          key: decision.key, label: decision.label, seconds: decision.seconds, at: now,
        });
      }
    } catch (e) {
      this.deps.log(`usage probe failed: ${String(e)}`);
      this.lastAt = Date.now();
    } finally {
      this.probing = false;
    }
  }

  /** Ships buffered samples; keeps them buffered if the helper is unreachable. */
  private async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    const ok = await this.deps.send(batch).catch(() => false);
    if (ok) this.pending.clear();
  }
}
