// Az indítási füstpróba (src/main/smoke.ts) feltételei. A próbát magát a CI
// futtatja egy valódi Electronon; itt az a három dolog van, amin a próba
// csendben elcsúszhatna: a jelző, a várt szöveg, és hogy elég KORÁN élesedik-e.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isSmoke, SMOKE_FLAG, versionRowText } from '../src/shared/smoke';

// A lefordított teszt a dist-test/test alatt fut — a forrás két szinttel feljebb.
const SRC = join(__dirname, '..', '..', 'src');

test('a próba csak a saját jelzőjére indul', () => {
  assert.equal(SMOKE_FLAG, '--smoke-test');
  assert.equal(isSmoke(['electron', '.', '--smoke-test']), true);
  assert.equal(isSmoke(['electron', '.', '--smoke-test=1']), false);
  assert.equal(isSmoke(['electron', '.', '--background']), false);
  assert.equal(isSmoke([]), false);
});

test('a felület ugyanazt a verzió-sort írja ki, amit a próba vár', () => {
  assert.equal(versionRowText('0.4.241'), 'Breaker v0.4.241');
  const renderer = readFileSync(join(SRC, 'renderer', 'renderer.ts'), 'utf8');
  // Ha a felület máshonnan (vagy kézzel) írná a sort, a próba egy hibátlan
  // appra is piros lenne — vagy valaki a próbát lazítaná „javításként”.
  assert.match(renderer, /\$\('appVersionRow'\)\.textContent = versionRowText\(v\);/);
  const smoke = readFileSync(join(SRC, 'main', 'smoke.ts'), 'utf8');
  assert.match(smoke, /const want = versionRowText\(app\.getVersion\(\)\);/);
});

test('a próba a fő folyamat ELSŐ importja — a többi modul betöltési hibáját is elkapja', () => {
  const main = readFileSync(join(SRC, 'main', 'main.ts'), 'utf8');
  const first = main.split('\n').find((l) => /^import\s/.test(l));
  // Egy később importált modul, ha betöltéskor elhasal, párbeszédablakot nyitna
  // — a CI-ban azt senki nem kattintja el, és a lépés az időkorlátjáig állna.
  assert.equal(first, "import { isSmoke, watchSmoke } from './smoke';");
});
