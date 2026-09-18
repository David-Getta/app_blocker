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

if (problems.length) {
  console.error('A három mag szétcsúszott:\n');
  for (const p of problems) console.error('  ' + p + '\n');
  console.error('A TypeScript a referencia (desktop/src/shared) — ahhoz kell igazítani a másik kettőt.');
  process.exit(1);
}

const PHONE_LANGS = ['Kotlin', 'Swift'];
for (const [name, kotlinLabel, swiftLabel] of PHONE_LABELS) {
  // A két nyelv a behelyettesítést másképp írja ($hour / \(hour)); a váz ugyanaz kell legyen.
  const norm = (t) => (t || '').replace(/\$\{[^}]+\}|\$[a-z]+|\\\([^)]*\)/g, '#');
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

console.log(`mag-szinkron OK (${CHECKS.length + ALPHABETS.length} érték egyezik mindhárom nyelven, ${PAIRS.length} a gép és az Android között, ${PHONE_PAIRS.length} a két telefon között)`);
