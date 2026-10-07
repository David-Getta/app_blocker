// A találatok eltüntetése az oldalról — és a lejátszó-oldal feltöltőjének
// kiolvasása.
//
// Ez legalább annyira fontos, mint a navigáció megállítása, és elsőre nem
// nyilvánvaló, hogy MIÉRT:
//
// A YouTube-főoldalon a tiltott csatorna videói `/watch?v=...` címre mutatnak,
// amiben a csatorna NEM szerepel. A navigáció megállítása tehát csak akkor
// lépne működésbe, amikor az ember MÁR rákattintott — az inger addigra
// megtette a hatását. A videókártya mellett viszont ott a csatorna neve, ami a
// `/@valaki` címre mutat: ezt megtaláljuk, és a KÖRÜLÖTTE lévő kártyát rejtjük
// el. Így a csatorna eltűnik az ajánlóból is, nem csak a saját oldala.
//
// Amit szándékosan NEM csinálunk: szövegre keresni. A csatorna neve előfordul
// olyan helyeken is, ahol nem a csatornáról van szó (kommentben, címben), és
// egy szöveges találat elvenne valamit, amit a felhasználó nem tiltott le. A
// link viszont egyértelmű.
//
// A CSATORNA-SZŰRŐ (fehérlista) ugyanígy két rétegből áll, csak megfordítva:
//
//   - a hírfolyamban az a kártya tűnik el, amin NEM engedélyezett csatornára
//     mutató link van — de csak ha a kártya VIDEÓRA is mutat: a csatorna-link
//     önmagában (egy komment szerzője, egy említés) nem videókártya, és azt
//     elrejteni olyat venne el, amit a felhasználó nem szűrt;
//   - a lejátszó-oldalon a cím nem árulja el a csatornát, de a LAP igen: a
//     saját metaadatában (schema.org VideoObject, mikroadat, a lejátszó
//     beágyazott adata) megnevezi a feltöltőt. Ezt kiolvassuk, és a háttérnek
//     szólunk — a döntés OTT születik, a lap tartalmában futó kód csak jelez.
//
// ELAVULÁS-ŐR: egylapos váltásnál (History API) az előző videó metaadata még
// a DOM-ban lóghat, mire mi olvasunk. Ezért a metaadatot csak akkor hisszük
// el, ha a MOSTANI videót nevezi meg — különben inkább nem mondunk semmit.
// A tévedés két iránya nem egyforma: egy át nem irányított rossz videó
// következő navigációnál újra esélyt kap, egy tévesen tiltott jó videó
// viszont a felhasználó szemében a szűrőt járatja le.

/**
 * A látható lap ennyi időnként nézeti újra magát — ugyanannyi, amennyi
 * időnként a bővítmény legfeljebb az appot kérdezi (lásd app-link.js).
 */
const RECHECK_MS = 20_000;

/**
 * GÉPELÉS KÖZBEN NEM ZÁRUNK. Ha a lap közben lezárul (menet indul, keret
 * betelik), az újranézés átirányítaná — és a félkész szöveg elveszne. Ezért
 * ha az utolsó két percben gépeltél a lapon, a lap csak szól, és a
 * gépelés-csend után zárul. Legfeljebb tíz percig halasztható: nem kiskapu,
 * hanem idő a mentésre. A számlálás ITT, a tartalom-szkript izolált világában
 * van — a weboldal kódja nem írhatja át.
 */
const EDIT_QUIET_MS = 2 * 60_000;
const MAX_DEFER_MS = 10 * 60_000;
let lastInputAt = 0;
let firstDeferredAt = 0;
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!t) return;
  const textInput = t.tagName === 'INPUT'
    && /^(text|search|email|url|tel|number|password)?$/i.test(t.getAttribute('type') ?? '');
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || textInput) lastInputAt = Date.now();
}, true);

/** Gépelnek-e most a lapon, és halasztható-e még a zárás. */
function editingNow(now = Date.now()) {
  if (!lastInputAt || now - lastInputAt >= EDIT_QUIET_MS) return false;
  return !firstDeferredAt || now - firstDeferredAt < MAX_DEFER_MS;
}

/** A zárás okai a sávon — ugyanazok a szavak, mint a tiltó lapon. */
const CLOSING_REASONS = {
  focus: 'munkamenet fut',
  closed: 'az oldal zárva',
  keyword: 'kulcsszó',
  channel: 'csatorna-szűrő',
  rule: 'részleges szabály',
};

/**
 * A sáv a lap tetején: a lap közben lezárult, de mert épp gépelsz, még nem
 * zárjuk be. Árnyék-DOM-ban, hogy a lap stílusa ne törje szét.
 */
let closingBanner = null;
function showClosingBanner(reason) {
  if (closingBanner) return;
  const host = document.createElement('div');
  host.id = 'breaker-closing';
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText = 'font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;background:#1f2937;'
    + 'color:#f9fafb;padding:10px 16px;box-shadow:0 2px 10px rgba(0,0,0,.35);';
  const why = CLOSING_REASONS[reason] ?? 'szabály';
  box.textContent = `Ez az oldal közben lezárult (${why}). Mentsd el, amit írsz: ha két percig `
    + 'nem gépelsz — de legkésőbb tíz perc múlva —, a lap a tiltó lapra fut.';
  root.appendChild(box);
  (document.body ?? document.documentElement).appendChild(host);
  closingBanner = host;
}

/**
 * A ZÁRÁS ELŐTTI SÁV: a lap még nyitva, de az utolsó percekben jár — a szünet
 * vége, a menetrend szerinti zárás vagy a napi keret közeleg. A háttér mondja
 * meg (az újranézés válaszában), mi és mennyi; a sáv csak kimondja. Bezárható:
 * egy zárásról egyszer elég szólni, ugyanarra nem jön vissza.
 */
const SOON_WORDS = {
  pause: (n) => `A szünet ${n} perc múlva véget ér — utána ez az oldal újra zárva. Mentsd el, amit írsz.`,
  schedule: (n) => `A menetrend szerint ez az oldal ${n} perc múlva zárul. Mentsd el, amit írsz.`,
  limit: (n) => `A mai keretből ezen az oldalon kevesebb mint ${n} perc maradt. Mentsd el, amit írsz.`,
};
let soonBanner = null;
let soonText = null;
let soonDismissed = null;
function showSoonBanner(soon) {
  const words = SOON_WORDS[soon?.kind];
  if (!words || closingBanner) return hideSoonBanner();
  if (soonDismissed === soon.kind) return;
  const text = words(Math.max(1, Math.ceil(soon.leftMs / 60_000)));
  if (soonBanner) {
    soonText.textContent = text;
    return;
  }
  const host = document.createElement('div');
  host.id = 'breaker-soon';
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  const box = document.createElement('div');
  box.setAttribute('role', 'status');
  box.style.cssText = 'font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;background:#78350f;'
    + 'color:#fffbeb;padding:10px 44px 10px 16px;box-shadow:0 2px 10px rgba(0,0,0,.35);position:relative;';
  const msg = document.createElement('span');
  msg.textContent = text;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Bezárás');
  close.style.cssText = 'all:initial;position:absolute;right:12px;top:50%;transform:translateY(-50%);'
    + 'font:20px/1 system-ui,sans-serif;color:#fffbeb;cursor:pointer;padding:4px 8px;';
  close.addEventListener('click', () => {
    soonDismissed = soon.kind;
    hideSoonBanner();
  });
  box.append(msg, close);
  root.appendChild(box);
  (document.body ?? document.documentElement).appendChild(host);
  soonBanner = host;
  soonText = msg;
}
function hideSoonBanner() {
  if (!soonBanner) return;
  soonBanner.remove();
  soonBanner = null;
  soonText = null;
}

(async () => {
  const [{ matchesRule }, chan, kw] = await Promise.all([
    import(chrome.runtime.getURL('rules-core.js')),
    import(chrome.runtime.getURL('channels.js')),
    import(chrome.runtime.getURL('keywords.js')),
  ]);
  const TIME_FLUSH_SECONDS = 10;

  let rules = [];
  let channels = [];
  let pageFilters = [];

  /** A kártya, amit el kell tüntetni: a link néhány szinttel feljebbi doboza. */
  function cardOf(link) {
    // Fölfelé lépkedünk, amíg egy elég nagy dobozt nem találunk. Fix
    // szelektor helyett azért, mert a YouTube (és minden más oldal) hetente
    // átnevezi az osztályait — egy fix névre kötött rejtés csendben leállna.
    let node = link;
    for (let i = 0; i < 8 && node.parentElement; i++) {
      node = node.parentElement;
      const tag = node.tagName;
      if (tag.includes('-') || tag === 'ARTICLE' || tag === 'LI') return node;
    }
    return link;
  }

  function absHref(link) {
    try {
      return new URL(link.getAttribute('href') ?? '', location.href).href;
    } catch {
      return null;
    }
  }

  /**
   * Hány KÜLÖNBÖZŐ videóra mutat link ebben a dobozban — legfeljebb háromig
   * számolva, mert a döntéshez ennyi elég: nulla = nem videókártya, több mint
   * kettő = egész polc vagy sor, azt nem bántjuk. A menetenkénti gyorsítótár
   * azért kell, mert a kommentfolyam sok linkje ugyanazokon az ősökön megy
   * fel, és a nagy dobozokat nem érdemes újraszámolni.
   */
  function distinctVideoCount(node, memo) {
    const got = memo.get(node);
    if (got !== undefined) return got;
    const ids = new Set();
    for (const a of node.getElementsByTagName?.('a') ?? []) {
      if (!a.getAttribute('href')) continue;
      const href = absHref(a);
      const id = href ? chan.contentIdOf(href) : null;
      if (id) ids.add(id);
      if (ids.size > 2) break;
    }
    memo.set(node, ids.size);
    return ids.size;
  }

  /**
   * A VIDEÓKÁRTYA a csatorna-link körül: a legszűkebb ős, amiben videóra
   * mutató link is van. Ha az első ilyen ős már kettőnél több különböző
   * videót tartalmaz, az nem egy kártya, hanem egy egész szakasz — arról nem
   * dönthet egyetlen link.
   */
  function videoCardOf(link, memo) {
    let node = link;
    for (let i = 0; i < 12 && node.parentElement; i++) {
      node = node.parentElement;
      const count = distinctVideoCount(node, memo);
      if (count === 0) continue;
      return count <= 2 ? node : null;
    }
    return null;
  }

  function hide(card) {
    if (card.dataset?.breakerHidden === '1') return;
    if (card.dataset) card.dataset.breakerHidden = '1';
    card.style.display = 'none';
  }

  function hideMatches(root) {
    const links = root.querySelectorAll?.('a[href]') ?? [];
    const memo = new Map();
    for (const link of links) {
      const href = absHref(link);
      if (!href) continue;
      if (rules.some((r) => matchesRule(r, href))) {
        hide(cardOf(link));
        continue;
      }
      // A csatorna-szűrő: nem engedélyezett csatornára mutató link egy
      // videókártyán. A lejátszót magát sosem rejtjük — arról a tiltó lap
      // dönt, egy némán eltűnő fél képernyő csak riasztó lenne.
      if (pageFilters.length === 0) continue;
      if (!chan.channelVerdict(href, pageFilters)) continue;
      const card = videoCardOf(link, memo);
      if (card && !card.querySelector('video')) hide(card);
    }
  }

  // ---------------------------------------------------------------------
  // A LEJÁTSZÓ-OLDAL FELTÖLTŐJE. Három forrás, a szemantikustól a nyersebb
  // felé; az első, amelyik ad valamit, dönt. Mindhárom csak akkor számít, ha
  // az elavulás-őrön átmegy (lásd a fájl fejlécét).
  // ---------------------------------------------------------------------

  /** JSON-LD: <script type="application/ld+json"> VideoObject → author.url. */
  function authorsFromJsonLd(id) {
    const out = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(s.textContent ?? '');
      } catch {
        continue;
      }
      const nodes = [];
      const push = (n) => { if (n && typeof n === 'object') nodes.push(n); };
      if (Array.isArray(data)) data.forEach(push); else push(data);
      for (const n of nodes.slice()) {
        if (Array.isArray(n['@graph'])) n['@graph'].forEach(push);
      }
      for (const n of nodes) {
        const types = Array.isArray(n['@type']) ? n['@type'] : [n['@type']];
        if (!types.includes('VideoObject')) continue;
        if (id && !JSON.stringify(n).includes(id)) continue; // elavulás-őr
        const authors = Array.isArray(n.author) ? n.author : [n.author];
        for (const a of authors) {
          if (a && typeof a === 'object' && typeof a.url === 'string' && a.url) out.push(a.url);
          // A puszta név (szöveg) nem azonosító — arra nem építünk ítéletet.
        }
      }
    }
    return out;
  }

  function collectMicrodataAuthors(root, out) {
    for (const el of root.querySelectorAll('[itemprop="author"]')) {
      if (el.tagName === 'A' || el.tagName === 'LINK') {
        const h = el.getAttribute('href');
        if (h) out.push(h);
        continue;
      }
      const u = el.querySelector('[itemprop="url"]');
      const h = u?.getAttribute('href') ?? u?.getAttribute('content');
      if (h) out.push(h);
    }
  }

  /** Mikroadat: VideoObject hatókörön belüli itemprop="author" → url. */
  function authorsFromMicrodata(id) {
    const out = [];
    const scopes = document.querySelectorAll('[itemtype*="VideoObject"]');
    for (const scope of scopes) {
      if (id && !scope.outerHTML.includes(id)) continue; // elavulás-őr
      collectMicrodataAuthors(scope, out);
    }
    // A YouTube a fejlécében LAPOS mikroadatot használ, VideoObject-doboz
    // nélkül. Ott a videoId meta a bizonyíték, hogy a blokk a MOSTANI
    // videóról szól — enélkül a lapszintű szerző-keresés bármit elkapna.
    if (scopes.length === 0 && id
      && document.querySelector(`meta[itemprop="videoId"][content="${CSS.escape(id)}"]`)) {
      collectMicrodataAuthors(document, out);
    }
    return out;
  }

  /**
   * A lejátszó beágyazott adata: a lapba írt szkript, amiben a videó adatai
   * utaznak. Nem az oldal belső osztályneveire támaszkodunk (azok hetente
   * változnak), hanem a stabil adatmezőre — és CSAK olyan szkriptre, amelyik
   * a mostani videót nevezi meg. Ez a legnyersebb forrás, ezért az utolsó.
   */
  function authorsFromPlayerData(id) {
    if (!id) return [];
    const out = [];
    for (const s of document.scripts) {
      const t = s.textContent;
      if (!t || !t.includes(`"videoId":"${id}"`)) continue;
      const m = t.match(/"ownerProfileUrl"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) out.push(m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&'));
    }
    return out;
  }

  /** Melyik címre szólt már jelentés — egylapos váltásnál újra kell nézni. */
  let reportedFor = null;

  /**
   * A LAP csatornája, ha megmondható: a címből, vagy a lap saját adatából.
   * A csatorna-idő mérése használja — annak mindegy, hogy a csatorna
   * engedélyezett-e, csak az, hogy MELYIK.
   */
  function pageChannelKey() {
    const urlKey = chan.channelKeyFromPath(location.pathname);
    if (urlKey) return urlKey;
    const id = chan.contentIdOf(location.href);
    let candidates = [...authorsFromJsonLd(id), ...authorsFromMicrodata(id)];
    if (candidates.length === 0) candidates = authorsFromPlayerData(id);
    for (const raw of candidates) {
      let u;
      try {
        u = new URL(raw, location.href);
      } catch {
        continue;
      }
      const host = u.hostname.toLowerCase();
      if (!pageFilters.some((f) => chan.hostMatchesFilter(host, f.host))) continue;
      const key = chan.channelKeyFromPath(u.pathname);
      if (key) return key;
    }
    return null;
  }

  function checkPageAuthor() {
    if (pageFilters.length === 0 || reportedFor === location.href) return;
    // Csatorna-alakú címről a háttér már a navigációnál döntött; itt a
    // lejátszó-lapok dolgát végezzük, ahol a cím hallgat.
    if (chan.channelKeyFromPath(location.pathname)) return;
    const id = chan.contentIdOf(location.href);
    let candidates = [...authorsFromJsonLd(id), ...authorsFromMicrodata(id)];
    if (candidates.length === 0) candidates = authorsFromPlayerData(id);
    if (candidates.length === 0) return;

    // Ha BÁRMELYIK jelölt engedélyezett, a lap marad: két forrás vitájában a
    // megengedő téved kisebbet. Csak akkor szólunk, ha van azonosított
    // feltöltő, és egyik sem engedélyezett.
    let violation = null;
    let allowedSeen = false;
    for (const raw of candidates) {
      let u;
      try {
        u = new URL(raw, location.href);
      } catch {
        continue;
      }
      const host = u.hostname.toLowerCase();
      const key = chan.channelKeyFromPath(u.pathname);
      if (!key) continue;
      for (const f of pageFilters) {
        if (!chan.hostMatchesFilter(host, f.host)) continue;
        if ((Array.isArray(f.allow) ? f.allow : []).includes(key)) allowedSeen = true;
        else if (!violation) violation = u.href;
      }
    }
    if (allowedSeen || !violation) return;
    reportedFor = location.href;
    // A döntés a háttéré: az a saját, frissen töltött szűrő-listájával ítél,
    // az itteni szűrés csak arra jó, hogy ne zaklassuk fölöslegesen.
    try {
      const p = chrome.runtime.sendMessage({ type: 'breaker:page-author', authorUrl: violation });
      if (p && typeof p.catch === 'function') p.catch(() => { /* a háttér épp alszik */ });
    } catch { /* a lap élete végén a csatorna már zárva lehet */ }
  }

  /** Összevonva, késleltetve: a mutáció-vihar alatt elég negyedmásodpercenként. */
  let authorTimer = null;
  /** A lap csatornája a mérésnek — a debounce frissíti, az óra csak olvassa. */
  let cachedChannel = null;
  function queueAuthorCheck() {
    if (pageFilters.length === 0 || authorTimer) return;
    authorTimer = setTimeout(() => {
      authorTimer = null;
      try {
        cachedChannel = { url: location.href, key: pageChannelKey() };
      } catch {
        cachedChannel = null;
      }
      try {
        checkPageAuthor();
      } catch { /* a lap fura DOM-ja ne állítsa le a rejtést */ }
    }, 250);
  }

  // ---------------------------------------------------------------------
  // CSATORNA-IDŐ. Ha a lap csatornája megmondható, mérjük is, mennyi időt
  // visz — másodpercenként, de csak amíg a lap látszik ÉS az ablak fókuszban
  // van: a háttérben szóló lap nem „használat”. Az írás a háttérben történik
  // (egy író, sorban), a tartalom-szkript csak jelent. Csak szűrős oldalon
  // fut — máshol a bővítmény nem gyűjt semmit.
  // ---------------------------------------------------------------------
  let pendingKey = null;
  let pendingSec = 0;
  function flushTime() {
    if (!pendingKey || pendingSec <= 0 || pageFilters.length === 0) return;
    const msg = {
      type: 'breaker:channel-time',
      host: pageFilters[0].host,
      key: pendingKey,
      seconds: pendingSec,
    };
    pendingSec = 0;
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') p.catch(() => { /* a háttér alszik */ });
    } catch { /* a lap élete végén a csatorna már zárva lehet */ }
  }
  let ticker = null;
  function ensureTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      if (pageFilters.length === 0) return;
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      const key = cachedChannel && cachedChannel.url === location.href
        ? cachedChannel.key : null;
      if (!key) return;
      // Kulcsváltásnál (egylapos navigáció) előbb a régi kerül kiírásra.
      if (pendingKey && pendingKey !== key) flushTime();
      pendingKey = key;
      pendingSec += 1;
      if (pendingSec >= TIME_FLUSH_SECONDS) flushTime();
    }, 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushTime();
    });
    addEventListener('pagehide', () => { flushTime(); });
  }

  // A hírfolyam görgetés közben tölt be. Egyszeri futtatás csak azt takarná el,
  // ami az első képernyőn volt — a többi szépen megjelenne. Ugyanez a figyelő
  // veszi észre az egylapos váltást is: a metaadat cseréje DOM-változás.
  // LUSTÁN indul: amíg se szabály, se ide szóló szűrő nincs, egy figyelő sem
  // dolgozik — a bővítmény ott nem fogyaszthat, ahol nincs dolga.
  let observer = null;
  function ensureObserver() {
    if (observer) return;
    observer = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (node.nodeType === 1) hideMatches(node);
        }
      }
      queueAuthorCheck();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------
  // KULCSSZÓ A CÍMSORBAN. A navigáció-figyelő a webcímet látja; a lap
  // címsorát (a <title>-t) csak a lapban futó kód. Betöltéskor és minden
  // váltásnál (az egylapos oldalak a címsort cserélik) megnézzük; találatnál a
  // háttérnek szólunk — a döntés OTT születik, a saját listájával, a
  // böngészőtől kérdezett címsorból. A lap csak jelez.
  // ---------------------------------------------------------------------
  let keywords = [];
  let titleObserver = null;
  let reportedTitle = '';
  function checkTitle() {
    if (keywords.length === 0) return;
    const title = String(document.title || '');
    if (!title || title === reportedTitle) return;
    const hit = kw.keywordInText(keywords, title);
    if (!hit) return;
    reportedTitle = title;
    try {
      const p = chrome.runtime.sendMessage({ type: 'breaker:title-hit', keyword: hit });
      if (p && typeof p.catch === 'function') p.catch(() => { /* a háttér épp alszik */ });
    } catch { /* a lap élete végén a csatorna már zárva lehet */ }
  }
  function ensureTitleWatch() {
    checkTitle();
    if (titleObserver || keywords.length === 0) return;
    titleObserver = new MutationObserver(() => checkTitle());
    // A <title> szövege és a <head> gyerekei: a címsor cseréje is változás.
    titleObserver.observe(document.head || document.documentElement,
      { childList: true, subtree: true, characterData: true });
  }

  function applyConfig(newRules, newChannels, newKeywords) {
    rules = Array.isArray(newRules) ? newRules : [];
    channels = Array.isArray(newChannels) ? newChannels : [];
    keywords = (Array.isArray(newKeywords) ? newKeywords : []).filter((k) => typeof k === 'string' && k);
    reportedTitle = '';
    ensureTitleWatch();
    // Csak azok a szűrők érdekesek, amelyek ERRE az oldalra szólnak — a többi
    // oldalon a csatorna-logika el sem indul, ne is fogyasszon semmit.
    pageFilters = channels.filter(
      (f) => f && chan.hostMatchesFilter(String(location.hostname ?? '').toLowerCase(), f.host),
    );
    if (rules.length === 0 && pageFilters.length === 0) return;
    ensureObserver();
    if (pageFilters.length > 0) ensureTicker();
    hideMatches(document);
    queueAuthorCheck();
  }

  async function fetchConfig() {
    const answer = await chrome.runtime.sendMessage({ type: 'breaker:active-rules' });
    // Válasz nélkül záródó port vagy üres válasz: ez nem beállítás, hanem
    // elveszett üzenet — a hívó újrapróbál.
    if (!answer || typeof answer !== 'object') throw new Error('a háttér nem válaszolt');
    applyConfig(answer.rules, answer.channels, answer.keywords);
  }

  /**
   * ÚJRAPRÓBÁLVA. A háttér egy MV3 service worker: ha épp indul vagy frissül,
   * az első üzenet elveszhet — a port válasz nélkül záródik. Eddig egy ilyen
   * lap szűrő és csatorna-idő-mérés nélkül maradt újratöltésig: a navigáció
   * megállítása megvolt, de a hírfolyam-rejtés és a mérés csendben kimaradt,
   * és semmi nem jelezte. Három próba, növekvő szünettel; ami azután sem
   * jön, azt a tár-figyelő hozza, ha a háttér később ír.
   */
  const CONFIG_RETRY_DELAYS = [300, 1000, 3000];
  async function fetchConfigWithRetry() {
    for (let attempt = 0; ; attempt++) {
      try {
        await fetchConfig();
        return;
      } catch (e) {
        if (attempt >= CONFIG_RETRY_DELAYS.length) throw e;
        await new Promise((resolve) => setTimeout(resolve, CONFIG_RETRY_DELAYS[attempt]));
      }
    }
  }

  try {
    await fetchConfigWithRetry();
  } catch {
    // A háttér a próbák után sem felelt. Rejtés nélkül indulunk — a navigáció
    // megállítása attól még megvan, és az a fontosabb réteg. A tár-figyelő
    // lent ettől még él: ha a háttér később ír, innen is felébredünk.
  }

  // ---------------------------------------------------------------------
  // A NYITOTT LAP IS. A tiltás eddig csak navigáláskor dőlt el: a munkamenet
  // indulásakor, a keret beteltekor vagy egy új szabály felvételekor már
  // nyitott lap nyitva maradt, a benne szóló videó ment tovább. Most a
  // LÁTHATÓ lap újranézeti magát a háttérrel — ugyanazzal a döntéssel, mint a
  // navigáció:
  //   - a szabályok változásakor (tár) — azonnal;
  //   - amikor a lap láthatóvá válik — a háttérben maradt fülön ez dönt;
  //   - látható lapnál húsz másodpercenként: ez ÉBRESZTI a hátteret, hogy az
  //     appot is megkérdezze. Enélkül egy navigálás nélkül nézett videó
  //     mellett a bővítmény meg sem tudná, hogy elindult egy munkamenet.
  // A rejtett lap nem kérdez: ami nem látszik, az nem viszi el a figyelmet,
  // és amikor előjön, úgyis újranéz.
  // ---------------------------------------------------------------------
  let recheckTimer = null;
  function recheck() {
    // A bővítmény frissítése után a régi lapokon árván marad ez a szkript:
    // ilyenkor megállunk, nem próbálkozunk húsz másodpercenként a semmibe.
    if (!chrome.runtime?.id) {
      if (recheckTimer !== null) clearInterval(recheckTimer);
      recheckTimer = null;
      return;
    }
    if (document.visibilityState !== 'visible') return;
    if (!/^https?:$/.test(location.protocol)) return;
    try {
      const p = chrome.runtime.sendMessage({ type: 'breaker:recheck', editing: editingNow() });
      if (p && typeof p.then === 'function') {
        p.then((r) => {
          // A zárás előtti sáv: ha a háttér közelgő zárást mond, kitesszük
          // (vagy frissítjük); ha már nem mond, levesszük.
          if (r?.soon) showSoonBanner(r.soon); else hideSoonBanner();
          if (!r?.deferred) return;
          if (!firstDeferredAt) firstDeferredAt = Date.now();
          hideSoonBanner();
          showClosingBanner(r.reason);
        }).catch(() => { /* a háttér alszik — a következő kör hozza */ });
      }
    } catch { /* a lap élete végén a csatorna már zárva lehet */ }
  }
  recheckTimer = setInterval(recheck, RECHECK_MS);
  document.addEventListener('visibilitychange', recheck);

  /**
   * Csak a lehúzás bélyegei változtak-e (idő, port, hibaüzenet) — a szabályok
   * nem. A háttér húsz másodpercenként húz le, és minden nyitott lap hallja:
   * ha ilyenkor mind a hátteret hívná, a sok nyitott fül folyamatos terhelés
   * lenne a semmiért.
   */
  function onlyStampsChanged(change) {
    if (!change || !change.oldValue || !change.newValue) return false;
    const strip = (v) => JSON.stringify({ ...v, fetchedAt: 0, attemptedAt: 0, error: null, port: null });
    try {
      return strip(change.oldValue) === strip(change.newValue);
    } catch {
      return false;
    }
  }

  // A szűrők és szabályok menet közben is változnak: az app frissíti a
  // hátteret, az a tárat. E nélkül egy régóta nyitva lévő lap a betöltéskori
  // állapotot őrizné — az újonnan bekapcsolt szűrő a régi lapokon
  // újratöltésig nem rejtene semmit, és senki nem értené, miért.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      // CSAK a beállítás-kulcsok érdekesek. A csatorna-idő kulcsa is
      // `breaker.` előtagú, és tízmásodpercenként íródik — ha arra is
      // frissítenénk, minden nyitott lap folyamatosan a hátteret hívná.
      if (!changes['breaker.applink'] && !changes['breaker.partial']) return;
      if (!changes['breaker.partial'] && onlyStampsChanged(changes['breaker.applink'])) return;
      fetchConfig().catch(() => { /* a háttér épp alszik */ });
      recheck();
    });
  } catch { /* nagyon régi böngésző — marad a betöltéskori állapot */ }
})();
