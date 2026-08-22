// Platform paths for the privileged helper. Every path can be overridden via
// environment variables so the whole helper can run unprivileged in dev/tests.

import * as os from 'os';
import * as path from 'path';

export function stateFilePath(): string {
  if (process.env.LAKAT_STATE) return process.env.LAKAT_STATE;
  switch (process.platform) {
    case 'darwin':
      return '/Library/Application Support/Lakat/state.json';
    case 'win32':
      return path.join(process.env.ProgramData || 'C:\\ProgramData', 'Lakat', 'state.json');
    default:
      return process.getuid && process.getuid() === 0
        ? '/var/lib/lakat/state.json'
        : path.join(os.homedir(), '.lakat-dev', 'state.json');
  }
}

export function hostsFilePath(): string {
  if (process.env.LAKAT_HOSTS) return process.env.LAKAT_HOSTS;
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  }
  return '/etc/hosts';
}

export function socketPath(): string {
  if (process.env.LAKAT_SOCKET) return process.env.LAKAT_SOCKET;
  if (process.platform === 'win32') return '\\\\.\\pipe\\lakat-helper';
  if (process.platform === 'darwin') return '/var/run/lakat.sock';
  return process.getuid && process.getuid() === 0
    ? '/var/run/lakat.sock'
    : path.join(os.homedir(), '.lakat-dev', 'lakat.sock');
}
