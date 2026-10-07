// A híd a bővítményhez: a részleges szabályok kiadása a saját gépen belül.
//
// MIÉRT KELL. A részleges tiltást (`youtube.com/@valaki`) csak a böngésző tudja
// érvényesíteni, mert egyedül ő látja a teljes címet — a DNS a hosztnévnél
// tovább nem lát. A szabályokat viszont az APPBAN veszi fel az ember, mert ott
// van mögöttük a súrlódás: felvenni egy kattintás, levenni próbatétel. Híd
// nélkül ugyanazt kétszer kellene begépelni, két helyen, két külön listába —
// és ami kétszer van, az előbb-utóbb szétcsúszik.
//
// MIÉRT ÍGY. A bővítmény nem tud unix socketet olvasni (ott ül a segéd), és nem
// tud fájlt sem. Ami marad: egy HTTP-végpont. Ezért:
//
//   - CSAK a 127.0.0.1-re köt. A szinkron-kiszolgálótól ez külön dolog: az a
//     hálózat felé szolgál ki, ez SOHA. A blokklista nem megy ki a Wi-Fire.
//   - Kóddal védett. Enélkül a gépen futó bármelyik program elolvashatná, mi
//     van blokkolva — az pedig magánügy.
//   - Csak OLVAS. Ezen a hídon semmit nem lehet feloldani, se módosítani. Ha
//     lehetne, a bővítmény lenne a legegyszerűbb kiskapu az egész appban.
//
// AMI NEM MEGY: ha az app nincs nyitva, a híd sem él. A bővítmény ilyenkor az
// utoljára letöltött listát használja — vagyis TOVÁBB TILT, nem enged át. Ez a
// helyes irány: a hiba a szigorúbb oldalra dől.

import * as crypto from 'crypto';
import { normalizeDomain } from '../shared/blocklist';
import * as http from 'http';
import type { AddressInfo } from 'net';

/** A híd alapértelmezett portja. A szinkroné 8787; ez nem az. */
export const BRIDGE_PORT = 8788;
/** Ha foglalt, ennyi következőt próbálunk meg. */
export const BRIDGE_PORT_TRIES = 10;
/** A bővítménynek küldött alak verziója. */
export const BRIDGE_PROTOCOL = 1;
/** A kód fejlécének neve. Egyedi fejléc: weboldalról már az előellenőrzés elbukik. */
export const TOKEN_HEADER = 'x-breaker-token';
/** A bővítmény ebben mondja meg, fut-e inkognitóban ('1' / '0'). */
export const INCOGNITO_HEADER = 'x-breaker-incognito';

export interface BridgeRule {
  host: string;
  path: string;
}

/**
 * Egy MOST zárva lévő hosztnév, okkal.
 *
 * A DNS-réteg (hosts-fájl) így is, úgy is tilt — ez a lista csak azért megy le,
 * hogy a bővítmény a nyers hibalap HELYETT meg tudja mondani, MIÉRT nem nyílik
 * az oldal, és mikor nyílik újra. Magyarázat, nem érvényesítés: ha a bővítmény
 * nincs ott, a tiltás attól még tiltás.
 */
export interface BridgeClosed {
  host: string;
  reason: 'always' | 'schedule' | 'cooldown' | 'limit';
  /** meddig (epoch ms) — hűtésnél és kereté; menetrendnél nulla */
  until: number;
}

/**
 * Egy most még NYITOTT hosztnév, ami hamarosan zárul — és miért.
 *
 * A böngészőben telik a legtöbb idő, és ott a zárás a legkeményebb: a nyitott
 * lap a tiltó lapra fut. A tartalom-szkript ebből tesz ki egy sávot az utolsó
 * percekben, hogy a vége ne félbehagyott mondat közepén érjen. Magyarázat,
 * nem érvényesítés, mint a zárva-lista: ha a bővítmény nincs ott, a zárás
 * attól még zárás.
 *
 * - `pause`: a szünet vége (`at`, epoch ms);
 * - `schedule`: a menetrend szerinti zárás (`at`, epoch ms);
 * - `limit`: a mai keretből hátralévő aktív másodpercek (`left`) — idő
 *   helyett, mert a keret csak az oldalon töltött idővel fogy.
 */
export interface BridgeSoon {
  host: string;
  kind: 'pause' | 'schedule' | 'limit' | 'burst';
  at?: number;
  left?: number;
  /** az adag hossza (mp) — a lap küszöbe legfeljebb a fele, hogy egy rövid adag ne az elejétől szóljon */
  of?: number;
  /** a szünet hossza az adag után (mp) — a lap kimondja */
  cool?: number;
}

/** Ennyin belüli zárásról megy le jel: a sáv úgyis csak az utolsó percekben szól. */
export const SOON_HORIZON_MS = 10 * 60_000;

/**
 * A futó ZÁRLAT, ahogy a bővítménynek kell: csak a vége.
 *
 * Magyarázat, nem érvényesítés — mint a zárva-lista. A tiltó lap enélkül azt
 * írná, hogy „az appban feloldható, próbatétellel”, pedig zárlat alatt pont
 * ez az út nincs. A lap ne ígérjen olyat, ami nem létezik.
 */
export interface BridgeLockdown {
  /** a futó zárlat vége — nulla, ha most nem tart (de van heti zárlat-ablak) */
  until: number;
  /** a heti ablak tartja-e — a lap ezt is kimondja: nem kézzel indított döntés, hanem a hétköznap */
  byWindow?: boolean;
  /**
   * A heti zárlat-ablakok következő hete. A segéd az ablak zárlatát az app
   * nélkül is elindítja; a bővítmény ebből tudja akkor is, ha az app (és vele
   * ez a híd) zárva van — különben a tiltó lap feloldást ígérne.
   */
  windows?: { startsAt: number; endsAt: number }[];
}

/**
 * A MÉRÉS-ŐR, ahogy a bővítménynek kell: be van-e kapcsolva, és mely
 * hosztnevekre szól (a napi kerettel vagy adaggal védett oldalakéi). Ha az app
 * elhallgat, a segéd ezeket a hosts-ban zárja — a bővítmény ebből tudja
 * megmondani a tiltó lapon, miért, a DNS csupasz hibaoldala helyett.
 */
export interface BridgeMeasureGuard {
  hosts: string[];
}

/**
 * A futó munkamenet, ahogy a bővítménynek kell.
 *
 * Ez FEHÉRLISTA: ha fut, minden más tiltva. A böngésző az egyetlen hely, ahol
 * ezt tényleg érvényesíteni lehet — a DNS a hosztnévnél tovább nem lát, és
 * „mindent tilts, kivéve ötöt” egy hosts-fájlban nem leírható.
 */
/** Egy hosztnév indoka: amiért a felhasználó maga tiltotta le — a tiltó lapnak. */
export interface BridgeNote {
  host: string;
  text: string;
}

/**
 * A MEGBÍZOTT (párban zárolás), ha van: csak a neve. A tiltó lap ebből mondja
 * ki, hogy a feloldás útja az ő jelmondatával ér véget — a lenyomat nem megy
 * le, a bővítménynek semmi dolga vele.
 */
export interface BridgePartner {
  name: string;
}

export interface BridgeFocus {
  running: boolean;
  /** a csomag neve, hogy a tiltó lap megnevezze, MI fut */
  name?: string;
  /** mikor jár le — a tiltó lap ebből mondja meg, mennyi van hátra */
  endsAt?: number;
  allowSites?: string[];
  /** a heti ablak szerint indult, nem gombnyomásra — a vége az ablak vége */
  window?: boolean;
  /**
   * A heti ablakok következő hete, az elköltöttek nélkül. A bővítmény ebből
   * tartja be az ablakot akkor is, ha az app (és vele ez a híd) zárva van —
   * amíg az app válaszol, a fenti élő állapot dönt.
   */
  windows?: { packId: string; name: string; allowSites: string[]; startsAt: number; endsAt: number }[];
}

/**
 * A JAVASOLT csomag: amit a felugró lap egy kattintással indíthat — a
 * legutóbb használt (napló nélkül az első) a szokásos hosszával, ahogy a
 * segéd választja. Null, ha nincs csomag, vagy menet fut (egyszerre egy).
 */
export interface BridgeSuggest {
  packId: string;
  name: string;
  minutes: number;
  /**
   * A CSÚCS-ÓRA, amire a lap heti ablakot tehet a javasolt csomagra — vagy
   * null: nincs csúcs, a csomagnak már van ablaka (a csere lazíthat, az az
   * appé), vagy egy ablak már fedi a csúcs-órát. Régi app nem küldi.
   */
  peakHour?: number | null;
  /**
   * LE VAN-E FEDVE: a csomag neve, amelynek heti ablaka a csúcs-órát fedi —
   * a felugró lap kimondja, hogy a menet magától indul. Null, ha egyik sem.
   */
  peakPack?: string | null;
  /**
   * A MENET-NAP: ma szoktál-e leülni — a négy hét menet-napja, elég mintából,
   * az app szabálya szerint. A lap a gomb mellett kimondja. Régi app nem küldi.
   */
  focusDay?: boolean;
  /** A MENET-ÓRA: most szoktál-e elkezdeni — a négy hét menet-órája, elég mintából. A lap a gomb mellett kimondja. */
  focusHourNow?: boolean;
  /**
   * A MENET-ÓRA, amire a lap heti ablakot tehet a javasolt csomagra — a
   * csúcs-óra gombjának tükre, ugyanazokkal a kapukkal; null, ha a menet-óra
   * a csúcs-óra (azt a másik gomb kínálja), vagy nem tehető rá ablak. Régi app nem küldi.
   */
  focusHour?: number | null;
  /**
   * LE VAN-E FEDVE a menet-óra: a csomag neve, amelynek heti ablaka fedi — a
   * lap kimondja, hogy a menet-órában magától indul. Null, ha egyik sem, vagy
   * a menet-óra a csúcs-óra (azt a csúcs-óra fedése mondja). Régi app nem küldi.
   */
  focusHourPack?: string | null;
  /**
   * AMIKOR A CSÚCS-ÓRA A MENET-ÓRA: a hét csúcs-órája és a négy hét
   * menet-órája ugyanaz — a felugró lap a csúcs mondata után kimondja. Régi app nem küldi.
   */
  sameHour?: boolean;
  /**
   * A MENET-SOROZAT: hány napja ülsz le minden nap — a lap a menet gombja
   * mellett mondja, kettőtől (egy nap nem sorozat). Régi app nem küldi.
   */
  focusStreak?: number;
  /** A LEGHOSSZABB SOROZAT a naplóban — a lap a mostani sorozat mellett, zárójelben mondja, ha több. Régi app nem küldi. */
  focusLongestStreak?: number;
  /**
   * KÖZELEG A NAPI KERET: kész mondat a legsürgősebb oldalról, ha a mai
   * keretéből kevés van hátra — az app oldja fel a fedőnevet és a rejtést.
   * Üres, ha egyik oldal sincs a küszöbön belül. Régi app nem küldi.
   */
  limitSoon?: string;
}

/**
 * Crockford base32 kód, négyes csoportokban.
 *
 * Ugyanaz az ábécé, mint a párosító kódnál: nincs benne I, L, O és U, mert
 * kézzel másolva összekeverhetők. Ezt a kódot is kézzel viszi át az ember.
 */
export function newBridgeToken(bytes: Buffer = crypto.randomBytes(10)): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(acc >> bits) & 31];
    }
  }
  return out.replace(/(.{4})(?=.)/g, '$1-');
}

/** Összehasonlítás állandó időben, a kötőjeleket és a kisbetűket elnézve. */
export function tokenMatches(want: string, got: unknown): boolean {
  if (typeof got !== 'string') return false;
  const clean = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, '');
  const a = Buffer.from(clean(want));
  const b = Buffer.from(clean(got));
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface BridgeDeps {
  /** a pillanatnyi szabályok; a hívó tudja, honnan (a segéd állapotából) */
  getRules: () => Promise<BridgeRule[]>;
  /** a futó munkamenet, ha van */
  getFocus?: () => Promise<BridgeFocus>;
  /** a BEKAPCSOLT csatorna-szűrők — a kikapcsoltak a böngészőre nem tartoznak */
  getChannels?: () => Promise<{ host: string; allow: string[] }[]>;
  /** a MOST zárva lévő hosztnevek, okkal — a tiltó lap ebből magyaráz */
  getClosed?: () => Promise<BridgeClosed[]>;
  /** a hamarosan záruló, most még nyitott hosztnevek — a lap ebből szól előre */
  getSoon?: () => Promise<BridgeSoon[]>;
  /** a futó zárlat, ha van — a tiltó lap ebből tudja, hogy most nincs feloldás */
  getLockdown?: () => Promise<BridgeLockdown | null>;
  getNotes?: () => Promise<BridgeNote[]>;
  /** a megbízott neve, ha van — a tiltó lap ebből tudja, hogy a feloldás az ő jelmondatával ér véget */
  getPartner?: () => Promise<BridgePartner | null>;
  /** a kulcsszó-szabályok: bármely oldalon, ha a cím tartalmazza — csak a böngésző tudja érvényesíteni */
  getKeywords?: () => Promise<string[]>;
  /**
   * A bővítmény MEGAKADÁS-KÖNYVE visszafelé: hányszor vitt a tiltó lapra, az
   * elmúlt hét nap, forrásonként (böngésző-profilonként). A segéd tartja; a
   * heti mondat és a statisztika sora mondja.
   */
  putHits?: (source: string, days: unknown[]) => Promise<void>;
  /** a javasolt csomag a felugró lapnak — null, ha nincs mit indítani */
  getSuggest?: () => Promise<BridgeSuggest | null>;
  /** a mérés-őr (lásd shared/measure-guard.ts) — null, ha nincs bekapcsolva */
  getMeasureGuard?: () => Promise<BridgeMeasureGuard | null>;
  /**
   * A MÁSODIK befelé menő út: a menet indítása a felugró lapról. Csak
   * SZIGORÍTÁS jöhet be — a bíró dönt, a bővítmény nem vehet le semmit.
   */
  startFocus?: (packId: string, minutes: number) => Promise<void>;
  /**
   * A HARMADIK befelé menő út: heti ablak a csúcs-órára a javasolt csomagon.
   * Csak felvétel — ablak nélküli csomagra —, az szigorítás; a csere az appé.
   */
  addFocusWindow?: (packId: string, hour: number) => Promise<void>;
  token: string;
  /** csak teszthez: melyik portról induljon */
  startPort?: number;
  /**
   * Meghívjuk minden SIKERES lehúzásnál.
   *
   * Ebből tudja meg az app, hogy a bővítmény tényleg ott van — nem csak a
   * kiszolgáló fut. A munkamenet fehérlistáját a gépen KIZÁRÓLAG a bővítmény
   * érvényesíti, tehát ez a különbség nem részletkérdés.
   */
  notePull?: (info: { incognito: boolean | null }) => void;
  /**
   * A NEGYEDIK befelé menő út: a böngésző jele, melyik oldal van elöl (lásd
   * shared/usage.ts `withTabHint`). Csak a mérést segíti ott, ahol a szonda a
   * címet nem látja — az oldalra szabott keret így fogy. Szabályt nem ír.
   */
  noteTab?: (hint: { focused: boolean; host: string | null }) => void;
}

/** A befelé menő törzs plafonja: egy hét megakadás-sora, bőven. */
export const MAX_BODY_BYTES = 64 * 1024;

export interface BridgeHandle {
  port: number;
  close: () => void;
}

/**
 * A kérés eldöntése — a hálózattól függetlenül, hogy tesztelhető legyen.
 *
 * A visszaadott fejlécekben SZÁNDÉKOSAN nincs `Access-Control-Allow-Origin`.
 * A bővítmény a `host_permissions` jogán így is olvashatja; egy weboldal
 * viszont nem — pedig ő is el tudná érni a 127.0.0.1-et.
 */
export async function answer(
  deps: BridgeDeps, method: string | undefined, url: string | undefined,
  headers: Record<string, unknown>, body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const path = (url ?? '').split('?')[0];
  // BEFELÉ négy út van, és mind a lazítás irányában zárt. A megakadás-könyv:
  // csak könyvelés jön rajta, szabály soha. A menet indítása: szigorítás — a
  // bíró dönt róla, ugyanúgy, mint az app gombjánál. A heti ablak a
  // csúcs-órára: csak FELVÉTEL, ablak nélküli csomagra — a csere lazíthat, az
  // az appé. És az elöl lévő oldal jele: a mérés kap rajta szemet ott, ahol a
  // szonda vak — a jel nélkül az idő appként könyvelődne, és az oldal kerete
  // nem fogyna; a szonda saját látványát pedig sosem írja felül. A bővítmény
  // nem vehet le semmit az appban.
  if (method === 'POST' && path === '/tab') {
    if (!tokenMatches(deps.token, headers[TOKEN_HEADER])) {
      return { status: 401, body: { error: 'Hiányzó vagy rossz kód.' } };
    }
    const b = body && typeof body === 'object' ? body as { focused?: unknown; host?: unknown } : {};
    if (typeof b.focused !== 'boolean' || (b.host !== null && typeof b.host !== 'string')) {
      return { status: 400, body: { error: 'Fókusz és hoszt (vagy null) kell.' } };
    }
    // A hoszt a mérés kulcsa lesz: ugyanaz a tisztítás, mint a szonda által
    // olvasott címé. Ami nem tartománynév (localhost, szemét), az nem oldal.
    const host = typeof b.host === 'string' ? normalizeDomain(b.host) : null;
    deps.noteTab?.({ focused: b.focused, host });
    return { status: 200, body: { ok: true } };
  }
  if (method === 'POST' && path === '/focus_start') {
    if (!tokenMatches(deps.token, headers[TOKEN_HEADER])) {
      return { status: 401, body: { error: 'Hiányzó vagy rossz kód.' } };
    }
    const b = body && typeof body === 'object' ? body as { packId?: unknown; minutes?: unknown } : {};
    if (typeof b.packId !== 'string' || !b.packId || !Number.isInteger(b.minutes) || (b.minutes as number) <= 0) {
      return { status: 400, body: { error: 'Csomag és perc kell.' } };
    }
    if (!deps.startFocus) return { status: 404, body: { error: 'Ez az app nem indít menetet a hídról.' } };
    try {
      await deps.startFocus(b.packId, b.minutes as number);
    } catch (e) {
      // A bíró nemje (futó menet, ismeretlen csomag) nem hiba, hanem válasz.
      return { status: 409, body: { error: (e as Error).message || 'Nem indult el.' } };
    }
    return { status: 200, body: { ok: true } };
  }
  if (method === 'POST' && path === '/focus_window') {
    if (!tokenMatches(deps.token, headers[TOKEN_HEADER])) {
      return { status: 401, body: { error: 'Hiányzó vagy rossz kód.' } };
    }
    const b = body && typeof body === 'object' ? body as { packId?: unknown; hour?: unknown } : {};
    if (typeof b.packId !== 'string' || !b.packId || !Number.isInteger(b.hour) || (b.hour as number) < 0 || (b.hour as number) > 23) {
      return { status: 400, body: { error: 'Csomag és óra kell.' } };
    }
    if (!deps.addFocusWindow) return { status: 404, body: { error: 'Ez az app nem tesz ablakot a hídról.' } };
    try {
      await deps.addFocusWindow(b.packId, b.hour as number);
    } catch (e) {
      // A bíró és a híd nemje (ablakos csomag, ismeretlen csomag) válasz, nem hiba.
      return { status: 409, body: { error: (e as Error).message || 'Nem került fel.' } };
    }
    return { status: 200, body: { ok: true } };
  }
  if (method === 'POST' && path === '/hits') {
    if (!tokenMatches(deps.token, headers[TOKEN_HEADER])) {
      return { status: 401, body: { error: 'Hiányzó vagy rossz kód.' } };
    }
    const b = body && typeof body === 'object' ? body as { source?: unknown; days?: unknown } : {};
    if (typeof b.source !== 'string' || !Array.isArray(b.days)) {
      return { status: 400, body: { error: 'Forrás és napok kellenek.' } };
    }
    if (deps.putHits) await deps.putHits(b.source, b.days);
    return { status: 200, body: { ok: true } };
  }
  if (method !== 'GET') return { status: 405, body: { error: 'Csak GET.' } };
  if (path !== '/rules') return { status: 404, body: { error: 'Nincs ilyen végpont.' } };
  if (!tokenMatches(deps.token, headers[TOKEN_HEADER])) {
    // Ugyanaz a válasz hiányzó és rossz kódra: a különbség csak abban segítene,
    // aki próbálgat.
    return { status: 401, body: { error: 'Hiányzó vagy rossz kód.' } };
  }
  // PÁRHUZAMOSAN, nem egymás után. A kettő ugyanabból az egy állapotból jön, és
  // a hívó össze is vonja őket EGY lekérdezéssé — sorosan viszont nem tudná,
  // mert a második csak az első befejezése után indulna. A különbség nem
  // kozmetika: a bővítmény három másodperc után továbblép, a sorosan kétszer
  // lekérdezett állapot pedig ennek a duplájába is telhet, és akkor a
  // szabályok CSENDBEN nem frissülnének.
  const [rules, focus, channels, closed, lockdown, notes, partner, keywords, suggest, measureGuard, soon] = await Promise.all([
    deps.getRules(),
    deps.getFocus ? deps.getFocus() : Promise.resolve({ running: false }),
    deps.getChannels ? deps.getChannels() : Promise.resolve([]),
    deps.getClosed ? deps.getClosed() : Promise.resolve([]),
    deps.getLockdown ? deps.getLockdown() : Promise.resolve(null),
    deps.getNotes ? deps.getNotes() : Promise.resolve([]),
    deps.getPartner ? deps.getPartner() : Promise.resolve(null),
    deps.getKeywords ? deps.getKeywords() : Promise.resolve([]),
    deps.getSuggest ? deps.getSuggest() : Promise.resolve(null),
    deps.getMeasureGuard ? deps.getMeasureGuard() : Promise.resolve(null),
    deps.getSoon ? deps.getSoon() : Promise.resolve([]),
  ]);
  // Feljegyezzük, hogy VOLT lehúzás. Enélkül az app csak azt tudja, hogy a híd
  // FUT — azt nem, hogy beszél-e vele bárki. A kettő között pedig ott a
  // legcsendesebb hiba: a felhasználó elindít egy munkamenetet, a fehérlistát
  // viszont senki nem érvényesíti, és minden nyitva marad.
  // Fut-e a bővítmény inkognitóban — csak a szó szerinti '1' / '0' számít;
  // régi bővítmény nem küldi, az „nem tudni”.
  const ih = headers[INCOGNITO_HEADER];
  deps.notePull?.({ incognito: ih === '1' ? true : ih === '0' ? false : null });
  return {
    status: 200,
    body: {
      protocol: BRIDGE_PROTOCOL, rules, focus, channels, closed, lockdown, notes, partner, keywords, suggest, measureGuard,
      soon,
    },
  };
}

/** A híd elindítása. A hívó felelőssége, hogy a kódot megmutassa a felületen. */
export function startRulesBridge(deps: BridgeDeps): Promise<BridgeHandle> {
  const server = http.createServer((req, res) => {
    const send = ({ status, body }: { status: number; body: unknown }): void => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        // A tartalom pillanatnyi állapot; egy gyorsítótárazott válasz régi
        // szabályokat tartana életben.
        'cache-control': 'no-store',
      });
      res.end(text);
    };
    const finish = (parsed?: unknown): void => {
      void answer(deps, req.method, req.url, req.headers as Record<string, unknown>, parsed)
        .then(send)
        .catch(() => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"error":"Belső hiba."}');
        });
    };
    if (req.method !== 'POST') { finish(); return; }
    // A törzs KORLÁTTAL: a könyv egy hét sora, nem egy fájl. Ami nagyobb,
    // az nem a bővítmény.
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { over = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', () => { /* a megszakított kérésnek nincs válasza */ });
    req.on('end', () => {
      if (over) { send({ status: 413, body: { error: 'Túl nagy.' } }); return; }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        send({ status: 400, body: { error: 'Rossz JSON.' } });
        return;
      }
      finish(parsed);
    });
  });

  return new Promise((resolve, reject) => {
    let port = deps.startPort ?? BRIDGE_PORT;
    let tries = 0;
    const tryListen = (): void => {
      // A 127.0.0.1 KÖTELEZŐ. A 0.0.0.0 azt jelentené, hogy a blokklista a
      // hálózaton is elérhető — pont az ellenkezője annak, amiért ez a híd van.
      server.listen(port, '127.0.0.1');
    };
    server.on('listening', () => {
      const addr = server.address() as AddressInfo;
      resolve({ port: addr.port, close: () => server.close() });
    });
    server.on('error', (e: Error & { code?: string }) => {
      if (e.code === 'EADDRINUSE' && tries < BRIDGE_PORT_TRIES) {
        tries++;
        port++;
        tryListen();
        return;
      }
      reject(e);
    });
    tryListen();
  });
}
