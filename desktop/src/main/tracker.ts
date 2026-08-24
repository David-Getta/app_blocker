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
import { ProbeHealth } from '../shared/probe-health';
import { execFile, spawn } from 'child_process';
import {
  decideSample, domainFromBrowserUrl, SAMPLE_INTERVAL_MS, MAX_LABEL_LENGTH, type Foreground,
} from '../shared/usage';
import { SampleBuffer } from '../shared/sample-buffer';
import { ProbeSupervisor } from '../shared/probe-supervisor';
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
  // Truncate before anything is stored: an app can name itself whatever it likes.
  const fg: Foreground = {
    appId: (appId || appName).slice(0, MAX_LABEL_LENGTH),
    appName: appName.slice(0, MAX_LABEL_LENGTH),
  };

  const flavour = MAC_BROWSERS[fg.appId];
  if (!flavour) return fg;

  const script = flavour === 'safari'
    ? `tell application id "${fg.appId}" to return URL of front document`
    : `tell application id "${fg.appId}" to return URL of active tab of front window`;
  const url = await run('/usr/bin/osascript', ['-e', script]);
  if (url) {
    const domain = domainFromBrowserUrl(url);
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
public class BreakerW {
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
  $h = [BreakerW]::GetForegroundWindow()
  if ($h -ne [IntPtr]::Zero) {
    $procId = 0
    [void][BreakerW]::GetWindowThreadProcessId($h, [ref]$procId)
    $p = Get-Process -Id $procId
    if ($p) {
      $name = $p.ProcessName
      $desc = $p.Description
      if (-not $desc) { $desc = $name }
      $url = ''
      # Chromium/Firefox expose the address bar as an Edit control with a
      # ValuePattern — but so does every text field ON the page. Taking the
      # first Edit in the window would read compose boxes, search fields and
      # login forms (a Chrome PWA / --app= window has no omnibox at all, yet is
      # still process "chrome"). So: skip password and offscreen elements, and
      # accept a value only if it is an absolute http(s) URL. A false negative
      # costs a site breakdown; a false positive would capture what the user
      # typed.
      if ($uia) {
        try {
          $ae = [System.Windows.Automation.AutomationElement]::FromHandle($h)
          if ($ae) {
            $cond = New-Object System.Windows.Automation.AndCondition(
              (New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                [System.Windows.Automation.ControlType]::Edit)),
              (New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::IsPasswordProperty, $false)),
              (New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::IsOffscreenProperty, $false)))
            $edits = $ae.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
            $limit = [Math]::Min($edits.Count, 8)
            for ($i = 0; $i -lt $limit -and $url -eq ''; $i++) {
              $vp = $edits[$i].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
              if ($vp) {
                $v = $vp.Current.Value
                if ($v -match '^https?://') { $url = $v }
              }
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
const winSupervisor = new ProbeSupervisor();

function startWindowsProbe(intervalMs: number, log: (m: string) => void): void {
  const now = Date.now();
  if (!winSupervisor.canStart(now)) return;
  const script = WIN_PROBE_LOOP.replace('__SLEEP_MS__', String(intervalMs));
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    // spawn() can throw synchronously (bad argv, EMFILE); that is a failed
    // attempt like any other and must go through the backoff, not be swallowed.
    winSupervisor.started(now);
    const { failures } = winSupervisor.ended(now);
    log(`windows probe could not be spawned (${failures}. kísérlet): ${String(e)}`);
    return;
  }
  winProc = child;
  winSupervisor.started(now);
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

  // Node emits 'error' (then 'close') when the spawn itself fails and never
  // emits 'exit' in that case. Clearing state only on 'exit' therefore left
  // winProc pointing at a child that never existed, and the restart guard then
  // blocked every retry — Windows tracking died silently for the whole session.
  // Every terminal event lands here instead, and only for the current child:
  // a late event from a replaced probe must not shoot down its successor.
  const finished = (why: string) => {
    if (winProc !== child) return;
    winProc = null;
    winLatest = null;
    const { retryInMs, failures } = winSupervisor.ended(Date.now());
    log(`windows probe ${why}; retry in ${Math.round(retryInMs / 1000)}s (${failures} egymás utáni hiba)`);
  };
  child.on('exit', () => finished('exited'));
  child.on('close', () => finished('closed'));
  child.on('error', (e) => finished(`failed: ${String(e)}`));
}

export function parseWinLine(line: string): Foreground | null {
  if (!line) return null;
  const [name, desc, url] = line.split('|');
  if (!name) return null;
  const fg: Foreground = {
    appId: name.slice(0, MAX_LABEL_LENGTH),
    appName: (desc || name).slice(0, MAX_LABEL_LENGTH),
  };
  // Second check, in JS: the probe only prints absolute http(s) URLs, but the
  // consequence of a stray page-input value getting through is that what the
  // user typed becomes a stored "site". Verify rather than trust.
  if (url && WIN_BROWSERS.has(name.toLowerCase())) {
    const domain = domainFromBrowserUrl(url);
    if (domain) fg.domain = domain;
  }
  return fg;
}

function stopWindowsProbe(): void {
  const child = winProc;
  winProc = null; // before kill(), so the exit handler sees it is no longer current
  child?.kill();
  winLatest = null;
  winSupervisor.reset();
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
  /**
   * Az ÉPP előtérben lévő app, minden mintavételnél.
   *
   * A mérés amúgy is megkérdezi; a munkamenet ugyanezt az adatot használja
   * („ez az app nincs a listán”). Egy MÁSODIK szonda ugyanerre fölösleges
   * terhelés lenne — és a kettő előbb-utóbb máshogy válaszolna.
   */
  onForeground?: (fg: Foreground | null) => void;
}

export class UsageTracker {
  private timer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastAt = Date.now();
  private buffer = new SampleBuffer();
  private probing = false;
  private flushing = false;
  private health = new ProbeHealth();

  constructor(private deps: TrackerDeps) {}

  /** A mérés sorozatban nem lát semmit — a felület ezt kiírja. */
  get probeBlocked(): boolean { return this.health.blocked; }
  get probeNeverWorked(): boolean { return this.health.neverWorked; }

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
      this.health.record(fg !== null);
      this.deps.onForeground?.(fg);
      const now = Date.now();
      const decision = decideSample({ lastAt: this.lastAt, now, idleSeconds, fg });
      this.lastAt = now;
      if (!decision) return;
      this.buffer.add(decision.key, decision.label, decision.seconds, now);
    } catch (e) {
      this.deps.log(`usage probe failed: ${String(e)}`);
      this.health.record(false);
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
      if (!ok) this.buffer.restore(inFlight, Date.now());
      const dropped = this.buffer.takeDropped();
      if (dropped > 0) {
        this.deps.log(`usage: ${dropped} elavult mérési tétel eldobva (a segéd túl régóta elérhetetlen)`);
      }
    } finally {
      this.flushing = false;
    }
  }
}
