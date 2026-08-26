// A letöltőoldal besorolása és hibaüzenetei.
//
// MIÉRT ÉR EZ TESZTET. Ez az a felület, amin keresztül az app egyáltalán
// eljut a felhasználóhoz. Ha itt valami csendben rossz, semmi nem hasal el:
// az oldal betöltődik, szépen néz ki, és vagy hiányzik róla egy letöltés,
// vagy azt írja ki, hogy nincs mit letölteni.
//
// Mindkettő MEGTÖRTÉNT MÁR:
//
//   - a böngésző-bővítmény zipje némán kiesett, mert a besorolás „ext”-et
//     adott, a gyűjtő meg eldobta, mert nem volt ilyen vödör;
//   - a hibaág minden esetre a „nincs még kiadás” mondatot írta ki, pedig a
//     leggyakoribb ok a GitHub kérés-korlátja.
//
// A teszt a KISZÁLLÍTOTT fájl bájtjait futtatja, nem egy másolatát.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

function downloadJs(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'website', 'download.js');
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
    dir = path.dirname(dir);
  }
  throw new Error('nem talalom a website/download.js fajlt');
}

const SRC = downloadJs();

/**
 * Egy függvény kiemelése a fájlból, futtatható alakban.
 *
 * A `deps` azok a nevek, amikre a függvény a fájl körül támaszkodik (a
 * `document`, a kiadások címe). Paraméterként adjuk át, nem a törzsbe írva:
 * így a KISZÁLLÍTOTT bájtok futnak, körülöttük egy szűk, hamis világgal.
 */
function extract<T>(name: string, deps: Record<string, unknown> = {}, extra = ''): T {
  const m = SRC.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`nincs ${name} a letöltőoldalon`);
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `${extra}\n${m[0]}\nreturn ${name};`);
  return factory(...names.map((k) => deps[k])) as T;
}

const classify = extract<(n: string) => { plat: string; label: string } | null>('classify');

/**
 * A v0.4.3 kiadás VALÓDI fájlnevei, és ahova tartozniuk kell.
 *
 * Nem kitalált nevek: ezeket állítja elő a kiadási folyamat. Ha a névadás
 * megváltozik és a besorolás nem követi, ez a teszt szól — nem a felhasználó,
 * aki hiába keresi a letöltését.
 */
const ASSETS: [string, string | null][] = [
  ['Breaker-v0.4.3.apk', 'android'],
  ['Breaker-v0.4.3.aab', null],                    // Play Store-feltöltés, nem végfelhasználónak
  ['Breaker-0.4.3-arm64.dmg', 'mac'],
  ['Breaker-0.4.3.dmg', 'mac'],
  ['Breaker-0.4.3-arm64-mac.zip', null],           // frissítés-csomag, nem kézi letöltés
  ['Breaker-0.4.3-mac.zip', null],
  ['Breaker-Setup-0.4.3.exe', 'win'],
  ['Breaker-bovitmeny-v0.4.3.zip', 'ext'],
  ['latest.yml', null],
  ['latest-mac.yml', null],
  ['Breaker-0.4.3.dmg.blockmap', null],
  ['Breaker-Setup-0.4.3.exe.blockmap', null],
];

test('minden kiadási fájl a helyére kerül', () => {
  for (const [name, plat] of ASSETS) {
    const got = classify(name);
    assert.equal(
      got?.plat ?? null, plat,
      `${name}: ${plat ?? 'nem kellene megjelennie'} helyett ${got?.plat ?? 'semmi'}`,
    );
  }
});

test('a két Mac-csomag KÜLÖN feliratot kap', () => {
  // Ránézésre ugyanaz a kettő, pedig a rossz meg sem nyílik. Ha ugyanazt a
  // feliratot kapnák, az Intel-gépes felhasználó ötven százalék eséllyel egy
  // olyan appot töltene le, ami el sem indul nála.
  const arm = classify('Breaker-0.4.3-arm64.dmg');
  const intel = classify('Breaker-0.4.3.dmg');
  assert.notEqual(arm?.label, intel?.label);
  assert.match(arm?.label ?? '', /szilícium|M1/i);
  assert.match(intel?.label ?? '', /Intel/i);
});

test('a bővítmény zipje NEM esik a „minden más” vödörbe', () => {
  // Ez a konkrét hiba egyszer már megtörtént: a fájl ott volt a kiadásban, a
  // besorolás is felismerte, csak épp senki nem gyűjtötte be.
  const ext = classify('Breaker-bovitmeny-v0.4.3.zip');
  assert.equal(ext?.plat, 'ext');
  assert.notEqual(ext?.plat, 'other');
});

test('minden vödör, amit a besorolás ad, létezik is a felületen', () => {
  // A NÉMA KIESÉS ŐRE. A gyűjtő a PLATFORMS kulcsaiból épül; ha a besorolás
  // olyan vödröt ad vissza, ami ott nincs, a fájl eltűnik — hiba nélkül.
  const plats = new Set<string>();
  for (const [name] of ASSETS) {
    const c = classify(name);
    if (c) plats.add(c.plat);
  }
  const m = SRC.match(/const PLATFORMS = \{([\s\S]*?)\n\};/);
  assert.ok(m, 'nem találom a PLATFORMS táblát');
  for (const plat of plats) {
    assert.ok(
      new RegExp(`\\b${plat}:`).test(m![1]),
      `a(z) „${plat}” vödröt a besorolás adja, de a PLATFORMS nem ismeri — `
      + 'az ilyen fájl NÉMÁN kiesik az oldalról',
    );
  }
});

test('a hibaüzenet nem mondja azt, hogy nincs kiadás, amikor van', () => {
  // A kérés-korlát a leggyakoribb ok. Ha erre a „még nincs kiadott verzió”
  // mondat jön, a látogató elmegy — pedig nyolc kiadás áll a másik oldalon.
  let html = '';
  const fakeDoc = { getElementById: () => ({ set innerHTML(v: string) { html = v; } }) };
  const renderError = extract<(k: string) => void>('renderError', {
    document: fakeDoc,
    RELEASES: 'https://example.invalid/releases',
    text_fallback: () => ['Nem sikerült lekérdezni a verziót', 'A kiadások oldalán megvan.'],
  });

  const cases: [string, RegExp, RegExp][] = [
    ['rate', /kérés-korlát/i, /nincs kiadott|nincs kiadás/i],
    ['off', /internetkapcsolat/i, /nincs kiadott|nincs kiadás/i],
    ['none', /nincs kiadott verzió/i, /kérés-korlát/i],
    ['', /nem sikerült/i, /nincs kiadott|nincs kiadás/i],
  ];
  for (const [kind, expected, forbidden] of cases) {
    html = '';
    renderError(kind);
    assert.match(html, expected, `„${kind}”: hiányzik a lényeg`);
    assert.doesNotMatch(html, forbidden, `„${kind}”: rossz mondatot ír ki`);
  }
});

test('a hibaüzenet mindig odavisz a kiadásokhoz', () => {
  // Bármi legyen az ok, a látogató NE zsákutcába érkezzen: egy link mindig
  // marad, ami a letöltésekhez visz.
  let html = '';
  const fakeDoc = { getElementById: () => ({ set innerHTML(v: string) { html = v; } }) };
  const renderError = extract<(k: string) => void>('renderError', {
    document: fakeDoc,
    RELEASES: 'https://example.invalid/releases',
    text_fallback: () => ['a', 'b'],
  });
  for (const kind of ['rate', 'off', 'none', 'ismeretlen']) {
    html = '';
    renderError(kind);
    assert.match(html, /https:\/\/example\.invalid\/releases/, `„${kind}”: nincs kiút`);
  }
});
