// A munkamenet-figyelés bekötése: a mérő jele, a fő folyamat, a réteg.
//
// A tét: a böngésző eddig appként esett a figyelés alá, és aki a csomag
// engedett oldalán dolgozott, hárompercenként azt kapta, hogy a böngésző
// „nincs a listán”. A mag (foregroundWarning) tesztje a focus.test.ts-ben van;
// ez azt nézi, hogy a három darab tényleg össze van-e kötve.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/** Egy forrásfájl a tesztek mellől — forrásból és fordított kimenetből is. */
function source(rel: string): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
    dir = path.dirname(dir);
  }
  throw new Error(`nem találom: ${rel}`);
}

test('a mérő megjelöli a böngészőt — akkor is, ha épp nincs benne webcím', () => {
  const tracker = source('src/main/tracker.ts');
  // macOS: a címolvasás előtt, hogy az új lap is böngésző maradjon.
  const mac = tracker.slice(tracker.indexOf('const flavour = MAC_BROWSERS[fg.appId];'));
  assert.ok(mac.indexOf('fg.browser = true;') > 0 && mac.indexOf('fg.browser = true;') < mac.indexOf('const url = await run('));
  // Windows: a folyamatnév szerint, a cím nélkül is.
  assert.ok(tracker.includes('if (WIN_BROWSERS.has(name.toLowerCase())) fg.browser = true;'));
});

test('a fő folyamat a magot kérdezi, két látást vár, és a réteg mindkét fajtát kimondja', () => {
  const main = source('src/main/main.ts');
  assert.ok(main.includes('const warning = foregroundWarning(focusPack, focusStartedAt, fg, now);'));
  assert.ok(main.includes("if (warning.kind === 'site' && (siteSeen?.count ?? 0) < SITE_WARN_SIGHTINGS) return;"));
  assert.ok(main.includes('focusStartedAt = run ? run.startedAt : 0;'), 'a türelmi idő a menet indulásától számít');
  assert.ok(!main.includes('shouldWarnAboutApp('), 'a böngészőt nem nézzük appként');

  const overlay = source('src/renderer/overlay.ts');
  assert.ok(overlay.includes("if (warning.kind === 'site') {"));
  assert.ok(overlay.includes('bridge.onOverlayWarn?.(() => { void refresh(); });'), 'a már látszó réteg is megkapja');
  const preload = source('src/main/preload.ts');
  assert.ok(preload.includes("onOverlayWarn: (cb) => ipcRenderer.on('breaker:overlay-warn', () => cb()),"));
});
