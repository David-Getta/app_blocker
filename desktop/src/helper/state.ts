// Persistent helper state. Lives in a root/SYSTEM protected directory so the
// GUI (and the user) cannot simply edit the blocklist file to skip challenges.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Step } from '../shared/challenges';
import type { Schedule } from '../shared/schedule';
import { emptyUsage, type UsageState } from '../shared/usage';
import type { SharedToday } from '../shared/limits';
import {
  MAX_FOCUS_LOG, normalizePack, type FocusLogEntry, type FocusPack, type FocusRun,
} from '../shared/focus';
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
  /**
   * Ha van, a teljesítés a futó munkamenetet rövidíti erre az időpontra.
   *
   * A -1 azt jelenti: állítsd le MOST. A kettőt meg kell különböztetni, mert a
   * „nulla” egy érvényes időpont lenne, a hiányzó mező pedig azt jelenti, hogy
   * ez a kísérlet nem a munkamenetről szól.
   */
  pendingFocusEnd?: number;
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
   * Mikor rögzítettünk UTOLJÁRA mért időt.
   *
   * Nem a szinkronizált mérés-blobban van, hanem itt: ez helyi diagnosztika,
   * nem adat. A statisztikán a nulla önmagában néma — nem lehet megmondani
   * belőle, hogy tényleg nem használtad a gépet, vagy a mérés hasalt el. Ez a
   * mező teszi különbséggé a kettőt.
   */
  usageLastSampleAt?: number;
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

  /**
   * A többi eszköz mai összegzése — ebből lesz a KÖZÖS napi keret.
   *
   * Azért van elmentve, és nem csak a memóriában: ha a gép újraindul, vagy a
   * szinkron épp nem érhető el, a délelőtt a telefonon elhasznált keret ne
   * induljon újra nulláról. Elavulni nem tud, mert minden sor a saját napját
   * hozza — éjfélkor magától kiürül.
   */
  sharedToday?: SharedToday;

  /**
   * Munkamenet-csomagok: „most csak EZ mehet”.
   *
   * A blokklista feketelista, ez fehérlista. Lásd shared/focus.ts.
   */
  focusPacks?: FocusPack[];
  /** a FUTÓ munkamenet, ha van */
  focusRun?: FocusRun | null;
  /**
   * A munkamenet szinkron-számlálója.
   *
   * Ugyanaz a szerep, mint az oldalak `rev` mezőjének: ez dönti el, mikor mehet
   * át egy LAZÍTÁS (rövidítés, leállítás) a másik eszközre. Nőni csak akkor tud,
   * ha a munkamenet ténylegesen megváltozott ezen a gépen — leállítani pedig
   * csak próbatétellel lehet, tehát a nagyobb szám mögött ott a munka.
   */
  focusRev?: number;
  focusUpdatedAt?: number;
  focusUpdatedBy?: string;
  /** a lenyomat, amiből kiderül, hogy változott-e (lásd revisions.ts) */
  focusRevFp?: string;
  /**
   * Miért nem megy a munkamenet szinkronja, ha nem megy.
   *
   * Külön mező, mert a munkamenet köre SZÁNDÉKOSAN nem állítja meg az egész
   * szinkront (a blokklista fontosabb). Enélkül viszont a hiba néma lenne: egy
   * régi fiókkiszolgáló nem ismeri a gyűjteményt, a menet sosem érne át a
   * telefonra, és a felhasználó azt hinné, a funkció rossz.
   */
  focusSyncError?: string;
  /**
   * A LEZÁRULT munkamenetek naplója.
   *
   * Helyi marad, nem megy fel a kiszolgálóra: ez mérés, nem beállítás — és a
   * mérés eddig sem hagyta el a gépet. A statisztika ebből dolgozik.
   */
  focusLog?: FocusLogEntry[];
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
  /** a munkamenet-gyűjtemény utolsó ismert verziója a kiszolgálón */
  focusVersion?: number;
  /** a saját `usage` blobunk verziója */
  usageVersion?: number;
  /** a saját mai összegzésünk verziója (a közös napi kerethez) */
  todayVersion?: number;
  /** az utolsó kör, ami VÉGIG lefutott */
  lastSyncAt?: number;
  /**
   * Az utolsó PRÓBÁLKOZÁS — sikeres és sikertelen egyaránt.
   *
   * Külön mező, mert e nélkül egy befagyott időbélyeg kétértelmű: nem lehet
   * megmondani, hogy a szinkron tíz órája sikertelen és tíz percenként újra
   * próbálja, vagy hogy a kör MAGA állt le és azóta hozzá se kezdett. A
   * kettő közül a második valódi hiba, az első csak offline gép — a
   * felhasználó pedig ugyanazt látta mindkettőre.
   */
  lastAttemptAt?: number;
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
      // A közös keret adatai kívülről jönnek: ha nem a várt alakúak, inkább
      // ne legyenek. Egy hibás sor itt a blokkolási döntést befolyásolná.
      // A csomagok kívülről is jöhetnek (állapotfájl, később szinkron): amit
      // nem tudunk értelmezni, azt inkább nem tartjuk meg.
      if (parsed.focusPacks !== undefined) {
        parsed.focusPacks = (Array.isArray(parsed.focusPacks) ? parsed.focusPacks : [])
          .map((x) => normalizePack(x))
          .filter((x): x is FocusPack => x !== null);
      }
      // A napló is kívülről jön. Ha nem tömb, a statisztika `filter`-e KIVÉTELT
      // dobna — és a felhasználó egy üres statisztika-képernyőt látna, aminek
      // semmi köze nem lenne a méréshez. Ami nem értelmezhető, az kiesik; a
      // sorok külön-külön is, mert egy rossz sor ne vigye el az egész hetet.
      if (parsed.focusLog !== undefined) {
        parsed.focusLog = (Array.isArray(parsed.focusLog) ? parsed.focusLog : [])
          .filter((e): e is FocusLogEntry => !!e && typeof e === 'object'
            && typeof (e as FocusLogEntry).packId === 'string'
            && typeof (e as FocusLogEntry).packName === 'string'
            && Number.isFinite((e as FocusLogEntry).startedAt)
            && Number.isFinite((e as FocusLogEntry).endedAt)
            && Number.isFinite((e as FocusLogEntry).plannedEndsAt))
          .slice(-MAX_FOCUS_LOG);
      }
      const run = parsed.focusRun;
      if (run && !(typeof run.packId === 'string' && Number.isFinite(run.endsAt))) {
        parsed.focusRun = null;
      }
      const shared = parsed.sharedToday;
      if (shared && !(typeof shared.selfDeviceId === 'string' && Array.isArray(shared.devices))) {
        delete parsed.sharedToday;
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
