// A letöltött frissítési csomag gyorsítótára.
//
// Külön modul és külön tesztek, mert a `mac-updater.ts` az electronra
// hivatkozik, tehát `node:test` alól nem tölthető be — ez a rész viszont
// tiszta fájlkezelés, és pont olyan, amit ellenőrizni akarunk.
//
// MIÉRT LÉTEZIK. A csomag ~90 MB, és korábban minden letöltés friss
// `mkdtemp` mappába ment. Futáson belül ez rendben volt: a hívó megjegyezte az
// utat, és nem töltötte le újra. Az app ÚJRAINDÍTÁSA után viszont a megjegyzett
// út a memóriával együtt elveszett — tehát az app újra letöltötte ugyanazt a
// ~90 MB-ot, a régi mappa meg ottmaradt, örökre. Aki egy nap háromszor frissít
// és közben újraindítja az appot, annak ez háromszor ~90 MB letöltés és
// ugyanennyi szemét a lemezen, magyarázat nélkül.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** A gyorsítótár gyökere. Verziónként egy almappa, állandó néven. */
export function updateCacheDir(): string {
  return path.join(os.tmpdir(), 'breaker-update');
}

/** Egy adott verzió csomagjának helye. */
export function updateCachePath(version: string, assetName: string): string {
  return path.join(updateCacheDir(), version, assetName);
}

/**
 * A már nem kellő csomagok törlése.
 *
 * A `keepVersion` az, amit épp letöltünk vagy telepítünk — minden más mehet,
 * beleértve a régi, `mkdtemp`-es mappákat is. Ez nem takarítási buzgalom: a
 * csomagok ~90 MB-osak, és semmi nem szólna arról, hogy megtelik a lemez.
 */
export function cleanupStaleUpdates(keepVersion?: string): void {
  const base = updateCacheDir();
  try {
    for (const name of fs.readdirSync(base)) {
      if (name === keepVersion) continue;
      fs.rmSync(path.join(base, name), { recursive: true, force: true });
    }
  } catch { /* még nem létezik: nincs mit takarítani */ }
  // A RÉGI alak: `breaker-update-XXXXXX` közvetlenül a temp mappában. Aki
  // korábbi verzióról frissít, annak ezek ott vannak, és semmi más nem
  // takarítaná el őket.
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith('breaker-update-')) continue;
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
    }
  } catch { /* nem baj */ }
}

/**
 * Használható-e a gyorsítótárban talált csomag.
 *
 * Csak ELLENŐRZŐÖSSZEGGEL igazolható csomagot fogadunk el. A gyorsítótár a
 * rendszer temp mappájában van, tehát elvben más is írhat bele; a méret
 * önmagában ezért kevés, egy azonos méretű, kicserélt fájlt észrevétlenül
 * telepítenénk. Az sha512 viszont döntő — amihez nincs, azt inkább újra
 * letöltjük. Egy ~90 MB-os olvasás fél másodperc; a rossz csomag telepítése
 * nem javítható.
 */
export function cachedPackageUsable(
  dest: string, expect: { size?: number; sha512?: string },
): boolean {
  if (!expect.sha512) return false;
  try {
    if (expect.size && fs.statSync(dest).size !== expect.size) return false;
    const hash = crypto.createHash('sha512');
    hash.update(fs.readFileSync(dest));
    return hash.digest('base64') === expect.sha512;
  } catch {
    return false;
  }
}
