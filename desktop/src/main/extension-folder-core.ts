// A bővítmény-mappa magja: lenyomat, másolás — Electron nélkül, tesztelhetően.
//
// MIÉRT VAN. A bővítményt eddig minden kiadásnál külön kellett letölteni,
// kicsomagolni és a böngészőbe betölteni — pont az a fajta kézi munka, amit
// a legtöbben egyszer elvégeznek, aztán soha többé, és onnantól egy régi
// bővítmény fut egy új app mellett. Mostantól a bővítmény az app részeként
// érkezik, az app induláskor kimásolja egy ÁLLANDÓ mappába, és ha a tartalma
// változott, frissíti. A böngészőbe ezt a mappát kell egyszer betölteni.
//
// A frissítés tartalom-lenyomat alapján dől el, nem a manifest verziója
// szerint: egy elfelejtett verzióemelés ne hagyhasson elavult mappát.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** A lenyomat fájlja a célmappában — a másolás UTOLSÓ lépése írja. */
export const HASH_FILE = '.breaker-hash';

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === HASH_FILE || e.name === '.DS_Store') continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/** A mappa tartalmának lenyomata: fájlnevek és tartalmak, rögzített sorrendben. */
export function contentHash(dir: string): string {
  const h = crypto.createHash('sha256');
  for (const rel of listFiles(dir)) {
    h.update(rel);
    h.update('\0');
    h.update(fs.readFileSync(path.join(dir, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

export function readManifestVersion(dir: string): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { version?: unknown };
    return typeof m.version === 'string' ? m.version : null;
  } catch {
    return null;
  }
}

/**
 * A célmappa a forrás mása legyen.
 *
 * HELYBEN ír, nem mappát cserél: a böngésző a betöltött mappát figyeli, egy
 * átnevezett mappa alól kicsúszna. Ami a forrásban már nincs, az a célból is
 * eltűnik. A lenyomat utoljára íródik: egy félbeszakadt másolás így
 * legközelebb újra fut, nem marad félkész mappa „kész” jelzéssel.
 *
 * @returns frissült-e (hamis, ha a lenyomat egyezett és nem kellett írni)
 */
export function syncExtensionFolder(src: string, dest: string): boolean {
  const want = contentHash(src);
  let have: string | null = null;
  try {
    have = fs.readFileSync(path.join(dest, HASH_FILE), 'utf8').trim();
  } catch {
    have = null;
  }
  if (have === want) return false;
  fs.mkdirSync(dest, { recursive: true });
  const wanted = listFiles(src);
  const wantedSet = new Set(wanted);
  for (const rel of listFiles(dest)) {
    if (!wantedSet.has(rel)) fs.rmSync(path.join(dest, rel), { force: true });
  }
  for (const rel of wanted) {
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, rel), to);
  }
  fs.writeFileSync(path.join(dest, HASH_FILE), want);
  return true;
}
