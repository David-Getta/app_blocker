// Mikor induljon a szinkron magától.
//
// Külön fájl és külön tesztek, mert ez a huzalozás egy csúnya hurkot rejt, amit
// ránézésre semmi nem árul el:
//
//   a szinkron a végén MENT (commit),
//   a mentés viszont ÜTEMEZ egy szinkront (hogy a változás felmenjen),
//   az a szinkron megint ment…
//
// Így a segéd húsz másodpercenként, örökre verte volna a kiszolgálót — miközben
// minden egyes függvény külön-külön helyes. Ezért tartunk számon egy futás
// közbeni állapotot: a szinkron alatti mentés NEM ütemez újat.
//
// A hívó adja az időzítőt, hogy a teszt ne valós időben fusson.

export interface SyncScheduleDeps {
  /** van-e egyáltalán fiók; enélkül nincs mit szinkronizálni */
  hasAccount: () => boolean;
  /** a tényleges kör; a hívó felelőssége, hogy ne dobjon */
  run: (why: string) => Promise<void>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface SyncSchedule {
  /** minden mentés után hívandó */
  notifyCommit: () => void;
  /** azonnali kör (indulás, időzítő, kézi gomb) */
  runNow: (why: string) => Promise<void>;
  /** csak tesztekhez: van-e felfüggesztett ütemezés */
  pending: () => boolean;
}

export function createSyncSchedule(deps: SyncScheduleDeps, debounceMs: number): SyncSchedule {
  let timer: unknown = null;
  let running = false;

  const notifyCommit = (): void => {
    // A szinkron saját mentése NEM indíthat újabb kört: az a hurok.
    if (running || timer !== null) return;
    if (!deps.hasAccount()) return;
    timer = deps.setTimer(() => {
      timer = null;
      void runNow('változás');
    }, debounceMs);
  };

  const runNow = async (why: string): Promise<void> => {
    if (running || !deps.hasAccount()) return;
    running = true;
    // A felfüggesztett ütemezés fölösleges, ha úgyis most futunk.
    if (timer !== null) { deps.clearTimer(timer); timer = null; }
    try {
      await deps.run(why);
    } finally {
      running = false;
    }
  };

  return { notifyCommit, runNow, pending: () => timer !== null };
}
