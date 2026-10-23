// A védett futtatókörnyezet héjainak próba-fája (test/runtime-shell.test.ts és
// test/helper-update.test.ts közös része): egy ideiglenes fa, csonkolt
// macOS-eszközök (launchctl, codesign, sw_vers, sysctl, plutil, ls -le, df), egy
// kicsi „Node” tarball két architektúrára, és a segéd csomagja.

import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { shQuote } from '../src/shared/guard-script';
import { DAEMON_LABEL } from '../src/shared/install-script';
import { PAYLOAD_ENTRY, runtimeId, type NodeRuntimePin } from '../src/shared/helper-runtime';
import {
  MAC_RUNTIME_SHELL_DEFAULTS, MAC_SHELL_TOOLS, macInstallScript, type MacInstallInputs, type MacRuntimeShellOptions,
} from '../src/shared/runtime-shell';

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const packer = require(path.join(__dirname, '..', '..', 'scripts', 'pack-helper-payload.js'));

export const SHELLS: Array<[string, string[]]> = ([
  ['dash', ['/bin/dash']],
  ['bash --posix', ['/bin/bash', '--posix']],
] as Array<[string, string[]]>).filter(([, cmd]) => fs.existsSync(cmd[0]));
let shell: string[] = SHELLS[0][1];
export const currentShell = (): string[] => shell;

export function shTest(name: string, fn: () => void | Promise<void>): void {
  for (const [label, cmd] of SHELLS) {
    test(`${name} [${label}]`, () => { shell = cmd; return fn(); });
  }
}



export const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
export const exe = (file: string, body: string) => fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
export const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
export const UID = process.getuid ? process.getuid() : 0;

export interface Rig {
  root: string;
  /** az állapotmappa (szóközzel az útjában, mint élesben) */
  dir: string;
  rt: string;
  ld: string;
  dp: string;
  flags: string;
  calls: string;
  nodeEnv: string;
  opts: MacRuntimeShellOptions;
  inputs: MacInstallInputs;
  payload: Buffer;
  pin: NodeRuntimePin;
  /** a várt változatnév (arm64) */
  id: string;
}

/** Egy kicsi „Node”: --selfcheck-re ok-t ír, ha a belépési pont megvan; a környezetét feljegyzi. */
export function fakeNode(envOut: string, flags: string, tag: string): string {
  return [
    `env > ${shQuote(envOut)}`,
    `[ -f ${shQuote(path.join(flags, 'selfcheck-hang'))} ] && exec sleep 30`,
    `[ -f ${shQuote(path.join(flags, 'selfcheck-bad'))} ] && { echo nope; exit 0; }`,
    `# ${tag}`,
    '[ "$1" = --disable-sigusr1 ] && [ "$2" = --no-addons ] && [ -f "$3" ] && [ "$4" = --selfcheck ] && echo ok',
  ].join('\n');
}

export function buildNodeTar(root: string, arch: 'arm64' | 'x64', version: string, envOut: string, flags: string, tag: string = arch) {
  const top = `node-${version}-darwin-${arch}`;
  const work = fs.mkdtempSync(path.join(root, `nb-${arch}-`));
  fs.mkdirSync(path.join(work, top, 'bin'), { recursive: true });
  exe(path.join(work, top, 'bin', 'node'), fakeNode(envOut, flags, tag));
  fs.writeFileSync(path.join(work, top, 'README.md'), 'x');
  const tarFile = path.join(root, `${top}.tar.xz`);
  execFileSync('tar', ['-cJf', tarFile, '-C', work, top]);
  const tarBuf = fs.readFileSync(tarFile);
  return {
    tarFile,
    pin: { tarSha256: sha(tarBuf), tarSize: tarBuf.length, member: `${top}/bin/node`, binSha256: sha(fs.readFileSync(path.join(work, top, 'bin', 'node'))) },
  };
}

export function rig(over: Partial<MacRuntimeShellOptions> = {}): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtsh-'));
  const lib = path.join(root, 'Application Support');
  fs.mkdirSync(lib, { mode: 0o755 });
  fs.chmodSync(lib, 0o755);
  const dir = path.join(lib, 'Breaker');
  const rt = path.join(dir, 'runtime');
  const ld = path.join(root, 'LaunchDaemons');
  fs.mkdirSync(ld);
  const flags = path.join(root, 'flags');
  fs.mkdirSync(flags);
  const tools = path.join(root, 'tools');
  fs.mkdirSync(tools);
  const calls = path.join(root, 'calls');
  const loaded = path.join(root, 'loaded');
  fs.mkdirSync(loaded);
  const nodeEnv = path.join(root, 'node-env');
  const f = (n: string) => shQuote(path.join(flags, n));

  // launchctl: betöltött-e (jelzőfájl), bootout, bootstrap — a segéd indulását is eljátssza.
  exe(path.join(tools, 'launchctl'), [
    `echo "$*" >> ${shQuote(calls)}`,
    'lbl=${2#system/}',
    'case "$1" in',
    `  print) [ -f ${shQuote(loaded)}/"$lbl" ] ;;`,
    `  bootout) rm -f ${shQuote(loaded)}/"$lbl"; exit 0 ;;`,
    '  bootstrap)',
    '    lbl=$(sed -n \'s:.*<key>Label</key><string>\\(.*\\)</string>.*:\\1:p\' "$3")',
    `    [ -f ${f('bootstrap-fail')} ] && [ "$lbl" = ${DAEMON_LABEL} ] && exit 5`,
    `    [ -f ${f('guard-fail')} ] && [ "$lbl" = hu.breaker.guard ] && exit 5`,
    `    touch ${shQuote(loaded)}/"$lbl"`,
    `    if [ "$lbl" = ${DAEMON_LABEL} ] && grep -qF ${shQuote(`${rt}/current/node`)} "$3" && [ ! -f ${f('unhealthy')} ]; then`,
    `      b=$(readlink ${shQuote(`${rt}/current`)}); touch ${shQuote(rt)}/.ok-"$b"`,
    '    fi',
    '    ;;',
    'esac',
  ].join('\n'));
  exe(path.join(tools, 'codesign'), `echo "$*" >> ${shQuote(`${calls}.codesign`)}\n[ ! -f ${f('codesign-bad')} ]`);
  exe(path.join(tools, 'sysctl'), `[ -f ${f('intel')} ] && exit 1\necho 1`);
  exe(path.join(tools, 'sw_vers'), `if [ -f ${f('macos')} ]; then cat ${f('macos')}; else echo 14.6.1; fi`);
  exe(path.join(tools, 'plutil'), '[ "$1" = -lint ] && grep -q "<plist" "$2"');
  exe(path.join(tools, 'lsle'), `ls -lR "$@"\n[ -f ${f('acl')} ] && echo ' 0: group:everyone allow write'\nexit 0`);
  exe(path.join(tools, 'df'), `echo 'Filesystem 1024-blocks Used Available Capacity Mounted'\nif [ -f ${f('full')} ]; then echo 'd 1 1 100 99% /'; else echo 'd 1 1 99999999 1% /'; fi`);

  const nodeArm = buildNodeTar(root, 'arm64', 'v9.8.7', nodeEnv, flags);
  const nodeX64 = buildNodeTar(root, 'x64', 'v9.8.7', nodeEnv, flags);
  const pin: NodeRuntimePin = {
    version: 'v9.8.7', minMacos: [13, 5], teamId: 'TEAM123456', identifier: 'node', arm64: nodeArm.pin, x64: nodeX64.pin,
  };

  // A segéd csomagja — a valódi tar-íróval, egy belépési ponttal.
  const payload = packer.makeTar([
    { path: PAYLOAD_ENTRY, mode: 0o644, data: Buffer.from('// segéd\n') },
    { path: 'app/package.json', mode: 0o644, data: Buffer.from('{"type":"commonjs","version":"0.4.300"}\n') },
  ]) as Buffer;
  const res = path.join(root, 'Breaker.app', 'Contents', 'Resources', 'helper');
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(res, 'payload.tar'), payload);
  const cache = path.join(root, 'cache');
  fs.mkdirSync(cache);
  fs.copyFileSync(nodeArm.tarFile, path.join(cache, 'node.tar.xz'));

  const opts: MacRuntimeShellOptions = {
    ...MAC_RUNTIME_SHELL_DEFAULTS,
    dir, runtime: rt, daemonsDir: ld, ownerUid: UID, trustChain: [root, lib],
    pin,
    tools: {
      ...MAC_SHELL_TOOLS,
      launchctl: path.join(tools, 'launchctl'),
      codesign: path.join(tools, 'codesign'),
      openssl: 'openssl',
      tar: 'tar',
      tarSafeFlags: '--no-same-owner --no-xattrs --no-acls',
      sysctl: path.join(tools, 'sysctl'),
      swVers: path.join(tools, 'sw_vers'),
      plutil: path.join(tools, 'plutil'),
      xattrClear: 'true',
      base64Decode: 'base64 -d',
      aclStrip: 'true',
      aclStripOne: 'true',
      ownRoot: 'true',
      swapLink: 'mv -fT',
      aclList: path.join(tools, 'lsle'),
      df: path.join(tools, 'df'),
    },
    copySeconds: 5,
    selfcheckSeconds: 2,
    healthSeconds: 1,
    pollSeconds: 0.05,
    minFreeKb: 1000,
    minMacos: [13, 5],
    ...over,
  };
  const inputs: MacInstallInputs = {
    ownerUid: 501,
    payloadTar: path.join(res, 'payload.tar'),
    payloadSha256: sha(payload),
    payloadSize: payload.length,
    nodeTar: path.join(cache, 'node.tar.xz'),
    guardScript: '#!/bin/sh\necho guard\n',
    guardPlist: '<plist><dict><key>Label</key><string>hu.breaker.guard</string></dict></plist>\n',
  };
  return {
    root, dir, rt, ld, dp: path.join(ld, `${DAEMON_LABEL}.plist`), flags, calls, nodeEnv, opts, inputs, payload, pin,
    id: runtimeId(sha(payload), pin.arm64.binSha256),
  };
}

export interface Run { code: number; out: string; err: string; ms: number }

export function install(r: Rig, inputs: Partial<MacInstallInputs> = {}, env: Record<string, string> = {}): Run {
  const script = path.join(r.root, `install-${crypto.randomBytes(4).toString('hex')}.sh`);
  fs.writeFileSync(script, macInstallScript({ ...r.inputs, ...inputs }, r.opts));
  const t0 = Date.now();
  const p = spawnSync(shell[0], [...shell.slice(1), script], {
    encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
  });
  return { code: p.status ?? -1, out: p.stdout, err: p.stderr, ms: Date.now() - t0 };
}

export const flag = (r: Rig, n: string, body = '') => fs.writeFileSync(path.join(r.flags, n), body);
export const unflag = (r: Rig, n: string) => fs.rmSync(path.join(r.flags, n), { force: true });
export const calls = (r: Rig) => read(r.calls).split('\n').filter(Boolean);
export const entries = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
export const brk = (run: Run) => [...run.err.matchAll(/BRK:([a-z-]+)/g)].map((m) => m[1]);

