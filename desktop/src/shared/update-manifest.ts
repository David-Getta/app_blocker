// Pure helpers for the macOS self-update path.
//
// Why this exists at all: Squirrel.Mac (what electron-updater drives on macOS)
// can only apply an update to an app signed with a Developer ID certificate.
// Without one — which is where this project starts — the "update" button would
// have nothing to do but open a download page, and the user would be dragging
// bundles by hand for every release. So on unsigned macOS builds the app does
// the update itself, and these are the parts of that job that are worth
// testing on their own: which file to take, and is it the right one.

export interface ReleaseAsset {
  name: string;
  url: string;
  size?: number;
}

export interface MacManifestEntry {
  url: string;
  sha512?: string;
  size?: number;
}

/** Semver-ish compare (>0 when a is newer). Mirrors the Android UpdateChecker. */
export function compareVersions(a: string, b: string): number {
  const pa = normalize(a);
  const pb = normalize(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function normalize(v: string): number[] {
  return String(v).trim().replace(/^v/i, '').split('.').map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/**
 * The zip to download for this Mac.
 *
 * electron-builder names them `Lakat-1.2.3-mac.zip` (Intel),
 * `Lakat-1.2.3-arm64-mac.zip` (Apple silicon) and `…-universal-mac.zip`.
 * A universal build runs everywhere, so it is the fallback — but never the
 * first choice, because it is roughly twice the download.
 *
 * The DMG is deliberately not considered: it needs mounting and a manual drag,
 * which is exactly the friction this path exists to remove.
 */
export function pickMacAsset(assets: ReleaseAsset[], arch: string): ReleaseAsset | null {
  const zips = assets.filter((a) => /\.zip$/i.test(a.name) && /mac/i.test(a.name));
  const isArm = (n: string) => /arm64/i.test(n);
  const isUniversal = (n: string) => /universal/i.test(n);
  const exact = arch === 'arm64'
    ? zips.find((a) => isArm(a.name) && !isUniversal(a.name))
    : zips.find((a) => !isArm(a.name) && !isUniversal(a.name));
  return exact ?? zips.find((a) => isUniversal(a.name)) ?? null;
}

/**
 * Minimal reader for electron-builder's `latest-mac.yml`.
 *
 * Only the fields that matter here (version, and per-file url/sha512/size), so
 * the app does not need a YAML dependency for one small, fixed shape. Anything
 * unrecognised is ignored: a missing checksum degrades to "no integrity check",
 * never to a crash.
 */
export function parseLatestMacYml(text: string): { version?: string; files: MacManifestEntry[] } {
  const files: MacManifestEntry[] = [];
  let version: string | undefined;
  let current: MacManifestEntry | null = null;

  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (/^version:/.test(line)) {
      version = line.slice('version:'.length).trim();
      continue;
    }
    const listStart = line.match(/^\s*-\s*url:\s*(.+)$/);
    if (listStart) {
      current = { url: listStart[1].trim() };
      files.push(current);
      continue;
    }
    if (!current) continue;
    const sha = line.match(/^\s+sha512:\s*(.+)$/);
    if (sha) { current.sha512 = sha[1].trim(); continue; }
    const size = line.match(/^\s+size:\s*(\d+)\s*$/);
    if (size) { current.size = Number(size[1]); continue; }
    // A non-indented key ends the files list.
    if (/^\S/.test(line)) current = null;
  }
  return { version, files };
}

/** The manifest entry describing `name`, if the manifest knows about it. */
export function manifestEntryFor(
  manifest: { files: MacManifestEntry[] }, name: string,
): MacManifestEntry | null {
  return manifest.files.find((f) => f.url === name) ?? null;
}

/**
 * The `.app` bundle an executable lives in — `/Applications/Lakat.app` for
 * `/Applications/Lakat.app/Contents/MacOS/Lakat`.
 *
 * Null when the executable is not inside a bundle (a dev run, or a build run
 * straight from a directory), which is exactly when self-updating must not be
 * attempted.
 */
export function appBundlePath(execPath: string): string | null {
  const marker = '.app/';
  const i = execPath.indexOf(marker);
  return i === -1 ? null : execPath.slice(0, i + marker.length - 1);
}
