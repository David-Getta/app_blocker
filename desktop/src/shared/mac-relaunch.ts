// A macOS önfrissítés utolsó lépése: az ÚJ példány elindítása a régi helyett.
//
// Ez pontosan azért van külön, tesztelhető modulban, mert a sorrend nem
// mindegy, és rossz sorrendben a hiba néma: az app egyszerűen eltűnik.
//
// A Breaker egypéldányos (requestSingleInstanceLock). Ha még futunk, amikor az
// újat elindítjuk, az új példány NEM kapja meg a zárat, és azonnal kilép —
// utána a régi is kilép, és a felhasználónak nem marad futó appja. Frissített
// app a lemezen, üres képernyő: pont az a kézi munka, ami elől a funkció
// menekülni akart.
//
// Ezért nem mi indítjuk el az újat, hanem egy leválasztott kis héjprogram:
// megvárja, amíg a mi folyamatunk tényleg kilép (tehát a zár felszabadul),
// akkor takarít, és csak azután indít. A várakozás korlátos, hogy egy
// beragadt kilépés se hagyja indítás nélkül a felhasználót.

/** Legfeljebb ennyit vár a régi példány kilépésére, mielőtt mindenképp indít. */
export const RELAUNCH_WAIT_STEPS = 150; // 150 × 0,2 mp = 30 mp

/** POSIX-héj idézőjelezés: a saját idézőjelet is elbírja. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A leválasztott héjprogram, ami a régi példány kilépése UTÁN takarít és indít.
 *
 * @param pid     a most futó (régi) példány folyamatazonosítója
 * @param bundle  a frissített app útvonala, amit el kell indítani
 * @param cleanup törlendő útvonalak: a félretett régi bundle (abból fut a kód,
 *                amíg élünk, ezért nem lehet előbb) és a letöltés munkamappája
 *                (a zip + a kicsomagolt másolat, együtt pár száz megabájt)
 */
export function relaunchScript(pid: number, bundle: string, cleanup: string[] = []): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`érvénytelen pid: ${pid}`);
  return [
    'i=0',
    `while kill -0 ${pid} 2>/dev/null && [ "$i" -lt ${RELAUNCH_WAIT_STEPS} ]; do`,
    '  sleep 0.2',
    '  i=$((i+1))',
    'done',
    ...cleanup.map((p) => `rm -rf ${shQuote(p)}`),
    `open -n ${shQuote(bundle)}`,
  ].join('\n');
}
