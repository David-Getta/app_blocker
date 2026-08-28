// A csatorna-szűrők összefésülése két eszköz között.
//
// MIÉRT KÜLÖN FÁJL. A blokklista (merge.ts) rekordonként egyeztet, a
// munkamenet (focus-merge.ts) egy futó állapotot véd. A csatorna-szűrők a
// CSOMAGOKHOZ hasonlítanak: szerkeszthető beállítás-lista, amin a súrlódást
// nem a szinkron, hanem a HELYI kapu (referee) tartja — lazítani csak
// próbatétellel lehet, és a `rev` csak elvégzett munka után nő.
//
// Ezért a szabály itt a legegyszerűbb a három közül: az egész lista egyben
// utazik, és a FRISSEBB oldal nyer (`rev`, majd idő, majd eszközazonosító).
// Egy régi állapot visszajátszása nem tud lazítani — a lazításhoz a másik
// gépen próbatétel kellett, és annak a nyoma a nagyobb `rev`.
//
// A doksi: docs/feature-channel-filter.md

import {
  MAX_ALLOW_PER_FILTER, MAX_CHANNEL_FILTERS, sanitizeFilter, type ChannelFilter,
} from '../channels.js';

/** Egy szűrő-azonosító legnagyobb hossza — kívülről jött szöveg. */
const MAX_FILTER_ID_LENGTH = 64;

export interface SyncChannels {
  filters: ChannelFilter[];
  rev: number;
  updatedAt: number;
  updatedBy: string;
}

export function emptyChannels(deviceId: string): SyncChannels {
  return { filters: [], rev: 0, updatedAt: 0, updatedBy: deviceId };
}

/**
 * Egy kívülről jött csatorna-blob használható alakja.
 *
 * A szinkronon át érkező JSON ugyanolyan megbízhatatlan, mint bármi más: a
 * rekordokat UGYANAZ a tisztító nézi át, mint a helyi mentést (sanitizeFilter)
 * — ami ott nem menne át, az innen sem jöhet be. Egy rossz rekord kiesik, a
 * blob egésze nem hasal el tőle.
 */
export function normalizeSyncChannels(raw: unknown, fallbackDevice: string): SyncChannels {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<SyncChannels>;
  const filters: ChannelFilter[] = [];
  for (const f of Array.isArray(o.filters) ? o.filters : []) {
    if (!f || typeof f !== 'object') continue;
    const id = typeof (f as ChannelFilter).id === 'string'
      ? (f as ChannelFilter).id.slice(0, MAX_FILTER_ID_LENGTH) : '';
    const clean = sanitizeFilter(f as ChannelFilter);
    if (!id || !clean) continue;
    if (filters.some((x) => x.id === id)) continue;
    filters.push({ id, ...clean });
    if (filters.length >= MAX_CHANNEL_FILTERS) break;
  }
  return {
    filters,
    rev: numberOr(o.rev, 0),
    updatedAt: numberOr(o.updatedAt, 0),
    updatedBy: typeof o.updatedBy === 'string' && o.updatedBy ? o.updatedBy : fallbackDevice,
  };
}

/**
 * Két csatorna-állapot összefésülése: a frissebb oldal listája marad.
 *
 * Nem rekordonként, hanem egyben — a szűrők együtt alkotnak egy szándékot
 * („ezeken az oldalakon ezt engedem”), és egy fél-fél keverék mindkét gép
 * felhasználóját meglepné. Aki utoljára dolgozott rajta, azé a szó.
 */
export function mergeChannels(local: SyncChannels, incoming: SyncChannels): SyncChannels {
  const newer = pickNewer(local, incoming);
  const older = newer === local ? incoming : local;
  return {
    filters: newer.filters,
    rev: Math.max(local.rev, incoming.rev),
    updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
    // Az eszközazonosító a győztesé — a döntetlen-eltörés stabilitása múlik
    // rajta, mint a munkamenetnél.
    updatedBy: newer.updatedBy || older.updatedBy,
  };
}

/**
 * Melyik oldal FRISSEBB. Sorrend: `rev`, majd idő, majd eszközazonosító —
 * ugyanaz a teljes rendezés, mint a munkamenetnél, ugyanazért: enélkül két
 * eszköz örökké oda-vissza írná egymást, és a szinkron sosem konvergálna.
 */
function pickNewer(a: SyncChannels, b: SyncChannels): SyncChannels {
  if (a.rev !== b.rev) return a.rev > b.rev ? a : b;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.updatedBy >= b.updatedBy ? a : b;
}

/** Ugyanaz-e a két állapot (nincs mit feltölteni). */
export function sameChannels(a: SyncChannels, b: SyncChannels): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function stable(c: SyncChannels): unknown {
  return {
    filters: [...c.filters]
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .map((f) => ({
        id: f.id,
        host: f.host,
        // Az engedélylista HALMAZ, nem sorrend: rendezve hasonlítjuk, hogy egy
        // átrendeződés ne látsszon változásnak, és ne induljon tőle feltöltés.
        allow: [...f.allow].sort().slice(0, MAX_ALLOW_PER_FILTER),
        enabled: f.enabled,
      })),
    rev: c.rev,
  };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
