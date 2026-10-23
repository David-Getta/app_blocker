// Az app (és a segéd csomagjának) verziója: x.y.z, számként összevetve.
// Függőség nélkül — a felület (böngésző-oldal) is használja.

export const VERSION_RE = /^\d{1,4}\.\d{1,5}\.\d{1,6}$/;

/** a > b, számként, tagonként (az alak a VERSION_RE szerinti; rossz alakra nem újabb). */
export function isNewer(a: string, b: string): boolean {
  if (!VERSION_RE.test(a) || !VERSION_RE.test(b)) return false;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}
