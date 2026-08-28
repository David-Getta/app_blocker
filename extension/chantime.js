// Csatorna-idő: mennyi időt vitt egy-egy csatorna — ott, ahol ez megmondható.
//
// MIÉRT VAN. A csatorna-szűrő kérdése nem az, hogy „sok-e a YouTube”, hanem
// hogy MELYIK csatorna eszi az időt. Az app oldal-szinten mér (annyit lát a
// rendszer); a csatornát csak a böngészőben futó kód látja — ugyanaz a kód,
// ami a szűrőhöz már azonosítja a lapok csatornáját. Ha már tudja, mérje is.
//
// HOL MÉR. Csak azokon az oldalakon, ahol BEKAPCSOLT csatorna-szűrő van: ott
// a felhasználó kimondta, hogy csatorna-szinten akarja kézben tartani. Máshol
// a bővítmény nem gyűjt semmit. A mérés a gépen marad (a bővítmény tárában),
// nem megy se az appba, se a fiókba.
//
// A fájl függőség nélküli tiszta logika: a tartalom-szkript és a beállítási
// lap használja, a tesztek pedig a kiszállított bájtokat futtatják.

/** Ennyi napot tartunk meg — ugyanannyit, mint az app oldal-mérése. */
export const RETENTION_DAYS = 30;
/** Naponta legfeljebb ennyi (oldal, csatorna) sor — a tárat védi. */
export const MAX_KEYS_PER_DAY = 200;

/** A nap kulcsa HELYI idő szerint: a „ma” az, amit az ember annak él meg. */
export function dayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Egy (oldal, csatorna) pár tárolási kulcsa. A | a hosztban nem fordulhat elő. */
export function entryKey(host, channel) {
  return `${host}|${channel}`;
}

/**
 * Másodpercek hozzáírása. A `state` alakja: { days: { nap: { kulcs: mp } } }.
 * Vissza ugyanaz az objektum — a hívó dönti el, mikor menti.
 */
export function addSeconds(state, day, host, channel, seconds) {
  const s = state && typeof state === 'object' ? state : {};
  if (!s.days || typeof s.days !== 'object') s.days = {};
  if (!Number.isFinite(seconds) || seconds <= 0) return s;
  const bucket = s.days[day] && typeof s.days[day] === 'object' ? s.days[day] : {};
  s.days[day] = bucket;
  const key = entryKey(host, channel);
  if (bucket[key] === undefined && Object.keys(bucket).length >= MAX_KEYS_PER_DAY) return s;
  bucket[key] = (Number.isFinite(bucket[key]) ? bucket[key] : 0) + seconds;
  return s;
}

/**
 * Takarítás: a megtartási időn túli napok kiesnek. A napkulcsok
 * szövegként rendezhetők, mert az alak fix hosszú (ÉÉÉÉ-HH-NN).
 */
export function sweepDays(state, today) {
  const s = state && typeof state === 'object' ? state : { days: {} };
  if (!s.days || typeof s.days !== 'object') s.days = {};
  const days = Object.keys(s.days).sort();
  const keep = days.filter((d) => d <= today).slice(-RETENTION_DAYS);
  // A JÖVŐBELI nap nem mérés, hanem elállított óra — azt is eldobjuk.
  const kept = new Set(keep);
  for (const d of days) if (!kept.has(d)) delete s.days[d];
  return s;
}

/** Az utolsó `count` nap kulcsai, a maival együtt, időrendben. */
export function lastDays(today, count) {
  const [y, m, d] = String(today).split('-').map(Number);
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = new Date(y, m - 1, d);
    t.setDate(t.getDate() - i);
    out.push(dayKey(t));
  }
  return out;
}

/**
 * A legtöbb időt vivő csatornák a megadott napokon.
 *
 * @returns [{host, channel, seconds}] csökkenő sorrendben, legfeljebb `limit`
 */
export function topChannels(state, days, limit = 10) {
  const totals = new Map();
  for (const day of days ?? []) {
    const bucket = state?.days?.[day];
    if (!bucket || typeof bucket !== 'object') continue;
    for (const [key, sec] of Object.entries(bucket)) {
      if (!Number.isFinite(sec) || sec <= 0) continue;
      totals.set(key, (totals.get(key) ?? 0) + sec);
    }
  }
  return [...totals.entries()]
    .map(([key, seconds]) => {
      const sep = key.indexOf('|');
      return { host: key.slice(0, sep), channel: key.slice(sep + 1), seconds };
    })
    .filter((x) => x.host && x.channel)
    .sort((a, b) => b.seconds - a.seconds || (a.channel < b.channel ? -1 : 1))
    .slice(0, limit);
}

/** Olvasható idő: „2 ó 15 p”, „48 p”, „30 mp”. */
export function formatSeconds(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s} mp`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} p`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} ó` : `${h} ó ${m} p`;
}
