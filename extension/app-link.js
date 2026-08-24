// A kapcsolat az appal.
//
// MIÉRT VAN. A szabályokat az APPBAN veszi fel az ember, mert ott van mögöttük
// a súrlódás: felvenni egy kattintás, levenni próbatétel. Ez a bővítmény
// viszont csak a saját listáját ismerné — vagyis ugyanazt kétszer kellene
// begépelni, két helyre. Ami kétszer van, az előbb-utóbb szétcsúszik, és
// mindenki azt hiszi, hogy a másik fele is tilt.
//
// AZ APP SZABÁLYAI ITT NEM VEHETŐK LE. Ez nem hiányzó gomb: ha innen is le
// lehetne szedni őket, a bővítmény lenne a legegyszerűbb kiskapu az appban —
// tíz perc várakozás egy próbatétel helyett. Levenni az appban kell.
//
// HA AZ APP NINCS NYITVA, az utoljára letöltött listát használjuk. Vagyis
// TOVÁBB TILT, nem enged át: a hiba a szigorúbb oldalra dől.

const KEY = 'breaker.applink';

/** Az app ezen a porton kezdi; ha foglalt volt, a következőn (lásd main/rules-bridge.ts). */
export const FIRST_PORT = 8788;
export const PORT_TRIES = 10;
export const TOKEN_HEADER = 'x-breaker-token';
/** Ennél sűrűbben nincs értelme kérdezni; a szolgáltatás-worker sokszor ébred. */
export const REFRESH_MS = 60 * 1000;

/** @returns {Promise<{token: string|null, port: number|null, rules: {host:string,path:string}[], fetchedAt: number, error: string|null}>} */
export async function loadLink() {
  const got = await chrome.storage.local.get(KEY);
  const raw = got?.[KEY] ?? {};
  const rules = Array.isArray(raw.rules) ? raw.rules : [];
  const focus = raw.focus && typeof raw.focus === 'object' ? raw.focus : {};
  return {
    token: typeof raw.token === 'string' && raw.token ? raw.token : null,
    port: Number.isInteger(raw.port) ? raw.port : null,
    // A futó munkamenet FEHÉRLISTA: ha fut, minden más tiltva. Ez is
    // gyorsítótárazódik — ha az app nincs nyitva, a munkamenet ATTÓL MÉG megy
    // tovább a lejáratáig. Bezárni az appot nem feloldás.
    focus: {
      running: focus.running === true && Number.isFinite(focus.endsAt),
      name: typeof focus.name === 'string' ? focus.name : '',
      endsAt: Number.isFinite(focus.endsAt) ? focus.endsAt : 0,
      allowSites: Array.isArray(focus.allowSites)
        ? focus.allowSites.filter((h) => typeof h === 'string' && h)
        : [],
    },
    // Rekordonként tűrünk: egy sérült bejegyzés ne vigye el a többit.
    rules: rules.filter((r) => r && typeof r.host === 'string' && typeof r.path === 'string')
      .map((r) => ({ host: r.host, path: r.path })),
    fetchedAt: Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : 0,
    error: typeof raw.error === 'string' ? raw.error : null,
  };
}

async function saveLink(link) {
  await chrome.storage.local.set({ [KEY]: link });
}

/**
 * A kód elmentése. A SZABÁLYOKAT NEM dobjuk el:
 *
 * ha valaki új kódot ír be, attól a régi szabályok nem szűnnek meg — legfeljebb
 * frissülnek. Az eldobás lazítás lenne, méghozzá a legolcsóbb fajta.
 */
export async function setToken(token) {
  const link = await loadLink();
  const clean = String(token ?? '').trim();
  await saveLink({ ...link, token: clean || null, port: null, error: null });
  return clean || null;
}

/** A kapcsolat bontása. A már letöltött szabályok MEGMARADNAK — lásd fent. */
export async function forgetToken() {
  const link = await loadLink();
  await saveLink({ ...link, token: null, port: null, error: null });
}

/**
 * Egy kör: lekérjük az app szabályait, és elmentjük.
 *
 * A port azért nem fix, mert a 8788 bármelyik másik program alatt lehet; az app
 * ilyenkor a következőn indul. Az elsőnek talált portot MEGJEGYEZZÜK, hogy ne
 * kelljen minden körben tízet végigpróbálni.
 *
 * @returns {Promise<{ok: boolean, rules?: {host:string,path:string}[], error?: string}>}
 */
export async function pullFromApp(now = Date.now(), fetchImpl = fetch) {
  const link = await loadLink();
  if (!link.token) return { ok: false, error: 'Nincs beállítva kód.' };

  const ports = link.port
    ? [link.port, ...range(FIRST_PORT, PORT_TRIES).filter((p) => p !== link.port)]
    : range(FIRST_PORT, PORT_TRIES);

  let lastError = 'Az app nem érhető el ezen a gépen.';
  for (const port of ports) {
    let res;
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}/rules`, {
        headers: { [TOKEN_HEADER]: link.token },
        cache: 'no-store',
      });
    } catch {
      continue; // ezen a porton nincs semmi
    }
    if (res.status === 401) {
      // Válaszolt VALAKI, csak nem ismeri a kódot. Ez nem hálózati hiba, hanem
      // rossz kód — ezt meg kell mondani, különben a felhasználó a portot
      // keresné.
      lastError = 'A kód nem jó. Másold ki újra az appból.';
      continue;
    }
    if (!res.ok) { lastError = `Az app hibát adott (${res.status}).`; continue; }
    let body;
    try {
      body = await res.json();
    } catch {
      lastError = 'Az app válasza értelmezhetetlen.';
      continue;
    }
    const rules = Array.isArray(body?.rules)
      ? body.rules.filter((r) => r && typeof r.host === 'string' && typeof r.path === 'string')
        .map((r) => ({ host: r.host, path: r.path }))
      : [];
    const focus = body?.focus && typeof body.focus === 'object' ? body.focus : { running: false };
    // Az ÜRES lista is válasz: azt jelenti, hogy az appban levették az összeset.
    // Csak akkor fogadjuk el, ha a kérés tényleg sikerült — ha nem érjük el az
    // appot, a régi lista marad érvényben.
    await saveLink({ ...link, port, rules, focus, fetchedAt: now, error: null });
    return { ok: true, rules, focus };
  }

  await saveLink({ ...link, error: lastError });
  return { ok: false, error: lastError };
}

function range(from, count) {
  return Array.from({ length: count }, (_, i) => from + i);
}

/**
 * Kell-e most kérdezni.
 *
 * Kód nélkül soha. Egyébként percenként egyszer: a szolgáltatás-worker minden
 * navigációnál felébred, és egy kérés navigációnként fölösleges terhelés lenne.
 */
export function dueForRefresh(link, now) {
  if (!link.token) return false;
  return now - link.fetchedAt >= REFRESH_MS;
}

/**
 * A döntéshez használt szabályok: a sajátok ÉS az appból jöttek.
 *
 * Egyesítés, nem választás. Mindkét oldal tiltás, és két tiltásból soha nem lesz
 * kevesebb tiltás.
 */
/**
 * Fut-e MOST munkamenet.
 *
 * A lejáratot HELYBEN nézzük, nem az apptól kérdezzük: ha az appot bezárták,
 * a munkamenet a saját idejéig akkor is tart — de egy perccel sem tovább.
 * Enélkül egy bezárt app örökre bent tartana a fehérlistában.
 */
export function focusActive(link, now = Date.now()) {
  const f = link?.focus;
  return !!f && f.running === true && f.endsAt > now;
}

/**
 * Átmehet-e ez a cím a munkamenet alatt.
 *
 * Egyezés vagy ALDOMAIN: a `google.com` engedése a `translate.google.com`-ot is
 * engedi. A `notgoogle.com` viszont NEM — a végén hasonlító tartománynév a
 * leggyakoribb megkerülés.
 */
export function focusAllows(link, host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return false;
  return (link?.focus?.allowSites ?? []).some((a) => h === a || h.endsWith(`.${a}`));
}

export function withAppRules(localActive, appRules) {
  const out = [...localActive];
  for (const r of appRules) {
    if (out.some((x) => x.host === r.host && x.path === r.path)) continue;
    out.push({ ...r, fromApp: true });
  }
  return out;
}
