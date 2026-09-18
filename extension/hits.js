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
/** A nap élbolya, ami a hídra megy: ennyi hoszt — MELYIK oldal akaszt meg a legtöbbször. */
export const TOP_HOSTS_PER_DAY = 5;
/** Naponta legfeljebb ennyi kulcsszó a könyvben — a lista úgysem hosszabb. */
export const MAX_KEYWORDS_PER_DAY = 50;
/** A nap élbolya kulcsszavanként — ennyi megy a hídra. */
export const TOP_KEYWORDS_PER_DAY = 5;

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
export function recordHit(state, day, reason, host, hour, keyword) {
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
  // Kulcsszavanként is: MELYIK kulcsszó dolgozik — csak a kulcsszó okánál, a
  // fogó szóval. A gépen marad; a hídra a nap élbolya megy.
  const k = r === 'keyword' && typeof keyword === 'string' ? keyword.trim().toLowerCase() : '';
  if (k) {
    if (!bucket.byKeyword || typeof bucket.byKeyword !== 'object') bucket.byKeyword = {};
    if (bucket.byKeyword[k] !== undefined || Object.keys(bucket.byKeyword).length < MAX_KEYWORDS_PER_DAY) {
      bucket.byKeyword[k] = (Number.isFinite(bucket.byKeyword[k]) ? bucket.byKeyword[k] : 0) + 1;
    }
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

/** Ennyi mai megakadástól a tiltó lap egy lépést is javasol. */
export const NUDGE_AT = 5;

/** A tiltó lap javaslata a sokadik megakadásnál — vagy üres. Nem tilt, nem ítél. */
export function hitsNudge(today) {
  return today >= NUDGE_AT ? ' Egy munkamenet vagy egy rövid zárlat most segítene — te döntesz.' : '';
}

/** „21–22 óra” — a csúcs-óra felirata. */
export function hourLabel(hour) {
  return `${hour}–${(hour + 1) % 24} óra`;
}

/**
 * A CSÚCS-ÓRA a kísértés pillanatában: a hét csúcsa, és hogy MOST ez az óra-e
 * ({ hour, count, now }) — vagy null, ha még nem volt. A tükör a pillanaté: a
 * tiltó lap csak a csúcs-órában mondja, a felugró lap a hetet, jelöléssel.
 */
export function peakNow(state, today, hour) {
  const peak = peakHour(state, lastDays(today, 7));
  return peak ? { hour: peak.hour, count: peak.count, now: peak.hour === hour } : null;
}

/** A felugró lap sora a hét csúcsáról — üres, ha nem volt. */
export function peakText(peak) {
  if (!peak) return '';
  return ` A hét csúcsa: ${hourLabel(peak.hour)} (${peak.count} megakadás)${peak.now ? ' — most' : ''}.`;
}

/** A tiltó lap mondata: csak a csúcs-órában — ilyenkor jár a kéz magától. Különben üres. */
export function peakNowText(peak) {
  if (!peak || !peak.now) return '';
  return ` Most a hét csúcs-órája van (${hourLabel(peak.hour)}, ${peak.count} megakadás a héten) — ilyenkor jár a kéz magától.`;
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

/** Ma, az elmúlt 7 nap, az előző 7 nap és az elmúlt 30 nap (a mai nappal) összege. */
export function hitsSummary(state, today) {
  const week = lastDays(today, 7).reduce((sum, d) => sum + hitsOn(state, d), 0);
  // Az előző hét: a tizennégy napból az első hét — a hét az előző héthez képest.
  const prevWeek = lastDays(today, 14).slice(0, 7).reduce((sum, d) => sum + hitsOn(state, d), 0);
  // A hónap: a könyv harminc napot tart — a mondat akkor mondja, ha több a hétnél.
  const month = lastDays(today, 30).reduce((sum, d) => sum + hitsOn(state, d), 0);
  return { today: hitsOn(state, today), week, prevWeek, month };
}

/** A harminc nap napi sora, a legrégebbitől — a hónap alakja. */
export function hitsMonth(state, today) {
  return lastDays(today, 30).map((d) => ({ day: d, total: hitsOn(state, d) }));
}

/**
 * A HÓNAP rajza csak akkor mond többet a hétnél, ha a hét ELŐTTI napokon is
 * volt megakadás — különben ugyanazt a hét oszlopot mutatná, szélesebben.
 * A gépi mag tükre; a sor a legrégebbitől jön, az utolsó hét nap a hété.
 */
export function monthHasOlderHits(series, weekDays = 7) {
  return series.slice(0, Math.max(0, series.length - weekDays)).some((d) => d.total > 0);
}

/**
 * „A héten 12 megakadás, az előző héten 18.” — a két szám egymás mellett,
 * ítélet nélkül; a gépi sor tükre. Előző hét nélkül nincs (null): egy nulla
 * nem összehasonlítás. A nulla hét viszont mondat, ha volt mihez mérni.
 */
export function hitsTrendText(summary) {
  const prev = summary?.prevWeek ?? 0;
  if (prev <= 0) return null;
  return `A héten ${summary.week} megakadás, az előző héten ${prev}.`;
}

/**
 * Az elmúlt 7 nap sorai a hídra: nap, összeg, okonként. Csak azok a napok,
 * amikor volt megakadás — az üres nap nem sor.
 */
/**
 * Ennyi napot küld a híd az appnak: két hetet, hogy a gép a hetet az előző
 * héthez mérhesse. A forrás mindig a teljes két hetét küldi, a segéd cseréli.
 */
export const REPORT_DAYS = 14;

export function hitsReport(state, today, count = REPORT_DAYS) {
  const out = [];
  for (const day of lastDays(today, count)) {
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
    // A nap élbolya hosztonként — az öt leggyakoribb megy a hídra (a gépen
    // belül, a fiókba nem): MELYIK oldal akaszt meg a legtöbbször. A többi
    // hoszt csak itt marad.
    const hosts = state?.days?.[day]?.byHost;
    const topHosts = hosts && typeof hosts === 'object'
      ? Object.entries(hosts)
        .filter(([h, n]) => typeof h === 'string' && h && Number.isFinite(n) && n > 0)
        .map(([h, n]) => [h, Math.floor(n)])
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, TOP_HOSTS_PER_DAY)
      : [];
    // Kulcsszavanként is az élboly: MELYIK kulcsszó dolgozik — a gépi kártya
    // ebből mondja; a teljes szó-könyv itt marad.
    const kws = state?.days?.[day]?.byKeyword;
    const topKeywords = kws && typeof kws === 'object'
      ? Object.entries(kws)
        .filter(([k, n]) => typeof k === 'string' && k && Number.isFinite(n) && n > 0)
        .map(([k, n]) => [k, Math.floor(n)])
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, TOP_KEYWORDS_PER_DAY)
      : [];
    const row = { day, total, byReason };
    if (byHour && byHour.some((n) => n > 0)) row.byHour = byHour;
    if (topHosts.length) row.topHosts = topHosts;
    if (topKeywords.length) row.topKeywords = topKeywords;
    out.push(row);
  }
  return out;
}

/** A felugró lap és a beállítási lap mondata — vagy null, ha nincs miről. */
export function hitsText(summary) {
  const t = summary?.today ?? 0;
  const w = summary?.week ?? 0;
  const m = summary?.month ?? 0;
  if (w === 0) return null;
  // A hónap csak akkor kerül a mondatba, ha több a hétnél — különben ugyanazt mondaná.
  const monthPart = m > w ? `, 30 napban ${m}` : '';
  if (t === 0) return `Ma még nem állított meg a böngésző; az elmúlt 7 napban ${w} megakadás${monthPart}.`;
  return `Ma ${t} megakadás — a böngésző ennyiszer vitt a tiltó lapra; az elmúlt 7 napban ${w}${monthPart}.`;
}

/** Egy nap sora a beállítási lapon: „szept. 18. — 3 (kulcsszó 2, zárva 1)”. */
export function hitsRows(state, today) {
  return hitsReport(state, today, 7).reverse().map((r) => ({
    day: r.day,
    total: r.total,
    detail: Object.entries(r.byReason).map(([k, n]) => `${REASON_NAMES[k] ?? k} ${n}`).join(', '),
  }));
}

/** Az okok nevei — a gépi statisztika ugyanezeket mondja. */
export const REASON_NAMES = { closed: 'zárva oldal', focus: 'munkamenet', channel: 'csatorna', rule: 'részleges szabály', keyword: 'kulcsszó', other: 'egyéb' };

/**
 * A hét okonként, a legnagyobb elöl — MELYIK szabály dolgozik. Holtversenynél
 * az okok rögzített sorrendje, hogy a sor ne ugráljon két frissítés között.
 */
export function hitsWeekByReason(state, today) {
  const sum = {};
  for (const r of hitsReport(state, today, 7)) for (const [k, n] of Object.entries(r.byReason)) sum[k] = (sum[k] ?? 0) + n;
  const order = [...HIT_REASONS, 'other'];
  return Object.entries(sum).filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([reason, count]) => ({ reason, count }));
}

/**
 * A hosztok könyve a napokra összeadva: a legnagyobb (hoszt, szám) — vagy
 * null. Holtversenynél az ábécé. Csak itt, a teljes könyvből, pontosan — a
 * hídra a napi élboly megy, ez a lap a sajátjából mondja.
 */
export function topHost(state, days) {
  const sum = {};
  for (const day of days) {
    const hosts = state?.days?.[day]?.byHost;
    if (!hosts || typeof hosts !== 'object') continue;
    for (const [h, n] of Object.entries(hosts)) if (Number.isFinite(n) && n > 0) sum[h] = (sum[h] ?? 0) + Math.floor(n);
  }
  const best = Object.entries(sum).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return best ? { host: best[0], count: best[1] } : null;
}

/**
 * A kulcsszavak könyve a napokra összeadva: (kulcsszó, szám) sorok, a
 * legnagyobb elöl, holtversenynél az ábécé — MELYIK kulcsszó dolgozik. A
 * teljes könyvből, pontosan; a hídra a napi élboly megy.
 */
export function keywordsWeek(state, days) {
  const sum = {};
  for (const day of Array.isArray(days) ? days : []) {
    const kws = state?.days?.[day]?.byKeyword;
    if (!kws || typeof kws !== 'object') continue;
    for (const [k, n] of Object.entries(kws)) if (Number.isFinite(n) && n > 0) sum[k] = (sum[k] ?? 0) + Math.floor(n);
  }
  return Object.entries(sum).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([keyword, count]) => ({ keyword, count }));
}

/** „Kulcsszavanként a héten: shorts 7 · reels 3” — vagy null, ha nincs miről. */
export function keywordsText(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return `Kulcsszavanként a héten: ${rows.map((r) => `${r.keyword} ${r.count}`).join(' · ')}`;
}

/**
 * A lista szavai, amelyek a héten NEM fogtak — a tükör másik fele: ami sosem
 * fog, azt lehet, hogy fölösleges tartani (a levétel próbatétel, de hogy
 * fölösleges-e, itt derül ki). Csak akkor mond bármit, ha a héten volt
 * kulcsszó-megakadás: friss könyv mellett minden szó „nem fogott” lenne, és
 * az nem tény, hanem hiány.
 */
export function idleKeywords(keywords, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const hit = new Set(rows.map((r) => String(r.keyword).toLowerCase()));
  return (Array.isArray(keywords) ? keywords : [])
    .map((k) => String(k).trim().toLowerCase())
    .filter((k) => k && !hit.has(k));
}

/** „A héten nem fogott: live, stream” — vagy null, ha nincs ilyen. */
export function idleKeywordsText(idle) {
  if (!Array.isArray(idle) || idle.length === 0) return null;
  return `A héten nem fogott: ${idle.join(', ')}`;
}

/** „A héten: 4 zárva oldal · 3 munkamenet” — vagy null, ha nincs miről. */
export function hitsReasonText(rows) {
  if (!rows.length) return null;
  return 'A héten: ' + rows.map((r) => `${r.count} ${REASON_NAMES[r.reason] ?? r.reason}`).join(' · ');
}

// ---------------------------------------------------------------- a hét napjai

/** Ennyi napból áll a csúcs-nap mintája: négy-négy nap a hét minden napjára — a hét egy napja egyszer nem minta. A gépi mag tükre. */
export const PEAK_WEEKDAY_DAYS = 28;

/** A HÉT NAPJAI szerint: az utolsó 28 nap megakadásai a hét hét napjára osztva (0 = vasárnap). */
export function hitsByWeekday(state, today, count = PEAK_WEEKDAY_DAYS) {
  const by = [0, 0, 0, 0, 0, 0, 0];
  for (const d of lastDays(today, count)) {
    const [y, m, dd] = d.split('-').map(Number);
    by[new Date(y, m - 1, dd).getDay()] += hitsOn(state, d);
  }
  return by;
}

/** A csúcs-nap: { day, count } — vagy null. Holtversenynél a hét elejéhez közelebbi (hétfőtől). */
export function peakWeekday(byDay) {
  let best = null;
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    const count = byDay[day] ?? 0;
    if (count > 0 && (best === null || count > best.count)) best = { day, count };
  }
  return best;
}

export const WEEKDAY_NAMES = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'];

/** „A négy hét csúcs-napja: vasárnap (14 megakadás).” — melyik napon akad meg a kéz a legtöbbször. */
export function peakWeekdayText(peak) {
  return `A négy hét csúcs-napja: ${WEEKDAY_NAMES[peak.day] ?? '?'} (${peak.count} megakadás).`;
}
