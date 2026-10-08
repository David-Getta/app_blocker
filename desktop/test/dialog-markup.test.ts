// A párbeszéd-ablakok és a választó-csipek jelölése a felolvasónak.
//
// Az akadálymentességi próba (scripts/a11y-check.js) csak azt az ablakot látja,
// amit a füstpróba kinyit. Ez a teszt a forrást nézi: egy új modál vagy egy
// új csip ne kerülhesse meg a közös segédet — attól nem hasalna el semmi, csak
// a felolvasó kapna egy cím nélküli dobozt, vagy egy csak színből látszó
// választást.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// A lefordított teszt a dist-test/test alatt fut — a desktop mappa két szinttel feljebb.
const RENDERER = join(__dirname, '..', '..', 'src', 'renderer');
const ts = readFileSync(join(RENDERER, 'renderer.ts'), 'utf8');
const html = readFileSync(join(RENDERER, 'index.html'), 'utf8');

/** A dialog() segéd törzse — ott, és csak ott, készülhet modál h()-val. */
function dialogHelperBody(): string {
  const start = ts.indexOf('function dialog(cls: string, title: string)');
  assert.ok(start > 0, 'nincs dialog() segéd a renderer.ts-ben');
  return ts.slice(start, ts.indexOf('\n}\n', start));
}

test('minden dinamikus modál a dialog() segéden át készül', () => {
  const helper = dialogHelperBody();
  assert.ok(helper.includes("setAttribute('role', 'dialog')"));
  assert.ok(helper.includes("setAttribute('aria-modal', 'true')"));
  assert.ok(helper.includes("setAttribute('aria-labelledby', head.id)"));
  const outside = ts.replace(helper, '');
  const stray = outside.match(/h\('div', 'modal(?: [\w-]+)*'\)/g) ?? [];
  assert.deepEqual(stray, [], 'modál a dialog() megkerülésével: a felolvasónak cím nélküli doboz');
  assert.ok((ts.match(/= dialog\('modal/g) ?? []).length >= 12, 'kevesebb modál ment át a segéden, mint ahány van');
});

test('a statikus modálok is dialógusok, a címükkel', () => {
  const modals = html.match(/<div class="modal(?: [\w-]+)*"[^>]*>/g) ?? [];
  assert.ok(modals.length >= 2, 'a szünet és a próbatétel ablaka hiányzik');
  for (const tag of modals) {
    assert.ok(tag.includes('role="dialog"'), `role nélkül: ${tag}`);
    assert.ok(tag.includes('aria-modal="true"'), `aria-modal nélkül: ${tag}`);
    const id = tag.match(/aria-labelledby="([^"]+)"/)?.[1];
    assert.ok(id, `cím nélkül: ${tag}`);
    assert.ok(html.includes(`id="${id}"`), `a cím (${id}) nincs a lapon`);
  }
});

test('a választó-csip állapota a felolvasónak is szól (setOn: aria-pressed)', () => {
  const start = ts.indexOf('function setOn(el: Element, on: boolean)');
  assert.ok(start > 0, 'nincs setOn() segéd');
  const body = ts.slice(start, ts.indexOf('\n}\n', start));
  assert.ok(body.includes("setAttribute('aria-pressed'"));
  const outside = ts.replace(body, '');
  assert.ok(!outside.includes("classList.toggle('chip-on'"),
    'csip-állapot a setOn() megkerülésével: a kiválasztás csak színből látszana');
});

test('a próbatétel minden beviteli mezőjének van neve', () => {
  for (const name of ['Az átgépelt szöveg', 'Az eredmény', 'A kód emlékezetből', 'A mondat visszafelé']) {
    assert.ok(ts.includes(`setAttribute('aria-label', '${name}')`), `hiányzik: ${name}`);
  }
  assert.ok(ts.includes("setAttribute('aria-label', `${name} jelmondata`)"), 'a megbízott mezője név nélkül');
});
