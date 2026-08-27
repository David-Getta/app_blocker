// Wire protocol between the GUI app and the privileged helper.
// Newline-delimited JSON over a unix domain socket (macOS) / named pipe (Windows).

export type ChallengeType = 'TRANSCRIBE' | 'MATH_CHAIN' | 'MEMORY' | 'REVERSE' | 'DELAY';

/** What the UI is allowed to see about the current step. Never contains expected answers. */
export interface StepDisplay {
  id: string;
  type: ChallengeType;
  /** TRANSCRIBE / REVERSE: the text to work from. */
  text?: string;
  /** MATH_CHAIN: current problem and position. */
  math?: { question: string; index: number; total: number };
  /** MEMORY: server-armed timing. `code` is only present while the show window
   *  is open (armedAt + showMs); afterwards the server stops shipping it. */
  memory?: { code: string | null; showMs: number; waitMs: number; armedAt: number | null };
  /** DELAY: when the claim window opens/closes (epoch ms). */
  delay?: { minutes: number; claimableAt: number | null; claimWindowMs: number };
}

export interface SessionInfo {
  id: string;
  kind: 'pause' | 'delete';
  siteId: string;
  /** pause length that was requested (minutes), pause sessions only */
  minutes?: number;
  stepIndex: number;
  stepCount: number;
  current: StepDisplay;
}

export interface SiteInfo {
  id: string;
  domain: string;
  hostnames: string[];
  addedAt: number;
  /** epoch ms until which blocking is paused, or null when actively blocked */
  pauseUntil: number | null;
  /** epoch ms when the site will actually be deleted, or null */
  pendingDeleteAt: number | null;
  /** weekly schedule (absent = always blocked) */
  schedule?: import('./schedule').Schedule;
  /** daily active-time budget in seconds (absent = no budget) */
  dailyLimitSeconds?: number;
  /** fedőnév: ha van, a felület ezt mutatja a cím helyett */
  alias?: string;
  /**
   * Részleges szabályok (pl. `/@valaki`).
   *
   * Ezeket a DNS-motor nem érvényesíti — a böngésző-bővítmény veszi át őket.
   * A felület ezért külön is kimondja, hogy ez gyengébb réteg.
   */
  rules?: import('./urlrules').UrlRule[];
  /** active seconds spent on this site today, for the budget meter */
  usedTodaySeconds: number;
  /**
   * Ebből mennyi jött MÁS eszközről.
   *
   * A keret közös: ha a telefonon elment tizenöt perc, itt már csak öt van a
   * húszból. A felületnek ezt ki kell mondania, különben úgy néz ki, mintha az
   * app rosszul számolna.
   */
  usedTodayElsewhere: number;
  /** true when today's budget is spent (and the site therefore blocks) */
  limitExhausted: boolean;
  /** whether the site is blocked at status time (pause + delete + schedule + budget) */
  blockedNow: boolean;
}

/**
 * Amit a felület a szinkronról tudhat.
 *
 * Az adatkulcs és a belépőkulcs SZÁNDÉKOSAN nincs benne: azok a segéd
 * root-védett állapotában maradnak. A felület csak annyit lát, ami a
 * megjelenítéshez kell.
 */
export interface SyncStatus {
  serverUrl: string;
  accountId: string;
  deviceName: string;
  lastSyncAt?: number;
  /** az utolsó próbálkozás ideje — sikertelen kör is léptet rajta */
  lastAttemptAt?: number;
  lastError?: string;
}

export interface SyncDeviceInfo {
  deviceId: string;
  name: string;
  /** ez az eszköz-e, amin épp ülünk */
  self: boolean;
  /** mért idő ma, másodpercben */
  todaySeconds: number;
  /** összesített mért idő az elmúlt 7 napban, másodpercben */
  last7Seconds: number;
  /**
   * A hét legtöbb idejét vivő célpontjai azon az eszközön.
   *
   * A `label` NYERS: a felület dolga fedőnévre vagy „rejtett oldal”-ra
   * cserélni. A segéd nem tudhatja, hogy a felületen épp rejtve van-e a lista.
   */
  top: { label: string; seconds: number }[];
}

/**
 * A fiók ÖSSZES eszköze együtt.
 *
 * Ez az a szám, ami tényleg számít: nem az, hogy mennyi ment el a gépen és
 * külön mennyi a telefonon, hanem hogy MENNYI ÖSSZESEN. Két eszközön napi húsz
 * perc együtt negyven.
 */
/**
 * Részleges szabály felvételének/levételének eredménye.
 *
 * `applied: true` = megtörtént (szigorítás, ingyen van).
 * `applied: false` + session = próbatétel indult (lazítás).
 */
export interface SetRuleResult {
  applied: boolean;
  session: SessionInfo | null;
}

export interface SyncCombinedInfo {
  /** hány eszköz adata van benne */
  deviceCount: number;
  todaySeconds: number;
  last7Seconds: number;
  /** NYERS címkék, ugyanúgy, mint eszközönként */
  top: { label: string; seconds: number }[];
}

export interface StatusData {
  helperVersion: string;
  platform: string;
  sites: SiteInfo[];
  /** difficulty tier 0..3 derived from recent unlocks */
  tier: number;
  unlocks7d: number;
  session: SessionInfo | null;
  dohPolicyApplied: boolean;
  /** whether active-time measurement is switched on */
  usageEnabled: boolean;
  /** rejtve induljon-e a blokkolt oldalak listája (felületi beállítás) */
  hideSiteList?: boolean;
  /** a szinkron állapota, ha van fiók */
  sync?: SyncStatus;
  /** munkamenet-csomagok: „most csak EZ mehet” (lásd shared/focus.ts) */
  focusPacks: import('./focus').FocusPack[];
  /** a FUTÓ munkamenet, ha van; a lejártat a segéd nem adja ki */
  focusRun: import('./focus').FocusRun | null;
  /**
   * Miért nem megy a munkamenet szinkronja, ha nem megy.
   *
   * A munkamenet köre szándékosan nem állítja meg az egész szinkront (a
   * blokklista fontosabb) — enélkül viszont a hiba NÉMA lenne, és a felhasználó
   * azt hinné, a funkció rossz.
   */
  focusSyncError?: string;
  /** egy korábbi néven telepített segéd láthatóan még fut (lásd hosts.ts) */
  legacyHelperRunning?: boolean;
  now: number;
}

export type HelperRequest =
  | { id: number; op: 'status' }
  | { id: number; op: 'add_site'; input: string; usePreset: boolean }
  | { id: number; op: 'start_unlock'; siteId: string; minutes: number }
  | { id: number; op: 'start_delete'; siteId: string }
  | { id: number; op: 'submit'; sessionId: string; answer: string }
  | { id: number; op: 'claim'; sessionId: string }
  | { id: number; op: 'abandon'; sessionId: string }
  | { id: number; op: 'cancel_delete'; siteId: string }
  | { id: number; op: 'relock'; siteId: string }
  | { id: number; op: 'set_schedule'; siteId: string; schedule: import('./schedule').Schedule }
  | { id: number; op: 'set_limit'; siteId: string; seconds: number | null }
  // A fedőnév NEM lazítás: az oldal ettől ugyanúgy blokkolva marad, csak nem a
  // címe áll a listán. Ezért próbatétel nélkül állítható, mindkét irányba.
  | { id: number; op: 'set_alias'; siteId: string; alias: string | null }
  // A lista elrejtése szintén tisztán felületi: a blokkolás nem változik tőle.
  | { id: number; op: 'set_hide_list'; hidden: boolean }
  | { id: number; op: 'set_rule'; siteId: string; input: string; remove: boolean }
  | { id: number; op: 'sync_signup'; serverUrl: string; accountId: string; password: string; deviceName: string }
  | { id: number; op: 'sync_signin'; serverUrl: string; accountId: string; password: string; deviceName: string }
  | { id: number; op: 'sync_recovery'; serverUrl: string; accountId: string; recoveryCode: string; newPassword: string; deviceName: string }
  | { id: number; op: 'sync_signout' }
  | { id: number; op: 'sync_now' }
  | { id: number; op: 'sync_devices' }
  | { id: number; op: 'usage_batch'; samples: UsageSampleMsg[] }
  | { id: number; op: 'usage_stats'; focusKey?: string }
  | { id: number; op: 'usage_enable'; enabled: boolean }
  | { id: number; op: 'usage_clear' }
  // Munkamenetek. A csomag mentése és törlése ingyen van — de nem azé, amelyik
  // épp fut. Az indítás szigorítás, tehát szintén ingyen; a `focus_change`
  // viszont kétirányú: hosszabbítani ingyen, rövidíteni próbatétellel.
  | { id: number; op: 'focus_save'; pack: import('./focus').FocusPack }
  | { id: number; op: 'focus_delete'; packId: string }
  | { id: number; op: 'focus_start'; packId: string; minutes: number }
  | { id: number; op: 'focus_change'; endsAt: number | null };

/** One recorded slice of active time, as measured by the user-session tracker. */
export interface UsageSampleMsg {
  key: string;
  label: string;
  seconds: number;
  /** epoch ms the slice ended at (decides which day it lands in) */
  at: number;
}

export interface UsageStatsData {
  summary: import('./usage').UsageSummary;
  /** 30-day daily series for the focused target (or the busiest one) */
  focusKey: string | null;
  focusLabel: string;
  focusSeries: { day: string; seconds: number }[];
  /**
   * A munkamenetek összegzése — ma és a héten.
   *
   * Az app eddig azt mérte, MIRE megy el az idő. Ez a másik oldal: hányszor
   * ültél le dolgozni, és hányat vittél végig. A „korán leállítva” az a szám,
   * amiből tanulni lehet — nem szégyenpad, hanem visszajelzés arról, hogy
   * rövidebb menetet kellene indítani.
   */
  focusToday: import('./focus').FocusSummary;
  focusWeek: import('./focus').FocusSummary;
  /**
   * Mikor rögzített a segéd UTOLJÁRA mért időt — vagy `null`, ha még soha.
   *
   * A nulla önmagában nem mond semmit: lehet, hogy tényleg nem használtad a
   * gépet, és lehet, hogy a mérés elhasalt. Ez a mező különbözteti meg a
   * kettőt, anélkül hogy naplót kellene olvasni hozzá.
   */
  lastSampleAt: number | null;
}

/** Result of a set_schedule request. */
/** Result of changing a daily budget: applied straight away, or gated. */
export interface SetLimitResult {
  applied: boolean;
  session: SessionInfo | null;
}

export interface SetScheduleResult {
  /** true when applied immediately (tightening); false when a challenge is required */
  applied: boolean;
  /** present when loosening requires completing challenges first */
  session: SessionInfo | null;
}

export interface SubmitResult {
  accepted: boolean;
  /** true when the whole session finished and the effect was applied */
  sessionDone: boolean;
  message?: string;
  session: SessionInfo | null;
}

export type HelperResponse =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string; code?: string };

/**
 * A helper PROTOKOLL-verziója — nem az app verziója.
 *
 * Bumpold, valahányszor új `op` kerül a HelperRequest unióba, vagy egy meglévő
 * válasz alakja változik. A GUI ezt hasonlítja össze azzal, amit a futó helper
 * mond magáról: frissítés után a root démon a következő indításig a RÉGI marad,
 * és egy régi helper az új parancsokat nem ismeri.
 *
 * 0.3.0 — set_alias (fedőnév) és set_hide_list (lista elrejtése), a status
 *         kiegészülve az alias és a hideSiteList mezővel
 * 0.4.0 — fiók és eszközök közti szinkron: sync_* parancsok, a status
 *         kiegészülve a sync mezővel
 * 0.2.0 — set_limit (napi időkeret), a status kiegészülve a keret mezőivel
 * 0.1.0 — első kiadás
 */
export const HELPER_VERSION = '0.4.0';
export const PAUSE_CHOICES_MIN = [15, 30, 60];
