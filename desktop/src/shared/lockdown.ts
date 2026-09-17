// Zárlat: az az időszak, amikor a lazítás nem drága, hanem NEM LÉTEZIK.
//
// MIÉRT KELL. Eddig minden lazításnak volt ára — próbatétel —, de ára volt,
// tehát útja is. Aki hajnali kettőkor elhatározza, hogy átrágja magát rajta,
// az átrágja magát rajta; a nehezebb feladat csak drágítja az utat, nem zárja
// le. A zárlat az a válasz, ami tényleg lezárja: amíg tart, a segéd EL SEM
// INDÍT próbatételt lazításra. Nincs mit teljesíteni, nincs mit megpróbálni.
//
// MIT NEM CSINÁL. Nem lakatolja le a gépet, és nem is állítjuk, hogy
// megtenné: rendszergazdaként a segéd leállítható, az app letörölhető. A
// zárlat az APPON BELÜL zár le mindent — az impulzus ellen véd, nem a
// megfontolt, tíz perces kerülőút ellen. Ezt a felület is kimondja.
//
// AZ IRÁNY. Zárlatot indítani ingyen van, HOSSZABBÍTANI is ingyen van.
// Rövidíteni, visszavonni, kivételt tenni sehogy sem lehet — se gombbal, se
// próbatétellel. Ez az egyetlen művelet az egész appban, aminek nincs
// visszaútja, és pont ettől ér valamit.
//
// Tiszta és függőség nélküli, mint a megosztott mag többi része; a Kotlin és a
// Swift tükrözi. Lásd docs/feature-lockdown.md.

/** Egy zárlat legfeljebb ennyi lehet. Ami ennél hosszabb, az már nem döntés. */
export const MAX_LOCKDOWN_DAYS = 30;
export const MAX_LOCKDOWN_MS = MAX_LOCKDOWN_DAYS * 24 * 3600_000;

/** A felület gyorsgombjai, percben. A leghosszabb szándékosan egy hét. */
export const LOCKDOWN_CHOICES_MIN = [60, 180, 8 * 60, 24 * 60, 3 * 24 * 60, 7 * 24 * 60];

/**
 * A futó zárlat.
 *
 * A `startedAt` nem dísz: ebből látszik a felületen, hogy mennyi telt el és
 * mennyi van hátra — egy puszta határidő mellett a hosszú zárlat első napja
 * ugyanúgy néz ki, mint az utolsó.
 */
export interface Lockdown {
  /** mikortól tart (epoch ms) */
  startedAt: number;
  /** meddig tart (epoch ms) */
  until: number;
}

/** Tart-e most zárlat. */
export function isLocked(l: Lockdown | null | undefined, now: number): boolean {
  return !!l && Number.isFinite(l.until) && l.until > now;
}

/**
 * Csak az ÉLŐ zárlat — a lejárt nincs.
 *
 * A szinkron határán kell: a lejárt zárlatot a helyi oldal nem viszi fel, a
 * kiszolgálóról jövőt viszont a fésülés hűen átvenné, és a kettő minden
 * körben különbözne — a segéd minden tíz percben „változást” látna, mentene
 * és újraírná a hosts fájlt, örökké. Ha mindkét oldalon csak az élő számít,
 * a kettő ugyanazt látja, és a kör megnyugszik.
 */
export function liveLockdown(l: Lockdown | null | undefined, now: number): Lockdown | undefined {
  return isLocked(l, now) ? l! : undefined;
}

/** Mennyi van még hátra, ms-ben. Nulla, ha nincs zárlat. */
export function lockdownRemainingMs(l: Lockdown | null | undefined, now: number): number {
  return isLocked(l, now) ? l!.until - now : 0;
}

/**
 * Zárlat indítása vagy hosszabbítása `ms` időre MOSTTÓL.
 *
 * Az eredmény SOSEM rövidebb a mostaninál: ez a függvény az egyetlen út a
 * mezőhöz, és így a rövidítés nem elfelejtett ellenőrzés kérdése, hanem
 * megfogalmazhatatlan. Ha a kért idő rövidebb, mint ami már fut, a futó marad
 * — a hívó nem hibázott, csak nem ért el vele semmit.
 *
 * Az értelmetlen hossz (nem szám, nulla, negatív) null-t ad: nem indul zárlat.
 */
export function startLockdown(
  cur: Lockdown | null | undefined, ms: number, now: number,
): Lockdown | null {
  if (!Number.isFinite(ms) || ms <= 0 || !Number.isFinite(now)) return cur ?? null;
  const want = now + Math.min(Math.round(ms), MAX_LOCKDOWN_MS);
  if (isLocked(cur, now)) {
    return want > cur!.until ? { startedAt: cur!.startedAt, until: want } : cur!;
  }
  return { startedAt: now, until: want };
}

/**
 * Két eszköz zárlata EGGYÉ fésülve: a KÉSŐBBI vég nyer.
 *
 * Nem versenyhelyzet-feloldás, hanem maga a szabály: a zárlat szigorítás,
 * tehát a szinkron sosem viheti vissza. Egy hálózat nélküli gép nem tud
 * feloldani semmit azzal, hogy a régi állapotát tolja fel; a másik eszközön
 * indított zárlat pedig percek múlva itt is él.
 */
export function mergeLockdown(
  a: Lockdown | null | undefined, b: Lockdown | null | undefined,
): Lockdown | null {
  if (!a) return b ?? null;
  if (!b) return a;
  if (b.until > a.until) return b;
  if (a.until > b.until) return a;
  // Azonos vég: a korábbi kezdés az igaz — az mutatja a teljes hosszt.
  return a.startedAt <= b.startedAt ? a : b;
}

/**
 * A dróton érkezett zárlat beolvasása. Minden mező gyanús: másik eszköz írta.
 *
 * Ami nem értelmes, az nincs — egy hibás rekord nem indíthat harminc napos
 * zárlatot, és nem is takarhat el egy futót.
 */
export function parseLockdown(raw: unknown): Lockdown | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const until = typeof o.until === 'number' ? o.until : NaN;
  const startedAt = typeof o.startedAt === 'number' ? o.startedAt : NaN;
  if (!Number.isFinite(until) || until <= 0) return null;
  const start = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : until;
  return { startedAt: Math.min(start, until), until };
}

/**
 * Magyar, olvasható hátralévő idő: „6 nap 3 óra”, „2 ó 15 p”, „4 perc”.
 *
 * A zárlat hossza napokban is mérhető, ezért nem a percre pontos alak kell —
 * aki hét napot zárt le, annak a másodpercek csak nézegetnivalót adnának.
 */
export function formatLockdownRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days} nap ${hours} óra` : `${days} nap`;
  if (hours > 0) return mins > 0 ? `${hours} ó ${mins} p` : `${hours} óra`;
  return `${Math.max(1, mins)} perc`;
}
