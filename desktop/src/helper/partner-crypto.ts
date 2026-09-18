// A megbízott jelmondatának LENYOMATA — a segédben, mert az scrypt a Node
// `crypto`-ja. A szabály (mi számít ugyanannak a jelmondatnak) a tiszta
// magban van (shared/partner.ts); itt csak a hasolás és az összevetés.
//
// Ugyanaz az scrypt, ugyanazokkal a paraméterekkel, mint a fiók kulcsáé: a
// lassúság a lényeg. Négy szó a próbatételek szólistájából sokmilliárd
// kombináció; a lenyomatonkénti tizedmásodperc azt évekre nyújtja — és ennyi
// elég, mert ez nem a kiszolgáló elleni védelem, hanem a fájlba belenézés
// elleni („csak megnézem a fájlban”). A telefonok ugyanezt számolják
// (Scrypt.kt, Scrypt.swift): a jelmondat egy eszközön születik, és
// bármelyiken ellenőrizhető.

import * as crypto from 'crypto';
import { SCRYPT_N, SCRYPT_P, SCRYPT_R } from '../shared/sync/crypto';
import { normalizePhrase, type PartnerLock } from '../shared/partner';

const HASH_LEN = 32;
const SALT_LEN = 16;
const SCRYPT_MAXMEM = 2 * 128 * SCRYPT_N * SCRYPT_R;

/** A jelmondat lenyomata egy adott sóval — base64. */
export function hashPhrase(phrase: string, saltB64: string): string {
  return crypto.scryptSync(
    Buffer.from(normalizePhrase(phrase), 'utf8'), Buffer.from(saltB64, 'base64'), HASH_LEN,
    { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
  ).toString('base64');
}

/** Új megbízott: friss só, a jelmondat lenyomata — a jelmondat maga nem marad meg. */
export function makePartnerLock(name: string, phrase: string, now: number): PartnerLock {
  const salt = crypto.randomBytes(SALT_LEN).toString('base64');
  return { name, salt, hash: hashPhrase(phrase, salt), setAt: now };
}

/** Ez-e a jelmondat — állandó idejű összevetéssel. */
export function verifyPhrase(lock: PartnerLock, phrase: string): boolean {
  if (normalizePhrase(phrase) === '') return false;
  const got = Buffer.from(hashPhrase(phrase, lock.salt), 'base64');
  const want = Buffer.from(lock.hash, 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
