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
import { mergeFocus, normalizeSyncFocus, sameFocus } from '../src/shared/sync/focus-merge';
import { combineUsage } from '../src/shared/usage';
import { isBlockedNowWithLimit } from '../src/shared/limits';
import { isBlockedBySchedule, isLoosening, type Schedule } from '../src/shared/schedule';
import { noteBurstUsage, type BurstState } from '../src/shared/burst';
import {
  DECISION_NOW, DEVICES, SCHEDULE_WEEK_START, flipFocus, flipSite, focusConformanceKey, randomBurstRun, randomDecision,
  randomFocus, randomScheduleCase, randomSite, randomUsage, randomVerdict, referenceVerdict, rng, siteConformanceKey,
  usageConformanceKey,
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
  bursts: unknown[]; verdicts: unknown[]; schedules: unknown[];
}

/** Perc a hét kezdetétől (hétfő 00:00 UTC) epoch ms-ben, másodperc-eltolással. */
const atWeek = (day: number, hour: number, minute: number, second = 0) =>
  SCHEDULE_WEEK_START + ((day * 24 + hour) * 60 + minute) * 60_000 + second * 1000;
const WORK: Schedule = { mode: 'scheduled_block', bands: [{ days: [1, 2, 3, 4, 5], startMin: 540, endMin: 1020 }] };
const NIGHT: Schedule = { mode: 'scheduled_block', bands: [{ days: [1], startMin: 1320, endMin: 360 }] };
const OPEN_WEEKEND: Schedule = { mode: 'scheduled_allow', bands: [{ days: [0, 6], startMin: 0, endMin: 1440 }] };
const ALWAYS_WITH_BANDS: Schedule = { mode: 'always', bands: [{ days: [1], startMin: 0, endMin: 1440 }] };
const ALL_BROKEN: Schedule = { mode: 'scheduled_allow', bands: [{ days: [], startMin: 0, endMin: 1440 }, { days: [1], startMin: 1440, endMin: 60 }] };
/**
 * Kézzel válogatott élek: a sávhatár perce (a percen belül másodpercekkel), az
 * éjfélen átnyúló sáv két napja, a nyitó mód, a sávos „mindig”, a csupa rossz
 * sáv. A hét 2026-09-28-tól (hétfő) indul; a nap itt 0 = hétfő a hét elejétől.
 */
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
];

function buildFixture(): Fixture {
  const sites: unknown[] = [];
  const focus: unknown[] = [];
  const usage: unknown[] = [];
  const decisions: unknown[] = [];
  const bursts: unknown[] = [];
  const verdicts: unknown[] = [];
  const schedules: unknown[] = [];
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
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const [a, b, c] = DEVICES.map((d) => randomFocus(r, d));
    const ab = mergeFocus(a, b);
    // EGY MEZŐ CSERÉJE: a három nyelvnek ugyanazt kell KÜLÖNBSÉGNEK tartania
    // (`sameFocus` / `FocusSync.same`), és ami nem jelentés, azt nem. A várt
    // érték a fajtából jön; itt azt is ellenőrizzük, hogy a csere tényleg az,
    // aminek szántuk — egy hatástalan csere néma lyuk volna a fixtúrában.
    const { flip, what, same } = flipFocus(r, a);
    const observed = sameFocus(normalizeSyncFocus(a, 'x'), normalizeSyncFocus(flip, 'x'));
    assert.equal(observed, same, `a csere nem az, aminek szántuk: mag ${seed}, ${what}`);
    focus.push({
      seed, a, b, c, ab: focusConformanceKey(ab), abc: focusConformanceKey(mergeFocus(ab, c)), flip, what, same,
    });
  }
  // A HASZNÁLATI STATISZTIKA egyesítése: három eszköz mérése — napok, célok,
  // címkék (a több időt mérő eszközé), kapcsoló (ha bármelyik mér, az összeg
  // valódi). Nem fésülés, hanem összeadás — de a három nyelvnek itt is bájtra
  // ugyanazt kell adnia, a napok sorrendjével együtt.
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const [a, b, c] = DEVICES.map((d) => randomUsage(r, d));
    usage.push({ seed, a, b, c, abc: usageConformanceKey(combineUsage([a, b, c])) });
  }
  // A DÖNTÉS: tilt-e most — szünet, törlésre várás, közös napi keret. Ez az,
  // amiért az egész szinkron van: ugyanaz a bemenet, ugyanaz a döntés
  // mindhárom nyelven. A menetrend kimarad (helyi idő), lásd randomDecision.
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const { site, usage: u, shared } = randomDecision(r);
    const blocked = isBlockedNowWithLimit(site, u, DECISION_NOW, shared);
    decisions.push({ seed, now: DECISION_NOW, site, usage: u, shared, blocked });
  }
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
  CURATED_SCHEDULES.forEach((c, i) => {
    schedules.push({
      seed: 1000 + i, ...c, blocked: isBlockedBySchedule(c.schedule, c.now), loosening: isLoosening(c.schedule, c.other, c.now),
    });
  });
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const c = randomScheduleCase(r);
    schedules.push({ seed, ...c, blocked: isBlockedBySchedule(c.schedule, c.now), loosening: isLoosening(c.schedule, c.other, c.now) });
  }
  // Nem elfajult: zár is, nyit is; lazítás is, nem is.
  const sch = schedules as Array<{ blocked: boolean; loosening: boolean }>;
  assert.ok(sch.some((c) => c.blocked) && sch.some((c) => !c.blocked), 'a menetrend-esetek egyfélék');
  assert.ok(sch.some((c) => c.loosening) && sch.some((c) => !c.loosening), 'a lazítás-esetek egyfélék');
  return {
    note: 'Generálja és őrzi: desktop/test/merge-fixture.test.ts (UPDATE_MERGE_FIXTURE=1 npm test). '
      + 'Olvassa: android/jvm-tests MergeFixtureTest, ios/SharedTests MergeFixtureTests. '
      + 'A focus-esetek flip/what/same mezője: egy mező cseréje, és hogy a három nyelv különbségnek tartja-e. '
      + 'A sites-esetek flip/what/af/fa mezője: egy mező cseréje, és a fésülés mindkét sorrendben. '
      + 'A usage-esetek: három eszköz mérése és az egyesítés kulcsa. '
      + 'A decisions-esetek: oldal, helyi mérés, a többi eszköz mai összegzése, időpont — és hogy tilt-e most. '
      + 'A bursts-esetek (gép és Android): adag-szabály, minták, és a számláló állapota minden minta után. '
      + 'A verdicts-esetek (a két telefon): név, lista, kulcsszavak, menet, csomag, saját kiszolgáló — és a döntés. '
      + 'A schedules-esetek: menetrend, egy másik menetrend, időpont (UTC-ben értékelve) — tilt-e most, és lazítás-e a csere.',
    version: 12,
    sites,
    focus,
    usage,
    decisions,
    bursts,
    verdicts,
    schedules,
  };
}

/** Esetenként egy sor: olvasható diff, mégis kompakt fájl. */
function render(f: Fixture): string {
  const rows = (items: unknown[]) => items.map((x) => ' ' + JSON.stringify(x)).join(',\n');
  return `{\n"note": ${JSON.stringify(f.note)},\n"version": ${f.version},\n`
    + `"sites": [\n${rows(f.sites)}\n],\n"focus": [\n${rows(f.focus)}\n],\n"usage": [\n${rows(f.usage)}\n],\n`
    + `"decisions": [\n${rows(f.decisions)}\n],\n"bursts": [\n${rows(f.bursts)}\n],\n`
    + `"verdicts": [\n${rows(f.verdicts)}\n],\n"schedules": [\n${rows(f.schedules)}\n]\n}\n`;
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
