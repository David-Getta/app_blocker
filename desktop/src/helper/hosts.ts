// hosts-file engine: applies the managed block, flushes DNS caches, watches
// for tampering and best-effort disables browser DNS-over-HTTPS (so incognito
// and guest sessions cannot slip past the hosts file via secure DNS).

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import {
  buildManagedBlock, extractManagedBlock, replaceManagedBlock,
} from '../shared/blocklist';
import { isBlockedNowWithLimit } from '../shared/limits';
import type { HelperState } from './state';
import { hostsFilePath } from './paths';

export function activeHostnames(state: HelperState, now: number): string[] {
  const set = new Set<string>();
  for (const site of state.sites) {
    // Combines pause, pending-delete, the weekly schedule and today's budget.
    if (!isBlockedNowWithLimit(site, state.usage, now)) continue;
    for (const h of site.hostnames) set.add(h);
  }
  return [...set].sort();
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000 }, () => resolve()); // best effort
  });
}

export async function flushDnsCache(): Promise<void> {
  if (process.platform === 'darwin') {
    await run('/usr/bin/dscacheutil', ['-flushcache']);
    await run('/usr/bin/killall', ['-HUP', 'mDNSResponder']);
  } else if (process.platform === 'win32') {
    await run('ipconfig', ['/flushdns']);
  }
}

/** Rewrites the managed block to match state. Returns true when the file changed. */
export function applyBlocklist(state: HelperState, now: number): boolean {
  const file = hostsFilePath();
  const block = buildManagedBlock(activeHostnames(state, now), process.platform);
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    current = '';
  }
  if (extractManagedBlock(current) === block && (block !== '' || !current.includes('LAKAT BLOCK'))) {
    return false;
  }
  let next = replaceManagedBlock(current, block);
  if (process.platform === 'win32') next = next.replace(/\n/g, '\r\n');
  const tmp = path.join(path.dirname(file), `.lakat-hosts.tmp`);
  try {
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, file);
  } catch {
    // some AV products lock hosts renames; fall back to in-place write
    fs.writeFileSync(file, next);
  }
  void flushDnsCache();
  return true;
}

/**
 * Watches the hosts file; if the managed block is edited or removed while
 * blocking is active, it is re-applied within ~2 seconds.
 */
export function watchHosts(getState: () => HelperState, log: (m: string) => void): void {
  const file = hostsFilePath();
  const dir = path.dirname(file);
  let timer: NodeJS.Timeout | null = null;
  try {
    fs.watch(dir, (_event, filename) => {
      if (filename && filename.toString().toLowerCase() !== path.basename(file).toLowerCase()) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          if (applyBlocklist(getState(), Date.now())) log('hosts drift detected -> managed block re-applied');
        } catch (e) {
          log(`hosts re-apply failed: ${String(e)}`);
        }
      }, 1500);
    });
  } catch (e) {
    log(`hosts watch unavailable: ${String(e)}`);
  }
}

// ------------------------------------------------- browser DoH hardening

const FIREFOX_POLICY = JSON.stringify(
  { policies: { DNSOverHTTPS: { Enabled: false, Locked: true } } }, null, 2,
);

/**
 * Browsers with built-in DNS-over-HTTPS can resolve names without touching the
 * hosts file. We push machine-level policies turning DoH off where we can.
 * Everything here is best effort and logged, never fatal.
 */
export async function applyDohPolicies(log: (m: string) => void): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const regAdd = (key: string) =>
        run('reg', ['add', key, '/v', 'DnsOverHttpsMode', '/t', 'REG_SZ', '/d', 'off', '/f']);
      await regAdd('HKLM\\SOFTWARE\\Policies\\Google\\Chrome');
      await regAdd('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge');
      for (const base of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
        if (!base) continue;
        const ffDir = path.join(base, 'Mozilla Firefox');
        if (fs.existsSync(ffDir)) {
          fs.mkdirSync(path.join(ffDir, 'distribution'), { recursive: true });
          fs.writeFileSync(path.join(ffDir, 'distribution', 'policies.json'), FIREFOX_POLICY);
        }
      }
      log('DoH policies applied (Chrome/Edge registry, Firefox policies.json)');
      return true;
    }
    if (process.platform === 'darwin') {
      const set = (domain: string) =>
        run('/usr/bin/defaults', ['write', domain, 'DnsOverHttpsMode', '-string', 'off']);
      await set('/Library/Preferences/com.google.Chrome');
      await set('/Library/Preferences/com.microsoft.Edge');
      await set('/Library/Preferences/org.chromium.Chromium');
      await set('/Library/Preferences/com.brave.Browser');
      const ffDir = '/Applications/Firefox.app/Contents/Resources';
      if (fs.existsSync(ffDir)) {
        fs.mkdirSync(path.join(ffDir, 'distribution'), { recursive: true });
        fs.writeFileSync(path.join(ffDir, 'distribution', 'policies.json'), FIREFOX_POLICY);
      }
      log('DoH policies applied (Chromium-family defaults, Firefox policies.json)');
      return true;
    }
    return false;
  } catch (e) {
    log(`DoH policy apply failed: ${String(e)}`);
    return false;
  }
}
