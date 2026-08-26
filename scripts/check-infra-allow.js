#!/usr/bin/env node
// A kivétellista maradjon SZŰK.
//
// MIÉRT LÉTEZIK. A munkamenet fehérlista: alatta minden tiltva. Egy telefon
// viszont, aminek MINDEN névfeloldása elhasal, nem korlátozott telefon, hanem
// használhatatlan — nem jön értesítés, a rendszer azt hiszi, nincs internet, és
// a felhasználó nem a beállítását hibáztatja, hanem az appot. Ezért van egy
// szűk, tételesen indokolt kivétellista (`INFRA_ALLOW` / `infraAllow`).
//
// EZ A LISTA AZ EGYETLEN SZÁNDÉKOS LYUK a fehérlistán. Ami rákerül, az a
// munkamenet alatt is átmegy — és a döntés VÉGZŐDÉS szerint illeszkedik
// (`h == it || h.endsWith(".$it")`). Vagyis egyetlen elgépelt sor,
// `google.com` a `mtalk.google.com` helyett, kinyitná a Gmailt, a Drive-ot, a
// Dokumentumokat és a YouTube-ot leszámítva gyakorlatilag mindent — pont azt,
// ami elől a felhasználó elzárta magát.
//
// Semmi nem hasalna el tőle. A fordítás jó, a tesztek zöldek, a munkamenet
// „fut”, és közben nem tilt.
//
// A KÉT LISTA SZÁNDÉKOSAN KÜLÖNBÖZIK: az androidos az értesítéshez a Google
// hosztjait engedi, az iPhone-os az Apple-éit. Ezért NEM a mag-szinkron őrzi
// őket (az azonos értékeket hasonlít), hanem ez: nem az egyezést nézzük, hanem
// hogy mindkettő szűk MARADJON.
//
// AMIT NEM FED: azt nem tudja megmondani, hogy egy bejegyzés INDOKOLT-e. Egy
// harmadik szintű, valódi hoszt felvétele ezen átmegy — az emberi bírálat
// helyett ez csak a nyilvánvaló tágítást zárja ki.
//
// Futtatás: node scripts/check-infra-allow.js

const fs = require('fs');
const path = require('path');

const ROOT = __dirname.replace(/\/scripts$/, '');

/** Ennél több tétel már nem „szűk kivétel”, hanem második fehérlista. */
const MAX_ENTRIES = 12;

/** Ennél kevesebb címkéből álló név egész tartományokat nyitna meg. */
const MIN_LABELS = 3;

const LISTS = [
  {
    name: 'Android',
    file: 'android/app/src/main/java/hu/breaker/app/core/Focus.kt',
    start: /val INFRA_ALLOW = listOf\(/,
  },
  {
    name: 'iPhone',
    file: 'ios/Shared/Focus.swift',
    start: /public static let infraAllow = \[/,
  },
];

/** A lista tételei — a nyitástól az első záró sorig, megjegyzések nélkül. */
function entriesOf(text, start) {
  const from = text.search(start);
  if (from < 0) return null;
  const rest = text.slice(from);
  // A blokk vége az első olyan sor, ami csak zárójelet tartalmaz.
  const end = rest.search(/\n\s*[)\]]\s*\n/);
  const body = end < 0 ? rest : rest.slice(0, end);
  return (body.match(/"[^"]*"/g) || []).map((s) => s.slice(1, -1));
}

const problems = [];
for (const list of LISTS) {
  const full = path.join(ROOT, list.file);
  if (!fs.existsSync(full)) {
    problems.push(`${list.name}: a fájl nincs meg (${list.file})`);
    continue;
  }
  const entries = entriesOf(fs.readFileSync(full, 'utf8'), list.start);
  if (entries === null) {
    problems.push(`${list.name}: nem találom a kivétellistát ${list.file}-ben`);
    continue;
  }
  if (entries.length === 0) {
    problems.push(`${list.name}: a kivétellista üres — ez nem lehet szándékos`);
    continue;
  }
  if (entries.length > MAX_ENTRIES) {
    problems.push(
      `${list.name}: ${entries.length} tétel a kivétellistán (legfeljebb ${MAX_ENTRIES}). `
      + 'Egy folyamatosan növő kivétel már nem kivétel, hanem második fehérlista.',
    );
  }
  for (const e of entries) {
    if (e !== e.toLowerCase() || e.trim() !== e) {
      problems.push(`${list.name}: „${e}” nem tiszta kisbetűs név`);
    }
    if (/[*?/\\ :]/.test(e) || e.startsWith('.') || e.endsWith('.')) {
      problems.push(`${list.name}: „${e}” nem egy sima hosztnév`);
    }
    const labels = e.split('.').filter(Boolean);
    if (labels.length < MIN_LABELS) {
      problems.push(
        `${list.name}: „${e}” CSAK ${labels.length} címkéből áll. `
        + 'A döntés végződés szerint illeszkedik, tehát ez az egész tartományt '
        + 'megnyitná a munkamenet alatt — mindent, ami alatta van.',
      );
    }
  }
  // Egy tétel ne fedjen le egy másikat: a redundancia rendszerint úgy
  // keletkezik, hogy valaki KITÁGÍTOTT egy meglévő sort, és a régi ottmaradt.
  for (const a of entries) {
    for (const b of entries) {
      if (a !== b && (b === a || b.endsWith(`.${a}`))) {
        problems.push(`${list.name}: „${a}” már lefedi „${b}”-t — az egyik fölösleges`);
      }
    }
  }
}

if (problems.length === 0) {
  const total = LISTS.length;
  console.log(`kivétellista OK (${total} platform, mindkettő szűk és tételes)`);
  process.exit(0);
}

console.error('A munkamenet kivétellistája nem szűk:\n');
for (const p of problems) console.error(`  ${p}`);
console.error('\nEz az EGYETLEN szándékos lyuk a fehérlistán. Ami rákerül, az a');
console.error('munkamenet alatt is átmegy — és semmi nem hasal el tőle.');
process.exit(1);
