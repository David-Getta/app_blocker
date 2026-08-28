// A beállítások lapja.
//
// A DOM-ot kézzel építjük, `innerHTML` nélkül. Nem stílusból: a szabály
// szövegét a felhasználó írja be, és ha az bekerülne a lap forrásába, egy
// beillesztett `<img onerror=...>` a bővítmény jogosultságaival futna. Ez a
// lap látja az ÖSSZES szabályt és a tárolót — pont az, amit nem szabad
// kiadni a kezünkből.

import { ruleLabel } from './rules-core.js';
import {
  addRule, cancelRemoval, load, REMOVE_DELAY_MS, startRemoval, sweep,
} from './storage.js';
import { loadLink, pullFromApp, setToken, withAppRules } from './app-link.js';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Mennyi van hátra, emberi alakban. */
function remaining(ms) {
  const min = Math.ceil(ms / 60000);
  return min <= 1 ? 'kevesebb mint egy perc' : `${min} perc`;
}

async function render() {
  await sweep();
  const state = await load();
  const link = await loadLink();
  const now = Date.now();
  renderLink(link);
  const list = $('list');
  list.textContent = '';
  // Az appból jött szabályok ugyanabban a listában állnak: a felhasználót nem
  // érdekli, melyik honnan való — az érdekli, mi van tiltva.
  const rules = withAppRules(state.rules, link.rules)
    .sort((a, b) => ruleLabel(a).localeCompare(ruleLabel(b)));
  $('empty').hidden = rules.length > 0;

  for (const rule of rules) {
    const li = el('li');
    const left = el('div');
    left.appendChild(el('div', 'name', ruleLabel(rule)));
    if (rule.fromApp) {
      left.appendChild(el('div', 'muted', 'A Breaker appból — levenni ott lehet.'));
    } else if (rule.removeAt !== null && rule.removeAt > now) {
      left.appendChild(el('div', 'muted',
        `Levétel ${remaining(rule.removeAt - now)} múlva — addig tilt.`));
    }
    li.appendChild(left);

    if (rule.fromApp) {
      // NINCS gomb. Ha innen is le lehetne szedni, a bővítmény lenne a
      // legegyszerűbb kiskapu az appban: tíz perc egy próbatétel helyett.
      li.appendChild(el('span', 'muted', 'appból'));
    } else if (rule.removeAt !== null && rule.removeAt > now) {
      const keep = el('button', undefined, 'Mégis maradjon');
      keep.addEventListener('click', async () => {
        await cancelRemoval(rule.host, rule.path);
        await render();
      });
      li.appendChild(keep);
    } else {
      const drop = el('button', undefined, 'Levétel');
      drop.addEventListener('click', async () => {
        await startRemoval(rule.host, rule.path);
        await render();
      });
      li.appendChild(drop);
    }
    list.appendChild(li);
  }
}

function renderLink(link) {
  const state = $('linkState');
  if (!link.token) {
    state.textContent = 'Nincs összekötve.';
    return;
  }
  if (link.error) {
    // Kimondjuk, mi a baj. Egy néma „nincs kapcsolat” azt az érzetet keltené,
    // hogy a szabályok is eltűntek — pedig azok érvényben maradnak.
    state.textContent = `${link.error} A legutóbb letöltött ${link.rules.length} szabály érvényben marad.`;
    return;
  }
  const mins = Math.round((Date.now() - link.fetchedAt) / 60000);
  // A csatorna-szűrő is innen jön: ha lejött, mondjuk ki. Enélkül a
  // felhasználó csak a tiltó lapon szembesülne vele, hogy a szűrő itt fut.
  const chan = (link.channels ?? []).length;
  const chanText = chan > 0
    ? `, ${chan} csatorna-szűrő`
    : '';
  state.textContent = `Összekötve — ${link.rules.length} szabály az appból${chanText}, `
    + (mins < 1 ? 'az imént frissítve.' : `${mins} perce frissítve.`);
}

async function onConnect() {
  const value = $('token').value;
  await setToken(value);
  await pullFromApp();
  $('token').value = '';
  await render();
}

async function onAdd() {
  const input = $('input');
  const error = $('error');
  const result = await addRule(input.value);
  if (!result.ok) {
    error.textContent = result.error;
    error.hidden = false;
    return;
  }
  error.hidden = true;
  input.value = '';
  await render();
}

// A várakozás hossza EGY helyen van leírva (storage.js), és onnan kerül a
// szövegbe. Két helyen tartva előbb-utóbb elcsúszna, és a felület mást ígérne,
// mint ami történik.
$('delay').textContent = `${Math.round(REMOVE_DELAY_MS / 60000)} perc`;

$('add').addEventListener('click', () => { void onAdd(); });
$('connect').addEventListener('click', () => { void onConnect(); });
$('token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void onConnect();
});
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void onAdd();
});

// A visszaszámlálás magától fogy; enélkül a lap addig mutatná a régi értéket,
// amíg valaki rá nem frissít — és a felhasználó azt hinné, beragadt.
setInterval(() => { void render(); }, 30_000);
void render();
