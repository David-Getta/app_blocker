import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { postJson, readJson, SyncError } from '../src/helper/sync-client';

/**
 * A válasz-feldolgozás hibaágai.
 *
 * A fontos rész nem a szöveg, hanem az IDŐKORLÁT HATÓKÖRE. A megszakítás
 * korábban csak a fejlécig ért: egy kiszolgáló, ami válaszolni kezd, majd a
 * törzset nem fejezi be, örökre megállította volna a kört. És nem csak azt az
 * egyet — az ütemező `running` jelzője csak a kör BEFEJEZÉSEKOR törlődik,
 * tehát onnantól minden későbbi kör azonnal visszafordult volna. A szinkron a
 * folyamat hátralévő életére halott, hibaüzenet nélkül.
 *
 * Amit ez a fájl fed: hogy a megszakítás a törzs olvasásakor MÁS üzenetet ad,
 * mint a hibás cím — a kettő ugyanis két külön teendő a felhasználónak.
 * Amit NEM fed: hogy az időzítő tényleg a törzs beolvasása UTÁN törlődik. Az a
 * `call` szerkezetén múlik, és egy valódi, tizenöt másodpercig hallgató
 * kiszolgáló kellene hozzá.
 */

/** Olyan válasz, aminek a törzse nem olvasható be. */
function brokenBody(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new Error('terminated')),
  } as unknown as Response;
}

function jsonBody(status: number, value: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(value),
  } as unknown as Response;
}

test('a megszakadt TÖRZS nem hibás címnek látszik', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    () => readJson(brokenBody(), ctrl),
    (e: SyncError) => {
      // A cím jó volt, a kiszolgáló válaszolt is — ezt a mondatnak tükröznie
      // kell, különben a felhasználó a beállításait kezdi bütykölni.
      assert.match(e.message, /elkezdett válaszolni/);
      // A SZÁM is a törzs keretéből jöjjön, ne a fejlécéből: aki hatvan
      // másodpercet vár, ne tizenötöt olvasson.
      assert.match(e.message, /60 másodperc/);
      assert.equal(e.code, 'OFFLINE');
      return true;
    },
  );
});

test('megszakítás NÉLKÜL az olvashatatlan törzs a címre gyanakszik', async () => {
  await assert.rejects(
    () => readJson(brokenBody(), new AbortController()),
    (e: SyncError) => {
      assert.match(e.message, /nem JSON/);
      assert.equal(e.code, 'BAD_SERVER');
      return true;
    },
  );
});

test('a kiszolgáló saját hibája megy tovább, a kódjával együtt', async () => {
  await assert.rejects(
    () => readJson(jsonBody(400, { error: 'Ismeretlen gyűjtemény.', code: 'BAD_REQUEST' }),
      new AbortController()),
    (e: SyncError) => {
      assert.equal(e.message, 'Ismeretlen gyűjtemény.');
      assert.equal(e.code, 'BAD_REQUEST');
      return true;
    },
  );
});

test('a 409 nem hiba, hanem a protokoll része', async () => {
  // „Közben más eszköz írt.” Ha ezt hibaként dobnánk, az ütközés-feloldás
  // sosem futna le, és két eszköz szerkesztése közül az egyik mindig elveszne.
  const r = await readJson(jsonBody(409, { version: 7 }), new AbortController());
  assert.equal(r.version, 7);
});

// ------------------------------------------------- a törzs SAJÁT ideje

/** Kiszolgáló, ami azonnal fejlécet küld, a törzset viszont késve fejezi be. */
function slowBodyServer(delayMs: number, finish = true): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"ok":');
      if (finish) setTimeout(() => res.end('true}'), delayMs);
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => srv.close() });
    });
  });
}

test('a TÖRZS saját keretet kap, nem a fejlécén osztozik', async () => {
  // EZ A LÉNYEG, és egy saját regresszióból jött. Amikor az időkorlátot
  // kiterjesztettem a törzsre, először KÖZÖS keretet adtam a kettőnek — egy
  // egymegabájtos blob viszont egy rossz mobilneten simán több, mint a
  // fejlécre szabott idő. A javítás így minden lassú kapcsolaton elrontotta
  // volna a szinkront: az egyik hiba helyett a másikba estem volna.
  const srv = await slowBodyServer(800);
  try {
    // A fejléc kerete SZÁNDÉKOSAN rövidebb, mint a törzs késése — ha a kettő
    // osztozna, ez itt megszakadna. A számok BŐSÉGESEK: az első változatom
    // hatvan ezredmásodpercet adott a fejlécnek, és terhelt gépen egyszer el
    // is bukott rajta. Egy billegő teszt rosszabb, mint a semmi: legközelebb
    // valódi hibánál is „csak flakes”-nek néznénk.
    const r = await postJson(srv.url, '/akarmi', {}, 300, 5000);
    assert.equal(r.ok, true);
  } finally {
    srv.close();
  }
});

test('a be nem fejezett törzs viszont elhasal, nem vár örökre', async () => {
  const srv = await slowBodyServer(0, false);
  try {
    // VERSENY, nem puszta `rejects`: határidő nélkül a hívás örökre várna, és
    // a futtató csendben kevesebb tesztet jelentene — hiba nélkül. Egy eltűnt
    // teszt rosszabb egy pirosnál, mert a szám ránézésre ugyanolyan zöld.
    const eredmeny = await Promise.race([
      postJson(srv.url, '/akarmi', {}, 1000, 80).then(() => 'ÁTMENT', (e: SyncError) => e),
      new Promise<string>((r) => { setTimeout(() => r('BELÓGOTT'), 800); }),
    ]);
    assert.ok(eredmeny instanceof SyncError, `a hívás nem ért véget: ${String(eredmeny)}`);
    assert.match((eredmeny as SyncError).message, /elkezdett válaszolni/);
    assert.equal((eredmeny as SyncError).code, 'OFFLINE');
  } finally {
    srv.close();
  }
});
