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
import { CLOSED_FRESH_MS, loadLink, pullFromApp, pushHits, setToken, withAppRules } from './app-link.js';
import { dayKey, formatSeconds, lastDays, topChannels } from './chantime.js';
// A `lastDays` a csatorna-időé (ugyanaz a naptár) — a könyv is azzal él.
import {
  hitsByHour, hitsReasonText, hitsRows, hitsSummary, hitsText, hitsTrendText, hitsWeekByReason, hourLabel, idleKeywords,
  idleKeywordsText, keywordsText, keywordsWeek, peakHour, topHost,
} from './hits.js';

const TIME_KEY = 'breaker.chantime';

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

/** A csatorna-idő listái: ma és az elmúlt hét nap. */
function renderTimeList(listId, emptyId, rows) {
  const list = $(listId);
  list.textContent = '';
  $(emptyId).hidden = rows.length > 0;
  for (const r of rows) {
    const li = el('li');
    const left = el('div');
    left.appendChild(el('div', 'name', r.channel));
    left.appendChild(el('div', 'muted', r.host));
    li.appendChild(left);
    li.appendChild(el('span', 'muted', formatSeconds(r.seconds)));
    list.appendChild(li);
  }
}

async function renderChannelTime() {
  const got = await chrome.storage.local.get(TIME_KEY);
  const state = got?.[TIME_KEY] ?? { days: {} };
  const today = dayKey();
  renderTimeList('timeToday', 'timeTodayEmpty', topChannels(state, [today]));
  renderTimeList('timeWeek', 'timeWeekEmpty', topChannels(state, lastDays(today, 7)));
}

/** A megakadások: a mondat, és naponként egy sor az elmúlt hétről. */
async function renderHits() {
  const got = await chrome.storage.local.get('breaker.hits');
  const state = got?.['breaker.hits'] ?? { days: {} };
  const today = dayKey();
  const summary = hitsSummary(state, today);
  const text = hitsText(summary);
  $('hitsLine').hidden = text === null;
  $('hitsLine').textContent = text ?? '';
  // A HÉT AZ ELŐZŐ HÉTHEZ KÉPEST: a két szám egymás mellett — irány, nem
  // ítélet; a saját könyvből, pontosan. Előző hét nélkül a sor nincs.
  const trend = hitsTrendText(summary);
  $('hitsPrev').hidden = trend === null;
  $('hitsPrev').textContent = trend ?? '';
  // MIKOR jár a kéz magától: a hét csúcs-órája, és a nap huszonnégy rekesze.
  const week = lastDays(today, 7);
  const peak = peakHour(state, week);
  $('hitsPeak').hidden = peak === null;
  $('hitsPeak').textContent = peak
    ? `A hét csúcsa: ${hourLabel(peak.hour)} (${peak.count} megakadás) — akkor jár a kéz magától.` : '';
  // MELYIK szabály dolgozik: a hét okonként, a legnagyobb elöl.
  const reasons = hitsReasonText(hitsWeekByReason(state, today));
  $('hitsReasons').hidden = reasons === null;
  $('hitsReasons').textContent = reasons ?? '';
  // MELYIK oldal akaszt meg a legtöbbször: a hét csúcs-oldala a saját könyvből — pontosan.
  const top = topHost(state, week);
  $('hitsTop').hidden = top === null;
  $('hitsTop').textContent = top ? `A héten a legtöbbször: ${top.host} (${top.count}×).` : '';
  // MELYIK kulcsszó dolgozik: a hét kulcsszavanként, a saját könyvből.
  const kwRows = keywordsWeek(state, week);
  const kw = keywordsText(kwRows);
  $('hitsKeywords').hidden = kw === null;
  $('hitsKeywords').textContent = kw ?? '';
  // A LISTA SZAVAI, amelyek a héten nem fogtak: a tükör másik fele — csak ha a
  // héten volt kulcsszó-megakadás, különben a hiány tényként hangzana.
  const link = await loadLink();
  const idle = idleKeywordsText(idleKeywords(link.keywords ?? [], kwRows));
  $('hitsIdleKeywords').hidden = idle === null;
  $('hitsIdleKeywords').textContent = idle ?? '';
  const strip = $('hitsHours');
  strip.textContent = '';
  strip.hidden = peak === null;
  if (peak) {
    const by = hitsByHour(state, week);
    by.forEach((n, hour) => {
      const bar = el('span', 'hour-bar');
      bar.style.height = `${Math.max(2, Math.round((n / peak.count) * 28))}px`;
      bar.title = `${hourLabel(hour)}: ${n}`;
      if (hour === peak.hour) bar.classList.add('peak');
      strip.appendChild(bar);
    });
  }
  const rows = hitsRows(state, today);
  const list = $('hitsList');
  list.textContent = '';
  $('hitsEmpty').hidden = rows.length > 0;
  for (const r of rows) {
    const li = el('li');
    const left = el('div');
    left.appendChild(el('div', 'name', r.day.replace(/-/g, '. ') + '.'));
    left.appendChild(el('div', 'muted', r.detail));
    li.appendChild(left);
    li.appendChild(el('span', 'muted', String(r.total)));
    list.appendChild(li);
  }
}

async function render() {
  await sweep();
  const state = await load();
  const link = await loadLink();
  const now = Date.now();
  renderLink(link);
  renderClosedNow(link, now);
  void renderChannelTime();
  void renderHits();
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

/**
 * Mi van MOST zárva az app szerint — ugyanabból a listából, amiből a tiltó
 * lap magyaráz. Csak friss adatból beszél, és a lejárt bejegyzést kihagyja:
 * elavult zárva-t mondani rosszabb, mint hallgatni (a tiltást a DNS tartja).
 */
function renderClosedNow(link, now = Date.now()) {
  const box = $('closedNow');
  // Frissesség dönt, nem a kód megléte — ugyanúgy, ahogy a closedFor-nál:
  // a lista magáért beszél, ha elég friss.
  const fresh = now - (link.fetchedAt ?? 0) <= CLOSED_FRESH_MS;
  const seen = new Set();
  const parts = [];
  const words = { always: 'tiltva', schedule: 'menetrend', cooldown: 'adag-szünet', limit: 'mai keret' };
  for (const c of fresh ? link.closed ?? [] : []) {
    if (seen.has(c.host)) continue;
    seen.add(c.host);
    let label = words[c.reason] ?? 'tiltva';
    if (c.until > now) {
      const min = Math.ceil((c.until - now) / 60000);
      label += min >= 90 ? `, még kb. ${Math.round(min / 60)} ó` : `, még kb. ${Math.max(min, 1)} p`;
    } else if (c.until > 0) {
      continue; // a lejárt zárás már nem zárás
    }
    parts.push(`${c.host} (${label})`);
  }
  box.hidden = parts.length === 0;
  box.textContent = parts.length > 0 ? `Most zárva: ${parts.join(' · ')}` : '';
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

// A KÖNYV TÖRLÉSE: a megakadások könyve a tiéd — törölhető. Az app az üres
// jelentéssel felejt: a híd a forrást is leveszi. App nélkül a gép marad,
// ahogy volt — a következő jelentés rendezi.
$('hitsClearBtn').addEventListener('click', async () => {
  const ok = window.confirm('Törlöd a megakadások könyvét? A számok, az órák, az oldalak és a kulcsszavak is mennek — az app is elfelejti.');
  if (!ok) return;
  await chrome.storage.local.set({ 'breaker.hits': { days: {} } });
  try { await pushHits([]); } catch { /* app nélkül: a következő jelentés rendezi */ }
  await renderHits();
});
