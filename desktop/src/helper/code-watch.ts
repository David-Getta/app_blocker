// A segéd a saját kódját figyeli (macOS): ha az app frissült, újraindul az új
// kóddal; ha az app eltűnt, kilép — onnan az őr veszi át.
//
// MIÉRT. A segéd az app binárisán fut, a launchd pedig csak indításkor olvas
// be: egy frissítés után a régi kód futott tovább a következő újraindításig
// (ezért szólt a felület „régebbi segéd” sávja). Ha pedig az appot törlik, a
// segéd a törölt fájlból fut tovább, és az őrrel (shared/guard-script.ts)
// felváltva írnák a hosts fájlt. Ezért: ha a bináris vagy az app.asar
// megváltozott — és egy percig nem változik tovább, tehát a csere véget ért —,
// a segéd kilép. A launchd (KeepAlive) újraindítja az új kóddal; ha a bináris
// nincs meg, nem tudja, és az őr a szigorú blokkot teszi a helyére.
//
// Windowson nincs rá szükség: futó exe nem cserélhető, a frissítés a segédet
// leállítja, és az őr indítja újra.

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
