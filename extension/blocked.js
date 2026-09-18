// Mi fogta meg a lapot: egy részleges szabály, vagy egy futó munkamenet.
//
// Külön fájl, nem inline szkript: a bővítmények alap tartalombiztonsági
// házirendje az inline szkriptet nem engedi futni — csendben, hibaüzenet
// nélkül. A lap ilyenkor betöltődne, csak épp nem mondaná meg, mi tiltotta le.
// Modulként fut, hogy a megakadás-könyv magját (hits.js) ugyanabból a fájlból
// olvassa, amiből a háttér ír — két számolás két számot adna.
import { dayKey, hitsOn, hitsOnHost } from './hits.js';

const params = new URLSearchParams(location.search);
const focus = params.get('focus');

// A hosszú várakozás emberi léptékben: perc, óra, nap — mindig „kb.”, mert a
// percre kerekítésnél pontosabbat úgysem ígérhetünk. Itt fent, mert a zárlat
// és a zárva-lap is ezt használja.
const roughly = (min) => {
  if (min >= 2 * 1440) return `kb. ${Math.round(min / 1440)} nap`;
  if (min >= 90) return `kb. ${Math.round(min / 60)} óra`;
  return `kb. ${Math.max(min, 1)} perc`;
};

// A ZÁRLAT vége, ha az app zárlatban van. Amíg tart, a lap nem ígérhet
// feloldást: a szokásos „az appban, próbatétellel” láb hazugság lenne, mert
// zárlat alatt pont az az út nincs. Nem drágább — nincs.
const lockdownUntil = Number(params.get('lockdownUntil'));
// A heti ablak tartja-e: a lap kimondja, hogy nem kézzel indított döntés
// volt, hanem a hétköznap — és hogy az ablak végéig tart.
const lockdownByWindow = params.get('lockdownWindow') === '1';
const lockdownText = () => {
  const ms = lockdownUntil - Date.now();
  if (!Number.isFinite(lockdownUntil) || ms <= 0) return null;
  const head = lockdownByWindow ? 'Zárlat van érvényben a heti ablak szerint' : 'Zárlat van érvényben';
  return `${head}: még ${roughly(Math.ceil(ms / 60000))}. Amíg tart, ezt semmilyen `
    + 'próbatétellel nem lehet feloldani — az appban sem. Szigorítani lehet, lazítani nem.';
};
// A MEGBÍZOTT (párban zárolás): ha van, a feloldás útja az ő jelmondatával ér
// véget — a láb ezt mondja a próbatétel mellé, mert a kísértés pillanatában
// ez a különbség: nem elég egyedül átrágni magad rajta. A nevet a lap újra
// tisztítja, mert erre a lapra kézzel írt címmel is el lehet jutni.
const partnerName = (params.get('partner') || '')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
const withPartner = (text) => (partnerName
  ? `${text} A feloldáshoz a megbízottad (${partnerName}) jelmondata is kell — az utolsó szó az övé.`
  : text);
/**
 * A láb szövege: zárlat alatt a zárlaté, különben a `fallback` — megbízottal
 * az ő mondatával. Félpercenként újranéz — és a zárlat LEJÁRTAKOR visszaáll a
 * rendes lábra, különben a lap az ellenkező irányba hazudna: egy már nem
 * létező zárlatot mondana. Zárlat alatt a megbízott sem szerepel: ott út sincs.
 */
const paintFoot = (el, fallback) => {
  let timer = null;
  const paint = () => {
    const t = lockdownText();
    el.textContent = t ?? withPartner(fallback);
    if (t === null && timer !== null) clearInterval(timer);
  };
  paint();
  if (lockdownText() !== null) timer = setInterval(paint, 30_000);
};

if (focus) {
  document.getElementById('focusCard').hidden = false;
  document.getElementById('focusName').textContent = focus;
  // Nem gombnyomásra indult: aki nem maga indította, itt tudja meg, miért fut.
  if (params.get('window') === '1') document.getElementById('focusWindow').hidden = false;
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
  // Zárlat alatt a menet leállítása sem indítható — a láb ezt mondja, nem a
  // próbatétel útját.
  const focusFoot = document.getElementById('focusFoot');
  paintFoot(focusFoot, focusFoot.textContent);
} else if (params.get('closedReason')) {
  // Az EGÉSZ oldal zárva (a tiltást a DNS tartja; ez a lap csak megmondja,
  // miért). Az ok négyféle, és a lap mind a négyről a maga nyelvén beszél —
  // egy általános „tiltva” pont azt a kérdést hagyná nyitva, amiért ez a lap
  // egyáltalán létezik: hogy MIKOR és MITŐL nyílik újra.
  document.getElementById('closedCard').hidden = false;
  document.getElementById('closedHost').textContent = params.get('closedHost') || 'ez az oldal';
  const until = Number(params.get('until'));
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
  // A láb alapból a feloldás útját mondja; zárlat alatt a zárlatot — az út
  // most nincs, és ezt a lapnak ki kell mondania, nem elhallgatnia.
  paintFoot(document.getElementById('closedFoot'), t.foot);
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
  // Zárlat alatt új csatornát sem lehet engedélyezni — a láb ezt mondja.
  const channelFoot = document.getElementById('channelFoot');
  paintFoot(channelFoot, channelFoot.textContent);
  if (params.get('by') === 'video') {
    // A kulcs nem a címből jött, hanem a lap saját adatából: a videó
    // feltöltőjéből. Ezt ki kell mondani, különben az ember a címben keresné
    // a csatornát — ott pedig nincs.
    document.getElementById('channelTitle').textContent =
      'Ennek a videónak a csatornája nincs az engedélyezettek közt.';
    document.getElementById('channelSeen').textContent =
      'A cím ezt nem árulja el, de a lap igen — a videót ez a csatorna töltötte fel:';
  }
} else if (params.get('keyword')) {
  // A KULCSSZÓ fogta meg: bármely oldalon, ha a cím tartalmazza. A lap kiírja,
  // MELYIK szó — az appban azt kell megkeresni, ha levennéd. Újra tisztítva,
  // mert erre a lapra kézzel írt címmel is el lehet jutni.
  document.getElementById('keywordCard').hidden = false;
  document.getElementById('keyword').textContent = (params.get('keyword') || '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, 40) || 'ismeretlen kulcsszó';
  // A webcímben vagy a lap címsorában volt: a lap kimondja, hol fogta meg.
  if (params.get('by') === 'title') {
    document.getElementById('keywordWhere').textContent = 'A lap címsora tartalmazza:';
  }
  const keywordFoot = document.getElementById('keywordFoot');
  paintFoot(keywordFoot, keywordFoot.textContent);
} else {
  document.getElementById('ruleCard').hidden = false;
  const rule = params.get('rule');
  document.getElementById('rule').textContent =
    rule && rule.trim() ? rule : 'ismeretlen szabály';
}

// Az INDOK: amiért te magad tiltottad le — a kísértés pillanatában ez a
// mondat számít, nem a szabály neve. Bármelyik kártya alatt megjelenik, ha az
// app adott ilyet; a szöveg a tiédről jön, de a lap újra megtisztítja, mert
// erre a lapra kézzel írt címmel is el lehet jutni.
{
  const rawNote = params.get('note') || '';
  const note = rawNote.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
  const noteEl = document.getElementById('note');
  if (note && noteEl) {
    noteEl.textContent = `Ezért tiltottad le: „${note}”`;
    noteEl.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// HÁNYADSZOR MA. A bővítmény könyve, a kísértés pillanatában:
// „Ma ez a 7. megakadás — ebből a 3. ezen az oldalon.” Tükör, nem ítélet.
// A háttér az átirányítás UTÁN könyvel, ezért a tár változását is figyeljük:
// a szám magától jó lesz, mire az ember odanéz.
// ---------------------------------------------------------------------------
function hostOfUrl(url) {
  const s = String(url || '').trim();
  if (!/^https?:\/\//i.test(s)) return null;
  const rest = s.replace(/^https?:\/\//i, '').replace(/^[^/@]*@/, '');
  const cut = rest.search(/[/?#]/);
  let host = cut < 0 ? rest : rest.slice(0, cut);
  const colon = host.indexOf(':');
  if (colon >= 0) host = host.slice(0, colon);
  return host.toLowerCase().replace(/\.+$/, '') || null;
}

const hitsNote = document.getElementById('hitsNote');
const fromHost = hostOfUrl(params.get('from') || '');

function paintHits(state) {
  const today = dayKey();
  const n = hitsOn(state, today);
  if (n <= 0) { hitsNote.hidden = true; return; }
  const onHost = fromHost ? hitsOnHost(state, today, fromHost) : 0;
  hitsNote.textContent = `Ma ez a ${n}. megakadás`
    + (onHost > 1 ? ` — ebből a ${onHost}. ezen az oldalon` : '') + '.';
  hitsNote.hidden = false;
}

try {
  chrome.storage.local.get('breaker.hits')
    .then((got) => paintHits(got?.['breaker.hits'] ?? { days: {} }))
    .catch(() => { /* tár nélkül nincs szám — a lap többi része attól még áll */ });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['breaker.hits']) paintHits(changes['breaker.hits'].newValue ?? { days: {} });
  });
} catch { /* nem bővítmény-környezet (pl. kézzel megnyitott fájl) */ }
