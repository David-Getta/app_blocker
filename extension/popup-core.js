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

/** Óra-sáv szövege: „21:00–22:00”; a 23 vége 24:00 (a nap vége, nem nulla). */
export function hourSpan(h) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:00–${p(h + 1)}:00`;
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
