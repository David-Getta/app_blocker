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
  {
    name: 'bővítmény felugró lapja',
    html: 'extension/popup.html',
    code: ['extension/popup.js'],
  },
];

const problems = [];
/** Amire a kód hivatkozik, de a jelölésben nincs. */
const missing = [];

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

// A MÁSIK IRÁNY: a kód olyan azonosítóra hivatkozik, ami a jelölésben nincs.
//
// Ez rosszabb, mint a kezelő nélküli gomb: a `$('valami')` `null`-t ad,
// és a `null.textContent` KIVÉTELT dob. Egy elgépelt vagy átnevezett
// azonosító így nem egy funkciót visz el, hanem a felület egész
// megjelenítését — attól a ponttól semmi nem rajzolódik ki.
//
// Fordítás nem fogja ki: a `getElementById` visszatérési típusa itt
// `HTMLElement`, nem `HTMLElement | null`, mert a segédfüggvény ezt így
// ígéri. Az ígéretet viszont senki nem tartatta be — mostantól igen.
for (const surface of SURFACES) {
  const htmlPath = path.join(ROOT, surface.html);
  if (!fs.existsSync(htmlPath)) continue;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const file of surface.code) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;
    const code = fs.readFileSync(full, 'utf8');
    // Csak a `$('...')` és a `getElementById('...')` alakot nézzük: ezek
    // ígérik, hogy az elem LÉTEZIK. Egy `querySelector` nem ígér semmit.
    for (const m of code.matchAll(/(?:\$(?:<[^>]*>)?|getElementById)\(\s*'([^']+)'\s*\)/g)) {
      const id = m[1];
      if (ids.has(id)) continue;
      missing.push({ file, id, html: surface.html });
    }
  }
}

if (missing.length > 0) {
  console.error('A kód olyan azonosítót keres, ami a jelölésben nincs:\n');
  for (const m of missing) console.error(`  ${m.file}: #${m.id} (nincs a ${m.html}-ben)`);
  console.error('\nEz futásidejű kivétel: a keresés null-t ad, és attól a ponttól');
  console.error('a felület nem rajzolódik tovább. Egy átnevezés ennyibe kerül.');
  process.exit(1);
}

if (problems.length === 0) {
  console.log('felület-huzalozás OK (kezelők és azonosítók is a helyükön)');
  process.exit(0);
}

console.error('Kezelő nélküli gomb(ok) — rájuk kattintva nem történik semmi:\n');
for (const p of problems) console.error(`  ${p.file}: #${p.id}`);
console.error('\nEz a felület legcsendesebb hibája: semmi nem hibázik, a funkció mégis');
console.error('elérhetetlen. Vagy legyen kezelője, vagy ne legyen azonosítója.');
process.exit(1);
