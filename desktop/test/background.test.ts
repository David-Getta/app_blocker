// Az app a háttérben: a bezárás elrejt, a bejelentkezés rejtve indít.
//
// A tét: a gépen a mérés az appban fut, és a napi keret meg az adag a mért
// időből fogy. Amíg az ablak bezárása leállította az appot, egy kattintás
// ingyen kikapcsolta mindkettőt. Ezek a tesztek két dolgot őriznek: a tiszta
// döntéseket (shared/background.ts), és hogy a fő folyamat TÉNYLEG így van
// bekötve — egy visszaírt `app.quit()` a „minden ablak bezárult” eseményben
// semmilyen más tesztet nem buktatna el.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  BACKGROUND_FLAG, closeAction, LAUNCH_AGENT_LABEL, launchAgentPlist, launchAgentUsable, startsHidden, xmlEscape,
} from '../src/shared/background';

test('rejtve csak a bejelentkezéskori kapcsolóval indul', () => {
  assert.equal(BACKGROUND_FLAG, '--background');
  assert.equal(startsHidden(['/Applications/Breaker.app/Contents/MacOS/Breaker', '--background']), true);
  assert.equal(startsHidden(['C:\\Program Files\\Breaker\\Breaker.exe']), false, 'kézi indítás: ablakkal');
  assert.equal(startsHidden(['Breaker.exe', '--background=1']), false, 'csak a pontos kapcsoló');
});

test('a bezárás elrejt, csak a kilépés zár be', () => {
  assert.equal(closeAction(false), 'hide');
  assert.equal(closeAction(true), 'close');
});

test('az indító-ügynök a rendes helyen lévő appra mutat, a letöltésből futóra nem', () => {
  assert.equal(launchAgentUsable('/Applications/Breaker.app/Contents/MacOS/Breaker'), true);
  assert.equal(launchAgentUsable('/Users/anna/Apps/Breaker.app/Contents/MacOS/Breaker'), true);
  assert.equal(launchAgentUsable(
    '/private/var/folders/x/T/AppTranslocation/ABC/d/Breaker.app/Contents/MacOS/Breaker',
  ), false, 'ideiglenes hely: a következő indításkor már nem létezik');
  assert.equal(launchAgentUsable('/usr/local/bin/electron'), false, 'fejlesztői futtató');
  assert.equal(launchAgentUsable(''), false);
});

test('a plist rejtve indít, nem tart életben, és az útvonalat idézi', () => {
  const plist = launchAgentPlist('/Users/a&b/<x>/Breaker.app/Contents/MacOS/Breaker');
  assert.ok(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(plist.includes(`<string>${LAUNCH_AGENT_LABEL}</string>`));
  assert.ok(plist.includes('<string>/Users/a&amp;b/&lt;x&gt;/Breaker.app/Contents/MacOS/Breaker</string>'));
  assert.ok(plist.includes(`<string>${BACKGROUND_FLAG}</string>`));
  assert.ok(plist.includes('<key>RunAtLoad</key>\n  <true/>'));
  // A szándékos kilépés kilépés marad: a launchd nem indítja újra.
  assert.ok(!plist.includes('KeepAlive'));
  // Nyers `&` csak entitás elején maradhat — különben a plist érvénytelen.
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(plist));
  assert.equal(xmlEscape(`a&b<c>"d'e`), 'a&amp;b&lt;c&gt;&quot;d&apos;e');
});

/** A fő folyamat forrása — a tesztek forrásból és fordított kimenetből is futnak. */
function mainSource(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'src', 'main', 'main.ts');
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
    dir = path.dirname(dir);
  }
  throw new Error('nem találom a src/main/main.ts-t');
}

/** Egy `app.on('<esemény>', …)` kezelő törzse, a nyitó zárójeltől a párjáig. */
function handlerBody(src: string, event: string): string {
  const at = src.indexOf(`app.on('${event}'`);
  assert.ok(at >= 0, `nincs ${event} kezelő`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`a ${event} kezelő nincs lezárva`);
}

test('a fő folyamat: a „minden ablak bezárult” nem léptet ki', () => {
  const src = mainSource();
  // A segéd-módban és a felületi módban is van ilyen kezelő — egyik sem léphet ki.
  let from = 0;
  let seen = 0;
  for (;;) {
    const at = src.indexOf("app.on('window-all-closed'", from);
    if (at < 0) break;
    seen++;
    const body = handlerBody(src.slice(at), 'window-all-closed');
    assert.ok(!/app\.(quit|exit)\(/.test(body.replace(/\/\/.*$/gm, '')),
      `a window-all-closed kezelő kiléptet:\n${body}`);
    from = at + 1;
  }
  assert.ok(seen >= 2, 'mindkét módban kell kezelő');
});

test('a fő folyamat: a bezárás elrejt, a kilépés előbb jelez, a második indítás előhoz', () => {
  const src = mainSource();
  assert.ok(src.includes("win.on('close', (e) => {"), 'nincs bezárás-kezelő az ablakon');
  assert.ok(src.includes('if (closeAction(quitting) === \'close\') return;'));
  assert.ok(src.includes('e.preventDefault();\n      win.hide();'));
  // Windowson a leállítás nem küld before-quit-et — a jel itt is kell.
  assert.ok(src.includes("win.on('session-end', () => { quitting = true; });"));
  // A kilépés jele a before-quit ELSŐ utasítása: utána zárul be az ablak.
  const beforeQuit = handlerBody(src, 'before-quit').replace(/\/\/.*$/gm, '').trim();
  assert.match(beforeQuit, /^\{\s*quitting = true;/, `a before-quit nem a jellel kezd:\n${beforeQuit}`);
  assert.match(handlerBody(src, 'second-instance'), /showMain\(\)/);
  assert.match(handlerBody(src, 'activate'), /showMain\(\)/);
  // Bejelentkezéskor rejtve, és az indítási bejegyzés pótlása minden indításkor.
  assert.ok(src.includes('createWindow({ show: !startsHidden(process.argv) });'));
  assert.ok(src.includes('ensureLoginStart();'));
});
