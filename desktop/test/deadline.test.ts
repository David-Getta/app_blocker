import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { withDeadline } from '../src/shared/deadline';

/**
 * A határidő azért van, mert egy „fut még?” jelző, amit csak a befejezés
 * töröl, halálos kombináció egy soha be nem fejeződő művelettel: onnantól
 * minden későbbi kör azonnal visszafordul, és a dolog CSENDBEN áll le.
 *
 * A mérés előtér-szondája pont ilyen. macOS-en az `osascript` megállhat az
 * engedélykérő ablakon; ha a visszahívása elmarad, a szonda ígérete sosem
 * teljesül. A szonda-egészség ilyenkor meg sem szólal — az HIBÁT számol, nem
 * elmaradást —, tehát a felhasználó figyelmeztetést sem kap. Csak a nullát.
 */

test('a teljesülő ígéret eredménye jön, nem a tartalék', async () => {
  assert.equal(await withDeadline(Promise.resolve('ok'), 50, 'tartalék'), 'ok');
});

// SAJÁT IDŐZÍTŐVEL, nem valós várakozással. Az első változatom egy tényleges,
// soha nem teljesülő ígéretre várt — és a szándékos elrontásra NEM hasalt el,
// hanem BELÓGOTT: a futtató egyszerűen négy teszttel kevesebbet jelentett,
// hiba nélkül. Egy eltűnt teszt rosszabb egy pirosnál, mert a szám ránézésre
// ugyanolyan zöld. Még a `timeout` beállítás sem segített rajta.
//
// Így viszont a törés AZONNAL és HANGOSAN látszik: ha nincs határidő, az
// időzítő el sem indul, és az első állítás elhasal.
test('a SOSEM teljesülő ígéret helyett a tartalék jön', async () => {
  const soha = new Promise<string>(() => { /* szándékosan üres */ });
  let fire: (() => void) | null = null;
  const p = withDeadline(soha, 20, 'tartalék', (fn) => { fire = fn; return 1; }, () => {});
  assert.notEqual(fire, null, 'a határidő időzítője elindult');
  (fire as unknown as () => void)();
  // VERSENY, nem puszta `await`. Ha a határidő nem old fel semmit, a `p`
  // örökre várna, és a futtató egyszerűen kevesebb tesztet jelentene — hiba
  // nélkül. Így viszont a belógás is HANGOS: mérhető válasz lesz belőle.
  const beragadt = new Promise<string>((r) => { setTimeout(() => r('BELÓGOTT'), 200); });
  assert.equal(await Promise.race([p, beragadt]), 'tartalék');
});

test('a hiba is a tartalékot adja, nem dobja tovább', async () => {
  // Ha itt dobnánk, a hívónak külön `catch` ága kellene ugyanarra — és az a
  // két hely előbb-utóbb szétcsúszna. Egy elmaradt szonda mindkét okból
  // ugyanaz: ez a kör nem látott semmit.
  const hiba = Promise.reject(new Error('elszállt'));
  assert.equal(await withDeadline(hiba, 50, null), null);
});

test('a lassú, de MÉGIS teljesülő ígéret nem kap két választ', async () => {
  // A tartalék már kiment; a késve érkező eredményt el kell dobni. Enélkül a
  // `resolve` kétszer futna — ártalmatlan, de a szándék nem lenne kimondva.
  const lassu = new Promise<string>((r) => setTimeout(() => r('késve'), 40));
  assert.equal(await withDeadline(lassu, 10, 'tartalék'), 'tartalék');
  assert.equal(await lassu, 'késve');
});

test('a határidő időzítője a gyors esetben TÖRLŐDIK', () => {
  // Enélkül minden mérési kör hagyna maga után egy függő időzítőt. Öt
  // másodpercenként egyet, egy egész napon át — és a folyamat leállása is
  // késne miattuk.
  let cleared = 0;
  const timers: (() => void)[] = [];
  return withDeadline(
    Promise.resolve(1), 1000, 0,
    (fn) => { timers.push(fn); return timers.length; },
    () => { cleared += 1; },
  ).then((v) => {
    assert.equal(v, 1);
    assert.equal(cleared, 1, 'az időzítő törlődött');
  });
});
