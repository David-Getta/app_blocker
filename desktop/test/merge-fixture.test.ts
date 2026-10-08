// Megfelelőségi fixture: a három nyelv UGYANAZT fésüli össze ugyanabból.
//
// A fuzz-tesztek nyelvenként azt nézik, hogy a saját szabályaik sorrendtől
// függetlenek. Ez a fájl azt, hogy a Kotlin- és a Swift-tükör ugyanazt az
// eredményt adja, mint a gép: a `fixtures/merge-cases.json` a gép által
// kiszámolt bemeneteket és eredmény-kulcsokat tartja, a Kotlin
// (MergeFixtureTest) és a Swift (MergeFixtureTests) teszt ugyanezt a fájlt
// olvassa, a saját összefésülésével számol, és a kulcsot hasonlítja.
//
// A fixture-t EZ a teszt írja, és ez őrzi: ha a szabály itt változik, a fájl
// elavul, és a teszt megmondja, hogyan kell frissíteni. Ha a fájl frissül, a
// másik két nyelv tesztje mutatja meg, hol csúszott el a tükör.
//
//   UPDATE_MERGE_FIXTURE=1 npm test     — a fájl újraírása

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergeSite } from '../src/shared/sync/merge';
import { mergeFocus, normalizeSyncFocus, sameFocus, type SyncFocus } from '../src/shared/sync/focus-merge';
import { combineUsage } from '../src/shared/usage';
import { closesAfterPause, isBlockedNowWithLimit } from '../src/shared/limits';
import {
  isBlockedBySchedule, isLoosening, isValidBand, nextCloseAt, nextOpenAt, type Schedule,
} from '../src/shared/schedule';
import {
  dueLockdownWindow, isWindowLockdown, isWindowsLoosening, weekHasFreeTime, windowLockdown, windowStartingSoon,
  type Lockdown, type LockdownWindow,
} from '../src/shared/lockdown';
import {
  FUTURE_LOG_TOLERANCE_MS, focusByHour, focusByWeekday, focusDaySeries, focusDayStreak, focusLongestStreak,
  nextOccurrence, summarizeFocus, summarizeFocusPrevWeek, windowRunsByPack, type FocusSummary, type Occurrence,
} from '../src/shared/focus';
import { noteBurstUsage, type BurstState } from '../src/shared/burst';
import {
  DECISION_NOW, DEVICES, FOCUS_MERGE_NOW, SCHEDULE_WEEK_START, flipFocus, focusScenarios, flipSite, focusConformanceKey, randomBurstRun, randomDecision,
  randomFocus, randomFocusLogCase, randomScheduleCase, randomSite, randomUsage, randomVerdict, randomWindowsCase,
  referenceVerdict, rng, siteConformanceKey, usageConformanceKey, usageSummaryParts, type FocusLogCase, type WindowsCase,
} from './merge-random';

// A döntés napkulcsa helyi időben számolódik; a fixtúra UTC-ben készül, és a
// CI mindhárom futtatója UTC-ben jár. Itt kimondjuk, hogy egy más időzónás
// gépen újragenerált fájl se térjen el (dél UTC: a nap ettől még ugyanaz).
process.env.TZ = 'UTC';

/** dist-test/test/… → a tároló gyökere. */
const FIXTURE = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'merge-cases.json');
const SEEDS = 80;

interface Fixture {
  note: string; version: number; sites: unknown[]; focus: unknown[]; usage: unknown[]; decisions: unknown[];
  bursts: unknown[]; verdicts: unknown[]; schedules: unknown[]; windows: unknown[]; focusLogs: unknown[];
}

const summaryKey = (s: FocusSummary) => `${s.sessions}/${s.totalMs}/${s.stoppedEarly}/${s.windowRuns}/${s.topPack ?? '-'}`;

/** Minden, amit a három magnak egy naplóról ugyanúgy kell mondania. */
function focusLogAnswers(c: FocusLogCase) {
  const weekAgo = c.now - 7 * 86_400_000;
  const runs = windowRunsByPack(c.log, weekAgo, c.now);
  return {
    week: summaryKey(summarizeFocus(c.log, weekAgo, c.now)),
    prev: summaryKey(summarizeFocusPrevWeek(c.log, c.now)),
    byWeekday: focusByWeekday(c.log, c.now).join(','),
    byHour: focusByHour(c.log, c.now).join(','),
    streak: focusDayStreak(c.log, c.now),
    longest: focusLongestStreak(c.log, c.now),
    runs: Object.keys(runs).sort().map((k) => `${k}=${runs[k]}`).join(','),
    series: focusDaySeries(c.log, c.now, 7).map((d) => `${d.day}:${d.seconds}`).join(','),
  };
}

/** Perc a hét kezdetétől (hétfő 00:00 UTC) epoch ms-ben, másodperc-eltolással. */
const atWeek = (day: number, hour: number, minute: number, second = 0) =>
  SCHEDULE_WEEK_START + ((day * 24 + hour) * 60 + minute) * 60_000 + second * 1000;
const WORK: Schedule = { mode: 'scheduled_block', bands: [{ days: [1, 2, 3, 4, 5], startMin: 540, endMin: 1020 }] };
const NIGHT: Schedule = { mode: 'scheduled_block', bands: [{ days: [1], startMin: 1320, endMin: 360 }] };
const OPEN_WEEKEND: Schedule = { mode: 'scheduled_allow', bands: [{ days: [0, 6], startMin: 0, endMin: 1440 }] };
const ALWAYS_WITH_BANDS: Schedule = { mode: 'always', bands: [{ days: [1], startMin: 0, endMin: 1440 }] };
const ALL_BROKEN: Schedule = { mode: 'scheduled_allow', bands: [{ days: [], startMin: 0, endMin: 1440 }, { days: [1], startMin: 1440, endMin: 60 }] };
/** Egész héten szabad: sosem zár — a „zár … múlva” sor itt hallgat (nextClose = 0). */
const OPEN_ALL_WEEK: Schedule = { mode: 'scheduled_allow', bands: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }] };
/**
 * Kézzel válogatott élek: a sávhatár perce (a percen belül másodpercekkel), az
 * éjfélen átnyúló sáv két napja, a nyitó mód, a sávos „mindig”, a csupa rossz
 * sáv. A hét 2026-09-28-tól (hétfő) indul; a nap itt 0 = hétfő a hét elejétől.
 */
const W_WORK: LockdownWindow = { id: 'work', days: [1, 2, 3, 4, 5], startMin: 540, endMin: 1020 };
const W_NIGHT: LockdownWindow = { id: 'night', days: [1], startMin: 1320, endMin: 360 };
const W_ALL: LockdownWindow = { id: 'all', days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 };
/**
 * Kézzel válogatott ablak-élek: a közelgő ablak kerete (tíz perc; egy másodperc
 * fölötte már nem), az élő ablak, a futó zárlat, ami túlér rajta (nincs mit
 * kérni) és ami nem (kitolódik, a kezdése marad), az éjfélen átnyúló ablak
 * másnap hajnalban, két ablak egyszerre, a szabad idő nélküli hét, az üres
 * lista, és az ablak végén véget érő kézi zárlat (ablak-zárlat).
 */
const CURATED_WINDOWS: WindowsCase[] = [
  { windows: [W_WORK], next: [W_WORK], cur: null, now: atWeek(0, 8, 55, 0), within: 600_000 },
  { windows: [W_WORK], next: [], cur: null, now: atWeek(0, 8, 49, 59), within: 600_000 },
  { windows: [W_WORK], next: [W_NIGHT], cur: null, now: atWeek(0, 12, 0, 0), within: 600_000 },
  { windows: [W_WORK], next: [W_WORK], cur: { startedAt: atWeek(0, 7, 0), until: atWeek(0, 18, 0) }, now: atWeek(0, 12, 0), within: 600_000 },
  { windows: [W_WORK], next: [W_WORK], cur: { startedAt: atWeek(0, 7, 0), until: atWeek(0, 10, 0) }, now: atWeek(0, 9, 30), within: 600_000 },
  { windows: [W_NIGHT], next: [W_NIGHT], cur: null, now: atWeek(1, 2, 0, 0), within: 600_000 },
  { windows: [W_NIGHT, W_WORK], next: [W_WORK], cur: null, now: atWeek(1, 5, 59, 59), within: 6 * 3_600_000 },
  { windows: [W_ALL], next: [W_WORK], cur: null, now: atWeek(3, 12, 0), within: 600_000 },
  { windows: [], next: [W_WORK], cur: null, now: atWeek(3, 12, 0), within: 600_000 },
  { windows: [W_WORK], next: [], cur: { startedAt: atWeek(0, 7, 0), until: atWeek(0, 17, 0) }, now: atWeek(0, 16, 59, 59), within: 600_000 },
  { windows: [W_WORK], next: [W_WORK], cur: { startedAt: atWeek(0, 7, 0), until: atWeek(0, 17, 0) }, now: atWeek(0, 17, 0, 0), within: 600_000 },
  { windows: [W_WORK], next: [W_WORK], cur: null, now: atWeek(5, 8, 55, 0), within: 6 * 3_600_000 },
];

const occKey = (o: Occurrence | null) => (o ? `${o.startsAt}/${o.endsAt}` : null);
const lockKey = (l: Lockdown | null) => (l ? `${l.startedAt}/${l.until}` : null);

/** Minden, amit a három magnak egy ablak-esetről ugyanúgy kell mondania. */
function windowsAnswers(c: WindowsCase) {
  const lockOut = windowLockdown(c.cur, c.windows, c.now);
  const probe = lockOut ?? c.cur;
  const first = c.windows[0];
  return {
    free: weekHasFreeTime(c.windows, c.now),
    loosening: isWindowsLoosening(c.windows, c.next, c.now),
    due: occKey(dueLockdownWindow(c.windows, c.now)),
    lock: lockKey(lockOut),
    isWin: probe ? isWindowLockdown(probe, c.windows) : null,
    soon: occKey(windowStartingSoon(c.cur, c.windows, c.now, c.within)),
    // `nextOcc`, nem `next`: a `next` az eset ablak-listája (a csere célja).
    nextOcc: first && isValidBand(first) ? occKey(nextOccurrence(first, c.now)) : null,
  };
}

const CURATED_SCHEDULES: Array<{ schedule: Schedule; other: Schedule; now: number }> = [
  { schedule: WORK, other: OPEN_WEEKEND, now: atWeek(0, 8, 59, 59) },
  { schedule: WORK, other: OPEN_WEEKEND, now: atWeek(0, 9, 0, 0) },
  { schedule: WORK, other: WORK, now: atWeek(0, 16, 59, 59) },
  { schedule: WORK, other: NIGHT, now: atWeek(0, 17, 0, 0) },
  { schedule: WORK, other: WORK, now: atWeek(5, 12, 0, 0) },
  { schedule: NIGHT, other: WORK, now: atWeek(0, 21, 59, 0) },
  { schedule: NIGHT, other: NIGHT, now: atWeek(0, 22, 0, 0) },
  { schedule: NIGHT, other: NIGHT, now: atWeek(1, 0, 0, 0) },
  { schedule: NIGHT, other: NIGHT, now: atWeek(1, 5, 59, 59) },
  { schedule: NIGHT, other: OPEN_WEEKEND, now: atWeek(1, 6, 0, 0) },
  { schedule: NIGHT, other: NIGHT, now: atWeek(2, 1, 0, 0) },
  { schedule: OPEN_WEEKEND, other: WORK, now: atWeek(5, 23, 59, 59) },
  { schedule: OPEN_WEEKEND, other: WORK, now: atWeek(6, 0, 0, 0) },
  { schedule: ALWAYS_WITH_BANDS, other: WORK, now: atWeek(0, 12, 0, 0) },
  { schedule: ALL_BROKEN, other: OPEN_WEEKEND, now: atWeek(6, 12, 0, 0) },
  { schedule: WORK, other: ALL_BROKEN, now: atWeek(3, 10, 0, 0) },
  // A váltás élei: sosem zár; szombat délben zár (hétfő 0:00-kor nyit) a hétvégi
  // tiltás; az éjfélen átnyúló sáv vége a következő napon.
  { schedule: OPEN_ALL_WEEK, other: WORK, now: atWeek(2, 12, 0, 0) },
  { schedule: { mode: 'scheduled_block', bands: [{ days: [0, 6], startMin: 0, endMin: 1440 }] }, other: WORK, now: atWeek(5, 12, 30, 15) },
  { schedule: NIGHT, other: WORK, now: atWeek(1, 3, 15, 0) },
];

function buildFixture(): Fixture {
  const sites: unknown[] = [];
  const focus: unknown[] = [];
  const usage: unknown[] = [];
  const decisions: unknown[] = [];
  const bursts: unknown[] = [];
  const verdicts: unknown[] = [];
  const schedules: unknown[] = [];
  const windows: unknown[] = [];
  const focusLogs: unknown[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const [a, b, c] = DEVICES.map((d) => randomSite(r, d));
    const ab = mergeSite(a, b);
    // KÖZELI REKORDOK: az `a` és egy egy mezőben más párja, mindkét sorrendben.
    // A szigorúság-lánc és a döntetlen-törés éles esetei; a két sorrendnek
    // ugyanoda kell jutnia (a fésülés szimmetrikus), és a három nyelvnek is.
    const { flip, what } = flipSite(r, a);
    const af = siteConformanceKey(mergeSite(a, flip));
    const fa = siteConformanceKey(mergeSite(flip, a));
    assert.equal(af, fa, `a közeli rekordok fésülése nem szimmetrikus: mag ${seed}, ${what}`);
    sites.push({
      seed, a, b, c, ab: siteConformanceKey(ab), abc: siteConformanceKey(mergeSite(ab, c)), flip, what, af, fa,
    });
  }
  // A menet új szabályainak minden ága legyen benne (különben a tükrök egy
  // ágat sosem bizonyítanak): sírkő leállít, rövidítés nyer a hosszabb felett,
  // jövőbeli sor nem számít, eltolt menet.
  const seen = { killed: false, cutWins: false, future: false, origin: false };
  const note = (a: SyncFocus, b: SyncFocus, ab: SyncFocus): void => {
    if ((a.run || b.run) && !ab.run) seen.killed = true;
    if (a.run && b.run && a.run.packId === b.run.packId && a.run.startedAt === b.run.startedAt
      && (a.run.cuts ?? 0) !== (b.run.cuts ?? 0) && ab.run && ab.run.endsAt < Math.max(a.run.endsAt, b.run.endsAt)) {
      seen.cutWins = true;
    }
    if (ab.run && ab.log.some((e) => e.endedAt > FOCUS_MERGE_NOW + FUTURE_LOG_TOLERANCE_MS && e.packId === ab.run!.packId)) {
      seen.future = true;
    }
    if (ab.run?.origin !== undefined) seen.origin = true;
  };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const [a, b, c] = DEVICES.map((d) => randomFocus(r, d));
    // A „MOST” is az eset része: a jövőben véget ért naplósor nem zár le
    // menetet, és ehhez a fésülésnek tudnia kell, mikor van most.
    const now = FOCUS_MERGE_NOW;
    const ab = mergeFocus(a, b, now);
    // EGY MEZŐ CSERÉJE: a három nyelvnek ugyanazt kell KÜLÖNBSÉGNEK tartania
    // (`sameFocus` / `FocusSync.same`), és ami nem jelentés, azt nem. A várt
    // érték a fajtából jön; itt azt is ellenőrizzük, hogy a csere tényleg az,
    // aminek szántuk — egy hatástalan csere néma lyuk volna a fixtúrában.
    const { flip, what, same } = flipFocus(r, a);
    const observed = sameFocus(normalizeSyncFocus(a, 'x'), normalizeSyncFocus(flip, 'x'));
    assert.equal(observed, same, `a csere nem az, aminek szántuk: mag ${seed}, ${what}`);
    focus.push({
      seed, now, a, b, c, ab: focusConformanceKey(ab), abc: focusConformanceKey(mergeFocus(ab, c, now)), flip, what, same,
    });
    note(a, b, ab);
  }
  // KÉZZEL ÍRT ESETEK a menet minden ágára — ugyanúgy a három nyelvnek.
  focusScenarios().forEach((sc, i) => {
    const now = FOCUS_MERGE_NOW;
    const ab = mergeFocus(sc.a, sc.b, now);
    const { flip, what, same } = flipFocus(rng(10_000 + i), sc.a);
    const observed = sameFocus(normalizeSyncFocus(sc.a, 'x'), normalizeSyncFocus(flip, 'x'));
    assert.equal(observed, same, `a csere nem az, aminek szántuk: ${sc.name}, ${what}`);
    focus.push({
      seed: -(i + 1), scenario: sc.name, now, a: sc.a, b: sc.b, c: sc.c,
      ab: focusConformanceKey(ab), abc: focusConformanceKey(mergeFocus(ab, sc.c, now)), flip, what, same,
    });
    note(sc.a, sc.b, ab);
  });
  for (const [k, v] of Object.entries(seen)) assert.ok(v, `a menet-ág hiányzik a fixtúrából: ${k} — a fixtúra elfajult`);
  // A HASZNÁLATI STATISZTIKA egyesítése: három eszköz mérése — napok, célok,
  // címkék (a több időt mérő eszközé), kapcsoló (ha bármelyik mér, az összeg
  // valódi). Nem fésülés, hanem összeadás — de a három nyelvnek itt is bájtra
  // ugyanazt kell adnia, a napok sorrendjével együtt.
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const [a, b, c] = DEVICES.map((d) => randomUsage(r, d));
    const combined = combineUsage([a, b, c]);
    // AZ ÖSSZEGZŐ az egyesített mérésen, a döntés időpontjában (dél UTC, a
    // mérés utolsó napja): ma, tegnap, hét, hónap, toplisták, a hét az előző
    // héthez — a statisztika képernyőjének számai, amiknek a három magon
    // ugyanannak kell lenniük. Holtversenyben a kulcs dönt, mindhárom magban.
    usage.push({ seed, a, b, c, abc: usageConformanceKey(combined), now: DECISION_NOW, summary: usageSummaryParts(combined, DECISION_NOW) });
  }
  const sums = usage as Array<{ summary: { wow: string; topToday: string } }>;
  assert.ok(sums.some((u) => /\/\d+,|\/\d+$/.test(u.summary.wow)), 'egy trendnek sincs előző hete — a fixtúra elfajult');
  assert.ok(sums.some((u) => u.summary.topToday.includes(',')), 'a mai toplista mindig egyetlen sor — a fixtúra elfajult');
  // A DÖNTÉS: tilt-e most — szünet, törlésre várás, közös napi keret. Ez az,
  // amiért az egész szinkron van: ugyanaz a bemenet, ugyanaz a döntés
  // mindhárom nyelven. A menetrend kimarad (helyi idő), lásd randomDecision.
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const { site, usage: u, shared } = randomDecision(r);
    const blocked = isBlockedNowWithLimit(site, u, DECISION_NOW, shared);
    // ZÁRUL-E A SZÜNET VÉGÉN: ugyanaz a döntés a szünet végének pillanatában,
    // a szünetet nem számítva — a szünet vége előtti szó ebből tudja, hogy
    // mondhatja-e: „újra zárva”. Szünet nélkül nincs kérdés (null).
    const afterPause = site.pauseUntil === null ? null : closesAfterPause(site, u, shared);
    decisions.push({ seed, now: DECISION_NOW, site, usage: u, shared, blocked, afterPause });
  }
  const dec = decisions as Array<{ afterPause: boolean | null; blocked: boolean; site: { pauseUntil: number | null } }>;
  assert.ok(dec.some((d) => d.afterPause === true) && dec.some((d) => d.afterPause === false),
    'a szünet vége mindig ugyanazt mondja — a fixtúra elfajult');
  assert.ok(dec.some((d) => d.afterPause === false && (d.site.pauseUntil ?? 0) > DECISION_NOW + 24 * 3_600_000),
    'nincs éjfélen átnyúló szünet, ami után a keret nyitva hagyja — a fixtúra elfajult');
  // AZ ADAG-SZÁMLÁLÓ: egy szabály, nyolc minta, és a számláló állapota minden
  // minta után. A gép és az Android tükre (az iPhone nem mér, ott nincs mit
  // tükrözni — kimondva). Lépésenként rögzítve, hogy egy eltérés a helyén
  // látszódjon, ne csak a végén.
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const { rule, samples } = randomBurstRun(r);
    const states: string[] = [];
    let st: BurstState | undefined;
    for (const sm of samples) {
      st = noteBurstUsage(rule, st, sm.seconds, sm.at);
      states.push(`${st.usedSeconds}/${st.lastAt}/${st.cooldownUntil}`);
    }
    bursts.push({ seed, rule, samples, states });
  }
  // A MUNKAMENET-DÖNTÉS: mi mehet egy menet alatt — a két telefon DNS-motora
  // (`Focus.verdict`) ugyanazt dönti, a gép közös darabjaiból írt referencia
  // szerint. A fehérlista lyuka a legdrágább hiba: egy név, ami az egyik
  // telefonon átmegy, a másikon nem, ugyanaz az app két szigorúsággal.
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const c = randomVerdict(r);
    verdicts.push({ seed, ...c, verdict: referenceVerdict(c) });
  }
  // A MENETREND: tilt-e most egy heti sávrendszer szerint, és lazítás-e a
  // csere egy másikra. Ez dönt a gépen és a telefonon EGYSZERRE ugyanarról az
  // oldalról; a sávok helyi időben értékelődnek ki, ezért UTC-ben (lásd fent).
  // Előbb a kézzel válogatott élek (a sávhatár perce, az éjfélen átnyúló sáv
  // két napja), aztán a véletlen esetek.
  // A KÖVETKEZŐ VÁLTÁS is: mikor nyit (nextOpen) és mikor zár (nextClose)
  // legközelebb — a sor ebből mondja, hogy „nyit/zár … múlva”, és a gép
  // ebből írja a zárás végét is (closedUntil). Ha a két telefon máskor
  // mondaná, ugyanaz az oldal három eszközön három időpontban nyílna.
  const decide = (c: { schedule: Schedule; other: Schedule; now: number }) => ({
    blocked: isBlockedBySchedule(c.schedule, c.now),
    loosening: isLoosening(c.schedule, c.other, c.now),
    nextOpen: nextOpenAt(c.schedule, c.now),
    nextClose: nextCloseAt(c.schedule, c.now),
  });
  CURATED_SCHEDULES.forEach((c, i) => {
    schedules.push({ seed: 1000 + i, ...c, ...decide(c) });
  });
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const c = randomScheduleCase(r);
    schedules.push({ seed, ...c, ...decide(c) });
  }
  // Nem elfajult: zár is, nyit is; lazítás is, nem is; a váltás jövőbeli is,
  // most-i is, soha-sem is.
  const sch = schedules as Array<{ blocked: boolean; loosening: boolean; now: number; nextOpen: number; nextClose: number }>;
  assert.ok(sch.some((c) => c.blocked) && sch.some((c) => !c.blocked), 'a menetrend-esetek egyfélék');
  assert.ok(sch.some((c) => c.loosening) && sch.some((c) => !c.loosening), 'a lazítás-esetek egyfélék');
  assert.ok(sch.some((c) => c.nextOpen > c.now) && sch.some((c) => c.nextClose > c.now), 'nincs jövőbeli váltás');
  assert.ok(sch.some((c) => c.nextOpen === 0) && sch.some((c) => c.nextClose === 0), 'nincs soha nem nyíló vagy soha nem záró menetrend');
  // A ZÁRLAT-ABLAKOK: marad-e szabad idő, lazítás-e a csere, az élő ablak, a
  // megkövetelt zárlat (futó zárlat mellett és nélkül), ablak-zárlat-e, a
  // közelgő ablak, a következő előfordulás — UTC-ben, mint a menetrend. A
  // heti ablak minden eszközön ugyanakkor zár és ugyanakkor enged.
  CURATED_WINDOWS.forEach((c, i) => windows.push({ seed: 1000 + i, ...c, ...windowsAnswers(c) }));
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const c = randomWindowsCase(r);
    windows.push({ seed, ...c, ...windowsAnswers(c) });
  }
  const win = windows as Array<ReturnType<typeof windowsAnswers>>;
  for (const key of ['due', 'lock', 'soon', 'nextOcc'] as const) {
    assert.ok(win.some((c) => c[key] !== null) && win.some((c) => c[key] === null), `az ablak-esetek egyfélék: ${key}`);
  }
  assert.ok(win.some((c) => c.isWin === true) && win.some((c) => c.isWin === false), 'az ablak-zárlat-esetek egyfélék');
  // A MENETEK ÖSSZEGZÉSE a naplóból: a hét és az előző hét, a menet-nap, a
  // menet-óra, a sorozat és a leghosszabb sorozat, az ablakból indult menetek
  // csomagonként, a napi rajz — a statisztika és a heti mondat számai; UTC-ben.
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const c = randomFocusLogCase(r);
    focusLogs.push({ seed, ...c, ...focusLogAnswers(c) });
  }
  const fl = focusLogs as Array<ReturnType<typeof focusLogAnswers>>;
  assert.ok(fl.some((c) => c.streak >= 2), 'egy sorozat sincs — a fixtúra elfajult');
  assert.ok(fl.some((c) => c.runs !== ''), 'ablakból indult menet sincs — a fixtúra elfajult');
  assert.ok(fl.some((c) => !c.prev.startsWith('0/')), 'előző heti menet sincs — a fixtúra elfajult');
  assert.ok(fl.some((c) => !c.week.endsWith('/-')) && fl.some((c) => c.week.startsWith('0/')), 'a heti összegzők egyfélék');
  return {
    note: 'Generálja és őrzi: desktop/test/merge-fixture.test.ts (UPDATE_MERGE_FIXTURE=1 npm test). '
      + 'Olvassa: android/jvm-tests MergeFixtureTest, ios/SharedTests MergeFixtureTests. '
      + 'A focus-esetek flip/what/same mezője: egy mező cseréje, és hogy a három nyelv különbségnek tartja-e; '
      + 'a now mezője a fésülés időpontja (a jövőben véget ért naplósor nem zár le menetet). '
      + 'A sites-esetek flip/what/af/fa mezője: egy mező cseréje, és a fésülés mindkét sorrendben. '
      + 'A usage-esetek: három eszköz mérése, az egyesítés kulcsa, és az összegző (summary) a now időpontban: ma, tegnap, hét, hónap, '
      + 'toplisták (kulcs=címke=mp, holtversenyben a kulcs dönt), a hét az előző héthez (ez/múlt/századszázalék), napok. '
      + 'A decisions-esetek: oldal, helyi mérés, a többi eszköz mai összegzése, időpont — és hogy tilt-e most, '
      + 'meg hogy a szünet végén zárul-e (afterPause; szünet nélkül null). '
      + 'A bursts-esetek (gép és Android): adag-szabály, minták, és a számláló állapota minden minta után. '
      + 'A verdicts-esetek (a két telefon): név, lista, kulcsszavak, menet, csomag, saját kiszolgáló — és a döntés. '
      + 'A schedules-esetek: menetrend, egy másik menetrend, időpont (UTC-ben értékelve) — tilt-e most, lazítás-e a csere, '
      + 'és a következő nyitás és zárás (nextOpen/nextClose: epoch ms; now, ha már most annyi; 0, ha nyolc napon belül sincs). '
      + 'A windows-esetek: zárlat-ablakok, a csere célja, futó zárlat, időpont, a közelgő ablak kerete (UTC-ben) — szabad idő, '
      + 'lazítás, élő ablak, megkövetelt zárlat, ablak-zárlat-e, közelgő ablak, a következő előfordulás (nextOcc). '
      + 'A focusLogs-esetek: napló és időpont (UTC) — a hét és az előző hét összegzője (menet/ms/korai/ablakból/csúcs-csomag), '
      + 'menet-napok, menet-órák, sorozat, leghosszabb sorozat, ablakból indult menetek csomagonként, a napi rajz.',
    version: 20,
    sites,
    focus,
    usage,
    decisions,
    bursts,
    verdicts,
    schedules,
    windows,
    focusLogs,
  };
}

/** Esetenként egy sor: olvasható diff, mégis kompakt fájl. */
function render(f: Fixture): string {
  const rows = (items: unknown[]) => items.map((x) => ' ' + JSON.stringify(x)).join(',\n');
  return `{\n"note": ${JSON.stringify(f.note)},\n"version": ${f.version},\n`
    + `"sites": [\n${rows(f.sites)}\n],\n"focus": [\n${rows(f.focus)}\n],\n"usage": [\n${rows(f.usage)}\n],\n`
    + `"decisions": [\n${rows(f.decisions)}\n],\n"bursts": [\n${rows(f.bursts)}\n],\n`
    + `"verdicts": [\n${rows(f.verdicts)}\n],\n"schedules": [\n${rows(f.schedules)}\n],\n`
    + `"windows": [\n${rows(f.windows)}\n],\n"focusLogs": [\n${rows(f.focusLogs)}\n]\n}\n`;
}

test('a megfelelőségi fixture a gép szabályaival egyezik (a Kotlin és a Swift ebből dolgozik)', () => {
  const built = render(buildFixture());
  if (process.env.UPDATE_MERGE_FIXTURE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, built);
    return;
  }
  assert.ok(fs.existsSync(FIXTURE), `nincs fixture: ${FIXTURE} — UPDATE_MERGE_FIXTURE=1 npm test`);
  const onDisk = fs.readFileSync(FIXTURE, 'utf8');
  assert.equal(
    onDisk, built,
    'a fixtures/merge-cases.json elavult a gép szabályaihoz képest — UPDATE_MERGE_FIXTURE=1 npm test, '
    + 'aztán a Kotlin- és Swift-teszt mutatja meg, követi-e a tükör',
  );
});
