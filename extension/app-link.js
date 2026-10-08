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

import { incognitoAllowed } from './incognito.js';
import { cleanKeywords } from './keywords.js';

const KEY = 'breaker.applink';

/** Az app ezen a porton kezdi; ha foglalt volt, a következőn (lásd main/rules-bridge.ts). */
export const FIRST_PORT = 8788;
export const PORT_TRIES = 10;
export const TOKEN_HEADER = 'x-breaker-token';
/** Fut-e a bővítmény inkognitóban: '1' / '0' — az app ebből tudja kimondani, ha nem. */
export const INCOGNITO_HEADER = 'x-breaker-incognito';
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

/**
 * Ennyi ideig az app ÉLŐ szava dönt a munkamenetről a legutóbbi sikeres
 * lehúzás után. Utána — ha az app nem válaszol — a tárolt heti ablakok is
 * élnek: a segéd az ablak menetét az app nélkül is elindítja, és a
 * böngészőben különben senki nem tartaná be. Három lehúzásnyi idő, mint a
 * zárva-listánál.
 */
export const FOCUS_FRESH_MS = 3 * 20 * 1000;

/** Ennél több ablak-előfordulás nem tárolódik (az app egy hetet küld). */
const MAX_FOCUS_WINDOWS = 64;
/** Ennél több zárlat-ablak-előfordulás sem (hét ablak, egy hét). */
const MAX_LOCKDOWN_WINDOWS = 64;

/**
 * Ennyi csend után számít az app távollévőnek a MÉRÉS-ŐR szempontjából —
 * ugyanannyi, mint a segédben (APP_GRACE_MS, shared/measure-guard.ts): a lap
 * akkor mondja, hogy zárva, amikor a segéd is zár.
 */
export const MEASURE_GUARD_SILENT_MS = 3 * 60 * 1000;
/** Ennél több őrzött hosztnév nem tárolódik (az app is ennyit küld). */
const MAX_GUARD_HOSTS = 2000;

/**
 * A mérés-őr a hídról: { hosts } — vagy null, ha nincs bekapcsolva. Régi app
 * válaszában nincs: az nem hiba, nincs őr (a lap akkor nem magyaráz).
 */
function cleanMeasureGuard(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.hosts)) return null;
  const hosts = [...new Set(raw.hosts
    .filter((h) => typeof h === 'string')
    .map((h) => h.trim().toLowerCase().replace(/\.+$/, ''))
    .filter((h) => h && h.length <= 253))].slice(0, MAX_GUARD_HOSTS);
  return { hosts };
}

/**
 * Friss-e az app szava: az utolsó sikeres lehúzás legfeljebb FOCUS_FRESH_MS
 * régi. Amíg igen, az app élő állapota dönt a munkamenetről és a zárlatról;
 * utána a tárolt heti ablakok is élnek.
 */
export function appFresh(link, now = Date.now()) {
  return Number.isFinite(link?.fetchedAt) && link.fetchedAt > 0 && now - link.fetchedAt <= FOCUS_FRESH_MS;
}

/**
 * A hídról jött heti ablak-előfordulások tisztán: csomag-azonosító, név,
 * engedett oldalak, kezdés, vég — a rosszul formált kimarad. Régi app
 * válaszában nincs: az nem hiba, üres lista (az ablak akkor csak futó app
 * mellett él, ahogy eddig).
 */
function cleanFocusWindows(list) {
  return (Array.isArray(list) ? list : [])
    .filter((w) => w && typeof w.packId === 'string' && w.packId
      && Number.isFinite(w.startsAt) && Number.isFinite(w.endsAt) && w.endsAt > w.startsAt
      && Array.isArray(w.allowSites))
    .slice(0, MAX_FOCUS_WINDOWS)
    .map((w) => ({
      packId: w.packId,
      name: typeof w.name === 'string' ? [...w.name].slice(0, 40).join('') : '',
      allowSites: w.allowSites.filter((h) => typeof h === 'string' && h),
      startsAt: w.startsAt,
      endsAt: w.endsAt,
    }));
}

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

/** Ennyi közelgő zárást tárolunk (az app is ennyit küld). */
export const MAX_SOON = 500;

/**
 * A ZÁRÁS ELŐTTI SÁV ennyivel a zárás előtt jelenik meg a lapon — ugyanannyi,
 * mint az app értesítése a szünet végéről (`PAUSE_END_WARN_MS`), a mag-szinkron
 * őr nézi.
 */
export const SOON_BANNER_MS = 2 * 60_000;

/**
 * Egy közelgő-zárás bejegyzés szűrése: hosztnév, fajta, és a fajtához illő
 * szám (`at` a szünetnél és a menetrendnél, `left` másodperc a keretnél). A
 * rosszul formált kimarad; régi app nem küldi — az üres lista.
 */
export function cleanSoon(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e.host !== 'string' || !e.host) continue;
    const host = e.host.toLowerCase();
    if ((e.kind === 'pause' || e.kind === 'schedule') && Number.isFinite(e.at) && e.at > 0) {
      out.push({ host, kind: e.kind, at: e.at });
    } else if (e.kind === 'limit' && Number.isFinite(e.left) && e.left > 0) {
      out.push({ host, kind: 'limit', left: e.left });
    } else if (e.kind === 'burst' && Number.isFinite(e.left) && e.left > 0
      && Number.isFinite(e.of) && e.of > 0 && Number.isFinite(e.cool) && e.cool > 0) {
      out.push({ host, kind: 'burst', left: e.left, of: e.of, cool: e.cool });
    }
    if (out.length >= MAX_SOON) break;
  }
  return out;
}

/**
 * Zárul-e HAMAROSAN ez a most még nyitott hosztnév — és miért: `{ kind,
 * leftMs, id }`, vagy null. Csak friss lehúzásból (`appFresh`): egy régi jelre ne
 * mondjunk zárást, ami azóta talán el is maradt (visszakapcsolta, megváltotta).
 * Csak az utolsó `SOON_BANNER_MS`-en belül, és a legközelebbi nyer.
 *
 * A keret nem óra, hanem aktív idő: az app a lehúzáskor hátralévő
 * másodperceket adja, és azóta — ha a lapon voltál — ennyivel kevesebb. Az
 * eltelt időt levonjuk: inkább korábban szóljunk, mint későn.
 *
 * Az `id` a zárás azonosítója (fajta és időpont): a lap ebből tudja, hogy a
 * bezárt sáv UGYANARRÓL a zárásról szólna-e. A meghosszabbított szünet már
 * másik zárás. A keretnek és az adagnak nincs időpontja (aktív idő), az
 * azonosítójuk a fajta.
 *
 * Az ADAG (ennyi használat után szünet) ugyanígy aktív idő; a küszöbe az
 * utolsó két perc, de legfeljebb az adag fele, és a sáv a szünet hosszát is
 * kimondja (`cool`, másodperc).
 */
export function closingSoonFor(link, host, now = Date.now()) {
  const h = String(host ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (!h || !appFresh(link, now)) return null;
  const since = Math.max(0, now - link.fetchedAt);
  let best = null;
  for (const e of link.soon ?? []) {
    if (e.host !== h) continue;
    const active = e.kind === 'limit' || e.kind === 'burst';
    const leftMs = active ? e.left * 1000 - since : e.at - now;
    // Az ADAG küszöbe legfeljebb a fele: egy kétperces adag ne az elejétől szóljon.
    const horizon = e.kind === 'burst' ? Math.min(SOON_BANNER_MS, (e.of * 1000) / 2) : SOON_BANNER_MS;
    if (!(leftMs > 0) || leftMs > horizon) continue;
    if (best === null || leftMs < best.leftMs) {
      best = { kind: e.kind, leftMs, id: active ? e.kind : `${e.kind}@${e.at}` };
      if (e.kind === 'burst') best.cool = e.cool;
    }
  }
  return best;
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
      // KÓDPONTBAN vágva, mint az app magja: a `slice` egy emodzsit félbe vágna,
      // és a lapon a fele értelmetlen jelként maradna.
      text: [...n.text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 140).join(''),
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
  const n = Number(raw.until);
  const until = Number.isFinite(n) && n > 0 ? n : 0;
  // A heti zárlat-ablakok következő hete (lásd `effectiveLockdown`): csak
  // valódi számok, kezdés a vég előtt. Régi app válaszában nincs — az nem
  // hiba, üres lista.
  const windows = (Array.isArray(raw.windows) ? raw.windows : [])
    .filter((w) => w && Number.isFinite(w.startsAt) && Number.isFinite(w.endsAt) && w.endsAt > w.startsAt)
    .slice(0, MAX_LOCKDOWN_WINDOWS)
    .map((w) => ({ startsAt: w.startsAt, endsAt: w.endsAt }));
  if (until === 0 && windows.length === 0) return null;
  // A heti ablak tartja-e: csak a szó szerinti igaz számít — a lap ebből
  // mondja, hogy nem kézzel indított döntés, hanem a hétköznap.
  const out = until > 0 && raw.byWindow === true ? { until, byWindow: true } : { until };
  return windows.length > 0 ? { ...out, windows } : out;
}

/**
 * A megbízott (párban zárolás) a tárból vagy a hídról: `{ name }` vagy null.
 * Csak a név jön — a jelmondat lenyomata az appé. A nevet a lap kiírja,
 * ezért itt is tisztítjuk, mint az indokot.
 */
function cleanPartner(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') return null;
  const name = [...raw.name.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 40).join('');
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
      // A futó menet SAJÁT csomagjának listája, a rárétegződő ablakok metszete
      // nélkül — app nélkül ebből számolunk (lásd `effectiveFocus`). Régi app
      // nem küldi: akkor null, és a fenti, metszett lista marad az alap.
      packAllowSites: Array.isArray(focus.packAllowSites)
        ? focus.packAllowSites.filter((h) => typeof h === 'string' && h)
        : null,
      // A heti ablak szerint indult (nem gombnyomásra): a felugró és a tiltó
      // lap ezt kimondja, hogy aki nem maga indította, tudja, miért fut.
      window: focus.window === true,
      // A heti ablakok következő hete: ha az app nem válaszol, ezekből él a
      // menet a böngészőben (lásd `effectiveFocus`).
      windows: cleanFocusWindows(focus.windows),
    },
    // A MOST zárva lévő hosztnevek, okkal — a tiltó lap ebből magyaráz. A
    // frissessége számít, ezért a döntés nem innen, hanem a `closedFor`-ból jön.
    closed: cleanClosed(raw.closed),
    // A hamarosan záruló, most még nyitott hosztnevek — a lap ebből szól előre
    // (lásd `closingSoonFor`); a frissessége itt is számít.
    soon: cleanSoon(raw.soon),
    lockdown: cleanLockdown(raw.lockdown),
    // A mérés-őr: ha az app elhallgat, ezek a hosztok zárva (lásd `measureGuardFor`).
    measureGuard: cleanMeasureGuard(raw.measureGuard),
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
  const peakPack = typeof raw.peakPack === 'string' && raw.peakPack ? [...raw.peakPack].slice(0, 40).join('') : null;
  // A MENET-NAP: az app mondja, ma szoktál-e leülni — csak a szó szerinti igaz számít.
  const focusDay = raw.focusDay === true;
  // A MENET-ÓRA: az app mondja, most szoktál-e elkezdeni — csak a szó szerinti igaz számít.
  const focusHourNow = raw.focusHourNow === true;
  // A MENET-ÓRA, amire ablak tehető: az app mondja (a csúcs-óra tükre) — csak egész óra, 0–23.
  const focusHour = Number.isInteger(raw.focusHour) && raw.focusHour >= 0 && raw.focusHour <= 23 ? raw.focusHour : null;
  // LE VAN-E FEDVE a menet-óra: a csomag neve, amelynek ablaka fedi — kívülről jött szöveg, rövidre vágva.
  const focusHourPack = typeof raw.focusHourPack === 'string' && raw.focusHourPack ? [...raw.focusHourPack].slice(0, 40).join('') : null;
  // AMIKOR A CSÚCS-ÓRA A MENET-ÓRA: az app mondja — csak a szó szerinti igaz számít.
  const sameHour = raw.sameHour === true;
  // A MENET-SOROZAT: hány napja ülsz le minden nap — az app száma; csak nemnegatív egész, különben nulla.
  const focusStreak = Number.isInteger(raw.focusStreak) && raw.focusStreak >= 0 ? raw.focusStreak : 0;
  // A LEGHOSSZABB SOROZAT: az app száma; csak nemnegatív egész, különben nulla — a lap a mostani mellett mondja.
  const focusLongestStreak = Number.isInteger(raw.focusLongestStreak) && raw.focusLongestStreak >= 0 ? raw.focusLongestStreak : 0;
  // KÖZELEG A NAPI KERET: az app kész mondata (a fedőnevet is ő oldja fel) — kívülről jött szöveg, rövidre vágva.
  const limitSoon = typeof raw.limitSoon === 'string' ? [...raw.limitSoon].slice(0, 80).join('') : '';
  return { packId: raw.packId, name: raw.name, minutes, peakHour, peakPack, focusDay, focusHourNow, focusHour, focusHourPack, sameHour, focusStreak, focusLongestStreak, limitSoon };
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
  // Fut-e inkognitóban: az app ebből tudja kimondani, ha ott a munkamenet és a
  // kulcsszó nem érvényesül. Ha a böngésző nem tudja megmondani, nem küldjük.
  const incognito = await incognitoAllowed();
  const extra = typeof incognito === 'boolean' ? { [INCOGNITO_HEADER]: incognito ? '1' : '0' } : {};
  for (const port of ports) {
    let res;
    // A megszakítás a VALÓDI kérést is leállítja, nem csak a várakozást: egy
    // félbehagyott, de tovább élő kapcsolat portonként gyűlne.
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    try {
      res = await withTimeout(fetchImpl(`http://127.0.0.1:${port}/rules`, {
        headers: { [TOKEN_HEADER]: link.token, ...extra },
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
    // A mérés-őr — régi app válaszában nincs, az sem hiba: nincs őr.
    const measureGuard = cleanMeasureGuard(body?.measureGuard);
    // A közelgő zárások — régi app válaszában nincs, az sem hiba: nincs sáv.
    const soon = cleanSoon(body?.soon);
    // Az ÜRES lista is válasz: azt jelenti, hogy az appban levették az összeset.
    // Csak akkor fogadjuk el, ha a kérés tényleg sikerült — ha nem érjük el az
    // appot, a régi lista marad érvényben.
    await saveLink({
      ...link, port, rules, focus, channels, closed, lockdown, notes, partner, keywords, suggest, measureGuard,
      soon, fetchedAt: now, error: null,
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

/** Egy fül címének tartománya — csak valódi weboldalé (http/https); máskor null. */
function tabHost(url) {
  try {
    const u = new URL(String(url ?? ''));
    return /^https?:$/.test(u.protocol) && u.hostname ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * A MÉRŐ JELE: melyik oldal van elöl ebben a böngészőben.
 *
 * Az app a böngésző címét a rendszeren át olvassa; ha ez nem megy (macOS-en a
 * frissítés után visszavont „Automatizálás” engedély, Windowson egy címsor,
 * amit a szonda nem lát), a böngészőben töltött idő APPKÉNT könyvelődik, és az
 * oldal napi kerete nem fogy. Itt viszont pontosan tudjuk, melyik fül van elöl.
 * Ha a böngésző nincs fókuszban, a jel semmiről nem szól — ezt is megmondjuk,
 * különben az app egy régi oldalra könyvelné egy másik app perceit.
 *
 * @returns {Promise<{focused: boolean, host: string|null}>}
 */
export async function currentTabHint(api = globalThis.chrome) {
  try {
    const w = await api.windows.getLastFocused({ populate: false });
    if (!w || w.focused !== true) return { focused: false, host: null };
    const [tab] = await api.tabs.query({ active: true, windowId: w.id });
    return { focused: true, host: tabHost(tab?.url) };
  } catch {
    return { focused: false, host: null };
  }
}

/** A jel az appnak, a hídon, a kóddal. Hiba esetén csend: a következő kör hozza. */
export async function postTabHint(hint, fetchImpl = fetch, timeoutMs = PORT_TIMEOUT_MS) {
  return postToApp('/tab', { focused: hint.focused === true, host: hint.host ?? null }, fetchImpl, timeoutMs);
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
 * A MOST hatásos munkamenet: { name, endsAt, allowSites, window } — vagy null.
 *
 * Amíg az app friss szava megvan (FOCUS_FRESH_MS), az dönt: ő tudja, fut-e
 * menet, és hogy egy ablakét már leállították-e (kifizetett próbatétellel) —
 * a listája a most hatásos, a rárétegződő ablakok metszete már benne.
 *
 * Ha az app régebben szólt — bezárták, vagy nem válaszol —, a tárolt heti
 * ablakok közül a most tartók is érvényesek: a segéd az app nélkül is
 * betartja őket, és a böngészőben különben senki nem tenné. Ugyanúgy, mint a
 * segédben (focus.ts `effectivePack`): a futó menetet az ablak NEM váltja ki,
 * hanem rárétegződik — a lista a menet saját csomagjának és a most tartó
 * ablakoknak a METSZETE. Ha nem fut menet, az elsőként kezdődő ablak a menet
 * (a segéd is azt indítja), a többi arra rétegződik.
 *
 * A lejáratot HELYBEN nézzük: ha az appot bezárták, a menet a saját idejéig
 * tart — de egy perccel sem tovább.
 */
export function effectiveFocus(link, now = Date.now()) {
  const f = link?.focus;
  const live = f && f.running === true && f.endsAt > now
    ? { name: f.name, endsAt: f.endsAt, allowSites: f.allowSites ?? [], window: f.window === true }
    : null;
  if (appFresh(link, now)) return live;
  const ws = (f?.windows ?? []).filter((o) => o.startsAt <= now && now < o.endsAt);
  // A futó menet alapja a SAJÁT listája: a tárolt `allowSites` a lehúzáskor
  // tartó ablakok metszete — egy azóta véget ért ablak szűkítése nem ragadhat
  // rá. Régi app nem küldi: akkor a tárolt lista (szigorúbb, nem lazább).
  const base = live
    ? { ...live, allowSites: f.packAllowSites ?? live.allowSites }
    : ws.length > 0 ? { name: ws[0].name, endsAt: ws[0].endsAt, allowSites: ws[0].allowSites, window: true } : null;
  if (!base) return null;
  let sites = base.allowSites;
  for (const w of ws) sites = intersectSites(sites, w.allowSites);
  return { ...base, allowSites: sites };
}

/**
 * Két engedett-lista metszete az aldomain-szabállyal: ami MINDKETTŐN átmegy.
 * A `google.com` és a `translate.google.com` metszete a `translate.google.com`
 * — a mag `intersectPacks`-ének oldal-fele.
 */
export function intersectSites(a, b) {
  const covers = (list, h) => list.some((x) => h === x || h.endsWith(`.${x}`));
  const out = [...a.filter((h) => covers(b, h)), ...b.filter((h) => covers(a, h))];
  return out.filter((h, i) => out.indexOf(h) === i);
}

/**
 * Indul-e HAMAROSAN heti ablakos munkamenet, ami ezt a lapot zárja: `{ kind:
 * 'focus', leftMs, name, id }`, vagy null — a zárás előtti sáv másik fele.
 *
 * A tárolt ablakokból számol, ugyanúgy, ahogy a menetet a bővítmény az app
 * nélkül is érvényesíti (`effectiveFocus`): ha az ablak a listán van, a menet
 * el is indul. Csak az utolsó `SOON_BANNER_MS`-ben, és csak ha ez az oldal
 * NINCS a csomagban (egyezés vagy aldomain, mint a `focusAllows`-nál).
 *
 * Futó menet mellett is szól, ha a lapot az most engedi: az ablak egy MÁSIK
 * csomag menetére rárétegződik (a mag `windowRunStartingSoon`-jának és
 * `effectivePack`-jének szabálya), és ami eddig ment, de az ablak nem engedi,
 * figyelmeztetés nélkül zárulna. Ha a futó menet nem engedi, a lap már zárva
 * — nincs mit előre mondani. A csomag SAJÁT menete mellett az ablak nem
 * indít újat, de akkor a két lista ugyanaz, tehát az engedett lap az
 * ablakban is engedett: a szűrő ezt magától kiveszi.
 */
export function focusStartingSoonFor(link, host, now = Date.now()) {
  const h = String(host ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return null;
  const allows = (list) => (list ?? []).some((a) => h === a || h.endsWith(`.${a}`));
  const cur = effectiveFocus(link, now);
  if (cur && !allows(cur.allowSites)) return null;
  let best = null;
  for (const w of link?.focus?.windows ?? []) {
    const leftMs = w.startsAt - now;
    if (!(leftMs > 0) || leftMs > SOON_BANNER_MS) continue;
    if (allows(w.allowSites)) continue;
    if (best === null || leftMs < best.leftMs) {
      best = { kind: 'focus', leftMs, name: w.name ?? '', id: `focus@${w.packId}@${w.startsAt}` };
    }
  }
  return best;
}

/** Fut-e MOST munkamenet (a hatásos, lásd `effectiveFocus`). */
export function focusActive(link, now = Date.now()) {
  return effectiveFocus(link, now) !== null;
}

/**
 * Átmehet-e ez a cím a munkamenet alatt.
 *
 * Egyezés vagy ALDOMAIN: a `google.com` engedése a `translate.google.com`-ot is
 * engedi. A `notgoogle.com` viszont NEM — a végén hasonlító tartománynév a
 * leggyakoribb megkerülés.
 */
export function focusAllows(link, host, now = Date.now()) {
  const h = String(host ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return false;
  return (effectiveFocus(link, now)?.allowSites ?? []).some((a) => h === a || h.endsWith(`.${a}`));
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
 * Zárva tartja-e MOST a mérés-őr ezt a hosztot: be van kapcsolva, a hoszt a
 * keretes oldalaké, és az app régebben szólt, mint a türelmi idő — vagyis a
 * segéd is zárja. Ilyenkor a lap megmondja, miért (és hogy mi nyitja: az app
 * elindítása), a DNS csupasz hibaoldala helyett. Amíg az app friss, nincs mit
 * mondani: a mérés fut.
 */
export function measureGuardFor(link, host, now = Date.now()) {
  const h = String(host ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (!h || !link?.measureGuard) return false;
  const last = Number.isFinite(link.fetchedAt) ? link.fetchedAt : 0;
  if (now - last <= MEASURE_GUARD_SILENT_MS) return false;
  return link.measureGuard.hosts.includes(h);
}

/**
 * A MOST hatásos zárlat: { until, byWindow } — vagy null.
 *
 * A tárolt vég frissesség nélkül számít, szándékosan — lásd `cleanLockdown`:
 * a zárlat csak hosszabbodhat, egy régebbi vég is igaz alsó becslés. Ha az
 * app régebben szólt (bezárták, nem válaszol), a tárolt heti zárlat-ablakok
 * közül a most tartó is számít: a segéd az ablak zárlatát az app nélkül is
 * elindítja, és a lap különben olyan feloldást ígérne, ami nincs. Amíg az
 * app friss, az ő szava dönt (ő tudja, ha egy ablakot azóta levettek).
 */
export function effectiveLockdown(link, now = Date.now()) {
  const l = link?.lockdown;
  const until = Number(l?.until);
  let best = Number.isFinite(until) && until > now ? { until, byWindow: l.byWindow === true } : null;
  if (appFresh(link, now)) return best;
  for (const w of l?.windows ?? []) {
    if (w.startsAt <= now && now < w.endsAt && (!best || w.endsAt > best.until)) {
      best = { until: w.endsAt, byWindow: true };
    }
  }
  return best;
}

/** Meddig tart a zárlat (epoch ms), vagy 0 — a hatásos, lásd `effectiveLockdown`. */
export function lockdownUntil(link, now = Date.now()) {
  return effectiveLockdown(link, now)?.until ?? 0;
}

export function withAppRules(localActive, appRules) {
  const out = [...localActive];
  for (const r of appRules) {
    if (out.some((x) => x.host === r.host && x.path === r.path)) continue;
    out.push({ ...r, fromApp: true });
  }
  return out;
}
