#!/usr/bin/env node
// A három mag (TypeScript, Kotlin, Swift) számbeli összhangjának ellenőrzése.
//
// Az architektúra alapja, hogy ugyanaz a szabályrendszer fut mindhárom
// platformon: a TS a referencia, a Kotlin és a Swift annak a tükre. Ezt eddig
// SEMMI nem őrizte. Egy nehézségi paraméter átírása a desktopon simán
// elcsúszhatott a másik kettőtől, és a felhasználó ugyanazt az appot kapta
// volna két különböző szigorúsággal — anélkül, hogy bárhol hibát látunk.
//
// Ez a szkript az értékeket a FORRÁSBÓL olvassa ki, nem másolja ide őket:
// különben ugyanaz a csúszás történne, csak eggyel odébb.
//
// Futtatás: node scripts/check-core-sync.js

const fs = require('fs');
const path = require('path');

const ROOT = __dirname.replace(/\/scripts$/, '');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** "10 * 60_000" -> 600000. Csak összeadás/szorzás/eltolás és számliterál. */
function evalNumber(expr) {
  const cleaned = expr
    .replace(/_/g, '')
    // A Kotlin `shl` és a Swift/TS `<<` ugyanaz a művelet, csak más a jele.
    // ELŐBB kell cserélni, mint a szám-utótagokat: különben a `shl` végi `l`-t
    // a `[LlfFdD]\b` minta leszedné, és `sh` maradna a helyén.
    .replace(/\bshl\b/g, '<<')
    .replace(/[LlfFdD]\b/g, '')
    .trim();
  if (!/^[\d\s*+.()<-]+$/.test(cleaned)) return NaN;
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${cleaned});`)();
}

function numbersIn(text) {
  return (text.match(/-?\d[\d_]*(?:\.\d+)?/g) || []).map((n) => Number(n.replace(/_/g, '')));
}

// ---------------------------------------------------------------- kinyerés

const ts = {
  challenges: read('desktop/src/shared/challenges.ts'),
  alias: read('desktop/src/shared/alias.ts'),
  sync: read('desktop/src/shared/sync/crypto.ts'),
  referee: read('desktop/src/helper/referee.ts'),
  protocol: read('desktop/src/shared/protocol.ts'),
};
const kt = {
  engine: read('android/app/src/main/java/hu/breaker/app/core/ChallengeEngine.kt'),
  referee: read('android/app/src/main/java/hu/breaker/app/core/Referee.kt'),
  alias: read('android/app/src/main/java/hu/breaker/app/core/Alias.kt'),
  sync: read('android/app/src/main/java/hu/breaker/app/core/SyncCrypto.kt'),
};
const sw = {
  pairing: read('ios/Shared/Pairing.swift'),
  engine: read('ios/Shared/ChallengeEngine.swift'),
  referee: read('ios/Shared/Referee.swift'),
  alias: read('ios/Shared/Alias.swift'),
  sync: read('ios/Shared/SyncCrypto.swift'),
};

ts.pairing = read('desktop/src/shared/sync/pairing.ts');
// A szűrő megakadásai csak a két telefonon élnek (a gépen a böngésző könyve más).
kt.filterHits = read('android/app/src/main/java/hu/breaker/app/core/FilterHits.kt');
sw.filterHits = read('ios/Shared/FilterHits.swift');
// A sokadik megakadás lépcsői viszont közösek: a gépen a böngésző könyve adja.
ts.browserHits = read('desktop/src/shared/browser-hits.ts');
kt.pairing = read('android/app/src/main/java/hu/breaker/app/core/Pairing.kt');

ts.limits = read('desktop/src/shared/limits.ts');
kt.limits = read('android/app/src/main/java/hu/breaker/app/core/Limits.kt');
sw.limits = read('ios/Shared/Limits.swift');

ts.rules = read('desktop/src/shared/urlrules.ts');
kt.rules = read('android/app/src/main/java/hu/breaker/app/core/UrlRules.kt');
sw.rules = read('ios/Shared/UrlRules.swift');

ts.focus = read('desktop/src/shared/focus.ts');
kt.focus = read('android/app/src/main/java/hu/breaker/app/core/Focus.kt');
sw.focus = read('ios/Shared/Focus.swift');
// A böngésző-bővítmény a maga másolatával dolgozik: a felugró lap sorozat-küszöbe.
const ext = { popupCore: read('extension/popup-core.js') };
// A megakadások könyve is: a csúcs-nap ablaka és küszöbe, a javaslat első lépcsője.
ext.hits = read('extension/hits.js');
// A bővítmény a kulcsszó és a részleges szabály saját másolatával dönt a
// böngészőben — a plafonjainak az appéval kell egyeznie.
ext.keywords = read('extension/keywords.js');
ext.rules = read('extension/rules-core.js');
// A híd a heti ablakokat és a zárlat-ablakokat egy hétre előre leküldi; a
// bővítmény a maga plafonjáig tárolja — ha kisebb volna, a hét vége kiesne.
ext.appLink = read('extension/app-link.js');

ts.digest = read('desktop/src/shared/digest.ts');
kt.digest = read('android/app/src/main/java/hu/breaker/app/core/Digest.kt');
sw.digest = read('ios/Shared/Digest.swift');
ts.usage = read('desktop/src/shared/usage.ts');
kt.usage = read('android/app/src/main/java/hu/breaker/app/core/Usage.kt');

ts.partner = read('desktop/src/shared/partner.ts');
kt.partner = read('android/app/src/main/java/hu/breaker/app/core/Partner.kt');
sw.partner = read('ios/Shared/Partner.swift');

ts.keywords = read('desktop/src/shared/keywords.ts');
kt.keywords = read('android/app/src/main/java/hu/breaker/app/core/Keywords.kt');
sw.keywords = read('ios/Shared/Keywords.swift');

ts.lockdown = read('desktop/src/shared/lockdown.ts');
kt.lockdown = read('android/app/src/main/java/hu/breaker/app/core/Lockdown.kt');
sw.lockdown = read('ios/Shared/Lockdown.swift');

// A szinkron fésülése és a plafonjai: a hosztnév-jelek, a csomagok és a
// csomag-jelek korlátja — és az adag-szabály korlátai a két mérő nyelvben.
ts.merge = read('desktop/src/shared/sync/merge.ts');
kt.merge = read('android/app/src/main/java/hu/breaker/app/core/SyncMerge.kt');
sw.merge = read('ios/Shared/SyncMerge.swift');
ts.focusMerge = read('desktop/src/shared/sync/focus-merge.ts');
kt.focusSync = read('android/app/src/main/java/hu/breaker/app/core/FocusSync.kt');
sw.focusSync = read('ios/Shared/FocusSync.swift');
ts.burst = read('desktop/src/shared/burst.ts');
kt.burst = read('android/app/src/main/java/hu/breaker/app/core/Burst.kt');

function scalar(text, re, label) {
  const m = text.match(re);
  if (!m) return { missing: label };
  const v = evalNumber(m[1]);
  return Number.isFinite(v) ? v : { missing: `${label} (nem szám: ${m[1]})` };
}

function list(text, re, label) {
  const m = text.match(re);
  if (!m) return { missing: label };
  return numbersIn(m[1]);
}

/** Egy sor a táblázatban: mit hasonlítunk, és honnan vesszük mindhárom nyelven. */
const CHECKS = [
  ['CLAIM_WINDOW_MS',
    scalar(ts.challenges, /CLAIM_WINDOW_MS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.engine, /CLAIM_WINDOW_MS[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.engine, /claimWindowMs[^=]*=\s*(.+)/, 'swift')],
  ['DELETE_PENDING_MS',
    scalar(ts.challenges, /DELETE_PENDING_MS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.engine, /DELETE_PENDING_MS[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.engine, /deletePendingMs[^=]*=\s*(.+)/, 'swift')],
  ['SESSION_MAX_AGE_MS',
    scalar(ts.challenges, /SESSION_MAX_AGE_MS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.engine, /SESSION_MAX_AGE_MS[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.engine, /sessionMaxAgeMs[^=]*=\s*(.+)/, 'swift')],
  ['REROLL_COOLDOWN_MS',
    scalar(ts.challenges, /REROLL_COOLDOWN_MS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.engine, /REROLL_COOLDOWN_MS[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.engine, /rerollCooldownMs[^=]*=\s*(.+)/, 'swift')],
  ['CLOCK_JUMP_THRESHOLD_MS',
    scalar(ts.referee, /CLOCK_JUMP_THRESHOLD_MS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.referee, /CLOCK_JUMP_THRESHOLD_MS[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.referee, /clockJumpThresholdMs[^=]*=\s*(.+)/, 'swift')],
  ['MAX_ABANDONS',
    scalar(ts.referee, /MAX_ABANDONS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.referee, /MAX_ABANDONS\s*=\s*(.+)/, 'kt'),
    scalar(sw.referee, /maxAbandons\s*=\s*(.+)/, 'swift')],
  ['PAUSE_CHOICES_MIN',
    list(ts.protocol, /PAUSE_CHOICES_MIN\s*=\s*\[([^\]]+)\]/, 'ts'),
    list(kt.engine, /PAUSE_CHOICES_MIN\s*=\s*listOf\(([^)]+)\)/, 'kt'),
    list(sw.engine, /pauseChoicesMin\s*=\s*\[([^\]]+)\]/, 'swift')],
  // A ZÁRLAT SZÁMAI. Ha a plafon vagy a gyorsgombok szétcsúsznának, ugyanaz a
  // gomb két eszközön két különböző hosszt zárna — és annak nincs visszaútja.
  ['MAX_LOCKDOWN_DAYS',
    scalar(ts.lockdown, /MAX_LOCKDOWN_DAYS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.lockdown, /MAX_LOCKDOWN_DAYS\s*=\s*(.+)/, 'kt'),
    scalar(sw.lockdown, /maxLockdownDays\s*=\s*(.+)/, 'swift')],
  ['LOCKDOWN_CHOICES_MIN',
    list(ts.lockdown, /LOCKDOWN_CHOICES_MIN\s*=\s*\[([^\]]+)\]/, 'ts'),
    list(kt.lockdown, /LOCKDOWN_CHOICES_MIN\s*=\s*listOf\(([^)]+)\)/, 'kt'),
    list(sw.lockdown, /lockdownChoicesMin\s*=\s*\[([^\]]+)\]/, 'swift')],
  // A ZÁRLAT-ABLAK SZÁMAI. A plafon és a heti szabad óra: ha szétcsúsznának,
  // a telefon egy hetedik ablakot vagy egy egész hetet elfogadna, amit a gép
  // nem — és a fésülés a bővebbet tartja meg.
  ['MAX_LOCKDOWN_WINDOWS',
    scalar(ts.lockdown, /MAX_LOCKDOWN_WINDOWS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.lockdown, /MAX_LOCKDOWN_WINDOWS\s*=\s*(.+)/, 'kt'),
    scalar(sw.lockdown, /maxLockdownWindows\s*=\s*(.+)/, 'swift')],
  // Az ablak azonosítójának plafonja: a dróton jött ablak ezen túl kiesik —
  // ha a magok másképp mérnék, ugyanaz az ablak az egyiken megmaradna.
  ['MAX_WINDOW_ID',
    scalar(ts.lockdown, /MAX_WINDOW_ID\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.lockdown, /MAX_WINDOW_ID\s*=\s*(.+)/, 'kt'),
    scalar(sw.lockdown, /maxWindowId\s*=\s*(.+)/, 'swift')],
  ['MIN_FREE_MINUTES_PER_WEEK',
    scalar(ts.lockdown, /MIN_FREE_MINUTES_PER_WEEK\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.lockdown, /MIN_FREE_MINUTES_PER_WEEK\s*=\s*(.+)/, 'kt'),
    scalar(sw.lockdown, /minFreeMinutesPerWeek\s*=\s*(.+)/, 'swift')],
  ['WINDOW_PRE_WARN_MS',
    scalar(ts.lockdown, /WINDOW_PRE_WARN_MS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.lockdown, /WINDOW_PRE_WARN_MS\s*=\s*(.+)/, 'kt'),
    scalar(sw.lockdown, /windowPreWarnMs: Double\s*=\s*(.+)/, 'swift')],
  // A HETI VISSZATEKINTÉS: az óra és a napló plafonja. Ha elcsúsznának, a
  // három eszköz más hétfőn szólna ugyanarról a hétről, vagy más hosszú
  // naplót tartana — csendben.
  ['DIGEST_HOUR',
    scalar(ts.digest, /DIGEST_HOUR\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.digest, /DIGEST_HOUR\s*=\s*(.+)/, 'kt'),
    scalar(sw.digest, /digestHour\s*=\s*(.+)/, 'swift')],
  ['MAX_DIGEST_TEXT',
    scalar(ts.digest, /MAX_DIGEST_TEXT\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.digest, /MAX_DIGEST_TEXT\s*=\s*(.+)/, 'kt'),
    scalar(sw.digest, /maxDigestText\s*=\s*(.+)/, 'swift')],
  ['MAX_DIGEST_LOG',
    scalar(ts.digest, /MAX_DIGEST_LOG\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.digest, /MAX_DIGEST_LOG\s*=\s*(.+)/, 'kt'),
    scalar(sw.digest, /maxDigestLog\s*=\s*(.+)/, 'swift')],
  // A PÁRBAN ZÁROLÁS SZÁMAI: a jelmondat szavai, a név hossza, a rossz
  // próbák plafonja. Ha a plafon szétcsúszna, ugyanarra a megbízottra a
  // telefonon több (vagy kevesebb) rossz jelmondat férne bele, mint a gépen —
  // és a felület mindenhol „ötször”-t mondana.
  ['PARTNER_PHRASE_WORDS',
    scalar(ts.partner, /PARTNER_PHRASE_WORDS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.partner, /PARTNER_PHRASE_WORDS\s*=\s*(.+)/, 'kt'),
    scalar(sw.partner, /partnerPhraseWords\s*=\s*(.+)/, 'swift')],
  ['MAX_PARTNER_NAME',
    scalar(ts.partner, /MAX_PARTNER_NAME\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.partner, /MAX_PARTNER_NAME\s*=\s*(.+)/, 'kt'),
    scalar(sw.partner, /maxPartnerName\s*=\s*(.+)/, 'swift')],
  ['MAX_PARTNER_TRIES',
    scalar(ts.partner, /MAX_PARTNER_TRIES\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.partner, /MAX_PARTNER_TRIES\s*=\s*(.+)/, 'kt'),
    scalar(sw.partner, /maxPartnerTries\s*=\s*(.+)/, 'swift')],
  // A KULCSSZÓ-SZABÁLYOK SZÁMAI: a plafon és a hossz-sáv. Ha szétcsúsznának, a
  // telefon fésülése elejtene egy szót, amit a gép felvett — csendben.
  ['MAX_KEYWORDS',
    scalar(ts.keywords, /MAX_KEYWORDS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.keywords, /MAX_KEYWORDS\s*=\s*(.+)/, 'kt'),
    scalar(sw.keywords, /maxKeywords\s*=\s*(.+)/, 'swift')],
  ['MAX_KEYWORD_LENGTH',
    scalar(ts.keywords, /MAX_KEYWORD_LENGTH\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.keywords, /MAX_KEYWORD_LENGTH\s*=\s*(.+)/, 'kt'),
    scalar(sw.keywords, /maxKeywordLength\s*=\s*(.+)/, 'swift')],
  ['MIN_KEYWORD_LENGTH',
    scalar(ts.keywords, /MIN_KEYWORD_LENGTH\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.keywords, /MIN_KEYWORD_LENGTH\s*=\s*(.+)/, 'kt'),
    scalar(sw.keywords, /minKeywordLength\s*=\s*(.+)/, 'swift')],
  ['MAX_ALLOW_ENTRIES',
    scalar(ts.focus, /MAX_ALLOW_ENTRIES\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.focus, /MAX_ALLOW_ENTRIES\s*=\s*(.+)/, 'kt'),
    scalar(sw.focus, /maxAllowEntries\s*=\s*(.+)/, 'swift')],
  ['MAX_PACK_NAME',
    scalar(ts.focus, /MAX_PACK_NAME\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.focus, /MAX_PACK_NAME\s*=\s*(.+)/, 'kt'),
    scalar(sw.focus, /maxPackName\s*=\s*(.+)/, 'swift')],
  // Az engedélyezett app nevének plafonja: a név a fiókon utazik, és a fogadó
  // oldal is vág — eltérő plafon mellett a lista minden körben átíródna.
  ['MAX_ALLOW_APP_LENGTH',
    scalar(ts.focus, /MAX_ALLOW_APP_LENGTH\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.focus, /MAX_ALLOW_APP_LENGTH\s*=\s*(.+)/, 'kt'),
    scalar(sw.focus, /maxAllowAppLength\s*=\s*(.+)/, 'swift')],
  ['MAX_SESSION_MINUTES',
    scalar(ts.focus, /MAX_SESSION_MINUTES\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.focus, /MAX_SESSION_MINUTES\s*=\s*(.+)/, 'kt'),
    scalar(sw.focus, /maxSessionMinutes\s*=\s*(.+)/, 'swift')],
  // A NAPLÓ HOSSZA. Ha szétcsúszna, a három eszköz más-más menetet vágna le a
  // végéről, és minden szinkron-kör oda-vissza írogatná a különbséget: az egyik
  // eszköz visszatenné, amit a másik levágott, a végtelenségig.
  ['MAX_FOCUS_LOG',
    scalar(ts.focus, /MAX_FOCUS_LOG\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.focus, /MAX_FOCUS_LOG\s*=\s*(.+)/, 'kt'),
    scalar(sw.focus, /maxFocusLog\s*=\s*(.+)/, 'swift')],
  ['SESSION_CHOICES_MIN',
    list(ts.focus, /SESSION_CHOICES_MIN\s*=\s*\[([^\]]+)\]/, 'ts'),
    list(kt.focus, /SESSION_CHOICES_MIN\s*=\s*listOf\(([^)]+)\)/, 'kt'),
    list(sw.focus, /sessionChoicesMin\s*=\s*\[([^\]]+)\]/, 'swift')],
  // Az ismétlődő menet indítási küszöbe. Ha az egyik magban egy perc, a
  // másikban tíz, a telefon és a gép az ablak végén más-más percben döntené
  // el, indul-e még — és két eszköz két különböző menetet írna a naplóba.
  ['RECURRENCE_MIN_REMAINING_MS',
    scalar(ts.focus, /RECURRENCE_MIN_REMAINING_MS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.focus, /RECURRENCE_MIN_REMAINING_MS\s*=\s*(.+)/, 'kt'),
    scalar(sw.focus, /recurrenceMinRemainingMs[^=]*=\s*(.+)/, 'swift')],
  // HÁNY LÉPÉS EGY KÍSÉRLET. Ha ez szétcsúszik, ugyanaz a fok az egyik
  // eszközön három feladat, a másikon hat — vagyis a felhasználó a gyengébb
  // eszközön old fel, és semmi nem jelzi.
  ['tier: activeSteps',
    list(ts.challenges, /activeSteps:\s*\[([^\]]+)\]/, 'ts'),
    list(kt.engine, /ACTIVE_STEPS\s*=\s*intArrayOf\(([^)]+)\)/, 'kt'),
    list(sw.engine, /activeSteps\s*=\s*\[([^\]]+)\]/, 'swift')],
  ['tier: transcribeChars',
    list(ts.challenges, /transcribeChars:\s*\[([^\]]+)\]/, 'ts'),
    list(kt.engine, /TRANSCRIBE_CHARS\s*=\s*intArrayOf\(([^)]+)\)/, 'kt'),
    list(sw.engine, /transcribeChars\s*=\s*\[([^\]]+)\]/, 'swift')],
  ['tier: mathLen',
    list(ts.challenges, /mathLen:\s*\[([^\]]+)\]/, 'ts'),
    list(kt.engine, /MATH_LEN\s*=\s*intArrayOf\(([^)]+)\)/, 'kt'),
    list(sw.engine, /mathLen\s*=\s*\[([^\]]+)\]/, 'swift')],
  ['tier: mathFactorMax',
    list(ts.challenges, /mathFactorMax:\s*\[([^\]]+)\]/, 'ts'),
    list(kt.engine, /MATH_FACTOR_MAX\s*=\s*intArrayOf\(([^)]+)\)/, 'kt'),
    list(sw.engine, /mathFactorMax\s*=\s*\[([^\]]+)\]/, 'swift')],
  ['tier: memoryLen',
    list(ts.challenges, /memoryLen:\s*\[([^\]]+)\]/, 'ts'),
    list(kt.engine, /MEMORY_LEN\s*=\s*intArrayOf\(([^)]+)\)/, 'kt'),
    list(sw.engine, /memoryLen\s*=\s*\[([^\]]+)\]/, 'swift')],
  ['tier: memoryShowMs',
    list(ts.challenges, /memoryShowMs:\s*\[([^\]]+)\]/, 'ts'),
    list(kt.engine, /MEMORY_SHOW_MS\s*=\s*longArrayOf\(([^)]+)\)/, 'kt'),
    list(sw.engine, /memoryShowMs\s*=\s*\[([^\]]+)\]/, 'swift')],
  ['tier: memoryWaitMs',
    list(ts.challenges, /memoryWaitMs:\s*\[([^\]]+)\]/, 'ts'),
    list(kt.engine, /MEMORY_WAIT_MS\s*=\s*longArrayOf\(([^)]+)\)/, 'kt'),
    list(sw.engine, /memoryWaitMs\s*=\s*\[([^\]]+)\]/, 'swift')],
  ['tier: reverseWords',
    list(ts.challenges, /reverseWords:\s*\[([^\]]+)\]/, 'ts'),
    list(kt.engine, /REVERSE_WORDS\s*=\s*intArrayOf\(([^)]+)\)/, 'kt'),
    list(sw.engine, /reverseWords\s*=\s*\[([^\]]+)\]/, 'swift')],
  ['tier: pauseDelayMin',
    list(ts.challenges, /pauseDelayMin:\s*\[([^\n]+)\]/, 'ts'),
    list(kt.engine, /PAUSE_DELAY_MIN\s*=\s*arrayOf\(([^)]*\)[^\n]*)/, 'kt'),
    list(sw.engine, /pauseDelayMin\s*=\s*\[([^\n]+)\]/, 'swift')],
  ['tier: deleteDelayMin',
    list(ts.challenges, /deleteDelayMin:\s*\[([^\n]+)\]/, 'ts'),
    list(kt.engine, /DELETE_DELAY_MIN\s*=\s*arrayOf\(([^)]*\)[^\n]*)/, 'kt'),
    list(sw.engine, /deleteDelayMin\s*=\s*\[([^\n]+)\]/, 'swift')],
  // A fedőnév nem nehézségi paraméter, de itt is ugyanaz a csapda: ha az egyik
  // magban 40, a másikban 60 a hosszkorlát, akkor ugyanaz a név az egyik
  // eszközön elfér, a másikon csonkul — és senki nem ért semmit.
  // A közös napi keret: ha az egyik mag kétszáz célt fogad el, a másik ötvenet,
  // ugyanaz az összegzés az egyik eszközön teljes, a másikon csonka — és a
  // keret máshol fogyna el. Csendben, mindenféle hibaüzenet nélkül.
  ['MAX_DIGEST_TARGETS',
    scalar(ts.limits, /MAX_DIGEST_TARGETS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.limits, /MAX_DIGEST_TARGETS\s*=\s*(.+)/, 'kt'),
    scalar(sw.limits, /maxDigestTargets\s*=\s*(.+)/, 'swift')],
  // KÖZELEG A NAPI KERET: ennyivel a betelés előtt szól a heads-up. Ha a három
  // mag mást mond, ugyanaz az oldal az egyik eszközön szólna, a másikon nem.
  ['LIMIT_SOON_SECONDS',
    scalar(ts.limits, /LIMIT_SOON_SECONDS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.limits, /LIMIT_SOON_SECONDS\s*=\s*(.+)/, 'kt'),
    scalar(sw.limits, /limitSoonSeconds[^=]*=\s*(.+)/, 'swift')],
  // Részleges szabályok. Ha az egyik magban 50, a másikban 20 a felső korlát,
  // a szinkron a huszonegyediket az egyik eszközön elfogadja, a másikon eldobja
  // — és a felhasználó csak annyit lát, hogy a szabály „eltűnt”.
  ['MAX_RULES_PER_SITE',
    scalar(ts.rules, /MAX_RULES_PER_SITE\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.rules, /MAX_RULES_PER_SITE\s*=\s*(.+)/, 'kt'),
    scalar(sw.rules, /maxRulesPerSite\s*=\s*(.+)/, 'swift')],
  ['MAX_RULE_PATH_LENGTH',
    scalar(ts.rules, /MAX_RULE_PATH_LENGTH\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.rules, /MAX_RULE_PATH_LENGTH\s*=\s*(.+)/, 'kt'),
    scalar(sw.rules, /maxRulePathLength\s*=\s*(.+)/, 'swift')],
  // A SZINKRON PLAFONJAI. Egy eltérő plafon nem hibaüzenet, hanem nem
  // konvergáló szinkron: ha az egyik mag 64 jelre vág, a másik nem, ugyanabból
  // a két blobból más jön ki, és a két eszköz körönként egymást írja felül —
  // a fixtúra csak a plafon alatt járó esetekben látná.
  ['MAX_HOSTNAME_MARKS',
    scalar(ts.merge, /MAX_HOSTNAME_MARKS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.merge, /MAX_HOSTNAME_MARKS\s*=\s*(.+)/, 'kt'),
    scalar(sw.merge, /maxHostnameMarks\s*=\s*(.+)/, 'swift')],
  ['MAX_PACKS',
    scalar(ts.focusMerge, /MAX_PACKS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.focusSync, /MAX_PACKS\s*=\s*(.+)/, 'kt'),
    scalar(sw.focusSync, /maxPacks\s*=\s*(.+)/, 'swift')],
  ['MAX_PACK_MARKS',
    scalar(ts.focusMerge, /MAX_PACK_MARKS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.focusSync, /MAX_PACK_MARKS\s*=\s*(.+)/, 'kt'),
    scalar(sw.focusSync, /maxPackMarks\s*=\s*(.+)/, 'swift')],
  ['MAX_ALIAS_LENGTH',
    scalar(ts.alias, /MAX_ALIAS_LENGTH\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.alias, /MAX_ALIAS_LENGTH[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.alias, /maxAliasLength[^=]*=\s*(.+)/, 'swift')],
  ['MAX_REASON_LENGTH',
    scalar(ts.alias, /MAX_REASON_LENGTH\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.alias, /MAX_REASON_LENGTH[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.alias, /maxReasonLength[^=]*=\s*(.+)/, 'swift')],
  ['REVEAL_MS',
    scalar(ts.alias, /REVEAL_MS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.alias, /REVEAL_MS[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.alias, /revealMs[^=]*=\s*(.+)/, 'swift')],
  // A szinkron kulcsszármaztatása: ha ez a három szám elcsúszik, ugyanaz a
  // jelszó MÁS kulcsot ad a telefonon és a gépen — vagyis a másik eszközön nem
  // lehet belépni. Csendben, mindenféle hibaüzenet nélkül.
  ['SCRYPT_N',
    scalar(ts.sync, /SCRYPT_N\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.sync, /SCRYPT_N[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.sync, /scryptN[^=]*=\s*(.+)/, 'swift')],
  ['SCRYPT_R',
    scalar(ts.sync, /SCRYPT_R\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.sync, /SCRYPT_R[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.sync, /scryptR[^=]*=\s*(.+)/, 'swift')],
  ['MIN_PASSWORD_LENGTH',
    scalar(ts.sync, /MIN_PASSWORD_LENGTH\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.sync, /MIN_PASSWORD_LENGTH[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.sync, /minPasswordLength[^=]*=\s*(.+)/, 'swift')],
  ['SCRYPT_P',
    scalar(ts.sync, /SCRYPT_P\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.sync, /SCRYPT_P[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.sync, /scryptP[^=]*=\s*(.+)/, 'swift')],
  // A párosító kód közös állandói. Ha ezek elcsúsznak, a gépen kiírt kód a
  // telefonon nem nyílik ki — vagy ami rosszabb, MÁS címet ad.
  ['DEFAULT_SYNC_PORT',
    scalar(ts.pairing, /DEFAULT_SYNC_PORT\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.pairing, /DEFAULT_SYNC_PORT[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.pairing, /defaultPort[^=]*=\s*(.+)/, 'swift')],
  ['MAX_CODE_CHARS',
    scalar(ts.pairing, /MAX_CODE_CHARS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.pairing, /MAX_CODE_CHARS[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.pairing, /maxCodeChars[^=]*=\s*(.+)/, 'swift')],
  // A SOKADIK megakadás lépcsői: ha a telefon máshol szólna, mint a gép, ugyanaz
  // az ember két különböző „sokat” hallana.
  ['HIT_NUDGE_STEPS',
    list(ts.browserHits, /HIT_NUDGE_STEPS\s*=\s*\[([^\]]+)\]/, 'ts'),
    list(kt.filterHits, /NUDGE_STEPS\s*=\s*listOf\(([^)]+)\)/, 'kt'),
    list(sw.filterHits, /nudgeSteps:\s*\[Int\]\s*=\s*\[([^\]]+)\]/, 'swift')],
  // AZ ELŐJELZÉS a csúcs-óra előtt: ha a gép tíz perccel, a telefon öttel
  // szólna, ugyanaz az ember két órát tanulna meg.
  ['PEAK_WARN_LEAD_MS',
    scalar(ts.browserHits, /PEAK_WARN_LEAD_MS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.filterHits, /PEAK_WARN_LEAD_MS[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.filterHits, /peakWarnLeadMs[^=]*=\s*(.+)/, 'swift')],
  ['PEAK_WARN_MIN_COUNT',
    scalar(ts.browserHits, /PEAK_WARN_MIN_COUNT\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.filterHits, /PEAK_WARN_MIN_COUNT[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.filterHits, /peakWarnMinCount[^=]*=\s*(.+)/, 'swift')],
  // A CSÚCS-NAP mintája: négy-négy nap a hét minden napjára — ha a gép négy
  // hétből, a telefon egyből nézné, ugyanaz az ember két napot tudna meg.
  ['PEAK_WEEKDAY_DAYS',
    scalar(ts.browserHits, /PEAK_WEEKDAY_DAYS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.filterHits, /PEAK_WEEKDAY_DAYS[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.filterHits, /peakWeekdayDays[^=]*=\s*(.+)/, 'swift')],
  // A CSÚCS-NAP „ma van” mondatának küszöbe: egy-két megakadás négy hétből
  // nem minta — ha a gép háromnál, a telefon egynél szólna, ugyanaz az ember
  // két napot tudna meg.
  ['PEAK_DAY_MIN_COUNT',
    scalar(ts.browserHits, /PEAK_DAY_MIN_COUNT\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.filterHits, /PEAK_DAY_MIN_COUNT[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.filterHits, /peakDayMinCount[^=]*=\s*(.+)/, 'swift')],
  // A SOROZAT KÜSZÖBE: egy nap nem sorozat — ha a gép kettőnél, a telefon
  // háromnál szólna, ugyanaz az ember két számot tudna meg ugyanarról.
  ['FOCUS_STREAK_MIN_DAYS',
    scalar(ts.focus, /FOCUS_STREAK_MIN_DAYS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.focus, /STREAK_MIN_DAYS[^=]*=\s*(.+)/, 'kt'),
    scalar(sw.focus, /streakMinDays[^=]*=\s*(.+)/, 'swift')],
];

// KÉT NYELV KÖZÖTT. Amit csak a gép és az Android tud (iPhone-on a bővítmény
// nem adhat értesítést, és az app nem fut a háttérben): a hétfő reggeli
// visszatekintés órája és a javaslat küszöbe. Ha elcsúsznának, a két eszköz
// más hétfőn — vagy más oldalról — szólna ugyanarról a hétről.
const PAIRS = [
  ['SUGGEST_MIN_SECONDS',
    scalar(ts.usage, /SUGGEST_MIN_SECONDS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.usage, /SUGGEST_MIN_SECONDS\s*=\s*(.+)/, 'kt')],
  // A mért idő napjának „ma van” küszöbe: ha a gép negyedóránál, a telefon
  // egy percnél szólna, ugyanaz az ember két napot tudna meg.
  ['USAGE_DAY_MIN_SECONDS',
    scalar(ts.usage, /USAGE_DAY_MIN_SECONDS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.usage, /USAGE_DAY_MIN_SECONDS\s*=\s*(.+)/, 'kt')],
  // A mérés plafonjai és az adag-szabály korlátai csak a két mérő nyelvben
  // élnek (az iPhone nem mér előteret). Ha a gép kétszáz célt tart meg egy
  // napra, a telefon ötvenet, ugyanaz a nap az egyiken teljes, a másikon
  // „egyéb”-be hajtva; ha az adag plafonja más, ugyanaz a szabály az egyik
  // eszközön él, a másikon nincs.
  ['MAX_TARGETS_PER_DAY',
    scalar(ts.usage, /MAX_TARGETS_PER_DAY\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.usage, /MAX_TARGETS_PER_DAY\s*=\s*(.+)/, 'kt')],
  ['MAX_LABEL_LENGTH',
    scalar(ts.usage, /MAX_LABEL_LENGTH\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.usage, /MAX_LABEL_LENGTH\s*=\s*(.+)/, 'kt')],
  // A megőrzés és egy minta felső határa: ha elcsúszna, a két mérő más
  // hosszú múltat tartana, vagy egy nagy minta az egyiken többet érne.
  ['RETENTION_DAYS',
    scalar(ts.usage, /RETENTION_DAYS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.usage, /RETENTION_DAYS\s*=\s*(.+)/, 'kt')],
  ['MAX_RECORD_SECONDS',
    scalar(ts.usage, /MAX_RECORD_SECONDS\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.usage, /MAX_RECORD_SECONDS\s*=\s*(.+)/, 'kt')],
  ['MAX_BURST_MINUTES',
    scalar(ts.burst, /MAX_BURST_MINUTES\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.burst, /MAX_BURST_MINUTES\s*=\s*(.+)/, 'kt')],
  ['MAX_COOLDOWN_MINUTES',
    scalar(ts.burst, /MAX_COOLDOWN_MINUTES\s*=\s*([^;]+);/, 'ts'),
    scalar(kt.burst, /MAX_COOLDOWN_MINUTES\s*=\s*(.+)/, 'kt')],
];

// A gép és a böngésző-bővítmény között: a felugró lap a sorozatot a maga
// másolatával mondja kettőtől. Ha elcsúszna, a lap más napon szólna, mint az app.
const EXT_PAIRS = [
  // A bővítmény a teljes címről MAGA dönt (kulcsszó, részleges szabály). Ha a
  // plafonja más volna, az appban felvett szó vagy szabály a böngészőben
  // csendben kiesne — vagy a bővítmény beállítás-lapja elutasítaná.
  ['MAX_KEYWORDS',
    scalar(ts.keywords, /MAX_KEYWORDS\s*=\s*([^;]+);/, 'ts'),
    scalar(ext.keywords, /MAX_KEYWORDS\s*=\s*([^;]+);/, 'ext')],
  ['MAX_KEYWORD_LENGTH',
    scalar(ts.keywords, /MAX_KEYWORD_LENGTH\s*=\s*([^;]+);/, 'ts'),
    scalar(ext.keywords, /MAX_KEYWORD_LENGTH\s*=\s*([^;]+);/, 'ext')],
  ['MIN_KEYWORD_LENGTH',
    scalar(ts.keywords, /MIN_KEYWORD_LENGTH\s*=\s*([^;]+);/, 'ts'),
    scalar(ext.keywords, /MIN_KEYWORD_LENGTH\s*=\s*([^;]+);/, 'ext')],
  ['MAX_RULE_PATH_LENGTH',
    scalar(ts.rules, /MAX_RULE_PATH_LENGTH\s*=\s*([^;]+);/, 'ts'),
    scalar(ext.rules, /MAX_RULE_PATH_LENGTH\s*=\s*([^;]+);/, 'ext')],
  ['FOCUS_STREAK_MIN_DAYS',
    scalar(ts.focus, /FOCUS_STREAK_MIN_DAYS\s*=\s*([^;]+);/, 'ts'),
    scalar(ext.popupCore, /STREAK_MIN_DAYS\s*=\s*([^;]+);/, 'ext')],
  // A csúcs-nap négy hete és a „ma van” küszöbe: a beállítás-lap és a tiltó lap a
  // maga könyvéből számol — ha más ablakkal, mint az app, a két lap mást mondana.
  ['PEAK_WEEKDAY_DAYS',
    scalar(ts.browserHits, /PEAK_WEEKDAY_DAYS\s*=\s*([^;]+);/, 'ts'),
    scalar(ext.hits, /PEAK_WEEKDAY_DAYS\s*=\s*([^;]+);/, 'ext')],
  ['PEAK_DAY_MIN_COUNT',
    scalar(ts.browserHits, /PEAK_DAY_MIN_COUNT\s*=\s*([^;]+);/, 'ts'),
    scalar(ext.hits, /PEAK_DAY_MIN_COUNT\s*=\s*([^;]+);/, 'ext')],
  // A sokadik megakadás első lépcsője: a tiltó lap a saját számlálójából javasol.
  ['HIT_NUDGE_FIRST_STEP',
    scalar(ts.browserHits, /HIT_NUDGE_STEPS\s*=\s*\[\s*(\d+)/, 'ts'),
    scalar(ext.hits, /NUDGE_AT\s*=\s*([^;]+);/, 'ext')],
  // A hét napjainak nevei: a csúcs-nap mondata a lapon és az appban ugyanazt a
  // napot ugyanúgy hívja — különben a „ma van” két nevet viselne.
  ['WEEKDAY_NAMES',
    quotedWords(ts.browserHits, /WEEKDAY_NAMES\s*=\s*\[([^\]]+)\]/) ?? { missing: 'ts' },
    quotedWords(ext.hits, /WEEKDAY_NAMES\s*=\s*\[([^\]]+)\]/) ?? { missing: 'ext' }],
  // Az előre-listák plafonja: amit az app egy hétre leküld, azt a bővítmény
  // mind megtartja — a heti ablakból és a zárlat-ablakból is.
  ['MAX_WINDOW_OCCURRENCES (munkamenet)',
    scalar(ts.focus, /MAX_WINDOW_OCCURRENCES\s*=\s*([^;]+);/, 'ts'),
    scalar(ext.appLink, /MAX_FOCUS_WINDOWS\s*=\s*([^;]+);/, 'ext')],
  ['MAX_WINDOW_OCCURRENCES (zárlat)',
    scalar(ts.focus, /MAX_WINDOW_OCCURRENCES\s*=\s*([^;]+);/, 'ts'),
    scalar(ext.appLink, /MAX_LOCKDOWN_WINDOWS\s*=\s*([^;]+);/, 'ext')],
];

/** Egy szám a két telefon-tükörből — aláhúzás és Kotlin-utótag nélkül. */
function phoneScalar(text, re, label) {
  const m = text.match(re);
  if (!m) return { missing: label };
  const v = Number(m[1].replace(/_/g, '').replace(/L$/, ''));
  return Number.isFinite(v) ? v : { missing: `${label} (nem szám: ${m[1]})` };
}

// A két telefon között: a szűrő megakadásainak szabályai. Ha a két készülék
// más ablakkal számolna, ugyanaz a hét két számot adna.
const PHONE_PAIRS = [
  ['FILTER_HIT_RETENTION_DAYS',
    phoneScalar(kt.filterHits, /RETENTION_DAYS\s*=\s*([\d_]+)/, 'kt'),
    phoneScalar(sw.filterHits, /retentionDays\s*=\s*([\d_]+)/, 'sw')],
  ['FILTER_HIT_DEDUPE_MS',
    phoneScalar(kt.filterHits, /DEDUPE_MS\s*=\s*([\d_]+L?)/, 'kt'),
    phoneScalar(sw.filterHits, /dedupeMs:\s*Double\s*=\s*([\d_]+)/, 'sw')],
  ['FILTER_HIT_MAX_SITES_PER_DAY',
    phoneScalar(kt.filterHits, /MAX_SITES_PER_DAY\s*=\s*([\d_]+)/, 'kt'),
    phoneScalar(sw.filterHits, /maxSitesPerDay\s*=\s*([\d_]+)/, 'sw')],
  ['FILTER_HIT_MAX_PER_DAY',
    phoneScalar(kt.filterHits, /MAX_PER_DAY\s*=\s*([\d_]+)/, 'kt'),
    phoneScalar(sw.filterHits, /maxPerDay\s*=\s*([\d_]+)/, 'sw')],
];
// A csúcs-óra felirata is: ha a két telefon mást írna, a heti mondat kétféle lenne.
const PHONE_LABELS = [
  ['FILTER_HIT_HOUR_LABEL',
    (kt.filterHits.match(/fun hourLabel\(hour: Int\): String = "([^"]+)"/) || [])[1],
    (sw.filterHits.match(/func hourLabel\(_ hour: Int\) -> String \{ "([^"]+)" \}/) || [])[1]],
];

/** Idézett szavak egy listából — a három nyelv más zárójelet ír, a szavak ugyanazok. */
function quotedWords(text, re) {
  const m = text.match(re);
  if (!m) return undefined;
  return (m[1].match(/["']([^"']+)["']/g) || []).map((q) => q.slice(1, -1)).join(',');
}

// A kódábécé nem szám, de ha eltér, a memória-próba más jeleket adna.
const ALPHABETS = [
  // A kulcsszó-javaslatok is: ha a gép mást kínálna, mint a telefon, a
  // „javaslat” szó két listát jelentene.
  ['KEYWORD_SUGGESTIONS',
    quotedWords(ts.keywords, /KEYWORD_SUGGESTIONS\s*=\s*\[([^\]]+)\]/),
    quotedWords(kt.keywords, /SUGGESTIONS\s*=\s*listOf\(([^)]+)\)/),
    quotedWords(sw.keywords, /suggestions\s*=\s*\[([^\]]+)\]/)],
  ['PAIRING_ALPHABET',
    (ts.pairing.match(/ALPHABET\s*=\s*'([^']+)'/) || [])[1],
    (kt.pairing.match(/ALPHABET\s*=\s*"([^"]+)"/) || [])[1],
    (sw.pairing.match(/alphabet\s*=\s*Array\("([^"]+)"\)/) || [])[1]],
  ['CODE_ALPHABET',
    (ts.challenges.match(/CODE_ALPHABET\s*=\s*'([^']+)'/) || [])[1],
    (kt.engine.match(/CODE_ALPHABET\s*=\s*"([^"]+)"/) || [])[1],
    (sw.engine.match(/codeAlphabet\s*=\s*Array\("([^"]+)"\)/) || [])[1]],
];

// ------------------------------------------------------------ összevetés

const problems = [];
const LANGS = ['TypeScript', 'Kotlin', 'Swift'];

for (const [name, ...values] of CHECKS) {
  const missing = values
    .map((v, i) => (v && v.missing ? LANGS[i] : null))
    .filter(Boolean);
  if (missing.length) {
    problems.push(`${name}: nem található itt: ${missing.join(', ')} — a minta elavult vagy a konstans eltűnt`);
    continue;
  }
  const asText = values.map((v) => JSON.stringify(v));
  if (new Set(asText).size !== 1) {
    problems.push(
      `${name} eltér:\n` + values.map((v, i) => `    ${LANGS[i].padEnd(11)} ${asText[i]}`).join('\n'),
    );
  }
}

for (const [name, ...values] of PAIRS) {
  const missing = values
    .map((v, i) => (v && v.missing ? LANGS[i] : null))
    .filter(Boolean);
  if (missing.length) {
    problems.push(`${name}: nem található itt: ${missing.join(', ')} — a minta elavult vagy a konstans eltűnt`);
    continue;
  }
  const asText = values.map((v) => JSON.stringify(v));
  if (new Set(asText).size !== 1) {
    problems.push(
      `${name} eltér:\n` + values.map((v, i) => `    ${LANGS[i].padEnd(11)} ${asText[i]}`).join('\n'),
    );
  }
}

for (const [name, ...values] of ALPHABETS) {
  if (values.some((v) => v === undefined)) {
    problems.push(`${name}: nem található minden magban — a minta elavult`);
    continue;
  }
  if (new Set(values).size !== 1) {
    problems.push(
      `${name} eltér:\n` + values.map((v, i) => `    ${LANGS[i].padEnd(11)} ${JSON.stringify(v)}`).join('\n'),
    );
  }
}

const EXT_LANGS = ['TypeScript', 'Bővítmény'];
for (const [name, ...values] of EXT_PAIRS) {
  const missing = values
    .map((v, i) => (v && v.missing ? EXT_LANGS[i] : null))
    .filter(Boolean);
  if (missing.length) {
    problems.push(`${name}: nem található itt: ${missing.join(', ')} — a minta elavult vagy a konstans eltűnt`);
    continue;
  }
  const asText = values.map((v) => JSON.stringify(v));
  if (new Set(asText).size !== 1) {
    problems.push(
      `${name} eltér:\n` + values.map((v, i) => `    ${EXT_LANGS[i].padEnd(11)} ${asText[i]}`).join('\n'),
    );
  }
}

// ------------------------------------------------------ a szóköz-készlet
//
// A szöveg-tisztítás szóköz-fogalma a három magban KIMONDOTT lista (a JS `\s`
// huszonöt kódpontja), nem a platformé: a Java regex `\s`-e csak ASCII, a
// Kotlin és a Swift szóköz-fogalma a BOM-ot nem ismeri. A listát a három
// forrásból olvassuk ki és hasonlítjuk; a viselkedést a text-cases.json
// fixtúra nézi, ez itt csak a lista betűit — de ez másodpercek alatt szól,
// a fixtúra csak a telefonok tesztkörében.
function codePointList(text, needle) {
  const start = text.indexOf(needle);
  if (start < 0) return null;
  const end = text.indexOf('\n\n', start);
  const block = text.slice(start, end < 0 ? text.length : end);
  const found = [];
  for (const m of block.matchAll(/0x([0-9a-fA-F]+)|\\u([0-9a-fA-F]{4})/g)) found.push(parseInt(m[1] ?? m[2], 16));
  return found.sort((a, b) => a - b);
}
const SPACE_LISTS = [
  codePointList(ts.alias, 'WHITESPACE_CODE_POINTS'),
  codePointList(read('android/app/src/main/java/hu/breaker/app/core/Text.kt'), 'val SPACES'),
  codePointList(read('ios/Shared/Text.swift'), 'static let spaces'),
];
if (SPACE_LISTS.some((l) => !l || l.length === 0)) {
  problems.push('a szóköz-készlet nem található mindhárom magban — a minta elavult vagy a lista eltűnt');
} else if (new Set(SPACE_LISTS.map((l) => JSON.stringify(l))).size !== 1) {
  problems.push(
    'a szóköz-készlet eltér:\n'
      + SPACE_LISTS.map((l, i) => `    ${LANGS[i].padEnd(11)} ${l.map((c) => c.toString(16)).join(' ')}`).join('\n'),
  );
}

const PHONE_LANGS = ['Kotlin', 'Swift'];
for (const [name, kotlinLabel, swiftLabel] of PHONE_LABELS) {
  // A két nyelv a behelyettesítést másképp írja ($hour / \(hour)); a váz ugyanaz kell legyen.
  // A Swift-behelyettesítésben zárójel is lehet (`\((hour + 1) % 24)`): egy
  // szintnyi beágyazást elfogadunk, különben a minta az első `)`-nél megállna.
  const norm = (t) => (t || '').replace(/\$\{[^}]+\}|\$[a-z]+|\\\((?:[^()]|\([^()]*\))*\)/g, '#');
  if (!kotlinLabel || !swiftLabel) {
    problems.push(`${name}: nem található — a minta elavult vagy a felirat eltűnt`);
  } else if (norm(kotlinLabel) !== norm(swiftLabel)) {
    problems.push(`${name} eltér:\n    Kotlin      ${kotlinLabel}\n    Swift       ${swiftLabel}`);
  }
}
for (const [name, ...values] of PHONE_PAIRS) {
  const missing = values
    .map((v, i) => (v && v.missing ? PHONE_LANGS[i] : null))
    .filter(Boolean);
  if (missing.length) {
    problems.push(`${name}: nem található itt: ${missing.join(', ')} — a minta elavult vagy a konstans eltűnt`);
    continue;
  }
  const asText = values.map((v) => JSON.stringify(v));
  if (new Set(asText).size !== 1) {
    problems.push(
      `${name} eltér:\n` + values.map((v, i) => `    ${PHONE_LANGS[i].padEnd(11)} ${asText[i]}`).join('\n'),
    );
  }
}

// A HOSZTNÉV-KIEGÉSZÍTÉS ELŐRE MEGADOTT LISTÁJA (PRESETS) mindhárom magban.
//
// Egy oldal felvételekor a gép és az Android ebből a térképből teszi a
// tiltásba a rokon hosztokat (a YouTube-hoz a youtu.be-t, az X-hez a
// twitter.com-ot), és a lista a hosztnév-jelekkel a szinkronon utazik. Ha az
// egyik magban egy sor hiányozna vagy elírnánk, ugyanaz a „YouTube” a gépen
// a rövid linket is zárná, a telefonon nem — és semmi nem hasalna el tőle.
// A kategória-csomagoknak saját fixtúrájuk van; ez a térkép eddig őrizetlen volt.
function presetMap(text, startNeedle, label) {
  const at = text.indexOf(startNeedle);
  if (at < 0) return { missing: label };
  // A térkép a deklarációtól az első üres sorig tart (mindhárom fájlban így áll).
  const rest = text.slice(at);
  const end = rest.search(/\n\s*\n/);
  const body = end < 0 ? rest : rest.slice(0, end);
  const out = {};
  const re = /["']([a-z0-9.-]+)["']\s*(?::|to)\s*(?:listOf\(|\[)([^\])]*)[\])]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    out[m[1]] = [...m[2].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
  }
  return Object.keys(out).length ? out : { missing: `${label} (üres térkép)` };
}
const PRESET_MAPS = [
  presetMap(read('desktop/src/shared/blocklist.ts'), 'export const PRESETS', 'ts'),
  presetMap(read('android/app/src/main/java/hu/breaker/app/core/Blocklist.kt'), 'val PRESETS', 'kt'),
  presetMap(read('ios/Shared/Blocklist.swift'), 'static let presets', 'swift'),
];
{
  const missing = PRESET_MAPS.filter((x) => x.missing).map((x) => x.missing);
  if (missing.length) {
    problems.push(`PRESETS: nem található itt: ${missing.join(', ')} — a minta elavult vagy a térkép eltűnt`);
  } else {
    const asText = PRESET_MAPS.map((x) => JSON.stringify(Object.keys(x).sort().map((k) => [k, x[k]])));
    if (new Set(asText).size !== 1) {
      problems.push('PRESETS eltér:\n' + asText.map((t, i) => `    ${LANGS[i].padEnd(11)} ${t}`).join('\n'));
    }
  }
}

// A KÖZÖS MAG NEM RENDEZ A GÉP NYELVI BEÁLLÍTÁSA SZERINT.
//
// A `localeCompare` a futtató gép nyelvét követi: magyar beállításon a „cs”,
// a „ny”, a „sz” külön betű, tehát a „cz.hu” a „csak.hu” elé kerül — a két
// telefon kódegység szerint rendez, és ugyanaz a hét két eszközön két sort
// mondott. A Java `toLowerCase()`-e ugyanígy nyelvfüggő (a török i), a Swift
// `localized…` hívásai is. A magban ezek tilosak; a felület (renderer,
// bővítmény-beállítások) rendezhet nyelv szerint, mert az nem utazik.
const LOCALE_BANS = [
  { dir: 'desktop/src/shared', ext: '.ts', needles: ['localeCompare(', 'Intl.Collator', 'toLocaleLowerCase(', 'toLocaleUpperCase(', 'toLocaleString(', 'toLocaleDateString(', 'toLocaleTimeString('] },
  // A Kotlin-magban a naptár is kimondott: `GregorianCalendar()`. Androidon a
  // `Calendar.getInstance()` amúgy is gregorián (a platform így szűkíti), de a
  // mag a JVM-en is fut (a tesztek), ahol thai nyelven buddhista naptárt ad.
  { dir: 'android/app/src/main/java/hu/breaker/app/core', ext: '.kt', needles: ['.toLowerCase()', '.toUpperCase()', 'Collator', 'CASE_INSENSITIVE_ORDER', 'Calendar.getInstance('] },
  // A Swift-magban a `Calendar.current` a felhasználó naptárát követi
  // (buddhista: 2569, japán: 8) — a napkulcs a szinkron nyelve, gregorián.
  { dir: 'ios/Shared', ext: '.swift', needles: ['localizedCompare', 'localizedStandardCompare', 'caseInsensitiveCompare', 'localizedLowercase', 'localizedUppercase', 'lowercased(with:', 'uppercased(with:', 'Calendar.current', 'Calendar.autoupdatingCurrent'] },
];
function walk(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(rel, ext));
    else if (e.name.endsWith(ext)) out.push(rel);
  }
  return out;
}
let localeFiles = 0;
// A Kotlin `format` a készülék nyelvével formáz (arab nyelven nem latin
// számjegyet ír): a magban az első argumentuma mindig `Locale.ROOT`.
function kotlinFormatProblems(rel, text) {
  const out = [];
  const re = /\.format\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const line = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index).trim();
    if (line.startsWith('//') || line.startsWith('*')) continue;
    const after = text.slice(m.index + m[0].length).trimStart();
    if (!/^(java\.util\.)?Locale\.ROOT\b/.test(after)) {
      out.push(`${rel}:${text.slice(0, m.index).split('\n').length}: a format nyelvfüggő (az első argumentuma nem Locale.ROOT) — arab nyelven nem latin számjegyet írna`);
    }
  }
  return out;
}
for (const ban of LOCALE_BANS) {
  for (const rel of walk(ban.dir, ban.ext)) {
    localeFiles++;
    const whole = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (ban.ext === '.kt') problems.push(...kotlinFormatProblems(rel, whole));
    const lines = whole.split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      for (const n of ban.needles) {
        if (line.includes(n)) problems.push(`${rel}:${i + 1}: nyelv- vagy naptárfüggő hívás a közös magban (${n}) — a rendezés, a kisbetű vagy a dátum a készülék beállítását követné, a többi eszközét nem`);
      }
    });
  }
}

// A kilépés az ÖSSZES ellenőrzés után áll. Korábban a két telefon közötti
// párok és feliratok a kilépés után gyűltek, és sosem buktattak — egy
// elnyelt eltérés rosszabb, mint egy hiányzó ellenőrzés, mert biztonságot
// mutat, amit nem ad.
if (problems.length) {
  console.error('A három mag szétcsúszott:\n');
  for (const p of problems) console.error('  ' + p + '\n');
  console.error('A TypeScript a referencia (desktop/src/shared) — ahhoz kell igazítani a másik kettőt.');
  process.exit(1);
}

console.log(`mag-szinkron OK (${CHECKS.length + ALPHABETS.length} érték egyezik mindhárom nyelven, ${PAIRS.length} a gép és az Android között, ${PHONE_PAIRS.length} a két telefon között, ${EXT_PAIRS.length} a gép és a bővítmény között; ${localeFiles} magfájl nyelvfüggő hívás nélkül; a hosztnév-kiegészítés ${Object.keys(PRESET_MAPS[0]).length} sora mindhárom magban)`);
