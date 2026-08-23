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

/** "10 * 60_000" -> 600000. Csak összeadás/szorzás és számliterál. */
function evalNumber(expr) {
  const cleaned = expr.replace(/_/g, '').replace(/[LlfFdD]\b/g, '').trim();
  if (!/^[\d\s*+.()-]+$/.test(cleaned)) return NaN;
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${cleaned});`)();
}

function numbersIn(text) {
  return (text.match(/-?\d[\d_]*(?:\.\d+)?/g) || []).map((n) => Number(n.replace(/_/g, '')));
}

// ---------------------------------------------------------------- kinyerés

const ts = {
  challenges: read('desktop/src/shared/challenges.ts'),
  referee: read('desktop/src/helper/referee.ts'),
  protocol: read('desktop/src/shared/protocol.ts'),
};
const kt = {
  engine: read('android/app/src/main/java/hu/breaker/app/core/ChallengeEngine.kt'),
  referee: read('android/app/src/main/java/hu/breaker/app/core/Referee.kt'),
};
const sw = {
  engine: read('ios/Shared/ChallengeEngine.swift'),
  referee: read('ios/Shared/Referee.swift'),
};

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
];

// A kódábécé nem szám, de ha eltér, a memória-próba más jeleket adna.
const ALPHABETS = [
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

console.log(`mag-szinkron OK (${CHECKS.length + ALPHABETS.length} érték egyezik mindhárom nyelven)`);
