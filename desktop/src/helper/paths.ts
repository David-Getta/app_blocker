// Platform paths for the privileged helper. Every path can be overridden via
// environment variables so the whole helper can run unprivileged in dev/tests.

import * as os from 'os';
import * as path from 'path';

export function stateFilePath(): string {
  if (process.env.BREAKER_STATE) return process.env.BREAKER_STATE;
  switch (process.platform) {
    case 'darwin':
      return '/Library/Application Support/Breaker/state.json';
    case 'win32':
      return path.join(process.env.ProgramData || 'C:\\ProgramData', 'Breaker', 'state.json');
    default:
      return process.getuid && process.getuid() === 0
        ? '/var/lib/breaker/state.json'
        : path.join(os.homedir(), '.breaker-dev', 'state.json');
  }
}

export function hostsFilePath(): string {
  if (process.env.BREAKER_HOSTS) return process.env.BREAKER_HOSTS;
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  }
  return '/etc/hosts';
}

export function socketPath(): string {
  if (process.env.BREAKER_SOCKET) return process.env.BREAKER_SOCKET;
  if (process.platform === 'win32') return '\\\\.\\pipe\\breaker-helper';
  if (process.platform === 'darwin') return '/var/run/breaker.sock';
  return process.getuid && process.getuid() === 0
    ? '/var/run/breaker.sock'
    : path.join(os.homedir(), '.breaker-dev', 'breaker.sock');
}

/** A szigorú blokk (shared/strict-block.ts) helye: a segéd állapotmappájában. */
export function strictBlockPath(): string {
  return path.join(path.dirname(stateFilePath()), 'strict-hosts');
}

/**
 * Az őr és az eltávolító másolatának mappája. macOS-en a segéd állapotmappája
 * (a rooté); Windowson a Program Files alatt — oda sima felhasználó nem írhat,
 * és a Gépház-eltávolítás sem viszi el (az a Breaker mappáját törli).
 */
export function guardDir(): string {
  if (process.platform === 'win32') {
    const pf = process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files';
    return path.join(pf, 'Breaker Guard');
  }
  return path.dirname(stateFilePath());
}

/** A teljes eltávolító szkript másolatának helye (a szigorú blokk magyarázata ide mutat). */
export function uninstallCopyPath(): string {
  return path.join(guardDir(), process.platform === 'win32' ? 'uninstall-windows.ps1' : 'uninstall-macos.sh');
}

/**
 * Egy Windows-rendszereszköz abszolút útja. A SYSTEM-ként futó segéd semmit ne
 * a PATH-ból vagy a munkakönyvtárból indítson: ami ott elébe kerül, az
 * rendszerjoggal futna.
 */
export function system32(exe: string): string {
  return path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
}
