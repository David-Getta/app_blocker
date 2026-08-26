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

export interface BridgeRule {
  host: string;
  path: string;
}

/**
 * A futó munkamenet, ahogy a bővítménynek kell.
 *
 * Ez FEHÉRLISTA: ha fut, minden más tiltva. A böngésző az egyetlen hely, ahol
 * ezt tényleg érvényesíteni lehet — a DNS a hosztnévnél tovább nem lát, és
 * „mindent tilts, kivéve ötöt” egy hosts-fájlban nem leírható.
 */
export interface BridgeFocus {
  running: boolean;
  /** a csomag neve, hogy a tiltó lap megnevezze, MI fut */
  name?: string;
  /** mikor jár le — a tiltó lap ebből mondja meg, mennyi van hátra */
  endsAt?: number;
  allowSites?: string[];
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
  notePull?: () => void;
}

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
  headers: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  if (method !== 'GET') return { status: 405, body: { error: 'Csak GET.' } };
  const path = (url ?? '').split('?')[0];
  if (path !== '/rules') return { status: 404, body: { error: 'Nincs ilyen végpont.' } };
  if (!tokenMatches(deps.token, headers[TOKEN_HEADER])) {
    // Ugyanaz a válasz hiányzó és rossz kódra: a különbség csak abban segítene,
    // aki próbálgat.
    return { status: 401, body: { error: 'Hiányzó vagy rossz kód.' } };
  }
  const rules = await deps.getRules();
  const focus = deps.getFocus ? await deps.getFocus() : { running: false };
  // Feljegyezzük, hogy VOLT lehúzás. Enélkül az app csak azt tudja, hogy a híd
  // FUT — azt nem, hogy beszél-e vele bárki. A kettő között pedig ott a
  // legcsendesebb hiba: a felhasználó elindít egy munkamenetet, a fehérlistát
  // viszont senki nem érvényesíti, és minden nyitva marad.
  deps.notePull?.();
  return { status: 200, body: { protocol: BRIDGE_PROTOCOL, rules, focus } };
}

/** A híd elindítása. A hívó felelőssége, hogy a kódot megmutassa a felületen. */
export function startRulesBridge(deps: BridgeDeps): Promise<BridgeHandle> {
  const server = http.createServer((req, res) => {
    void answer(deps, req.method, req.url, req.headers as Record<string, unknown>)
      .then(({ status, body }) => {
        const text = JSON.stringify(body);
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(text),
          // A tartalom pillanatnyi állapot; egy gyorsítótárazott válasz régi
          // szabályokat tartana életben.
          'cache-control': 'no-store',
        });
        res.end(text);
      })
      .catch(() => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"Belső hiba."}');
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
