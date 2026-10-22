// A Windows-segéd saját ütemezett feladatának önjavítása (SYSTEM-ként fut).
//
// A telepítés a v0.4.257 óta a helyes beállításokkal veszi fel a feladatot
// (shared/install-script.ts, WINDOWS_TASK_SETTINGS_PS): akkumulátoron is
// indul, nem áll le 72 óra után, hibás kilépés után újraindul. A korábban
// felvett feladat a Feladatütemező alapértékein ült — ezt a segéd induláskor
// egyszer a helyére teszi, csendben: se újratelepítés, se jóváhagyás nem kell
// hozzá. Ha nem sikerül, a naplóba megy, a segéd fut tovább.

import { execFile } from 'child_process';
import * as path from 'path';
import { encodePowerShell, windowsTaskSettingsRepairScript } from '../shared/install-script';

export function repairTaskSettings(log: (m: string) => void): void {
  if (process.platform !== 'win32') return;
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodePowerShell(windowsTaskSettingsRepairScript()),
  ];
  // Abszolút úttal: SYSTEM-ként egy PATH-on talált „powershell.exe” bárkié lehetne.
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFile(exe, args, { timeout: 60_000, windowsHide: true }, (err) => {
    log(err
      ? `a feladat beállításait nem sikerült a helyükre tenni: ${err.message}`
      : 'a feladat beállításai a helyükön (akkumulátoron is fut, nincs időkorlát, hiba után újraindul)');
  });
}
