// A párbeszéd-ablakok és a választó-csipek jelölése a felolvasónak.
//
// Az akadálymentességi próba (scripts/a11y-check.js) csak azt az ablakot látja,
// amit a füstpróba kinyit. Ez a teszt a forrást nézi: egy új modál vagy egy
// új csip ne kerülhesse meg a közös segédet — attól nem hasalna el semmi, csak
// a felolvasó kapna egy cím nélküli dobozt, egy csak színből látszó
// választást, vagy a billentyűzetes felhasználó egy ablakot, amiből a Tab a
// takart lapra szökik.

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

test('minden dinamikus ablak a mountDialog() segéden át kerül a lapra (fókusz, Tab-kör, Esc)', () => {
  const start = ts.indexOf('function mountDialog(overlay: HTMLElement, cancel?: HTMLElement)');
  assert.ok(start > 0, 'nincs mountDialog() segéd');
  const body = ts.slice(start, ts.indexOf('\n}\n', start));
  assert.ok(body.includes('trapDialog(overlay, cancel)'));
  const outside = ts.replace(body, '');
  assert.ok(!outside.includes('document.body.appendChild(overlay)'),
    'ablak a mountDialog() megkerülésével: a fókusz a takart lapon maradna');
  // Esc nélkül csak a megbízott jelmondata nyílik: az csak egyszer látszik.
  const noCancel = outside.match(/mountDialog\(overlay\);/g) ?? [];
  assert.equal(noCancel.length, 1, 'Esc nélküli ablak a jelmondaton kívül is');
});

test('a statikus ablakok is a fókusz-csapdán át nyílnak, és a frissítés nem viszi el a fókuszt', () => {
  assert.ok(ts.includes("releasePause ??= trapDialog($('pauseDialog'), $('pauseCancel'));"));
  assert.ok(ts.includes("releaseSession ??= trapDialog($('sessionModal'));"));
  assert.ok(/const focusMark = markOf\(document\.activeElement\);[\s\S]*restoreFocus\(focusMark\);\n\}/.test(ts),
    'a render() nem állítja vissza a fókuszt: a lista kétmásodpercenként elvinné');
  for (const m of html.match(/<div class="modal(?: [\w-]+)*"[^>]*>/g) ?? []) {
    assert.ok(m.includes('tabindex="-1"'), `nyitáskor nem fókuszálható: ${m}`);
  }
});

test('a hiba a felolvasónak is: minden ablaknak saját bejelentője van, a lapnak közös', () => {
  const helper = dialogHelperBody();
  assert.ok(helper.includes('modal.appendChild(announcerRegion())'), 'a dinamikus ablaknak nincs bejelentője');
  for (const tag of html.match(/<div class="modal(?: [\w-]+)*"[^>]*>[\s\S]*?<div class="modal-actions">/g) ?? []) {
    assert.ok(tag.includes('data-announcer'), `a statikus ablakból hiányzik a bejelentő: ${tag.slice(0, 80)}`);
  }
  assert.ok(/<div id="announcer"[^>]*aria-live="assertive"/.test(html), 'nincs közös bejelentő a lapon');
  assert.ok(ts.includes('\nwatchErrors();\n'), 'a hibafigyelő nem indul el');
});

test('a fejléc állapotjelzője élő régió, és csak változáskor íródik (setLive)', () => {
  assert.ok(/<div id="statusPill"[^>]*role="status"/.test(html));
  const start = ts.indexOf('function render(): void {');
  const body = ts.slice(start, ts.indexOf('\n}\n', start));
  assert.ok(!/pill\.textContent\s*=/.test(body),
    'az állapotjelző közvetlenül íródik: a kétmásodperces frissítés a felolvasóval újra és újra elmondatná');
});
