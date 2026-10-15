// A böngésző-DoH zár sora (macOS): azt mondja, amit a böngésző tényleg
// olvasna — a Chromium-család a gépszintű értéket csak ajánlásnak veszi, a
// Firefox zárolja, de a felhasználó saját beállítása felülírja, és csak a
// kezelt beállítás (profil, felügyelet) kötelező.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { dohLockLine, DOH_PROFILE_WHERE } from '../src/shared/doh-lock';

const ALL = ['Chrome', 'Edge', 'Chromium', 'Brave', 'Firefox'];
const line = (forcedOff: string[], lockedInBrowser: string[] = []) => dohLockLine({ browsers: ALL, forcedOff, lockedInBrowser });

test('mindegyik kötelező: a profil levehető — egy szervezeti felügyelet nem innen', () => {
  const s = line(ALL);
  assert.match(s, /^Most érvényben: a DoH-tilalom mindegyik böngészőben kötelező \(Chrome, Edge, Chromium, Brave, Firefox;/);
  assert.match(s, /Ha a Breaker profilja adja, a Rendszerbeállításokban eltávolíthatod; egy szervezeti felügyelet beállítását innen nem\.$/);
});

test('a segéd házirendje profil nélkül: a Chromium-család visszakapcsolható, a Firefox zárolva, de felülírható', () => {
  const s = line([], ['Firefox']);
  assert.equal(s, 'Most nincs kötelező DoH-tilalom. '
    + 'A böngésző beállításaiban visszakapcsolható: Chrome, Edge, Chromium, Brave. '
    + 'A böngészőben zárolva, de a saját felhasználói beállításoddal (Terminálból) felülírható: Firefox.');
  // Sehol nem mondja a Firefoxra, hogy a beállításaiban visszakapcsolható.
  assert.ok(!/visszakapcsolható: [^.]*Firefox/.test(s));
});

test('semmi: mind visszakapcsolható a böngésző beállításaiban', () => {
  assert.equal(line([]), 'Most nincs kötelező DoH-tilalom. A böngésző beállításaiban visszakapcsolható: Chrome, Edge, Chromium, Brave, Firefox.');
});

test('részben: a kötelezőket és a többit is néven nevezi, a böngészők sorrendjében', () => {
  assert.equal(line(['Firefox', 'Chrome']),
    'Részben érvényben — kötelező: Chrome, Firefox. A böngésző beállításaiban visszakapcsolható: Edge, Chromium, Brave.');
  // A kötelező felülírja a „zárolva”-t: egy böngésző csak egy helyen szerepel.
  assert.equal(line(['Firefox'], ['Firefox']),
    'Részben érvényben — kötelező: Firefox. A böngésző beállításaiban visszakapcsolható: Chrome, Edge, Chromium, Brave.');
});

test('a profil helye minden macOS-en megvan (a 12-esen és előtte külön tábla)', () => {
  assert.match(DOH_PROFILE_WHERE, /Általános › Eszközkezelés/);
  assert.match(DOH_PROFILE_WHERE, /Adatvédelem és biztonság › Profilok/);
  assert.match(DOH_PROFILE_WHERE, /macOS 12-n és előtte: Rendszerbeállítások › Profilok/);
});
