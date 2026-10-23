// A csendes frissítés bekötése a segédbe (#151, macOS): egyszerre egy, egy
// sikertelen próba után türelmi idő, a felkínált csomag megjegyzése (hogy egy
// visszatartott ajánlat se tartson egy régi segédet a helyén), és az állapot a
// status-ban. A motor maga a helper/update.ts.

import * as fs from 'fs';
import * as path from 'path';
import { runUpdate, type UpdateDeps, type UpdateOffer, type UpdateResult, badPayloads, offerPathProblem } from './update';

export interface HelperUpdateStatus {
  state: 'idle' | 'working' | 'failed' | 'activating' | 'rolled-back';
  error?: string;
  detail?: string;
  /** az utolsó próba ideje (ms) */
  at?: number;
}

/** A megjegyzett ajánlat a futtatókörnyezetben: rootnak írható, a segéd olvassa újra. */
interface StoredOffer extends UpdateOffer {
  /** a legutóbb átvett csomag ujjlenyomata — ha az őr visszaállított, ez a .bad-ben van */
  lastSha?: string;
}

/** Egy sikertelen próba után ennyi ideig nem próbáljuk újra ugyanazt. */
export const UPDATE_COOLDOWN_MS = 10 * 60_000;
/** Ilyen sűrűn nézzük újra a megjegyzett ajánlatot. */
export const UPDATE_RECHECK_MS = 6 * 60 * 60_000;

export interface Updater {
  offer(o: UpdateOffer, quiet?: boolean): Promise<UpdateResult>;
  status(): HelperUpdateStatus;
  /** az induláskori és a hatóránkénti újranézés */
  start(setTimer: (fn: () => void, ms: number) => void): void;
}

export function createUpdater(d: UpdateDeps & { onActivated: () => void }): Updater {
  const offerFile = path.join(d.root, '.offer.json');
  let busy = false;
  let st: HelperUpdateStatus = { state: 'idle' };
  let lastFail: { key: string; at: number } | null = null;

  const read = (): StoredOffer | null => {
    try {
      const v = JSON.parse(fs.readFileSync(offerFile, 'utf8')) as StoredOffer;
      if (offerPathProblem(v)) return null;
      return { bundle: v.bundle, ...(v.nodeTar ? { nodeTar: v.nodeTar } : {}), ...(typeof v.lastSha === 'string' ? { lastSha: v.lastSha } : {}) };
    } catch {
      return null;
    }
  };
  const write = (o: StoredOffer): void => {
    try {
      fs.writeFileSync(offerFile, `${JSON.stringify(o)}\n`, { mode: 0o600 });
    } catch (e) {
      d.log(`az ajánlat nem íródott ki: ${(e as Error).message}`);
    }
  };

  // Induláskor: ha a legutóbb átvett csomagot az őr visszaállította, kimondjuk.
  const stored = read();
  if (stored?.lastSha && badPayloads(d.root).has(stored.lastSha)) {
    st = { state: 'rolled-back', error: 'rolled-back' };
  }

  const offer = async (o: UpdateOffer, quiet = false): Promise<UpdateResult> => {
    const why = offerPathProblem(o);
    if (why) return { ok: false, error: 'path', detail: why };
    if (busy) return { ok: false, error: 'busy' };
    const key = `${o.bundle}|${o.nodeTar ?? ''}`;
    if (lastFail && lastFail.key === key && d.now() - lastFail.at < UPDATE_COOLDOWN_MS) {
      return { ok: false, error: 'cooldown' };
    }
    busy = true;
    const prev = st;
    st = { state: 'working', at: d.now() };
    // Megjegyezzük: ha a felület később nem kínálja fel, magunktól is megnézzük.
    write({ ...(read() ?? {}), bundle: o.bundle, ...(o.nodeTar ? { nodeTar: o.nodeTar } : { nodeTar: undefined }) });
    try {
      const r = await runUpdate(o, d);
      if (r.ok) {
        const cur = read();
        write({ ...(cur ?? o), lastSha: r.payloadSha256 });
        st = { state: 'activating', at: d.now() };
        d.onActivated();
        return r;
      }
      if (r.error === 'not-newer') {
        // Nincs újabb: a régi állapot marad (egy visszaállítás híre se tűnjön el).
        st = prev.state === 'working' ? { state: 'idle' } : prev;
      } else if (r.error !== 'busy') {
        lastFail = { key, at: d.now() };
        st = { state: 'failed', error: r.error, detail: r.detail, at: d.now() };
        if (!quiet || r.error !== 'need-node') d.log(`csendes frissítés: nem sikerült (${r.error}${r.detail ? `: ${r.detail}` : ''})`);
      } else {
        st = prev;
      }
      return r;
    } finally {
      busy = false;
    }
  };

  return {
    offer,
    status: () => ({ ...st }),
    start(setTimer) {
      const recheck = (): void => {
        const o = read();
        if (o) void offer({ bundle: o.bundle, ...(o.nodeTar ? { nodeTar: o.nodeTar } : {}) }, true);
        setTimer(recheck, UPDATE_RECHECK_MS);
      };
      setTimer(recheck, 2 * 60_000);
    },
  };
}
