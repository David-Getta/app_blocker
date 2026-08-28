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

(async () => {
  const [{ matchesRule }, chan] = await Promise.all([
    import(chrome.runtime.getURL('rules-core.js')),
    import(chrome.runtime.getURL('channels.js')),
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

  function applyConfig(newRules, newChannels) {
    rules = Array.isArray(newRules) ? newRules : [];
    channels = Array.isArray(newChannels) ? newChannels : [];
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
    applyConfig(answer?.rules, answer?.channels);
  }

  try {
    await fetchConfig();
  } catch {
    // A háttér épp alszik vagy frissül. Rejtés nélkül indulunk — a navigáció
    // megállítása attól még megvan, és az a fontosabb réteg. A tár-figyelő
    // lent ettől még él: ha a háttér később ír, innen is felébredünk.
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
      fetchConfig().catch(() => { /* a háttér épp alszik */ });
    });
  } catch { /* nagyon régi böngésző — marad a betöltéskori állapot */ }
})();
