// MEGAKADÁS-SZÁMLÁLÓ: hányszor állított meg a böngésző.
//
// MIÉRT VAN. A tiltás akkor dolgozik, amikor az ember nem figyel oda — pont
// ezért nem látszik, mennyit dolgozik. Egy szám, ami azt mondja:
// „ma hétszer futottál a tiltó lapra” — tükör: nem ítélet, hanem tény arról,
// hol jár a kéz magától. A csatorna-időhöz hasonlóan a gépen marad; az appnak
// is átmegy a hídon (a heti mondat és a statisztika sora mondja), a fiókba nem.
//
// MIT SZÁMOL. A tiltó lapra vitt navigációkat — okonként (zárva oldal,
// munkamenet, csatorna, részleges szabály, kulcsszó). Egy navigációt egyszer:
// a háttér két hálója (előtte, megtörtént) ugyanarra a címre kétszer is
// átirányíthat, azt a háttér szűri, itt csak a könyvelés van.
//
// A fájl függőség nélküli tiszta logika: a háttér, a felugró lap és a
// beállítási lap használja; a tesztek a kiszállított bájtokat futtatják.

/** Ennyi napot tartunk meg — mint a csatorna-idő és az app mérése. */
export const RETENTION_DAYS = 30;
/** Az okok, amikkel könyvelünk; ami nem ez, az „other”. */
export const HIT_REASONS = ['closed', 'focus', 'channel', 'rule', 'keyword'];
/** Naponta legfeljebb ennyi hosztnévre tartunk külön számot — a tárat védi. */
export const MAX_HOSTS_PER_DAY = 200;

/** A nap kulcsa HELYI idő szerint: a „ma” az, amit az ember annak él meg. */
export function dayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Az utolsó `count` nap kulcsa a mai nappal bezárólag, a legrégebbi elöl. */
export function lastDays(today, count) {
  const [y, m, d] = today.split('-').map(Number);
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push(dayKey(new Date(y, m - 1, d - i)));
  return out;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function reasonOf(reason) {
  return HIT_REASONS.includes(reason) ? reason : 'other';
}

/**
 * Egy megakadás könyvelése. A `state` alakja:
 * { days: { nap: { total: n, byReason: { ok: n } } } }. Vissza ugyanaz az
 * objektum — a hívó dönti el, mikor menti.
 */
export function recordHit(state, day, reason, host, hour) {
  const s = state && typeof state === 'object' ? state : {};
  if (!s.days || typeof s.days !== 'object') s.days = {};
  if (typeof day !== 'string' || !DAY_KEY.test(day)) return s;
  const bucket = s.days[day] && typeof s.days[day] === 'object' ? s.days[day] : { total: 0, byReason: {} };
  s.days[day] = bucket;
  if (!Number.isFinite(bucket.total)) bucket.total = 0;
  if (!bucket.byReason || typeof bucket.byReason !== 'object') bucket.byReason = {};
  const r = reasonOf(reason);
  bucket.total += 1;
  bucket.byReason[r] = (Number.isFinite(bucket.byReason[r]) ? bucket.byReason[r] : 0) + 1;
  // Hosztonként is: a tiltó lap ebből mondja, hányadszor ma EZEN az oldalon.
  // Csak a gépen marad — a hídra a napi összeg megy, a hoszt nem.
  const h = typeof host === 'string' ? host.trim().toLowerCase() : '';
  if (h) {
    if (!bucket.byHost || typeof bucket.byHost !== 'object') bucket.byHost = {};
    if (bucket.byHost[h] !== undefined || Object.keys(bucket.byHost).length < MAX_HOSTS_PER_DAY) {
      bucket.byHost[h] = (Number.isFinite(bucket.byHost[h]) ? bucket.byHost[h] : 0) + 1;
    }
  }
  // Óránként is: MIKOR jár a kéz magától — a nap huszonnégy rekesze.
  if (Number.isInteger(hour) && hour >= 0 && hour < 24) {
    if (!Array.isArray(bucket.byHour) || bucket.byHour.length !== 24) bucket.byHour = new Array(24).fill(0);
    bucket.byHour[hour] = (Number.isFinite(bucket.byHour[hour]) ? bucket.byHour[hour] : 0) + 1;
  }
  return s;
}

/** A napok órái összeadva: huszonnégy szám, 0 órától 23-ig. */
export function hitsByHour(state, days) {
  const out = new Array(24).fill(0);
  for (const day of Array.isArray(days) ? days : []) {
    const arr = state?.days?.[day]?.byHour;
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < 24; i++) {
      const n = arr[i];
      if (Number.isFinite(n) && n > 0) out[i] += Math.floor(n);
    }
  }
  return out;
}

/** A csúcs-óra a napokon: { hour, count } — vagy null, ha egy sem volt. Holtversenynél a korábbi óra. */
export function peakHour(state, days) {
  const by = hitsByHour(state, days);
  let best = -1;
  for (let i = 0; i < 24; i++) if (by[i] > 0 && (best < 0 || by[i] > by[best])) best = i;
  return best < 0 ? null : { hour: best, count: by[best] };
}

/** „21–22 óra” — a csúcs-óra felirata. */
export function hourLabel(hour) {
  return `${hour}–${(hour + 1) % 24} óra`;
}

/**
 * Takarítás: a megtartási időn túli és a jövőbeli napok kiesnek (a jövőbeli
 * nap nem megakadás, hanem elállított óra). A napkulcsok szövegként
 * rendezhetők, mert az alak fix hosszú.
 */
export function sweepHits(state, today) {
  const s = state && typeof state === 'object' ? state : { days: {} };
  if (!s.days || typeof s.days !== 'object') s.days = {};
  const keep = new Set(Object.keys(s.days).filter((d) => DAY_KEY.test(d) && d <= today).sort().slice(-RETENTION_DAYS));
  for (const d of Object.keys(s.days)) if (!keep.has(d)) delete s.days[d];
  return s;
}

/** Egy nap száma — hiányzó vagy rossz napnál nulla. */
export function hitsOn(state, day) {
  const n = state?.days?.[day]?.total;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Egy nap egy hosztjának száma — hiányzónál nulla. */
export function hitsOnHost(state, day, host) {
  const h = typeof host === 'string' ? host.trim().toLowerCase() : '';
  const n = h ? state?.days?.[day]?.byHost?.[h] : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Ma és az elmúlt 7 nap (a mai nappal) összege. */
export function hitsSummary(state, today) {
  const week = lastDays(today, 7).reduce((sum, d) => sum + hitsOn(state, d), 0);
  return { today: hitsOn(state, today), week };
}

/**
 * Az elmúlt 7 nap sorai a hídra: nap, összeg, okonként. Csak azok a napok,
 * amikor volt megakadás — az üres nap nem sor.
 */
export function hitsReport(state, today) {
  const out = [];
  for (const day of lastDays(today, 7)) {
    const total = hitsOn(state, day);
    if (total === 0) continue;
    const raw = state?.days?.[day]?.byReason;
    const byReason = {};
    for (const r of [...HIT_REASONS, 'other']) {
      const n = raw && Number.isFinite(raw[r]) && raw[r] > 0 ? Math.floor(raw[r]) : 0;
      if (n > 0) byReason[r] = n;
    }
    const hours = state?.days?.[day]?.byHour;
    const byHour = Array.isArray(hours) && hours.length === 24
      ? hours.map((n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)) : undefined;
    out.push(byHour && byHour.some((n) => n > 0) ? { day, total, byReason, byHour } : { day, total, byReason });
  }
  return out;
}

/** A felugró lap és a beállítási lap mondata — vagy null, ha nincs miről. */
export function hitsText(summary) {
  const t = summary?.today ?? 0;
  const w = summary?.week ?? 0;
  if (w === 0) return null;
  if (t === 0) return `Ma még nem állított meg a böngésző; az elmúlt 7 napban ${w} megakadás.`;
  return `Ma ${t} megakadás — a böngésző ennyiszer vitt a tiltó lapra; az elmúlt 7 napban ${w}.`;
}

/** Egy nap sora a beállítási lapon: „szept. 18. — 3 (kulcsszó 2, zárva 1)”. */
export function hitsRows(state, today) {
  const names = { closed: 'zárva oldal', focus: 'munkamenet', channel: 'csatorna', rule: 'részleges szabály', keyword: 'kulcsszó', other: 'egyéb' };
  return hitsReport(state, today).reverse().map((r) => ({
    day: r.day,
    total: r.total,
    detail: Object.entries(r.byReason).map(([k, n]) => `${names[k] ?? k} ${n}`).join(', '),
  }));
}
