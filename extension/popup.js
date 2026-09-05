// A felugró lap: egy pillantás az app és a bővítmény állapotára.
//
// A tartalmat a `popup-core.js` dönti el (tisztán, tesztekkel); itt csak a
// tárolt kapcsolat-állapotot töltjük be és kirakjuk. A Beállítások gomb a
// beállítási lapra visz — minden, ami módosítás, ott van, itt semmi.

import { CLOSED_FRESH_MS, loadLink } from './app-link.js';
import { describePopup } from './popup-core.js';

const $ = (id) => document.getElementById(id);

async function render() {
  const link = await loadLink();
  const d = describePopup(link, Date.now(), CLOSED_FRESH_MS);

  const state = $('state');
  state.textContent = d.state.text;
  state.className = `row ${d.state.kind === 'fresh' ? 'ok' : d.state.kind === 'unlinked' ? 'muted' : 'warn'}`;

  const focus = $('focus');
  focus.hidden = d.focus === null;
  if (d.focus) {
    focus.textContent = `Munkamenet: ${d.focus.name} — még ${d.focus.left}. `
      + `${d.focus.allowed} cím engedve, minden más tiltva.`;
  }

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

  $('counts').textContent = `Részleges szabályok: ${d.rules} · Csatorna-szűrők: ${d.channels}`;
}

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage?.();
  window.close();
});

void render();
