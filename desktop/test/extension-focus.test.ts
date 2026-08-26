// A bővítmény fehérlista-döntése és az appé UGYANAZT kell mondja.
//
// A gépen a munkamenet fehérlistáját KIZÁRÓLAG a böngésző-bővítmény tudja
// betartatni, tehát a `focusAllows` az, ami tényleg dönt. Az appban ott van
// ugyanez `isSiteAllowed` néven — a mag, amit a Kotlin és a Swift is tükröz, és
// amit a tesztek fednek.
//
// A kettő KÜLÖN megvalósítás, mert máshol fut: a bővítményben nincs fordítás, a
// segédben TypeScript van. Ha szétcsúsznak, az a legcsendesebb elromlás, amit
// ez a funkció produkálni tud: a csomagban ott a `google.com`, a böngésző mégis
// átengedi a `notgoogle.com`-ot — vagy fordítva, kizárja a
// `translate.google.com`-ot, és a munkamenet használhatatlan lesz.
//
// A KÖZÖS pontjuk ez a táblázat. Nem a két kódot hasonlítjuk össze, hanem a
// VÁLASZAIKAT ugyanarra a kérdésre.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { isSiteAllowed, type FocusPack } from '../src/shared/focus';

/**
 * A bővítmény mappája — a `__dirname`-től felfelé keresve.
 *
 * A tesztek kétféleképpen futnak: forrásból és a fordított kimenetből. Egy fix
 * relatív út az egyikben jó lenne, a másikban némán rossz fájlt keresne.
 */
function extensionDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'extension');
    if (fs.existsSync(path.join(candidate, 'app-link.js'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('nem talalom az extension/ mappat');
}

/**
 * A ténylegesen KISZÁLLÍTOTT `focusAllows` betöltése.
 *
 * A fájlt beolvassuk és lefuttatjuk, nem egy másolatát: így a teszt azokat a
 * bájtokat hajtja végre, amik a felhasználó böngészőjébe kerülnek.
 */
function loadFocusAllows(): (link: unknown, host: string) => boolean {
  const src = fs.readFileSync(path.join(extensionDir(), 'app-link.js'), 'utf8');
  const m = src.match(/export function focusAllows\(link, host\) \{[\s\S]*?\n\}/);
  if (!m) throw new Error('a bővítményben nincs focusAllows');
  const body = m[0].replace('export function', 'function');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn focusAllows;`)() as (link: unknown, host: string) => boolean;
}

const focusAllows = loadFocusAllows();

const pack = (sites: string[]): FocusPack => ({
  id: 'p1', name: 'Teszt', allowSites: sites, allowApps: [], defaultMinutes: 50,
});

/**
 * A kérdések. A megtévesztő eseteket SZÁNDÉKOSAN túlsúlyozzuk: a végén
 * hasonlító tartománynév a leggyakoribb megkerülési kísérlet, és ha a két
 * oldal ott csúszik szét, azt semmi más nem fogja ki.
 */
const CASES: { allow: string[]; host: string }[] = [
  { allow: ['google.com'], host: 'google.com' },
  { allow: ['google.com'], host: 'translate.google.com' },
  { allow: ['google.com'], host: 'a.b.google.com' },
  { allow: ['google.com'], host: 'notgoogle.com' },
  { allow: ['google.com'], host: 'google.com.evil.example' },
  { allow: ['google.com'], host: 'GOOGLE.COM' },
  { allow: ['google.com'], host: 'google.com.' },
  { allow: ['google.com'], host: '  google.com  ' },
  { allow: ['google.com'], host: '' },
  { allow: ['google.com'], host: '   ' },
  { allow: [], host: 'google.com' },
  { allow: ['quizlet.com', 'github.com'], host: 'github.com' },
  { allow: ['quizlet.com', 'github.com'], host: 'gist.github.com' },
  { allow: ['quizlet.com', 'github.com'], host: 'reddit.com' },
  { allow: ['co.uk'], host: 'valami.co.uk' },
  { allow: ['a.example'], host: 'example' },
];

test('the extension and the app agree on every whitelist question', () => {
  for (const c of CASES) {
    const mine = isSiteAllowed(pack(c.allow), c.host);
    const theirs = focusAllows({ focus: { allowSites: c.allow } }, c.host);
    assert.equal(
      theirs, mine,
      `szétcsúsztak: engedve=${JSON.stringify(c.allow)} host=${JSON.stringify(c.host)} `
      + `— app: ${mine}, bővítmény: ${theirs}`,
    );
  }
});

test('a hiányzó munkamenet-blokk nem enged át semmit', () => {
  // Fail-closed: ha a bővítmény nem kapott fehérlistát, az nem azt jelenti,
  // hogy minden mehet. A hívó dönti el, hogy fut-e menet; ez a függvény csak
  // annyit mond, hogy EZ a hoszt rajta van-e a listán.
  for (const link of [undefined, null, {}, { focus: {} }, { focus: { allowSites: null } }]) {
    assert.equal(focusAllows(link, 'google.com'), false);
  }
});
