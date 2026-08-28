// A navigáció megállítása.
//
// A `webNavigation.onBeforeNavigate` az első pont, ahol a TELJES cím látszik —
// és ez az egyetlen ok, amiért ez a funkció egyáltalán lehetséges: a DNS-szintű
// tiltás soha nem látja az utat, csak a hosztnevet.
//
// Miért nem `declarativeNetRequest`: azzal a szabályokat előre kellene
// fordítani, és a mi szabályaink szegmenshatáron illeszkednek — a `/@ab` nem
// foghatja meg a `/@abc`-t. Ezt egy URL-mintával nem lehet pontosan kifejezni,
// és pont a pontatlanság lenne a baj: elvenne valamit, amit a felhasználó nem
// tiltott le.

import { channelVerdict } from './channels.js';
import { firstMatch, ruleLabel } from './rules-core.js';
import { activeRules, load, sweep } from './storage.js';
import {
  dueForRefresh, focusActive, focusAllows, loadLink, pullFromApp, withAppRules,
} from './app-link.js';

/** Csak a főkeret számít: egy beágyazott hirdetés nem „az oldal megnyitása”. */
function isTopFrame(details) {
  return details.frameId === 0;
}

/**
 * Megfogja-e valami ezt a címet.
 *
 * Kétféle ok van, és a sorrend számít:
 *
 *   1. FUT EGY MUNKAMENET -> fehérlista: ami nincs felsorolva, az tiltva. Ez
 *      erősebb, mert mindenre vonatkozik, nem csak a felvett szabályokra.
 *   2. Részleges szabályok -> feketelista: az oldal egy darabja.
 *
 * @returns null (mehet), vagy { reason, rule?, focus? }
 */
async function decide(url) {
  const now = Date.now();
  const state = await load();
  const link = await loadLink();

  if (focusActive(link, now)) {
    const host = hostOf(url);
    // A bővítmény SAJÁT lapjai (a tiltó lap, a beállítások) sosem esnek bele:
    // különben a munkamenet alatt nem lehetne megnézni, mi fut és meddig.
    if (host && !focusAllows(link, host)) {
      return { reason: 'focus', focus: link.focus };
    }
  }

  // A CSATORNA-SZŰRŐ: az oldalon csak a felsorolt csatornák nyílnak meg. A
  // sorrend szándékos — a munkamenet erősebb (mindenre szól), a szűrő a
  // részleges szabályok ELŐTT jön, mert konkrétabb okot tud mondani.
  const chan = channelVerdict(url, link.channels);
  if (chan) return { reason: 'channel', channel: chan };

  // Az app szabályai HOZZÁADÓDNAK a sajátokhoz. Ha az app épp nem érhető el, az
  // utoljára letöltött lista marad érvényben — vagyis tovább tilt, nem enged át.
  const rule = firstMatch(withAppRules(activeRules(state, now), link.rules), url);
  return rule ? { reason: 'rule', rule } : null;
}

/** A cím hosztja, `URL` nélkül — ugyanúgy, ahogy a szabály-mag csinálja. */
function hostOf(url) {
  const s = String(url ?? '').trim();
  // Csak a valódi weboldalak számítanak. A `chrome://`, `about:` és a saját
  // bővítmény-lapjaink nem: ha ezeket is tiltanánk, a munkamenet alatt a
  // böngésző beállításai lennének elérhetetlenek — az pedig ijesztő, és nem
  // is véd semmit.
  if (!/^https?:\/\//i.test(s)) return null;
  const rest = s.replace(/^https?:\/\//i, '').replace(/^[^/@]*@/, '');
  const cut = rest.search(/[/?#]/);
  let host = cut < 0 ? rest : rest.slice(0, cut);
  const colon = host.indexOf(':');
  if (colon >= 0) host = host.slice(0, colon);
  return host.toLowerCase().replace(/\.+$/, '') || null;
}

/**
 * Az app megkérdezése, ha esedékes.
 *
 * NEM várunk rá a döntés előtt: egy lassú vagy elérhetetlen app nem
 * késleltetheti a navigációt. A friss lista a KÖVETKEZŐ döntésnél számít — az
 * app szabályai amúgy is percekben változnak, nem másodpercekben.
 */
function refreshInBackground() {
  void (async () => {
    const link = await loadLink();
    if (!dueForRefresh(link, Date.now())) return;
    await pullFromApp();
  })();
}

/** A tiltó lap címe, a MEGFOGÓ okkal együtt: a lap megnevezi, mi állította meg. */
function blockedUrl(hit) {
  if (hit.reason === 'focus') {
    const q = new URLSearchParams({
      focus: hit.focus.name || 'Munkamenet',
      endsAt: String(hit.focus.endsAt || 0),
    });
    return chrome.runtime.getURL(`blocked.html?${q.toString()}`);
  }
  if (hit.reason === 'channel') {
    // A lap kiírja, MILYEN kulcsot látott: az engedélyezéshez így nem kell
    // találgatni, hogy a szűrő minek olvasta a címet.
    const q = new URLSearchParams({ channel: hit.channel.key, channelHost: hit.channel.host });
    return chrome.runtime.getURL(`blocked.html?${q.toString()}`);
  }
  return chrome.runtime.getURL(`blocked.html?rule=${encodeURIComponent(ruleLabel(hit.rule))}`);
}

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (!isTopFrame(details)) return;
  refreshInBackground();
  const hit = await decide(details.url);
  if (!hit) return;
  const target = blockedUrl(hit);
  // A lapot NEM zárjuk be: a becsukódó lap ijesztő, és nem mondja meg, mi
  // történt. A saját lapunk viszont megnevezi a szabályt, ami megfogta.
  try {
    await chrome.tabs.update(details.tabId, { url: target });
  } catch {
    // A lap közben eltűnhetett. Ez nem hiba, csak elkéstünk vele.
  }
});

// A YouTube egyetlen lapon belül vált csatornát (History API), tehát az
// onBeforeNavigate nem fut le újra. Enélkül elég lenne a főoldalról rákattintani
// a csatornára, és a tiltás átengedné — pont a leggyakoribb úton.
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (!isTopFrame(details)) return;
  const hit = await decide(details.url);
  if (!hit) return;
  const target = blockedUrl(hit);
  try {
    await chrome.tabs.update(details.tabId, { url: target });
  } catch { /* a lap eltűnt */ }
});

// A lejárt visszaszámlálású szabályokat valakinek ki kell takarítania. A
// szolgáltatás-worker amúgy is felébred minden navigációnál, tehát itt a helye —
// külön ébresztő nélkül.
chrome.runtime.onStartup.addListener(() => { void sweep(); void pullFromApp(); });
chrome.runtime.onInstalled.addListener(() => { void sweep(); void pullFromApp(); });

// A beállítások lapja innen kéri le, mi számít MOST aktívnak, hogy ne kelljen
// két helyen ugyanazt az időkezelést megírni.
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type !== 'breaker:active-rules') return false;
  void (async () => {
    const state = await load();
    const link = await loadLink();
    respond({ rules: withAppRules(activeRules(state, Date.now()), link.rules) });
  })();
  return true; // aszinkron válasz
});
