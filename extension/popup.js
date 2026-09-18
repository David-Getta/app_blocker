// A felugró lap: egy pillantás az app és a bővítmény állapotára.
//
// A tartalmat a `popup-core.js` dönti el (tisztán, tesztekkel); itt csak a
// tárolt kapcsolat-állapotot töltjük be és kirakjuk. A Beállítások gomb a
// beállítási lapra visz — minden, ami módosítás, ott van, itt semmi.

import { CLOSED_FRESH_MS, addFocusWindowInApp, loadLink, pullFromApp, startFocusInApp } from './app-link.js';
import { describePopup, focusDayText, hourSpan, peakCoverText, suggestButton, windowButton } from './popup-core.js';
import { dayKey, hitsSummary, hitsText, peakDayNow, peakDayNowText, peakNow, peakText, topHost } from './hits.js';

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
  // A MENET-NAP: ma szoktál leülni — az app szava, frissen; a gomb mellett.
  const fd = focusDayText(link, Date.now(), CLOSED_FRESH_MS);
  $('focusDayNote').hidden = fd === '';
  $('focusDayNote').textContent = fd.trim();
  // ABLAK A CSÚCS-ÓRÁRA: ugyanazok a kapuk, és az app mondja, van-e mire.
  const wb = windowButton(link, Date.now(), CLOSED_FRESH_MS);
  const winBtn = $('peakWindow');
  winBtn.hidden = wb === null;
  winBtn.textContent = wb ? wb.text : '';
  winBtn.dataset.packId = wb ? wb.packId : '';
  winBtn.dataset.hour = wb ? String(wb.hour) : '';

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
    // LE VAN-E FEDVE: ha egy csomag ablaka fedi a csúcs-órát, a lap kimondja — az app szava.
    if (text !== null) text += peakText(peakNow(book, dayKey(), new Date().getHours())) + peakCoverText(link, Date.now(), CLOSED_FRESH_MS);
    // A CSÚCS-NAPON a lap azt is mondja, hogy ma van — a saját könyvből, csak elég mintából.
    if (text !== null) text += peakDayNowText(peakDayNow(book, dayKey(), new Date().getDay()));
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

// A HETI ABLAK felvétele a hídon, aztán friss lehúzás: az app javaslata már
// ablakos csomagot mond, a gomb eltűnik, a sor kimondja, hogy megvan.
$('peakWindow').addEventListener('click', async () => {
  const btn = $('peakWindow');
  const note = $('peakWindowNote');
  const packId = btn.dataset.packId || '';
  const hour = Number(btn.dataset.hour || '-1');
  if (!packId || !Number.isInteger(hour) || hour < 0 || hour > 23) return;
  btn.disabled = true;
  const r = await addFocusWindowInApp(packId, hour);
  btn.disabled = false;
  note.hidden = false;
  note.textContent = r.ok
    ? `Megvan: minden nap ${hourSpan(hour)} magától indul — levenni az appban, próbatétellel.`
    : `Nem került fel: ${r.error}`;
  if (r.ok) {
    try { await pullFromApp(); } catch { /* a következő kör úgyis lehúzza */ }
    await render();
  }
});

void render();
