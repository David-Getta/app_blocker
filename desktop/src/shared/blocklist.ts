// Domain normalization, preset expansion and hosts-file block building.
// Shared by the privileged helper (authoritative) and by tests.

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Accepts anything the user may paste ("https://www.youtube.com/watch?v=x",
 * "YouTube.com", "m.youtube.com/") and returns the canonical registrable-ish
 * domain ("youtube.com"), or null when it cannot be interpreted.
 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.replace(/^[^/@]*@/, ''); // userinfo
  const slash = s.search(/[/?#]/);
  if (slash >= 0) s = s.slice(0, slash);
  const colon = s.indexOf(':');
  if (colon >= 0) s = s.slice(0, colon); // port
  s = s.replace(/\.+$/, '');
  if (s.startsWith('www.')) s = s.slice(4);
  if (!DOMAIN_RE.test(s)) return null;
  return s;
}

/**
 * Extra hostnames for well known services, so blocking "youtube.com" also
 * covers the mobile site, shortlinks, etc. hosts files cannot express
 * wildcards, so we enumerate what matters in practice.
 */
export const PRESETS: Record<string, string[]> = {
  'youtube.com': [
    'm.youtube.com', 'music.youtube.com', 'youtubei.googleapis.com',
    'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be',
  ],
  'facebook.com': ['m.facebook.com', 'mbasic.facebook.com', 'fb.com', 'www.fb.com', 'fb.watch'],
  'instagram.com': ['m.instagram.com', 'ig.me'],
  'tiktok.com': ['m.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
  'x.com': ['twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'mobile.x.com', 't.co'],
  'twitter.com': ['x.com', 'www.x.com', 'mobile.twitter.com', 'mobile.x.com', 't.co'],
  'reddit.com': ['old.reddit.com', 'new.reddit.com', 'np.reddit.com', 'm.reddit.com', 'redd.it'],
  'twitch.tv': ['m.twitch.tv'],
  'netflix.com': ['m.netflix.com'],
  '9gag.com': ['m.9gag.com'],
};

/** Canonical domain -> concrete hostnames written into the hosts file. */
export function expandHostnames(domain: string, usePreset: boolean): string[] {
  const set = new Set<string>();
  set.add(domain);
  set.add('www.' + domain);
  set.add('m.' + domain);
  if (usePreset && PRESETS[domain]) for (const h of PRESETS[domain]) set.add(h);
  return [...set].sort();
}

export const MARKER_BEGIN = '# >>> BREAKER BLOCK BEGIN — ezt a részt a Breaker kezeli, kézzel ne szerkeszd';
export const MARKER_END = '# <<< BREAKER BLOCK END';

/**
 * A korábbi név (Lakat) jelölői.
 *
 * Az app 0.1.4-ig Lakat volt, és a hosts fájlba ezekkel a sorokkal írt. Az
 * átnevezéssel a segéd is új azonosítót kapott, tehát a RÉGI démon (és a
 * blokkja) nem tűnik el magától: aki csak a Breakert telepíti, annak a régi
 * sorok ott maradnának a hosts fájlban — örökre blokkolva pár oldalt úgy, hogy
 * semmilyen felület nem tud róluk.
 *
 * Ezért az új segéd minden íráskor kitakarítja őket. Ez a fajta hulladék épp az
 * a hiba, amit egy blokkoló appnál a legnehezebb kideríteni, mert semmilyen
 * felület nem mutatja: „ez az oldal nincs is a listán, mégsem megy”.
 */
export const LEGACY_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ['# >>> LAKAT BLOCK BEGIN', '# <<< LAKAT BLOCK END'],
];

/** Kivágja a korábbi néven írt kezelt blokkokat. Idempotens. */
export function stripLegacyBlocks(hostsContent: string): string {
  let out = hostsContent.replace(/\r\n/g, '\n');
  for (const [begin, end] of LEGACY_MARKERS) {
    for (;;) {
      const b = out.indexOf(begin);
      if (b < 0) break;
      const e = out.indexOf(end, b);
      // Nyitó jelölő záró nélkül: a fájl végéig tartónak vesszük, mert egy
      // félbeszakadt írás után pont az a maradék, amit takarítani kell.
      const cut = e < 0 ? out.length : e + end.length;
      out = out.slice(0, b) + out.slice(cut);
    }
  }
  return out;
}

/**
 * Renders the managed block for the given hostnames. Empty list -> empty string.
 * `platform` is a plain string (not NodeJS.Platform) so this module stays free
 * of Node types — it is also compiled for the browser-side renderer.
 */
export function buildManagedBlock(hostnames: string[], platform: string): string {
  if (hostnames.length === 0) return '';
  const lines: string[] = [MARKER_BEGIN];
  for (const h of hostnames) {
    lines.push(`0.0.0.0 ${h}`);
    if (platform !== 'win32') lines.push(`:: ${h}`);
  }
  lines.push(MARKER_END);
  return lines.join('\n');
}

/**
 * Replaces (or removes/appends) the managed block inside a hosts file body.
 * Preserves everything outside the markers. Idempotent.
 */
export function replaceManagedBlock(hostsContent: string, block: string): string {
  // A régi néven írt blokkok itt tűnnek el: minden hosts-írás egyben takarítás is.
  const normalized = stripLegacyBlocks(hostsContent);
  const begin = normalized.indexOf(MARKER_BEGIN);
  const end = normalized.indexOf(MARKER_END);
  let before: string;
  let after: string;
  if (begin >= 0 && end >= 0 && end >= begin) {
    before = normalized.slice(0, begin);
    after = normalized.slice(end + MARKER_END.length);
  } else {
    before = normalized;
    after = '';
  }
  before = before.replace(/\n+$/, '');
  after = after.replace(/^\n+/, '').replace(/\n+$/, '');
  const parts = [before, block, after].filter((p) => p !== '');
  const body = parts.join('\n\n');
  return body === '' ? '' : body + '\n';
}

/** Extracts the current managed block ('' when absent) for drift detection. */
export function extractManagedBlock(hostsContent: string): string {
  const normalized = hostsContent.replace(/\r\n/g, '\n');
  const begin = normalized.indexOf(MARKER_BEGIN);
  const end = normalized.indexOf(MARKER_END);
  if (begin < 0 || end < 0 || end < begin) return '';
  return normalized.slice(begin, end + MARKER_END.length);
}
