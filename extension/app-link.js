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
    },
    // A MOST zárva lévő hosztnevek, okkal — a tiltó lap ebből magyaráz. A
    // frissessége számít, ezért a döntés nem innen, hanem a `closedFor`-ból jön.
    closed: cleanClosed(raw.closed),
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
    // Az ÜRES lista is válasz: azt jelenti, hogy az appban levették az összeset.
    // Csak akkor fogadjuk el, ha a kérés tényleg sikerült — ha nem érjük el az
    // appot, a régi lista marad érvényben.
    await saveLink({ ...link, port, rules, focus, channels, closed, fetchedAt: now, error: null });
    return { ok: true, rules, focus, channels, closed };
  }

  // A PRÓBA idejét megjegyezzük, a szabálylistát viszont nem bántjuk: az app
  // elérhetetlensége nem jelenti azt, hogy nincsenek szabályok.
  await saveLink({ ...link, error: lastError, attemptedAt: now });
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

export function withAppRules(localActive, appRules) {
  const out = [...localActive];
  for (const r of appRules) {
    if (out.some((x) => x.host === r.host && x.path === r.path)) continue;
    out.push({ ...r, fromApp: true });
  }
  return out;
}
