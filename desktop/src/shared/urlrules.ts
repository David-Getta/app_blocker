// Részleges tiltás: nem az egész oldal, csak egy darabja.
//
// „A YouTube maradjon, de EZ a csatorna ne.” Ez más kérdés, mint az eddigi
// tiltás, és fontos tudni, MIÉRT:
//
// A blokkolás eddig DNS-szinten ment, mert az az egyetlen pont, amit minden
// böngésző és minden app lát — így él inkognitóban és vendég módban is. A DNS
// viszont CSAK A HOSZTNEVET látja: `youtube.com`. Az utat (`/@valaki`) nem, mert
// az már a titkosított HTTPS-kérésen belül van. Egy csatorna tiltása tehát a
// DNS-motorral fizikailag lehetetlen — nem hiányzó munka, hanem a mechanizmus
// határa.
//
// Amit a teljes URL-t látja, az a böngésző maga. A részleges tiltás ezért egy
// böngésző-bővítményre épül, és ennek ára van, amit a felület ki is mond:
//
//   - csak abban a böngészőben él, ahova telepítve van;
//   - vendég módban a bővítmények egyáltalán nem futnak;
//   - inkognitóban alapból ki van kapcsolva (a felhasználó bekapcsolhatja).
//
// A KÉT RÉTEG EGYMÁS MELLETT ÁLL, nem egymás helyett: a teljes oldal tiltása
// marad DNS-szintű és megkerülhetetlen; a részleges tiltás gyengébb réteg, ami
// az ingert veszi el. Aki azt akarja, hogy a YouTube egyáltalán ne menjen, az
// tiltsa az egész oldalt — arra ott a régi út.
//
// Ez a fájl a szabály MAGJA: mit írhat be az ember, és milyen URL esik alá.
// Pure, függőség nélkül, hogy a Kotlin/Swift oldal pontosan tükrözhesse.

import { normalizeDomain } from './blocklist';

/** Legfeljebb ennyi szabály tartozhat egy oldalhoz. */
export const MAX_RULES_PER_SITE = 50;
/** Az út hossza felülről kötve — a felületen is ki kell férnie. */
export const MAX_RULE_PATH_LENGTH = 200;

export interface UrlRule {
  /** a hoszt, amire vonatkozik: `youtube.com` */
  host: string;
  /**
   * Út-előtag, `/`-rel kezdve, záró `/` nélkül: `/@valaki`.
   *
   * SOSEM üres. Az üres út az egész oldalt jelentené, arra viszont ott a
   * DNS-szintű tiltás — egy „részleges” szabály, ami mindent tilt, csak
   * félreértés forrása lenne.
   */
  path: string;
}

/**
 * Amit az ember tényleg beír.
 *
 * Szándékosan bőkezű, mert a valóságban ezek kerülnek a vágólapra:
 *
 *   https://www.youtube.com/@valaki/videos?x=1  ->  youtube.com  /@valaki/videos
 *   youtube.com/@valaki                          ->  youtube.com  /@valaki
 *   www.reddit.com/r/hirek/                      ->  reddit.com   /r/hirek
 *
 * Amit NEM fogadunk el, és okkal:
 *
 *   youtube.com          -> nincs út: ez az egész oldal, arra a sima tiltás van
 *   /@valaki             -> nincs hoszt: nem tudnánk, mihez tartozik
 */
/**
 * A mobil aldomain ugyanaz az oldal.
 *
 * Aki a telefonjáról másolja ki a linket, `m.youtube.com/@valaki`-t illeszt be.
 * Ha ezt szó szerint vennénk, a szabály CSAK a mobil hoszton fogna — a gépen
 * megnyitott ugyanolyan csatorna átmenne rajta, és semmi nem árulná el, miért.
 *
 * A `www.`-t a `normalizeDomain` már leszedi; ez a kettő ugyanaz az eset. Csak
 * ITT csináljuk, a részleges szabályoknál: a DNS-szintű blokklista
 * viselkedéséhez nem nyúlunk.
 *
 * Teljes közdomain-lista (PSL) nélkül ennél tovább nem megyünk: találgatni,
 * hogy egy aldomain „ugyanaz az oldal”-e, több kárt okozna, mint hasznot.
 */
const ALIAS_PREFIXES = ['m.', 'mobile.'];

function stripAliasPrefix(host: string): string {
  for (const prefix of ALIAS_PREFIXES) {
    if (host.startsWith(prefix)) {
      const rest = host.slice(prefix.length);
      // Legalább két címke maradjon: `m.hu`-ból nem csinálunk `hu`-t.
      if (rest.split('.').length >= 2) return rest;
    }
  }
  return host;
}

export function normalizeRule(input: string): UrlRule | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  const host = normalizeDomain(raw);
  if (!host) return null;

  // A hoszt UTÁNI rész. A normalizeDomain már levágta a sémát és a `www.`-t,
  // ezért itt az eredetiből kell kikeresni az első `/`-t a hoszt után.
  const afterScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^/@]*@/, '');
  const slash = afterScheme.search(/[/?#]/);
  if (slash < 0) return null; // csak hoszt: ez az egész oldal
  let path = afterScheme.slice(slash);

  // A lekérdezés és a horgony nem része a szabálynak. A `?v=...` egy KONKRÉT
  // videó, nem egy csatorna; ha ezt beengednénk, a szabály egyetlen linkre
  // vonatkozna, és a felhasználó azt hinné, a csatornát tiltotta le.
  path = path.split(/[?#]/)[0];
  path = path.replace(/\/+$/, '');
  if (path === '' || path === '/') return null;
  if (!path.startsWith('/')) return null;

  // Több egymás utáni `/` egyetlen szegmenshatár.
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > MAX_RULE_PATH_LENGTH) return null;
  // Vezérlőkarakter és szóköz nem való egy útba; a felületen se lenne látható,
  // mit tiltott le az ember.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020]/.test(path)) return null;

  return { host: stripAliasPrefix(host), path: lowerIfCaseless(path) };
}

/**
 * A hoszt kisbetűs, az út viszont NEM feltétlenül.
 *
 * A `youtube.com/@Valaki` és a `/@valaki` ugyanaz a csatorna, viszont sok
 * oldalon (GitHub, Reddit-felhasználók) az út kis-nagybetű-érzékeny. A
 * gyakorlatban a mi eseteink kezelhetők kisbetűsen, és a KÖVETKEZETESSÉG
 * fontosabb: ha egyszer így írjuk le, az összevetés is így megy — különben egy
 * szabály hol fogna, hol nem, és semmi nem magyarázná meg.
 */
function lowerIfCaseless(path: string): string {
  return path.toLowerCase();
}

/** Ugyanaz a szabály-e (a duplikátumot nem vesszük fel kétszer). */
export function sameRule(a: UrlRule, b: UrlRule): boolean {
  return a.host === b.host && a.path === b.path;
}

/**
 * Ráillik-e a szabály erre az URL-re?
 *
 * A hoszt akkor jó, ha EGYEZIK vagy ALDOMAINJE a szabály hosztjának, mert a
 * `m.youtube.com/@valaki` ugyanaz a csatorna.
 *
 * Az út SZEGMENSHATÁRON illeszkedik, nem sztring-előtagként. Ez nem szőrözés:
 * előtagként a `/@ab` ráillene a `/@abc`-re is, vagyis egy csatorna tiltása
 * csendben letiltana egy másikat, akinek hasonlóan kezdődik a neve.
 */
export function matchesRule(rule: UrlRule, url: string): boolean {
  const parsed = splitUrl(url);
  if (!parsed) return false;
  if (!hostMatches(rule.host, parsed.host)) return false;
  const path = parsed.path;
  return path === rule.path || path.startsWith(`${rule.path}/`);
}

/** Illik-e BÁRMELYIK szabály az URL-re. */
export function anyRuleMatches(rules: UrlRule[], url: string): boolean {
  return rules.some((r) => matchesRule(r, url));
}

function hostMatches(ruleHost: string, host: string): boolean {
  return host === ruleHost || host.endsWith(`.${ruleHost}`);
}

/**
 * URL -> { hoszt, út }, a `URL` osztály nélkül.
 *
 * Kézzel, mert ugyanennek a magnak Kotlinban és Swiftben is futnia kell, és
 * ott más URL-elemző van. Ha itt a beépítettre támaszkodnánk, a három
 * platform apró eltéréseken csúszna szét — pont azon, hogy melyik URL számít
 * tiltottnak.
 */
function splitUrl(url: string): { host: string; path: string } | null {
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

/** Ahogy a felületen látszik: `youtube.com/@valaki`. */
export function ruleLabel(rule: UrlRule): string {
  return `${rule.host}${rule.path}`;
}
