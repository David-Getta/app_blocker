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
 * electron-builder names them `Breaker-1.2.3-mac.zip` (Intel),
 * `Breaker-1.2.3-arm64-mac.zip` (Apple silicon) and `…-universal-mac.zip`.
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
 * A rendszerkövetelményt hordozó Mac-csomag neve: `Breaker-1.2.3-arm64-darwin13.zip`.
 *
 * MIÉRT A NÉVBEN. Az Electron időnként feljebb emeli a legrégebbi macOS-t, amin
 * fut (a 44-es a macOS 13-at kéri). A v0.4.240-ig kiadott frissítők minden
 * zipet felraknak, aminek a nevében `mac` szerepel, és a régi példányt az új
 * elindítása ELŐTT törlik: egy macOS 12-es gépen ebből el nem induló app
 * lenne — és a root segéd is ugyanazt a binárist futtatja. A `darwinNN` név
 * nem tartalmazza a `mac` szót, tehát a régi frissítő nem látja (marad a működő
 * verzión), az újabb viszont kiolvassa belőle, mi kell neki.
 */
const GATED_MAC_ZIP = /-darwin(\d{1,3})\.zip$/i;

/** A csomag nevéből a legrégebbi macOS főverzió, amin fut — vagy null, ha nincs benne. */
export function macRequirementOf(name: string): number | null {
  const m = GATED_MAC_ZIP.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * A futó macOS főverziója (`process.getSystemVersion()`: „12.7.6” → 12).
 * Ismeretlen alaknál null — és az óvatos irány, hogy olyankor nem frissítünk.
 */
export function macosMajor(systemVersion: string): number | null {
  const m = /^\s*(\d{1,3})(?:\.\d+)*\s*$/.exec(String(systemVersion));
  return m ? Number(m[1]) : null;
}

export type MacPick =
  | { kind: 'asset'; asset: ReleaseAsset }
  | { kind: 'too-old'; needs: number; has: string }
  | { kind: 'none' };

/**
 * Melyik csomag kell erre a Macre — és fut-e itt egyáltalán.
 *
 * Ha a kiadás rendszerkövetelményt hordozó csomagot ad (`darwinNN`), az dönt:
 * régebbi macOS-en semmit nem töltünk le, és ezt ki is mondjuk (`too-old`) —
 * egy el nem induló app rosszabb, mint egy régi, működő verzió. A régi nevű
 * (`mac`) csomag a korábbi kiadásoké; azoknak nem volt külön követelményük azon
 * túl, amin ez a példány már fut.
 */
export function pickMacUpdate(assets: ReleaseAsset[], arch: string, systemVersion: string): MacPick {
  const gated = assets.filter((a) => macRequirementOf(a.name) !== null);
  if (gated.length > 0) {
    const isArm = (n: string) => /arm64/i.test(n);
    const isUniversal = (n: string) => /universal/i.test(n);
    const chosen = (arch === 'arm64'
      ? gated.find((a) => isArm(a.name) && !isUniversal(a.name))
      : gated.find((a) => !isArm(a.name) && !isUniversal(a.name)))
      ?? gated.find((a) => isUniversal(a.name));
    if (!chosen) return { kind: 'none' };
    const needs = macRequirementOf(chosen.name) as number;
    const has = macosMajor(systemVersion);
    if (has === null || has < needs) return { kind: 'too-old', needs, has: String(systemVersion).trim() };
    return { kind: 'asset', asset: chosen };
  }
  const legacy = pickMacAsset(assets, arch);
  return legacy ? { kind: 'asset', asset: legacy } : { kind: 'none' };
}

/** Ha a következő verzió ezen a Macen már nem fut: ezt mondja a fiók-panel. */
export interface MacTooOld {
  /** a következő verzió (az, amit nem rakunk fel) */
  version: string;
  /** a legrégebbi macOS főverzió, amin az fut */
  needs: number;
  /** a gép saját rendszerverziója, ahogy kiolvastuk (üres, ha nem sikerült) */
  has: string;
}

/**
 * A fiók-panel mondata. Ragozott szám nélkül írva („macOS 13 kell”,
 * „macOS 12.7.6 fut”): a szám toldaléka a kiejtésétől függene, és egy
 * elrontott rag egy őszinte mondatot is gépiessé tesz.
 */
export function macTooOldText(t: MacTooOld): string {
  const has = t.has
    ? `ezen a Macen macOS ${t.has} fut`
    : 'ennek a Macnek a rendszerverzióját nem sikerült kiolvasni';
  return `A következő verzióhoz (v${t.version}) legalább macOS ${t.needs} kell, ${has}. `
    + 'A Breaker így is működik tovább — a tiltás, a mérés, minden —, csak újabb verziót nem kap.';
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
 * The `.app` bundle an executable lives in — `/Applications/Breaker.app` for
 * `/Applications/Breaker.app/Contents/MacOS/Breaker`.
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
