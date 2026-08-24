// A gyorsbillentyűs réteg logikája.
//
// Két állapota van, és mindig pontosan az egyik látszik:
//
//   1. NEM FUT munkamenet -> a csomagok listája, számbillentyűvel indíthatóan;
//   2. FUT -> mennyi van hátra, és mit lehet vele csinálni.
//
// A réteg SEMMIT NEM OLD FEL. A leállítás gombja csak megnyitja az appot, ahol
// a próbatétel van — ha innen menne, a munkamenet egy billentyűkombináció
// lenne, és pont az a lényeg, hogy ne az legyen.

import { formatRemaining, SESSION_CHOICES_MIN, type FocusPack, type FocusRun } from '../shared/focus.js';

/**
 * Amit a rétegnek a hídból ismernie kell.
 *
 * SZÁNDÉKOSAN nem a `renderer.ts` globális deklarációját használjuk: a két fájl
 * ugyanabban a projektben van, és két különböző `Window.breaker` deklaráció
 * fordítási hiba. A réteg amúgy is csak két dolgot hív.
 */
interface OverlayBridge {
  call(op: string, payload?: Record<string, unknown>): Promise<
    { ok: true; data: unknown } | { ok: false; error: string; code?: string }>;
  hideOverlay(): Promise<void>;
}
const bridge = (window as unknown as { breaker: OverlayBridge }).breaker;

interface Status {
  focusPacks: FocusPack[];
  focusRun: FocusRun | null;
  now: number;
}

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

function h(tag: string, cls?: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

async function call<T>(op: string, payload?: Record<string, unknown>): Promise<T> {
  const r = await bridge.call(op, payload);
  if (!r.ok) throw new Error(r.error);
  return r.data as T;
}

let status: Status | null = null;
/** Melyik csomagnál tartunk a hossz-választásban (null = még a listánál). */
let choosing: FocusPack | null = null;

function close(): void {
  void bridge.hideOverlay();
}

function render(): void {
  const body = $('body');
  const foot = $('foot');
  body.textContent = '';
  foot.textContent = '';

  if (!status) {
    body.appendChild(h('p', 'empty', 'Nincs kapcsolat a háttérszolgáltatással.'));
    return;
  }

  const run = status.focusRun;
  if (run && run.endsAt > Date.now()) {
    $('kicker').textContent = 'Fut';
    const pack = status.focusPacks.find((p) => p.id === run.packId);
    $('title').textContent = pack?.name ?? 'Munkamenet';

    const box = h('div', 'running');
    const left = h('div', 'left');
    left.appendChild(h('span', 'dot'));
    left.append(document.createTextNode(formatRemaining(run.endsAt - Date.now())));
    box.appendChild(left);
    box.appendChild(h('div', 'what',
      pack && pack.allowSites.length + pack.allowApps.length > 0
        ? `Most csak ez mehet: ${[...pack.allowSites, ...pack.allowApps].join(', ')}`
        : 'Ebben a csomagban nincs engedélyezett tétel — minden tiltva.'));
    body.appendChild(box);

    const row = h('div', 'mins');
    for (const min of [15, 30, 60]) {
      const b = h('button', undefined, `+${min} perc`);
      b.addEventListener('click', () => void extend(min));
      row.appendChild(b);
    }
    const stop = h('button', 'ghost', 'Leállítás…');
    stop.addEventListener('click', () => {
      // Az appban van a próbatétel. Innen nem lehet leállítani, mert akkor a
      // munkamenet egy billentyűkombináció lenne.
      close();
      void call('status');
    });
    row.appendChild(stop);
    body.appendChild(row);

    foot.textContent = 'Hosszabbítani ingyen van. Leállítani az appban lehet, próbatétellel.';
    return;
  }

  $('kicker').textContent = 'Munkamenet';
  if (choosing) {
    $('title').textContent = choosing.name;
    const box = h('div', 'running');
    box.appendChild(h('div', 'what', 'Meddig tartson?'));
    body.appendChild(box);
    const row = h('div', 'mins');
    for (const min of SESSION_CHOICES_MIN) {
      const b = h('button', min === choosing.defaultMinutes ? 'primary' : undefined, `${min} perc`);
      b.addEventListener('click', () => void start(choosing as FocusPack, min));
      row.appendChild(b);
    }
    const back = h('button', 'ghost', 'Vissza');
    back.addEventListener('click', () => { choosing = null; render(); });
    row.appendChild(back);
    body.appendChild(row);
    foot.textContent = 'Indítani ingyen van — a munkamenet alatt minden más tiltva.';
    return;
  }

  $('title').textContent = 'Most csak ez mehet';
  if (status.focusPacks.length === 0) {
    body.appendChild(h('p', 'empty',
      'Még nincs csomagod. Az appban tudsz felvenni egyet: adsz neki nevet, és '
      + 'felsorolod, mi mehet alatta.'));
    foot.textContent = 'A csomag fehérlista: ami nincs rajta, az a munkamenet alatt tiltva.';
    return;
  }

  const list = h('div', 'packs');
  status.focusPacks.forEach((pack, i) => {
    const row = h('div', 'pack');
    row.tabIndex = 0;
    const left = h('div');
    left.appendChild(h('div', 'pack-name', pack.name));
    const items = [...pack.allowSites, ...pack.allowApps];
    left.appendChild(h('div', 'pack-sub',
      items.length ? `${items.slice(0, 4).join(', ')}${items.length > 4 ? '…' : ''}`
        : 'nincs engedélyezett tétel'));
    row.appendChild(left);
    // Számbillentyű: a réteg egy másodpercet kap, és az egérhez nyúlni fél
    // másodperc. Az első kilenc csomag így egyetlen leütéssel indul.
    if (i < 9) row.appendChild(h('div', 'pack-key', String(i + 1)));
    const open = (): void => { choosing = pack; render(); };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') open();
    });
    list.appendChild(row);
  });
  body.appendChild(list);
  foot.textContent = 'Válassz számbillentyűvel, vagy kattints. Az Esc bezárja.';
}

async function start(pack: FocusPack, minutes: number): Promise<void> {
  try {
    status = await call<Status>('focus_start', { packId: pack.id, minutes });
    choosing = null;
    render();
  } catch (e) {
    $('foot').textContent = (e as Error).message;
  }
}

async function extend(minutes: number): Promise<void> {
  if (!status?.focusRun) return;
  try {
    const r = await call<{ status: Status }>('focus_change', {
      endsAt: status.focusRun.endsAt + minutes * 60_000,
    });
    status = r.status;
    render();
  } catch (e) {
    $('foot').textContent = (e as Error).message;
  }
}

async function refresh(): Promise<void> {
  try {
    status = await call<Status>('status');
  } catch {
    status = null;
  }
  render();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { close(); return; }
  if (choosing || !status) return;
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= 9) {
    const pack = status.focusPacks[n - 1];
    if (pack) { choosing = pack; render(); }
  }
});

$('scrim').addEventListener('click', (e) => {
  // Csak a háttérre kattintva zár; a lapon belül ne csukódjon be véletlenül.
  if (e.target === $('scrim')) close();
});

// A réteg minden megnyitáskor újratölti magát (az ablak `show`-ra fókuszt kap),
// és amíg látszik, másodpercenként frissül: a hátralévő idő nem állhat meg.
void refresh();
setInterval(() => { if (status?.focusRun) render(); }, 1000);
window.addEventListener('focus', () => { void refresh(); });
