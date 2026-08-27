// One-click updates for macOS builds that are NOT Developer ID signed.
//
// Squirrel.Mac — what electron-updater drives on macOS — refuses to apply an
// update unless both the installed app and the update are signed with a
// Developer ID certificate. That certificate costs money and is tied to an
// Apple account, so until there is one, the built-in path can only ever open a
// download page and let the user drag bundles around by hand. That is not an
// update button, it is a chore.
//
// So on an unsigned macOS build the app updates itself: fetch the release,
// download the zip, check its size and checksum, unpack it with `ditto` (the
// only tool that reliably preserves an app bundle), clear the download
// quarantine flag we ourselves caused, swap the bundle, relaunch. Every step
// that can fail leaves the installed app untouched.
//
// Once a Developer ID certificate exists, initUpdater() prefers electron-updater
// again and this file simply stops being used.

import { app } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import {
  appBundlePath as bundleOf, compareVersions, manifestEntryFor, parseLatestMacYml, pickMacAsset,
  type ReleaseAsset,
} from '../shared/update-manifest';
import { relaunchScript } from '../shared/mac-relaunch';
import { cachedPackageUsable, cleanupStaleUpdates, updateCachePath } from '../shared/update-cache';

export { cleanupStaleUpdates };

const OWNER = 'David-Getta';
const REPO = 'app_blocker';
const LATEST_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const USER_AGENT = 'Breaker-Desktop-Updater';
const MAX_REDIRECTS = 5;
/** A desktop app zip is tens of megabytes; anything far past that is not ours. */
const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;

export interface MacUpdate {
  version: string;
  assetName: string;
  assetUrl: string;
  sha512?: string;
  size?: number;
}

// ------------------------------------------------------------------ network

function get(url: string, headers: Record<string, string>, redirects = 0): Promise<import('http').IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, ...headers } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) { reject(new Error('túl sok átirányítás')); return; }
        resolve(get(new URL(res.headers.location, url).toString(), headers, redirects + 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      resolve(res);
    });
    req.setTimeout(30_000, () => req.destroy(new Error('időtúllépés')));
    req.on('error', reject);
  });
}

async function getText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await get(url, headers);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res) {
    total += (chunk as Buffer).length;
    if (total > 8 * 1024 * 1024) throw new Error('túl nagy válasz');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// -------------------------------------------------------------- app bundle

/** `/Applications/Breaker.app` for this process. Pure part in shared/, so it is tested. */
export function appBundlePath(execPath = process.execPath): string | null {
  return bundleOf(execPath);
}

/**
 * True only for a real Developer ID signature. An ad-hoc signature (what
 * electron-builder produces without a certificate, and what Apple silicon
 * requires just to launch) looks signed but Squirrel.Mac still rejects it — so
 * "has a signature" is the wrong question to ask here.
 */
export function hasDeveloperIdSignature(bundle: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('codesign', ['-dv', '--verbose=2', bundle], (err, stdout, stderr) => {
      if (err && !stderr) { resolve(false); return; }
      resolve(/Authority=Developer ID Application/.test(`${stdout}${stderr}`));
    });
  });
}

// ------------------------------------------------------------------- check

/** The newest release, when it is newer than what is running. */
export async function checkMacUpdate(currentVersion = app.getVersion()): Promise<MacUpdate | null> {
  const body = await getText(LATEST_API, { Accept: 'application/vnd.github+json' });
  const release = JSON.parse(body) as {
    tag_name?: string;
    assets?: { name: string; browser_download_url: string; size: number }[];
  };
  const version = String(release.tag_name ?? '').replace(/^v/i, '').trim();
  if (!version || compareVersions(version, currentVersion) <= 0) return null;

  const assets: ReleaseAsset[] = (release.assets ?? []).map((a) => ({
    name: a.name, url: a.browser_download_url, size: a.size,
  }));
  const chosen = pickMacAsset(assets, process.arch);
  if (!chosen) return null;

  // The checksum is a bonus, not a requirement: an older release without a
  // manifest should still be installable, just without the extra check.
  let sha512: string | undefined;
  const manifestAsset = assets.find((a) => a.name === 'latest-mac.yml');
  if (manifestAsset) {
    try {
      const manifest = parseLatestMacYml(await getText(manifestAsset.url));
      sha512 = manifestEntryFor(manifest, chosen.name)?.sha512;
    } catch { /* no checksum, carry on */ }
  }

  return { version, assetName: chosen.name, assetUrl: chosen.url, sha512, size: chosen.size };
}

// ---------------------------------------------------------------- download

export async function downloadUpdate(
  update: MacUpdate, onProgress: (percent: number) => void,
): Promise<string> {
  const dest = updateCachePath(update.version, update.assetName);
  const dir = path.dirname(dest);

  // MÁR MEGVAN? Ez az, ami az újraindítást túléli: a hívó memóriája elveszett,
  // a fájl viszont ott van, és igazolható. Enélkül minden indítás után újra
  // menne a ~90 MB.
  if (cachedPackageUsable(dest, update)) {
    onProgress(100);
    return dest;
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    return await downloadInto(dir, update, onProgress);
  } catch (e) {
    // Bármi hasal el, a félkész ~90 MB ne maradjon a lemezen. A hívó csak a
    // hibát látja; a takarítás itt a legbiztosabb, mert csak itt tudjuk,
    // melyik mappa a miénk.
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}


async function downloadInto(
  dir: string, update: MacUpdate, onProgress: (percent: number) => void,
): Promise<string> {
  const dest = path.join(dir, update.assetName);
  const res = await get(update.assetUrl, {});
  const expected = Number(res.headers['content-length'] ?? update.size ?? 0);

  const hash = crypto.createHash('sha512');
  const out = fs.createWriteStream(dest);
  let received = 0;
  let lastPercent = -1;

  await new Promise<void>((resolve, reject) => {
    res.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_DOWNLOAD_BYTES) {
        res.destroy();
        out.destroy();
        reject(new Error('a letöltés túllépte a méretkorlátot'));
        return;
      }
      hash.update(chunk);
      if (expected > 0) {
        const percent = Math.min(99, Math.floor((received / expected) * 100));
        if (percent !== lastPercent) { lastPercent = percent; onProgress(percent); }
      }
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => resolve());
    res.pipe(out);
  });

  if (update.size && received !== update.size) {
    throw new Error(`a letöltött fájl mérete nem stimmel (${received} ≠ ${update.size})`);
  }
  if (update.sha512) {
    const actual = hash.digest('base64');
    if (actual !== update.sha512) {
      throw new Error('a letöltött fájl ellenőrzőösszege nem egyezik');
    }
  }
  onProgress(100);
  return dest;
}

// ------------------------------------------------------------------- apply

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(`${cmd} hiba: ${stderr || err.message}`));
      else resolve();
    });
  });
}

/**
 * Swaps the installed bundle for the downloaded one and relaunches.
 *
 * The old bundle is moved aside first (a rename on the same volume, so it is
 * instant and reversible) and only deleted once the new one is in place. If the
 * copy fails, the old bundle is moved back — the worst case is "the update did
 * not happen", never "there is no app any more".
 */
export async function applyUpdate(zipPath: string, bundle: string): Promise<void> {
  const workDir = path.join(path.dirname(zipPath), 'unpacked');
  fs.mkdirSync(workDir, { recursive: true });

  // ditto, not unzip: an .app is full of symlinks and extended attributes that
  // unzip silently mangles, and a mangled bundle will not launch.
  await run('ditto', ['-x', '-k', zipPath, workDir]);

  const entry = fs.readdirSync(workDir).find((n) => n.endsWith('.app'));
  if (!entry) throw new Error('a letöltött csomagban nincs .app');
  const fresh = path.join(workDir, entry);

  // We downloaded it, so we know where it came from: clear the quarantine flag
  // that would otherwise make macOS refuse the swapped-in copy.
  await run('xattr', ['-dr', 'com.apple.quarantine', fresh]).catch(() => { /* best effort */ });

  const backup = `${bundle}.old-${process.pid}`;
  fs.renameSync(bundle, backup);
  try {
    await run('ditto', [fresh, bundle]);
  } catch (e) {
    fs.rmSync(bundle, { recursive: true, force: true });
    fs.renameSync(backup, bundle); // put the working app back
    throw e;
  }

  // A régi bundle NEM törlődik itt: abból fut ez a kód. A takarítást (a régi
  // bundle és a letöltés pár száz megabájtos munkamappája) és az indítást is a
  // leválasztott héjprogram végzi, MIUTÁN kiléptünk — különben az új példány
  // nem kapja meg az egypéldány-zárat, és azonnal kilépne.
  // Lásd shared/mac-relaunch.ts.
  spawn('/bin/sh', ['-c', relaunchScript(process.pid, bundle, [backup, path.dirname(zipPath)])], {
    detached: true, stdio: 'ignore',
  }).unref();
  app.quit();
}
