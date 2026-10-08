// Az indítási füstpróba közös darabjai (a próba maga: src/main/smoke.ts).
//
// Külön, tiszta modulban, hogy a felület UGYANABBÓL a függvényből írja ki a
// verzió-sort, amelyiket a próba vár. Ha a kettő két helyen élne, egy
// szövegcsere a felületen piros próbát adna egy hibátlan appra — vagy, ami
// rosszabb, valaki „javításként” a próbát lazítaná.

export const SMOKE_FLAG = '--smoke-test';

export function isSmoke(argv: readonly string[]): boolean {
  return argv.includes(SMOKE_FLAG);
}

/** A fiók-panel verzió-sora. A felület indító kódja írja ki, a próba ezt várja. */
export function versionRowText(version: string): string {
  return `Breaker v${version}`;
}
