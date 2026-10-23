// A szigorú blokk kiírása (shared/strict-block.ts): minden változáskor, és
// biztonságból a körökben is — de csak akkor ír, ha a tartalom változott.
//
// A fájlt csak a root/SYSTEM írja, a segéd állapotmappájába (macOS 0600;
// Windowson a mappa le van zárva, lásd win-acl.ts). Véletlen nevű, kizárólagosan
// létrehozott ideiglenes fájlon át — egy előre odatett fájlba sosem írunk.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { renderStrictBlock, strictHostnames, strictNote } from '../shared/strict-block';
import { activeHostnames } from './hosts';
import { strictBlockPath, uninstallCopyPath } from './paths';
import type { HelperState } from './state';

let last: string | null = null;

/** A fájl mérete, vagy -1, ha nincs meg. */
function sizeOf(file: string): number {
  try { return fs.statSync(file).size; } catch { return -1; }
}

/** Kiírja a szigorú blokkot, ha változott. Sosem dob: a tiltást semmi nem állíthatja meg. */
export function writeStrictBlock(state: HelperState, now: number, log: (m: string) => void): void {
  try {
    const names = strictHostnames(state.sites, activeHostnames(state, now));
    const text = renderStrictBlock(names, strictNote(process.platform, uninstallCopyPath()));
    const file = strictBlockPath();
    // Ha ugyanazt írnánk, és a fájl is megvan (vagy üresnél nincs), nincs dolog —
    // de egy közben eltűnt fájlt a következő kör visszaírja.
    if (text === last && sizeOf(file) === (text === '' ? -1 : Buffer.byteLength(text, 'utf8'))) return;
    if (text === '') {
      fs.rmSync(file, { force: true });
    } else {
      const tmp = path.join(path.dirname(file), `.strict.${crypto.randomBytes(8).toString('hex')}.tmp`);
      fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, file);
    }
    last = text;
  } catch (e) {
    log(`a szigorú blokk nem íródott ki: ${String(e)}`);
  }
}
