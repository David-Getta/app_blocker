// Mikor szóljon a gép az adag-hűtésről — két állapotkép különbségéből.
//
// Androidon a tartós értesítés mondja meg, melyik oldal hűl és meddig, mert
// ott a VPN-szolgáltatás mindig fut. A gépen a segéd nem tud értesítést dobni
// (arc nélküli, root jogú démon), a böngészőn kívül pedig semmi nem magyaráz:
// aki épp nem a Breaker-ablakot nézi, annak a betelés némán történik meg, a
// feloldódást meg csak találgatni tudja. Ezt a lyukat tömi be az app saját
// értesítése — a betelés pillanatában és a szünet leteltekor.
//
// A modul szándékosan tiszta: két egymás utáni státusz-képből (mi hűl most,
// mi hűlt az előbb) mondja meg, van-e mondanivaló. Így a szabályai egyenként
// tesztelhetők, a felület meg csak kirakja, amit kap.
//
// Három kimondott hallgatási szabály — mind arról szól, hogy az értesítés
// csak TÉNYT mondjon ki, találgatást soha:
//
// - az app indulásakor futó hűtésre nem mond „most telt be”-t: a kezdetét
//   nem láttuk, a bejelentés hamis lenne. A LETELTÉT viszont bejelenti —
//   az attól még tény, hogy a kezdetén nem voltunk ott;
// - ha a hűtés a vége ELŐTT tűnik el (megváltott szünet, levett szabály),
//   hallgat: ott a felhasználó maga cselekedett, tudja;
// - a közben törölt oldalról akkor sem szól, ha az idő letelt: egy már nem
//   létező oldalra az „újra nyitva” nem tájékoztatás, hanem zaj.

/** Amennyit a lejárat-egyeztetés enged: a 2 mp-es kör csúszása + tartalék. */
export const REOPEN_SLACK_MS = 2500;

/** Amit a lépegető egy oldalról tudni akar — a felület tölti ki. */
export interface CoolingView {
  id: string;
  /** a MEGJELENÍTENDŐ név (fedőnév / rejtett sorszám), nem a nyers domain */
  label: string;
  closedReason?: string;
  closedUntil: number;
}

/**
 * Egy figyelt hűtés: meddig tart. Címke szándékosan nincs benne — a
 * bejelentés mindig a FRISS képből veszi a nevet, mert a fedőnév és a
 * rejtettség két kör között is változhat, és a bejelentésnek a mostani
 * állapotot kell tükröznie, nem a betéskorit.
 */
export interface BurstWatch {
  until: number;
}

export interface BurstNotice {
  kind: 'tripped' | 'reopened';
  label: string;
  until: number;
}

/**
 * Egy kör: az előző kép (`prev`) és a mostani oldalak alapján megmondja, mit
 * kell bejelenteni, és visszaadja a következő kör előző-képét.
 *
 * `prev === null` az első kör az app indulása után: ami épp hűl, azt
 * bejelentés nélkül vesszük fel — lásd a fájl tetején az első hallgatási
 * szabályt. A felvett hűtés leteltét már a rendes szabály jelenti be.
 */
export function stepBurstNotices(
  prev: Record<string, BurstWatch> | null,
  sites: CoolingView[],
  now: number,
): { watches: Record<string, BurstWatch>; notices: BurstNotice[] } {
  const watches: Record<string, BurstWatch> = {};
  const notices: BurstNotice[] = [];

  for (const s of sites) {
    // A lejárt, de még ki nem takarított bejegyzés nem hűtés — a segéd a
    // status-t élőben számolja, ez csak öv a nadrágtartó mellé.
    if (s.closedReason !== 'cooldown' || s.closedUntil <= now) continue;
    watches[s.id] = { until: s.closedUntil };
    if (prev !== null && !prev[s.id]) {
      notices.push({ kind: 'tripped', label: s.label, until: s.closedUntil });
    }
  }

  if (prev !== null) {
    for (const [id, w] of Object.entries(prev)) {
      if (watches[id]) continue; // még hűl
      const site = sites.find((s) => s.id === id);
      if (!site) continue; // törölt oldal — harmadik hallgatási szabály
      if (now < w.until - REOPEN_SLACK_MS) continue; // korai eltűnés — második szabály
      notices.push({ kind: 'reopened', label: site.label, until: w.until });
    }
  }

  return { watches, notices };
}
