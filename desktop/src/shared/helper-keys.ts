// A segéd csomagjait aláíró kiadási kulcsok nyilvános fele (#151).
//
// Csak a nyilvános fél van itt; a titkos a kiadási folyamat védett
// környezetében (HELPER_SIGNING_KEY), és egy offline mentésben. Amíg a lista
// üres, a segéd egyetlen csomagot sem fogad el csendben: kulcs nélkül nincs
// jelszó nélküli frissítés. Új kulcsot egy kiadással KORÁBBAN kell felvenni,
// mint ahogy aláírnánk vele (a telepített segédek a sajátjukban lévő listával
// ellenőriznek) — lásd docs/releasing.md.

import type { ReleaseKey } from './helper-manifest';

export const RELEASE_KEYS: readonly ReleaseKey[] = [];
