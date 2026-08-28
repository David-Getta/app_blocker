// Breaker GUI logic. Pure view layer: every decision (challenge content,
// validation, timing) is made by the privileged helper; this file only renders
// and forwards answers.

import type {
  SessionInfo, SiteInfo, StatusData, StepDisplay, SubmitResult, SetScheduleResult,
} from '../shared/protocol';
// Explicit .js so the browser's native ESM loader resolves it at runtime
// (TypeScript's bundler resolution does not rewrite the specifier).
import { PRESET_BANDS, type Schedule, type ScheduleMode } from '../shared/schedule.js';
import { formatDuration } from '../shared/usage.js';
import {
  displayName, displayNameNow, isAliased, MAX_ALIAS_LENGTH, REVEAL_MS,
} from '../shared/alias.js';
import { HELPER_VERSION } from '../shared/protocol.js';
// A .js itt sem elhagyható: a böngésző natív ESM-betöltője oldja fel futásidőben.
import { normalizeRule, ruleLabel } from '../shared/urlrules.js';
import { MAX_LIMIT_MINUTES } from '../shared/limits.js';
import {
  formatRemaining, MAX_ALLOW_ENTRIES, MAX_PACK_NAME, MAX_SESSION_MINUTES,
  SESSION_CHOICES_MIN, type FocusPack,
} from '../shared/focus.js';
import {
  encodePairingCode, formatPairingCode, resolveServerInput,
} from '../shared/sync/pairing.js';
import {
  channelKeyFromPath, channelVerdict, contentIdOf, hostMatchesFilter,
  normalizeChannelEntry, normalizeFilterHost,
} from '../shared/channels.js';
import type {
  SetLimitResult, SetRuleResult, SyncCombinedInfo, SyncDeviceInfo, UsageStatsData,
} from '../shared/protocol';

interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'unsupported';
  version?: string;
  percent?: number;
  error?: string;
  /** the app applies the update itself (unsigned macOS build) */
  selfManaged?: boolean;
}
interface SyncServerState {
  running: boolean;
  /** amit a másik eszközbe be kell írni */
  url?: string;
  /** ugyanez a saját gépről nézve (127.0.0.1) — a Wi-Fi váltásával sem változik */
  localUrl?: string;
  dataDir?: string;
  error?: string;
}
/** A böngésző-bővítménynek szóló helyi híd (lásd main/rules-bridge.ts). */
interface RulesBridgeInfo {
  running: boolean;
  port?: number;
  token?: string;
  /** mikor húzta le a bővítmény utoljára a szabályokat (0 = még soha) */
  lastPullAt?: number;
  error?: string;
}
interface Bridge {
  call(op: string, payload?: Record<string, unknown>): Promise<
    { ok: true; data: unknown } | { ok: false; error: string; code?: string }>;
  install(): Promise<{ ok: true } | { ok: false; error: string }>;
  checkUpdate(): Promise<{ ok: boolean; error?: string }>;
  installUpdate(): Promise<{ ok: boolean; opened?: boolean }>;
  getUpdateState(): Promise<UpdateState>;
  getTrackerState(): Promise<{
    blocked: boolean; neverWorked: boolean; samplesDropped: boolean; platform: string;
  }>;
  getSyncServer(): Promise<SyncServerState>;
  getBridgeInfo(): Promise<RulesBridgeInfo>;
  startSyncServer(): Promise<SyncServerState>;
  stopSyncServer(): Promise<SyncServerState>;
  onUpdateState(cb: (s: UpdateState) => void): void;
  platform: string;
}
declare global { interface Window { breaker: Bridge } }

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

class CallError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}

async function call<T>(op: string, payload?: Record<string, unknown>): Promise<T> {
  const r = await window.breaker.call(op, payload);
  if (!r.ok) throw new CallError(r.error, r.code);
  return r.data as T;
}

// ------------------------------------------------------------------- state

let status: StatusData | null = null;
let helperUp = false;
let modalOpen = false;
let renderedStepId: string | null = null;
let pendingPauseSiteId: string | null = null;
let stepTimers: ReturnType<typeof setInterval>[] = [];
let notifiedStepId: string | null = null;

function clearStepTimers(): void {
  for (const t of stepTimers) clearInterval(t);
  stepTimers = [];
}

// -------------------------------------------------------------- formatting

function fmtRemain(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hrs = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (hrs > 0) return `${hrs} ó ${String(min).padStart(2, '0')} p`;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function fmtClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Melyik oldal valódi címe látszik MOST, és meddig.
 *
 * Modulszintű, mert a lista kétmásodpercenként újraépül: ha a felfedést a DOM
 * tárolná, a következő frissítés eltüntetné. Nem a segédben tároljuk, mert ez
 * nem védelmi állapot — a hosts fájlban ott a cím, ez inger-eltávolítás.
 */
const revealedUntil = new Map<string, number>();

/**
 * Nyitva van-e MOST a lista, ha egyébként rejtettre van állítva.
 *
 * Szándékosan modulszintű és NEM tárolt: a beállítás „rejtve induljon” értelmű,
 * a megnyitás pedig csak erre a munkamenetre szól. Így az app
 * következő indítása megint nem szembesít azzal, mi van blokkolva — miközben
 * aki most tényleg dolgozni akar a listával, egy kattintással hozzáfér.
 */
let listOpenThisSession = false;

/**
 * Rejtve van-e MOST a blokkolt oldalak listája.
 *
 * Ezt az egy kérdést az ablak TÖBB pontja is felteszi — a lista, a
 * gyorsgombok és a statisztika címkéi is. Ha bármelyik kimaradna, a rejtés
 * annyit érne, mint egy lyukas zsák: elég egyetlen hely, ahol ott a cím.
 */
function isListHidden(st: StatusData): boolean {
  return st.hideSiteList === true && !listOpenThisSession;
}

/**
 * A statisztika a saját, ritkább körén frissül — de a CÍMKÉI az oldallistából
 * jönnek (fedőnév, „blokkolt” jelölés). Ha az oldallista változik, a diagram
 * fél percig a régit mutatná: fedőnév beállítása után ott maradna a valódi cím.
 * Ezt a füstteszt fogta meg, nem én.
 *
 * Ezért eltesszük a lista lenyomatát, és ha változik, azonnal újrarajzoljuk a
 * statisztikát. Sztring-összevetés kétmásodpercenként — ingyen van.
 */
let siteSignature = '';
function sitesFingerprint(st: StatusData): string {
  // A rejtés is bele tartozik: rejtett listánál a statisztika címkéi mások.
  // Nélküle a rejtés bekapcsolása után a diagramon még fél percig ott állt a
  // cím — ugyanaz a hiba, mint a fedőnévnél, ugyanaz a teszt fogta meg.
  return `${isListHidden(st) ? 'H' : '-'}|`
    + st.sites.map((x) => `${x.id}:${x.domain}:${x.alias ?? ''}`).join('|');
}

// ------------------------------------------------------------ status poll

let failStreak = 0;
let everConnected = false;

async function refresh(): Promise<void> {
  try {
    status = await call<StatusData>('status');
    helperUp = true;
    everConnected = true;
    failStreak = 0;
    // First successful connection: pull statistics right away rather than
    // waiting for the slow periodic refresh.
    if (!statsData) void refreshStats();
    // A mérés-állapot két logikai értéke; a fő folyamatból jön, olcsó. Azért
    // itt és nem a 30 másodperces statisztika-körben: ha a felhasználó most
    // adta meg az engedélyt, a figyelmeztetés pár másodpercen belül tűnjön el.
    trackerState = await Promise.resolve()
      .then(() => window.breaker.getTrackerState())
      .catch(() => trackerState);
  } catch {
    // One flaky poll must not tear the UI down (or close a challenge modal
    // mid-typing) — only flip to "down" after repeated failures.
    failStreak += 1;
    if (failStreak >= 2) {
      helperUp = false;
      status = null;
    }
  }
  render();
}

// ---------------------------------------------------------------- render

function render(): void {
  const pill = $('statusPill');
  if (!helperUp) {
    if (failStreak < 2) {
      pill.textContent = 'Kapcsolódás…';
    } else {
      pill.textContent = everConnected ? 'Újracsatlakozás a védelemhez…' : 'A védelem nincs telepítve';
    }
    pill.className = 'pill pill-warn';
  } else {
    const n = status!.sites.length;
    pill.textContent = n > 0 ? `Védelem aktív — ${n} oldal blokkolva` : 'Védelem aktív';
    pill.className = 'pill pill-ok';
  }

  const showInstall = !helperUp && failStreak >= 2 && !everConnected;
  $('installCard').classList.toggle('hidden', !showInstall);
  $('addCard').classList.toggle('hidden', !helperUp);
  $('listCard').classList.toggle('hidden', !helperUp);
  $('channelCard').classList.toggle('hidden', !helperUp);
  $('tierLine').classList.toggle('hidden', !helperUp);

  if (!helperUp) {
    // Keep an open challenge modal alive: the session (and the user's typed
    // answer) survives a helper restart, closing it would throw work away.
    return;
  }

  const sig = sitesFingerprint(status!);
  if (sig !== siteSignature) {
    siteSignature = sig;
    if (statsData) renderStats();
  }

  renderAddCard(status!);
  renderChannelCard(status!);
  renderFocusPill(status!);
  renderFocusCard(status!);
  renderSyncCard(status!);
  renderSiteList(status!);
  renderTier(status!);
  renderLegacyHelperBanner(status!);
  renderHelperStaleBanner(status!);
  renderProbeWarning(status!.usageEnabled);
  renderResumeBanner(status!);
  if (modalOpen) renderSession(status!.session);
}

// ------------------------------------------------------------------ nézetek
//
// Eddig minden EGYMÁS ALATT volt egyetlen hosszú lapon: a fiókhoz a képernyő
// aljáig kellett tekerni. A fülekkel egyszerre EGY dolog van a képernyőn.
//
// A választás a MUNKAMENETRE szól, nem tartósan: az app mindig az „Oldalak”
// nézettel nyílik. Ez szándékos — a blokklista az, amiért az app van, és nem
// akarjuk, hogy egy múltkori kattintás miatt a statisztika fogadjon.

type ViewName = 'sites' | 'focus' | 'stats';
let currentView: ViewName = 'sites';

function setView(view: ViewName): void {
  currentView = view;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('.view'))) {
    el.classList.toggle('hidden', el.dataset.view !== view);
  }
  for (const tab of Array.from(document.querySelectorAll<HTMLElement>('.tab'))) {
    if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  // A statisztika csak akkor kér adatot, amikor tényleg nézik: enélkül minden
  // indításkor lefutna egy olyan lekérdezés, aminek az eredményét senki nem
  // látja.
  if (view === 'stats') void refreshStats();
  window.scrollTo({ top: 0 });
}

// ------------------------------------------------------------------ panelek

function openDrawer(panel: string, scrim: string): void {
  $(panel).classList.remove('hidden');
  $(scrim).classList.remove('hidden');
}

function closeDrawer(panel: string, scrim: string): void {
  $(panel).classList.add('hidden');
  $(scrim).classList.add('hidden');
}

// ------------------------------------------------------------------ kinézet
//
// A háttér ízlés dolga, és pont ezért állítható. A választás a GÉPEN marad
// (localStorage): ez felületi beállítás, semmi köze a blokkoláshoz — a segéd
// root-védett állapotában nincs helye.

const BG_KEY = 'breaker.bg';
const MOTION_KEY = 'breaker.bg.motion';

interface BgChoice { id: string; name: string; swatch: string }

const BG_CHOICES: BgChoice[] = [
  {
    id: 'nyugalom',
    name: 'Nyugalom',
    swatch: 'radial-gradient(120% 100% at 10% 100%, #1d3a6b 0%, transparent 60%), #0f1216',
  },
  {
    id: 'aurora',
    name: 'Aurora',
    swatch: 'radial-gradient(90% 90% at 15% 100%, #1d3a6b 0%, transparent 55%),'
      + ' radial-gradient(80% 80% at 90% 0%, #16514f 0%, transparent 55%), #0f1216',
  },
  { id: 'racs', name: 'Rács', swatch: 'linear-gradient(#191c21 1px, transparent 1px) 0 0 / 12px 12px, #0f1216' },
  { id: 'tiszta', name: 'Tiszta', swatch: '#0f1216' },
];

function readPref(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    // Privát mód vagy letiltott tároló: a kinézet ettől még működjön.
    return fallback;
  }
}

function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch { /* a beállítás elvesztése nem ér annyit, hogy elhasaljon tőle a felület */ }
}

function applyBackground(): void {
  const bg = readPref(BG_KEY, 'nyugalom');
  const motion = readPref(MOTION_KEY, 'on');
  document.body.dataset.bg = BG_CHOICES.some((c) => c.id === bg) ? bg : 'nyugalom';
  document.body.dataset.motion = motion === 'off' ? 'off' : 'on';
  const box = $('bgChoices');
  if (box.childElementCount === 0) {
    for (const choice of BG_CHOICES) {
      const b = h('button', 'bg-choice');
      b.dataset.bg = choice.id;
      const sw = h('span', 'swatch');
      sw.style.background = choice.swatch;
      b.appendChild(sw);
      b.appendChild(h('span', 'label', choice.name));
      b.addEventListener('click', () => {
        writePref(BG_KEY, choice.id);
        applyBackground();
      });
      box.appendChild(b);
    }
  }
  for (const b of Array.from(box.children) as HTMLElement[]) {
    b.setAttribute('aria-pressed', String(b.dataset.bg === document.body.dataset.bg));
  }
  ($('bgMotion') as HTMLInputElement).checked = document.body.dataset.motion === 'on';
}

// -------------------------------------------------------------- munkamenetek
//
// A blokklista feketelista: mi NE menjen. A munkamenet fehérlista: most CSAK ez
// mehet. A kettő együtt él — a munkamenet sosem old fel semmit, amit a
// blokklista tilt, csak hozzátesz.

/** Hány perccel lehet egy kattintással hosszabbítani. */
const FOCUS_EXTEND_MIN = [15, 30, 60];

/**
 * A futó munkamenet jelzése a felső sorban.
 *
 * A munkamenet FEHÉRLISTA: amíg megy, minden más tiltva. Ha ez csak a
 * Munkamenetek fülön látszik, akkor a másik két nézetből úgy tűnik, mintha az
 * app nem csinálna semmit — és a felhasználó a hibát fogja keresni, nem a
 * munkamenetet. Ezért a jelzés minden nézetben ott van, és rákattintva
 * odalép.
 */
function renderFocusPill(st: StatusData): void {
  const pill = $('focusPill');
  const run = st.focusRun && st.focusRun.endsAt > Date.now() ? st.focusRun : null;
  pill.classList.toggle('hidden', !run);
  if (!run) return;
  const pack = (st.focusPacks ?? []).find((p) => p.id === run.packId);
  const left = formatRemaining(run.endsAt - Date.now());
  $('focusPillText').textContent = `${pack?.name ?? 'Munkamenet'} · ${left}`;
  pill.title = `Fut egy munkamenet — ${left} van hátra. Amíg tart, csak a csomagban felsoroltak mehetnek.`;
}

/**
 * A hosszabbítás-mezőbe gépelt szám, két újrarajzolás között.
 *
 * A futó munkamenet doboza MÁSODPERCENKÉNT újraépül (a hátralévő idő nem
 * állhat meg), és ezzel a benne lévő mező is elveszne: a felhasználó beírná a
 * 4-est, és mire a 3-at leütné, a mező már üres lenne. A gépelt érték ezért
 * NEM a mezőben lakik, hanem itt.
 */
let focusExtendDraft = '';

/**
 * Szól, ha a munkamenet fehérlistáját ITT nem érvényesíti senki.
 *
 * A gépen a fehérlistát KIZÁRÓLAG a böngésző-bővítmény tudja betartatni: a
 * DNS a hosztnévnél tovább nem lát, és „mindent tilts, kivéve ötöt” egy
 * hosts-fájlban nem leírható. Ha a bővítmény nincs összekötve, a munkamenet
 * indítása CSENDBEN nem tilt semmit a böngészőben — a felhasználó azt hinné,
 * fókuszban van, közben minden nyitva.
 *
 * Ugyanaz a hibafajta, mint a telefonon a kikapcsolt védelem: az app olyasmit
 * ígér, amit épp nem tud betartani.
 */
function renderFocusExtensionWarning(): void {
  const box = $('focusExtWarn');
  void window.breaker.getBridgeInfo().then((info) => {
    // A bővítmény húsz másodpercenként kérdez; két percnél régebbi lehúzás azt
    // jelenti, hogy nincs ott. A híd FUTÁSA önmagában nem elég bizonyíték.
    const fresh = !!info.lastPullAt && Date.now() - info.lastPullAt < 2 * 60_000;
    box.classList.toggle('hidden', fresh);
    if (fresh) return;
    box.textContent = info.lastPullAt
      ? 'A böngésző-bővítmény egy ideje nem jelentkezett. A munkamenet '
        + 'fehérlistáját a gépen ő érvényesíti — amíg nincs ott, a böngészőben '
        + 'nem tilt semmit.'
      : 'A böngésző-bővítmény nincs összekötve. A munkamenet fehérlistáját a '
        + 'gépen KIZÁRÓLAG ő tudja betartatni — enélkül az indítás a '
        + 'böngészőben nem tilt semmit. A blokklista attól még él.';
  }).catch(() => { /* a kártya enélkül is használható */ });
}

function renderFocusCard(st: StatusData): void {
  // A RÉGEBBI háttérszolgáltatás ezt a két mezőt nem küldi. Ha itt elhasalnánk,
  // a felület egésze üresen maradna — az egyetlen ok pedig egy hiányzó mező
  // lenne, amiről semmi nem szólna. A frissítést a felület külön sávban kéri.
  const packs = st.focusPacks ?? [];
  $('focusCard').classList.remove('hidden');
  const running = st.focusRun && st.focusRun.endsAt > Date.now() ? st.focusRun : null;
  const runBox = $('focusRunning');
  // A fókuszt is vissza kell adni: ha a felhasználó épp a mezőben áll, az
  // újraépítés kirakná belőle, és a következő leütés a semmibe menne.
  // Csak a MEZŐRE szól: ha a felhasználó egy gombra kattintott, a fókusz ne
  // ugorjon át tőle a mezőbe.
  const active = document.activeElement;
  const hadFocus = active instanceof HTMLInputElement && runBox.contains(active);
  runBox.textContent = '';
  runBox.classList.toggle('hidden', !running);

  renderFocusExtensionWarning();
  $('focusHint').textContent = running
    ? 'Amíg tart, csak a csomagban felsoroltak mehetnek. Minden más tiltva.'
    : 'Egy csomag megmondja, mi mehet — és a munkamenet alatt minden más tiltva. '
      + `A réteg ${overlayShortcutLabel()} kombinációval bárhonnan előjön.`;

  if (running) {
    const pack = packs.find((p) => p.id === running.packId);
    runBox.appendChild(h('div', 'micro', 'Most fut'));
    runBox.appendChild(h('div', 'focus-left', formatRemaining(running.endsAt - Date.now())));
    // A hátralévő idő mellett a VÉGE is kiírva. „Még 1 ó 12 p” önmagában
    // fejszámolás; a felhasználó viszont órában gondolkodik: addig, amíg el
    // nem kell indulnia.
    runBox.appendChild(h('div', 'micro',
      `eddig: ${new Date(running.endsAt).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })}`));
    runBox.appendChild(h('div', 'hint',
      pack ? `${pack.name} — mehet: ${[...pack.allowSites, ...pack.allowApps].join(', ') || 'semmi'}`
        : 'Ismeretlen csomag.'));
    const actions = h('div', 'focus-actions');
    for (const min of FOCUS_EXTEND_MIN) {
      const b = h('button', 'btn btn-small', `+${min} perc`);
      b.addEventListener('click', () => void changeFocus(running.endsAt + min * 60_000));
      actions.appendChild(b);
    }
    // Percre pontos hosszabbítás. A hosszabbítás SZIGORÍTÁS — tovább tart a
    // munkamenet —, ezért ingyen van, és nyugodtan lehet szabad mező.
    const more = h('input', 'alias-input minute-field') as HTMLInputElement;
    more.type = 'number';
    more.min = '1';
    more.max = String(MAX_SESSION_MINUTES);
    more.step = '1';
    more.placeholder = 'perc';
    more.setAttribute('aria-label', 'hosszabbítás percben');
    more.value = focusExtendDraft;
    more.addEventListener('input', () => { focusExtendDraft = more.value; });
    const addBtn = h('button', 'btn btn-small', 'Hozzáad');
    const addMore = (): void => {
      const n = Number(more.value);
      if (!Number.isFinite(n) || n < 1) {
        $('focusHint').textContent = `Írd be percben, mennyivel hosszabbítanád (1–${MAX_SESSION_MINUTES}).`;
        return;
      }
      const add = Math.min(Math.round(n), MAX_SESSION_MINUTES);
      focusExtendDraft = '';
      void changeFocus(running.endsAt + add * 60_000);
    };
    addBtn.addEventListener('click', addMore);
    more.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') addMore();
    });
    actions.append(more, addBtn);
    const stop = h('button', 'btn btn-small btn-danger', 'Leállítás…');
    stop.title = 'A leállítás próbatétel — ugyanúgy, mint egy feloldás.';
    stop.addEventListener('click', () => void changeFocus(null));
    actions.appendChild(stop);
    runBox.appendChild(actions);
    // A `setSelectionRange` itt NEM használható: számmezőn kivételt dob
    // ("does not support selection"). Nem is kell: az érték már be van írva, és
    // a fókusz a szám végére áll.
    if (hadFocus) more.focus();
  }

  const list = $('focusPacks');
  list.textContent = '';
  if (packs.length === 0) {
    list.appendChild(h('p', 'hint',
      'Még nincs csomagod. Egy csomag: egy név, és a lista arról, mi mehet alatta '
      + '— például „Nyelvtanulás”, és benne a szótár meg a jegyzetfüzet.'));
    return;
  }
  for (const pack of packs) {
    const isRunning = running?.packId === pack.id;
    const row = h('div', `focus-pack${isRunning ? ' focus-pack-on' : ''}`);
    const left = h('div');
    // A jelölés a név MELLÉ kerül, nem BELÉ: a `.focus-name` maradjon pontosan
    // a csomag neve — különben a név „Nyelvtanulásfut” lesz mindenkinek, aki
    // kiolvassa (képernyőolvasó, teszt, másolás).
    const nameRow = h('div', 'focus-name-row');
    nameRow.appendChild(h('div', 'focus-name', pack.name));
    // Melyik csomag fut: eddig csak a doboz tetején állt a neve, a listában
    // semmi nem jelezte. Két hasonló nevű csomagnál ez tényleges tévedés.
    if (isRunning) nameRow.appendChild(h('span', 'tag', 'fut'));
    left.appendChild(nameRow);
    const items = [...pack.allowSites, ...pack.allowApps];
    left.appendChild(h('div', 'focus-sub',
      items.length ? items.join(', ') : 'nincs engedélyezett tétel — minden tiltva'));
    row.appendChild(left);

    const actions = h('div', 'row-gap');
    if (!running) {
      const startBtn = h('button', 'btn btn-small btn-primary', 'Indítás');
      startBtn.addEventListener('click', () => openFocusStartDialog(pack));
      actions.appendChild(startBtn);
    }
    const edit = h('button', 'btn btn-small', 'Szerkesztés') as HTMLButtonElement;
    if (isRunning) {
      // A segéd a futó csomag mentését visszautasítja — enélkül a felület
      // felkínálna egy szerkesztőt, amiből a Mentés mindig hibára fut. Itt
      // mondjuk meg előre, MIÉRT nem megy.
      edit.disabled = true;
      edit.title = 'A futó csomag befagy: amíg megy a munkamenet, nem szerkeszthető. '
        + 'Enélkül menet közben hozzá lehetne adni bármit a fehérlistához.';
    } else {
      edit.addEventListener('click', () => openFocusEditor(pack));
    }
    actions.appendChild(edit);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function overlayShortcutLabel(): string {
  return window.breaker.platform === 'darwin' ? '⌘⌥B' : 'Ctrl+Alt+B';
}

async function changeFocus(endsAt: number | null): Promise<void> {
  try {
    const r = await call<{ applied: boolean; session: SessionInfo | null; status: StatusData }>(
      'focus_change', { endsAt },
    );
    status = r.status;
    if (r.session) openModal(r.session);
    render();
  } catch (e) {
    $('focusHint').textContent = (e as Error).message;
  }
}

/**
 * Perc-választó: gyorsgombok ÉS egy szabad mező.
 *
 * A gyorsgombok a gyakori eseteket adják egy kattintással, a mező viszont
 * nélkülözhetetlen: „huszonöt perc” nem mindenkinek huszonöt perc. Aki
 * negyvenhárom percet akar, mert annyi van ebédig, az eddig kénytelen volt
 * fölé vagy alá lőni — és egy önkontroll-appnál a „nagyjából annyi” pont a
 * rossz irány.
 *
 * @returns a doboz, és egy függvény, ami a PILLANATNYI értéket adja vissza.
 */
function minutePicker(
  choices: number[], initial: number, max: number, onPick?: () => void,
): { box: HTMLElement; value: () => number | null } {
  let chosen: number | null = initial;
  const box = h('div');
  const row = h('div', 'chips');
  const field = h('input', 'alias-input minute-field') as HTMLInputElement;

  const paint = (): void => {
    for (const el of Array.from(row.children)) {
      el.classList.toggle('chip-on', Number((el as HTMLElement).dataset.min) === chosen);
    }
  };
  for (const min of choices) {
    const b = h('button', 'chip', `${min} perc`);
    (b as HTMLElement).dataset.min = String(min);
    b.addEventListener('click', () => {
      chosen = min;
      field.value = String(min);
      paint();
      onPick?.();
    });
    row.appendChild(b);
  }
  box.appendChild(row);

  field.type = 'number';
  field.min = '1';
  field.max = String(max);
  field.step = '1';
  field.value = String(initial);
  field.setAttribute('aria-label', 'hossz percben');
  field.addEventListener('input', () => {
    const n = Number(field.value);
    chosen = Number.isFinite(n) && n >= 1 ? Math.min(Math.round(n), max) : null;
    paint();
    onPick?.();
  });
  const line = h('div', 'minute-row');
  line.appendChild(field);
  line.appendChild(h('span', 'hint', `perc (1–${max})`));
  box.appendChild(line);
  paint();

  return { box, value: () => chosen };
}

/** Indítás: csak a hossz kell hozzá. Indítani ingyen van — ez a szigorítás iránya. */
function openFocusStartDialog(pack: FocusPack): void {
  const overlay = h('div', 'overlay');
  const modal = h('div', 'modal modal-small');
  modal.appendChild(h('h3', undefined, pack.name));
  modal.appendChild(h('p', 'hint',
    'Meddig tartson? Hosszabbítani közben ingyen lehet; leállítani viszont '
    + 'ugyanabba a próbatételbe kerül, mint egy feloldás.'));
  const picker = minutePicker(SESSION_CHOICES_MIN, pack.defaultMinutes, MAX_SESSION_MINUTES);
  modal.appendChild(picker.box);

  const err = h('p', 'error hidden');
  modal.appendChild(err);
  const actions = h('div', 'modal-actions');
  const cancel = h('button', 'btn btn-small btn-ghost', 'Mégse');
  cancel.addEventListener('click', () => overlay.remove());
  const go = h('button', 'btn btn-small btn-primary', 'Indítás');
  go.addEventListener('click', () => void (async () => {
    const chosen = picker.value();
    if (chosen === null) {
      // Megmondjuk, mit várunk. Egy néma gomb itt azt jelentené, hogy a
      // felhasználó a mezőt nézi, és nem érti, miért nem indul semmi.
      err.textContent = `Írj be egy hosszat percben (1–${MAX_SESSION_MINUTES}).`;
      err.classList.remove('hidden');
      return;
    }
    try {
      status = await call<StatusData>('focus_start', { packId: pack.id, minutes: chosen });
      overlay.remove();
      render();
    } catch (e) {
      err.textContent = (e as Error).message;
      err.classList.remove('hidden');
    }
  })());
  const right = h('div', 'row-gap');
  right.append(cancel, go);
  actions.append(h('div', 'row-gap'), right);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

/**
 * A csomag szerkesztője.
 *
 * Szabadon szerkeszthető — DE nem az, amelyik épp fut. A futó csomag befagy:
 * enélkül a fehérlistához menet közben hozzá lehetne adni bármit, és a
 * munkamenet önmagát oldaná fel, csendben.
 */
function openFocusEditor(pack: FocusPack | null): void {
  const overlay = h('div', 'overlay');
  const modal = h('div', 'modal');
  modal.appendChild(h('h3', undefined, pack ? 'Csomag szerkesztése' : 'Új csomag'));
  modal.appendChild(h('p', 'hint',
    'A csomag FEHÉRLISTA: ami nincs rajta, az a munkamenet alatt tiltva. Ezért '
    + 'nem kell felsorolni, mi zavar — csak azt, ami kell.'));

  const box = h('div', 'focus-editor');
  const name = h('input', 'alias-input') as HTMLInputElement;
  name.type = 'text';
  name.placeholder = 'pl. Nyelvtanulás';
  name.value = pack?.name ?? '';
  // A segéd a nevet ennyinél levágja. Ha itt nem lenne korlát, a felhasználó
  // beírna egy hosszú nevet, és mentés után egy MÁSIK nevet kapna vissza,
  // magyarázat nélkül.
  name.maxLength = MAX_PACK_NAME;
  box.appendChild(h('label', undefined, 'A csomag neve'));
  box.appendChild(name);

  const lines = (t: string): string[] =>
    t.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

  /** Számláló a mező alatt: a segéd a fölösleget csendben eldobná. */
  const counter = (field: HTMLTextAreaElement): HTMLElement => {
    const out = h('div', 'micro count');
    const paint = (): void => {
      const n = lines(field.value).length;
      out.textContent = `${n} / ${MAX_ALLOW_ENTRIES} tétel`;
      out.classList.toggle('over', n > MAX_ALLOW_ENTRIES);
      if (n > MAX_ALLOW_ENTRIES) {
        out.textContent = `${n} / ${MAX_ALLOW_ENTRIES} tétel — az első ${MAX_ALLOW_ENTRIES} marad meg`;
      }
    };
    field.addEventListener('input', paint);
    paint();
    return out;
  };

  const sites = h('textarea', 'alias-input') as HTMLTextAreaElement;
  sites.rows = 3;
  sites.placeholder = 'egy soronként, pl. translate.google.com';
  sites.value = (pack?.allowSites ?? []).join('\n');
  box.appendChild(h('label', undefined, 'Engedélyezett oldalak (a böngészőben ez él)'));
  box.appendChild(sites);
  box.appendChild(counter(sites));

  const apps = h('textarea', 'alias-input') as HTMLTextAreaElement;
  apps.rows = 3;
  apps.placeholder = 'egy soronként, pl. Word';
  apps.value = (pack?.allowApps ?? []).join('\n');
  box.appendChild(h('label', undefined, 'Engedélyezett appok'));
  box.appendChild(apps);
  box.appendChild(counter(apps));

  // Ez eddig fixen 50 perc volt, és sehol nem lehetett átállítani: a csomag
  // „szokásos hossza” egy olyan beállítás volt, amit a felhasználó nem ért el.
  const lengthPicker = minutePicker(
    SESSION_CHOICES_MIN, pack?.defaultMinutes ?? 50, MAX_SESSION_MINUTES,
  );
  box.appendChild(h('label', undefined, 'Szokásos hossz (indításkor ezt kínáljuk fel)'));
  box.appendChild(lengthPicker.box);
  modal.appendChild(box);

  modal.appendChild(h('p', 'hint',
    'Az oldalakat a böngésző-bővítmény érvényesíti — ott látszik a teljes cím. '
    + 'Az appoknál a mérés látja, mi van előtérben, és a felület figyelmeztet; '
    + 'bezárni egy appot nem tudunk, és nem is állítjuk, hogy tudunk.'));

  const err = h('p', 'error hidden');
  modal.appendChild(err);

  const actions = h('div', 'modal-actions');
  const left = h('div', 'row-gap');
  if (pack) {
    // Kétlépcsős törlés. Egy gondosan összerakott fehérlista egyetlen
    // félrekattintással ne tűnjön el: az ELSŐ kattintás csak megkérdez.
    const del = h('button', 'btn btn-small btn-danger', 'Törlés');
    let armed = false;
    del.addEventListener('click', () => void (async () => {
      if (!armed) {
        armed = true;
        del.textContent = 'Biztos? Törlés';
        del.title = 'A csomag és a benne felsorolt tételek törlődnek.';
        return;
      }
      try {
        status = await call<StatusData>('focus_delete', { packId: pack.id });
        overlay.remove();
        render();
      } catch (e) {
        err.textContent = (e as Error).message;
        err.classList.remove('hidden');
        armed = false;
        del.textContent = 'Törlés';
      }
    })());
    left.appendChild(del);
  }
  const cancel = h('button', 'btn btn-small btn-ghost', 'Mégse');
  cancel.addEventListener('click', () => overlay.remove());
  const save = h('button', 'btn btn-small btn-primary', 'Mentés');
  save.addEventListener('click', () => void (async () => {
    try {
      status = await call<StatusData>('focus_save', {
        pack: {
          id: pack?.id ?? '',
          name: name.value,
          allowSites: lines(sites.value),
          allowApps: lines(apps.value),
          defaultMinutes: lengthPicker.value() ?? pack?.defaultMinutes ?? 50,
        },
      });
      overlay.remove();
      render();
    } catch (e) {
      err.textContent = (e as Error).message;
      err.classList.remove('hidden');
    }
  })());
  const right = h('div', 'row-gap');
  right.append(cancel, save);
  actions.append(left, right);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  name.focus();
}

// ------------------------------------------------------------------ szinkron

/**
 * A fiókkártya.
 *
 * A felület SEMMIT nem tud a kulcsokról: a jelszót átadja a segédnek, és onnan
 * már csak annyi jön vissza, ami kiírható. Az adatkulcs a segéd root-védett
 * állapotában marad — ott, ahol a blokklista is.
 */
function renderSyncCard(st: StatusData): void {
  $('syncCard').classList.remove('hidden');
  const on = !!st.sync;
  // A sarokikonból látszik, hogy be vagy-e lépve: a fiókazonosító kezdőbetűje
  // áll benne. Enélkül a panelt ki kellene nyitni ahhoz, hogy megtudd.
  $('accountBtn').classList.toggle('signed-in', on);
  $('accountGlyph').classList.toggle('hidden', on);
  $('accountInitial').classList.toggle('hidden', !on);
  $('accountInitial').textContent = (st.sync?.accountId ?? '').trim().charAt(0).toUpperCase() || '·';
  $('accountBtn').title = on ? `Fiók: ${st.sync?.accountId}` : 'Fiók és eszközök';
  $('syncSignedOut').classList.toggle('hidden', on);
  $('syncSignedIn').classList.toggle('hidden', !on);
  $('syncNowBtn').classList.toggle('hidden', !on);
  if (!st.sync) return;
  $('syncWho').textContent = `${st.sync.accountId} — ez az eszköz: ${st.sync.deviceName}`;
  // Hiba esetén a SIKERES szinkron és az utolsó PRÓBÁLKOZÁS külön áll.
  //
  // Egyetlen időbélyeg itt félrevezet: aki egy tíz órával korábbi szinkron-időt
  // lát egy hibaüzenet mellett, azt hiszi, az app délben feladta.
  // Pedig tíz percenként újrapróbálja — csak semmi nem mutatta. A friss
  // próbálkozás-idő ezt mondja ki; és ha AZ is órákkal ezelőtti, akkor
  // tényleg leállt a kör, ami viszont valódi hiba, és így végre látszik.
  const clock = (t: number): string => new Date(t).toLocaleTimeString('hu-HU');
  const ok = st.sync.lastSyncAt
    ? `Legutóbbi sikeres szinkron: ${clock(st.sync.lastSyncAt)}`
    : 'Még nem volt sikeres szinkron.';
  if (!st.sync.lastError) {
    $('syncState').textContent = st.sync.lastSyncAt
      ? `Legutóbbi szinkron: ${clock(st.sync.lastSyncAt)}`
      : 'Még nem volt szinkron.';
  } else {
    const tried = st.sync.lastAttemptAt
      ? ` · Utolsó próbálkozás: ${clock(st.sync.lastAttemptAt)}`
      : '';
    $('syncState').textContent = `${ok}${tried} · Hiba: ${st.sync.lastError}`;
  }
  // Két külön eredetű baj, egy hely: mindkettő arról szól, hogy valami nem ér
  // át a többi eszközre — és mindkettő némán maradna, ha nem írnánk ki.
  const syncWarn = [st.focusSyncError, st.channelsSyncError].filter(Boolean).join(' ');
  $('syncFocusError').textContent = syncWarn;
  $('syncFocusError').classList.toggle('hidden', !syncWarn);
}

/** A gombok köré ugyanaz a burok: letiltás, felirat, hibakiírás. */
async function withBusy(btn: HTMLButtonElement, label: string, fn: () => Promise<void>): Promise<void> {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  $('syncError').classList.add('hidden');
  try {
    await fn();
  } catch (e) {
    const el = $('syncError');
    el.textContent = (e as Error).message;
    el.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/**
 * A kiszolgáló címe — és ami ennél fontosabb: mikor NEM kell megadni.
 *
 * Eddig kötelező volt begépelni valamit, például `http://192.168.1.10:8787`.
 * Ez az a pont, ahol a funkció meghalt: aki idáig eljutott, ott feladta. Egy
 * technikailag tökéletes szinkron, amit senki nem kapcsol be, nulla értékű.
 *
 * Mostantól az ÜRES mező azt jelenti: „ezen a gépen”. Ha a beépített kiszolgáló
 * még nem fut, elindítjuk — a felhasználónak nem kell tudnia, mi az az IP-cím,
 * és nem is kell megkeresnie a sajátját.
 *
 * Ha írt valamit, az lehet teljes cím VAGY párosító kód; egy mező, kétféle
 * bemenet. Külön mező azt jelentené, hogy előbb el kell dönteni, melyikbe kell
 * írni — pont az a fajta apró döntés, amitől abbahagyják.
 */
async function resolveSyncServer(): Promise<string> {
  const typed = $<HTMLInputElement>('syncServer').value.trim();
  if (typed) {
    const resolved = resolveServerInput(typed);
    if (!resolved) {
      throw new Error(
        'Ez nem tűnik érvényes címnek vagy párosító kódnak. Ha ezen a gépen '
        + 'akarod tartani a fiókot, hagyd üresen a mezőt.',
      );
    }
    return resolved;
  }

  let st = await window.breaker.getSyncServer();
  if (!st.running) st = await window.breaker.startSyncServer();
  // A `listen` aszinkron: a cím egy pillanattal később áll össze. Megvárjuk,
  // mert enélkül az első fiók készítése hibára futna — és a felhasználó azt
  // hinné, hogy nem működik.
  for (let i = 0; i < 20 && !st.localUrl; i++) {
    await new Promise((r) => setTimeout(r, 100));
    st = await window.breaker.getSyncServer();
  }
  if (st.error) throw new Error(st.error);
  if (!st.localUrl) throw new Error('A kiszolgáló nem indult el ezen a gépen.');
  return st.localUrl;
}

async function syncFormValues(): Promise<{ serverUrl: string; accountId: string; password: string }> {
  return {
    serverUrl: await resolveSyncServer(),
    accountId: $<HTMLInputElement>('syncAccount').value.trim(),
    password: $<HTMLInputElement>('syncPassword').value,
  };
}

/**
 * A gépen futó kiszolgáló állapota.
 *
 * A saját cím KIÍRVA áll ott, nem elrejtve: ezt kell a telefonba begépelni, és
 * ha keresgélni kell hozzá, senki nem fogja megtenni.
 */
async function refreshSyncHost(): Promise<void> {
  const st = await window.breaker.getSyncServer();
  const btn = $<HTMLButtonElement>('syncHostBtn');
  const line = $('syncHostState');
  btn.textContent = st.running ? 'Kiszolgáló leállítása' : 'Kiszolgáló indítása ezen a gépen';
  line.classList.toggle('hidden', !st.running && !st.error);
  if (st.error) {
    line.textContent = st.error;
    return;
  }
  if (st.running) {
    if (!st.url) {
      line.textContent = 'Indul…';
      return;
    }
    // A másik eszközre a KÓD megy, nem az IP-cím. Ugyanaz az információ, de öt
    // karakter — és pont ezen a ponton adta fel eddig mindenki.
    const code = encodePairingCode(st.url);
    line.textContent = '';
    if (code) {
      line.appendChild(h('div', undefined, 'Fut. A telefonon ezt a kódot írd be:'));
      line.appendChild(h('div', 'pair-code', formatPairingCode(code)));
      line.appendChild(h('div', 'hint', `Vagy a teljes cím: ${st.url}. Amíg ez az app nem fut, nincs szinkron.`));
    } else {
      line.appendChild(h('div', undefined, `Fut. A másik eszközön ezt írd be: ${st.url}`));
      line.appendChild(h('div', 'hint', 'Amíg ez az app nem fut, nincs szinkron.'));
    }
  }
}

function setupSyncCard(): void {
  const deviceName = () => `${window.breaker.platform === 'win32' ? 'Windows' : 'Mac'} gép`;

  $('syncSignUpBtn').addEventListener('click', () => void withBusy(
    $<HTMLButtonElement>('syncSignUpBtn'), 'Fiók készítése…', async () => {
      const v = await syncFormValues();
      const r = await call<{ recoveryCode: string; status: StatusData }>('sync_signup', {
        ...v, deviceName: deviceName(),
      });
      status = r.status;
      render();
      // A helyreállító kódot EGYSZER látja. Ha elveszti a jelszót ÉS ezt is,
      // a kiszolgáló nem tud segíteni — nem lát bele. Ezért nem sávban
      // villantjuk, hanem megállítjuk vele.
      alert(
        'Írd fel ezt a helyreállító kódot, és tedd el biztos helyre:\n\n'
        + `${r.recoveryCode}\n\n`
        + 'Ha elfelejted a jelszót, EZ az egyetlen út vissza. A kiszolgáló nem '
        + 'tud segíteni, mert nem látja az adataidat.',
      );
    },
  ));

  $('syncSignInBtn').addEventListener('click', () => void withBusy(
    $<HTMLButtonElement>('syncSignInBtn'), 'Belépés…', async () => {
      const r = await call<{ status: StatusData }>('sync_signin', {
        ...(await syncFormValues()), deviceName: deviceName(),
      });
      status = r.status;
      $<HTMLInputElement>('syncPassword').value = '';
      render();
    },
  ));

  $('syncHostBtn').addEventListener('click', () => {
    // A frissítés a `withBusy` UTÁN fut: az visszaállítja a gomb eredeti
    // feliratát, tehát ami belül íródna ki, azt rögtön felül is írná.
    void withBusy($<HTMLButtonElement>('syncHostBtn'), 'Egy pillanat…', async () => {
      const st = await window.breaker.getSyncServer();
      if (st.running) await window.breaker.stopSyncServer();
      else await window.breaker.startSyncServer();
    }).then(() => {
      void refreshSyncHost();
      // A listen aszinkron: a cím egy pillanattal később áll össze.
      setTimeout(() => void refreshSyncHost(), 400);
    });
  });
  void refreshSyncHost();

  $('syncForgotBtn').addEventListener('click', () => {
    // Nem külön képernyő: a kód a meglévő űrlap mellé nyílik ki, mert a
    // kiszolgáló címe és a fiókazonosító ugyanaz marad — csak a jelszó helyett
    // a kód nyit.
    $('syncRecoveryBox').classList.toggle('hidden');
  });

  $('syncRecoverBtn').addEventListener('click', () => void withBusy(
    $<HTMLButtonElement>('syncRecoverBtn'), 'Belépés…', async () => {
      const v = await syncFormValues();
      const r = await call<{ status: StatusData }>('sync_recovery', {
        serverUrl: v.serverUrl,
        accountId: v.accountId,
        recoveryCode: $<HTMLInputElement>('syncRecoveryCode').value,
        // A kóddal belépve RÖGTÖN új jelszót állítunk be: enélkül a fiókba
        // csak a kóddal lehetne visszajutni, és a következő elvesztésnél már
        // semmi nem maradna.
        newPassword: v.password,
        deviceName: deviceName(),
      });
      status = r.status;
      $<HTMLInputElement>('syncPassword').value = '';
      $<HTMLInputElement>('syncRecoveryCode').value = '';
      $('syncRecoveryBox').classList.add('hidden');
      render();
    },
  ));

  $('syncNowBtn').addEventListener('click', () => void withBusy(
    $<HTMLButtonElement>('syncNowBtn'), 'Szinkron…', async () => {
      const r = await call<{ status: StatusData }>('sync_now', {});
      status = r.status;
      render();
    },
  ));

  $('syncSignOutBtn').addEventListener('click', () => void withBusy(
    $<HTMLButtonElement>('syncSignOutBtn'), 'Kilépés…', async () => {
      // Nincs megerősítés: a kijelentkezés nem visz el semmit. Egy „biztos?”
      // itt azt sugallná, hogy veszélyes — pedig pont az a lényeg, hogy nem az.
      status = await call<StatusData>('sync_signout', {});
      render();
    },
  ));

  $('syncDevicesBtn').addEventListener('click', () => void withBusy(
    $<HTMLButtonElement>('syncDevicesBtn'), 'Lekérés…', async () => {
      const r = await call<{ devices: SyncDeviceInfo[]; combined?: SyncCombinedInfo }>(
        'sync_devices', {},
      );
      const host = $('syncDevices');
      host.textContent = '';
      if (r.devices.length === 0) {
        host.appendChild(h('div', 'hint', 'Még nincs másik eszköz ebben a fiókban.'));
        return;
      }
      // Elöl az ÖSSZESÍTETT szám. Ez az, ami tényleg számít: nem az, hogy
      // mennyi ment el a gépen és külön mennyi a telefonon, hanem hogy mennyi
      // összesen. Egy eszköznél nincs mit összesíteni, ott csak zaj lenne.
      if (r.combined && r.combined.deviceCount > 1) {
        const c = r.combined;
        const card = h('div', 'sync-device sync-device-all');
        const head = h('div', 'sync-device-head');
        head.appendChild(h('span', undefined, `Mind a(z) ${c.deviceCount} eszköz együtt`));
        head.appendChild(h('span', 'muted',
          `ma ${formatDuration(c.todaySeconds)} · 7 nap ${formatDuration(c.last7Seconds)}`));
        card.appendChild(head);
        for (const t of c.top) {
          const line = h('div', 'sync-device-line');
          line.appendChild(h('span', undefined, statLabel(t.label)));
          line.appendChild(h('span', 'muted', formatDuration(t.seconds)));
          card.appendChild(line);
        }
        host.appendChild(card);
      }
      for (const d of r.devices) {
        const card = h('div', 'sync-device');
        const head = h('div', 'sync-device-head');
        head.appendChild(h('span', undefined, d.self ? `${d.name} (ez a gép)` : d.name));
        head.appendChild(h('span', 'muted',
          `ma ${formatDuration(d.todaySeconds)} · 7 nap ${formatDuration(d.last7Seconds)}`));
        card.appendChild(head);
        if (d.top.length === 0) {
          card.appendChild(h('div', 'muted', 'Nincs mért idő erről az eszközről.'));
        } else {
          for (const t of d.top) {
            const line = h('div', 'sync-device-line');
            // A címke UGYANAZON a tölcséren megy át, mint a saját statisztika:
            // ha a lista rejtve van, a másik eszköz adata sem nevezheti meg az
            // oldalt. Enélkül a rejtés pont ott lyukadna ki, ahol senki nem
            // keresi.
            line.appendChild(h('span', undefined, statLabel(t.label)));
            line.appendChild(h('span', 'muted', formatDuration(t.seconds)));
            card.appendChild(line);
          }
        }
        host.appendChild(card);
      }
    },
  ));
}

/** A szerkesztő alatt lévő szűrő azonosítója; null = új szűrő készül. */
let editingChannelFilterId: string | null = null;

/**
 * A csatorna-szűrők kártyája.
 *
 * A sorok a segéd állapotából jönnek — a felület itt is csak TÜKÖR: a
 * lazítás-kapukat a segéd tartja, a gomb csak elindítja a kérést, és ha
 * próbatétel jön vissza, kinyitja ugyanazt a modalt, mint minden más lazítás.
 */
function renderChannelCard(st: StatusData): void {
  const host = $('channelList');
  host.textContent = '';
  const filters = st.channelFilters ?? [];
  for (const f of filters) {
    const row = h('div', 'site-row');
    const head = h('div', 'site-head');
    // A REJTETT LISTA ide is elér. A lista elrejtése arról szól, hogy a
    // blokkolt oldal NEVE ne álljon a képernyőn ingerforrásként — és a szűrő
    // gazdagépe tipikusan pont egy ilyen oldal. Rejtett listánál ezért a
    // hosztot ugyanaz a tölcsér fedi el, mint a statisztikát, a csatornákat
    // pedig csak megszámoljuk: egy @név is megnevezné, miről van szó.
    const hidden = status ? isListHidden(status) : false;
    const name = h('div', 'site-name', hidden ? statLabel(f.host) : f.host);
    const state = h('span', 'muted', f.enabled
      ? ` — bekapcsolva, ${f.allow.length} engedélyezett csatorna`
      : ` — kikapcsolva (${f.allow.length} csatorna)`);
    name.appendChild(state);
    head.appendChild(name);
    row.appendChild(head);
    const chips = h('div', 'muted', hidden
      ? `${f.allow.length} engedélyezett csatorna (a lista rejtve)`
      : f.allow.join(', '));
    chips.style.overflowWrap = 'anywhere';
    row.appendChild(chips);

    const actions = h('div', 'site-actions');
    const toggle = h('button', 'btn btn-small', f.enabled ? 'Kikapcsolás' : 'Bekapcsolás');
    toggle.addEventListener('click', () => {
      void submitChannelFilter({ id: f.id, host: f.host, allow: f.allow, enabled: !f.enabled });
    });
    const edit = h('button', 'btn btn-small btn-ghost', 'Szerkesztés');
    if (status && isListHidden(status)) edit.classList.add('hidden');
    edit.addEventListener('click', () => {
      editingChannelFilterId = f.id;
      $<HTMLInputElement>('chanHost').value = f.host;
      $<HTMLTextAreaElement>('chanAllow').value = f.allow.join('\n');
      $<HTMLInputElement>('chanEnabled').checked = f.enabled;
      $<HTMLInputElement>('chanProbe').value = '';
      $('chanProbeOut').classList.add('hidden');
      $('chanForm').classList.remove('hidden');
    });
    const del = h('button', 'btn btn-small btn-ghost', 'Törlés');
    del.addEventListener('click', () => {
      void (async () => {
        try {
          const r = await call<{ applied: boolean; session: SessionInfo | null }>(
            'channel_filter_delete', { filterId: f.id },
          );
          if (r.applied) void refresh();
          else if (r.session) openModal(r.session);
        } catch (e) {
          alert((e as Error).message);
        }
      })();
    });
    actions.append(toggle, edit, del);
    row.appendChild(actions);
    host.appendChild(row);
  }
  if (filters.length === 0) {
    // A példa a beviteli mező helykitöltőjében áll, nem itt: a rejtett lista
    // őre a látható szöveget nézi, és egy konkrét oldalnév itt inger lenne.
    host.appendChild(h('p', 'hint',
      'Még nincs csatorna-szűrő. Add meg az oldalt, alá az engedélyezett '
      + 'csatornákat — @nevekkel vagy a csatorna címével.'));
  }
}

/** A mentés közös útja: siker -> frissítés; lazítás -> próbatétel-modal. */
async function submitChannelFilter(filter: {
  id?: string; host: string; allow: string[]; enabled: boolean;
}): Promise<void> {
  const err = $('chanError');
  err.classList.add('hidden');
  try {
    const r = await call<{ applied: boolean; session: SessionInfo | null }>(
      'channel_filter_save', { filter },
    );
    editingChannelFilterId = null;
    $('chanForm').classList.add('hidden');
    if (r.applied) void refresh();
    else if (r.session) openModal(r.session);
  } catch (e) {
    err.textContent = (e as Error).message;
    err.classList.remove('hidden');
  }
}

/**
 * Élő próba: mit tenne a MOST beírt (még mentetlen) szűrő egy címmel.
 *
 * Nem a mentett állapotot kérdezi, hanem az űrlapét — pont mentés ELŐTT kell
 * tudni, hogy a lista jól van-e összerakva. A magyarázat a három átengedő
 * okot is szétszedi: a „mehet” önmagában nem mondaná meg, hogy azért-e, mert
 * engedélyezett, vagy mert nem is erre az oldalra szól a cím.
 */
function renderChannelProbe(): void {
  const out = $('chanProbeOut');
  const raw = $<HTMLInputElement>('chanProbe').value.trim();
  if (!raw) {
    out.classList.add('hidden');
    return;
  }
  out.classList.remove('hidden');
  const host = normalizeFilterHost($<HTMLInputElement>('chanHost').value);
  if (!host) {
    out.textContent = 'Előbb az oldal kell (fent) — enélkül nincs mihez mérni.';
    return;
  }
  const allow = $<HTMLTextAreaElement>('chanAllow').value.split('\n')
    .map((x) => normalizeChannelEntry(x.trim()))
    .filter((x): x is string => !!x);
  // A kikapcsolt szűrő nem tilt — de a próba arra való, hogy a listát
  // ellenőrizd, ezért úgy válaszol, MINTHA be lenne kapcsolva, és ezt meg
  // is mondja.
  const offNote = $<HTMLInputElement>('chanEnabled').checked
    ? '' : ' (A szűrő most ki van kapcsolva — ez a bekapcsolt viselkedés.)';
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const v = channelVerdict(url, [{ host, allow }]);
  if (v) {
    out.textContent = `Ezt a szűrő MEGFOGNÁ — a kulcs, amit a címben lát: ${v.key}${offNote}`;
    return;
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    out.textContent = 'Ez nem tűnik címnek.';
    return;
  }
  if (!hostMatchesFilter(u.hostname.toLowerCase(), host)) {
    out.textContent = 'Ez a cím nem erre az oldalra szól — a szűrő nem foglalkozik vele.';
    return;
  }
  const key = channelKeyFromPath(u.pathname);
  if (key) {
    out.textContent = `Engedélyezett csatorna (${key}) — mehet.${offNote}`;
    return;
  }
  if (contentIdOf(url)) {
    out.textContent = 'Lejátszó-cím: a cím nem mondja meg a csatornát — böngészés '
      + `közben a lap adata (a feltöltő) dönt.${offNote}`;
    return;
  }
  out.textContent = `Nem csatorna-alakú cím (kezdőlap, keresés, lista) — szabad.${offNote}`;
}

function setupChannelCard(): void {
  $('chanNewBtn').addEventListener('click', () => {
    editingChannelFilterId = null;
    $<HTMLInputElement>('chanHost').value = '';
    $<HTMLTextAreaElement>('chanAllow').value = '';
    $<HTMLInputElement>('chanEnabled').checked = true;
    $<HTMLInputElement>('chanProbe').value = '';
    $('chanProbeOut').classList.add('hidden');
    $('chanError').classList.add('hidden');
    $('chanForm').classList.remove('hidden');
  });
  // A próba minden érintett mezőre újraszámol: a kérdés nem csak a próba-cím,
  // hanem az is, hogy a lista éppen hogyan áll.
  for (const id of ['chanProbe', 'chanHost', 'chanAllow']) {
    $(id).addEventListener('input', renderChannelProbe);
  }
  $('chanEnabled').addEventListener('change', renderChannelProbe);
  $('chanCancel').addEventListener('click', () => {
    $('chanForm').classList.add('hidden');
    $('chanError').classList.add('hidden');
  });
  $('chanForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const allow = $<HTMLTextAreaElement>('chanAllow').value
      .split('\n').map((x) => x.trim()).filter(Boolean);
    void submitChannelFilter({
      id: editingChannelFilterId ?? undefined,
      host: $<HTMLInputElement>('chanHost').value,
      allow,
      enabled: $<HTMLInputElement>('chanEnabled').checked,
    });
  });
}

function renderTier(st: StatusData): void {
  const names = ['alap', 'emelt', 'magas', 'maximális'];
  $('tierLine').textContent =
    `Próbatétel-nehézség: ${names[st.tier]} (${st.tier + 1}/4) · ${st.unlocks7d} feloldás az elmúlt 7 napban — minél többször oldasz fel, annál nehezebb.`;
}

/**
 * Egy KORÁBBI NÉVEN telepített segéd még fut.
 *
 * Az app 0.1.4-ig Lakat volt; a névváltással a segéd is új azonosítót kapott,
 * a régi LaunchDaemon viszont nem tűnik el magától — a rendszer minden bootnál
 * elindítja. Ilyenkor két root démon dolgozik ugyanazon a hosts fájlon, és
 * mindkettő figyeli a változást: körbe-körbe írják felül egymást, folyamatos
 * DNS-ürítéssel. Ez a felhasználónak annyiból állna, hogy „valami furcsa”, és
 * semmilyen felület nem mondaná meg, mi.
 */
function renderLegacyHelperBanner(st: StatusData): void {
  const banner = $('legacyHelperBanner');
  const show = st.legacyHelperRunning === true;
  banner.classList.toggle('hidden', !show);
  if (show) {
    $('legacyHelperText').textContent =
      'Egy korábbi verzió (Lakat) háttérszolgáltatása még fut, és ugyanazt a rendszerfájlt '
      + 'írja, mint a Breaker. Amíg ez így van, maradhatnak olyan tiltások, amiket itt nem '
      + 'látsz. Terminálban ez állítja le: '
      + 'sudo launchctl bootout system/hu.lakat.helper && '
      + 'sudo rm -f /Library/LaunchDaemons/hu.lakat.helper.plist';
  }
}

/**
 * A futó helper régebbi protokollt beszél, mint ez a GUI.
 *
 * Ez frissítés után NORMÁLIS állapot: a GUI az új bundle-ből indul, a root
 * démont viszont a launchd (illetve a Windows ütemező) csak a következő
 * rendszerindításkor cseréli le. Amíg ez tart, az új parancsokat a régi helper
 * nem ismeri — hangosan el is hasal rajtuk (UNKNOWN_OP) —, de a felhasználó
 * ebből csak annyit látna, hogy „valami nem működik”. Ezért kimondjuk, és
 * adunk rá egy gombot: a telepítő újrafuttatása kicseréli a démont, egyetlen
 * jelszókérés árán, újraindítás nélkül.
 */
function renderHelperStaleBanner(st: StatusData): void {
  const banner = $('helperStaleBanner');
  const stale = !!st.helperVersion && st.helperVersion !== HELPER_VERSION;
  banner.classList.toggle('hidden', !stale);
  if (stale) {
    // Szándékosan nem nevez meg konkrét funkciót: az eltérés nem mondja meg,
    // MELYIK parancsot nem ismeri a futó helper, csak azt, hogy nem ugyanazt a
    // protokollt beszélik. Egy konkrét ígéret („a napi keret nem működik”) itt
    // néha egyszerűen nem lenne igaz.
    $('helperStaleText').textContent =
      `A háttérszolgáltatás még a régi verzió (${st.helperVersion}, az app ${HELPER_VERSION}). ` +
      'Amíg nem frissül, az újabb beállítások nem biztos, hogy érvényesülnek.';
  }
}

function renderResumeBanner(st: StatusData): void {
  const banner = $('resumeBanner');
  const show = !!st.session && !modalOpen;
  banner.classList.toggle('hidden', !show);
  if (show && st.session) {
    const site = st.sites.find((s) => s.id === st.session!.siteId);
    $('resumeText').textContent =
      `Folyamatban lévő ${st.session.kind === 'delete' ? 'törlési' : 'feloldási'} kísérlet: ${site ? displayName(site) : ''} (${st.session.stepIndex + 1}/${st.session.stepCount}. próba)`;
  }
}

function renderSiteList(st: StatusData): void {
  // Rejtett lista: a kártya megmarad (látszódjon, hogy VAN mit rejteni), de a
  // tartalma nem. A darabszámot kiírjuk — a kérés az volt, hogy MIK vannak
  // blokkolva ne látszódjon, nem az, hogy hány.
  const hidden = isListHidden(st);
  $('listHidden').classList.toggle('hidden', !hidden);
  $('listBody').classList.toggle('hidden', hidden);
  // A fejlécgomb a BEÁLLÍTÁST kapcsolja, nem a pillanatnyi láthatóságot: ha
  // rejtettre van állítva, de most nyitva van, akkor a gomb a rejtést kapcsolja
  // KI. Enélkül nem lenne mód visszavonni a beállítást.
  const hideBtn = $<HTMLButtonElement>('hideListBtn');
  // Üres listánál nincs mit rejteni — kivéve ha a beállítás már be van
  // kapcsolva: akkor kell a gomb, hogy vissza lehessen vonni.
  hideBtn.classList.toggle('hidden', hidden || (st.sites.length === 0 && st.hideSiteList !== true));
  hideBtn.textContent = st.hideSiteList === true ? 'Ne rejtse ezután' : 'Lista elrejtése';
  if (hidden) {
    // A sorokat ki is ÜRÍTJÜK, nem csak eltakarjuk. Így a rejtett állapot
    // ugyanaz akkor is, ha indulásból az, és akkor is, ha most kapcsolták rá —
    // és nem marad ott a DOM-ban egy lista, amit egy fejlesztői eszköz vagy egy
    // félresikerült CSS bármikor visszahoz.
    $('siteList').textContent = '';
    const n = st.sites.length;
    $('listHiddenText').textContent = n === 0
      ? 'A lista el van rejtve. Még nincs benne egyetlen oldal sem.'
      : `${n} oldal van blokkolva. A lista el van rejtve, hogy a puszta megnyitás `
        + 'se emlékeztessen rájuk. Megnyitva csak eddig a bezárásig marad.';
    return;
  }

  const list = $('siteList');
  list.textContent = '';
  $('emptyList').classList.toggle('hidden', st.sites.length > 0);
  for (const site of st.sites) list.appendChild(siteRow(site, st));
}

function siteRow(site: SiteInfo, st: StatusData): HTMLElement {
  const now = st.now;
  const row = h('div', 'site-row');
  // Fejléc: a NÉV és az ÁLLAPOT egy sorban, mert ez a két dolog kell ránézésre.
  // Minden más (mérő, műveletek) ez alá kerül, halványabban.
  const head = h('div', 'site-head');
  const ident = h('div', 'site-ident');
  const shownName = displayNameNow(site, now, revealedUntil.get(site.id));
  const nameEl = h('div', 'site-domain', shownName);
  if (isAliased(site) && shownName === site.domain) nameEl.classList.add('site-domain-revealed');
  ident.appendChild(nameEl);
  if (isAliased(site)) {
    const until = revealedUntil.get(site.id);
    const showing = until !== undefined && now < until;
    const peek = h('button', 'btn btn-tiny peek-btn',
      showing ? `${Math.ceil((until! - now) / 1000)} mp` : 'Mutasd');
    peek.title = showing
      ? 'A valódi cím látszik; mindjárt visszabújik'
      : `A valódi cím ${Math.round(REVEAL_MS / 1000)} másodpercre látszik`;
    peek.disabled = showing;
    peek.addEventListener('click', () => {
      revealedUntil.set(site.id, Date.now() + REVEAL_MS);
      render();
    });
    nameEl.appendChild(peek);
  }
  ident.appendChild(h('div', 'site-sub', `${site.hostnames.length} hosztnév · felvéve: ${new Date(site.addedAt).toLocaleDateString('hu-HU')}`));
  head.appendChild(ident);
  const statusEl = h('div', 'site-status');
  const actions = h('div', 'site-actions');

  let meterEl: HTMLElement | null = null;
  const paused = site.pauseUntil !== null && site.pauseUntil > now;
  const deleting = site.pendingDeleteAt !== null;

  if (paused) {
    const p = h('span', 'pill pill-warn', `Szünetel még ${fmtRemain(site.pauseUntil! - now)}`);
    statusEl.appendChild(p);
    // A keret a szünet alatt IS fogy — az idő akkor is elmegy az oldalra.
    // Ha ezt elrejtenénk, a szünet végén jönne a meglepetés, hogy az oldal
    // azonnal zár. Inkább látszódjon, amíg lehet vele kezdeni valamit.
    if (site.dailyLimitSeconds) meterEl = limitMeter(site, true);
    const relock = h('button', 'btn btn-small', 'Blokkolás visszakapcsolása most');
    relock.addEventListener('click', () => void doSimple('relock', { siteId: site.id }));
    actions.appendChild(relock);
  } else if (deleting) {
    const p = h('span', 'pill pill-danger', `Törlés ${fmtRemain(site.pendingDeleteAt! - now)} múlva`);
    statusEl.appendChild(p);
    const cancel = h('button', 'btn btn-small', 'Törlés visszavonása');
    cancel.addEventListener('click', () => void doSimple('cancel_delete', { siteId: site.id }));
    actions.appendChild(cancel);
  } else {
    const scheduled = site.schedule && site.schedule.mode !== 'always';
    if (scheduled) {
      statusEl.appendChild(site.blockedNow
        ? h('span', 'pill pill-ok', 'Most blokkolva (menetrend)')
        : h('span', 'pill pill-warn', 'Most szabad (menetrend szerint)'));
    } else {
      statusEl.appendChild(h('span', 'pill pill-ok', 'Blokkolva'));
    }
    if (site.dailyLimitSeconds) meterEl = limitMeter(site, false);
    if (!st.session) {
      const unlock = h('button', 'btn btn-small', 'Feloldás');
      unlock.addEventListener('click', () => openPauseDialog(site.id));
      const sched = h('button', 'btn btn-small', 'Menetrend');
      sched.addEventListener('click', () => openScheduleDialog(site));
      const limit = h('button', 'btn btn-small', 'Napi keret');
      limit.addEventListener('click', () => openLimitDialog(site));
      const alias = h('button', 'btn btn-small', 'Fedőnév');
      alias.addEventListener('click', () => openAliasDialog(site));
      const parts = h('button', 'btn btn-small',
        site.rules?.length ? `Részek · ${site.rules.length}` : 'Részek');
      parts.addEventListener('click', () => openRulesDialog(site));
      const del = h('button', 'btn btn-small btn-danger', 'Törlés');
      del.addEventListener('click', () => void startDelete(site));
      actions.append(unlock, sched, limit, alias, parts, del);
    }
  }

  head.appendChild(statusEl);
  row.append(head);
  if (meterEl) row.append(meterEl);
  if (actions.childElementCount > 0) row.append(actions);
  return row;
}

/**
 * Today's budget as a bar. Dual-coded on purpose: the colour changes AND the
 * text says what happened, so it reads the same for anyone who cannot tell the
 * two colours apart.
 */
function limitMeter(site: SiteInfo, duringPause: boolean): HTMLElement {
  const limit = site.dailyLimitSeconds ?? 0;
  const used = Math.min(site.usedTodaySeconds, limit);
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
  const wrap = h('div', 'limit-meter');
  let label: string;
  if (site.limitExhausted && duringPause) {
    // A szünet erősebb a keretnél, tehát az oldal MOST még megy — de a szünet
    // végén már nem fog. Ezt előre kimondjuk, ne a bezáródás mondja el.
    label = `Napi keret elfogyott (${formatDuration(limit)}) — a szünet végén visszazár`;
  } else if (site.limitExhausted) {
    label = `Napi keret elfogyott (${formatDuration(limit)}) — holnap újraindul`;
  } else if (duringPause) {
    label = `Napi keret: ${formatDuration(used)} / ${formatDuration(limit)} — a szünet alatt is fogy`;
  } else {
    label = `Napi keret: ${formatDuration(used)} / ${formatDuration(limit)}`;
  }
  wrap.appendChild(h('div', 'limit-label', label));
  // A keret KÖZÖS az eszközök között. Enélkül úgy nézne ki, mintha az app
  // rosszul számolna: a gépen öt perc telt el, a mérő mégis húszat mutat.
  const elsewhere = site.usedTodayElsewhere ?? 0;
  if (elsewhere > 0) {
    wrap.appendChild(h('div', 'limit-note', `Ebből ${formatDuration(elsewhere)} másik eszközön`));
  }
  const bar = h('div', 'limit-bar');
  const fill = h('div', site.limitExhausted ? 'limit-fill limit-fill-full' : 'limit-fill');
  fill.style.width = `${Math.min(100, pct)}%`;
  bar.appendChild(fill);
  wrap.appendChild(bar);
  return wrap;
}

const LIMIT_CHOICES_MIN = [10, 20, 30, 45, 60, 90, 120];

/**
 * Fedőnév beállítása.
 *
 * Nincs benne próbatétel, és ez szándékos: a fedőnév nem lazítás. Az oldal
 * ettől ugyanúgy blokkolva marad, a hosts fájl egy bájtot sem változik — csak
 * nem a címe áll a listán. Súrlódást oda teszünk, ahol a védelem gyengülne.
 */
function openAliasDialog(site: SiteInfo): void {
  const overlay = h('div', 'overlay');
  const modal = h('div', 'modal modal-small');
  modal.appendChild(h('h3', undefined, `Név elrejtése: ${displayName(site)}`));
  modal.appendChild(h('p', 'hint',
    'A listán a cím helyett ez a név fog állni. A valódi cím nem tűnik el: a '
    + `név mellett egy gombbal ${Math.round(REVEAL_MS / 1000)} másodpercre `
    + 'előhívható, aztán magától visszabújik. A statisztikában is a fedőnév '
    + 'látszik majd.'));

  const input = h('input', 'alias-input') as HTMLInputElement;
  input.type = 'text';
  input.maxLength = MAX_ALIAS_LENGTH;
  input.placeholder = 'pl. A videós';
  input.value = site.alias ?? '';
  input.spellcheck = false;
  modal.appendChild(input);

  const err = h('p', 'error hidden');
  modal.appendChild(err);

  const actions = h('div', 'modal-actions');
  const left = h('div', 'row-gap');
  if (isAliased(site)) {
    const clear = h('button', 'btn btn-small btn-ghost', 'Fedőnév levétele');
    clear.addEventListener('click', () => void apply(null));
    left.appendChild(clear);
  }
  const cancel = h('button', 'btn btn-small btn-ghost', 'Mégse');
  cancel.addEventListener('click', () => overlay.remove());
  const save = h('button', 'btn btn-small btn-primary', 'Mentés');
  save.addEventListener('click', () => void apply(input.value));
  const right = h('div', 'row-gap');
  right.append(cancel, save);
  actions.append(left, right);
  modal.appendChild(actions);

  async function apply(value: string | null): Promise<void> {
    try {
      status = await call<StatusData>('set_alias', { siteId: site.id, alias: value });
      // Névváltáskor a korábbi felfedésnek nincs értelme.
      revealedUntil.delete(site.id);
      overlay.remove();
      render();
    } catch (e) {
      err.textContent = (e as Error).message;
      err.classList.remove('hidden');
    }
  }

  input.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') void apply(input.value);
  });
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  input.focus();
  input.select();
}

/**
 * Részleges tiltás: az oldal egy darabja.
 *
 * A párbeszéd legfontosabb része nem a lista, hanem a MAGYARÁZAT. Aki ide
 * eljut, azt hiszi, hogy ez ugyanolyan erős, mint a többi tiltás — pedig nem
 * az, és egy önkontroll-appnál a hamis biztonságérzet rosszabb, mint a
 * bevallott korlát.
 */
function openRulesDialog(site: SiteInfo): void {
  const overlay = h('div', 'overlay');
  const modal = h('div', 'modal');
  modal.appendChild(h('h3', undefined, `Csak egy rész: ${displayName(site)}`));
  modal.appendChild(h('p', 'hint',
    'Nem az egész oldal, csak egy darabja — például egy csatorna. Illeszd be a '
    + 'címét úgy, ahogy a böngészőben látod.'));

  const warn = h('div', 'rules-warning');
  warn.appendChild(h('strong', undefined, 'Ehhez böngésző-bővítmény kell, és gyengébb réteg.'));
  warn.appendChild(h('p', undefined,
    'A Breaker DNS-szinten tilt, a DNS viszont csak a hosztnevet látja — az utat '
    + '(a cím perjel utáni részét) nem, mert az a titkosított kérésen belül van. '
    + 'Ezért ezt a böngésző-bővítmény érvényesíti: csak abban a böngészőben, '
    + 'ahova telepítve van; vendég módban egyáltalán nem fut; inkognitóban külön '
    + 'be kell kapcsolni. Az egész oldal tiltása marad a megkerülhetetlen.'));
  modal.appendChild(warn);

  // A bővítmény összekötése. Ha ez nincs, a szabályokat kétszer kellene
  // begépelni — itt is, meg a bővítményben is —, és ami kétszer van, az
  // előbb-utóbb szétcsúszik.
  const link = h('div', 'bridge-box');
  modal.appendChild(link);
  void window.breaker.getBridgeInfo().then((info) => {
    link.textContent = '';
    if (!info.running || !info.token || !info.port) {
      link.appendChild(h('p', 'hint',
        'A bővítmény összekötése most nem érhető el' + (info.error ? ` (${info.error})` : '')
        + '. A szabályok attól még érvényesek, csak kézzel kell felvenni őket a '
        + 'bővítményben is.'));
      return;
    }
    link.appendChild(h('div', 'micro', 'A bővítmény összekötése'));
    link.appendChild(h('div', 'pair-code', info.token));
    link.appendChild(h('p', 'hint',
      'Másold be a bővítmény beállításai közé. Ezután a bővítmény innen veszi a '
      + 'szabályokat, és nem kell kétszer felvenni őket. Amíg ez az app nincs '
      + 'nyitva, a bővítmény az utoljára letöltött listát használja — vagyis '
      + 'tovább tilt, nem enged át.'));
  });

  const list = h('div', 'rules-list');
  const rules = site.rules ?? [];
  if (rules.length === 0) {
    list.appendChild(h('p', 'hint', 'Még nincs egyetlen részleges szabály sem ezen az oldalon.'));
  }
  for (const rule of rules) {
    const line = h('div', 'rules-line');
    line.appendChild(h('span', 'rules-name', ruleLabel(rule)));
    const drop = h('button', 'btn btn-tiny btn-ghost', 'Levétel…');
    drop.title = 'A levétel próbatétel — ugyanúgy, mint a feloldás.';
    drop.addEventListener('click', () => void apply(ruleLabel(rule), true));
    line.appendChild(drop);
    list.appendChild(line);
  }
  modal.appendChild(list);

  const input = h('input', 'alias-input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = `pl. ${site.domain}/@valaki`;
  input.spellcheck = false;
  modal.appendChild(input);
  modal.appendChild(h('p', 'hint',
    'Felvenni egy kattintás. Levenni próbatétel — ugyanúgy, mint a feloldást.'));

  const err = h('p', 'error hidden');
  modal.appendChild(err);

  const actions = h('div', 'modal-actions');
  const cancel = h('button', 'btn btn-small btn-ghost', 'Bezárás');
  cancel.addEventListener('click', () => overlay.remove());
  const add = h('button', 'btn btn-small btn-primary', 'Hozzáadás');
  add.addEventListener('click', () => void apply(input.value, false));
  const right = h('div', 'row-gap');
  right.append(cancel, add);
  actions.append(h('div', 'row-gap'), right);
  modal.appendChild(actions);

  async function apply(value: string, remove: boolean): Promise<void> {
    try {
      const r = await call<SetRuleResult & { status: StatusData }>('set_rule', {
        siteId: site.id, input: value, remove,
      });
      status = r.status;
      overlay.remove();
      render();
    } catch (e) {
      err.textContent = (e as Error).message;
      err.classList.remove('hidden');
    }
  }

  input.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') void apply(input.value, false);
  });
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  input.focus();
}

function openLimitDialog(site: SiteInfo): void {
  const overlay = h('div', 'overlay');
  const modal = h('div', 'modal modal-small');
  modal.appendChild(h('h3', undefined, `Napi keret: ${displayName(site)}`));
  modal.appendChild(h('p', 'hint',
    'Ha a mai aktív idő eléri a keretet, az oldal a nap hátralévő részére ' +
    'magától visszazár, éjfélkor pedig a keret újraindul. Keretet bevezetni ' +
    'vagy csökkenteni azonnal megy; emelni vagy megszüntetni ugyanúgy ' +
    'próbatételekbe kerül, mint egy feloldás.'));

  // A keret is percre pontos: a gyors gombok mellett ott a szabad mező. Aki
  // napi 35 percet szán valamire, annak a 30 kevés, a 45 sok — és ha csak
  // ezek közül lehet választani, a keret nem az ő döntése lesz, hanem a
  // gomblistáé.
  const current = site.dailyLimitSeconds ?? null;
  let noLimit = current === null;
  const picker = minutePicker(
    LIMIT_CHOICES_MIN,
    current === null ? 30 : Math.max(1, Math.round(current / 60)),
    MAX_LIMIT_MINUTES,
    () => { noLimit = false; paintNone(); },
  );
  const none = h('button', 'chip', 'Nincs keret') as HTMLButtonElement;
  function paintNone(): void {
    none.classList.toggle('chip-on', noLimit);
    // A mező marad olvasható, csak jelezzük, hogy most nem ő dönt.
    picker.box.classList.toggle('muted-box', noLimit);
  }
  none.addEventListener('click', () => { noLimit = true; paintNone(); });
  const noneRow = h('div', 'chips');
  noneRow.appendChild(none);
  paintNone();

  const err = h('p', 'error');
  err.classList.add('hidden');
  const apply = h('button', 'btn btn-primary', 'Alkalmaz');
  apply.addEventListener('click', async () => {
    const minutes = picker.value();
    if (!noLimit && minutes === null) {
      err.textContent = `Írj be egy keretet percben (1–${MAX_LIMIT_MINUTES}), vagy válaszd a „Nincs keret” lehetőséget.`;
      err.classList.remove('hidden');
      return;
    }
    const chosen = noLimit ? null : (minutes as number) * 60;
    try {
      const r = await call<SetLimitResult>('set_limit', { siteId: site.id, seconds: chosen });
      document.body.removeChild(overlay);
      if (r.applied) void refresh();
      else if (r.session) openModal(r.session); // loosening -> challenges
    } catch (e) {
      err.textContent = (e as Error).message;
      err.classList.remove('hidden');
    }
  });
  const cancel = h('button', 'btn btn-ghost', 'Mégse');
  cancel.addEventListener('click', () => document.body.removeChild(overlay));

  const actions = h('div', 'modal-actions');
  actions.append(cancel, apply);
  modal.append(picker.box, noneRow, err, actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

async function doSimple(op: string, payload: Record<string, unknown>): Promise<void> {
  try {
    status = await call<StatusData>(op, payload);
    render();
  } catch (e) {
    alert((e as Error).message);
  }
}

// ------------------------------------------------------------- add site

const PRESET_CHIPS = [
  'youtube.com', 'facebook.com', 'instagram.com', 'tiktok.com',
  'x.com', 'reddit.com', 'twitch.tv', 'netflix.com',
];

/**
 * A felvevő kártya — a gyorsgombokkal és a példákkal együtt.
 *
 * Rejtett listánál ez is elnémul. Nem szőrözés: a gyorsgombokon PONT azok a
 * címek állnak, amiket az ember tipikusan blokkol, a beviteli mező példája meg
 * ugyanaz. Hiába rejtenénk el a listát, ha egy kártyával feljebb ott sorakozik
 * ugyanaz nyolc gombon — a rejtés célja az emlékeztetés megszüntetése, nem egy
 * lista összecsukása.
 */
function renderAddCard(st: StatusData): void {
  const hidden = isListHidden(st);
  const chips = $('presetChips');
  chips.textContent = '';
  chips.classList.toggle('hidden', hidden);
  if (!hidden) {
    for (const name of PRESET_CHIPS) {
      const chip = h('button', 'chip', name);
      chip.type = 'button';
      chip.addEventListener('click', () => void addSite(name));
      chips.appendChild(chip);
    }
  }
  $<HTMLInputElement>('addInput').placeholder = hidden ? 'a cím, amit blokkolni akarsz' : 'pl. www.youtube.com';
  $('presetToggleText').textContent = hidden
    ? 'Ismert szolgáltatásnál a társoldalak blokkolása is (a mobilos és a rövidített címek)'
    : 'Ismert szolgáltatásnál a társoldalak blokkolása is (pl. youtu.be, m.youtube.com)';
}

function setupAddCard(): void {
  $('addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('addInput');
    if (input.value.trim()) void addSite(input.value);
  });
}

/**
 * Figyelmeztetés, ha a beírt címben ÚT is van.
 *
 * Ez a mezőnek a legrosszabb csendes hibája: aki bemásolja a
 * `youtube.com/@valaki` címet, azt hiszi, egy csatornát tilt le — a blokkolás
 * viszont DNS-szintű, tehát az utat el sem látja, és az EGÉSZ youtube.com
 * elesik. Semmi nem hibázik, csak nem az történik, amit kért.
 *
 * Nem tiltjuk meg: lehet, hogy tényleg az egész oldalt akarja. De előbb
 * mondjuk meg, mi fog történni, és azt is, hogy mi kell a másikhoz.
 */
function pathWarning(value: string): string | null {
  const rule = normalizeRule(value);
  if (!rule) return null;
  return `Csak jelzem: ez az EGÉSZ ${rule.host} oldalt tiltja le, nem csak a `
    + `${rule.path} részét — a blokkolás DNS-szintű, és a DNS az utat nem látja. `
    + 'Ha tényleg csak azt a részt szeretnéd, ahhoz a böngésző-bővítmény kell '
    + '(extension/ mappa a projektben). Ha az egész oldal a cél, nyomd meg újra.';
}

/** A legutóbb figyelmeztetett érték — a második megnyomás már felveszi. */
let warnedFor: string | null = null;

async function addSite(value: string): Promise<void> {
  const errEl = $('addError');
  errEl.classList.add('hidden');

  const warning = pathWarning(value);
  if (warning && warnedFor !== value.trim()) {
    warnedFor = value.trim();
    errEl.textContent = warning;
    errEl.classList.remove('hidden');
    return;
  }
  warnedFor = null;

  try {
    status = await call<StatusData>('add_site', {
      input: value,
      usePreset: $<HTMLInputElement>('presetToggle').checked,
    });
    $<HTMLInputElement>('addInput').value = '';
    render();
  } catch (e) {
    errEl.textContent = (e as Error).message;
    errEl.classList.remove('hidden');
  }
}

// ------------------------------------------------------- session lifecycle

function openPauseDialog(siteId: string): void {
  pendingPauseSiteId = siteId;
  $('pauseDialog').classList.remove('hidden');
}

async function startPause(minutes: number): Promise<void> {
  $('pauseDialog').classList.add('hidden');
  if (!pendingPauseSiteId) return;
  try {
    const session = await call<SessionInfo>('start_unlock', { siteId: pendingPauseSiteId, minutes });
    openModal(session);
  } catch (e) {
    alert((e as Error).message);
  }
  pendingPauseSiteId = null;
}

// ------------------------------------------------------------- schedule editor

const PRESET_LABELS: { key: keyof typeof PRESET_BANDS; label: string }[] = [
  { key: 'workHours', label: 'Munkaidő (H–P 9–17)' },
  { key: 'evening', label: 'Esti lekapcsolás (22–06)' },
  { key: 'weekend', label: 'Hétvége (Szo–V egész nap)' },
];

function openScheduleDialog(site: SiteInfo): void {
  const overlay = h('div', 'overlay');
  const modal = h('div', 'modal modal-small');
  modal.appendChild(h('h3', undefined, `Menetrend: ${displayName(site)}`));
  modal.appendChild(h('p', 'hint',
    'Szigorítani (több tiltott idő) azonnal megy. Lazítani — kevesebb tiltás — ' +
    'ugyanúgy próbatételekbe kerül, mint egy feloldás.'));

  const current: Schedule = site.schedule ?? { mode: 'always', bands: [] };
  let mode: ScheduleMode = current.mode;
  const selectedPresets = new Set<keyof typeof PRESET_BANDS>();
  // seed preset selection from current bands (best effort by JSON match)
  for (const { key } of PRESET_LABELS) {
    if (current.bands.some((b) => JSON.stringify(b) === JSON.stringify(PRESET_BANDS[key]))) {
      selectedPresets.add(key);
    }
  }

  const modeWrap = h('div', 'sched-modes');
  const modes: { v: ScheduleMode; label: string }[] = [
    { v: 'always', label: 'Mindig tiltva' },
    { v: 'scheduled_block', label: 'Csak a kijelölt sávokban tiltva' },
    { v: 'scheduled_allow', label: 'A kijelölt sávokban szabad, egyébként tiltva' },
  ];
  const presetWrap = h('div', 'sched-presets');

  function renderPresets(): void {
    presetWrap.style.display = mode === 'always' ? 'none' : 'block';
  }

  for (const m of modes) {
    const id = `mode_${m.v}`;
    const row = h('label', 'sched-radio');
    const radio = h('input') as HTMLInputElement;
    radio.type = 'radio'; radio.name = 'schedmode'; radio.value = m.v; radio.id = id;
    radio.checked = mode === m.v;
    radio.addEventListener('change', () => { mode = m.v; renderPresets(); });
    row.append(radio, document.createTextNode(' ' + m.label));
    modeWrap.appendChild(row);
  }

  presetWrap.appendChild(h('div', 'hint', 'Sávok:'));
  for (const { key, label } of PRESET_LABELS) {
    const row = h('label', 'sched-radio');
    const cb = h('input') as HTMLInputElement;
    cb.type = 'checkbox'; cb.checked = selectedPresets.has(key);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedPresets.add(key); else selectedPresets.delete(key);
    });
    row.append(cb, document.createTextNode(' ' + label));
    presetWrap.appendChild(row);
  }
  renderPresets();

  const err = h('p', 'error');
  err.classList.add('hidden');
  const apply = h('button', 'btn btn-primary', 'Alkalmaz');
  apply.addEventListener('click', async () => {
    const bands = mode === 'always' ? [] : [...selectedPresets].map((k) => PRESET_BANDS[k]);
    if (mode !== 'always' && bands.length === 0) {
      err.textContent = 'Válassz legalább egy sávot, vagy a „Mindig tiltva” módot.';
      err.classList.remove('hidden');
      return;
    }
    const schedule: Schedule = { mode, bands };
    try {
      const r = await call<SetScheduleResult>('set_schedule', { siteId: site.id, schedule });
      document.body.removeChild(overlay);
      if (r.applied) {
        void refresh();
      } else if (r.session) {
        openModal(r.session); // loosening -> challenges
      }
    } catch (e) {
      err.textContent = (e as Error).message;
      err.classList.remove('hidden');
    }
  });
  const cancel = h('button', 'btn btn-ghost', 'Mégse');
  cancel.addEventListener('click', () => document.body.removeChild(overlay));

  const actions = h('div', 'modal-actions');
  actions.append(cancel, apply);
  modal.append(modeWrap, presetWrap, err, actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

async function startDelete(site: SiteInfo): Promise<void> {
  const sure = confirm(
    `Biztosan törölnéd a(z) ${displayName(site)} blokkolását?\n\n` +
    'A törléshez a legnehezebb próbatételek tartoznak, és a törlés csak 24 órával ' +
    'a teljesítésük UTÁN válik véglegessé. Addig bármikor, egy kattintással visszavonhatod.');
  if (!sure) return;
  try {
    const session = await call<SessionInfo>('start_delete', { siteId: site.id });
    openModal(session);
  } catch (e) {
    alert((e as Error).message);
  }
}

function openModal(session: SessionInfo): void {
  modalOpen = true;
  renderedStepId = null;
  $('sessionModal').classList.remove('hidden');
  renderSession(session);
}

function closeModal(): void {
  modalOpen = false;
  renderedStepId = null;
  clearStepTimers();
  $('sessionModal').classList.add('hidden');
}

function setStepMessage(msg: string | null, isError = true): void {
  const el = $('stepMessage');
  if (!msg) {
    el.classList.add('hidden');
    return;
  }
  el.textContent = msg;
  el.className = isError ? 'error' : 'hint';
  el.classList.remove('hidden');
}

function renderSession(session: SessionInfo | null): void {
  if (!session) {
    // Finished or expired while the modal was open.
    clearStepTimers();
    renderedStepId = null;
    $('sessionTitle').textContent = 'Nincs aktív kísérlet';
    $('sessionProgress').textContent = '';
    $('stepArea').textContent = '';
    return;
  }
  const site = status?.sites.find((s) => s.id === session.siteId);
  // A munkamenet leállítása is próbatétel, de NEM egy oldalhoz tartozik: a
  // bíró ilyenkor `focus:<csomag>` azonosítót ad. Enélkül a fejléc azt írná ki,
  // hogy „Feloldás null percre:” — és a felhasználó nem értené, mit csinál épp.
  const focusPack = session.siteId.startsWith('focus:')
    ? (status?.focusPacks ?? []).find((p) => `focus:${p.id}` === session.siteId)
    : undefined;
  if (session.siteId.startsWith('focus:')) {
    $('sessionTitle').textContent = `Munkamenet leállítása: ${focusPack?.name ?? ''}`;
    $('sessionSubtitle').textContent =
      'A munkamenet addig FUT, amíg a próbák meg nincsenek. Hosszabbítani közben '
      + 'is ingyen lehet — csak a rövidítés kerül ebbe.';
  } else {
    $('sessionTitle').textContent = session.kind === 'delete'
      ? `Végleges törlés: ${site ? displayName(site) : ''}`
      : `Feloldás ${session.minutes} percre: ${site ? displayName(site) : ''}`;
    $('sessionSubtitle').textContent = session.kind === 'delete'
      ? 'A próbák teljesítése után a törlés még 24 órát vár — addig visszavonható.'
      : 'A próbák teljesítése után az oldal a választott ideig elérhető, majd magától visszazár.';
  }
  $('sessionProgress').textContent = `${session.stepIndex + 1}/${session.stepCount}. próba`;

  if (session.current.id !== renderedStepId) {
    renderedStepId = session.current.id;
    buildStep(session);
  }
}

// ------------------------------------------------------------ step widgets

/** Blocks paste/drop and suspiciously large input jumps (autotype). */
function guardInput(el: HTMLInputElement | HTMLTextAreaElement): void {
  el.addEventListener('paste', (e) => e.preventDefault());
  el.addEventListener('drop', (e) => e.preventDefault());
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  let prevLen = 0;
  el.addEventListener('input', () => {
    if (el.value.length - prevLen > 12) {
      el.value = '';
      setStepMessage('A beillesztés nem játszik — kézzel kell begépelni.');
    }
    prevLen = el.value.length;
  });
}

function buildStep(session: SessionInfo): void {
  clearStepTimers();
  setStepMessage(null);
  const area = $('stepArea');
  area.textContent = '';
  const step = session.current;
  const box = h('div', 'step-box');

  switch (step.type) {
    case 'TRANSCRIBE': buildTranscribe(box, session, step); break;
    case 'MATH_CHAIN': buildMath(box, session, step); break;
    case 'MEMORY': buildMemory(box, session, step); break;
    case 'REVERSE': buildReverse(box, session, step); break;
    case 'DELAY': buildDelay(box, session, step); break;
  }
  area.appendChild(box);
}

function submitButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = h('button', 'btn btn-primary step-submit', label);
  btn.addEventListener('click', onClick);
  return btn;
}

async function submitAnswer(session: SessionInfo, answer: string): Promise<void> {
  try {
    const r = await call<SubmitResult>('submit', { sessionId: session.id, answer });
    handleSubmitResult(r, session.kind);
  } catch (e) {
    setStepMessage((e as Error).message);
    void refresh();
  }
}

function handleSubmitResult(r: SubmitResult, kind: 'pause' | 'delete'): void {
  if (r.sessionDone) {
    closeModal();
    alert(kind === 'delete'
      ? 'Kész. A törlés 24 óra múlva válik véglegessé — addig a lista soron visszavonhatod.'
      : 'Sikerült! Az oldal a választott időre elérhető, utána magától visszazár a blokkolás.');
    void refresh();
    return;
  }
  if (status) status.session = r.session;
  if (r.session) {
    // Rebuild when the step changed (new id after fail-regenerate, or advance);
    // MATH_CHAIN keeps its id between problems, so rebuild on accepted answers too.
    if (r.session.current.id !== renderedStepId || (r.accepted && r.session.current.type === 'MATH_CHAIN')) {
      renderedStepId = r.session.current.id;
      $('sessionProgress').textContent = `${r.session.stepIndex + 1}/${r.session.stepCount}. próba`;
      buildStep(r.session);
    }
  }
  if (r.message) setStepMessage(r.message, !r.accepted);
}

function buildTranscribe(box: HTMLElement, session: SessionInfo, step: StepDisplay): void {
  box.appendChild(h('div', 'step-title', 'Gépeld át pontosan az alábbi szöveget'));
  box.appendChild(h('div', 'hint', 'Karakterre pontosan: kis-/nagybetű, vessző, pont, szám. Beilleszteni nem lehet.'));
  const text = step.text ?? '';
  box.appendChild(h('div', 'challenge-text', text));
  const ta = h('textarea');
  ta.spellcheck = false;
  guardInput(ta);
  const feedback = h('div', 'live-feedback');
  ta.addEventListener('input', () => {
    const v = ta.value;
    let i = 0;
    while (i < v.length && i < text.length && v[i] === text[i]) i++;
    if (v.length === 0) { feedback.textContent = ''; feedback.className = 'live-feedback'; }
    else if (i === v.length && v.length <= text.length) {
      feedback.textContent = `Eddig hibátlan (${v.length}/${text.length} karakter).`;
      feedback.className = 'live-feedback good';
    } else {
      feedback.textContent = `Eltérés a(z) ${i + 1}. karakternél.`;
      feedback.className = 'live-feedback bad';
    }
  });
  box.append(ta, feedback, submitButton('Kész, ellenőrzés', () => void submitAnswer(session, ta.value)));
}

function buildMath(box: HTMLElement, session: SessionInfo, step: StepDisplay): void {
  const m = step.math!;
  box.appendChild(h('div', 'step-title', `Fejszámolás-lánc — ${m.index + 1}/${m.total}. feladat`));
  box.appendChild(h('div', 'hint', 'Hibás válasznál a teljes lánc elölről indul, új feladatokkal. Számológép helyett papírt!'));
  box.appendChild(h('div', 'math-q', m.question));
  const input = h('input', 'challenge-input') as HTMLInputElement;
  input.type = 'text';
  input.inputMode = 'numeric';
  input.placeholder = 'Eredmény (egész szám, lehet negatív)';
  guardInput(input);
  const submit = () => void submitAnswer(session, input.value);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  box.append(input, submitButton('Ellenőrzés', submit));
  setTimeout(() => input.focus(), 50);
}

function buildMemory(box: HTMLElement, session: SessionInfo, step: StepDisplay): void {
  const mem = step.memory!;
  box.appendChild(h('div', 'step-title', 'Memória-próba'));
  const phaseHint = h('div', 'hint',
    `Jegyezd meg a kódot! ${Math.round(mem.showMs / 1000)} mp múlva végleg eltűnik, majd ${Math.round(mem.waitMs / 1000)} mp várakozás után emlékezetből kell beírni.`);
  const codeEl = h('div', 'big-code', mem.code ?? '• • • • •');
  const countdown = h('div', 'countdown');
  box.append(phaseHint, codeEl, countdown);

  // Timing is server-armed (armedAt): reopening the window does NOT restart
  // the show phase, and the helper refuses answers before the wait elapses.
  const showDeadline = (mem.armedAt ?? Date.now()) + mem.showMs;
  const waitDeadline = showDeadline + mem.waitMs;
  let inputBuilt = false;
  const t = setInterval(() => {
    const now = Date.now();
    if (mem.code !== null && now < showDeadline) {
      countdown.textContent = `Eltűnik: ${fmtRemain(showDeadline - now)}`;
      return;
    }
    codeEl.textContent = '• • • • •';
    if (now < waitDeadline) {
      phaseHint.textContent = 'Most várni kell — közben ne írd le sehova!';
      countdown.textContent = `Beírható: ${fmtRemain(waitDeadline - now)}`;
      return;
    }
    if (!inputBuilt) {
      inputBuilt = true;
      clearInterval(t);
      countdown.textContent = '';
      phaseHint.textContent = 'Írd be a kódot emlékezetből:';
      const input = h('input', 'challenge-input') as HTMLInputElement;
      input.autocomplete = 'off';
      input.spellcheck = false;
      guardInput(input);
      const submit = () => void submitAnswer(session, input.value);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      box.append(input, submitButton('Ellenőrzés', submit));
      input.focus();
    }
  }, 250);
  stepTimers.push(t);
}

function buildReverse(box: HTMLElement, session: SessionInfo, step: StepDisplay): void {
  box.appendChild(h('div', 'step-title', 'Gépeld be visszafelé'));
  box.appendChild(h('div', 'hint',
    'A teljes mondatot karakterről karakterre fordítva írd be, írásjelekkel és szóközökkel együtt. Példa: „Kis fa.” → „.af siK”'));
  box.appendChild(h('div', 'challenge-text', step.text ?? ''));
  const input = h('input', 'challenge-input') as HTMLInputElement;
  input.autocomplete = 'off';
  input.spellcheck = false;
  guardInput(input);
  const submit = () => void submitAnswer(session, input.value);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  box.append(input, submitButton('Ellenőrzés', submit));
}

function buildDelay(box: HTMLElement, session: SessionInfo, step: StepDisplay): void {
  const d = step.delay!;
  box.appendChild(h('div', 'step-title', `Kötelező várakozás: ${d.minutes} perc`));
  box.appendChild(h('div', 'hint',
    'A visszaszámlálás akkor is megy, ha bezárod az ablakot. Amikor lejár, 10 perced van átvenni a feloldást — ha lecsúszol róla, az egész kísérlet elölről kezdődik.'));
  const countdown = h('div', 'countdown');
  const claimBtn = h('button', 'btn btn-primary step-submit', 'Feloldás átvétele');
  claimBtn.disabled = true;
  claimBtn.addEventListener('click', async () => {
    try {
      const r = await call<SubmitResult>('claim', { sessionId: session.id });
      handleSubmitResult(r, session.kind);
      if (!r.accepted && r.message) setStepMessage(r.message);
    } catch (e) {
      setStepMessage((e as Error).message);
      void refresh();
    }
  });
  box.append(countdown, claimBtn);

  const t = setInterval(() => {
    const now = Date.now();
    const at = d.claimableAt;
    if (at === null) return;
    if (now < at) {
      countdown.textContent = `Átvehető: ${fmtRemain(at - now)} múlva (${fmtClock(at)})`;
      claimBtn.disabled = true;
    } else if (now <= at + d.claimWindowMs) {
      countdown.textContent = `Átvehető még: ${fmtRemain(at + d.claimWindowMs - now)}`;
      claimBtn.disabled = false;
      if (notifiedStepId !== step.id && 'Notification' in window && Notification.permission === 'granted') {
        notifiedStepId = step.id;
        new Notification('Breaker', { body: 'Letelt a várakozás — 10 perced van átvenni a feloldást.' });
      }
    } else {
      countdown.textContent = 'Az átvételi ablak lejárt.';
      claimBtn.disabled = true;
      void refresh();
    }
  }, 500);
  stepTimers.push(t);
}

// ----------------------------------------------------------------- wiring

function setupModal(): void {
  $('abandonBtn').addEventListener('click', async () => {
    const s = status?.session;
    if (s) {
      try { await call('abandon', { sessionId: s.id }); } catch { /* ignore */ }
    }
    closeModal();
    void refresh();
  });
  $('closeModalBtn').addEventListener('click', () => {
    closeModal();
    void refresh();
  });
  $('resumeBtn').addEventListener('click', () => {
    if (status?.session) openModal(status.session);
  });
  // Ez a gomb a HTML-ben megvolt, kezelő nélkül: rákattintva NEM TÖRTÉNT SEMMI.
  // A legcsendesebb hibafajta — a felület hibátlannak látszik, a funkció meg
  // elérhetetlen. A füstteszt most már megnyomja.
  $('focusNewBtn').addEventListener('click', () => openFocusEditor(null));
  // A felső sori jelzés nem csak tájékoztat: odavisz, ahol csinálni lehet vele
  // valamit. Egy jelzés, amire rá lehet kattintani, de nem történik semmi,
  // rosszabb, mint ha ott sem lenne.
  $('focusPill').addEventListener('click', () => setView('focus'));

  for (const tab of Array.from(document.querySelectorAll<HTMLElement>('.tab'))) {
    tab.addEventListener('click', () => setView((tab.dataset.view as ViewName) ?? 'sites'));
  }
  $('accountBtn').addEventListener('click', () => openDrawer('accountPanel', 'accountScrim'));
  $('accountClose').addEventListener('click', () => closeDrawer('accountPanel', 'accountScrim'));
  $('accountScrim').addEventListener('click', () => closeDrawer('accountPanel', 'accountScrim'));
  $('themeBtn').addEventListener('click', () => openDrawer('themePanel', 'themeScrim'));
  $('themeClose').addEventListener('click', () => closeDrawer('themePanel', 'themeScrim'));
  $('themeScrim').addEventListener('click', () => closeDrawer('themePanel', 'themeScrim'));
  $('bgMotion').addEventListener('change', (e) => {
    writePref(MOTION_KEY, (e.target as HTMLInputElement).checked ? 'on' : 'off');
    applyBackground();
  });
  // Az Esc a legfelső réteget zárja. Egy panel, ami csak egérrel csukható be,
  // billentyűzettel csapdába ejt.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('themePanel').classList.contains('hidden')) closeDrawer('themePanel', 'themeScrim');
    else if (!$('accountPanel').classList.contains('hidden')) closeDrawer('accountPanel', 'accountScrim');
  });
  applyBackground();
  setView('sites');
  $('showListBtn').addEventListener('click', () => {
    // Csak erre a munkamenetre nyitjuk meg: a BEÁLLÍTÁS marad „rejtve”.
    listOpenThisSession = true;
    render();
  });
  $('hideListBtn').addEventListener('click', async () => {
    const turningOn = status?.hideSiteList !== true;
    // Bekapcsoláskor rögtön össze is csukjuk; kikapcsoláskor nyitva marad.
    listOpenThisSession = !turningOn;
    try {
      status = await call<StatusData>('set_hide_list', { hidden: turningOn });
    } catch { /* a következő lekérdezés úgyis hozza */ }
    render();
  });
  $('helperStaleBtn').addEventListener('click', async () => {
    // Ugyanaz a telepítő, mint az első indításnál: bootout + bootstrap, tehát
    // a régi démont lecseréli. Egy jelszókérés, újraindítás nélkül.
    const btn = $<HTMLButtonElement>('helperStaleBtn');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Frissítés… (engedélykérés jöhet)';
    const r = await window.breaker.install();
    btn.disabled = false;
    btn.textContent = original;
    if (!r.ok) {
      $('helperStaleText').textContent = `A frissítés nem sikerült: ${r.error}`;
    }
    await refresh();
  });
  for (const btn of $('pauseDialog').querySelectorAll<HTMLButtonElement>('button[data-minutes]')) {
    btn.addEventListener('click', () => void startPause(Number(btn.dataset.minutes)));
  }
  $('pauseCancel').addEventListener('click', () => {
    pendingPauseSiteId = null;
    $('pauseDialog').classList.add('hidden');
  });
}

function setupInstall(): void {
  const btn = $<HTMLButtonElement>('installBtn');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Telepítés… (engedélykérés jöhet)';
    $('installError').classList.add('hidden');
    const r = await window.breaker.install();
    if (!r.ok) {
      $('installError').textContent = r.error;
      $('installError').classList.remove('hidden');
    } else {
      // give the daemon a few seconds to come up
      for (let i = 0; i < 10 && !helperUp; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        await refresh();
      }
    }
    btn.disabled = false;
    btn.textContent = 'Védelem telepítése (egyszeri engedély)';
  });
}

// ------------------------------------------------------------- statistics

let statsData: UsageStatsData | null = null;
let statsBusy = false;

/** Domains currently on the block list — used to mark them in the charts. */
function blockedDomains(): Set<string> {
  return new Set((status?.sites ?? []).map((s) => s.domain));
}

async function refreshStats(): Promise<void> {
  if (statsBusy || !helperUp) return;
  statsBusy = true;
  try {
    statsData = await call<UsageStatsData>('usage_stats');
    // A mérés állapota a fő folyamatból jön (a szonda ott fut), a statisztika a
    // helperből — ugyanabban a körben frissül mind a kettő.
    renderStats();
  } catch {
    // helper busy or down; keep the previous view rather than blanking it
  } finally {
    statsBusy = false;
  }
}

function tile(value: string, label: string): HTMLElement {
  const el = h('div', 'tile');
  el.appendChild(h('div', 'tile-value', value));
  el.appendChild(h('div', 'tile-label', label));
  return el;
}

/**
 * A statisztika sorain is a fedőnév álljon.
 *
 * A segéd a valódi domaint küldi címkeként — nem is tudhat a fedőnévről, mert
 * az felületi dolog. Ha ezt kihagynánk, a felhasználó elrejtené a nevet a
 * listán, aztán néhány sorral lejjebb szembejönne vele a diagramban: a funkció
 * pont annyit érne, mint egy lyukas zsák.
 *
 * A pillanatnyi felfedést itt SZÁNDÉKOSAN nem vesszük figyelembe: az egy adott
 * sor művelete, a statisztika meg ritkábban frissül — a kettő együtt csak
 * villogna.
 */
function statLabel(label: string): string {
  const st = status;
  if (!st) return label;
  const idx = st.sites.findIndex((x) => x.domain === label);
  if (idx < 0) return label;
  const site = st.sites[idx];
  // Rejtett listánál a statisztikában is elfedjük a címet — különben pont az
  // állna itt, amit két kártyával feljebb elrejtettünk, ráadásul „blokkolt”
  // címkével. A sorszám a lista sorrendjéből jön, tehát két frissítés között
  // nem ugrál, és ugyanazt az oldalt mindig ugyanaz a szám jelöli.
  // A fedőnév erősebb: azt épp azért adta meg, hogy AZ látszódjon.
  if (isListHidden(st) && !isAliased(site)) return `${idx + 1}. rejtett oldal`;
  return displayName(site);
}

/** Horizontal bar list: one measure across named targets, so one hue —
 *  the second hue means "this site is on your block list", and every bar
 *  that uses it also carries a written badge (never colour alone). */
function renderBarList(host: HTMLElement, rows: { key: string; label: string; seconds: number }[],
                       emptyEl: HTMLElement | null, markBlocked: boolean): void {
  host.textContent = '';
  // Az üres-szöveg elhagyható: a mai blokk üresen NEM szöveget mutat, hanem
  // eltűnik — egy minden reggel ott álló „még nincs adat” sor csak zaj.
  emptyEl?.classList.toggle('hidden', rows.length > 0);
  if (rows.length === 0) return;
  const max = Math.max(...rows.map((r) => r.seconds), 1);
  const blocked = blockedDomains();
  for (const row of rows) {
    const isBlocked = markBlocked && blocked.has(row.label);
    const wrap = h('div', 'bar-row');
    const name = h('div', 'bar-name', statLabel(row.label));
    if (isBlocked) {
      const badge = h('span', 'badge', 'blokkolt');
      name.appendChild(badge);
    }
    const value = h('div', 'bar-value', formatDuration(row.seconds));
    const track = h('div', 'bar-track');
    const fill = h('div', `bar-fill${isBlocked ? ' blocked' : ''}`);
    fill.style.width = `${Math.max(1, (row.seconds / max) * 100)}%`;
    track.appendChild(fill);
    wrap.append(name, value, track);
    attachTip(wrap, () =>
      `${statLabel(row.label)} — ${formatDuration(row.seconds)}${isBlocked ? ' · blokkolt oldal' : ''}`);
    host.appendChild(wrap);
  }
}

function renderDaily(series: { day: string; seconds: number }[], title: string): void {
  const host = $('dailyChart');
  host.textContent = '';
  $('seriesTitle').textContent = title
    ? `Napi bontás — ${title} (30 nap)`
    : 'Napi bontás (30 nap)';
  const max = Math.max(...series.map((d) => d.seconds), 1);
  for (const d of series) {
    const bar = h('div', `day-bar${d.seconds === 0 ? ' empty' : ''}`);
    bar.style.height = d.seconds === 0 ? '2px' : `${Math.max(3, (d.seconds / max) * 100)}%`;
    attachTip(bar, () => `${d.day} — ${formatDuration(d.seconds)}`);
    host.appendChild(bar);
  }
  $('axisStart').textContent = series[0]?.day ?? '';
  $('axisEnd').textContent = series[series.length - 1]?.day ?? '';
}

/** Shared hover tooltip: hit target is the whole mark, tip follows the cursor. */
function attachTip(el: HTMLElement, text: () => string): void {
  const tip = $('chartTip');
  el.addEventListener('mouseenter', () => {
    tip.textContent = text();
    tip.classList.remove('hidden');
  });
  el.addEventListener('mousemove', (e) => {
    const ev = e as MouseEvent;
    tip.style.left = `${Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${ev.clientY + 16}px`;
  });
  el.addEventListener('mouseleave', () => tip.classList.add('hidden'));
}

/** A legutóbb lekérdezett mérés-állapot; a poll frissíti. */
let trackerState: {
  blocked: boolean; neverWorked: boolean; samplesDropped: boolean; platform: string;
} | null = null;

/**
 * „A mérés be van kapcsolva, de nem kap adatot.”
 *
 * macOS-en az előtér lekérdezéséhez és a böngésző aktív fülének olvasásához
 * engedély kell; az engedélykérő ablak magától jön fel az első méréskor. Ha a
 * felhasználó nemet mond (vagy elkattintja), a szonda csendben üres marad: a
 * statisztika örökre nulla, a napi keret pedig SOSEM fogy el — vagyis a
 * felület védelmet mutatna ott, ahol nincs. Ezért kimondjuk, és megmondjuk,
 * hol lehet megadni.
 */
function renderProbeWarning(measurementOn: boolean): void {
  const el = $('usageBlocked');
  // A KÉZBESÍTÉS hibája előbbre való, mint a szondáé: ha a mért idő eljut a
  // segédig és ott vész el, akkor a szonda dolgozik, tehát a macOS-engedélyre
  // hivatkozó mondat rossz helyre küldené a felhasználót.
  if (measurementOn && trackerState?.samplesDropped) {
    el.classList.remove('hidden');
    el.textContent = 'A mérés fut és lát is adatot, de a mért időt nem sikerül eltárolni: '
      + 'a segéd sorozatban egyetlen mintát sem fogad el. Amíg ez tart, a mai idő '
      + 'nullán marad, és a napi időkeret sem fogy. A részletek a segéd naplójában '
      + 'vannak (macOS: /Library/Logs/Breaker/helper.log).';
    return;
  }
  const show = measurementOn && !!trackerState?.blocked;
  el.classList.toggle('hidden', !show);
  if (!show) return;
  if (trackerState!.platform !== 'darwin') {
    el.textContent = 'A mérés be van kapcsolva, de nem kap adatot az előtérről. '
      + 'Amíg nincs adat, a napi időkeret sem fogy.';
    return;
  }
  const where = 'Rendszerbeállítások → Adatvédelem és biztonság → Automatizálás, ott a '
    + 'Breakernél kapcsold be a „System Events” és a böngésződ sorát.';
  // KÉT KÜLÖN ESET, két külön teendővel. Sokáig ugyanazt a mondatot kapta
  // mind a kettő, pedig a felhasználó dolga más:
  //
  //   - ha MÉG SOHA nem működött, akkor az engedélykérő ablakot kattintotta el
  //     (vagy meg sem jelent), és most kézzel kell megadnia;
  //   - ha KORÁBBAN MŰKÖDÖTT és most nem, akkor jellemzően frissítés történt.
  //     Amíg nincs Apple fejlesztői aláírás, a macOS minden új változatot KÜLÖN
  //     appnak lát, és az automatizálási engedélyt újra kell adni. Aki ezt nem
  //     tudja, csak annyit lát, hogy a mérés „elromlott” — pedig nem az app
  //     hasalt el, hanem a rendszer vette vissza az engedélyt.
  el.textContent = trackerState!.neverWorked
    ? `A mérés be van kapcsolva, de még egyszer sem kapott adatot. macOS-en ehhez `
      + `engedély kell; az engedélykérő ablak az első méréskor jön fel, és ha `
      + `elkattintottad, itt adhatod meg: ${where} Amíg nincs adat, a napi `
      + 'időkeret sem fogy.'
    : `A mérés korábban kapott adatot, most viszont nem. macOS-en ez jellemzően `
      + `FRISSÍTÉS után fordul elő: amíg nincs Apple fejlesztői aláírás, a rendszer `
      + `az új változatot külön appnak látja, és az engedélyt újra kell adni: ${where} `
      + 'Amíg nincs adat, a napi időkeret sem fogy.';
}

/**
 * „Mikor mértünk utoljára?”
 *
 * A statisztikán a nulla önmagában NÉMA. Lehet, hogy tényleg nem használtad a
 * gépet — és lehet, hogy a mérés elhasalt valahol a szonda és a tároló között.
 * A felhasználó ugyanazt a nullát látja mindkettőre, és semmiből nem tudja
 * eldönteni, melyikről van szó.
 *
 * Ez a sor teszi ténnyé: ha ma reggel óta nem került be egyetlen szelet sem,
 * az látszik. Ha viszont fél órája még mértünk, akkor a nulla igaz, és nincs
 * mit keresni. Egyik esetben sem kell naplót olvasni hozzá.
 */
function renderLastSample(measurementOn: boolean): void {
  const el = $('lastSample');
  const at = statsData?.lastSampleAt ?? null;
  if (!measurementOn) { el.textContent = ''; return; }
  if (at === null) {
    el.textContent = 'Még egyetlen mért időt sem rögzítettünk ezen a gépen.';
    return;
  }
  const d = new Date(at);
  const sameDay = new Date().toDateString() === d.toDateString();
  // A DÁTUM is kiírandó, ha nem ma volt. Egy csupasz óraérték „12:41” mellé a
  // szem automatikusan a mai napot képzeli — és pont az a kérdés, hogy ma
  // volt-e egyáltalán.
  el.textContent = sameDay
    ? `Utoljára mért idő: ma ${d.toLocaleTimeString('hu-HU')}.`
    : `Utoljára mért idő: ${d.toLocaleDateString('hu-HU')} ${d.toLocaleTimeString('hu-HU')} `
      + '— azóta a mérés nem rögzített semmit.';
}

/**
 * A munkamenetek összegzése a statisztikán.
 *
 * Az app eddig azt mérte, MIRE megy el az idő. Ez a másik oldal: hányszor
 * ültél le dolgozni, és hányat vittél végig.
 *
 * A „korán leállítva” nem szégyenpad. Aki látja, hogy ötből négyszer leállt,
 * az nem a csomagot fogja hibáztatni, hanem rövidebb menetet indít — és az
 * működni fog. Ezért van kiírva, és ezért van mellé mondat is.
 */
function renderFocusStats(): void {
  const week = statsData?.focusWeek;
  const today = statsData?.focusToday;
  // Nulla menetnél nem mutatunk üres blokkot: egy minden nap ott álló
  // nullás doboz nem információ, csak zaj.
  const show = !!week && week.sessions > 0;
  $('focusStats').classList.toggle('hidden', !show);
  if (!show || !week || !today) return;

  const box = $('focusTiles');
  box.textContent = '';
  box.append(
    tile(String(today.sessions), 'menet ma'),
    tile(formatDuration(Math.round(today.totalMs / 1000)), 'fókuszban ma'),
    tile(String(week.sessions), 'menet a héten'),
    tile(formatDuration(Math.round(week.totalMs / 1000)), 'fókuszban a héten'),
  );

  const parts: string[] = [];
  if (week.topPack) parts.push(`A hét leggyakoribb csomagja: ${week.topPack}.`);
  if (week.stoppedEarly > 0) {
    parts.push(
      `${week.stoppedEarly} menet ért véget a tervezettnél korábban. `
      + 'Ha ez sokszor fordul elő, nem a csomaggal van baj: rövidebb menetet érdemes indítani.',
    );
  } else {
    parts.push('A héten minden menetet végigvittél.');
  }
  // MINDEN ESZKÖZ menete beleszámít, és ezt ki kell mondani. A mérés (mire megy
  // el az idő) eszközönként külön áll, a munkamenet viszont a fiók egészére
  // szól: a telefonon indított menet ugyanúgy menet. Ha a szám erről hallgatna,
  // aki a telefonján dolgozik, azt hinné, hogy az app nem látta.
  parts.push('Minden eszközöd menete beleszámít.');
  $('focusStatsNote').textContent = parts.join(' ');
}

function renderStats(): void {
  const card = $('statsCard');
  card.classList.toggle('hidden', !helperUp);
  if (!helperUp || !statsData) return;
  const s = statsData.summary;

  const enabled = status?.usageEnabled ?? s.enabled;
  $<HTMLButtonElement>('usageToggle').textContent = enabled ? 'Mérés kikapcsolása' : 'Mérés bekapcsolása';
  $('usageOff').classList.toggle('hidden', enabled);
  renderProbeWarning(enabled);
  $('statsBody').classList.toggle('hidden', !enabled && s.daysTracked === 0);

  const tiles = $('statTiles');
  tiles.textContent = '';
  tiles.append(
    tile(formatDuration(s.todaySeconds), 'ma'),
    tile(formatDuration(s.yesterdaySeconds), 'tegnap'),
    tile(formatDuration(s.last7Seconds), 'utolsó 7 nap'),
    tile(formatDuration(s.last30Seconds), 'utolsó 30 nap'),
  );

  renderLastSample(enabled);
  renderFocusStats();

  // A MAI lista vegyes: oldalak és appok együtt, idő szerint. A kérdés itt az,
  // hogy MA mire ment el — a fajta másodlagos. A hétnapos listák maradnak
  // szétszedve, mert ott az összevetés a lényeg. Üresen az egész blokk
  // eltűnik: hogy miért nulla, azt az „utoljára mért idő” sor mondja meg,
  // nem egy üres doboz.
  $('todayBlock').classList.toggle('hidden', s.topToday.length === 0);
  renderBarList($('topToday'), s.topToday, null, true);
  renderBarList($('topSites'), s.topWeekSites, $('topSitesEmpty'), true);
  renderBarList($('topApps'), s.topWeekApps, $('topAppsEmpty'), false);
  $('usageLegend').classList.toggle('hidden', s.topWeekSites.length === 0);
  renderDaily(statsData.focusSeries, statLabel(statsData.focusLabel));

  const wow = $('wowList');
  wow.textContent = '';
  $('wowBlock').classList.toggle('hidden', s.weekOverWeek.length === 0);
  for (const row of s.weekOverWeek) {
    const line = h('div', 'wow-row');
    line.appendChild(h('span', undefined, statLabel(row.label)));
    let text: string;
    let cls: string;
    if (row.deltaPct === null) {
      text = `új — ${formatDuration(row.thisWeek)}`;
      cls = 'wow-delta wow-flat';
    } else {
      const pct = Math.round(row.deltaPct);
      // Dead zone: a couple of percent either way is noise, not a trend, so it
      // stays neutral instead of shouting in red or green.
      const flat = Math.abs(pct) <= 5;
      const arrow = flat ? '＝' : pct > 0 ? '▲' : '▼';
      text = `${arrow} ${pct > 0 ? '+' : ''}${pct}% · ${formatDuration(row.thisWeek)}`;
      cls = `wow-delta ${flat ? 'wow-flat' : pct > 0 ? 'wow-up' : 'wow-down'}`;
    }
    line.appendChild(h('span', cls, text));
    wow.appendChild(line);
  }
}

/**
 * A mérés és a szinkron állapota, EGY beilleszthető szövegben.
 *
 * Miért van rá gomb. A leggyakoribb kérdés ennél a funkciónál az, hogy miért
 * nulla a mai nap — és a válasz mindig ugyanabból a néhány adatból jön ki:
 * be van-e kapcsolva a mérés, lát-e a szonda, eljut-e az idő a tárolóig,
 * mikor mértünk utoljára. Ezt képernyőképekből összerakni fárasztó és
 * pontatlan; így viszont egy beillesztés az egész.
 *
 * AMI SZÁNDÉKOSAN NINCS BENNE: cím, fedőnév, fióknév, kiszolgáló-cím. A
 * szöveget bárhová be lehet illeszteni, tehát nem tartalmazhat olyat, amit a
 * felhasználó nem szánt nyilvánosnak. A blokkolt oldalak SZÁMA még elfér —
 * abból nem derül ki, melyek azok.
 */
function diagnosticsText(): string {
  const st = status;
  const clock = (t?: number | null): string =>
    (t ? new Date(t).toLocaleString('hu-HU') : 'soha');
  const yn = (b: boolean | undefined): string => (b ? 'igen' : 'nem');
  const sum = statsData?.summary;
  return [
    'Breaker — diagnosztika',
    `Idő: ${new Date().toLocaleString('hu-HU')}`,
    `Rendszer: ${window.breaker.platform}`,
    `Segéd verziója: ${st?.helperVersion ?? '—'} (az app ${HELPER_VERSION})`,
    '',
    `Mérés bekapcsolva: ${yn(st?.usageEnabled)}`,
    `Szonda lát-e adatot: ${trackerState ? yn(!trackerState.blocked) : '—'}`,
    `Látott-e valaha: ${trackerState ? yn(!trackerState.neverWorked) : '—'}`,
    `Eldobott mérési minták: ${trackerState ? yn(trackerState.samplesDropped) : '—'}`,
    `Utoljára mért idő: ${clock(statsData?.lastSampleAt)}`,
    `Ma / 7 nap (mp): ${Math.round(sum?.todaySeconds ?? 0)} / ${Math.round(sum?.last7Seconds ?? 0)}`,
    `Mért napok száma: ${sum?.daysTracked ?? 0}`,
    '',
    `Fiók: ${st?.sync ? 'van' : 'nincs'}`,
    `Utolsó sikeres szinkron: ${clock(st?.sync?.lastSyncAt)}`,
    `Utolsó szinkron-próba: ${clock(st?.sync?.lastAttemptAt)}`,
    `Szinkron hibája: ${st?.sync?.lastError ?? '—'}`,
    `Munkamenet-szinkron hibája: ${st?.focusSyncError ?? '—'}`,
    `Csatorna-szűrő-szinkron hibája: ${st?.channelsSyncError ?? '—'}`,
    '',
    `Blokkolt oldalak száma: ${st?.sites?.length ?? 0}`,
    `Munkamenet-csomagok: ${st?.focusPacks?.length ?? 0}`,
    `Csatorna-szűrők száma: ${st?.channelFilters?.length ?? 0}`,
    `Fut-e munkamenet: ${yn(!!st?.focusRun)}`,
    `Védelem (DoH-házirend): ${yn(st?.dohPolicyApplied)}`,
  ].join('\n');
}

function setupStats(): void {
  $('usageToggle').addEventListener('click', async () => {
    const enabled = status?.usageEnabled ?? true;
    try {
      status = await call<StatusData>('usage_enable', { enabled: !enabled });
      await refreshStats();
      render();
    } catch (e) {
      alert((e as Error).message);
    }
  });
  $('usageDiag').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('usageDiag');
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(diagnosticsText());
      btn.textContent = 'Vágólapra másolva';
    } catch {
      // A vágólap megtagadható. Ilyenkor sem maradhat el a szöveg: kiírjuk,
      // hogy legalább kijelölhető legyen — egy néma gomb rosszabb a semminél.
      alert(diagnosticsText());
      btn.textContent = original;
      return;
    }
    setTimeout(() => { btn.textContent = original; }, 2000);
  });
  $('usageClear').addEventListener('click', async () => {
    if (!confirm('Biztosan törlöd a teljes mérési előzményt? Ez nem vonható vissza.')) return;
    try {
      await call('usage_clear');
      await refreshStats();
    } catch (e) {
      alert((e as Error).message);
    }
  });
  void refreshStats();
  setInterval(() => void refreshStats(), 30_000);
}

// ------------------------------------------------------------ auto-update

function renderUpdate(s: UpdateState): void {
  const bar = $('updateBar');
  const text = $('updateText');
  const btn = $<HTMLButtonElement>('updateBtn');
  btn.classList.add('hidden');
  btn.disabled = false;
  switch (s.status) {
    case 'downloading':
      bar.classList.remove('hidden');
      text.textContent = `Frissítés letöltése${s.version ? ` (${s.version})` : ''}… ${s.percent ?? 0}%`;
      break;
    case 'ready':
      bar.classList.remove('hidden');
      text.textContent = `Frissítés kész${s.version ? ` (${s.version})` : ''} — egy kattintás, és újraindulva már az új verzió fut.`;
      // Set the label on every branch: the error branch below changes it, and a
      // later 'ready' state must not inherit "open the download page".
      btn.textContent = 'Újraindítás és frissítés';
      btn.classList.remove('hidden');
      break;
    case 'error':
      // The self-install failed (no write access to the app bundle, a broken
      // download); the manual download always works. Az OKOT is kiírjuk: enélkül
      // egy jogosultsági hiba és egy megszakadt letöltés ugyanúgy néz ki, és
      // nem lehet tudni, érdemes-e újrapróbálni.
      bar.classList.remove('hidden');
      text.textContent = s.error
        ? `Új verzió érhető el a letöltőoldalon. (A frissítés nem sikerült: ${s.error})`
        : 'Új verzió érhető el a letöltőoldalon.';
      btn.textContent = 'Letöltés megnyitása';
      btn.classList.remove('hidden');
      break;
    default:
      bar.classList.add('hidden');
  }
}

function setupUpdater(): void {
  const btn = $<HTMLButtonElement>('updateBtn');
  btn.addEventListener('click', () => {
    // A csere közben az app kilép; egy második kattintás már egy félig
    // kicserélt bundle-re futna. A gomb ezért azonnal letiltja magát, és a
    // következő állapotfrissítés engedi vissza (pl. ha a csere hibára futott).
    btn.disabled = true;
    btn.textContent = 'Frissítés…';
    void window.breaker.installUpdate();
  });
  window.breaker.onUpdateState(renderUpdate);
  void window.breaker.getUpdateState().then(renderUpdate).catch(() => { /* dev build */ });
}

setupAddCard();
setupSyncCard();
setupModal();
setupInstall();
setupUpdater();
setupStats();
setupChannelCard();
if ('Notification' in window && Notification.permission === 'default') {
  void Notification.requestPermission();
}
void refresh();
setInterval(() => void refresh(), 2000);
