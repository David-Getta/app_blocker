// Megfelelőségi fixtúra a DRÓTON JÖTT REKORDOKRA: egy rossz elem nem viheti a
// többit, és a három mag ugyanazt tartja meg belőle.
//
// A blokklista és a munkamenet-dokumentum a fiókon utazik, és minden olvasó
// kívülről jött adatnak veszi. A gép és az Android rekordonként tűrt (egy
// hibás sor kiesik, a többi marad); az iPhone a listát EGYBEN dekódolta —
// egyetlen rossz csomag vagy oldal az egészet vitte, és a kör üresnek látta a
// kiszolgálót. A munkamenetnél ez több, mint adatvesztés: ha egy csomag nem
// dekódolódik, a jele (packMarks) a csomag nélkül sírkőnek látszik, és a
// csomag MINDENHOL törlődne. A gép ezért „látottnak” veszi a kiesett csomag
// azonosítóját, és a jelét is dobja — ezt a fixtúra kimondja.
//
// A szabály a gépé (referencia): a rekord csak az azonosító (és az oldalnál a
// domain) hibájára esik ki; minden más mező rossz típusa az alapértéket kapja
// — csak JSON-szám a szám, csak szöveg a szöveg, csak igaz az igaz.
//
//   UPDATE_WIRE_FIXTURE=1 npm test     — a fájl újraírása

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeIncomingSites } from '../src/helper/sync-client';
import { normalizeSyncFocus, type SyncFocus } from '../src/shared/sync/focus-merge';
import type { SyncSite } from '../src/shared/sync/merge';
import { normalizeSchedule, type Schedule } from '../src/shared/schedule';
import { rng, usageConformanceKey } from './merge-random';
import { keywordMarksKey } from '../src/shared/keywords';
import { windowMarksKey } from '../src/shared/lockdown';
import { combineUsage, type UsageState } from '../src/shared/usage';

/** dist-test/test/… → a tároló gyökere. */
const FIXTURE = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'wire-cases.json');

interface WireCase { in: string; out: string }
interface Fixture { note: string; version: number; sites: WireCase[]; focus: WireCase[]; usage: WireCase[] }

// ------------------------------------------------------------------ oldalak

const SITE_GOOD: unknown[] = [
  { id: 's1', domain: 'youtube.com', hostnames: ['youtube.com', 'www.youtube.com'], addedAt: 1000, pendingDeleteAt: null, rev: 2, updatedAt: 1500, updatedBy: 'gep' },
  { id: 's2', domain: 'reddit.com', hostnames: ['reddit.com'], addedAt: 2000, pendingDeleteAt: 5000, dailyLimitSeconds: 1800, alias: 'Fórum', reason: 'Este nem', rev: 3, updatedAt: 2500, updatedBy: 'telefon' },
  { id: 's3', domain: 'tiktok.com', hostnames: ['tiktok.com'], addedAt: 3000, rev: 1, updatedAt: 3000, updatedBy: 'gep' },
];

/** Megmarad, a rossz mező az alapértékét kapja. */
const SITE_TOLERATED: unknown[] = [
  { id: 'f1', domain: 'a.com', hostnames: 'a.com', addedAt: 1, rev: 1, updatedAt: 1, updatedBy: 'x' },
  { id: 'f2', domain: 'b.com', hostnames: [5, 'm.b.com', null, 'M.B.COM', true, 'm.b.com', {}], addedAt: 1, rev: 1, updatedAt: 1, updatedBy: 'x' },
  { id: 'f3', domain: 'c.com', hostnames: ['c.com'] },
  { id: 'f4', domain: 'd.com', hostnames: ['d.com'], addedAt: '5', pendingDeleteAt: '5', dailyLimitSeconds: '60', rev: '3', updatedAt: '7', updatedBy: 5 },
  { id: 'f5', domain: 'e.com', hostnames: ['e.com'], alias: 5, reason: true, addedAt: 1, rev: 2, updatedAt: 1, updatedBy: 'x' },
  { id: 'f6', domain: 'f.com', hostnames: ['f.com'], alias: null, reason: null, pendingDeleteAt: null, dailyLimitSeconds: null, addedAt: 1, rev: 1, updatedAt: 1, updatedBy: 'x' },
  { id: 'f7', domain: 'g.com', hostnames: ['g.com'], rev: 1.5, addedAt: true, updatedAt: false, updatedBy: null },
  { id: 'f8', domain: 'h.com', hostnames: null, rev: true, pendingDeleteAt: true, dailyLimitSeconds: false },
  { id: 'f9', domain: 'i.com', hostnames: ['i.com'], addedAt: [1], pendingDeleteAt: {}, rev: [2], updatedAt: {}, updatedBy: ['x'] },
  // A jelek: csak egész, pozitív, legfeljebb az (egész) rev — a tört rev 1.
  { id: 'f10', domain: 'j.com', hostnames: ['j.com', 'm.j.com'], rev: 2.5, hostnameMarks: { 'j.com': 2, 'm.j.com': 1 } },
  { id: 'f11', domain: 'k.com', hostnames: ['k.com', 'm.k.com'], rev: 3, hostnameMarks: { 'k.com': '2', 'm.k.com': 1.5, 'x.k.com': 3, 'w.k.com': 4, '': 1 } },
  { id: 'f12', domain: 'l.com', hostnames: ['l.com'], rev: 2, hostnameMarks: 'x' },
  // A menetrend: a rosszul formált sáv kiesik, a többi marad; ami nem
  // objektum, az nincs (mindig tiltva); az ismeretlen mód „mindig”.
  { id: 'g1', domain: 'm.com', hostnames: ['m.com'], schedule: 'x' },
  { id: 'g2', domain: 'n.com', hostnames: ['n.com'], schedule: { mode: 'scheduled_block', bands: 'x' } },
  { id: 'g3', domain: 'o.com', hostnames: ['o.com'], schedule: { mode: 'scheduled_block', bands: [
    null, 5, { days: [1, 2], startMin: 540, endMin: 600 }, { days: 'x', startMin: 1, endMin: 2 },
    { days: [1, '2'], startMin: 1, endMin: 2 }, { days: [3], startMin: '540', endMin: 600 },
    { days: [4], startMin: 540.5, endMin: 600 }, { days: [5], startMin: 0 }, { days: [5], startMin: 60, endMin: 120 },
  ] } },
  { id: 'g4', domain: 'p.com', hostnames: ['p.com'], schedule: { mode: 'jovobeli', bands: [{ days: [1], startMin: 0, endMin: 60 }] } },
  { id: 'g5', domain: 'q.com', hostnames: ['q.com'], schedule: { mode: 5, bands: [{ days: [1], startMin: 0, endMin: 60 }] } },
  { id: 'g6', domain: 'r.com', hostnames: ['r.com'], schedule: { mode: 'scheduled_allow' } },
  { id: 'g7', domain: 's.com', hostnames: ['s.com'], schedule: { mode: 'scheduled_allow', bands: [{ days: [0, 6], startMin: 1320, endMin: 360 }] } },
  { id: 'g8', domain: 't.com', hostnames: ['t.com'], schedule: { mode: 'scheduled_block', bands: [{ days: [9], startMin: 0, endMin: 60 }] } },
  { id: 'g9', domain: 'u.com', hostnames: ['u.com'], schedule: [] },
  { id: 'g10', domain: 'v.com', hostnames: ['v.com'], schedule: null },
  // A részleges szabályok: csak a kanonikus alak megy át (a magok kanonikus
  // alakban írnak); ami nem lista, az „nem tudok róla” (nem üres lista!).
  { id: 'h1', domain: 'w.com', hostnames: ['w.com'], rules: 'x' },
  { id: 'h2', domain: 'x.com', hostnames: ['x.com'], rules: [
    null, 5, { host: 'x.com', path: '/a' }, { host: 5, path: '/b' }, { host: 'x.com', path: 5 },
    { host: 'X.COM', path: '/c' }, { host: 'x.com', path: 'd' }, { host: 'x.com', path: '/a b' },
    { host: 'x.com', path: `/${'p'.repeat(600)}` }, { host: 'www.x.com', path: '/@Valaki' }, { path: '/e' },
  ] },
  { id: 'h3', domain: 'y.com', hostnames: ['y.com'], rules: [] },
  { id: 'h4', domain: 'z.com', hostnames: ['z.com'], rules: null },
];

/** Kiesik: nem objektum, vagy az azonosítója, a domainje nem jó. */
const SITE_DROPPED: unknown[] = [
  5, 'x', null, [], true,
  { domain: 'z.com', hostnames: ['z.com'] },
  { id: '', domain: 'z.com', hostnames: ['z.com'] },
  { id: 5, domain: 'z.com', hostnames: ['z.com'] },
  { id: null, domain: 'z.com', hostnames: ['z.com'] },
  { id: 'd1', hostnames: ['z.com'] },
  { id: 'd2', domain: 5, hostnames: ['z.com'] },
  { id: 'd3', domain: 'YouTube.com', hostnames: ['youtube.com'] },
  { id: 'd4', domain: 'https://youtube.com', hostnames: ['youtube.com'] },
  { id: 'd5', domain: 'not a host', hostnames: [] },
  { id: 'd6', domain: '', hostnames: [] },
  { id: 'd7', domain: 'youtube.com/', hostnames: [] },
  { id: 'd8', domain: ' youtube.com', hostnames: [] },
];

/** A menetrend HATÁSA (a döntés normalizálása után) — a nyers alak magonként más típusú. */
function scheduleKey(s: Schedule | undefined): string {
  if (s === undefined) return '-';
  const n = normalizeSchedule(s);
  return `${n.mode}:${n.bands.map((b) => `${[...new Set(b.days)].sort((x, y) => x - y).join(',')}/${b.startMin}/${b.endMin}`).join(';')}`;
}

function siteKey(s: SyncSite): string {
  const opt = (v: unknown) => (v === undefined || v === null ? '-' : String(v));
  return `${s.id}|${s.domain}|${s.hostnames.join(',')}|added=${s.addedAt}|del=${opt(s.pendingDeleteAt)}`
    + `|limit=${opt(s.dailyLimitSeconds)}|alias=${opt(s.alias)}|reason=${opt(s.reason)}`
    + `|rev=${s.rev}|at=${s.updatedAt}|by=${s.updatedBy}`
    + `|marks=${Object.keys(s.hostnameMarks ?? {}).sort().map((k) => `${k}=${s.hostnameMarks![k]}`).join(',')}`
    + `|sched=${scheduleKey(s.schedule)}`
    + `|rules=${s.rules === undefined ? '-' : `[${s.rules.map((r) => r.host + r.path).join(',')}]`}`;
}

// ------------------------------------------------------------- munkamenet

const PACK_GOOD: unknown[] = [
  { id: 'p1', name: 'Munka', allowSites: ['a.com'], allowApps: ['Code'], defaultMinutes: 30 },
  { id: 'p2', name: 'Olvasás', allowSites: [], allowApps: [], defaultMinutes: 45, recurrence: { days: [1, 3], startMin: 540, endMin: 600 } },
];

const PACK_TOLERATED: unknown[] = [
  { id: 't1', name: 'Csak név' },
  { id: 't2', name: 'Vegyes', allowSites: ['b.com', 5, true, null, 'B.COM'], allowApps: [5, 'Slack', null, '  Slack  '] },
  { id: 't3', name: 'Szöveges hossz', defaultMinutes: '30' },
  { id: 't4', name: 'Igaz hossz', defaultMinutes: true },
  { id: 't5', name: 'Óriás hossz', defaultMinutes: 100000 },
  { id: 't6', name: 'Rossz ismétlődés', recurrence: 'x' },
  { id: 't7', name: 'Lista helyett szöveg', allowSites: 'a.com', allowApps: 'Code' },
  { id: 't8', name: '  Szóközös   név  ' },
  { id: 't9', name: 'Tört hossz', defaultMinutes: 29.6 },
  { id: 't10', name: 'Null mezők', allowSites: null, allowApps: null, defaultMinutes: null, recurrence: null },
  { id: 't11', name: 'Fél ismétlődés', recurrence: { days: [1] } },
  { id: 't12', name: 'Tömb hossz', defaultMinutes: [30] },
];

/** Kiesik — de ha az azonosítója szöveg, „látott”: a jele is kiesik. */
const PACK_DROPPED: unknown[] = [
  5, 'x', null, [], true,
  { name: 'Nincs azonosító' },
  { id: '', name: 'Üres azonosító' },
  { id: 5, name: 'Szám azonosító' },
  { id: 'x1', name: 5 },
  { id: 'x2', name: '   ' },
  { id: 'x3', name: String.fromCodePoint(0xfeff) },
  { id: 'x4' },
  { id: 'p1', name: 'Ismétlődő azonosító' },
];

const LOG_GOOD: unknown[] = [
  { packId: 'p1', packName: 'Munka', startedAt: 1000, endedAt: 2000, plannedEndsAt: 2500, stopped: true },
  { packId: 'p2', packName: 'Olvasás', startedAt: 3000, endedAt: 4000, plannedEndsAt: 4000, stopped: false, window: true },
];

const LOG_TOLERATED: unknown[] = [
  { packId: 'l1', endedAt: 5000 },
  { packId: 'l2', packName: 5, startedAt: '100', endedAt: 6000, plannedEndsAt: '7000', stopped: 'true', window: 'true' },
  { packId: 'l3', packName: '  Hosszú   név  ', startedAt: 100, endedAt: 7000, plannedEndsAt: null, stopped: null, window: null },
  { packId: 'l4', packName: '', startedAt: true, endedAt: 8000, plannedEndsAt: false, stopped: 1, window: 1 },
];

const LOG_DROPPED: unknown[] = [
  5, 'x', null, [], true,
  { endedAt: 1 },
  { packId: '', endedAt: 1 },
  { packId: 5, endedAt: 1 },
  { packId: 'e1' },
  { packId: 'e2', endedAt: 0 },
  { packId: 'e3', endedAt: -5 },
  { packId: 'e4', endedAt: '3000' },
  { packId: 'e5', endedAt: true },
];

/**
 * A munkamenet-dokumentum többi mezője: a futó menet, a zárlat, az ablakok, a
 * kulcsszavak, a megbízott, a rejtés és a jeleik — mezőnként egy-egy hibás
 * változat. A szabály ugyanaz: csak JSON-szám a szám, csak szöveg a szöveg, a
 * listák elemenként tűrnek, és ami nem értelmezhető, az nincs.
 */
const SALT = 'A'.repeat(24);
const HASH = 'B'.repeat(44);
const SALT2 = 'C'.repeat(24);
const HASH2 = 'D'.repeat(44);
const SALT3 = 'E'.repeat(24);
const HASH3 = 'F'.repeat(44);
const FIELD_VARIANTS: Record<string, unknown>[] = [
  { run: { packId: 'p1', startedAt: 1000, endsAt: 5000 } },
  { run: { packId: 'p1', startedAt: '1000', endsAt: 5000 } },
  { run: { packId: 'p1', endsAt: 5000 } },
  { run: { packId: 'p1', startedAt: 1000, endsAt: '5000' } },
  { run: { packId: 'zz', startedAt: 1000, endsAt: 5000 } },
  { run: { packId: 5, startedAt: 1000, endsAt: 5000 } },
  { run: { packId: 'p1', startedAt: 1000, endsAt: 0 } },
  { run: 'x' },
  { lockdown: { startedAt: 1000, until: 9000 } },
  { lockdown: { until: 9000 } },
  { lockdown: { until: '9000' } },
  { lockdown: { startedAt: 20000, until: 9000 } },
  { lockdown: { startedAt: '1000', until: 9000 } },
  { lockdown: { until: -5 } },
  { lockdown: 'x' },
  { lockdownWindows: [
    { id: 'w1', days: [1, 2], startMin: 540, endMin: 600 },
    { id: 'w2', days: [1, '2', 9, 1.5], startMin: 600, endMin: 660 },
    { id: 'w3', days: [3], startMin: '540', endMin: 600 },
    { id: 5, days: [4], startMin: 0, endMin: 60 },
    null, 'x',
    { id: 'w1', days: [5], startMin: 0, endMin: 60 },
    { id: 'w6', days: [2, 1], startMin: 540, endMin: 600 },
    { id: 'w7', days: [6], startMin: null, endMin: 60 },
    { id: 'w8', days: [0], startMin: 0, endMin: 60 },
  ], lockdownWindowsRev: 3 },
  { lockdownWindows: 'x', lockdownWindowsRev: '3' },
  // Az ablak-jelek: kanonikus tartalmi kulcs (a napok növekvő sorrendben, vezető
  // nulla nélkül), pozitív egész, legfeljebb a blob rev-je.
  {
    lockdownWindows: [{ id: 'w1', days: [1, 2], startMin: 540, endMin: 600 }], lockdownWindowsRev: 3,
    lockdownWindowMarks: {
      '1,2/540/600': 2, '2,1/540/600': 1, '1/0540/600': 1, '9/0/60': 1, '1,1/0/60': 1,
      '3/0/60': 9, '4/0/60': 1.5, '5/0/60': '2', '6/0/1440': 4,
    },
  },
  { lockdownWindowMarks: 'x' },
  { lockdownWindowMarks: [1, 2] },
  { keywords: ['shorts', 12345, null, 'reels', 'Shorts', true, '  live  '], keywordsRev: 2 },
  { keywords: 'x', keywordsRev: 9 },
  // A kulcsszó-jelek: kanonikus kulcsszó, pozitív egész, legfeljebb a rev — a
  // „__proto__” is rendes kulcsszó (a JSON-ban saját mező, nem az öröklött).
  {
    keywords: ['shorts', '__proto__'], keywordsRev: 2,
    keywordMarks: JSON.parse('{"shorts":2,"reels":3,"live":"2","stream":1.5,"tiktok":9,"Shorts":1,"két szó":1,"ab":1,"__proto__":4}'),
  },
  { keywordMarks: 'x' },
  { keywordMarks: [1, 2] },
  { partner: { name: 'Anna', salt: SALT, hash: HASH, setAt: 1000 }, partnerRev: 4 },
  { partner: { name: 'Anna', salt: SALT, hash: HASH, setAt: '1000' }, partnerRev: 1.5 },
  { partner: { name: 5, salt: SALT, hash: HASH, setAt: 1000 } },
  { partner: { name: 'Anna', salt: 5, hash: HASH } },
  { partner: 'x' },
  // A társak és a levettek nyoma: a fővel egyező és a rossz alakú társ kiesik,
  // a rossz azonosságú nyom is; a nem egész vagy nem szám időpont nulla — és a
  // nyommal levett nem él, a fő a legkorábban felvett élő.
  {
    partner: { name: 'Anna', salt: SALT, hash: HASH, setAt: 1000 },
    partnerCo: [
      { name: 'Béla', salt: SALT2, hash: HASH2, setAt: 2000 }, { name: 'Anna', salt: SALT, hash: HASH, setAt: 1000 },
      'x', { name: 5, salt: SALT3, hash: HASH3 },
    ],
    partnersGone: [{ id: `${SALT3}|${HASH3}`, at: 7 }, { id: 'rossz', at: 1 }, { id: `${SALT2}|${HASH2}`, at: '3' }, null],
  },
  {
    partner: { name: 'Anna', salt: SALT, hash: HASH, setAt: 1000 },
    partnerCo: [{ name: 'Béla', salt: SALT2, hash: HASH2, setAt: 2000 }],
    partnersGone: [{ id: `${SALT}|${HASH}`, at: 1.5 }],
  },
  { partnerCo: [{ name: 'Béla', salt: SALT2, hash: HASH2, setAt: 2000 }, { name: 'Cili', salt: SALT3, hash: HASH3, setAt: 500 }] },
  { partnerCo: 'x', partnersGone: {} },
  { hideSiteList: true, hideSiteListRev: 2 },
  { hideSiteList: 'true', hideSiteListRev: 2 },
  { hideSiteList: 1 },
];

/** A jelek: a megmaradó, a kiesett (látott) és a sosem látott (sírkő) csomagé is. */
const MARK_IDS = ['p1', 'p2', 't1', 't2', 'x1', 'x2', 'x4', 'gone'];

function focusKey(f: SyncFocus): string {
  const packs = f.packs.map((p) => {
    const rec = p.recurrence ? `${p.recurrence.days.join(',')}/${p.recurrence.startMin}/${p.recurrence.endMin}` : '-';
    return `${p.id}|${p.name}|${p.allowSites.join(',')}|${p.allowApps.join(',')}|${p.defaultMinutes}|${rec}`;
  });
  const marks = Object.keys(f.packMarks ?? {}).sort().map((k) => `${k}=${f.packMarks![k]}`);
  const log = f.log.map((e) => `${e.packId}/${e.packName}/${e.startedAt}/${e.endedAt}/${e.plannedEndsAt}`
    + `/${e.stopped ? 1 : 0}/${e.window ? 1 : 0}`);
  const run = f.run ? `${f.run.packId}/${f.run.startedAt}/${f.run.endsAt}` : '-';
  const lock = f.lockdown ? `${f.lockdown.startedAt}/${f.lockdown.until}` : '-';
  const windows = (f.lockdownWindows ?? []).map((w) => `${w.id}:${w.days.join(',')}/${w.startMin}/${w.endMin}`);
  const partner = f.partner ? `${f.partner.name}|${f.partner.salt}|${f.partner.hash}|${f.partner.setAt}` : '-';
  const co = (f.partnerCo ?? []).map((p) => `${p.name}|${p.salt}|${p.hash}|${p.setAt}`).join(';');
  const gone = (f.partnersGone ?? []).map((g) => `${g.id}@${g.at}`).join(';');
  return `packs=[${packs.join(';')}] marks=[${marks.join(',')}] log=[${log.join(';')}]`
    + ` rev=${f.rev} at=${f.updatedAt} by=${f.updatedBy}`
    + ` run=${run} lock=${lock} windows=[${windows.join(';')}] wmark=${f.lockdownWindowsRev ?? 0}`
    + ` wm=[${windowMarksKey(f.lockdownWindowMarks)}]`
    + ` kw=[${(f.keywords ?? []).join(',')}] kmark=${f.keywordsRev ?? 0} kwm=[${keywordMarksKey(f.keywordMarks)}]`
    + ` partner=${partner} pmark=${f.partnerRev ?? 0} co=[${co}] gone=[${gone}]`
    + ` hide=${f.hideSiteList ? 1 : 0} hmark=${f.hideSiteListRev ?? 0}`;
}

// ------------------------------------------------------------------ esetek

function shuffled<T>(r: () => number, xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function siteCases(): unknown[][] {
  const out: unknown[][] = [];
  // Minden rossz elem külön, egy jó mellett — hogy a hiba neve látsszon.
  for (const x of [...SITE_TOLERATED, ...SITE_DROPPED]) out.push([SITE_GOOD[0], x]);
  out.push([...SITE_GOOD, ...SITE_TOLERATED, ...SITE_DROPPED]);
  for (let seed = 1; seed <= 30; seed++) {
    const r = rng(7000 + seed);
    for (let i = 0; i < 4; i++) r();
    const pool = [...SITE_GOOD, ...SITE_TOLERATED, ...SITE_DROPPED];
    out.push(shuffled(r, pool).slice(0, 2 + Math.floor(r() * 8)));
  }
  return out;
}

function focusCases(): unknown[] {
  const out: unknown[] = [];
  const blob = (packs: unknown[], log: unknown[], marks: Record<string, unknown>) => ({
    packs, run: null, log, rev: 5, updatedAt: 10, updatedBy: 'gep', packMarks: marks,
  });
  const allMarks = Object.fromEntries(MARK_IDS.map((id) => [id, 1]));
  for (const p of [...PACK_TOLERATED, ...PACK_DROPPED]) out.push(blob([PACK_GOOD[0], p], [LOG_GOOD[0]], allMarks));
  for (const e of [...LOG_TOLERATED, ...LOG_DROPPED]) out.push(blob([PACK_GOOD[0]], [LOG_GOOD[0], e], {}));
  out.push(blob([...PACK_GOOD, ...PACK_TOLERATED, ...PACK_DROPPED], [...LOG_GOOD, ...LOG_TOLERATED, ...LOG_DROPPED], allMarks));
  for (const v of FIELD_VARIANTS) {
    out.push({ packs: [PACK_GOOD[0]], log: [], rev: 5, updatedAt: 10, updatedBy: 'gep', ...v });
  }
  // A csomag- és a naplólista maga sem lista: üres, nem hiba.
  out.push({ packs: 'x', log: {}, rev: 1, updatedAt: 1, updatedBy: 'gep' });
  // A jelek értékenként tűrnek: a rossz érték csak magát viszi, nem az összeset.
  out.push(blob([...PACK_GOOD], [], { p1: '1', p2: 1.5, gone: 2, t1: true, x9: 0, x8: -1, x7: 6, '': 1 }));
  // A blob mezői is: a szövegként írt rev, a rossz futás nem viszi a csomagokat.
  out.push({ packs: [PACK_GOOD[0]], run: 'x', log: [LOG_GOOD[0]], rev: '5', updatedAt: 'x', updatedBy: 5, packMarks: { p1: 1 } });
  for (let seed = 1; seed <= 30; seed++) {
    const r = rng(8000 + seed);
    for (let i = 0; i < 4; i++) r();
    const packs = shuffled(r, [...PACK_GOOD, ...PACK_TOLERATED, ...PACK_DROPPED]).slice(0, 1 + Math.floor(r() * 8));
    const log = shuffled(r, [...LOG_GOOD, ...LOG_TOLERATED, ...LOG_DROPPED]).slice(0, Math.floor(r() * 8));
    const marks: Record<string, number> = {};
    for (const id of MARK_IDS) if (r() < 0.5) marks[id] = 1 + Math.floor(r() * 5);
    out.push(blob(packs, log, marks));
  }
  return out;
}

// -------------------------------------------------------- statisztika

/**
 * Egy MÁSIK eszköz mérése a dróton: napok, kulcsonként másodpercek, címkék, a
 * kapcsoló. Csak az egyesítés (`combineUsage`) eredménye számít — a három mag
 * a sajátjával egyesít. A szabály: csak szöveg a nap és a címke, csak
 * objektum a másodpercek, csak pozitív JSON-szám a másodperc (az igaz nem
 * egy), és a kapcsoló csak a valódi `true`-ra igaz.
 */
const USAGE_DAYS: unknown[] = [
  { day: '2026-09-07', seconds: { 'youtube.com': 600, 'reddit.com': 120 } },
  { day: '2026-09-08', seconds: { 'youtube.com': '600', 'a.com': true, 'b.com': 30, 'c.com': -5, 'd.com': null, 'e.com': [5] } },
  { day: '2026-09-09', seconds: 'x' },
  { day: '2026-09-10', seconds: [5] },
  { day: 5, seconds: { 'youtube.com': 60 } },
  { seconds: { 'youtube.com': 60 } },
  null, 'x', 5,
  { day: '2026-09-07', seconds: { 'youtube.com': 60 } },
  { day: '2026-09-11', seconds: {} },
];
const USAGE_LABELS: unknown[] = [
  { 'youtube.com': 'YouTube', 'reddit.com': 5, 'b.com': '', 'zz.com': 'Sosem mért' },
  'x',
  null,
];
const USAGE_ENABLED: unknown[] = [true, false, 'true', 1, null, undefined];

function usageCases(): unknown[] {
  const out: unknown[] = [];
  for (const d of USAGE_DAYS) out.push({ days: [USAGE_DAYS[0], d], labels: USAGE_LABELS[0], enabled: true });
  for (const l of USAGE_LABELS) out.push({ days: [USAGE_DAYS[0]], labels: l, enabled: true });
  for (const e of USAGE_ENABLED) out.push({ days: [USAGE_DAYS[0]], labels: {}, ...(e === undefined ? {} : { enabled: e }) });
  out.push({ days: USAGE_DAYS, labels: USAGE_LABELS[0], enabled: true });
  out.push({ days: 'x', labels: {}, enabled: true });
  return out;
}

function buildFixture(): Fixture {
  return {
    note: 'Generálja és őrzi: desktop/test/wire-fixture.test.ts (UPDATE_WIRE_FIXTURE=1 npm test). '
      + 'Az in egy dróton jött JSON-szöveg (oldal-lista vagy munkamenet-dokumentum), az out a gép olvasójának '
      + 'eredménye kulcsként; a Kotlin WireFixtureTest és a Swift WireFixtureTests a saját olvasójával '
      + 'ugyanezt kell kapja. Egy rossz elem nem viheti a többit.',
    version: 3,
    sites: siteCases().map((arr) => {
      const text = JSON.stringify(arr);
      return { in: text, out: normalizeIncomingSites(JSON.parse(text)).map(siteKey).join('\n') };
    }),
    focus: focusCases().map((b) => {
      const text = JSON.stringify(b);
      return { in: text, out: focusKey(normalizeSyncFocus(JSON.parse(text), 'gep')) };
    }),
    usage: usageCases().map((u) => {
      const text = JSON.stringify(u);
      return { in: text, out: usageConformanceKey(combineUsage([JSON.parse(text) as UsageState])) };
    }),
  };
}

/** JSON-szöveg csupa ASCII-ban: a 0x7f fölötti egységek `\uXXXX` alakban. */
function ascii(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function render(f: Fixture): string {
  const row = (c: WireCase) => `  {"in":${ascii(c.in)},"out":${ascii(c.out)}}`;
  return `{\n "note": ${ascii(f.note)},\n "version": ${f.version},\n`
    + ` "sites": [\n${f.sites.map(row).join(',\n')}\n ],\n`
    + ` "focus": [\n${f.focus.map(row).join(',\n')}\n ],\n`
    + ` "usage": [\n${f.usage.map(row).join(',\n')}\n ]\n}\n`;
}

test('a dróton jött rekordok fixtúrája friss, és egy rossz elem nem viszi a többit', () => {
  const built = buildFixture();
  // Nem elfajult: minden jó oldal és csomag megmarad az egyben-esetben, és a
  // kiesett csomag jele tényleg kiesik, a sírkő (sosem látott csomag) marad.
  const all = built.sites[SITE_TOLERATED.length + SITE_DROPPED.length].out.split('\n');
  assert.equal(all.length, SITE_GOOD.length + SITE_TOLERATED.length);
  const allFocus = built.focus[PACK_TOLERATED.length + PACK_DROPPED.length + LOG_TOLERATED.length + LOG_DROPPED.length].out;
  for (const id of ['p1', 'p2', 't1', 't12']) assert.ok(allFocus.includes(`${id}|`), id);
  assert.ok(/marks=\[[^\]]*gone=1/.test(allFocus), 'a sírkő jele marad');
  assert.ok(!/marks=\[[^\]]*x1=/.test(allFocus), 'a kiesett, de látott csomag jele kiesik');
  assert.ok(allFocus.includes('l1/Ismeretlen csomag/0/5000/5000/0/0'), 'a hiányzó mezők alapértéket kapnak');

  const text = render(built);
  if (process.env.UPDATE_WIRE_FIXTURE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, text);
  }
  assert.ok(fs.existsSync(FIXTURE), `nincs fixture: ${FIXTURE} — UPDATE_WIRE_FIXTURE=1 npm test`);
  const onDisk = fs.readFileSync(FIXTURE, 'utf8');
  assert.equal(
    onDisk, text,
    'a fixtures/wire-cases.json elavult a gép olvasójához képest — UPDATE_WIRE_FIXTURE=1 npm test, '
      + 'aztán a Kotlin (WireFixtureTest) és a Swift (WireFixtureTests) teszt mutatja meg, hol csúszott el a tükör',
  );
  assert.ok(/^[\x00-\x7f]*$/.test(onDisk), 'a fixtúra nem csupa ASCII');
});
