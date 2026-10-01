#!/usr/bin/env node
// Mind az őrök egy parancsban — ugyanazok, amiket a CI lépésenként futtat.
//
// MIÉRT LÉTEZIK. Az őrök (check-*.js) egyenként futtathatók, és pont ezért
// marad ki néha egy: egy kódsor átírása után a huzalozás-őr még a régi alakot
// kereste, és a CI ezen bukott el — helyben csak a szöveg-ellenőrzés futott le.
// Ez a parancs a mappában lévő ÖSSZES őrt futtatja (az újonnan felvetteket is,
// felsorolás nélkül), és kimondja, melyik bukott.
//
// És egy második őr is: minden check-*.js-nek ott kell lennie a CI-ban. Egy új
// őr, amit senki nem futtat, nem őr — és semmi nem jelezné, hogy kimaradt.
//
//   node scripts/check-all.js            — minden őr + a CI-lefedettség
//   node scripts/check-all.js --ci-only  — csak a CI-lefedettség (a CI ezt futtatja)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const self = path.basename(__filename);
const guards = fs.readdirSync(__dirname)
  .filter((f) => /^check-[a-z-]+\.js$/.test(f) && f !== self)
  .sort();

const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const notInCi = guards.filter((g) => !ci.includes(`node scripts/${g}`));

let failed = 0;
if (!process.argv.includes('--ci-only')) {
  for (const g of guards) {
    const r = spawnSync(process.execPath, [path.join(__dirname, g)], { cwd: root, encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    if (r.status === 0) {
      const last = out.split('\n').pop() ?? '';
      console.log(`OK    ${g} — ${last}`);
    } else {
      failed++;
      console.log(`HIBA  ${g}\n${out.split('\n').map((l) => `      ${l}`).join('\n')}`);
    }
  }
}

if (notInCi.length > 0) {
  console.log(`\nA CI nem futtatja ezeket az őröket: ${notInCi.join(', ')}`);
  console.log('Vedd fel őket a .github/workflows/ci.yml szöveg-ellenőrző lépései közé.');
}

if (failed > 0 || notInCi.length > 0) process.exit(1);
console.log(process.argv.includes('--ci-only')
  ? `őr-lefedettség OK (mind a ${guards.length} őr fut a CI-ban)`
  : `\nmind a ${guards.length} őr zöld, és mind fut a CI-ban`);
