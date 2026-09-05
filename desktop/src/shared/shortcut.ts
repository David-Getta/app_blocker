// A gyorsbillentyű-kombináció szabályai — tisztán, felület és Electron nélkül.
//
// MIÉRT VAN. A réteg kombinációja eddig be volt égetve (⌘⌥B / Ctrl+Alt+B), és
// ha egy másik program elvette, a réteg némán nem nyílt — a felület csak
// annyit tudott mondani, hogy „foglalt”. Az átállíthatóság ennek a
// gyógyszere, de három dolgot a felület NEM dönthet el maga, mert mindegyik
// hiba-forrás, ha két helyen kétféleképp dől el:
//
// - MI SZÁMÍT kombinációnak: legalább egy „valódi” módosító (⌘/Ctrl/Alt) és
//   pontosan egy billentyű. A csupasz betű vagy a Shift+betű gépelés, nem
//   parancs — egy ilyen regisztráció minden szövegmezőt elrontana;
// - HOGYAN ÍRJUK LE Electronnak (`CommandOrControl+Alt+B`), és hogyan
//   MUTATJUK az embernek (⌘⌥B, illetve Ctrl+Alt+B);
// - MIT FOGADUNK EL a lemezről: az elmentett szöveg is bemenet, és egy
//   elrontott vagy kézzel átírt érték ne dönthesse el, hogy a réteg
//   egyáltalán nyílik-e — ilyenkor az alapértelmezés áll vissza.

/** ⌘⌥B macOS-en, Ctrl+Alt+B Windowson — a Breaker kezdőbetűje. */
export const DEFAULT_OVERLAY_SHORTCUT = 'CommandOrControl+Alt+B';

/** Amit egy billentyű-eseményből használunk — a DOM KeyboardEvent részhalmaza. */
export interface KeyEventLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type ShortcutReject =
  /** csak módosító(k) vannak lenyomva — ez még nem kombináció */
  | 'modifier-only'
  /** billentyű módosító nélkül: az gépelés lenne, nem parancs */
  | 'no-modifier'
  /** Shift önmagában nem elég: a Shift+betű a nagybetű */
  | 'shift-only'
  /** ilyen billentyűt nem támogatunk (pl. Enter, Tab, Escape) */
  | 'unsupported-key';

export type ShortcutParse =
  | { ok: true; accelerator: string }
  | { ok: false; reason: ShortcutReject };

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

/**
 * A billentyű-kód → Electron-billentyűnév. Szándékosan szűk lista: betűk,
 * számok, F-billentyűk, szóköz. Ami nincs itt, azt nem fogadjuk el — inkább
 * egy „ezt nem lehet” üzenet, mint egy kombináció, amit a rendszer máshogy
 * ért, mint a felhasználó.
 */
function keyFromCode(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^F([1-9]|1[0-2])$/.exec(code);
  if (m) return `F${m[1]}`;
  if (code === 'Space') return 'Space';
  return null;
}

/**
 * Billentyű-eseményből Electron-accelerator.
 *
 * A „fő” módosító platformonként más: macOS-en a ⌘ (metaKey), Windowson a
 * Ctrl — mindkettő `CommandOrControl` lesz, hogy ugyanaz az elmentett érték
 * mindkét rendszeren ugyanazt jelentse. macOS-en a Ctrl külön (`Control`)
 * megy tovább; Windowson a Windows-billentyűt (metaKey) nem vesszük fel,
 * mert azt a rendszer magának tartja.
 */
export function acceleratorFromKeyEvent(e: KeyEventLike, platform: string): ShortcutParse {
  if (MODIFIER_CODES.test(e.code)) return { ok: false, reason: 'modifier-only' };
  const mac = platform === 'darwin';
  const mods: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) mods.push('CommandOrControl');
  if (mac && e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (mods.length === 0) return { ok: false, reason: 'no-modifier' };
  if (mods.length === 1 && mods[0] === 'Shift') return { ok: false, reason: 'shift-only' };
  const key = keyFromCode(e.code);
  if (!key) return { ok: false, reason: 'unsupported-key' };
  return { ok: true, accelerator: [...mods, key].join('+') };
}

const MODIFIER_ORDER = ['CommandOrControl', 'Control', 'Alt', 'Shift'];

/**
 * Egy tárolt/beírt accelerator ellenőrzése és kanonikus alakra hozása.
 *
 * @returns a kanonikus alak, vagy null, ha nem fogadható el — a hívó ilyenkor
 * az alapértelmezéshez nyúl. Ugyanazok a szabályok, mint az eseménynél: csak
 * ismert módosítók, nem csak Shift, pontosan egy támogatott billentyű.
 */
export function normalizeAccelerator(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('+').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const mods = new Set<string>();
  let key: string | null = null;
  for (const p of parts) {
    const mod = MODIFIER_ORDER.find((m) => m.toLowerCase() === p.toLowerCase());
    if (mod) { mods.add(mod); continue; }
    if (key !== null) return null;
    key = keyToken(p);
    if (!key) return null;
  }
  if (key === null || mods.size === 0) return null;
  if (mods.size === 1 && mods.has('Shift')) return null;
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+');
}

function keyToken(p: string): string | null {
  const up = p.toUpperCase();
  if (/^[A-Z0-9]$/.test(up)) return up;
  if (/^F([1-9]|1[0-2])$/.test(up)) return up;
  if (up === 'SPACE') return 'Space';
  return null;
}

/**
 * Amit az ember lát. macOS-en a szokásos jelek (⌘⌃⌥⇧, a ⌘ elöl, ahogy a
 * felület eddig is írta), máshol Ctrl+Alt+Shift+billentyű. A szóköz nevet
 * kap, mert egy üres hely nem felirat.
 */
export function shortcutLabel(accelerator: string, platform: string): string {
  const canon = normalizeAccelerator(accelerator) ?? DEFAULT_OVERLAY_SHORTCUT;
  const parts = canon.split('+');
  const key = parts[parts.length - 1];
  const keyText = key === 'Space' ? 'Szóköz' : key;
  const mods = parts.slice(0, -1);
  if (platform === 'darwin') {
    const sym: Record<string, string> = {
      CommandOrControl: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧',
    };
    return mods.map((m) => sym[m]).join('') + keyText;
  }
  const word: Record<string, string> = {
    CommandOrControl: 'Ctrl', Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift',
  };
  const seen = new Set<string>();
  const words = mods.map((m) => word[m]).filter((w) => (seen.has(w) ? false : (seen.add(w), true)));
  return [...words, keyText].join('+');
}

/** Az elutasítás oka emberi nyelven — a felület ezt írja ki. */
export function rejectText(reason: ShortcutReject): string {
  switch (reason) {
    case 'modifier-only': return 'Nyomj le egy billentyűt is a módosító mellé.';
    case 'no-modifier': return 'Kell mellé módosító is (⌘/Ctrl vagy Alt) — egy csupasz billentyű gépelés lenne.';
    case 'shift-only': return 'A Shift önmagában nem elég — a Shift+betű a nagybetű. Tegyél mellé ⌘/Ctrl-t vagy Alt-ot.';
    case 'unsupported-key': return 'Ez a billentyű nem választható — betű, szám, F1–F12 vagy szóköz lehet.';
  }
}
