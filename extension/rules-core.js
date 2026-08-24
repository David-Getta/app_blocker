// A részleges tiltás szabály-magja, a bővítmény oldalán.
//
// Ez a `desktop/src/shared/urlrules.ts` PÁRJA, ESM-ként, hogy a bővítmény
// szolgáltatás-workere és a tartalomszkript is használhassa fordítás nélkül. A
// `desktop/test/extension-core.test.ts` a két megvalósítást UGYANAZON a
// táblázaton hajtja végig, és eltérésnél elhasal.
//
// Enélkül a szabály a felületen mást jelentene, mint a böngészőben, és semmi
// nem szólna róla: az ember letiltana egy csatornát, a bővítmény meg átengedné.

export const MAX_RULE_PATH_LENGTH = 200;

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CONTROL_OR_SPACE = /[\u0000-\u0020]/;

/**
 * A mobil aldomain ugyanaz az oldal.
 *
 * Aki a telefonjáról másolja ki a linket, `m.youtube.com/@valaki`-t illeszt be.
 * Ha ezt szó szerint vennénk, a szabály CSAK a mobil hoszton fogna — a gépen
 * megnyitott ugyanolyan csatorna átmenne rajta.
 */
const ALIAS_PREFIXES = ['m.', 'mobile.'];

function stripAliasPrefix(host) {
  for (const prefix of ALIAS_PREFIXES) {
    if (host.startsWith(prefix)) {
      const rest = host.slice(prefix.length);
      if (rest.split('.').length >= 2) return rest;
    }
  }
  return host;
}

/** Beírt szöveg -> `{ host, path }`, vagy null, ha nem szabály. */
export function normalizeRule(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;
  const host = normalizeDomain(raw);
  if (!host) return null;

  const afterScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^/@]*@/, '');
  const slash = afterScheme.search(/[/?#]/);
  if (slash < 0) return null; // csak hoszt: ez az egész oldal
  let path = afterScheme.slice(slash);
  path = path.split(/[?#]/)[0];
  path = path.replace(/\/+$/, '');
  if (path === '' || path === '/') return null;
  if (!path.startsWith('/')) return null;
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > MAX_RULE_PATH_LENGTH) return null;
  if (CONTROL_OR_SPACE.test(path)) return null;
  return { host: stripAliasPrefix(host), path: path.toLowerCase() };
}

function normalizeDomain(input) {
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.replace(/^[^/@]*@/, '');
  const slash = s.search(/[/?#]/);
  if (slash >= 0) s = s.slice(0, slash);
  const colon = s.indexOf(':');
  if (colon >= 0) s = s.slice(0, colon);
  s = s.replace(/\.+$/, '');
  if (s.startsWith('www.')) s = s.slice(4);
  if (!DOMAIN_RE.test(s)) return null;
  return s;
}

/**
 * Ráillik-e a szabály erre az URL-re?
 *
 * Az út SZEGMENSHATÁRON illeszkedik, nem sztring-előtagként: előtagként a
 * `/@ab` ráillene a `/@abc`-re is, vagyis egy csatorna tiltása csendben
 * letiltana egy másikat, akinek hasonlóan kezdődik a neve.
 */
export function matchesRule(rule, url) {
  const parsed = splitUrl(url);
  if (!parsed) return false;
  if (!(parsed.host === rule.host || parsed.host.endsWith(`.${rule.host}`))) return false;
  return parsed.path === rule.path || parsed.path.startsWith(`${rule.path}/`);
}

export function anyRuleMatches(rules, url) {
  return rules.some((r) => matchesRule(r, url));
}

/** Melyik szabály fogott meg — a tiltó lap ezt írja ki. */
export function firstMatch(rules, url) {
  return rules.find((r) => matchesRule(r, url)) ?? null;
}

export function ruleLabel(rule) {
  return `${rule.host}${rule.path}`;
}

function splitUrl(url) {
  if (typeof url !== 'string') return null;
  let s = url.trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.replace(/^[^/@]*@/, '');
  const cut = s.search(/[/?#]/);
  let host = cut < 0 ? s : s.slice(0, cut);
  let path = cut < 0 ? '/' : s.slice(cut);
  const colon = host.indexOf(':');
  if (colon >= 0) host = host.slice(0, colon);
  host = host.toLowerCase().replace(/\.+$/, '');
  if (!host) return null;
  if (path.startsWith('?') || path.startsWith('#')) path = '/';
  path = path.split(/[?#]/)[0];
  path = path.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (path === '') path = '/';
  return { host, path: path.toLowerCase() };
}
