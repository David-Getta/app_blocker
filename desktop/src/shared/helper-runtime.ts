// A segéd védett futtatókörnyezete macOS-en (#151): hol van, és melyik Node
// futtatja.
//
// MIÉRT KÜLÖN NODE. A rendszerjoggal futó segéd eddig az app-csomagból futott
// (Electron Node-módban, az app.asar-ból) — azt pedig az app tulajdonosa
// írhatja. A védett futtatókörnyezet csak root által írható; benne a hivatalos
// Node.js bináris és a segéd saját JavaScriptje. A Node-ot nem mi fordítjuk:
// a nodejs.org kiadása, a Node.js Foundation Apple-tanúsítványával aláírva
// (Team ID HX7739G8FX). Ez az egyetlen kód, amit a root futtat, és amit egy
// tőlünk független fél is ellenőrizhet — ezért a tarball SHA-256-ját, benne a
// bináris SHA-256-ját és az aláíró csapatát is rögzítjük.
//
// A rögzítés menete (docs/releasing.md, „A Node-futtató rögzítése”): a
// SHASUMS256.txt.asc aláírását a Node kiadói kulcsaival ellenőrizzük, a
// tarballok SHA-256-ja abból jön; a bináris SHA-256-ja a kicsomagolt fájlé.
// Itt csak adat van: fájlt nem nyit, hálózatot nem ér.

import * as crypto from 'crypto';
import type { NodePin } from './helper-manifest';

/** A védett futtatókörnyezet gyökere: root:wheel 0700, ACL nélkül. */
export const RUNTIME_ROOT = '/Library/Application Support/Breaker/runtime';
/** Az éppen futó változatra mutató szimbolikus link (a plist ezt nevezi meg). */
export const RUNTIME_CURRENT = `${RUNTIME_ROOT}/current`;
/** A csomagon belül a segéd belépési pontja (a payload.tar szerkezete szerint). */
export const PAYLOAD_ENTRY = 'app/dist/helper/index.js';
export const RUNTIME_ENTRY = `${RUNTIME_CURRENT}/${PAYLOAD_ENTRY}`;
export const RUNTIME_NODE = `${RUNTIME_CURRENT}/node`;

export interface NodeRuntimePin {
  version: string;
  /** a Node.js ennél régebbi macOS-en nem indul (major, minor) */
  minMacos: readonly [number, number];
  /** a bináris aláírójának Apple Team ID-ja */
  teamId: string;
  /** a bináris code signing azonosítója */
  identifier: string;
  arm64: NodePin;
  x64: NodePin;
}

/**
 * A rögzített Node.js. Csere csak kiadáson át: a telepített segédek a saját
 * leírójuk szerint ellenőriznek, és egy új rögzítéshez az app az új tarballt
 * is felkínálja (lásd docs/releasing.md).
 */
export const NODE_RUNTIME: NodeRuntimePin = {
  version: 'v24.22.1',
  minMacos: [13, 5],
  teamId: 'HX7739G8FX',
  identifier: 'node',
  arm64: {
    tarSha256: '654ba79de6155647e22321932b45f2a1ccb705976cc337c9b8e278beb085a628',
    tarSize: 27518756,
    member: 'node-v24.22.1-darwin-arm64/bin/node',
    binSha256: '6f32069480ec14d52b6d7b1f3c7124cfbbc46203abf5ddf5c65b127435f3f329',
  },
  x64: {
    tarSha256: '65e450f90a6eaacd5000f611861c4ce65fadc87f813795dc4ed0c0e5f2fca2d4',
    tarSize: 29283404,
    member: 'node-v24.22.1-darwin-x64/bin/node',
    binSha256: 'cc6f41f72e3eb4460154952e56a35afdd96b6995cea51cd25e637355a2955a51',
  },
};

/** A tarball neve a kiadáson (a nodejs.org-on és a tükrünkön is ez). */
export function nodeTarName(arch: 'arm64' | 'x64', pin: NodeRuntimePin = NODE_RUNTIME): string {
  return `node-${pin.version}-darwin-${arch}.tar.xz`;
}

/**
 * Honnan tölthető le a tarball, sorrendben: előbb a saját tükrünk (a repó egy
 * rögzített kiadása), aztán a nodejs.org. Mindkettőt ugyanaz a SHA-256 köti;
 * a forrás csak a rendelkezésre állást számít, a bizalmat nem.
 */
export function nodeTarUrls(arch: 'arm64' | 'x64', pin: NodeRuntimePin = NODE_RUNTIME): string[] {
  const name = nodeTarName(arch, pin);
  return [
    `https://github.com/david-getta/app_blocker/releases/download/node-runtime-${pin.version}/${name}`,
    `https://nodejs.org/dist/${pin.version}/${name}`,
  ];
}

/**
 * A futtatókörnyezet egy változatának mappaneve: a csomag és a Node együttes
 * ujjlenyomatából, 16 hexa jegy. Ugyanaz a tartalom ugyanazt a nevet kapja —
 * egy újratelepítés nem halmoz fel másolatokat.
 */
export function runtimeId(payloadSha256: string, binSha256: string): string {
  return crypto.createHash('sha256').update(`${payloadSha256}:${binSha256}`).digest('hex').slice(0, 16);
}

/** A futtatókörnyezet változatának neve csak ilyen lehet (az őr is ezt nézi). */
export const RUNTIME_ID_RE = /^[0-9a-f]{16}$/;

/** A macOS-verzió (például „13.5.2”) eléri-e a megadottat. Rossz alakra nem. */
export function macosAtLeast(version: string, min: readonly [number, number]): boolean {
  const m = /^(\d+)(?:\.(\d+))?/.exec(version);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? '0');
  return major > min[0] || (major === min[0] && minor >= min[1]);
}
