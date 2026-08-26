// A munkamenet összefésülése két eszköz között.
//
// MIÉRT KÜLÖN FÁJL. A blokklista összefésülése (merge.ts) LISTÁT egyeztet,
// rekordonként. A munkamenetnél két nagyon különböző dolog utazik együtt:
//
//   - a CSOMAGOK: szerkeszthető beállítás, olyan, mint a blokklista;
//   - a FUTÓ munkamenet: EGY állapot, ami épp most tilt mindent.
//
// A kettőnek más a helyes összefésülése, és ha egy fájlban lennének, a kettő
// szabálya összekeveredne. A futó munkameneté a kockázatos: ott dől el, hogy a
// szinkron ki tudja-e kapcsolni azt, amit a felhasználó próbatétellel indított.
//
// A SZABÁLY UGYANAZ, MINT MINDENHOL:
//
//   szigorítás ingyen van, lazítás munkába kerül.
//
// A munkamenetnél a szigorítás iránya:
//
//   - INDÍTANI és HOSSZABBÍTANI szigorítás  -> azonos `rev` mellett is nyer;
//   - RÖVIDÍTENI és LEÁLLÍTANI lazítás      -> csak NAGYOBB `rev`-vel nyer.
//
// A `rev` csak akkor nő, ha valaki ténylegesen végigcsinálta a próbatételt.
// Enélkül a leállítás így nézne ki: a telefonon van egy régi, „nem fut”
// állapot, feltölti, és a gépen próbatétel nélkül eltűnik a munkamenet. Két
// eszköz és egy jól időzített szinkron elég lenne a kibúvóhoz.
//
// A doksi: docs/feature-focus-sessions.md

import {
  MAX_ALLOW_ENTRIES, normalizePack, type FocusPack, type FocusRun,
} from '../focus.js';

/** Legfeljebb ennyi csomag utazhat — a felületen sem fér ki több. */
export const MAX_PACKS = 30;

/**
 * A munkamenet a szinkronban.
 *
 * A `rev`/`updatedAt`/`updatedBy` hármas ugyanaz, mint a blokklistánál: a `rev`
 * a döntő, döntetlennél az idő, végül az eszközazonosító — hogy MINDEN eszköz
 * ugyanarra az eredményre jusson, különben két gép örökké oda-vissza írná
 * egymást.
 */
export interface SyncFocus {
  packs: FocusPack[];
  /** a futó munkamenet, vagy null, ha nem fut */
  run: FocusRun | null;
  rev: number;
  updatedAt: number;
  updatedBy: string;
}

export function emptyFocus(deviceId: string): SyncFocus {
  return { packs: [], run: null, rev: 0, updatedAt: 0, updatedBy: deviceId };
}

/**
 * Egy kívülről jött munkamenet-blob használható alakja.
 *
 * Kívülről jött adat: a szinkronon át érkező JSON ugyanolyan megbízhatatlan,
 * mint bármi más. Ami nem értelmezhető, az kiesik — de a blob EGÉSZE nem
 * hasalhat el egyetlen rossz csomagtól, mert akkor egy elrontott sor a futó
 * munkamenetet is eltüntetné.
 */
export function normalizeSyncFocus(raw: unknown, fallbackDevice: string): SyncFocus {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<SyncFocus>;
  const packs: FocusPack[] = [];
  for (const p of Array.isArray(o.packs) ? o.packs : []) {
    const n = normalizePack(p);
    if (n && !packs.some((x) => x.id === n.id) && packs.length < MAX_PACKS) packs.push(n);
  }
  return {
    packs,
    run: normalizeRun(o.run, packs),
    rev: numberOr(o.rev, 0),
    updatedAt: numberOr(o.updatedAt, 0),
    updatedBy: typeof o.updatedBy === 'string' && o.updatedBy ? o.updatedBy : fallbackDevice,
  };
}

/**
 * A futó munkamenet megtisztítása.
 *
 * Ha a csomagja nincs meg, a futás ÉRTELMEZHETETLEN: nem tudnánk megmondani,
 * mi mehet alatta. Ilyenkor nem tippelünk — a fehérlista tartalma nem az a
 * dolog, amit kitalálni szabad —, hanem eldobjuk a futást.
 */
function normalizeRun(raw: unknown, packs: FocusPack[]): FocusRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<FocusRun>;
  if (typeof r.packId !== 'string' || !packs.some((p) => p.id === r.packId)) return null;
  const startedAt = numberOr(r.startedAt, 0);
  const endsAt = numberOr(r.endsAt, 0);
  if (endsAt <= 0) return null;
  return { packId: r.packId, startedAt, endsAt };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Két munkamenet-állapot összefésülése.
 *
 * A csomagok és a futás KÜLÖN dőlnek el, mert más a szabályuk:
 *
 *   - a csomagoknál az utolsó író nyer (ez beállítás, nem tiltás — egy régi
 *     lista visszatérése bosszantó, de nem kibúvó);
 *   - a futásnál a SZIGORÚBB nyer, és lazítani csak nagyobb `rev` tud.
 */
export function mergeFocus(local: SyncFocus, incoming: SyncFocus): SyncFocus {
  const newer = pickNewer(local, incoming);
  const older = newer === local ? incoming : local;
  return {
    packs: newer.packs,
    run: mergeRun(local, incoming),
    rev: Math.max(local.rev, incoming.rev),
    updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
    // Az eszközazonosító a győztesé: enélkül a döntetlen-eltörés nem lenne
    // stabil, és a két eszköz felváltva írná felül egymást.
    updatedBy: newer.updatedBy || older.updatedBy,
  };
}

/**
 * Melyik oldal FRISSEBB. Sorrend: `rev`, majd idő, majd eszközazonosító.
 *
 * Az azonosító nem esztétika: ez teszi a döntést determinisztikussá. Enélkül
 * két eszköz ugyanabban a másodpercben írva örökké oda-vissza cserélgetné a
 * listát, és mindkettő azt látná, hogy „a másik elrontja”.
 */
function pickNewer(a: SyncFocus, b: SyncFocus): SyncFocus {
  if (a.rev !== b.rev) return a.rev > b.rev ? a : b;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.updatedBy >= b.updatedBy ? a : b;
}

/**
 * A FUTÓ munkamenet összefésülése — a kockázatos fele.
 *
 *   - nagyobb `rev` -> az övé a döntés, akár leállítás is (megcsinálta a
 *     próbatételt);
 *   - azonos `rev` -> a SZIGORÚBB nyer: a futó erősebb a nem futónál, két futó
 *     közül a később végződő.
 *
 * Így egy régi, „nem fut” állapot visszajátszása nem kapcsol ki semmit, egy
 * hosszabbítás viszont próbatétel nélkül is átmegy — pontosan úgy, ahogy az
 * appban.
 */
function mergeRun(a: SyncFocus, b: SyncFocus): FocusRun | null {
  if (a.rev !== b.rev) return (a.rev > b.rev ? a : b).run;
  if (!a.run) return b.run;
  if (!b.run) return a.run;
  return a.run.endsAt >= b.run.endsAt ? a.run : b.run;
}

/** Ugyanaz-e a két állapot (nincs mit feltölteni). */
export function sameFocus(a: SyncFocus, b: SyncFocus): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function stable(f: SyncFocus): unknown {
  return {
    packs: [...f.packs]
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .map((p) => ({
        id: p.id,
        name: p.name,
        allowSites: [...p.allowSites].sort().slice(0, MAX_ALLOW_ENTRIES),
        allowApps: [...p.allowApps].sort().slice(0, MAX_ALLOW_ENTRIES),
        defaultMinutes: p.defaultMinutes,
      })),
    run: f.run ? { packId: f.run.packId, startedAt: f.run.startedAt, endsAt: f.run.endsAt } : null,
    rev: f.rev,
  };
}
