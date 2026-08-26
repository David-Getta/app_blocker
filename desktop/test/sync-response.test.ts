import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readJson, SyncError } from '../src/helper/sync-client';

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
