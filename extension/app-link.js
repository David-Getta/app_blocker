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

import { cleanKeywords } from './keywords.js';

const KEY = 'breaker.applink';

/** Az app ezen a porton kezdi; ha foglalt volt, a következőn (lásd main/rules-bridge.ts). */
export const FIRST_PORT = 8788;
export const PORT_TRIES = 10;
export const TOKEN_HEADER = 'x-breaker-token';
/**
 * Ennél sűrűbben nincs értelme kérdezni; a szolgáltatás-worker sokszor ébred.
 *
 * Húsz másodperc, nem egy perc: a MUNKAMENET miatt. Aki elindít egy
 * munkamenetet, és utána még egy percig megnyithatja a YouTube-ot, az nem fog
 * megbízni benne. Egy kérés a saját gépen belül húsz másodpercenként semmibe
 * nem kerül.
 */
export const REFRESH_MS = 20 * 1000;

/**
 * Ennyit várunk EGY portra, mielőtt továbblépünk.
 *
 * A kérés a saját géped 127.0.0.1 címére megy, tehát a válasz ezredmásodperces
 * nagyságrendű — három másodperc bőven elég. Időkorlát NÉLKÜL viszont egy port,
 * amin valami MÁS ül és fogadja a kapcsolatot, de sosem válaszol, örökre
 * megállítaná a lekérdezést: a `fetch`-nek a böngészőben nincs alapértelmezett
 * határideje. A bővítmény ilyenkor csendben a RÉGI szabálylistával működne
 * tovább, és semmi nem szólna róla — az appban felvett új tiltás sosem érne át.
 */
export const PORT_TIMEOUT_MS = 3000;

/**
 * `promise`, de legfeljebb `ms`-ig.
 *
 * A megszakítást a hívó a `signal`-lal is elküldi; ez a verseny amiatt kell,
 * hogy a határidő akkor is működjön, ha a `fetch` valamiért nem reagál rá.
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => { setTimeout(() => reject(new Error('időtúllépés')), ms); }),
  ]);
}

/**
 * Ennyi ideig hisszük el a „zárva” listát a legutóbbi SIKERES lehúzás után.
 *
 * A szabályokkal ellentétben a zárva-lista PILLANATNYI állapot: a hűtés lejár,
 * a keret éjfélkor újraindul, a megváltott feloldás azonnal nyit. Ha az app
 * nincs ott, hogy frissítse, a magyarázó lap fél óra után hazudna — a tiltást
 * úgyis a DNS tartja, a lapnak csak friss adatból szabad beszélnie. Három
 * lehúzásnyi idő: egy-két kihagyott kör (alvó gép) még belefér.
 */
export const CLOSED_FRESH_MS = 3 * 20 * 1000;

/** Egy zárva-bejegyzés szűrése: csak az ismert alak megy át. */
function cleanClosed(list) {
  const reasons = ['always', 'schedule', 'cooldown', 'limit'];
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && typeof c.host === 'string' && c.host && reasons.includes(c.reason))
    .map((c) => ({
      host: c.host.toLowerCase(),
      reason: c.reason,
      until: Number.isFinite(c.until) && c.until > 0 ? c.until : 0,
    }));
}

/**
 * Egy indok-bejegyzés szűrése: hosztnév és egy józan hosszú szöveg — más nem
 * megy át. A szöveg a felhasználóé (ő írta az appban), de a tárba és a lapra
 * innen kerül: vezérlőkarakter nélkül, egy szóközzel, legfeljebb 140 jellel.
 */
function cleanNotes(list) {
  return (Array.isArray(list) ? list : [])
    .filter((n) => n && typeof n.host === 'string' && n.host && typeof n.text === 'string')
    .map((n) => ({
      host: n.host.toLowerCase(),
      text: n.text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140),
    }))
    .filter((n) => n.text);
}

/**
 * Az indok ehhez a hosztnévhez, ha az app adott — PONTOS hosztnévre, mint a
 * zárva-lista: a lap ne mondjon olyan indokot, amit másik címre írtak.
 */
export function noteFor(link, host) {
  const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
  if (!h) return null;
  const n = (link?.notes ?? []).find((x) => x && x.host === h);
  return n ? n.text : null;
}

/**
 * A tárból vagy a hídról jött zárlat használható alakja: `{ until }` vagy null.
 *
 * Csak a vég kell. A frissességet SZÁNDÉKOSAN nem nézzük (a zárva-listánál
 * igen): a zárlat csak hosszabbodni tud, rövidülni nem — egy régebbi lehúzás
 * vége tehát alsó becslés, és az is igaz marad. Amit nem tudunk, az az, hogy
 * azóta nem lett-e hosszabb; azt a következő lehúzás hozza.
 */
function cleanLockdown(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const until = Number(raw.until);
  if (!Number.isFinite(until) || until <= 0) return null;
  // A heti ablak tartja-e: csak a szó szerinti igaz számít — a lap ebből
  // mondja, hogy nem kézzel indított döntés, hanem a hétköznap.
  return raw.byWindow === true ? { until, byWindow: true } : { until };
}

/**
 * A megbízott (párban zárolás) a tárból vagy a hídról: `{ name }` vagy null.
 * Csak a név jön — a jelmondat lenyomata az appé. A nevet a lap kiírja,
 * ezért itt is tisztítjuk, mint az indokot.
 */
function cleanPartner(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') return null;
  const name = raw.name.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return name ? { name } : null;
}

/**
 * A megbízott neve, ha az app adott — frissesség nélkül, szándékosan: a
 * megbízott a lenyomattal él, nem a lehúzással; a levétele próbatétel, és az
 * app a következő lehúzáskor leveszi innen is.
 */
export function partnerNameOf(link) {
  return link?.partner?.name ? String(link.partner.name) : null;
}

/** @returns {Promise<{token: string|null, port: number|null, rules: {host:string,path:string}[], fetchedAt: number, error: string|null}>} */
export async function loadLink() {
  const got = await chrome.storage.local.get(KEY);
  const raw = got?.[KEY] ?? {};
  const rules = Array.isArray(raw.rules) ? raw.rules : [];
  const focus = raw.focus && typeof raw.focus === 'object' ? raw.focus : {};
  return {
    token: typeof raw.token === 'string' && raw.token ? raw.token : null,
    port: Number.isInteger(raw.port) ? raw.port : null,
    // A csatorna-szűrők is gyorsítótárazódnak, ugyanazért, amiért a szabályok:
    // ha az app épp nincs nyitva, az utoljára letöltött állapot él tovább —
    // vagyis tovább szűr, nem enged át. Bezárni az appot nem feloldás.
    channels: (Array.isArray(raw.channels) ? raw.channels : [])
      .filter((f) => f && typeof f.host === 'string' && f.host && Array.isArray(f.allow))
      .map((f) => ({
        host: f.host,
        allow: f.allow.filter((k) => typeof k === 'string' && k),
      })),
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
      // A heti ablak szerint indult (nem gombnyomásra): a felugró és a tiltó
      // lap ezt kimondja, hogy aki nem maga indította, tudja, miért fut.
      window: focus.window === true,
    },
    // A MOST zárva lévő hosztnevek, okkal — a tiltó lap ebből magyaráz. A
    // frissessége számít, ezért a döntés nem innen, hanem a `closedFor`-ból jön.
    closed: cleanClosed(raw.closed),
    lockdown: cleanLockdown(raw.lockdown),
    notes: cleanNotes(raw.notes),
    partner: cleanPartner(raw.partner),
    // A kulcsszavak — a mag szűrőjén át, mint minden más.
    keywords: cleanKeywords(raw.keywords),
    // A JAVASOLT csomag: amit a felugró lap egy kattintással indíthat.
    suggest: cleanSuggest(raw.suggest),
    // Rekordonként tűrünk: egy sérült bejegyzés ne vigye el a többit.
    rules: rules.filter((r) => r && typeof r.host === 'string' && typeof r.path === 'string')
      .map((r) => ({ host: r.host, path: r.path })),
    fetchedAt: Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : 0,
    /**
     * Mikor PRÓBÁLKOZTUNK utoljára — a sikertelen kör is léptet rajta.
     *
     * A `fetchedAt` csak sikernél lép, mert az mondja meg, mennyire friss a
     * SZABÁLYLISTA. Ha viszont csak azt néznénk, akkor egy zárva lévő app
     * mellett minden egyes lapbetöltés újraindítaná a tízportos keresést —
     * és a felhasználó nem is tudná, miért lassul a böngészője.
     */
    attemptedAt: Number.isFinite(raw.attemptedAt) ? raw.attemptedAt : 0,
    error: typeof raw.error === 'string' ? raw.error : null,
  };
}

async function saveLink(link) {
  await chrome.storage.local.set({ [KEY]: link });
}

/**
 * A javasolt csomag tisztán: { packId, name, minutes, peakHour } — vagy null.
 * Régi app válaszában nincs, az sem hiba. A csúcs-óra (amire a lap heti
 * ablakot tehet) csak 0–23 egészként számít; különben null — a javaslat marad.
 */
export function cleanSuggest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const minutes = Number(raw.minutes);
  if (typeof raw.packId !== 'string' || !raw.packId || typeof raw.name !== 'string' || !raw.name) return null;
  if (!Number.isInteger(minutes) || minutes <= 0) return null;
  const peakHour = Number.isInteger(raw.peakHour) && raw.peakHour >= 0 && raw.peakHour <= 23 ? raw.peakHour : null;
  // LE VAN-E FEDVE: a csomag neve, amelynek ablaka a csúcs-órát fedi — kívülről jött szöveg, rövidre vágva.
  const peakPack = typeof raw.peakPack === 'string' && raw.peakPack ? raw.peakPack.slice(0, 40) : null;
  // A MENET-NAP: az app mondja, ma szoktál-e leülni — csak a szó szerinti igaz számít.
  const focusDay = raw.focusDay === true;
  // A MENET-ÓRA: az app mondja, most szoktál-e elkezdeni — csak a szó szerinti igaz számít.
  const focusHourNow = raw.focusHourNow === true;
  // A MENET-ÓRA, amire ablak tehető: az app mondja (a csúcs-óra tükre) — csak egész óra, 0–23.
  const focusHour = Number.isInteger(raw.focusHour) && raw.focusHour >= 0 && raw.focusHour <= 23 ? raw.focusHour : null;
  // LE VAN-E FEDVE a menet-óra: a csomag neve, amelynek ablaka fedi — kívülről jött szöveg, rövidre vágva.
  const focusHourPack = typeof raw.focusHourPack === 'string' && raw.focusHourPack ? raw.focusHourPack.slice(0, 40) : null;
  // AMIKOR A CSÚCS-ÓRA A MENET-ÓRA: az app mondja — csak a szó szerinti igaz számít.
  const sameHour = raw.sameHour === true;
  // A MENET-SOROZAT: hány napja ülsz le minden nap — az app száma; csak nemnegatív egész, különben nulla.
  const focusStreak = Number.isInteger(raw.focusStreak) && raw.focusStreak >= 0 ? raw.focusStreak : 0;
  return { packId: raw.packId, name: raw.name, minutes, peakHour, peakPack, focusDay, focusHourNow, focusHour, focusHourPack, sameHour, focusStreak };
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
export async function pullFromApp(now = Date.now(), fetchImpl = fetch, timeoutMs = PORT_TIMEOUT_MS) {
  const link = await loadLink();
  if (!link.token) return { ok: false, error: 'Nincs beállítva kód.' };

  const ports = link.port
    ? [link.port, ...range(FIRST_PORT, PORT_TRIES).filter((p) => p !== link.port)]
    : range(FIRST_PORT, PORT_TRIES);

  let lastError = 'Az app nem érhető el ezen a gépen.';
  for (const port of ports) {
    let res;
    // A megszakítás a VALÓDI kérést is leállítja, nem csak a várakozást: egy
    // félbehagyott, de tovább élő kapcsolat portonként gyűlne.
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    try {
      res = await withTimeout(fetchImpl(`http://127.0.0.1:${port}/rules`, {
        headers: { [TOKEN_HEADER]: link.token },
        cache: 'no-store',
        ...(ctrl ? { signal: ctrl.signal } : {}),
      }), timeoutMs);
    } catch {
      if (ctrl) ctrl.abort();
      // A `lastError` SZÁNDÉKOSAN marad, ami volt: ha egy korábbi port már
      // adott értelmes választ (például „a kód nem jó”), azt nem szabad
      // felülírni egy „itt nincs semmi”-vel. Az első próbám pont ezen bukott
      // el — a rossz kódra hálózati hibát írt volna ki, és a felhasználó a
      // portot kereste volna.
      continue; // ezen a porton nincs semmi, vagy nem válaszol
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
      // A TÖRZS beolvasására is kiterjed a határidő. Egy kiszolgáló, ami
      // fejlécet küld, majd a törzset nem fejezi be, különben ugyanúgy
      // megállítana mindent — csak eggyel később.
      body = await withTimeout(res.json(), timeoutMs);
    } catch {
      if (ctrl) ctrl.abort();
      lastError = 'Az app válasza értelmezhetetlen.';
      continue;
    }
    const rules = Array.isArray(body?.rules)
      ? body.rules.filter((r) => r && typeof r.host === 'string' && typeof r.path === 'string')
        .map((r) => ({ host: r.host, path: r.path }))
      : [];
    const focus = body?.focus && typeof body.focus === 'object' ? body.focus : { running: false };
    // Egy RÉGI app válaszában nincs `channels` mező — az nem hiba, hanem üres
    // lista: a szűrés ilyenkor egyszerűen nem fut, ahogy eddig sem futott.
    const channels = (Array.isArray(body?.channels) ? body.channels : [])
      .filter((f) => f && typeof f.host === 'string' && f.host && Array.isArray(f.allow))
      .map((f) => ({
        host: f.host,
        allow: f.allow.filter((k) => typeof k === 'string' && k),
      }));
    // Egy régi app válaszában `closed` sincs — az sem hiba: a tiltó lap ilyenkor
    // egyszerűen nem magyaráz, a DNS pedig ugyanúgy tilt, ahogy eddig.
    const closed = cleanClosed(body?.closed);
    // A zárlat vége, ha az app tud ilyet — régi app válaszában nincs, az sem hiba.
    const lockdown = cleanLockdown(body?.lockdown);
    // Az indokok — régi app válaszában nincs, az sem hiba: a lap akkor nem idéz.
    const notes = cleanNotes(body?.notes);
    // A megbízott neve — régi app válaszában nincs, az sem hiba: a lap akkor nem mondja.
    const partner = cleanPartner(body?.partner);
    // A kulcsszavak — régi app válaszában nincs, az sem hiba: üres lista.
    const keywords = cleanKeywords(body?.keywords);
    // A javasolt csomag — régi app válaszában nincs, az sem hiba: nincs gomb.
    const suggest = cleanSuggest(body?.suggest);
    // Az ÜRES lista is válasz: azt jelenti, hogy az appban levették az összeset.
    // Csak akkor fogadjuk el, ha a kérés tényleg sikerült — ha nem érjük el az
    // appot, a régi lista marad érvényben.
    await saveLink({
      ...link, port, rules, focus, channels, closed, lockdown, notes, partner, keywords, suggest, fetchedAt: now, error: null,
    });
    return { ok: true, rules, focus, channels, closed, lockdown, notes, partner, keywords, suggest };
  }

  // A PRÓBA idejét megjegyezzük, a szabálylistát viszont nem bántjuk: az app
  // elérhetetlensége nem jelenti azt, hogy nincsenek szabályok.
  await saveLink({ ...link, error: lastError, attemptedAt: now });
  return { ok: false, error: lastError };
}

function range(from, count) {
  return Array.from({ length: count }, (_, i) => from + i);
}

const HITS_SENT_KEY = 'breaker.hitsSent';

/**
 * A MEGAKADÁSOK vissza az appba: az elmúlt hét nap sorai (hits.js
 * `hitsReport`) a hídra, a kóddal, egy állandó forrás-azonosítóval — két
 * böngésző két könyv, a segéd összeadja őket. Ugyanarra a portra, ahol az app
 * utoljára válaszolt; ha ott nincs, nem keresgélünk: a következő lehúzás
 * úgyis megtalálja. Ugyanaz a jelentés nem megy kétszer — a tár őrzi, mi ment
 * át utoljára; az app hibája nem jegyzi meg, a következő körben újra megy.
 */
export async function pushHits(report, now = Date.now(), fetchImpl = fetch, timeoutMs = PORT_TIMEOUT_MS) {
  const link = await loadLink();
  if (!link.token || !link.port) return { ok: false, error: 'Nincs összekötve.' };
  const days = Array.isArray(report) ? report : [];
  const sent = (await chrome.storage.local.get(HITS_SENT_KEY))?.[HITS_SENT_KEY];
  const source = typeof sent?.source === 'string' && sent.source ? sent.source : newSourceId();
  const key = JSON.stringify(days);
  if (sent?.key === key) return { ok: true, skipped: true };
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  try {
    const res = await withTimeout(fetchImpl(`http://127.0.0.1:${link.port}/hits`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: link.token, 'content-type': 'application/json' },
      body: JSON.stringify({ source, days }),
      cache: 'no-store',
      ...(ctrl ? { signal: ctrl.signal } : {}),
    }), timeoutMs);
    if (!res.ok) return { ok: false, error: `Az app hibát adott (${res.status}).` };
  } catch (err) {
    if (ctrl) ctrl.abort();
    return { ok: false, error: String(err?.message ?? err) };
  }
  await chrome.storage.local.set({ [HITS_SENT_KEY]: { source, key, at: now } });
  return { ok: true };
}

/**
 * EGY KATTINTÁS a felugró lapról a menetig: a javasolt csomag indítása az
 * appban, a hídon, a kóddal — szigorítás, ingyen. Ugyanarra a portra, ahol az
 * app utoljára válaszolt. A bíró nemje (futó menet, ismeretlen csomag) a
 * válaszban jön vissza, nem hálózati hibaként.
 */
export async function startFocusInApp(packId, minutes, fetchImpl = fetch, timeoutMs = PORT_TIMEOUT_MS) {
  return postToApp('/focus_start', { packId, minutes }, fetchImpl, timeoutMs);
}

/**
 * ABLAK A CSÚCS-ÓRÁRA a tiltó lapról és a felugró lapról: heti ablak a
 * javasolt csomagra a csúcs egy órájában, minden napra — az appban, a hídon,
 * a kóddal. Csak felvétel: ablakos csomagra az app nemet mond, a csere az övé.
 */
export async function addFocusWindowInApp(packId, hour, fetchImpl = fetch, timeoutMs = PORT_TIMEOUT_MS) {
  return postToApp('/focus_window', { packId, hour }, fetchImpl, timeoutMs);
}

/** Egy befelé menő kérés a hídon: { ok } vagy { ok: false, error } — a bíró nemje szöveggel, nem hálózati hibaként. */
async function postToApp(path, payload, fetchImpl, timeoutMs) {
  const link = await loadLink();
  if (!link.token || !link.port) return { ok: false, error: 'Nincs összekötve.' };
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  try {
    const res = await withTimeout(fetchImpl(`http://127.0.0.1:${link.port}${path}`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: link.token, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      ...(ctrl ? { signal: ctrl.signal } : {}),
    }), timeoutMs);
    if (!res.ok) {
      let msg = `Az app hibát adott (${res.status}).`;
      try { const b = await withTimeout(res.json(), timeoutMs); if (typeof b?.error === 'string' && b.error) msg = b.error; } catch { /* a státusz marad */ }
      return { ok: false, error: msg };
    }
  } catch (err) {
    if (ctrl) ctrl.abort();
    return { ok: false, error: String(err?.message ?? err) };
  }
  return { ok: true };
}

/** A könyv forrás-azonosítója: véletlen, egyszer, ezé a böngésző-profilé. */
function newSourceId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Kell-e most kérdezni.
 *
 * Kód nélkül soha. Egyébként percenként egyszer: a szolgáltatás-worker minden
 * navigációnál felébred, és egy kérés navigációnként fölösleges terhelés lenne.
 */
export function dueForRefresh(link, now) {
  if (!link.token) return false;
  // A KÉSŐBBI a kettő közül: a sikeres lekérdezés és a sikertelen PRÓBA is
  // számít. Enélkül egy elérhetetlen app mellett minden lapbetöltés újraindítja
  // a keresést — a `fetchedAt` ugyanis csak sikernél lép.
  const last = Math.max(link.fetchedAt, link.attemptedAt ?? 0);
  return now - last >= REFRESH_MS;
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

/**
 * Zárva van-e MOST ez a hosztnév az app szerint — és miért.
 *
 * Ez magyarázat, nem érvényesítés: a tiltást a DNS tartja, ez a lap szövegét
 * adja. Ezért itt a hiba iránya a SZOKÁSOS FORDÍTOTTJA: kétes esetben inkább
 * nem szólunk, mint hogy zárva-t mondjunk egy már kinyílt oldalra —
 *
 *   - csak PONTOS hosztnév-egyezés számít (a hosts-fájl is így zár);
 *   - a lejáratos bejegyzés (hűtés, keret) a saját idejével lejár;
 *   - az egész lista csak a legutóbbi sikeres lehúzás után CLOSED_FRESH_MS-ig
 *     él: a lejárat nélküli zárás (sima tiltás, menetrend) is megnyílhat
 *     időközben az appban, például egy megváltott feloldással.
 *
 * @returns {{host:string,reason:string,until:number}|null}
 */
export function closedFor(link, host, now = Date.now()) {
  const h = String(host ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return null;
  if (!link || now - (link.fetchedAt ?? 0) > CLOSED_FRESH_MS) return null;
  for (const c of link.closed ?? []) {
    if (c.host !== h) continue;
    if (c.until > 0 && c.until <= now) continue;
    return c;
  }
  return null;
}

/**
 * Meddig tart a zárlat (epoch ms), vagy 0, ha nincs vagy lejárt.
 *
 * Frissesség nélkül, szándékosan — lásd `cleanLockdown`: a zárlat csak
 * hosszabbodhat, egy régebbi vég is igaz alsó becslés.
 */
export function lockdownUntil(link, now = Date.now()) {
  const until = Number(link?.lockdown?.until);
  return Number.isFinite(until) && until > now ? until : 0;
}

export function withAppRules(localActive, appRules) {
  const out = [...localActive];
  for (const r of appRules) {
    if (out.some((x) => x.host === r.host && x.path === r.path)) continue;
    out.push({ ...r, fromApp: true });
  }
  return out;
}
