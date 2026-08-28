// Csatorna-szűrő: „csak a felsorolt csatornák nyílnak meg”.
//
// Ez a MEGFORDÍTOTT részleges tiltás. A részleges szabály feketelista (a
// felsorolt darabok tiltva), ez fehérlista EGY oldal csatornáira: ha a szűrő
// be van kapcsolva, a csatorna-alakú címek közül csak az engedélyezettek
// nyílnak meg — minden más az oldalon (kezdőlap, keresés) szabad marad. Nem
// teljes tiltás, hanem kapcsolható mód, mint a munkamenet.
//
// MIT TEKINTÜNK CSATORNÁNAK. Címből csak azt lehet megmondani, ami a címben
// van:
//
//   - `@névvel` kezdődő első szakasz (YouTube, TikTok): `@név`;
//   - YouTube régi formái: `channel/AZONOSÍTÓ`, `c/NÉV`, `user/NÉV`.
//
// Amit a cím NEM árul el, azt nem is állítjuk: egy /watch?v=… videóról a cím
// nem mondja meg, melyik csatornáé. Ez kimondott korlát, nem elhallgatott.
//
// A fájl SZÁNDÉKOSAN függőség nélküli: a bővítmény betölti modulként, a
// desktop tesztjei pedig a kiszállított bájtokat futtatják — így a két oldal
// nem tud szétcsúszni (lásd desktop/test/channels.test.ts).

/** Legfeljebb ennyi szűrő; több oldal ennyiből is kényelmesen kijön. */
export const MAX_CHANNEL_FILTERS = 20;
/** Egy szűrőben legfeljebb ennyi engedélyezett csatorna. */
export const MAX_ALLOW_PER_FILTER = 50;
/** Egy csatorna-kulcs legnagyobb hossza — a tárolt állapotot védi. */
export const MAX_CHANNEL_KEY_LENGTH = 100;

/**
 * A szűrő gazdagépe abból, amit az ember beír.
 *
 * Elfogad címet is (`https://www.youtube.com/...`), és a `www.` előtagot
 * levágja: a szűrő végződés szerint illeszkedik, tehát a `youtube.com` a
 * `www.youtube.com`-ot is fedi.
 */
export function normalizeFilterHost(input) {
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

/**
 * Egy CÍM ÚTVONALÁBÓL a csatorna kulcsa, vagy null, ha nem csatorna-alakú.
 *
 * A kulcs kisbetűs, mert a cím kis- és nagybetűje nem különböztet meg
 * csatornát — a `@Valaki` és a `@valaki` ugyanaz.
 */
export function channelKeyFromPath(path) {
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

/**
 * Egy ENGEDÉLYEZETT csatorna kulcsa abból, amit az ember beír.
 *
 * Elfogad teljes címet (`https://www.youtube.com/@valaki/videos`), `@nevet`,
 * és puszta nevet is — az utóbbit `@névként` értjük, mert a támogatott
 * oldalakon az a csatorna alakja.
 */
export function normalizeChannelEntry(input) {
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

/** Illeszkedik-e a cím hosztja a szűrő gazdagépére (végződés szerint). */
export function hostMatchesFilter(host, filterHost) {
  if (!host || !filterHost) return false;
  return host === filterHost || host.endsWith(`.${filterHost}`);
}

/**
 * Megfogja-e a csatorna-szűrő ezt a címet.
 *
 * @param url teljes cím
 * @param channels [{host, allow:[kulcsok]}] — csak a BEKAPCSOLT szűrők
 * @returns null (mehet), vagy { host, key } — a tiltó lap ebből mondja meg,
 *   MILYEN kulcsot látott, hogy az engedélyezéshez ne kelljen találgatni
 */
export function channelVerdict(url, channels) {
  const s = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return null;
  const rest = s.replace(/^https?:\/\//i, '').replace(/^[^/@]*@/, '');
  const slash = rest.search(/[/?#]/);
  let host = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase();
  const colon = host.indexOf(':');
  if (colon >= 0) host = host.slice(0, colon);
  host = host.replace(/\.+$/, '');
  const path = slash < 0 ? '/' : rest.slice(slash);
  for (const f of channels ?? []) {
    if (!f || !hostMatchesFilter(host, f.host)) continue;
    const key = channelKeyFromPath(path);
    if (key === null) continue;
    const allow = Array.isArray(f.allow) ? f.allow : [];
    if (!allow.includes(key)) return { host: f.host, key };
  }
  return null;
}
