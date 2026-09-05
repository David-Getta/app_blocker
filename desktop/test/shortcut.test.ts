import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  acceleratorFromKeyEvent, DEFAULT_OVERLAY_SHORTCUT, normalizeAccelerator, rejectText,
  shortcutLabel, type KeyEventLike,
} from '../src/shared/shortcut';

function ev(code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

test('macOS: ⌘ a fő módosító, a Ctrl külön megy', () => {
  assert.deepEqual(acceleratorFromKeyEvent(ev('KeyB', { metaKey: true, altKey: true }), 'darwin'),
    { ok: true, accelerator: 'CommandOrControl+Alt+B' });
  assert.deepEqual(acceleratorFromKeyEvent(ev('KeyK', { ctrlKey: true, shiftKey: true }), 'darwin'),
    { ok: true, accelerator: 'Control+Shift+K' });
});

test('Windows: a Ctrl a fő módosító, a Windows-billentyű nem számít', () => {
  assert.deepEqual(acceleratorFromKeyEvent(ev('KeyB', { ctrlKey: true, altKey: true }), 'win32'),
    { ok: true, accelerator: 'CommandOrControl+Alt+B' });
  // metaKey (Win) egyedül: nincs módosító
  assert.deepEqual(acceleratorFromKeyEvent(ev('KeyB', { metaKey: true }), 'win32'),
    { ok: false, reason: 'no-modifier' });
});

test('a csupasz billentyű és a csak-Shift gépelés, nem parancs', () => {
  assert.deepEqual(acceleratorFromKeyEvent(ev('KeyB'), 'darwin'), { ok: false, reason: 'no-modifier' });
  assert.deepEqual(acceleratorFromKeyEvent(ev('KeyB', { shiftKey: true }), 'win32'),
    { ok: false, reason: 'shift-only' });
});

test('csak módosító lenyomva: még nem kombináció', () => {
  for (const code of ['ControlLeft', 'ShiftRight', 'AltLeft', 'MetaLeft', 'OSRight']) {
    assert.deepEqual(acceleratorFromKeyEvent(ev(code, { ctrlKey: true }), 'win32'),
      { ok: false, reason: 'modifier-only' }, code);
  }
});

test('nem támogatott billentyű: Enter, Tab, Escape, nyilak', () => {
  for (const code of ['Enter', 'Tab', 'Escape', 'ArrowLeft', 'Backspace']) {
    assert.deepEqual(acceleratorFromKeyEvent(ev(code, { ctrlKey: true, altKey: true }), 'win32'),
      { ok: false, reason: 'unsupported-key' }, code);
  }
});

test('számok, F-billentyűk és a szóköz mennek', () => {
  assert.equal(acceleratorFromKeyEvent(ev('Digit5', { ctrlKey: true }), 'win32').ok, true);
  assert.deepEqual(acceleratorFromKeyEvent(ev('F12', { altKey: true }), 'win32'),
    { ok: true, accelerator: 'Alt+F12' });
  assert.deepEqual(acceleratorFromKeyEvent(ev('Space', { metaKey: true, shiftKey: true }), 'darwin'),
    { ok: true, accelerator: 'CommandOrControl+Shift+Space' });
  // F13 nincs
  assert.equal(acceleratorFromKeyEvent(ev('F13', { ctrlKey: true }), 'win32').ok, false);
});

test('normalizálás: sorrend, kis-nagybetű, elutasítás', () => {
  assert.equal(normalizeAccelerator('shift+alt+b'), 'Alt+Shift+B');
  assert.equal(normalizeAccelerator(' CommandOrControl + f5 '), 'CommandOrControl+F5');
  assert.equal(normalizeAccelerator(DEFAULT_OVERLAY_SHORTCUT), DEFAULT_OVERLAY_SHORTCUT);
  // két billentyű, ismeretlen módosító, csak Shift, üres, nem szöveg
  assert.equal(normalizeAccelerator('Control+A+B'), null);
  assert.equal(normalizeAccelerator('Super+B'), null);
  assert.equal(normalizeAccelerator('Shift+B'), null);
  assert.equal(normalizeAccelerator('B'), null);
  assert.equal(normalizeAccelerator(''), null);
  assert.equal(normalizeAccelerator(42 as unknown as string), null);
  assert.equal(normalizeAccelerator('Control+Enter'), null);
});

test('az eseményből jött accelerator már kanonikus — a normalizálás nem változtat rajta', () => {
  const r = acceleratorFromKeyEvent(ev('KeyQ', { metaKey: true, ctrlKey: true, altKey: true, shiftKey: true }), 'darwin');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(normalizeAccelerator(r.accelerator), r.accelerator);
});

test('címke: mac-jelek ⌘ elöl, máshol Ctrl+Alt+…', () => {
  assert.equal(shortcutLabel(DEFAULT_OVERLAY_SHORTCUT, 'darwin'), '⌘⌥B');
  assert.equal(shortcutLabel(DEFAULT_OVERLAY_SHORTCUT, 'win32'), 'Ctrl+Alt+B');
  assert.equal(shortcutLabel('Control+Shift+F5', 'darwin'), '⌃⇧F5');
  assert.equal(shortcutLabel('Control+Shift+F5', 'win32'), 'Ctrl+Shift+F5');
  assert.equal(shortcutLabel('CommandOrControl+Shift+Space', 'linux'), 'Ctrl+Shift+Szóköz');
  // hibás tárolt érték: az alapértelmezés címkéje, nem üres szöveg
  assert.equal(shortcutLabel('nonsense', 'win32'), 'Ctrl+Alt+B');
});

test('minden elutasításhoz van emberi mondat', () => {
  for (const reason of ['modifier-only', 'no-modifier', 'shift-only', 'unsupported-key'] as const) {
    assert.ok(rejectText(reason).length > 10, reason);
  }
});
