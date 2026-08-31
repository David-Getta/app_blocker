// Adag-szabály oldalanként: ennyi HASZNÁLAT után ennyi SZÜNET.
//
// A napi keret testvére, más alakú lyukra: a keret a napi összesenről szól,
// ez arról, hogy egyszerre mennyi fér. A példa, amiből született:
// két perc Gemini után tíz perc tiltás, aztán az oldal magától feloldódik.
// Nem büntetés, hanem ütem: a rövid odapillantás belefér, a belefeledkezés
// nem.
//
// HOGYAN SZÁMOL. A mérés kötegekben érkező mintáiból oldalanként adag-számláló
// gyűlik. Ha a számláló eléri az adagot, indul a hűtés (DNS-tiltás), és a
// számláló nullázódik. Ha egy hűtésnyi ideig nem használtad az oldalt, a
// számláló magától tiszta lappal indul — e nélkül a hetekkel korábbi fél
// percek is összeadódnának, és a tiltás az égből esne az emberre.
//
// A SZÁMLÁLÓ ESZKÖZ-HELYI. A beállítás (adag + szünet hossza) a blokklista
// rekordján utazik a többi gépre, a számláló és a hűtés vége viszont nem:
// a szinkron tízperces körökben jár, egy kétperces adaghoz az túl lassú —
// ebből nem pontatlan közös számláló lesz, hanem őszintén eszközönkénti.
//
// Tiszta és függőség nélküli, mint a megosztott mag többi része — a Kotlin
// tükrözi (Android is mér és tilt), a Swift a mezőket viszi át (az iPhone nem
// mér előteret, ott a szabály nem érvényesül — kimondva, nem elhallgatva).
// Lásd docs/feature-burst-limit.md.

/** Az adag legfeljebb egy nap — ami ennél több, az már a napi keret dolga. */
export const MAX_BURST_MINUTES = 24 * 60;
/** A szünet is legfeljebb egy nap — ami hosszabb, az sima tiltás legyen. */
export const MAX_COOLDOWN_MINUTES = 24 * 60;

export interface BurstRule {
  /** ennyi aktív használat fér egy adagba, másodpercben */
  burstSeconds: number;
  /** ennyi ideig tilt utána, másodpercben */
  cooldownSeconds: number;
}

/**
 * Az adag-számláló egy oldalra, EZEN a gépen.
 *
 * Nem kerül a drótra: lásd a fejlécet. A `lastAt` a legutóbb elszámolt minta
 * ideje — ebből derül ki, hogy volt-e egy hűtésnyi pihenő.
 */
export interface BurstState {
  usedSeconds: number;
  lastAt: number;
  cooldownUntil: number;
}

/**
 * Használható szabály a két beírt értékből, vagy null.
 *
 * A kettő CSAK EGYÜTT értelmes: adag szünet nélkül nem tilt semmit, szünet
 * adag nélkül sosem indul el. A fél-kitöltött állapotot ezért nem tároljuk el
 * félig, hanem nincs szabály.
 */
export function normalizeBurst(
  burstSeconds: number | undefined | null, cooldownSeconds: number | undefined | null,
): BurstRule | null {
  if (burstSeconds === undefined || burstSeconds === null) return null;
  if (cooldownSeconds === undefined || cooldownSeconds === null) return null;
  if (!Number.isFinite(burstSeconds) || burstSeconds <= 0) return null;
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds <= 0) return null;
  return {
    burstSeconds: Math.min(Math.round(burstSeconds), MAX_BURST_MINUTES * 60),
    cooldownSeconds: Math.min(Math.round(cooldownSeconds), MAX_COOLDOWN_MINUTES * 60),
  };
}

/**
 * Egy elfogadott mérés-minta elszámolása az adag-számlálóban.
 *
 * A minták időbélyeggel jönnek, és nem feltétlenül sorban — a köteg múltbeli
 * szeleteket is hozhat. Ezért:
 *
 *   - hűtés alatt a minta NEM számít (a tiltott oldal hibalapján ülve mért
 *     másodpercek különben újraindítanák a hűtést a lejárta után);
 *   - ha a minta és az előző elszámolt minta közt egy hűtésnyi csend volt,
 *     a számláló tiszta lappal indul;
 *   - a `lastAt` sosem lép hátra: egy elkésett régi minta nem gyárthat
 *     hamis pihenőt.
 *
 * A visszaadott állapot ÚJ objektum — a hívó dönt, hova teszi.
 */
export function noteBurstUsage(
  rule: BurstRule, st: BurstState | undefined | null, seconds: number, at: number,
): BurstState {
  const cur: BurstState = st ?? { usedSeconds: 0, lastAt: 0, cooldownUntil: 0 };
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(at)) return cur;
  if (cur.cooldownUntil > at) return cur;
  let used = cur.usedSeconds;
  if (cur.lastAt > 0 && at - cur.lastAt >= rule.cooldownSeconds * 1000) used = 0;
  used += seconds;
  const lastAt = Math.max(cur.lastAt, at);
  if (used >= rule.burstSeconds) {
    // Az adag betelt: indul a hűtés, a számláló nulláról jön vissza. A hűtés
    // a MINTA idejétől számít, nem a beérkezésétől — ha a köteg késett, a
    // különbség már le is telt belőle.
    return { usedSeconds: 0, lastAt, cooldownUntil: at + rule.cooldownSeconds * 1000 };
  }
  return { usedSeconds: used, lastAt, cooldownUntil: cur.cooldownUntil };
}

/** Tart-e most a hűtés. */
export function isCoolingDown(st: BurstState | undefined | null, now: number): boolean {
  return !!st && st.cooldownUntil > now;
}

/**
 * LAZÍTÁS-e a szabály cseréje — mert a lazítás próbatételbe kerül.
 *
 * Szigorítás (ingyen): szabály felvétele, kisebb adag, hosszabb szünet.
 * Lazítás (próbatétel): a szabály levétele, nagyobb adag, rövidebb szünet.
 * Vegyes módosításnál elég egyetlen lazító irány, és már próbatétel — ahogy
 * a menetrendnél is a lazító fele dönt.
 */
export function isBurstLoosening(current: BurstRule | null, next: BurstRule | null): boolean {
  if (current === null) return false;      // nem volt szabály: bármilyen szabály szigorúbb
  if (next === null) return true;          // a szabály levétele felszabadítja az oldalt
  return next.burstSeconds > current.burstSeconds
    || next.cooldownSeconds < current.cooldownSeconds;
}
