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

  return {
    state,
    fresh,
    focus,
    closed: closed.slice(0, CLOSED_SHOWN),
    closedMore: Math.max(0, closed.length - CLOSED_SHOWN),
    rules: (link?.rules ?? []).length,
    channels: (link?.channels ?? []).length,
  };
}
