// A Windows-segéd állapotmappájának jogai (C:\ProgramData\Breaker).
//
// MIÉRT. A ProgramData almappái a szülő jogait öröklik: a Users csoport
// olvashat MINDENT, és új fájlt is tehet beléjük. Így
//   - a state.json — benne a szinkron authKey-e és a titkosítás dataKey-e —
//     a gép minden felhasználójának olvasható volt (macOS-en ugyanez 0600,
//     csak rootnak);
//   - egy előre odatett, a felhasználó tulajdonában álló fájlon át az állapot
//     az övé lehetett volna, és a következő induláskor a szerkesztett lista
//     töltődik be — rendszergazda és próbatétel nélküli lazítás.
// Ezért a segéd minden induláskor, az állapot betöltése ELŐTT lezárja a
// mappát: tulajdonos a SYSTEM (a mappa és minden fájl — egy idegen tulajdonos
// a saját fájlján visszaadhatná magának a jogot), a hozzáférés csak a SYSTEM-é
// és a rendszergazdáké, öröklés nélkül; a fájlok a mappától öröklik. A
// felhasználó oldala (az app) ezt a mappát nem olvassa: a segéddel a pipe-on
// beszél.
//
// A neveket SID-del adjuk (S-1-5-18: SYSTEM, S-1-5-32-544: Administrators):
// a fióknevek a Windows nyelvétől függenek.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Az icacls hívásai, sorrendben — a teszt és a CI-próba is ezt nézi. */
export function hardenCommands(dir: string): string[][] {
  return [
    [dir, '/setowner', '*S-1-5-18', '/T', '/C', '/Q'],
    [dir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/C', '/Q'],
    // A gyerekek csak a mappától örököljenek (egy kézzel adott jog is menjen).
    [path.join(dir, '*'), '/reset', '/T', '/C', '/Q'],
  ];
}

export function hardenStateDir(dir: string, log: (m: string) => void): void {
  if (process.platform !== 'win32') return;
  // Abszolút úttal: SYSTEM-ként egy PATH-on talált „icacls.exe” bárkié lehetne.
  const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    log(`az állapotmappa nem jött létre: ${String(e)}`);
    return;
  }
  const cmds = hardenCommands(dir);
  for (let i = 0; i < cmds.length; i++) {
    try {
      execFileSync(icacls, cmds[i], { windowsHide: true, timeout: 30_000, stdio: 'pipe' });
    } catch (e) {
      // Az üres mappán a gyerekek visszaállítása „nincs ilyen fájl” — az nem hiba.
      if (i === cmds.length - 1 && fs.readdirSync(dir).length === 0) continue;
      log(`az állapotmappa jogai (${i + 1}. lépés): ${(e as Error).message}`);
    }
  }
}
