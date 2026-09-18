// A felugró lap tartalma — tisztán, DOM és chrome nélkül, hogy tesztelhető legyen.
//
// MIÉRT VAN. A bővítmény ikonjára kattintva eddig nem történt semmi. Aki
// tudni akarta, összekötve van-e az app, fut-e munkamenet, mi van zárva, annak
// a beállítási lapot kellett megnyitnia. Ez a lap egy pillantás: ugyanabból a
// tárolt kapcsolat-állapotból beszél, amiből a tiltó lap — és ugyanazokkal a
// szabályokkal: a zárva-lista csak frissen számít, a lejárt bejegyzés nem
// zárás, a munkamenet lejáratát helyben nézzük. Magyarázat, nem érvényesítés:
// a tiltást az app tartja DNS-szinten.

/** Ennyi zárva-sort mutatunk; a többi egy összegző sorba megy. */
export const CLOSED_SHOWN = 8;
/** A SOROZAT KÜSZÖBE: egy nap nem sorozat — kettőtől mondat. Az app szabályának másolata (FOCUS_STREAK_MIN_DAYS); a mag-összhang őre méri. */
export const STREAK_MIN_DAYS = 2;

export function spanText(ms) {
  const min = Math.ceil(ms / 60000);
  // A zárlat napokban is mérhet; „kb. 168 ó” senkinek nem mond semmit.
  if (min >= 2 * 1440) return `kb. ${Math.round(min / 1440)} nap`;
  if (min >= 90) return `kb. ${Math.round(min / 60)} ó`;
  return `${Math.max(min, 1)} p`;
}

export function agoText(ms) {
  const min = Math.floor(ms / 60000);
  return min < 1 ? 'az imént' : `${min} perce`;
}

/**
 * @param link a `loadLink()` eredménye (vagy annak alakja)
 * @param now most (epoch ms)
 * @param freshMs meddig friss a zárva-lista a legutóbbi sikeres lehúzás után
 */
/**
 * A MENET GOMBJA a felugró lapon: a javasolt csomag, ha az app friss választ
 * adott, van mit indítani, és nem fut menet (egyszerre egy). A gomb szövege
 * ugyanaz, mint az appban: „Munkamenet: Nyelvtanulás, 25 perc”.
 */
export function suggestButton(link, now, freshMs) {
  // Összekötetlenül nincs gomb: az app javaslata az appé, kód nélkül nem beszélünk róla.
  if (!link || typeof link.token !== 'string' || !link.token) return null;
  const s = link.suggest;
  if (!s || typeof s.packId !== 'string' || !s.packId || typeof s.name !== 'string' || !Number.isInteger(s.minutes) || s.minutes <= 0) return null;
  const fresh = Number.isFinite(link?.fetchedAt) && link.fetchedAt > 0 && now - link.fetchedAt <= freshMs;
  if (!fresh) return null;
  const f = link?.focus;
  if (f && f.running === true && f.endsAt > now) return null;
  return { packId: s.packId, minutes: s.minutes, text: `Munkamenet: ${s.name}, ${s.minutes} perc` };
}

/** Óra-sáv szövege: „21:00–22:00”; a 23 vége 00:00 — mint az app ablak-címkéjén. */
export function hourSpan(h) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:00–${p((h + 1) % 24)}:00`;
}

/**
 * LE VAN-E FEDVE a csúcs-óra: ha egy csomag heti ablaka fedi, a felugró lap
 * kimondja, hogy a menet magától indul — ugyanaz, mint a statisztika sora.
 * Csak összekötve és friss válasz mellett; különben üres.
 */
export function peakCoverText(link, now, freshMs) {
  if (!link || typeof link.token !== 'string' || !link.token) return '';
  const fresh = Number.isFinite(link?.fetchedAt) && link.fetchedAt > 0 && now - link.fetchedAt <= freshMs;
  const name = link?.suggest?.peakPack;
  if (!fresh || typeof name !== 'string' || !name) return '';
  return ` A csúcs-órában magától indul: ${name}.`;
}

/**
 * AMIKOR A CSÚCS-ÓRA A MENET-ÓRA: az app mondja, hogy a hét csúcs-órája és a
 * négy hét menet-órája ugyanaz — a lap a csúcs mondata után kimondja: a kéz
 * akkor jár, amikor le szoktál ülni. Csak összekötve és friss válasz mellett.
 */
export function sameHourText(link, now, freshMs) {
  if (!link || typeof link.token !== 'string' || !link.token) return '';
  const fresh = Number.isFinite(link?.fetchedAt) && link.fetchedAt > 0 && now - link.fetchedAt <= freshMs;
  if (!fresh || link?.suggest?.sameHour !== true) return '';
  return ' Ez a menet-órád is: a kéz akkor jár, amikor le szoktál ülni.';
}

/**
 * LE VAN-E FEDVE a menet-óra: ha egy csomag heti ablaka fedi, a lap kimondja,
 * hogy a menet magától indul — a csúcs-óra fedésének tükre, az app szava.
 * Csak összekötve és friss válasz mellett; különben üres.
 */
export function focusHourCoverText(link, now, freshMs) {
  if (!link || typeof link.token !== 'string' || !link.token) return '';
  const fresh = Number.isFinite(link?.fetchedAt) && link.fetchedAt > 0 && now - link.fetchedAt <= freshMs;
  const name = link?.suggest?.focusHourPack;
  if (!fresh || typeof name !== 'string' || !name) return '';
  return ` A menet-órában magától indul: ${name}.`;
}

/**
 * A MENET-NAP: ha az app azt mondja, ma szoktál leülni (a négy hét menet-napja,
 * elég mintából — az app szabálya), a lap a gomb mellett kimondja. Csak
 * összekötve és friss válasz mellett; különben üres. Tény, nem felszólítás.
 */
export function focusDayText(link, now, freshMs) {
  if (!link || typeof link.token !== 'string' || !link.token) return '';
  const fresh = Number.isFinite(link?.fetchedAt) && link.fetchedAt > 0 && now - link.fetchedAt <= freshMs;
  if (!fresh || link?.suggest?.focusDay !== true) return '';
  return ' Ma a menet-napod van — ilyenkor szoktál leülni.';
}

/** A MENET-ÓRA: ha az app azt mondja, most szoktál elkezdeni, a lap a gomb mellett kimondja — összekötve, frissen. */
export function focusHourNowText(link, now, freshMs) {
  if (!link || typeof link.token !== 'string' || !link.token) return '';
  const fresh = Number.isFinite(link?.fetchedAt) && link.fetchedAt > 0 && now - link.fetchedAt <= freshMs;
  if (!fresh || link?.suggest?.focusHourNow !== true) return '';
  return ' Most a menet-órád van.';
}

/**
 * A MENET-SOROZAT: hány napja ülsz le minden nap — az app száma, a lap a gomb
 * mellett mondja, kettőtől (egy nap nem sorozat — az app szabálya). Csak
 * összekötve és friss válasz mellett; különben üres. Tény, nem felszólítás.
 */
export function focusStreakText(link, now, freshMs) {
  if (!link || typeof link.token !== 'string' || !link.token) return '';
  const fresh = Number.isFinite(link?.fetchedAt) && link.fetchedAt > 0 && now - link.fetchedAt <= freshMs;
  const n = link?.suggest?.focusStreak;
  if (!fresh || !Number.isInteger(n) || n < STREAK_MIN_DAYS) return '';
  // A REKORD csak a mostani sorozat mellett, zárójelben, ha több — a statisztika szövege szó szerint.
  const longest = link?.suggest?.focusLongestStreak;
  return Number.isInteger(longest) && longest > n
    ? ` ${n} napja minden nap leültél (a leghosszabb sorozatod: ${longest} nap).`
    : ` ${n} napja minden nap leültél.`;
}

/**
 * A CSÚCS-ÓRA ABLAKÁNAK gombja: { packId, hour, text } — vagy null. Ugyanazok
 * a kapuk, mint a menet gombjánál (összekötve, friss válasz, futó menet
 * nélkül), és az app mondja meg, van-e csúcs-óra, amire ablak tehető.
 */
export function windowButton(link, now, freshMs) {
  const sb = suggestButton(link, now, freshMs);
  const h = link?.suggest?.peakHour;
  if (!sb || !Number.isInteger(h) || h < 0 || h > 23) return null;
  return { packId: sb.packId, hour: h, text: `Heti ablak a csúcs-órára: ${link.suggest.name}, minden nap ${hourSpan(h)}` };
}

/**
 * A MENET-ÓRA ABLAKÁNAK gombja: a csúcs-óra gombjának tükre — ugyanazok a
 * kapuk, és az app mondja meg, van-e menet-óra, amire ablak tehető (ha a
 * menet-óra a csúcs-óra, az app nem küldi: azt a másik gomb kínálja).
 */
export function focusHourWindowButton(link, now, freshMs) {
  const sb = suggestButton(link, now, freshMs);
  const h = link?.suggest?.focusHour;
  if (!sb || !Number.isInteger(h) || h < 0 || h > 23) return null;
  return { packId: sb.packId, hour: h, text: `Heti ablak a menet-órára: ${link.suggest.name}, minden nap ${hourSpan(h)}` };
}

export function describePopup(link, now, freshMs) {
  const fetchedAt = link?.fetchedAt ?? 0;
  const linked = !!link?.token;
  // Összekötetlenül nem beszélünk az app állapotáról akkor sem, ha a tár még
  // őriz egy friss listát (a kód elfelejtése után percekig lehet ilyen): egy
  // „nincs összekötve” és egy „most zárva” egymás alatt ellentmondás lenne.
  const fresh = linked && fetchedAt > 0 && now - fetchedAt <= freshMs;
  const words = { always: 'tiltva', schedule: 'menetrend', cooldown: 'adag-szünet', limit: 'mai keret' };

  const closed = [];
  const seen = new Set();
  for (const c of fresh ? link.closed ?? [] : []) {
    if (!c || typeof c.host !== 'string' || seen.has(c.host)) continue;
    seen.add(c.host);
    if (c.until > 0 && c.until <= now) continue; // a lejárt zárás már nem zárás
    closed.push({
      host: c.host,
      reason: words[c.reason] ?? 'tiltva',
      left: c.until > now ? spanText(c.until - now) : null,
    });
  }

  const f = link?.focus;
  const focus = f && f.running === true && f.endsAt > now
    ? {
      name: f.name || 'Munkamenet',
      left: spanText(f.endsAt - now),
      allowed: (f.allowSites ?? []).length,
      // A heti ablak menete: a lap kimondja, hogy nem gombnyomásra indult.
      window: f.window === true,
    }
    : null;

  // A ZÁRLAT: összekötve, és még tart. Frissesség nélkül — a zárlat csak
  // hosszabbodhat, egy régebbi vég is igaz alsó becslés (lásd app-link.js).
  const lu = Number(link?.lockdown?.until);
  const lockdown = linked && Number.isFinite(lu) && lu > now
    ? { left: spanText(lu - now), byWindow: link?.lockdown?.byWindow === true } : null;

  let state;
  if (!linked) {
    state = { kind: 'unlinked', text: 'Nincs összekötve az appal — a Beállításokban add meg a kódot.' };
  } else if (fresh) {
    state = { kind: 'fresh', text: `Összekötve az appal — ${agoText(now - fetchedAt)} frissítve.` };
  } else if (fetchedAt > 0) {
    state = {
      kind: 'stale',
      text: `Az app ${agoText(now - fetchedAt)} jelentkezett utoljára — a zárva-lista addig nem friss. `
        + 'A tiltást a rendszer tartja, ez csak a magyarázat.',
    };
  } else {
    state = {
      kind: 'never',
      text: link?.error ? `Nem érem el az appot: ${link.error}` : 'Az appot még nem érte el — fut a Breaker?',
    };
  }

  // A MEGBÍZOTT (párban zárolás): összekötve, ha az app adott — frissesség
  // nélkül, mint a zárlat: a megbízott a lenyomattal él, nem a lehúzással.
  const partner = linked && typeof link?.partner?.name === 'string' && link.partner.name
    ? link.partner.name : null;

  return {
    state,
    fresh,
    lockdown,
    partner,
    focus,
    closed: closed.slice(0, CLOSED_SHOWN),
    closedMore: Math.max(0, closed.length - CLOSED_SHOWN),
    rules: (link?.rules ?? []).length,
    channels: (link?.channels ?? []).length,
    keywords: (link?.keywords ?? []).length,
  };
}
