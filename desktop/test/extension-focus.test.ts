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

/** Egy kiszállított `export function` szövege, név és fejléc szerint. */
function exportedFunction(src: string, head: string): string {
  const at = src.indexOf(`export function ${head} {`);
  if (at < 0) throw new Error(`a bővítményben nincs ${head}`);
  const end = src.indexOf('\n}', at);
  return src.slice(at, end + 2).replace('export function', 'function');
}

type Link = unknown;
interface Shipped {
  FOCUS_FRESH_MS: number;
  effectiveFocus: (link: Link, now?: number) => {
    name: string; endsAt: number; allowSites: string[]; window: boolean;
  } | null;
  focusAllows: (link: Link, host: string, now?: number) => boolean;
}

/**
 * A ténylegesen KISZÁLLÍTOTT `effectiveFocus` és `focusAllows` betöltése.
 *
 * A fájlt beolvassuk és lefuttatjuk, nem egy másolatát: így a teszt azokat a
 * bájtokat hajtja végre, amik a felhasználó böngészőjébe kerülnek.
 */
function loadShipped(): Shipped {
  const src = fs.readFileSync(path.join(extensionDir(), 'app-link.js'), 'utf8');
  const fresh = src.match(/export const FOCUS_FRESH_MS = [^;\n]+;/);
  if (!fresh) throw new Error('a bővítményben nincs FOCUS_FRESH_MS');
  const body = [
    fresh[0].replace('export const', 'const'),
    exportedFunction(src, 'appFresh(link, now = Date.now())'),
    exportedFunction(src, 'effectiveFocus(link, now = Date.now())'),
    exportedFunction(src, 'focusAllows(link, host, now = Date.now())'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn { FOCUS_FRESH_MS, effectiveFocus, focusAllows };`)() as Shipped;
}

const { FOCUS_FRESH_MS, effectiveFocus, focusAllows } = loadShipped();

/** Egy friss lehúzás egy futó menettel — ilyenkor az app élő szava dönt. */
const NOW = 1_700_000_000_000;
const running = (allowSites: unknown) => ({
  fetchedAt: NOW, focus: { running: true, name: 'Teszt', endsAt: NOW + 3600_000, allowSites },
});

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
    const theirs = focusAllows(running(c.allow), c.host, NOW);
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
  for (const link of [
    undefined, null, {}, { focus: {} }, { focus: { allowSites: null } }, running(null), running(undefined),
  ]) {
    assert.equal(focusAllows(link, 'google.com', NOW), false);
  }
});

// ---------------------------------------------------------------------------
// A heti ablak az app nélkül
// ---------------------------------------------------------------------------
//
// A heti ablak menetét a segéd az app nélkül is elindítja — a böngészőben
// viszont a bővítmény tartja be, és ő eddig csak az app élő szavából tudott
// róla. Az app egy hetet előre leküld; ha nem válaszol, ebből él a menet.

const win = (startsAt: number, endsAt: number, allowSites = ['github.com']) => ({
  packId: 'p1', name: 'Mély munka', allowSites, startsAt, endsAt,
});

test('amíg az app friss, az ő szava dönt — a tárolt ablak nem írja felül', () => {
  // Az app tudja, hogy az ablak menetét leállították (kifizetett próbatétellel):
  // ha a tárolt lista ilyenkor is élne, a leállítás a böngészőben nem érne semmit.
  const link = { fetchedAt: NOW, focus: { running: false, windows: [win(NOW - 60_000, NOW + 3600_000)] } };
  assert.equal(effectiveFocus(link, NOW), null);
  assert.equal(effectiveFocus(link, NOW + FOCUS_FRESH_MS), null, 'a határon még friss');
  assert.equal(focusAllows(link, 'github.com', NOW), false);
});

test('ha az app hallgat, a most tartó ablak él a böngészőben', () => {
  const link = { fetchedAt: NOW, focus: { running: false, windows: [win(NOW + 3600_000, NOW + 7200_000)] } };
  const later = NOW + 3600_000 + 5 * 60_000;
  const eff = effectiveFocus(link, later);
  assert.deepEqual(eff, { name: 'Mély munka', endsAt: NOW + 7200_000, allowSites: ['github.com'], window: true });
  assert.equal(focusAllows(link, 'github.com', later), true);
  assert.equal(focusAllows(link, 'gist.github.com', later), true);
  assert.equal(focusAllows(link, 'youtube.com', later), false);
  // A határok: a kezdés percében már, a vég percében már nem.
  assert.notEqual(effectiveFocus(link, NOW + 3600_000), null);
  assert.equal(effectiveFocus(link, NOW + 7200_000), null);
  assert.equal(effectiveFocus(link, NOW + 3600_000 - 1), null, 'előtte nincs');
});

test('app nélkül az ablak előbbre való, mint a tárolt kézi menet', () => {
  // A segéd az ablak kezdetén a kézi menetet lezárja és az ablakét indítja —
  // a böngésző ugyanezt teszi, különben a régi menet listája engedne át.
  const link = {
    fetchedAt: NOW,
    focus: {
      running: true, name: 'Kézi', endsAt: NOW + 3 * 3600_000, allowSites: ['youtube.com'],
      windows: [win(NOW + 3600_000, NOW + 7200_000)],
    },
  };
  const during = NOW + 3600_000 + 60_000;
  assert.equal(effectiveFocus(link, during)?.name, 'Mély munka');
  assert.equal(focusAllows(link, 'youtube.com', during), false);
  // Az ablak után a kézi menet a saját idejéig tart, ahogy eddig.
  assert.equal(effectiveFocus(link, NOW + 7200_000 + 60_000)?.name, 'Kézi');
  assert.equal(effectiveFocus(link, NOW + 3 * 3600_000), null);
});

test('soha nem lehúzott kapcsolatnál is a tárolt ablak dönt (nincs friss szó)', () => {
  const link = { fetchedAt: 0, focus: { running: false, windows: [win(NOW - 1, NOW + 60_000)] } };
  assert.equal(effectiveFocus(link, NOW)?.window, true);
  for (const bad of [{ fetchedAt: NaN }, { fetchedAt: -5 }, {}]) {
    assert.equal(effectiveFocus({ ...bad, focus: link.focus }, NOW)?.window, true);
  }
});
