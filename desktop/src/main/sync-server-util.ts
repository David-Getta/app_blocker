// A beépített szinkron-kiszolgáló tiszta részei.
//
// Külön fájl, mert a `sync-server.ts` az Electronra épül, és azt egy sima
// node-teszt nem tudja betölteni. Ami itt van, az viszont a rendszertől
// független — és pont ez a két dolog az, ami könnyen elromlik: a helyi cím
// megtalálása és a hibaüzenet, amit a felhasználó lát.

import * as os from 'os';

/** Alapértelmezett port. Ugyanaz, mint a különálló kiszolgálóé. */
export const SYNC_PORT = 8787;

export interface SyncServerState {
  running: boolean;
  /** amit a másik eszközbe be kell írni */
  url?: string;
  /**
   * Ugyanez a kiszolgáló, de a SAJÁT gépről nézve.
   *
   * A helyi felhasználáshoz ez a megbízható: a hálózati cím a Wi-Fi váltásával
   * megváltozik, a 127.0.0.1 viszont sosem. Enélkül a saját gépen bejelentkezés
   * után a fiók egy olyan címre hivatkozna, ami holnap már mást jelent.
   */
  localUrl?: string;
  /** hol tárolja az adatot ez a gép */
  dataDir?: string;
  error?: string;
}

/**
 * A gép helyi hálózati címe.
 *
 * A `localhost` itt HASZNÁLHATATLAN: azt a telefon nem éri el. A cél az első
 * nem belső IPv4 cím — ezt kell beírni a másik eszközön.
 */
export function lanAddress(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | undefined {
  for (const list of Object.values(interfaces)) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return undefined;
}

/**
 * Amit a felhasználó a hiba helyén lát.
 *
 * A csupasz `EADDRINUSE` semmit nem mond annak, aki nem fejlesztő. A leggyakoribb
 * oka viszont pontosan megnevezhető: már fut egy kiszolgáló ezen a gépen.
 */
export function serverError(e: Error & { code?: string }): string {
  if (e.code === 'EADDRINUSE') {
    return `A ${SYNC_PORT}-es port foglalt — fut már egy kiszolgáló ezen a gépen?`;
  }
  return e.message;
}
