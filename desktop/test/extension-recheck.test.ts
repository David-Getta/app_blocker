// A nyitott lap újranézése a bővítményben.
//
// A tét: a tiltás eddig csak navigáláskor dőlt el. A munkamenet indulásakor,
// a keret beteltekor vagy egy új szabály felvételekor már nyitott lap nyitva
// maradt — a benne szóló videó ment tovább, és semmi nem jelezte. Most a
// látható lap újranézeti magát. Ezek a tesztek a KISZÁLLÍTOTT kódot nézik: a
// tár-figyelő szűrőjét (csak a bélyeg változott-e) lefuttatva, a bekötést a
// forrásban.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/** A bővítmény mappája — a `__dirname`-től felfelé keresve. */
function extensionDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'extension');
    if (fs.existsSync(path.join(candidate, 'content.js'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('nem talalom az extension/ mappat');
}

function read(file: string): string {
  return fs.readFileSync(path.join(extensionDir(), file), 'utf8');
}

type Change = { oldValue?: unknown; newValue?: unknown };

/** A tartalom-szkript szűrője, a kiszállított bájtokból kivágva. */
function loadOnlyStampsChanged(): (change: Change | undefined) => boolean {
  const src = read('content.js');
  const m = src.match(/ {2}function onlyStampsChanged\(change\) \{[\s\S]*?\n {2}\}/);
  if (!m) throw new Error('a tartalom-szkriptben nincs onlyStampsChanged');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}\nreturn onlyStampsChanged;`)() as (change: Change | undefined) => boolean;
}

const LINK = {
  token: 'ABCD-EFGH', port: 8788,
  rules: [{ host: 'youtube.com', path: '/@valaki' }],
  focus: { running: false, name: '', endsAt: 0, allowSites: [], window: false, windows: [] },
  closed: [], keywords: [],
  fetchedAt: 1000, attemptedAt: 1000, error: null,
};

test('a lehúzás bélyege magában nem ébreszt minden fület — a szabály változása igen', () => {
  const only = loadOnlyStampsChanged();
  // Csak az idő, a port, a hibaüzenet lépett: ugyanazok a szabályok.
  assert.equal(only({ oldValue: LINK, newValue: { ...LINK, fetchedAt: 21_000, attemptedAt: 21_000 } }), true);
  assert.equal(only({ oldValue: LINK, newValue: { ...LINK, attemptedAt: 41_000, error: 'Az app nem érhető el.' } }), true);
  assert.equal(only({ oldValue: LINK, newValue: { ...LINK, port: 8790 } }), true);
  // Elindult egy munkamenet, betelt egy keret, jött egy szabály: ez már nem bélyeg.
  const running = { ...LINK.focus, running: true, name: 'Mély munka', endsAt: 99_000, allowSites: ['example.org'] };
  assert.equal(only({ oldValue: LINK, newValue: { ...LINK, focus: running, fetchedAt: 21_000 } }), false);
  assert.equal(only({ oldValue: LINK, newValue: { ...LINK, closed: [{ host: 'youtube.com', reason: 'limit', until: 5 }] } }), false);
  assert.equal(only({ oldValue: LINK, newValue: { ...LINK, rules: [] } }), false);
  // Az első írás és a törlés nem „csak bélyeg”: arra mindig újranézünk.
  assert.equal(only({ newValue: LINK }), false);
  assert.equal(only({ oldValue: LINK }), false);
  assert.equal(only(undefined), false);
});

test('a bekötés: a látható lap kérdez, a háttér a böngésző szerinti címet nézi, és nem könyvel', () => {
  const content = read('content.js');
  // Ugyanannyi időnként, amennyi időnként a bővítmény legfeljebb az appot kérdezi.
  const recheckMs = Number((content.match(/const RECHECK_MS = ([\d_]+);/) ?? [])[1]?.replace(/_/g, ''));
  const appLink = read('app-link.js');
  const refresh = (appLink.match(/export const REFRESH_MS = (\d+) \* 1000;/) ?? [])[1];
  assert.equal(recheckMs, Number(refresh) * 1000, 'az újranézés üteme a lehúzásé');
  assert.ok(content.includes('recheckTimer = setInterval(recheck, RECHECK_MS);'));
  assert.ok(content.includes("document.addEventListener('visibilitychange', recheck);"));
  assert.ok(content.includes("if (document.visibilityState !== 'visible') return;"), 'rejtett lap nem kérdez');
  // A tár-figyelőben: a puszta bélyeg nem, a szabály-változás igen — és ott újranéz.
  const listener = content.slice(content.indexOf('chrome.storage.onChanged.addListener'));
  assert.ok(listener.indexOf("onlyStampsChanged(changes['breaker.applink'])) return;") > 0);
  assert.ok(listener.indexOf('recheck();') > listener.indexOf('onlyStampsChanged('));

  const bg = read('background.js');
  const handler = bg.slice(bg.indexOf("if (msg?.type !== 'breaker:recheck') return false;"));
  assert.ok(handler.length > 0 && handler.includes('const url = sender.tab?.url;'), 'a cím a böngészőtől jön');
  assert.ok(!/msg\??\.url/.test(handler.slice(0, handler.indexOf('return true;'))), 'nem az üzenet címe');
  assert.ok(handler.includes('sender.frameId !== 0'), 'csak a fő keret');
  assert.ok(handler.includes("enforce('újranézés', { tabId, url, frameId: 0 }, { record: false })"));
  // A könyv a PRÓBÁLKOZÁSOKAT számolja: az újranézés nem megakadás.
  const enforce = bg.slice(bg.indexOf('async function enforce('), bg.indexOf('chrome.webNavigation.onBeforeNavigate'));
  assert.ok(enforce.indexOf('if (!record) return;') > 0
    && enforce.indexOf('if (!record) return;') < enforce.indexOf('await recordHitNow('));
});
