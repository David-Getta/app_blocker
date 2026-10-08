// A WINDOWS-SEGÉD KULCSA: amivel az app bizonyítja, hogy a telepítő
// felhasználóé.
//
// MIÉRT. A segéd SYSTEM-ként fut, és named pipe-on hallgat. Az alapértelmezett
// biztonsági leíró a mindenki-csoportnak csak OLVASÁST ad — a nem emelt app
// egyetlen kérést sem tudott küldeni (a CI Windows-próbája mutatta meg:
// „Access denied”). Egyedi DACL-t natív kód nélkül nem tudunk a pipe-ra
// tenni; a Node csak „mindenki írhatja”-t ismer. Ezért a pipe mindenkinek
// nyitott, de csak az a kapcsolat kap szót, amelyik az első sorában
// (`hello`) bemutatja a kulcsot.
//
// HOL ÉL. A kulcs maga az app adatkönyvtárában (a felhasználó profilja: más
// felhasználó nem olvassa). A segéd csak a SHA-256 lenyomatát ismeri — a
// telepítő süti az ütemezett feladat parancssorába, ahogy macOS-en a
// tulajdonos uid-jét. A lenyomatból a kulcs nem fejthető vissza, tehát akkor
// sem baj, ha valaki látja.

import * as crypto from 'crypto';

/** A segéd parancssori kapcsolója: `--client-key-sha256=<64 hexa>`. */
export const CLIENT_KEY_ARG = '--client-key-sha256=';

/** Kulcs és lenyomat is 32 bájt, kisbetűs hexában. */
const HEX64 = /^[0-9a-f]{64}$/;

export function isClientKey(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}

export function isKeyHash(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}

/** Friss kulcs: 32 véletlen bájt. */
export function newClientKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** A kulcs lenyomata — ezt kapja a segéd. */
export function clientKeyHash(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Illik-e a bemutatott kulcs a lenyomathoz — időzítésből sem árulkodik. */
export function clientKeyMatches(key: unknown, expectedHash: string): boolean {
  if (!isClientKey(key) || !isKeyHash(expectedHash)) return false;
  return crypto.timingSafeEqual(Buffer.from(clientKeyHash(key), 'hex'), Buffer.from(expectedHash, 'hex'));
}

/** A segéd parancssorából: a lenyomat, ha van és jó alakú; különben undefined. */
export function keyHashFromArgs(argv: readonly string[]): string | undefined {
  const arg = argv.find((a) => a.startsWith(CLIENT_KEY_ARG));
  if (arg === undefined) return undefined;
  const hash = arg.slice(CLIENT_KEY_ARG.length);
  return isKeyHash(hash) ? hash : undefined;
}
