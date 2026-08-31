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
} else if (params.get('closedReason')) {
  // Az EGÉSZ oldal zárva (a tiltást a DNS tartja; ez a lap csak megmondja,
  // miért). Az ok négyféle, és a lap mind a négyről a maga nyelvén beszél —
  // egy általános „tiltva” pont azt a kérdést hagyná nyitva, amiért ez a lap
  // egyáltalán létezik: hogy MIKOR és MITŐL nyílik újra.
  document.getElementById('closedCard').hidden = false;
  document.getElementById('closedHost').textContent = params.get('closedHost') || 'ez az oldal';
  const until = Number(params.get('until'));
  // A hosszú várakozás emberi léptékben: perc, óra, nap — mindig „kb.”, mert
  // a percre kerekítésnél pontosabbat úgysem ígérhetünk.
  const roughly = (min) => {
    if (min >= 2 * 1440) return `kb. ${Math.round(min / 1440)} nap`;
    if (min >= 90) return `kb. ${Math.round(min / 60)} óra`;
    return `kb. ${Math.max(min, 1)} perc`;
  };
  const texts = {
    cooldown: {
      title: 'Adag betelt — most szünet van.',
      body: 'Az adag-szabály, amit beállítottál: ennyi használat után ennyi '
        + 'szünet. A szünet magától lejár, és az oldal magától kinyílik — '
        + 'addig minden böngészőben és appban zárva.',
      foot: 'Nagyobb adagot vagy rövidebb szünetet kérni a Breaker appban '
        + 'lehet, és próbatételbe kerül. A már futó szünetet az sem engedi '
        + 'el — az magától jár le.',
      left: (min) => (min <= 1 ? 'Kevesebb mint egy perc, és újranyílik.'
        : `Újranyílik magától: még ${roughly(min)}.`),
      done: 'A szünet letelt — az oldal újra nyitva.',
    },
    limit: {
      title: 'A mai keret betelt.',
      body: 'Ennyi fért ma ebbe az oldalba — a keret minden eszközöd idejét '
        + 'együtt számolja, és éjfélkor újraindul.',
      foot: 'Ma többet csak feloldással lehet: az a Breaker appban megy, és '
        + 'próbatételbe kerül — különben a keret csak javaslat lenne.',
      left: (min) => `Éjfélkor újraindul — még ${roughly(min)}.`,
      done: 'Új nap, új keret — az oldal újra nyitva.',
    },
    schedule: {
      title: 'Menetrend szerint most zárva.',
      body: 'Ennek az oldalnak megszabtad, mikor nyithat — most épp zárva '
        + 'tart. A pontos rendet a Breaker appban látod.',
      foot: 'A menetrenden lazítani az appban lehet, próbatétellel — '
        + 'szigorítani ingyen.',
      left: (min) => `Nyit: még ${roughly(min)}.`,
      done: 'A menetrend szerint az oldal újra nyitva.',
    },
    always: {
      title: 'Ezt az oldalt te tiltottad le.',
      body: 'A Breaker blokklistáján van, ezért minden böngészőben és appban '
        + 'zárva — inkognitóban is.',
      foot: 'Levenni a Breaker appban lehet, és próbatételbe kerül — épp '
        + 'azért, hogy egy gyenge pillanat ne legyen elég hozzá.',
      left: null,
      done: null,
    },
  };
  const t = texts[params.get('closedReason')] ?? texts.always;
  document.getElementById('closedTitle').textContent = t.title;
  document.getElementById('closedBody').textContent = t.body;
  document.getElementById('closedFoot').textContent = t.foot;
  if (t.left && Number.isFinite(until) && until > 0) {
    const el = document.getElementById('closedLeft');
    el.hidden = false;
    // Az eredeti cím, amiről a tiltás lehozott — a lejáratkor ebből lesz link.
    // Újra ellenőrizzük, pedig a háttér is tette: erre a lapra kézzel írt
    // címmel is el lehet jutni, és innen csak valódi webcímre mutathat link.
    const from = params.get('from');
    const backTo = from && /^https?:\/\//i.test(from) && from.length <= 2000 ? from : null;
    const paint = () => {
      const min = Math.ceil((until - Date.now()) / 60000);
      if (min <= 0) {
        // Lejárt. Nem találgatunk („mindjárt”): a tiltás lapját a böngésző
        // magától nem cseréli vissza — adunk utat, ha van hová.
        el.textContent = t.done + (backTo ? '' : ' Töltsd újra az oldalt.');
        if (backTo) {
          const back = document.getElementById('closedBack');
          back.hidden = false;
          document.getElementById('closedBackLink').href = backTo;
        }
      } else {
        el.textContent = t.left(min);
      }
    };
    paint();
    // Fél percenként frissül: egy beragadt szám azt sugallná, hogy áll az idő.
    setInterval(paint, 30_000);
  }
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
