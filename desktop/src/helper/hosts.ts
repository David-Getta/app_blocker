// hosts-file engine: applies the managed block, flushes DNS caches, watches
// for tampering and best-effort disables browser DNS-over-HTTPS (so incognito
// and guest sessions cannot slip past the hosts file via secure DNS).

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import {
  buildManagedBlock, extractManagedBlock, hasLegacyBlock, replaceManagedBlock, stripLegacyBlocks,
} from '../shared/blocklist';
import { isBlockedNowWithLimit } from '../shared/limits';
import type { HelperState } from './state';
import { hostsFilePath } from './paths';

export function activeHostnames(state: HelperState, now: number): string[] {
  const set = new Set<string>();
  for (const site of state.sites) {
    // Combines pause, pending-delete, the weekly schedule and today's budget.
    if (!isBlockedNowWithLimit(site, state.usage, now, state.sharedToday)) continue;
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
// ------------------------------------------- a korábbi verzió segédje

/**
 * Fut-e még egy KORÁBBI néven telepített segéd?
 *
 * A régi (Lakat) LaunchDaemon az átnevezés után nem tűnik el magától: külön
 * azonosítója van, a rendszer minden bootnál elindítja. Ha fut, a két segéd
 * ugyanazon a hosts fájlon dolgozik, és mindkettő figyeli a változást — mi
 * kitakarítjuk a régi blokkot, a régi visszaírja, mi megint kitakarítjuk.
 * Végtelen pingpong, folyamatos DNS-ürítéssel, és EGYIK felület sem mutatja.
 *
 * Ezért számoljuk, hányszor bukkan fel újra a régi blokk. Ha rövid időn belül
 * többször, az nem maradék, hanem élő démon: abbahagyjuk a takarítást, és
 * szólunk. A takarítás abbahagyása a biztonságos irány — a régi blokk marad,
 * tehát TÖBB oldal van tiltva, nem kevesebb (lásd a hibatűrés táblázatot).
 */
const LEGACY_WINDOW_MS = 2 * 60_000;
const LEGACY_HITS_FOR_ALARM = 3;
let legacyHits: number[] = [];
let legacySuspected = false;

/** Igaz, ha egy korábbi verzió segédje láthatóan MÉG FUT. */
export function legacyHelperSuspected(): boolean {
  return legacySuspected;
}

/** Csak tesztből: visszaállítja a felismerés állapotát. */
export function resetLegacyDetection(): void {
  legacyHits = [];
  legacySuspected = false;
}

function noteLegacyBlock(now: number, log: (m: string) => void): void {
  legacyHits = legacyHits.filter((t) => now - t < LEGACY_WINDOW_MS);
  legacyHits.push(now);
  if (!legacySuspected && legacyHits.length >= LEGACY_HITS_FOR_ALARM) {
    legacySuspected = true;
    log(
      'a korábbi verzió segédje láthatóan még fut: a régi blokk többször visszatért. ' +
      'A takarítást leállítom, hogy ne veszekedjen a két démon a hosts fájlon.',
    );
  }
}

export function applyBlocklist(
  state: HelperState, now: number, log: (m: string) => void = () => { /* néma */ },
): boolean {
  const file = hostsFilePath();
  const block = buildManagedBlock(activeHostnames(state, now), process.platform);
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    current = '';
  }
  if (extractManagedBlock(current) === block && (block !== '' || !current.includes('BREAKER BLOCK'))) {
    return false;
  }
  // A régi néven írt blokk takarítása — de csak amíg nem derül ki, hogy egy
  // korábbi segéd MÉG FUT. Akkor inkább ott hagyjuk: két démon, ami körbe-körbe
  // írja felül egymást, rosszabb, mint egy fölösleges blokk.
  if (hasLegacyBlock(current) && !legacySuspected) noteLegacyBlock(now, log);
  const base = legacySuspected ? current : stripLegacyBlocks(current);
  let next = replaceManagedBlock(base, block);
  if (process.platform === 'win32') next = next.replace(/\n/g, '\r\n');
  const tmp = path.join(path.dirname(file), `.breaker-hosts.tmp`);
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
      const set = (domain: string, key: string, value: string) =>
        run('/usr/bin/defaults', ['write', domain, key, '-string', value]);
      for (const domain of [
        '/Library/Preferences/com.google.Chrome',
        '/Library/Preferences/com.microsoft.Edge',
        '/Library/Preferences/org.chromium.Chromium',
        '/Library/Preferences/com.brave.Browser',
      ]) {
        await set(domain, 'DnsOverHttpsMode', 'off');
        // A gépszintű plistet a felhasználóként futó böngészőnek OLVASNIA kell.
        // A `defaults` a démon umaskjával hozza létre; ha az szigorú, a fájl
        // létrejön, a böngésző viszont nem látja — a házirend némán hatástalan
        // lenne, miközben a felület azt írja, hogy alkalmaztuk.
        try { fs.chmodSync(`${domain}.plist`, 0o644); } catch { /* nincs ilyen böngésző */ }
      }
      // Firefox: NEM írunk a /Applications/Firefox.app-ba. A policies.json oda
      // tenni dokumentált út, de az egy MÁSIK gyártó aláírt bundle-je: a
      // beleírás érvényteleníti az aláírását, és a Firefox saját frissítője
      // ettől elhasalhat. Egy blokkoló app nem tehet tönkre más appot azért,
      // hogy szigorúbb legyen. A konfigurációs profil ugyanezt a házirendet
      // adja, a bundle érintése nélkül.
      await run('/usr/bin/defaults', [
        'write', '/Library/Preferences/org.mozilla.firefox', 'DNSOverHTTPS',
        '-dict', 'Enabled', '-bool', 'false', 'Locked', '-bool', 'true',
      ]);
      try { fs.chmodSync('/Library/Preferences/org.mozilla.firefox.plist', 0o644); } catch { /* ok */ }
      log('DoH policies applied (Chromium-family + Firefox machine preferences)');
      return true;
    }
    return false;
  } catch (e) {
    log(`DoH policy apply failed: ${String(e)}`);
    return false;
  }
}
