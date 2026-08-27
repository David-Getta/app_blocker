// Határidő egy ígéretre, ami esetleg SOSEM teljesül.
//
// Külön modul és külön tesztek, mert a hívói (a mérés szondája) az electronra
// hivatkoznak, tehát `node:test` alól nem tölthetők be — ez a rész viszont
// tiszta logika.
//
// MIÉRT LÉTEZIK. Egy „fut még?” jelző, amit csak a befejezés töröl, halálos
// kombináció egy soha be nem fejeződő művelettel: onnantól minden későbbi kör
// azonnal visszafordul, és a dolog CSENDBEN áll le. A mérés előtér-szondája
// pont ilyen: macOS-en az `osascript` megállhat az engedélykérő ablakon, és ha
// a rendszer a kilövését sem hajtja végre, a visszahívás sosem fut le. A
// szonda „egészség” számlálója ilyenkor MEG SEM SZÓLAL — nem hibát lát, hanem
// semmit —, tehát a felhasználó figyelmeztetést sem kap. Csak a nullát látja.

/**
 * `promise` eredménye, vagy `fallback`, ha `ms` alatt nem teljesül.
 *
 * Az elhagyott ígéret később nyugodtan teljesülhet: az eredményét eldobjuk. Ez
 * szándékos — egy elmaradt minta ára eltörpül amellett, hogy a mérés a
 * folyamat hátralévő életére leáll.
 */
export function withDeadline<T>(
  promise: Promise<T>, ms: number, fallback: T,
  setTimer: (fn: () => void, delay: number) => unknown = setTimeout,
  clearTimer: (h: unknown) => void = (h) => clearTimeout(h as NodeJS.Timeout),
): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const timer = setTimer(() => {
      if (done) return;
      done = true;
      resolve(fallback);
    }, ms);
    promise.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimer(timer);
        resolve(v);
      },
      () => {
        // A hiba is EREDMÉNY: a hívó a tartalék értéket kapja, és attól még
        // lefut az „ez a kör nem látott semmit” könyvelés. Ha itt dobnánk, a
        // hívó `catch` ága is jó lenne — de akkor két helyen kellene ugyanazt
        // kezelni, és az egyik előbb-utóbb kimaradna.
        if (done) return;
        done = true;
        clearTimer(timer);
        resolve(fallback);
      },
    );
  });
}
