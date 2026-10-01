#!/usr/bin/env node
// A bővítmény JS-e sehol nem fordul — ez az őr legalább a szintaxisát nézi.
//
// MIÉRT ŐR, ÉS NEM EGY SOR A CI-BAN. Eddig a CI egy beágyazott parancssorral
// futtatta ugyanezt, és pont ezért maradt ki helyben: a `check-all.js` csak a
// check-*.js őröket futtatja. Egy kétszer deklarált `const` a felugró lapon
// így csak a CI-ban derült ki (v0.4.210 előtt) — a desktop-tesztek, a
// végponti teszt és mind a hét őr zöld volt, mert a felugró lapot egyik sem
// töltötte be. Őrként a `check-all.js` is futtatja, felsorolás nélkül.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.resolve(__dirname, '..', 'extension');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
const bad = [];
for (const f of files) {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: fs.readFileSync(path.join(dir, f)), encoding: 'utf8',
  });
  if (r.status !== 0) bad.push(`extension/${f}\n${(r.stderr || '').trim().split('\n').slice(0, 6).join('\n')}`);
}
if (bad.length > 0) {
  console.error(`A bővítmény ${bad.length} fájlja nem is tölthető be:\n\n${bad.join('\n\n')}`);
  process.exit(1);
}
console.log(`bővítmény-szintaxis OK (${files.length} fájl modulként betölthető)`);
