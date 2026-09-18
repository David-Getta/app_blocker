// A felugró lap: egy pillantás az app és a bővítmény állapotára.
//
// A tartalmat a `popup-core.js` dönti el (tisztán, tesztekkel); itt csak a
// tárolt kapcsolat-állapotot töltjük be és kirakjuk. A Beállítások gomb a
// beállítási lapra visz — minden, ami módosítás, ott van, itt semmi.

import { CLOSED_FRESH_MS, loadLink, pullFromApp, startFocusInApp } from './app-link.js';
import { describePopup, suggestButton } from './popup-core.js';
import { dayKey, hitsSummary, hitsText, peakNow, peakText, topHost } from './hits.js';

const $ = (id) => document.getElementById(id);

async function render() {
  const link = await loadLink();
  const d = describePopup(link, Date.now(), CLOSED_FRESH_MS);

  const state = $('state');
  state.textContent = d.state.text;
  state.className = `row ${d.state.kind === 'fresh' ? 'ok' : d.state.kind === 'unlinked' ? 'muted' : 'warn'}`;

  const lock = $('lockdown');
  lock.hidden = d.lockdown === null;
  if (d.lockdown) {
    lock.textContent = `${d.lockdown.byWindow ? 'Zárlat a heti ablak szerint' : 'Zárlat'}: még `
      + `${d.lockdown.left}. Amíg tart, feloldás, keret-emelés és `
      + 'szabály-levétel sehol nem indítható — próbatétellel sem.';
  }

  // A megbízott: a lazítás útja az ő jelmondatával ér véget — a felugró lap
  // ugyanazt tudja, amit a tiltó lap.
  const partner = $('partner');
  partner.hidden = d.partner === null;
  if (d.partner) {
    partner.textContent = `Megbízott: ${d.partner} — minden lazító próbatétel utolsó lépése az ő jelmondata.`;
  }

  const focus = $('focus');
  focus.hidden = d.focus === null;
  if (d.focus) {
    focus.textContent = `Munkamenet: ${d.focus.name} — még ${d.focus.left}. `
      + `${d.focus.allowed} cím engedve, minden más tiltva.`
      + (d.focus.window ? ' A heti ablak szerint indult; a vége az ablak vége.' : '');
  }

  // EGY KATTINTÁS a menetig: a javasolt csomag az appból — a gomb csak friss
  // válasz mellett és futó menet nélkül. Szigorítás, ingyen; a bíró dönt.
  const sb = suggestButton(link, Date.now(), CLOSED_FRESH_MS);
  const startBtn = $('startFocus');
  startBtn.hidden = sb === null;
  startBtn.textContent = sb ? sb.text : '';
  startBtn.dataset.packId = sb ? sb.packId : '';
  startBtn.dataset.minutes = sb ? String(sb.minutes) : '';

  const box = $('closedBox');
  const list = $('closedList');
  list.textContent = '';
  box.hidden = !d.fresh;
  if (d.fresh) {
    $('closedTitle').textContent = d.closed.length > 0
      ? 'Most zárva az app szerint:'
      : 'Most semmi sincs zárva az app szerint.';
    for (const c of d.closed) {
      const li = document.createElement('li');
      li.textContent = `${c.host} — ${c.reason}${c.left ? `, még ${c.left}` : ''}`;
      list.appendChild(li);
    }
    const more = $('closedMore');
    more.hidden = d.closedMore === 0;
    more.textContent = d.closedMore > 0 ? `…és még ${d.closedMore} név.` : '';
  }

  $('counts').textContent = `Részleges szabályok: ${d.rules} · Csatorna-szűrők: ${d.channels}`
    + (d.keywords > 0 ? ` · Kulcsszavak: ${d.keywords}` : '');

  // A megakadások: tükör, nem ítélet — a bővítmény saját könyve, nem az appé.
  const hits = $('hits');
  let text = null;
  try {
    const got = await chrome.storage.local.get('breaker.hits');
    const book = got?.['breaker.hits'] ?? { days: {} };
    text = hitsText(hitsSummary(book, dayKey()));
    // MELYIK oldal ma: a nap csúcs-oldala a saját könyvből — pontosan.
    const top = text === null ? null : topHost(book, [dayKey()]);
    if (top) text += ` Ma a legtöbbször: ${top.host} (${top.count}×).`;
    // MIKOR jár a kéz magától: a hét csúcsa — és ha most van, a lap jelöli.
    if (text !== null) text += peakText(peakNow(book, dayKey(), new Date().getHours()));
  } catch { /* tár nélkül nincs szám — a lap többi része attól még áll */ }
  hits.hidden = text === null;
  hits.textContent = text ?? '';
}

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage?.();
  window.close();
});

// A MENET indítása a hídon, aztán friss lehúzás: a lap a futó menetet mutatja,
// nem egy gombot, ami már nem igaz. A bíró nemje a gomb alatt olvasható.
$('startFocus').addEventListener('click', async () => {
  const btn = $('startFocus');
  const note = $('startFocusNote');
  const packId = btn.dataset.packId || '';
  const minutes = Number(btn.dataset.minutes || '0');
  if (!packId || !Number.isInteger(minutes) || minutes <= 0) return;
  btn.disabled = true;
  const r = await startFocusInApp(packId, minutes);
  btn.disabled = false;
  note.hidden = r.ok;
  note.textContent = r.ok ? '' : `Nem indult el: ${r.error}`;
  if (r.ok) {
    try { await pullFromApp(); } catch { /* a következő kör úgyis lehúzza */ }
    await render();
  }
});

void render();
