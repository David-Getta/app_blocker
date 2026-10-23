// A segéd a saját kódját figyeli (macOS): ha az app frissült vagy eltűnt, és
// egy percig úgy marad, a segéd NAPLÓZ — de nem lép ki.
//
// MIÉRT NEM LÉP KI. A rendszerjoggal futó kódot egy rendszergazdai lépés (a
// telepítés, a frissítő gomb) vagy a gép újraindítása cserélje — ne egy
// fájlművelet az app mappájában. Ha a segéd egy cserére vagy egy eltűnésre
// kilépne, a launchd (KeepAlive) — vagy az őr — azt indítaná újra, ami épp a
// helyén van.
//
// A törölt appból futó segéd tovább tilt a beállított szabályokkal (a megnyitott
// fájlok a törlés után is olvashatók); az őr ilyenkor élőnek látja, és nem ír.
// Ha leáll — legkésőbb a gép újraindításakor —, a launchd nem tudja elindítani,
// és az őr a szigorú blokkot teszi a helyére. Frissítés után a régi kód fut a
// következő indulásig; ezt a felület „régebbi segéd” sávja mondja ki.
//
// Windowson nincs rá szükség: futó exe nem cserélhető, a frissítés a segédet
// leállítja, és az őr indítja újra (az alapértelmezett helyet, a Program Files-t
// csak rendszergazda írja).

import * as fs from 'fs';

// Az Electron node-módjában a `fs` az app.asar-t mappának mutatja, és a már
// megnyitott archívumot (amiből a segéd maga fut) gyorsítótárból adja: a csere
// vagy a törlés nem látszana rajta. Az `original-fs` a valódi fájlt nézi.
const realFs: typeof fs = (() => {
  if (!process.versions.electron) return fs;
  try {
    return require('original-fs') as typeof fs;
  } catch {
    return fs;
  }
})();

/** Egy út ujjlenyomata: inode, méret, módosítás — vagy „nincs meg”. */
export function fileMark(p: string): string {
  try {
    const st = realFs.statSync(p);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

export interface CodeWatch {
  /** az induláskori ujjlenyomat */
  base: string;
  /** a legutóbb látott eltérő ujjlenyomat, és mióta áll így */
  pending: { mark: string; since: number } | null;
}

export type CodeVerdict = 'same' | 'settling' | 'changed' | 'gone';

/** Egy lépés: ha az eltérés `stableMs` óta nem mozdult, döntünk. */
export function codeWatchStep(w: CodeWatch, mark: string, now: number, stableMs = 60_000): CodeVerdict {
  if (mark === w.base) {
    w.pending = null;
    return 'same';
  }
  if (!w.pending || w.pending.mark !== mark) {
    w.pending = { mark, since: now };
    return 'settling';
  }
  if (now - w.pending.since < stableMs) return 'settling';
  return mark.split('|').includes('missing') ? 'gone' : 'changed';
}

/** A becsomagolt segéd figyelendő útjai: a bináris és az app.asar — vagy null, ha nem becsomagolt. */
export function codePaths(execPath: string, entry: string | undefined): string[] | null {
  if (!entry) return null;
  const i = entry.indexOf('/app.asar/');
  if (i < 0) return null;
  return [execPath, entry.slice(0, i + '/app.asar'.length)];
}

export function markOf(paths: string[]): string {
  return paths.map(fileMark).join('|');
}
