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
import { HELPER_VERSION } from '../shared/protocol.js';
import type { SetLimitResult, UsageStatsData } from '../shared/protocol';

interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'unsupported';
  version?: string;
  percent?: number;
  error?: string;
  /** the app applies the update itself (unsigned macOS build) */
  selfManaged?: boolean;
}
interface Bridge {
  call(op: string, payload?: Record<string, unknown>): Promise<
    { ok: true; data: unknown } | { ok: false; error: string; code?: string }>;
  install(): Promise<{ ok: true } | { ok: false; error: string }>;
  checkUpdate(): Promise<{ ok: boolean; error?: string }>;
  installUpdate(): Promise<{ ok: boolean; opened?: boolean }>;
  getUpdateState(): Promise<UpdateState>;
  getTrackerState(): Promise<{ blocked: boolean; neverWorked: boolean; platform: string }>;
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
  $('tierLine').classList.toggle('hidden', !helperUp);

  if (!helperUp) {
    // Keep an open challenge modal alive: the session (and the user's typed
    // answer) survives a helper restart, closing it would throw work away.
    return;
  }

  renderSiteList(status!);
  renderTier(status!);
  renderLegacyHelperBanner(status!);
  renderHelperStaleBanner(status!);
  renderProbeWarning(status!.usageEnabled);
  renderResumeBanner(status!);
  if (modalOpen) renderSession(status!.session);
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
      `Folyamatban lévő ${st.session.kind === 'delete' ? 'törlési' : 'feloldási'} kísérlet: ${site?.domain ?? ''} (${st.session.stepIndex + 1}/${st.session.stepCount}. próba)`;
  }
}

function renderSiteList(st: StatusData): void {
  const list = $('siteList');
  list.textContent = '';
  $('emptyList').classList.toggle('hidden', st.sites.length > 0);
  for (const site of st.sites) list.appendChild(siteRow(site, st));
}

function siteRow(site: SiteInfo, st: StatusData): HTMLElement {
  const row = h('div', 'site-row');
  // Fejléc: a NÉV és az ÁLLAPOT egy sorban, mert ez a két dolog kell ránézésre.
  // Minden más (mérő, műveletek) ez alá kerül, halványabban.
  const head = h('div', 'site-head');
  const ident = h('div', 'site-ident');
  ident.appendChild(h('div', 'site-domain', site.domain));
  ident.appendChild(h('div', 'site-sub', `${site.hostnames.length} hosztnév · felvéve: ${new Date(site.addedAt).toLocaleDateString('hu-HU')}`));
  head.appendChild(ident);

  const now = st.now;
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
      const unlock = h('button', 'btn btn-small', 'Feloldás időre…');
      unlock.addEventListener('click', () => openPauseDialog(site.id));
      const sched = h('button', 'btn btn-small', 'Menetrend…');
      sched.addEventListener('click', () => openScheduleDialog(site));
      const limit = h('button', 'btn btn-small', 'Napi keret…');
      limit.addEventListener('click', () => openLimitDialog(site));
      const del = h('button', 'btn btn-small btn-danger', 'Végleges törlés…');
      del.addEventListener('click', () => void startDelete(site));
      actions.append(unlock, sched, limit, del);
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
  const bar = h('div', 'limit-bar');
  const fill = h('div', site.limitExhausted ? 'limit-fill limit-fill-full' : 'limit-fill');
  fill.style.width = `${Math.min(100, pct)}%`;
  bar.appendChild(fill);
  wrap.appendChild(bar);
  return wrap;
}

const LIMIT_CHOICES_MIN = [10, 20, 30, 45, 60, 90, 120];

function openLimitDialog(site: SiteInfo): void {
  const overlay = h('div', 'overlay');
  const modal = h('div', 'modal modal-small');
  modal.appendChild(h('h3', undefined, `Napi keret: ${site.domain}`));
  modal.appendChild(h('p', 'hint',
    'Ha a mai aktív idő eléri a keretet, az oldal a nap hátralévő részére ' +
    'magától visszazár, éjfélkor pedig a keret újraindul. Keretet bevezetni ' +
    'vagy csökkenteni azonnal megy; emelni vagy megszüntetni ugyanúgy ' +
    'próbatételekbe kerül, mint egy feloldás.'));

  let chosen: number | null = site.dailyLimitSeconds ?? null;
  const choices = h('div', 'pause-choices');
  const buttons: HTMLButtonElement[] = [];
  const mark = () => {
    for (const b of buttons) {
      const value = b.dataset.seconds === '' ? null : Number(b.dataset.seconds);
      b.classList.toggle('btn-primary', value === chosen);
    }
  };
  for (const min of LIMIT_CHOICES_MIN) {
    const b = h('button', 'btn', `${min} perc`) as HTMLButtonElement;
    b.dataset.seconds = String(min * 60);
    b.addEventListener('click', () => { chosen = min * 60; mark(); });
    buttons.push(b);
    choices.appendChild(b);
  }
  const none = h('button', 'btn', 'Nincs keret') as HTMLButtonElement;
  none.dataset.seconds = '';
  none.addEventListener('click', () => { chosen = null; mark(); });
  buttons.push(none);
  choices.appendChild(none);
  mark();

  const err = h('p', 'error');
  err.classList.add('hidden');
  const apply = h('button', 'btn btn-primary', 'Alkalmaz');
  apply.addEventListener('click', async () => {
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
  modal.append(choices, err, actions);
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

function setupAddCard(): void {
  const chips = $('presetChips');
  for (const name of ['youtube.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'x.com', 'reddit.com', 'twitch.tv', 'netflix.com']) {
    const chip = h('button', 'chip', name);
    chip.type = 'button';
    chip.addEventListener('click', () => void addSite(name));
    chips.appendChild(chip);
  }
  $('addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('addInput');
    if (input.value.trim()) void addSite(input.value);
  });
}

async function addSite(value: string): Promise<void> {
  const errEl = $('addError');
  errEl.classList.add('hidden');
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
  modal.appendChild(h('h3', undefined, `Menetrend: ${site.domain}`));
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
    `Biztosan törölnéd a(z) ${site.domain} blokkolását?\n\n` +
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
  $('sessionTitle').textContent = session.kind === 'delete'
    ? `Végleges törlés: ${site?.domain ?? ''}`
    : `Feloldás ${session.minutes} percre: ${site?.domain ?? ''}`;
  $('sessionProgress').textContent = `${session.stepIndex + 1}/${session.stepCount}. próba`;
  $('sessionSubtitle').textContent = session.kind === 'delete'
    ? 'A próbák teljesítése után a törlés még 24 órát vár — addig visszavonható.'
    : 'A próbák teljesítése után az oldal a választott ideig elérhető, majd magától visszazár.';

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

/** Horizontal bar list: one measure across named targets, so one hue —
 *  the second hue means "this site is on your block list", and every bar
 *  that uses it also carries a written badge (never colour alone). */
function renderBarList(host: HTMLElement, rows: { key: string; label: string; seconds: number }[],
                       emptyEl: HTMLElement, markBlocked: boolean): void {
  host.textContent = '';
  emptyEl.classList.toggle('hidden', rows.length > 0);
  if (rows.length === 0) return;
  const max = Math.max(...rows.map((r) => r.seconds), 1);
  const blocked = blockedDomains();
  for (const row of rows) {
    const isBlocked = markBlocked && blocked.has(row.label);
    const wrap = h('div', 'bar-row');
    const name = h('div', 'bar-name', row.label);
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
      `${row.label} — ${formatDuration(row.seconds)}${isBlocked ? ' · blokkolt oldal' : ''}`);
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
let trackerState: { blocked: boolean; neverWorked: boolean; platform: string } | null = null;

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
  const show = measurementOn && !!trackerState?.blocked;
  el.classList.toggle('hidden', !show);
  if (!show) return;
  el.textContent = trackerState!.platform === 'darwin'
    ? 'A mérés be van kapcsolva, de nem kap adatot. macOS-en ehhez engedély kell: '
      + 'Rendszerbeállítások → Adatvédelem és biztonság → Automatizálás, ott a '
      + 'Breakernél kapcsold be a „System Events” és a böngésződ sorát. '
      + 'Amíg nincs adat, a napi időkeret sem fogy.'
    : 'A mérés be van kapcsolva, de nem kap adatot az előtérről. '
      + 'Amíg nincs adat, a napi időkeret sem fogy.';
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

  renderBarList($('topSites'), s.topWeekSites, $('topSitesEmpty'), true);
  renderBarList($('topApps'), s.topWeekApps, $('topAppsEmpty'), false);
  $('usageLegend').classList.toggle('hidden', s.topWeekSites.length === 0);
  renderDaily(statsData.focusSeries, statsData.focusLabel);

  const wow = $('wowList');
  wow.textContent = '';
  $('wowBlock').classList.toggle('hidden', s.weekOverWeek.length === 0);
  for (const row of s.weekOverWeek) {
    const line = h('div', 'wow-row');
    line.appendChild(h('span', undefined, row.label));
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
setupModal();
setupInstall();
setupUpdater();
setupStats();
if ('Notification' in window && Notification.permission === 'default') {
  void Notification.requestPermission();
}
void refresh();
setInterval(() => void refresh(), 2000);
