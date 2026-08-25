#!/usr/bin/env node
// Van-e olyan gomb a felületen, amihez nem tartozik kezelő.
//
// MIÉRT LÉTEZIK. Az „Új csomag” gomb hónapokig ott volt a felületen, és
// rákattintva NEM TÖRTÉNT SEMMI: a HTML-be bekerült, a `renderer.ts`-be nem.
// Ez a legcsendesebb hibafajta, amit egy felület produkálni tud — semmi nem
// hibázik, semmi nem naplózódik, az app hibátlannak látszik, a funkció meg
// elérhetetlen. Aki nem tudja, hogy ott kellene megnyílnia valaminek, azt
// hiszi, az app romlott el.
//
// A szabály: ha egy gombnak azonosítója van, akkor tartozzon hozzá KEZELŐ.
//
// Nem elég, hogy a kód HIVATKOZIK rá. Az első változat ezt nézte, és pont egy
// olyan gombot engedett át, amit a felület kirajzolt (feliratot írt bele), de
// kattintani nem lehetett rajta. A megjelenítés és a kezelő két külön dolog;
// itt az utóbbit keressük.
//
// Futtatás: node scripts/check-ui-wiring.js

const fs = require('fs');
const path = require('path');

const ROOT = __dirname.replace(/\/scripts$/, '');

/** Egy felület: a jelölő és a kód, ami életre kelti. */
const SURFACES = [
  {
    name: 'asztali app',
    html: 'desktop/src/renderer/index.html',
    code: ['desktop/src/renderer/renderer.ts'],
  },
  {
    name: 'gyorsbillentyűs réteg',
    html: 'desktop/src/renderer/overlay.html',
    code: ['desktop/src/renderer/overlay.ts'],
  },
  {
    name: 'bővítmény',
    html: 'extension/options.html',
    code: ['extension/options.js'],
  },
];

const problems = [];

for (const surface of SURFACES) {
  const htmlPath = path.join(ROOT, surface.html);
  if (!fs.existsSync(htmlPath)) continue;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const code = surface.code
    .map((f) => path.join(ROOT, f))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');

  const lines = code.split('\n');

  // Csak a GOMBOKAT nézzük. A megjelenítésre használt elemek (szövegdobozok,
  // sávok) azonosítója attól még jó, hogy nincs rájuk kattintás-kezelő.
  for (const m of html.matchAll(/<button\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const id = m[1];
    // A `type="submit"` gomb az ŰRLAPOT küldi el: annak a kezelője az űrlapon
    // van, nem a gombon.
    if (/type="submit"/.test(m[0])) continue;
    if (!isWired(id, code, lines)) {
      problems.push({ surface: surface.name, file: surface.html, id });
    }
  }
}

/**
 * Van-e a gombhoz kezelő.
 *
 * Két bevett alak fordul elő a kódban, és mindkettőt el kell fogadni:
 *
 *   $('gomb').addEventListener('click', ...)      — közvetlenül;
 *   const b = $('gomb'); ... b.addEventListener   — változón keresztül.
 *
 * A második miatt nem elég egy sort nézni: a hivatkozás sorát megjegyezzük, és
 * ha ott változóba megy, akkor a változóra keresünk kezelőt.
 */
function isWired(id, code, lines) {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ref = new RegExp(`['"\`]${esc}['"\`]|#${esc}\\b`);
  const vars = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!ref.test(lines[i])) continue;
    // Négy sor, mert a kezelő gyakran a következő sorban kezdődik.
    if (/addEventListener|\.onclick\s*=/.test(lines.slice(i, i + 4).join('\n'))) return true;
    const asg = lines[i].match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/);
    if (asg) vars.push(asg[1]);
  }
  return vars.some((v) => new RegExp(`\\b${v}\\.(addEventListener|onclick)`).test(code));
}

if (problems.length === 0) {
  console.log('felület-huzalozás OK (minden gombhoz tartozik kezelő)');
  process.exit(0);
}

console.error('Kezelő nélküli gomb(ok) — rájuk kattintva nem történik semmi:\n');
for (const p of problems) console.error(`  ${p.file}: #${p.id}`);
console.error('\nEz a felület legcsendesebb hibája: semmi nem hibázik, a funkció mégis');
console.error('elérhetetlen. Vagy legyen kezelője, vagy ne legyen azonosítója.');
process.exit(1);
