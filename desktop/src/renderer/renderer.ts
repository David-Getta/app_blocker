// Lakat GUI logic. Pure view layer: every decision (challenge content,
// validation, timing) is made by the privileged helper; this file only renders
// and forwards answers.

import type {
  SessionInfo, SiteInfo, StatusData, StepDisplay, SubmitResult,
} from '../shared/protocol';

interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'unsupported';
  version?: string;
  percent?: number;
  error?: string;
}
interface Bridge {
  call(op: string, payload?: Record<string, unknown>): Promise<
    { ok: true; data: unknown } | { ok: false; error: string; code?: string }>;
  install(): Promise<{ ok: true } | { ok: false; error: string }>;
  checkUpdate(): Promise<{ ok: boolean; error?: string }>;
  installUpdate(): Promise<{ ok: boolean; opened?: boolean }>;
  getUpdateState(): Promise<UpdateState>;
  onUpdateState(cb: (s: UpdateState) => void): void;
  platform: string;
}
declare global { interface Window { lakat: Bridge } }

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
  const r = await window.lakat.call(op, payload);
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

async function refresh(): Promise<void> {
  try {
    status = await call<StatusData>('status');
    helperUp = true;
  } catch {
    helperUp = false;
    status = null;
  }
  render();
}

// ---------------------------------------------------------------- render

function render(): void {
  const pill = $('statusPill');
  if (!helperUp) {
    pill.textContent = 'A védelem nincs telepítve';
    pill.className = 'pill pill-warn';
  } else {
    const n = status!.sites.length;
    pill.textContent = n > 0 ? `Védelem aktív — ${n} oldal blokkolva` : 'Védelem aktív';
    pill.className = 'pill pill-ok';
  }

  $('installCard').classList.toggle('hidden', helperUp);
  $('addCard').classList.toggle('hidden', !helperUp);
  $('listCard').classList.toggle('hidden', !helperUp);
  $('tierLine').classList.toggle('hidden', !helperUp);

  if (!helperUp) {
    closeModal();
    return;
  }

  renderSiteList(status!);
  renderTier(status!);
  renderResumeBanner(status!);
  if (modalOpen) renderSession(status!.session);
}

function renderTier(st: StatusData): void {
  const names = ['alap', 'emelt', 'magas', 'maximális'];
  $('tierLine').textContent =
    `Próbatétel-nehézség: ${names[st.tier]} (${st.tier + 1}/4) · ${st.unlocks7d} feloldás az elmúlt 7 napban — minél többször oldasz fel, annál nehezebb.`;
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
  const main = h('div', 'site-main');
  main.appendChild(h('div', 'site-domain', site.domain));
  main.appendChild(h('div', 'site-sub', `${site.hostnames.length} hosztnév · felvéve: ${new Date(site.addedAt).toLocaleDateString('hu-HU')}`));

  const now = st.now;
  const statusEl = h('div', 'site-status');
  const actions = h('div', 'site-actions');

  const paused = site.pauseUntil !== null && site.pauseUntil > now;
  const deleting = site.pendingDeleteAt !== null;

  if (paused) {
    const p = h('span', 'pill pill-warn', `Szünetel még ${fmtRemain(site.pauseUntil! - now)}`);
    statusEl.appendChild(p);
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
    statusEl.appendChild(h('span', 'pill pill-ok', 'Blokkolva'));
    if (!st.session) {
      const unlock = h('button', 'btn btn-small', 'Feloldás időre…');
      unlock.addEventListener('click', () => openPauseDialog(site.id));
      const del = h('button', 'btn btn-small btn-danger', 'Végleges törlés…');
      del.addEventListener('click', () => void startDelete(site));
      actions.append(unlock, del);
    }
  }

  main.appendChild(statusEl);
  row.append(main, actions);
  return row;
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
    `Jegyezd meg a kódot! ${Math.round(mem.showMs / 1000)} mp múlva eltűnik, majd ${Math.round(mem.waitMs / 1000)} mp várakozás után emlékezetből kell beírni.`);
  const codeEl = h('div', 'big-code', mem.code);
  const countdown = h('div', 'countdown');
  box.append(phaseHint, codeEl, countdown);

  const showDeadline = Date.now() + mem.showMs;
  let inputBuilt = false;
  const t = setInterval(() => {
    const now = Date.now();
    if (now < showDeadline) {
      countdown.textContent = `Eltűnik: ${fmtRemain(showDeadline - now)}`;
      return;
    }
    codeEl.textContent = '• • • • •';
    const waitDeadline = showDeadline + mem.waitMs;
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
        new Notification('Lakat', { body: 'Letelt a várakozás — 10 perced van átvenni a feloldást.' });
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
    const r = await window.lakat.install();
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

// ------------------------------------------------------------ auto-update

function renderUpdate(s: UpdateState): void {
  const bar = $('updateBar');
  const text = $('updateText');
  const btn = $<HTMLButtonElement>('updateBtn');
  btn.classList.add('hidden');
  switch (s.status) {
    case 'downloading':
      bar.classList.remove('hidden');
      text.textContent = `Frissítés letöltése${s.version ? ` (${s.version})` : ''}… ${s.percent ?? 0}%`;
      break;
    case 'ready':
      bar.classList.remove('hidden');
      text.textContent = `Frissítés kész${s.version ? ` (${s.version})` : ''} — újraindításkor települ.`;
      btn.classList.remove('hidden');
      break;
    case 'error':
      // Unsigned macOS builds cannot self-install; offer the manual download.
      bar.classList.remove('hidden');
      text.textContent = 'Új verzió érhető el a letöltőoldalon.';
      btn.textContent = 'Letöltés megnyitása';
      btn.classList.remove('hidden');
      break;
    default:
      bar.classList.add('hidden');
  }
}

function setupUpdater(): void {
  const btn = $<HTMLButtonElement>('updateBtn');
  btn.addEventListener('click', () => void window.lakat.installUpdate());
  window.lakat.onUpdateState(renderUpdate);
  void window.lakat.getUpdateState().then(renderUpdate).catch(() => { /* dev build */ });
}

setupAddCard();
setupModal();
setupInstall();
setupUpdater();
if ('Notification' in window && Notification.permission === 'default') {
  void Notification.requestPermission();
}
void refresh();
setInterval(() => void refresh(), 2000);
