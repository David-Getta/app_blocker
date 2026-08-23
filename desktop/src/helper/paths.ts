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
