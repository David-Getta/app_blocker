// Csatorna-szűrő: „csak a felsorolt csatornák nyílnak meg”.
//
// A LOGIKA KÉT PÉLDÁNYBAN ÉL, és ezt ki kell mondani: a bővítmény a saját,
// függőség nélküli `extension/channels.js`-t viszi (a böngészőbe azt
// szállítjuk ki), a segéd és a felület ezt a TypeScript ikret. A kettő
// egyezését teszt őrzi, amely a KISZÁLLÍTOTT bővítmény-bájtokat futtatja
// ugyanazon a bemenet-készleten (`desktop/test/channels.test.ts`) — ugyanaz a
// minta, mint a részleges szabályok magjánál. Ha itt változtatsz, ott is.
//
// Mit tekintünk csatornának, és mit nem — lásd a bővítménybeli fájl fejlécét.
// A rövid változat: amit a CÍM elárul (`@név`, `channel/…`, `c/…`, `user/…`),
// azt szűrjük; amit nem (egy /watch videó csatornája), arról nem hazudunk.

export interface ChannelFilter {
  id: string;
  /** a szűrt oldal gazdagépe (`youtube.com`) — végződés szerint illeszkedik */
  host: string;
  /** az ENGEDÉLYEZETT csatornák kulcsai (`@név`, `channel/…`, kisbetűs) */
  allow: string[];
  /** a szűrő csak bekapcsolva tilt — mint a munkamenet */
  enabled: boolean;
}

export const MAX_CHANNEL_FILTERS = 20;
export const MAX_ALLOW_PER_FILTER = 50;
export const MAX_CHANNEL_KEY_LENGTH = 100;

export function normalizeFilterHost(input: string): string | null {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '').replace(/^[^/@]*@/, '');
  const cut = s.search(/[/?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  const colon = s.indexOf(':');
  if (colon >= 0) s = s.slice(0, colon);
  s = s.replace(/^www\./, '').replace(/\.+$/, '');
  if (!s || s.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null;
  return s;
}

export function channelKeyFromPath(path: string): string | null {
  const segs = String(path ?? '').split(/[?#]/)[0].split('/').filter(Boolean);
  if (segs.length === 0) return null;
  const first = decodeURIComponent(segs[0]).toLowerCase();
  if (first.startsWith('@') && first.length > 1) {
    return first.slice(0, MAX_CHANNEL_KEY_LENGTH);
  }
  if ((first === 'channel' || first === 'c' || first === 'user') && segs.length > 1) {
    const second = decodeURIComponent(segs[1]).toLowerCase();
    if (!second) return null;
    return `${first}/${second}`.slice(0, MAX_CHANNEL_KEY_LENGTH);
  }
  return null;
}

export function normalizeChannelEntry(input: string): string | null {
  let s = String(input ?? '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(s)) {
    const noScheme = s.replace(/^https?:\/\//i, '');
    const slash = noScheme.indexOf('/');
    if (slash < 0) return null;
    return channelKeyFromPath(noScheme.slice(slash));
  }
  if (s.startsWith('/')) return channelKeyFromPath(s);
  s = s.toLowerCase();
  if (/^(channel|c|user)\/[^/\s]+$/.test(s)) return s.slice(0, MAX_CHANNEL_KEY_LENGTH);
  if (s.startsWith('@')) s = s.slice(1);
  if (!/^[\w.-]+$/.test(s)) return null;
  return `@${s}`.slice(0, MAX_CHANNEL_KEY_LENGTH);
}

export function hostMatchesFilter(host: string | null, filterHost: string): boolean {
  if (!host || !filterHost) return false;
  return host === filterHost || host.endsWith(`.${filterHost}`);
}

/**
 * Egy http(s) cím hosztja és útvonala, `URL` nélkül — a `user:pass@` alak
 * miatt kézzel: a @ előtti rész nem a hoszt, és nem is csatorna.
 */
function urlParts(url: string): { host: string; path: string } | null {
  const s = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return null;
  const rest = s.replace(/^https?:\/\//i, '').replace(/^[^/@]*@/, '');
  const slash = rest.search(/[/?#]/);
  let host = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase();
  const colon = host.indexOf(':');
  if (colon >= 0) host = host.slice(0, colon);
  host = host.replace(/\.+$/, '');
  if (!host) return null;
  return { host, path: slash < 0 ? '/' : rest.slice(slash) };
}

/**
 * Megfogja-e a csatorna-szűrő ezt a címet — az iker a bővítménybelivel.
 *
 * A felületen az élő ELŐNÉZET használja („ezt a címet a szűrő megfogná”), a
 * tényleges tiltást a bővítményben futó példány végzi.
 */
export function channelVerdict(
  url: string, channels: { host: string; allow: string[] }[],
): { host: string; key: string } | null {
  const p = urlParts(url);
  if (!p) return null;
  for (const f of channels ?? []) {
    if (!f || !hostMatchesFilter(p.host, f.host)) continue;
    const key = channelKeyFromPath(p.path);
    if (key === null) continue;
    const allow = Array.isArray(f.allow) ? f.allow : [];
    if (!allow.includes(key)) return { host: f.host, key };
  }
  return null;
}

/**
 * A VIDEÓ azonosítója a címből, ha a cím lejátszóra mutat — különben null.
 *
 * A bővítménybeli példány kommentje mondja el, mi épül rá (kártya-ismérv és
 * elavulás-őr). A kis- és nagybetű ITT SZÁMÍT: a videó-azonosítók érzékenyek
 * rá, ezért nem kisbetűsítünk, ahogy a csatorna-kulcsoknál tesszük.
 */
export function contentIdOf(url: string): string | null {
  const s = String(url ?? '').trim();
  let path: string | null = null;
  if (s.startsWith('/')) path = s;
  else path = urlParts(s)?.path ?? null;
  if (!path) return null;
  const v = path.match(/[?&]v=([A-Za-z0-9_-]{4,})/);
  if (v) return v[1];
  const segs = path.split(/[?#]/)[0].split('/').filter(Boolean);
  const idLike = (x: string) => /^[A-Za-z0-9_-]{4,}$/.test(x);
  if (segs.length >= 2 && ['shorts', 'embed', 'video', 'live', 'v'].includes(segs[0].toLowerCase())
    && idLike(segs[1])) {
    return segs[1];
  }
  // A `/@valaki/video/123` alak (TikTok): az azonosító a harmadik szakasz.
  if (segs.length >= 3 && segs[1].toLowerCase() === 'video' && idLike(segs[2])) return segs[2];
  return null;
}

/**
 * Megfogja-e a szűrő ezt a lapot A FELTÖLTŐJE alapján.
 *
 * A LAP címe dönti el, melyik szűrő alá esik; a FELTÖLTŐ címe adja a kulcsot.
 * A feltöltőnek ugyanarra a gazdagépre kell mutatnia: egy máshova mutató
 * szerző-link nem ennek az oldalnak a csatornája, arról nem mondunk ítéletet.
 */
export function authorVerdict(
  pageUrl: string, authorUrl: string, channels: { host: string; allow: string[] }[],
): { host: string; key: string } | null {
  const page = urlParts(pageUrl);
  const author = urlParts(authorUrl);
  if (!page || !author) return null;
  for (const f of channels ?? []) {
    if (!f || !hostMatchesFilter(page.host, f.host)) continue;
    if (!hostMatchesFilter(author.host, f.host)) continue;
    const key = channelKeyFromPath(author.path);
    if (key === null) continue;
    const allow = Array.isArray(f.allow) ? f.allow : [];
    if (!allow.includes(key)) return { host: f.host, key };
  }
  return null;
}

/**
 * Egy beérkező szűrő-rekord tisztítása mentés előtt.
 *
 * A segéd rootként fut és a saját állapotfájlját írja: ami ide bekerül, azt
 * ELLENŐRIZZÜK, nem elhisszük. A rossz bejegyzések kiesnek; ha a gazdagép
 * rossz vagy egyetlen érvényes engedélyezett csatorna sincs, az egész rekord
 * érvénytelen — egy üres fehérlistájú, bekapcsolt szűrő az oldal ÖSSZES
 * csatornáját tiltaná, amit a felhasználó nem biztos, hogy szándékolt.
 */
export function sanitizeFilter(raw: {
  id?: unknown; host?: unknown; allow?: unknown; enabled?: unknown;
}): Omit<ChannelFilter, 'id'> | null {
  const host = normalizeFilterHost(String(raw.host ?? ''));
  if (!host) return null;
  const seen = new Set<string>();
  const allow: string[] = [];
  for (const entry of Array.isArray(raw.allow) ? raw.allow : []) {
    const key = normalizeChannelEntry(String(entry ?? ''));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    allow.push(key);
    if (allow.length >= MAX_ALLOW_PER_FILTER) break;
  }
  if (allow.length === 0) return null;
  return { host, allow, enabled: raw.enabled === true };
}

/**
 * LAZÍTÁS-e a szűrő cseréje — mert a lazítás próbatételbe kerül.
 *
 * A szabály ugyanaz, mint mindenhol: szigorítani ingyen lehet, lazítani nem.
 * Kikapcsolt szűrőn minden módosítás ingyen van (nem tilt semmit). Bekapcsolt
 * szűrőnél lazítás: a kikapcsolás, a gazdagép cseréje (a régi oldal
 * felszabadul), és ÚJ engedélyezett csatorna felvétele (több nyílik meg).
 * Engedélyezett csatorna LEVÉTELE szigorítás — ingyen.
 */
export function isFilterLoosening(
  current: ChannelFilter | undefined, next: Omit<ChannelFilter, 'id'>,
): boolean {
  if (!current || !current.enabled) return false;
  if (!next.enabled) return true;
  if (next.host !== current.host) return true;
  return next.allow.some((k) => !current.allow.includes(k));
}
