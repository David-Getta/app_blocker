// Mi fogta meg a lapot: egy részleges szabály, vagy egy futó munkamenet.
//
// Külön fájl, nem inline szkript: a bővítmények alap tartalombiztonsági
// házirendje az inline szkriptet nem engedi futni — csendben, hibaüzenet
// nélkül. A lap ilyenkor betöltődne, csak épp nem mondaná meg, mi tiltotta le.
const params = new URLSearchParams(location.search);
const focus = params.get('focus');

if (focus) {
  document.getElementById('focusCard').hidden = false;
  document.getElementById('focusName').textContent = focus;
  const endsAt = Number(params.get('endsAt'));
  const left = () => {
    const ms = endsAt - Date.now();
    if (!Number.isFinite(endsAt) || ms <= 0) return 'Mindjárt lejár.';
    const min = Math.ceil(ms / 60000);
    if (min >= 60) {
      const h = Math.floor(min / 60);
      const m = min % 60;
      return m === 0 ? `Még ${h} óra van hátra.` : `Még ${h} ó ${m} p van hátra.`;
    }
    return min <= 1 ? 'Kevesebb mint egy perc van hátra.' : `Még ${min} perc van hátra.`;
  };
  const el = document.getElementById('focusLeft');
  el.textContent = left();
  // Percenként frissül: egy beragadt szám azt sugallná, hogy nem telik az idő.
  setInterval(() => { el.textContent = left(); }, 30_000);
} else if (params.get('channel')) {
  // A csatorna-szűrő fogta meg. A lap kiírja, MILYEN kulcsot látott: az
  // engedélyezéshez így nem kell találgatni — azt kell felvenni, ami itt áll.
  document.getElementById('channelCard').hidden = false;
  document.getElementById('channelKey').textContent = params.get('channel');
  document.getElementById('channelHost').textContent =
    params.get('channelHost') || 'ez az oldal';
  if (params.get('by') === 'video') {
    // A kulcs nem a címből jött, hanem a lap saját adatából: a videó
    // feltöltőjéből. Ezt ki kell mondani, különben az ember a címben keresné
    // a csatornát — ott pedig nincs.
    document.getElementById('channelTitle').textContent =
      'Ennek a videónak a csatornája nincs az engedélyezettek közt.';
    document.getElementById('channelSeen').textContent =
      'A cím ezt nem árulja el, de a lap igen — a videót ez a csatorna töltötte fel:';
  }
} else {
  document.getElementById('ruleCard').hidden = false;
  const rule = params.get('rule');
  document.getElementById('rule').textContent =
    rule && rule.trim() ? rule : 'ismeretlen szabály';
}
