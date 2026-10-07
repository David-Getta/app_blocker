// Mikor szóljon az app, hogy egy szünet (feloldás) mindjárt véget ér.
//
// A feloldás próbatétellel kifizetett idő, és a vége nem lehet meglepetés:
// aki épp ír, néz vagy olvas, annak két perc kell, hogy befejezze. A lista
// sora ott van („Szünetel még …”), de aki nem a Breaker-ablakot nézi, az nem
// látja — a visszazárás némán történne meg, félbehagyott mondat közepén.
//
// A modul szándékosan tiszta, mint az adag-értesítésé (burst-notify.ts): két
// egymás utáni képből mondja meg, van-e mondanivaló. Két hallgatási szabály:
//
// - a frissen indított RÖVID szünetre (amit már a figyelmeztetési időn belül
//   látunk először) nem szól: a felhasználó épp most állította be, tudja;
// - egy szünetről egyszer szól. Ha közben a vége változik (új feloldás),
//   az új szünet új figyelést kap; ha eltűnik (visszakapcsolta), hallgat.
//
// Ugyanez a szabály a Kotlin (`PauseNotify`) és a Swift (`PauseNotify`) magban.

/** Ennyivel a szünet vége előtt szól az app. */
export const PAUSE_END_WARN_MS = 2 * 60_000;

/** Amit a lépegető egy oldalról tudni akar — a felület tölti ki. */
export interface PauseView {
  id: string;
  /** a MEGJELENÍTENDŐ név (fedőnév / rejtett sorszám), nem a nyers domain */
  label: string;
  pauseUntil: number | null;
}

/** A figyelt szünetek: oldal → a szünet vége, amiről még nem szóltunk. */
export type PauseWatches = Record<string, number>;

export interface PauseNotice {
  label: string;
  until: number;
}

/**
 * Egy kör: a figyelt szünetek (`prev`) és a mostani oldalak alapján megmondja,
 * miről kell most szólni, és visszaadja a következő kör figyelését.
 */
export function stepPauseNotices(
  prev: PauseWatches,
  sites: PauseView[],
  now: number,
): { watches: PauseWatches; notices: PauseNotice[] } {
  const watches: PauseWatches = {};
  const notices: PauseNotice[] = [];
  for (const s of sites) {
    const until = s.pauseUntil;
    if (until === null || !Number.isFinite(until) || until <= now) continue;
    if (until - now > PAUSE_END_WARN_MS) {
      watches[s.id] = until; // élesítve: a figyelmeztetés idején szólunk
      continue;
    }
    // Az ablakon belül: csak az élesített, UGYANAZ a szünet kap szót — a
    // frissen indított rövidre és a már bejelentettre hallgatunk.
    if (prev[s.id] === until) notices.push({ label: s.label, until });
  }
  return { watches, notices };
}

/** Az értesítés címe — ugyanaz mindhárom platformon. */
export const PAUSE_END_TITLE = 'Breaker — mindjárt vége a szünetnek';

/**
 * Az értesítés szövege, tény, nem felszólítás:
 * „youtube.com 2 perc múlva újra zárva — a szünet véget ér.”
 * A hátralévő perc felfelé kerekít, mint a zárlat számlálója: két percen
 * belül „2 perc”, az utolsó percben „1 perc”.
 */
export function pauseEndText(label: string, leftMs: number): string {
  const minutes = Math.max(1, Math.ceil(leftMs / 60_000));
  return `${label} ${minutes} perc múlva újra zárva — a szünet véget ér.`;
}
