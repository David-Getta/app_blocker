// Persistent helper state. Lives in a root/SYSTEM protected directory so the
// GUI (and the user) cannot simply edit the blocklist file to skip challenges.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Step } from '../shared/challenges';
import type { Schedule } from '../shared/schedule';
import { emptyUsage, type UsageState } from '../shared/usage';
import type { UrlRule } from '../shared/urlrules';
import { stateFilePath } from './paths';

export interface SiteRec {
  id: string;
  domain: string;
  hostnames: string[];
  addedAt: number;
  pauseUntil: number | null;
  pendingDeleteAt: number | null;
  /** optional weekly schedule; absent = always blocked */
  schedule?: Schedule;
  /** optional daily active-time budget in seconds; absent = no budget */
  dailyLimitSeconds?: number;
  /** fedőnév: ha van, a felület EZT mutatja a cím helyett (lásd shared/alias.ts) */
  alias?: string;
  /**
   * Részleges szabályok: az oldal egy-egy darabja (pl. `/@valaki`).
   *
   * Ezeket a DNS-motor NEM tudja érvényesíteni — a hosztnévnél tovább nem lát.
   * A böngésző-bővítmény veszi át őket; a segéd tárolja és szinkronizálja, hogy
   * ne kelljen minden gépen újra felvenni. Lásd docs/feature-partial-block.md.
   */
  rules?: UrlRule[];

  // --- szinkron (lásd helper/revisions.ts és shared/sync/merge.ts) ---
  /** hányszor változott érdemben ez a rekord; ez dönt az összefésülésnél */
  rev?: number;
  /** mikor változott utoljára (ms) */
  updatedAt?: number;
  /** melyik eszközön — a döntetlen eltörésére */
  updatedBy?: string;
  /** a szinkron-mezők lenyomata a legutóbbi léptetéskor; ebből látszik, hogy változott-e */
  revFp?: string;
}

export interface SessionRec {
  id: string;
  kind: 'pause' | 'delete';
  siteId: string;
  minutes?: number;
  steps: Step[];
  stepIndex: number;
  createdAt: number;
  /** when set, finishing the session applies this schedule instead of pausing
   *  (used to gate schedule LOOSENING behind the same challenges) */
  pendingSchedule?: Schedule;
  /** when set, finishing applies this daily budget instead of pausing;
   *  null means "remove the budget" (both are gated loosenings) */
  pendingLimit?: number | null;
  /** ha van, a teljesítés EZT a részleges szabályt veszi le (lazítás) */
  pendingRuleRemoval?: UrlRule;
}

/**
 * What an abandoned attempt leaves behind, so restarting cannot re-roll it.
 *
 * Kept PER SITE, and a single shared record would not do: with one slot,
 * starting and cancelling an attempt on any other site (or the delete flow on
 * the same one) would evict the debt and hand back a fresh draw — the re-roll
 * again, one step removed.
 */
export interface AbandonRec {
  siteId: string;
  kind: 'pause' | 'delete';
  comboKey: string;
  at: number;
}

export interface HelperState {
  version: 1;
  sites: SiteRec[];
  /** epoch ms of every successful unlock/delete request, for difficulty tiers */
  unlockLog: number[];
  lastCombo: string | null;
  session: SessionRec | null;
  /** attempts given up on, per site; see REROLL_COOLDOWN_MS */
  abandons?: AbandonRec[];
  /** wall clock at the previous housekeeping tick, to notice clock jumps */
  lastTickAt?: number;
  dohApplied: boolean;
  /** active-time tracking history (stays on this machine) */
  usage: UsageState;
  /**
   * Rejtve induljon-e a blokkolt oldalak listája.
   *
   * Beállítás, nem pillanatnyi állapot: a felület minden indításkor rejtve
   * kezdi, és a munkamenetre nyitható meg. Így az app megnyitása önmagában nem
   * szembesít azzal, mi van blokkolva.
   */
  hideSiteList?: boolean;

  /**
   * Fiók a szinkronhoz. Hiányzik = nincs bejelentkezve.
   *
   * A `dataKey` szándékosan ITT van, a segéd root-védett állapotfájljában: a
   * végpontok közti titkosítás a KISZOLGÁLÓ ellen véd, nem a saját géped ellen.
   * Ha a felület tárolná, minden felhasználói folyamat elolvashatná.
   */
  sync?: SyncAccount;
}

export interface SyncAccount {
  serverUrl: string;
  accountId: string;
  /** ezen a gépen ez az eszközazonosító — a döntetlen eltörésére is ez megy */
  deviceId: string;
  /** amit a kiszolgálónak küldünk; a jelszó sosem kerül ide */
  authKey: string;
  /** az adatkulcs base64-ben; ezzel titkosítjuk a feltöltött tartalmat */
  dataKey: string;
  /** eszköznév, amit a többi eszközön látni fogsz (titkosítva megy fel) */
  deviceName: string;
  /** a `sites` gyűjtemény verziója, amire a legutóbbi feltöltésünk épült */
  sitesVersion?: number;
  /** a saját `usage` blobunk verziója */
  usageVersion?: number;
  lastSyncAt?: number;
  /** az utolsó hiba, hogy a felület meg tudja mondani, mi nem megy */
  lastError?: string;
}

export function defaultState(): HelperState {
  return {
    version: 1, sites: [], unlockLog: [], lastCombo: null, session: null,
    dohApplied: false, usage: emptyUsage(),
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export function loadState(): HelperState {
  const file = stateFilePath();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as HelperState;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.sites)) {
      // Forward migration: state files written before usage tracking existed.
      if (!parsed.usage || !Array.isArray(parsed.usage.days)) parsed.usage = emptyUsage();
      if (!Array.isArray(parsed.unlockLog)) parsed.unlockLog = [];
      // A session whose stepIndex does not address a real step can only wedge
      // the referee — every operation on it reads steps[stepIndex]. Dropping it
      // means the unlock attempt starts over, which is friction in the safe
      // direction; keeping it would block pause AND delete indefinitely.
      const ses = parsed.session;
      if (ses && !(Array.isArray(ses.steps) && ses.stepIndex >= 0 && ses.stepIndex < ses.steps.length)) {
        parsed.session = null;
      }
      return parsed;
    }
  } catch {
    // missing or corrupt -> start fresh
  }
  return defaultState();
}

export function saveState(state: HelperState): void {
  const file = stateFilePath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = path.join(dir, `.state.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
