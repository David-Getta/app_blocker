// Véletlen szinkron-rekordok a tesztekhez — a fuzz és a megfelelőségi
// fixture közös generátora.
//
// A véletlen egy LCG, és a képlete meg a hívási sorrendje SZERZŐDÉS: a Kotlin
// (MergeFuzzTest) és a Swift (MergeFuzzTests) tükör ugyanezt a sorozatot
// állítja elő ugyanabból a magból, tehát ugyanazokat az eseteket járja be.
// Ha itt egy r() hívás sorrendje változik, ott is változnia kell.

import type { SyncSite } from '../src/shared/sync/merge';
import { emptyFocus, type SyncFocus } from '../src/shared/sync/focus-merge';
import type { FocusPack } from '../src/shared/focus';
import type { Band } from '../src/shared/schedule';

/** Determinisztikus véletlen (LCG): a mag a hibaüzenetben áll, a bukás megismételhető. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export const HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'yt.be'];
export const DEVICES = ['gep-a', 'gep-b', 'telefon'];

export function randomSite(r: () => number, device: string): SyncSite {
  const hostnames = HOSTS.filter((h, i) => i === 0 || r() < 0.5);
  const marks: Record<string, number> = {};
  for (const h of HOSTS.slice(1)) if (r() < 0.4) marks[h] = 1 + Math.floor(r() * 5);
  const pendingDeleteAt = r() < 0.15 ? 5_000 + Math.floor(r() * 3) : null;
  const dailyLimitSeconds = r() < 0.4 ? 600 * (1 + Math.floor(r() * 3)) : undefined;
  const alias = r() < 0.3 ? `n${Math.floor(r() * 3)}` : undefined;
  const rev = 1 + Math.floor(r() * 5);
  const updatedAt = 100 + Math.floor(r() * 5);
  // A jel sosem nagyobb a rekord rev-jénél — a bemenet mindhárom nyelvben
  // így tisztít, tehát a megfelelőségi fixture-ben sem lehet más.
  for (const h of Object.keys(marks)) marks[h] = Math.min(marks[h], rev);
  return {
    id: 'site_1', domain: 'youtube.com', hostnames, addedAt: 1_000,
    ...(Object.keys(marks).length ? { hostnameMarks: marks } : {}),
    pauseUntil: null, pendingDeleteAt, dailyLimitSeconds, alias, rev, updatedAt, updatedBy: device,
  };
}

export const PACK_IDS = ['p1', 'p2', 'p3', 'p4'];
export const WIN: Band = { days: [1, 2, 3, 4, 5], startMin: 540, endMin: 720 };

export function randomFocus(r: () => number, device: string): SyncFocus {
  const packs: FocusPack[] = PACK_IDS.filter(() => r() < 0.6).map((id) => ({
    id, name: `csomag ${id} v${Math.floor(r() * 3)}`, allowSites: ['quizlet.com'], allowApps: [],
    defaultMinutes: 50, ...(r() < 0.4 ? { recurrence: WIN } : {}),
  }));
  const marks: Record<string, number> = {};
  for (const id of PACK_IDS) if (r() < 0.4) marks[id] = 1 + Math.floor(r() * 5);
  const rev = 1 + Math.floor(r() * 5);
  // A jel sosem nagyobb a blob rev-jénél (a bemenet is így tisztít): a
  // csomag nélküli menet lehetetlensége erre épül.
  for (const id of Object.keys(marks)) marks[id] = Math.min(marks[id], rev);
  // A menet lejárata és kezdése is csak pár értéket vesz fel: legyen sok
  // döntetlen, mert éppen a döntetlen-lánc az, ami sorrendfüggő tud lenni.
  const run = r() < 0.4 && packs.length > 0
    ? {
        packId: packs[Math.floor(r() * packs.length)].id,
        startedAt: 10 + 60_000 * Math.floor(r() * 2),
        endsAt: 610_000 + 60_000 * Math.floor(r() * 2),
      }
    : null;
  return {
    ...emptyFocus(device), packs, ...(Object.keys(marks).length ? { packMarks: marks } : {}),
    run, rev, updatedAt: 100 + Math.floor(r() * 5), updatedBy: device,
  };
}

/**
 * A MEGFELELŐSÉGI kulcs — bájtra ugyanez a három nyelvben (Kotlin
 * MergeFixtureTest, Swift MergeFixtureTests). Ami benne van, annak a három
 * tükörben azonosan kell kijönnie ugyanabból a két bemenetből.
 */
export function siteConformanceKey(s: SyncSite): string {
  const marks = Object.entries(s.hostnameMarks ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join(',');
  const opt = (v: number | string | null | undefined) => (v === null || v === undefined ? '-' : String(v));
  return `hosts=[${[...s.hostnames].sort().join(',')}] marks=[${marks}] rev=${s.rev}`
    + ` pending=${opt(s.pendingDeleteAt)} limit=${opt(s.dailyLimitSeconds)} alias=${opt(s.alias)}`
    + ` at=${s.updatedAt} by=${s.updatedBy}`;
}

export function focusConformanceKey(f: SyncFocus): string {
  const packs = [...f.packs].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)).map((p) => {
    const rec = p.recurrence
      ? `${[...p.recurrence.days].sort((a, b) => a - b).join(',')}/${p.recurrence.startMin}/${p.recurrence.endMin}`
      : '-';
    return [p.id, p.name, [...p.allowSites].sort().join(','), [...p.allowApps].sort().join(','), String(p.defaultMinutes), rec].join('|');
  }).join(';');
  const marks = Object.entries(f.packMarks ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join(',');
  const run = f.run ? `${f.run.packId}/${f.run.startedAt}/${f.run.endsAt}` : '-';
  return `packs=[${packs}] run=${run} marks=[${marks}] rev=${f.rev} at=${f.updatedAt} by=${f.updatedBy}`;
}
