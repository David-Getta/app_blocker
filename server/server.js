'use strict';
// Breaker szinkron-kiszolgáló.
//
// Egy dolgot csinál: verziózott, TITKOSÍTOTT blobokat tárol fiókonként. Nem
// tudja, mi van bennük, és nem is kell tudnia — a blokklista és a mért idők a
// kliensen titkosítódnak (lásd desktop/src/shared/sync/crypto.ts).
//
// Ezért nem is kell megbízni benne: aki futtatja — akár egy idegen —, csak
// átlátszatlan bájtokat lát, és ha hozzányúlna, a GCM-címke miatt a
// visszafejtés elhasalna.
//
// Nincs függősége. `node server.js` és megy; a tár egy könyvtár.
//
//   BREAKER_SYNC_DIR   hova kerüljön az adat (alap: ./data)
//   PORT               melyik porton hallgasson (alap: 8787)
//   BREAKER_OPEN_SIGNUP  "0" esetén nem lehet új fiókot regisztrálni
//
// A protokoll: docs/feature-accounts-sync.md

const http = require('http');
const crypto = require('crypto');
const { Store } = require('./store');

const MAX_BODY = 2_000_000;
const MAX_PAYLOAD = 1_000_000;
const PROTOCOL = 1;

/**
 * A belépőkulcs hashelése.
 *
 * SHA-256 elég, és ez nem hanyagság: a kliens NEM a jelszót küldi, hanem egy
 * 64 MB-os scrypt kimenetéből származó alkulcsot. Az már kitalálhatatlan, tehát
 * a kiszolgálón egy második, drága KDF csak arra lenne jó, hogy minden kérés
 * fél másodpercig süsse a processzort — az pedig ingyen szolgáltatás-megtagadás
 * bárkinek, aki ismeri a címet.
 */
function hashAuth(authKey, salt) {
  return crypto.createHash('sha256').update(`${salt}:${authKey}`).digest('hex');
}

function timingEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function isId(s) {
  return typeof s === 'string' && s.length >= 3 && s.length <= 128 && /^[\w.@:-]+$/.test(s);
}

function isBlob(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= MAX_PAYLOAD;
}

function createApp(store, opts = {}) {
  const openSignup = opts.openSignup !== false;

  /** Fiók + jogosultság egy lépésben. Minden végpont ezen megy át. */
  function authed(body) {
    if (!isId(body.accountId) || typeof body.authKey !== 'string') {
      return { error: 'Hiányzó azonosító.', code: 'BAD_REQUEST', status: 400 };
    }
    const acc = store.readAccount(body.accountId);
    // Ugyanaz a válasz nem létező fiókra és rossz kulcsra: különben a
    // hibaüzenetből ki lehetne deríteni, kinek van itt fiókja.
    if (!acc) return { error: 'Hibás fiók vagy jelszó.', code: 'BAD_AUTH', status: 401 };
    const byPassword = timingEqual(acc.authHash, hashAuth(body.authKey, acc.salt));
    // A helyreállító kódnak saját belépőkulcsa van: elfelejtett jelszóval is be
    // kell tudni jutni, különben a kód semmit nem ér.
    const byRecovery = !!acc.recoveryAuthHash
      && timingEqual(acc.recoveryAuthHash, hashAuth(body.authKey, acc.recoverySalt));
    if (!byPassword && !byRecovery) {
      return { error: 'Hibás fiók vagy jelszó.', code: 'BAD_AUTH', status: 401 };
    }
    return { acc, viaRecovery: byRecovery && !byPassword };
  }

  /**
   * Hány eszköz tartozhat egy fiókhoz.
   *
   * Nem kényelmi korlát: eszközönként egy külön mérés-blob tárolódik, tehát
   * eszközazonosítókat gyártva egy fiók korlátlanul tudná enni a lemezt. Húsz
   * eszköz jóval több, mint amennyit bárki valóban használ.
   */
  const MAX_DEVICES = 20;

  function touchDevice(acc, deviceId, nameBlob) {
    if (!isId(deviceId)) return;
    const d = acc.devices.find((x) => x.deviceId === deviceId);
    if (d) {
      d.lastSeen = Date.now();
      if (isBlob(nameBlob)) d.nameBlob = nameBlob;
      return;
    }
    if (acc.devices.length >= MAX_DEVICES) {
      // A LEGRÉGEBBEN látott eszköz esik ki, nem az új: aki most jelentkezik,
      // az épp használja. A kiesés csak a listázást érinti — a helyi blokkokhoz
      // a kiszolgáló amúgy sem fér hozzá.
      acc.devices.sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
      acc.devices.shift();
    }
    acc.devices.push({ deviceId, nameBlob: isBlob(nameBlob) ? nameBlob : '', lastSeen: Date.now() });
  }

  const routes = {
    '/v1/signup'(body) {
      if (!openSignup) return { status: 403, json: { error: 'A regisztráció ki van kapcsolva.', code: 'CLOSED' } };
      if (!isId(body.accountId)) return { status: 400, json: { error: 'Érvénytelen fiókazonosító.', code: 'BAD_REQUEST' } };
      if (!isBlob(body.wrappedByPassword) || !isBlob(body.wrappedByRecovery)) {
        return { status: 400, json: { error: 'Hiányzó kulcsok.', code: 'BAD_REQUEST' } };
      }
      if (store.readAccount(body.accountId)) {
        return { status: 409, json: { error: 'Ez a fiókazonosító foglalt.', code: 'TAKEN' } };
      }
      const salt = crypto.randomBytes(16).toString('hex');
      // KÜLÖN só a helyreállító ágnak. A jelszócsere ugyanis sót cserél, és ha
      // közös lenne, a csere csendben tönkretenné a helyreállító kódot — pont
      // azt, ami az utolsó mentőöv.
      const recoverySalt = crypto.randomBytes(16).toString('hex');
      store.writeAccount(body.accountId, {
        accountId: body.accountId,
        salt,
        recoverySalt,
        authHash: hashAuth(body.authKey, salt),
        recoveryAuthHash: typeof body.recoveryAuthKey === 'string'
          ? hashAuth(body.recoveryAuthKey, recoverySalt) : undefined,
        wrappedByPassword: body.wrappedByPassword,
        wrappedByRecovery: body.wrappedByRecovery,
        devices: [],
        createdAt: Date.now(),
      });
      return { status: 200, json: { ok: true } };
    },

    '/v1/signin'(body) {
      const a = authed(body);
      if (a.error) return { status: a.status, json: { error: a.error, code: a.code } };
      touchDevice(a.acc, body.deviceId, body.nameBlob);
      store.writeAccount(body.accountId, a.acc);
      return {
        status: 200,
        json: {
          wrappedByPassword: a.acc.wrappedByPassword,
          wrappedByRecovery: a.acc.wrappedByRecovery,
          devices: a.acc.devices,
        },
      };
    },

    /**
     * Jelszócsere: csak a CSOMAGOLÁS változik.
     *
     * Az adatkulcs marad, tehát a tárolt blobokhoz nem nyúlunk — a kiszolgáló
     * amúgy sem tudna hozzájuk nyúlni. A régi belépőkulccsal kell hitelesíteni,
     * hogy egy ellopott munkamenet ne tudja átvenni a fiókot.
     */
    '/v1/rekey'(body) {
      const a = authed(body);
      if (a.error) return { status: a.status, json: { error: a.error, code: a.code } };
      if (typeof body.newAuthKey !== 'string' || !isBlob(body.newWrappedByPassword)) {
        return { status: 400, json: { error: 'Hiányzó új kulcsok.', code: 'BAD_REQUEST' } };
      }
      const salt = crypto.randomBytes(16).toString('hex');
      // Csak a JELSZÓ ága forog. A helyreállító ág saját sóval megy, tehát a
      // jelszócsere nem teszi tönkre a kódot — ha viszont a kliens új kódot is
      // ad, azt átvesszük, saját friss sóval.
      a.acc.salt = salt;
      a.acc.authHash = hashAuth(body.newAuthKey, salt);
      if (typeof body.recoveryAuthKey === 'string') {
        a.acc.recoverySalt = crypto.randomBytes(16).toString('hex');
        a.acc.recoveryAuthHash = hashAuth(body.recoveryAuthKey, a.acc.recoverySalt);
      }
      a.acc.wrappedByPassword = body.newWrappedByPassword;
      if (isBlob(body.newWrappedByRecovery)) a.acc.wrappedByRecovery = body.newWrappedByRecovery;
      store.writeAccount(body.accountId, a.acc);
      return { status: 200, json: { ok: true } };
    },

    '/v1/pull'(body) {
      const a = authed(body);
      if (a.error) return { status: a.status, json: { error: a.error, code: a.code } };
      if (body.collection !== 'sites' && body.collection !== 'usage') {
        return { status: 400, json: { error: 'Ismeretlen gyűjtemény.', code: 'BAD_REQUEST' } };
      }
      const b = store.readBlob(body.accountId, body.collection,
        body.collection === 'usage' ? body.deviceId : undefined);
      return { status: 200, json: b };
    },

    '/v1/push'(body) {
      const a = authed(body);
      if (a.error) return { status: a.status, json: { error: a.error, code: a.code } };
      if (body.collection !== 'sites' && body.collection !== 'usage') {
        return { status: 400, json: { error: 'Ismeretlen gyűjtemény.', code: 'BAD_REQUEST' } };
      }
      if (!isBlob(body.payload)) {
        return { status: 413, json: { error: 'A tartalom túl nagy vagy üres.', code: 'TOO_BIG' } };
      }
      if (!Number.isInteger(body.baseVersion) || body.baseVersion < 0) {
        return { status: 400, json: { error: 'Hiányzó alapverzió.', code: 'BAD_REQUEST' } };
      }
      touchDevice(a.acc, body.deviceId, body.nameBlob);
      store.writeAccount(body.accountId, a.acc);
      const r = store.writeBlob(
        body.accountId, body.collection,
        body.collection === 'usage' ? body.deviceId : undefined,
        body.baseVersion, body.payload,
      );
      return { status: r.ok ? 200 : 409, json: r };
    },

    '/v1/usage-all'(body) {
      const a = authed(body);
      if (a.error) return { status: a.status, json: { error: a.error, code: a.code } };
      return { status: 200, json: { devices: store.listUsage(body.accountId, a.acc.devices) } };
    },

    /**
     * Eszköz eltávolítása a fiókból.
     *
     * FONTOS: ez CSAK a szinkronból veszi ki. Az adott eszközön a blokkok
     * érintetlenül maradnak — különben az „eszköz eltávolítása” lenne a világ
     * legegyszerűbb feloldása, és pont az ellen szól az egész app.
     */
    '/v1/forget-device'(body) {
      const a = authed(body);
      if (a.error) return { status: a.status, json: { error: a.error, code: a.code } };
      a.acc.devices = a.acc.devices.filter((d) => d.deviceId !== body.deviceId);
      store.writeAccount(body.accountId, a.acc);
      return { status: 200, json: { ok: true, devices: a.acc.devices } };
    },
  };

  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, protocol: PROTOCOL });
    }
    const route = routes[req.url];
    if (req.method !== 'POST' || !route) return send(res, 404, { error: 'Nincs ilyen végpont.', code: 'NO_ROUTE' });

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // A törzs korlátja a kapcsolaton van, nem a JSON-on: enélkül egy végtelen
      // kérés a memóriát enné, még mielőtt bármit értelmeznénk belőle.
      if (size > MAX_BODY) { send(res, 413, { error: 'Túl nagy kérés.', code: 'TOO_BIG' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, { error: 'Hibás JSON.', code: 'BAD_JSON' });
      }
      if (!body || typeof body !== 'object') return send(res, 400, { error: 'Hibás kérés.', code: 'BAD_JSON' });
      if (body.protocol !== undefined && body.protocol !== PROTOCOL) {
        return send(res, 426, { error: 'Frissítsd az appot: más protokollverzió.', code: 'BAD_PROTOCOL' });
      }
      let out;
      try {
        out = route(body);
      } catch (e) {
        return send(res, 500, { error: 'Kiszolgálóhiba.', code: 'SERVER' });
      }
      send(res, out.status, out.json);
    });
  });
}

function send(res, status, json) {
  const text = JSON.stringify(json);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // A kiszolgáló nem szolgál ki böngészőt, és nem is akar: semmi ne
    // ágyazhassa be, és semmi ne találgassa a tartalomtípust.
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(text);
}

module.exports = { createApp, hashAuth, Store };

if (require.main === module) {
  const dir = process.env.BREAKER_SYNC_DIR || './data';
  const port = Number(process.env.PORT || 8787);
  const app = createApp(new Store(dir), { openSignup: process.env.BREAKER_OPEN_SIGNUP !== '0' });
  app.listen(port, () => {
    // A TÉNYLEGES portot írjuk ki, nem a kértet: PORT=0 esetén a rendszer oszt
    // ki egyet, és a kiírt cím különben használhatatlan lenne.
    const actual = app.address().port;
    console.log(`Breaker szinkron-kiszolgáló: http://0.0.0.0:${actual} (tár: ${dir})`);
  });
}
