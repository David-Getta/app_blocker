// A találatok eltüntetése az oldalról.
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

(async () => {
  const { matchesRule } = await import(chrome.runtime.getURL('rules-core.js'));

  let rules = [];
  try {
    const answer = await chrome.runtime.sendMessage({ type: 'breaker:active-rules' });
    rules = Array.isArray(answer?.rules) ? answer.rules : [];
  } catch {
    // A háttér épp alszik vagy frissül. Rejtés nélkül maradunk — a navigáció
    // megállítása attól még megvan, és az a fontosabb réteg.
    return;
  }
  if (rules.length === 0) return;

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

  function hideMatches(root) {
    const links = root.querySelectorAll?.('a[href]') ?? [];
    for (const link of links) {
      let href;
      try {
        href = new URL(link.getAttribute('href') ?? '', location.href).href;
      } catch {
        continue;
      }
      if (!rules.some((r) => matchesRule(r, href))) continue;
      const card = cardOf(link);
      if (card.dataset?.breakerHidden === '1') continue;
      if (card.dataset) card.dataset.breakerHidden = '1';
      card.style.display = 'none';
    }
  }

  hideMatches(document);

  // A hírfolyam görgetés közben tölt be. Egyszeri futtatás csak azt takarná el,
  // ami az első képernyőn volt — a többi szépen megjelenne.
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType === 1) hideMatches(node);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
