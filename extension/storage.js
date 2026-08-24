// A szabályok tárolása és a súrlódás.
//
// Ugyanaz a szabály, mint az appban: **szabályt felvenni ingyen van**, mert az
// szigorítás; **levenni viszont várakozás**, mert az lazítás. Enélkül a
// részleges tiltás egyetlen gomb lenne — és pont az a lényeg, hogy ne az legyen.
//
// A várakozás itt szándékosan egyszerűbb, mint az app próbatételei: a bővítmény
// nem tud próbatételt bonyolítani a segéd nélkül, viszont az időt tudja mérni.
// Aki EZT is ki akarja kerülni, az a böngésző beállításaiban kikapcsolja a
// bővítményt — ez a réteg ennyit tud, és a felület ki is mondja.

import { normalizeRule, ruleLabel } from './rules-core.js';

const KEY = 'breaker.partial';
/**
 * Ennyit kell várni egy szabály levételére.
 *
 * Tíz perc nem sok, viszont pont annyi, hogy az impulzus elmúljon — a
 * részleges tiltásnál pont az impulzus ellen dolgozunk. Aki tíz perc múlva is
 * akarja, az tényleg akarja.
 */
export const REMOVE_DELAY_MS = 10 * 60 * 1000;
export const MAX_RULES = 200;

/** @returns {Promise<{rules: {host:string,path:string,addedAt:number,removeAt:number|null}[]}>} */
export async function load() {
  const got = await chrome.storage.local.get(KEY);
  const raw = got?.[KEY];
  const rules = Array.isArray(raw?.rules) ? raw.rules : [];
  // Rekordonként tűrünk: egy sérült bejegyzés ne vigye el az egész listát.
  return {
    rules: rules
      .filter((r) => r && typeof r.host === 'string' && typeof r.path === 'string')
      .map((r) => ({
        host: r.host,
        path: r.path,
        addedAt: Number.isFinite(r.addedAt) ? r.addedAt : 0,
        removeAt: Number.isFinite(r.removeAt) ? r.removeAt : null,
      })),
  };
}

async function save(state) {
  await chrome.storage.local.set({ [KEY]: state });
}

/** Csak azok, amik MOST tiltanak (a lejárt visszaszámlálásúak már nem). */
export function activeRules(state, now) {
  return state.rules.filter((r) => r.removeAt === null || r.removeAt > now);
}

/**
 * Új szabály. Szigorítás, tehát azonnal érvényes, kérdés nélkül.
 *
 * @returns {Promise<{ok: true, label: string} | {ok: false, error: string}>}
 */
export async function addRule(input, now = Date.now()) {
  const rule = normalizeRule(input);
  if (!rule) {
    return { ok: false, error: 'Ez nem egy oldal-részlet. Kell hozzá egy út is, például youtube.com/@valaki.' };
  }
  const state = await load();
  const existing = state.rules.find((r) => r.host === rule.host && r.path === rule.path);
  if (existing) {
    // Ha épp visszaszámlálás alatt állt, az újrafelvétel VISSZAVONJA azt.
    // Szigorítás, tehát ingyen van — ez a helyes irány.
    existing.removeAt = null;
    await save(state);
    return { ok: true, label: ruleLabel(rule) };
  }
  if (state.rules.length >= MAX_RULES) {
    return { ok: false, error: `Legfeljebb ${MAX_RULES} szabály lehet.` };
  }
  state.rules.push({ ...rule, addedAt: now, removeAt: null });
  await save(state);
  return { ok: true, label: ruleLabel(rule) };
}

/**
 * Levétel: NEM azonnal. Elindul egy visszaszámlálás, és a szabály addig tilt.
 *
 * @returns {Promise<{ok: boolean, removeAt?: number, error?: string}>}
 */
export async function startRemoval(host, path, now = Date.now()) {
  const state = await load();
  const rule = state.rules.find((r) => r.host === host && r.path === path);
  if (!rule) return { ok: false, error: 'Nincs ilyen szabály.' };
  // Már fut egy visszaszámlálás: nem indítjuk újra. Újraindítani ugyan nem
  // lenne lazítás, de a másik irányba se csúszhat el — a meglévő határidő
  // marad, különben a gomb ismételgetése tolná ki, és az zavarba ejtő.
  if (rule.removeAt !== null) return { ok: true, removeAt: rule.removeAt };
  rule.removeAt = now + REMOVE_DELAY_MS;
  await save(state);
  return { ok: true, removeAt: rule.removeAt };
}

/** A visszaszámlálás megszakítása. Szigorítás, tehát ingyen van. */
export async function cancelRemoval(host, path) {
  const state = await load();
  const rule = state.rules.find((r) => r.host === host && r.path === path);
  if (rule) rule.removeAt = null;
  await save(state);
}

/** A lejárt visszaszámlálású szabályok tényleges kitakarítása. */
export async function sweep(now = Date.now()) {
  const state = await load();
  const kept = state.rules.filter((r) => r.removeAt === null || r.removeAt > now);
  if (kept.length !== state.rules.length) await save({ rules: kept });
  return kept;
}
