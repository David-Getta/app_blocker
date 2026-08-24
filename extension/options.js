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
  const now = Date.now();
  const list = $('list');
  list.textContent = '';
  const rules = [...state.rules].sort((a, b) => ruleLabel(a).localeCompare(ruleLabel(b)));
  $('empty').hidden = rules.length > 0;

  for (const rule of rules) {
    const li = el('li');
    const left = el('div');
    left.appendChild(el('div', 'name', ruleLabel(rule)));
    if (rule.removeAt !== null && rule.removeAt > now) {
      left.appendChild(el('div', 'muted',
        `Levétel ${remaining(rule.removeAt - now)} múlva — addig tilt.`));
    }
    li.appendChild(left);

    if (rule.removeAt !== null && rule.removeAt > now) {
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
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void onAdd();
});

// A visszaszámlálás magától fogy; enélkül a lap addig mutatná a régi értéket,
// amíg valaki rá nem frissít — és a felhasználó azt hinné, beragadt.
setInterval(() => { void render(); }, 30_000);
void render();
