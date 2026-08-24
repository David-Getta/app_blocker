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

import { firstMatch, ruleLabel } from './rules-core.js';
import { activeRules, load, sweep } from './storage.js';

/** Csak a főkeret számít: egy beágyazott hirdetés nem „az oldal megnyitása”. */
function isTopFrame(details) {
  return details.frameId === 0;
}

async function decide(url) {
  const now = Date.now();
  const state = await load();
  return firstMatch(activeRules(state, now), url);
}

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (!isTopFrame(details)) return;
  const hit = await decide(details.url);
  if (!hit) return;
  const target = chrome.runtime.getURL(
    `blocked.html?rule=${encodeURIComponent(ruleLabel(hit))}`,
  );
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
  const target = chrome.runtime.getURL(
    `blocked.html?rule=${encodeURIComponent(ruleLabel(hit))}`,
  );
  try {
    await chrome.tabs.update(details.tabId, { url: target });
  } catch { /* a lap eltűnt */ }
});

// A lejárt visszaszámlálású szabályokat valakinek ki kell takarítania. A
// szolgáltatás-worker amúgy is felébred minden navigációnál, tehát itt a helye —
// külön ébresztő nélkül.
chrome.runtime.onStartup.addListener(() => { void sweep(); });
chrome.runtime.onInstalled.addListener(() => { void sweep(); });

// A beállítások lapja innen kéri le, mi számít MOST aktívnak, hogy ne kelljen
// két helyen ugyanazt az időkezelést megírni.
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type !== 'breaker:active-rules') return false;
  void (async () => {
    const state = await load();
    respond({ rules: activeRules(state, Date.now()) });
  })();
  return true; // aszinkron válasz
});
