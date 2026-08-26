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

import {
  formatRemaining, MAX_SESSION_MINUTES, SESSION_CHOICES_MIN,
  type FocusPack, type FocusRun,
} from '../shared/focus.js';

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
  showMain(): Promise<void>;
  getOverlayState(): Promise<{
    shortcutOk: boolean; warnApp: string | null; extensionStale?: boolean;
  }>;
}
const bridge = (window as unknown as { breaker: OverlayBridge }).breaker;

interface Status {
  focusPacks: FocusPack[];
  focusRun: FocusRun | null;
  now: number;
}

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

/**
 * A lábjegyzet szövege, ha a fehérlistát ITT nem érvényesíti senki.
 *
 * A lábjegyzetbe kerül, nem külön sorba: a réteg lényege, hogy egy pillantás
 * alatt átlátható, és egy plusz doboz pont attól venné el. A `null` azt
 * jelenti, hogy minden rendben — olyankor a szokásos mondat áll ott.
 */
function extWarning(): string | null {
  if (!extensionStale) return null;
  return 'A böngésző-bővítmény nincs összekötve — a fehérlistát a gépen ő '
    + 'érvényesíti, enélkül a böngészőben nem tilt semmit. A blokklista él.';
}

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
/**
 * Ha van, a réteg NEM a csomaglistát mutatja, hanem azt, hogy ez az app nincs
 * a listán. Az appokat nem tudjuk letiltani — egy futó programot nem lövünk ki
 * —, de szólni tudunk.
 */
let warnApp: string | null = null;
/**
 * Nincs összekötve a böngésző-bővítmény.
 *
 * A gépen a munkamenet fehérlistáját KIZÁRÓLAG ő tudja betartatni: a DNS a
 * hosztnévnél tovább nem lát. Enélkül az indítás csendben nem tilt semmit a
 * böngészőben — és épp ez a réteg az, ahonnan a legtöbben indítanak.
 */
let extensionStale = false;
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

  if (warnApp && run && run.endsAt > Date.now()) {
    const pack = status.focusPacks.find((p) => p.id === run.packId);
    $('kicker').textContent = 'Nincs a listán';
    $('title').textContent = warnApp;
    const box = h('div', 'running');
    box.appendChild(h('div', 'what',
      `Most ${pack?.name ?? 'egy munkamenet'} fut — ez az app nincs benne. `
      + `Még ${formatRemaining(run.endsAt - Date.now())} van hátra.`));
    box.appendChild(h('div', 'what',
      'Bezárni nem tudjuk helyetted, és nem is fogjuk: egy futó program adatot '
      + 'veszíthet. Ezt a döntést neked kell meghoznod.'));
    body.appendChild(box);
    const row = h('div', 'mins');
    const ok = h('button', 'primary', 'Értem');
    ok.addEventListener('click', () => { warnApp = null; close(); });
    row.appendChild(ok);
    body.appendChild(row);
    foot.textContent = 'A böngészőben a fehérlista tényleg tilt; az appoknál csak szólni tudunk.';
    return;
  }

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
      // munkamenet egy billentyűkombináció lenne — a gomb tehát ELŐHOZZA az
      // appot, nem csak bezárja a réteget.
      void bridge.showMain();
    });
    row.appendChild(stop);
    body.appendChild(row);

    foot.textContent = extWarning()
      ?? 'Hosszabbítani ingyen van. Leállítani az appban lehet, próbatétellel.';
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
    body.appendChild(row);

    // Percre pontos hossz a rétegben is. A gyorsgombok a gyakori esetek; ez
    // pedig az, amikor a felhasználó tudja, hogy 43 perce van ebédig. Ha csak
    // az appban lenne meg, a réteg éppen a sietős esetben lenne rosszabb.
    const exact = h('div', 'mins');
    const field = h('input', 'mins-field') as HTMLInputElement;
    field.type = 'number';
    field.min = '1';
    field.max = String(MAX_SESSION_MINUTES);
    field.step = '1';
    field.value = String(choosing.defaultMinutes);
    field.setAttribute('aria-label', 'hossz percben');
    const go = (): void => {
      const n = Number(field.value);
      if (!Number.isFinite(n) || n < 1) {
        foot.textContent = `Írj be egy hosszat percben (1–${MAX_SESSION_MINUTES}).`;
        return;
      }
      void start(choosing as FocusPack, Math.min(Math.round(n), MAX_SESSION_MINUTES));
    };
    field.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent;
      // Az Esc MINDIG a rétegé: ha itt is elnyelnénk, a mezőből nem lehetne
      // kilépni billentyűvel — pont abban a rétegben, aminek a lényege, hogy
      // egy mozdulattal jön és megy.
      if (ev.key === 'Escape') return;
      // A réteg számbillentyűs indítása globális; a többi leütés a mezőé.
      ev.stopPropagation();
      if (ev.key === 'Enter') go();
    });
    exact.appendChild(field);
    const startBtn = h('button', 'primary', 'Indítás');
    startBtn.addEventListener('click', go);
    exact.appendChild(startBtn);
    const back = h('button', 'ghost', 'Vissza');
    back.addEventListener('click', () => { choosing = null; render(); });
    exact.appendChild(back);
    body.appendChild(exact);

    foot.textContent = extWarning()
      ?? 'Indítani ingyen van — a munkamenet alatt minden más tiltva.';
    return;
  }

  $('title').textContent = 'Most csak ez mehet';
  if (status.focusPacks.length === 0) {
    body.appendChild(h('p', 'empty',
      'Még nincs csomagod. Az appban tudsz felvenni egyet: adsz neki nevet, és '
      + 'felsorolod, mi mehet alatta.'));
    // Idáig ez zsákutca volt: a réteg megmondta, hogy az appban kell csinálni
    // valamit, de nem vitt oda — a felhasználónak magától kellett rájönnie,
    // hogy előbb be kell zárnia, aztán megkeresnie az ablakot.
    const row = h('div', 'mins');
    const open = h('button', 'primary', 'Csomag felvétele az appban');
    open.addEventListener('click', () => { void bridge.showMain(); });
    row.appendChild(open);
    body.appendChild(row);
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
  try {
    // Egyszer olvasható: ha a réteg máskor is előjön, ne a régi figyelmeztetés
    // fogadja.
    const st = await bridge.getOverlayState();
    if (st.warnApp) warnApp = st.warnApp;
    extensionStale = st.extensionStale === true;
  } catch { /* a réteg enélkül is használható */ }
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
