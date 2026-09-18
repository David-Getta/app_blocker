#!/usr/bin/env node
// Tényleg MEGKÉRDEZI-e valaki a döntést hozó függvényt.
//
// MIÉRT LÉTEZIK. Ennek a projektnek a visszatérő hibafajtája nem a rossz
// logika, hanem a HUZALOZATLAN logika: a mag megvan, teszt is van rá, csak
// éppen senki nem hívja. Semmi nem hasal el tőle — se fordítás, se teszt —, az
// app hibátlannak látszik, a tiltás meg nem történik meg. A felhasználó pedig
// azt hiszi, védve van.
//
// Az „Új csomag” gomb így volt kezelő nélkül egy kiadáson át. Egy nem hívott
// `Focus.verdict` ennél sokkal rosszabb: ott a munkamenet látszana futni, a
// telefon meg mindent beengedne.
//
// A fordítás ezt SOHA nem fogja ki: egy nem hívott függvény tökéletesen
// érvényes kód.
//
// MIT FED. A lista lentebb pontosan megmondja, de csoportosítva ezek:
//
//   - a blokklista tényleges alkalmazása (hosts fájl, DNS-szűrő, alagút);
//   - ami eldönti, melyik név kerül a tiltásba (szünet, menetrend, napi keret);
//   - a munkamenet fehérlistája mind a négy felületen;
//   - a munkamenet naplója: lezárás, egyesítés, összegzés;
//   - a súrlódás eszkalációja (a fok kiszámítása);
//   - a részleges tiltás a böngészőben;
//   - a szinkron körei;
//   - a frissítés-keresés;
//   - két figyelmeztetés, ami nélkül a felhasználó nem tudná meg, hogy a
//     munkamenetet épp nem érvényesíti senki.
//
// MIT NEM FED — és ezt ki kell mondani, mert egy harmincegy pontos ellenőrző
// könnyen ad hamis biztonságérzetet:
//
//   - ez SZÖVEGET keres, nem hívási gráfot. Ha a hívás egy soha le nem futó
//     ágban áll, az ellenőrző elégedett;
//   - ha a döntést MEGKÉRDEZIK, de az eredményét eldobják, nem szól;
//   - ha rossz bemenettel hívják (más `now`, más lista), nem szól;
//   - ha a függvény maga romlik el, nem szól — arra a tesztek vannak.
//
// Vagyis ez azt garantálja, hogy a döntés a HELYÉN van, nem azt, hogy jó. A
// kettő közül viszont az elsőt nem fogta ki eddig SEMMI, és a projekt hibái
// épp abból a fajtából valók.
//
// Futtatás: node scripts/check-enforcement.js

const fs = require('fs');
const path = require('path');

const ROOT = __dirname.replace(/\/scripts$/, '');

/**
 * Egy huzalozás: melyik fájlban KELL szerepelnie melyik hívásnak, és mi
 * veszne el, ha nem szerepelne.
 *
 * A `needle` szándékosan a HÍVÁS neve, nem egy import: importálni lehet
 * használat nélkül is.
 */
const WIRES = [
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'Focus.verdict',
    lost: 'az androidos DNS-szűrő nem venné figyelembe a munkamenetet — a '
      + 'fehérlista látszólag futna, a telefon meg mindent beengedne',
  },
  {
    file: 'ios/PacketTunnel/PacketTunnelProvider.swift',
    needle: 'Focus.verdict',
    lost: 'az iPhone alagútja nem venné figyelembe a munkamenetet',
  },
  {
    file: 'extension/background.js',
    needle: 'focusActive',
    lost: 'a böngésző-bővítmény nem érvényesítené a fehérlistát a gépen',
  },
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'summarizeFocus',
    lost: 'a munkamenet-statisztika üresen állna, mert senki nem számolná ki',
  },
  // A MÉRÉS KÉZBESÍTÉSE. A segéd minden mintát ellenőriz, és amit nem fogad
  // el, azt szó nélkül eldobja — a kérés attól még sikeres. Ha ezt a két
  // pontot bárki kiveszi, a mért idő megint némán elvész: a szonda dolgozik,
  // a felület nullát mutat, és a napi keret sosem fogy el.
  {
    file: 'desktop/src/main/tracker.ts',
    needle: 'delivery.record',
    lost: 'a mérés nem venné észre, ha a segéd sorozatban egyetlen mintát sem '
      + 'rögzít — a mért idő némán elveszne, figyelmeztetés nélkül',
  },
  // MIKOR MÉRTÜNK UTOLJÁRA. Enélkül a statisztikán a nulla néma marad: nem
  // lehet megmondani belőle, hogy tényleg nem használtad a gépet, vagy a mérés
  // hasalt el. A segédnek fel kell jegyeznie, a felületnek ki kell írnia.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'usageLastSampleAt = s.at',
    lost: 'a segéd nem jegyezné fel, mikor mért utoljára — a statisztikán a '
      + 'nulla megkülönböztethetetlen maradna az elhasalt méréstől',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'Utoljára mért idő',
    lost: 'az utolsó mérés ideje nem jutna képernyőre',
  },
  // MIKOR MÉRTÜNK UTOLJÁRA — a TELEFONON is. A nulla ott ugyanolyan néma, mint
  // a gépen: nem derül ki belőle, hogy tényleg nem használtad a készüléket,
  // vagy hogy a mérés hasalt el.
  {
    file: 'android/app/src/main/java/hu/breaker/app/usage/UsageTracker.kt',
    needle: 'usageLastSampleAt = latest',
    lost: 'a telefon nem jegyezné fel, mikor mért utoljára',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'lastSampleLine(lastSampleAt)',
    lost: 'a telefonon az utolsó mérés ideje nem jutna képernyőre',
  },
  // A CSATORNA-SZŰRŐ LÁNCA. Négy szem, és bármelyik kiesésével a szűrő
  // némán díszletté válik: az appban ott áll, a böngésző meg mindent enged.
  {
    file: 'extension/background.js',
    needle: 'channelVerdict(url, link.channels)',
    lost: 'a böngésző nem kérdezné meg a csatorna-szűrőt — az appban minden '
      + 'beállítva, és mégis minden csatorna nyílna',
  },
  {
    file: 'desktop/src/main/main.ts',
    needle: '.filter((f) => f.enabled)',
    lost: 'a bekapcsolt szűrők nem jutnának le a hídra a bővítményhez',
  },
  {
    file: 'desktop/src/main/rules-bridge.ts',
    // A tű a VÁLASZ teste, nem a mezőnevek: a puszta felsorolás a
    // Promise.all szétszedésében is szerepel, és az elfedte a törlést.
    needle: 'BRIDGE_PROTOCOL, rules, focus, channels',
    lost: 'a híd válaszából kimaradna a csatorna-lista',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'renderChannelCard(status!)',
    lost: 'a csatorna-szűrők kártyája nem jelenne meg — a szűrő láthatatlan '
      + 'és kezelhetetlen lenne',
  },
  // A CSATORNA-SZŰRŐ MÁSODIK RÉTEGE: a hírfolyam-tisztítás és a lejátszó-lap
  // feltöltője. Ez öt szem, és mindegyik kiesése néma: a bővítmény betöltődik,
  // a régi réteg működik, csak épp a videók maradnának elérhetők.
  {
    file: 'extension/manifest.json',
    // E nélkül a tartalom-szkript importja NÉMÁN hal meg, és vele a rejtés
    // meg a feltöltő-keresés is — a bővítmény-füstteszt ezt fogta ki először.
    needle: '"channels.js"',
    lost: 'a tartalom-szkript nem tudná betölteni a csatorna-magot',
  },
  {
    file: 'extension/content.js',
    needle: 'chan.channelVerdict(href, pageFilters)',
    lost: 'a nem engedélyezett csatornák videókártyái ott maradnának a '
      + 'hírfolyamban',
  },
  {
    file: 'extension/content.js',
    needle: "type: 'breaker:page-author'",
    lost: 'a lejátszó-oldal feltöltőjéről senki nem szólna a háttérnek',
  },
  {
    file: 'extension/background.js',
    needle: 'authorVerdict(sender.url',
    lost: 'a feltöltő-jelzésből nem lenne döntés — a rossz csatorna videója '
      + 'lejátszódna',
  },
  {
    file: 'extension/background.js',
    needle: 'channels: link.channels',
    lost: 'a tartalom-szkript nem kapná meg a szűrőket, tehát se rejtés, se '
      + 'feltöltő-keresés',
  },
  {
    file: 'extension/background.js',
    // A tiltás MÁSODIK hálója. Az onBeforeNavigate egyetlen esély: ha a
    // szolgáltatás-worker ébredés közben elejti, a tiltott lap némán átmegy.
    // A redundancia törlésétől semmi nem hasal el — pont ezért kell ide.
    needle: 'chrome.webNavigation.onCommitted.addListener',
    lost: 'a tiltás második hálója tűnne el — egy elejtett esemény némán '
      + 'átengedne egy tiltott lapot',
  },
  // A CSATORNA-IDŐ HÁRMASA: mérés a lapon, írás a háttérben, lista a
  // beállításokon. Bármelyik kiesése néma: a szűrő ugyanúgy tilt, csak a
  // „melyik csatorna vitte az időt” kérdésre nem felelne senki.
  {
    file: 'extension/content.js',
    needle: 'if (pageFilters.length > 0) ensureTicker();',
    lost: 'a csatorna-idő órája el sem indulna — a mérés némán nulla maradna',
  },
  {
    file: 'extension/background.js',
    // A tű a SORBA FŰZÖTT hívás, nem a puszta név: az a definícióban is
    // szerepel, és elfedné a hívás törlését.
    needle: 'timeWrite.then(() => recordChannelTime(msg))',
    lost: 'a jelentett másodperceket senki nem írná be — a mérő dolgozna, '
      + 'a tár üres maradna',
  },
  {
    file: 'extension/options.js',
    needle: 'void renderChannelTime();',
    lost: 'a mért csatorna-idő ki lenne számolva, képernyőre nem jutna',
  },
  // A CSATORNA-SZŰRŐK SZINKRONJA. A kör és a számláló-léptetés két külön
  // szem: a kör nélkül a szűrők sosem indulnak útnak, a léptetés nélkül a
  // lazítás sosem nyerne a másik gépen — és egyik hiánya sem hasal el.
  {
    file: 'desktop/src/helper/sync-client.ts',
    needle: 'await syncChannelsRound(state, acc, key)',
    lost: 'a csatorna-szűrők sosem érnének át a másik gépre — az appban minden '
      + 'rendben látszana',
  },
  {
    file: 'desktop/src/helper/revisions.ts',
    needle: 'bumpChannelsRevision(state, deviceId, now)',
    lost: 'a szűrő-változás nem léptetne számlálót — a lazítás sosem nyerne a '
      + 'másik gépen, a szigorítás pedig egy régi állapottal is felülíródhatna',
  },
  // AZ ADAG-SZABÁLY LÁNCA. A számláló a mérésből gyűlik, a tiltás a hosts
  // fájlból lesz — négy szem két platformon, és bármelyik kiesése néma:
  // a beállítás ott áll a felületen, az oldal meg csak nem zár be soha.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'noteBurstUsage(b.rule, state.bursts[b.id]',
    lost: 'a gépen mért idő nem gyűlne az adagba — az adag sosem telne be',
  },
  {
    file: 'desktop/src/helper/hosts.ts',
    needle: 'state.bursts?.[site.id]',
    lost: 'a betelt adag nem jutna el a hosts fájlig — a hűtés csak kijelzés '
      + 'lenne, tiltás nem',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/usage/UsageTracker.kt',
    needle: 'BurstLogic.noteUsage(rule, bursts[siteId]',
    lost: 'a telefonon mért idő nem gyűlne az adagba',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Store.kt',
    needle: 'state.bursts[site.id]',
    lost: 'a telefonon a betelt adag nem tiltana — a DNS-szűrő nem tudna róla',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'openBurstDialog(site)',
    lost: 'az adag-szabályt nem lehetne beállítani — a mag ott lenne, kapcsoló '
      + 'nélkül',
  },
  // A ZÁRVA-MAGYARÁZAT LÁNCA. A tiltást a DNS tartja, ez a lánc csak a
  // MIÉRT-et viszi a böngészőig — de pont ezért a kiesése a legcsendesebb:
  // minden tiltana tovább, csak a felhasználó bámulna megint nyers hibalapot.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'closedReason: why?.reason',
    lost: 'a segéd nem mondaná meg a zárás okát — a híd üres listát adna, a '
      + 'tiltó lap némán kimaradna',
  },
  {
    file: 'desktop/src/main/main.ts',
    needle: '!site.blockedNow || !site.closedReason',
    lost: 'a zárva-lista nem épülne fel a hídra — a bővítmény sosem tudná meg, '
      + 'mi van zárva és miért',
  },
  {
    file: 'desktop/src/main/main.ts',
    needle: 'window: isWindowRun(run, packs)',
    lost: 'a híd nem mondaná meg a bővítménynek, hogy a menet a heti ablak '
      + 'szerint indult — a felugró és a tiltó lap gombnyomásnak hinné',
  },
  {
    file: 'extension/background.js',
    needle: "if (hit.focus.window === true) q.set('window', '1')",
    lost: 'a tiltó lap nem tudná meg, hogy a menet az ablak szerint indult — '
      + 'a sor, ami ezt kimondja, örökre rejtve maradna',
  },
  {
    file: 'extension/background.js',
    needle: 'closedFor(link, hostOf(url), now)',
    lost: 'a bővítmény nem kérdezné meg, zárva-e az oldal — a hűtött oldalra '
      + 'megint a nyers DNS-hibalap jönne',
  },
  // A JAVASLAT a telefon felvevő kártyáján: a mérés tudja, mire ment el a hét,
  // a mag kiválogatja — ha a felület nem kérdezné, a sor csendben hiányozna.
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'UsageLogic.suggestBlocks(',
    lost: 'a telefon felvevő kártyáján nem lenne javaslat — a mérés tudná, a '
      + 'felület nem mondaná',
  },
  // PÁRBAN ZÁROLÁS: a megbízott lépése a bíró EGY kapuján kerül a terv végére.
  // A mag (partner.ts, Partner.kt, Partner.swift) teszttel megvan — ha a kapu
  // nem tenné rá, a megbízott a tárban ülne, és a lazítás nélküle menne. A
  // felületen pedig a lépést ki kell tudni rajzolni, különben a kísérlet
  // egy üres lapon állna meg — se hiba, se továbblépés.
  {
    file: 'desktop/src/helper/referee.ts',
    needle: 'if (state.partner) plan.steps.push(',
    lost: 'a gépen a megbízott a tárban ülne, és minden lazítás az ő jelmondata '
      + 'nélkül menne — a mag megvan, a bíró nem kérné',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Referee.kt',
    needle: 'val partner = state.partner ?: return plan',
    lost: 'a telefonon a gépen felvett megbízott nem jelentene semmit — a '
      + 'szinkron lehozná, a bíró nem kérné a jelmondatát',
  },
  {
    file: 'ios/Shared/Referee.swift',
    needle: 'guard let partner = state.partner else { return plan }',
    lost: 'iPhone-on a gépen felvett megbízott nem jelentene semmit — a '
      + 'szinkron lehozná, a bíró nem kérné a jelmondatát',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "case 'PARTNER': buildPartner(box, session, step)",
    lost: 'a gépen a megbízott lépése üres lapon állna meg — se mező, se hiba, '
      + 'se továbblépés',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'is Step.Partner -> PartnerStepUi(step, ::submit)',
    lost: 'a telefonon a megbízott lépése üres lapon állna meg',
  },
  {
    file: 'ios/App/ChallengeView.swift',
    needle: 'case .partner(let id, let name):',
    lost: 'iPhone-on a megbízott lépése üres lapon állna meg',
  },
  // A FÉLBEMARADT KÍSÉRLET könyvelése az EGY helyen, ahol minden nem
  // végigvitt kísérlet átmegy (dropSession). Ha kiesne, a visszatekintés
  // csak a feloldásokat mondaná — a tükör fele hiányozna, csendben.
  {
    file: 'desktop/src/helper/referee.ts',
    needle: 'state.droppedAttempts = [...(state.droppedAttempts ?? []).filter(',
    lost: 'a gépen a félbemaradt kísérlet nem lenne könyvelve — a visszatekintés '
      + 'csak a feloldásokat mondaná',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Referee.kt',
    needle: 'droppedAttempts = state.droppedAttempts.filter {',
    lost: 'a telefonon a félbemaradt kísérlet nem lenne könyvelve',
  },
  {
    file: 'ios/Shared/Referee.swift',
    needle: 'state.droppedAttempts = (state.droppedAttempts ?? []).filter {',
    lost: 'iPhone-on a félbemaradt kísérlet nem lenne könyvelve',
  },
  // A KULCSSZÓ-SZABÁLYOK: a híd leadja a listát, a háttér illeszt, a lap
  // kimondja; a segéd a levételt próbatételhez köti. Ha bármelyik kiesne, a
  // lista a tárban ülne, és a cím nyitva maradna — semmi nem hasalna el.
  {
    file: 'desktop/src/main/main.ts',
    needle: 'return s.keywords ?? [];',
    lost: 'a híd nem adná le a kulcsszavakat — a bővítmény nem tudna róluk',
  },
  {
    file: 'extension/background.js',
    needle: 'keywordHit(link.keywords ?? [], url)',
    lost: 'a bővítmény tárolná a kulcsszavakat, de nem illesztené a címre — a '
      + 'tiltás elmaradna',
  },
  {
    file: 'extension/blocked.js',
    needle: "params.get('keyword')",
    lost: 'a kulcsszó-tiltás a részleges szabály lapján állna meg — a lap nem '
      + 'mondaná, melyik szó fogta meg',
  },
  {
    file: 'desktop/src/helper/referee.ts',
    needle: 'if (s.pendingKeywords !== undefined) {',
    lost: 'a kulcsszó levételének próbatétele végigmenne, de a lista maradna — '
      + 'vagy a bíró oldal-feloldást adna helyette',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "'set_keywords'",
    lost: 'a kulcsszavak kártyája nem érné el a segédet — a gomb nem csinálna semmit',
  },
  // A KULCSSZAVAK A TELEFONON: a bíró a levételt próbatételhez köti, a
  // teljesítés a függő listát ülteti be, a felület a bírót hívja. Ha a
  // teljesítés ága kiesne, a kifizetett levétel némán elveszne; ha a felület
  // a tárba írna a bíró helyett, a levétel egy koppintás lenne.
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Referee.kt',
    needle: 'if (s.pendingKeywords != null) {',
    lost: 'Androidon a kifizetett kulcsszó-levétel némán elveszne',
  },
  {
    file: 'ios/Shared/Referee.swift',
    needle: 'if let words = s.pendingKeywords {',
    lost: 'iPhone-on a kifizetett kulcsszó-levétel némán elveszne',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'Referee.setKeywords(',
    lost: 'Androidon a kulcsszó nem a bírón át menne — a levétel egy koppintás lenne',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'Referee.setKeywords(',
    lost: 'iPhone-on a kulcsszó nem a bírón át menne — a levétel egy koppintás lenne',
  },
  // A SZŰRŐ MEGAKADÁSAI a telefonon: a szolgáltatás/tunnel könyvel a LISTA
  // tiltásánál, a heti mondat mondja. Ha a bekötés kiesne, a mag és a teszt
  // megvolna — a szám mindig nulla lenne, és semmi nem jelezné. Ha a feltétel
  // a munkamenet tiltását is számolná, a háttér-forgalom százat mondana.
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'if (reason != null && name != null && FilterHitLogic.shouldCount(hitSeen, name, now))',
    lost: 'Androidon a szűrő nem (csak a lista és a kulcsszó tiltásánál) könyvelné a megakadásokat',
  },
  {
    file: 'ios/PacketTunnel/PacketTunnelProvider.swift',
    needle: 'if let reason = FilterHitLogic.reasonOf(verdict), let name, FilterHitLogic.shouldCount(&hitSeen, name, now: now)',
    lost: 'iPhone-on a tunnel nem (csak a lista és a kulcsszó tiltásánál) könyvelné a megakadásokat',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Digest.kt',
    needle: 'filterHits7d = FilterHitLogic.hits7d(st.filterHits, now),',
    lost: 'Androidon a heti mondat nem mondaná a megakadásokat',
  },
  {
    file: 'ios/Shared/Digest.swift',
    needle: 'filterHits7d: FilterHitLogic.hits7d(st.filterHits ?? [:], now: now)',
    lost: 'iPhone-on a heti mondat nem mondaná a megakadásokat',
  },
  {
    file: 'extension/blocked.js',
    needle: "changes['breaker.hits']",
    lost: 'a tiltó lap nem mondaná, hányadszor ma — a könyv csak a felugró lapon látszana',
  },
  // A KULCSSZÓ A CÍMSORBAN: a tartalom-szkript jelez, a háttér dönt. Ha a
  // jelzés vagy a kezelő kiesne, a címsor-találat némán átmenne — a webcím
  // szabálya elfedné, hogy a másik fele nem működik.
  {
    file: 'extension/content.js',
    needle: "type: 'breaker:title-hit'",
    lost: 'a tartalom-szkript nem jelezné a címsor kulcsszavát',
  },
  {
    file: 'extension/background.js',
    needle: "if (msg?.type !== 'breaker:title-hit') return false;",
    lost: 'a háttér nem döntene a címsor kulcsszaváról — a jelzés a semmibe menne',
  },
  // A MEGAKADÁS OTT IS, AHOL A KÍSÉRTÉS VAN: a réteg lába és az Android
  // értesítése a mai számot mondja. Ha kiesne, a könyv megvolna — csak pont
  // ott nem látszana, ahol számít.
  {
    file: 'desktop/src/renderer/overlay.ts',
    needle: '|| stopWayLine(status)) + hitsLine(status);',
    lost: 'a gyorsbillentyűs réteg nem mondaná a mai megakadásokat',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'FilterHitLogic.hitsToday(st.filterHits, now)',
    lost: 'az Android értesítése nem mondaná a mai megakadásokat',
  },
  // A HÉTFŐ REGGELI EMLÉKEZTETŐ iPhone-on: a mondat az appban születik, az
  // értesítés odahív. Ha a bekötés kiesne, a napló sora megvolna — csak
  // senki nem tudna róla.
  {
    file: 'ios/App/ContentView.swift',
    needle: 'DigestReminder.reschedule()',
    lost: 'iPhone-on senki nem tudna a heti visszatekintésről — az értesítés nem szólna',
  },
  // A MEGAKADÁSOK NAPRÓL NAPRA a három statisztikán: ha a rajz bekötése
  // kiesne, a sor megvolna, a hét alakja nem — és senki nem hiányolná.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "'hitsWeekBlock', 'hitsWeekChart'",
    lost: 'a gépi statisztika nem rajzolná a megakadások hetét',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'filterHitDays = FilterHitLogic.daySeries(state.filterHits, now, 7),',
    lost: 'az Android statisztika nem rajzolná a megakadások hetét',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'FilterHitLogic.daySeries(store.state.filterHits ?? [:], now: now, count: 7)',
    lost: 'az iPhone statisztika nem rajzolná a megakadások hetét',
  },
  // A SOKADIK MEGAKADÁS javaslata: ha a bekötés kiesne, a lépcsők megvolnának
  // a magban — csak senki nem szólna.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'showHitNudge(status!.browserHitsToday ?? 0, nowForBurst);',
    lost: 'a gép nem javasolna lépést a sokadik megakadásnál',
  },
  {
    file: 'extension/blocked.js',
    needle: '+ hitsNudge(n);',
    lost: 'a tiltó lap nem javasolna lépést a sokadik megakadásnál',
  },
  // AZ ÓRÁK a telefonon: ha a szolgáltatás/tunnel nem könyvelné, a csúcs-óra
  // mindig üres lenne, és senki nem hiányolná.
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'FilterHitLogic.recordHour(it.filterHitHours, day, hour)',
    lost: 'Androidon a szűrő nem könyvelné az órákat — a csúcs-óra mindig üres',
  },
  {
    file: 'ios/PacketTunnel/PacketTunnelProvider.swift',
    needle: 'FilterHitLogic.recordHour($0.filterHitHours ?? [:], day: day, hour: hour)',
    lost: 'iPhone-on a tunnel nem könyvelné az órákat — a csúcs-óra mindig üres',
  },
  // A SOKADIK megakadás a telefonon: a mag tudja a lépcsőt, de ha a szolgáltatás
  // nem szólna és a lap nem mondaná, a javaslat sosem érne el senkihez.
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'FilterHitLogic.nudgeText(step), NUDGE_CHANNEL_ID',
    lost: 'Androidon a szolgáltatás nem szólna a sokadik megakadásnál',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'FilterHitLogic.nudgeText(nudge)',
    lost: 'az Android kezdőlapja nem javasolna lépést a sokadik megakadásnál',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'FilterHitLogic.nudgeText(step)',
    lost: 'az iPhone kezdőlapja nem javasolna lépést a sokadik megakadásnál',
  },
  // A HÓNAP a bővítmény beállítás-lapján: a saját könyvből, ugyanazzal a szabállyal.
  {
    file: 'extension/options.js',
    needle: 'const showMonth = monthHasOlderHits(month);',
    lost: 'a bővítmény beállítás-lapja nem rajzolná a hónap alakját',
  },
  // A MEGAKADÁSOK HARMINC NAPJA: a segéd a hónapot adja, a három statisztika rajzolja.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'browserHitsMonth: browserHitsSeries(state.browserHits, now, 30),',
    lost: 'a segéd nem adná a státuszba a hónap megakadásait',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'renderHitsMonth(status?.browserHitsMonth ?? []);',
    lost: 'a gépi statisztika nem rajzolná a megakadások harminc napját',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'filterHitMonth = FilterHitLogic.daySeries(state.filterHits, now, 30),',
    lost: 'az Android statisztika nem kapná meg a hónap megakadásait',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'DailyChart(filterHitMonth)',
    lost: 'az Android statisztika nem rajzolná a megakadások harminc napját',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'MonthBars(series: hitMonth)',
    lost: 'az iPhone statisztikája nem rajzolná a megakadások harminc napját',
  },
  // AZ ADAG A HÉTEN a heti mondatban és az oldal sorában: a két építő és a két sor.
  {
    file: 'desktop/src/helper/digest-journal.ts',
    needle: 'burstTripsWeek: state.sites.reduce((a, s) => a + burstTripsInDays(state.burstTripLog, s.id, dayKeysBack(now, 7)), 0),',
    lost: 'a gépi heti mondat nem mondaná az adag heti beteléseit',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Digest.kt',
    needle: 'burstTripsWeek = st.sites.sumOf { BurstLogic.tripsInDays(st.burstTripLog, it.id, UsageLogic.dayKeysBack(now, 7)) },',
    lost: 'az Android heti mondat nem mondaná az adag heti beteléseit',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "if (weekTrips > trips) label += ` · a héten ${weekTrips}×`;",
    lost: 'a gépi adag-sor nem mondaná a hét beteléseit',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'weekTrips = BurstLogic.tripsInDays(state.burstTripLog, site.id, UsageLogic.dayKeysBack(now, 7)),',
    lost: 'az Android adag-sor nem kapná meg a hét beteléseit',
  },
  // A BETELÉSEK KÖNYVE: a betelés a könyvbe is megy, a takarítás hét napot tart,
  // a státusz a hét összegét adja — ha bármelyik kiesne, a hét sora üres vagy hazug.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'state.burstTripLog = noteBurstTrip(state.burstTripLog, b.id, today);',
    lost: 'a segéd nem könyvelné a betelést a hét könyvébe',
  },
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'burstTripsWeek: burstTripsInDays(state.burstTripLog, s.id, dayKeysBack(now, 7)),',
    lost: 'a státusz nem adná a hét adag-beteléseit',
  },
  {
    file: 'desktop/src/helper/referee.ts',
    needle: 'sweepBurstTripLog(state.burstTripLog, state.sites.map((s) => s.id), dayKeysBack(now, 7))',
    lost: 'a betelések könyve nem takarítana — a régi napok bent maradnának',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/usage/UsageTracker.kt',
    needle: 'tripLog = BurstLogic.noteTrip(tripLog, siteId, today)',
    lost: 'Androidon a betelés nem menne a hét könyvébe',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'BurstLogic.tripsInDays(state.burstTripLog, site.id, days)',
    lost: 'az Android statisztika nem kapná meg a hét adag-beteléseit',
  },
  // A KERET SORA a héten betelt napokkal: a segéd oldalanként számol, a sor mondja.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'limitFullDays7d: limitFullDays(state.usage, [s], now).days,',
    lost: 'a segéd nem adná a keret sorába a héten betelt napokat',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "if (full7 > 0) label += ` · a héten ${full7} napon betelt`;",
    lost: 'a gépi keret sora nem mondaná a héten betelt napokat',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'LimitLogic.limitFullDays(usage, listOf(site.domain to site.dailyLimitSeconds), now).days',
    lost: 'az Android keret sora nem mondaná a héten betelt napokat',
  },
  // A KERET BETELT NAPJAI: a mag számol, a statisztika és a heti mondat mondja
  // — ha a bekötés kiesne, a keret csendben dolgozna, és senki nem tudná, hányszor.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'limitFullDays: limitFullDays(state.usage, state.sites, now),',
    lost: 'a segéd nem adná a statisztikába a keret betelt napjait',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "const fullLine = limitFullLine(statsData.limitFullDays ?? { days: 0, bySite: [] }, statLabel);",
    lost: 'a gépi statisztika nem mondaná a keret betelt napjait',
  },
  {
    file: 'desktop/src/helper/digest-journal.ts',
    needle: 'limitFullDays: limitFullDays(state.usage, state.sites, now).days,',
    lost: 'a gépi heti mondat nem mondaná a keret betelt napjait',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'limitFullDays = LimitLogic.limitFullDays(state.usage, state.sites.map { it.domain to it.dailyLimitSeconds }, now),',
    lost: 'az Android statisztika nem kapná meg a keret betelt napjait',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'LimitLogic.limitFullLine(it, labelOf)',
    lost: 'az Android statisztika nem mondaná a keret betelt napjait',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Digest.kt',
    needle: 'limitFullDays = LimitLogic.limitFullDays(st.usage, st.sites.map { it.domain to it.dailyLimitSeconds }, now).days,',
    lost: 'az Android heti mondat nem mondaná a keret betelt napjait',
  },
  // A HETI MONDAT a lefedett csúcs-óráról: a három építő adja a csomag nevét;
  // ha kiesne, a mondat a csúcsot mondaná, az ablakot nem — csendben.
  {
    file: 'desktop/src/helper/digest-journal.ts',
    needle: 'browserHitsPeakPack: peak ? packCoveringHour(state.focusPacks ?? [], peak.hour)?.name ?? null : null,',
    lost: 'a gépi heti mondat nem mondaná a lefedett csúcs-órát',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Digest.kt',
    needle: 'filterHitsPeakPack = FilterHitLogic.peakHour(st.filterHitHours, now)?.let { Focus.packCoveringHour(st.focusPacks, it.first)?.name },',
    lost: 'az Android heti mondat nem mondaná a lefedett csúcs-órát',
  },
  {
    file: 'ios/Shared/Digest.swift',
    needle: '.flatMap { Focus.packCoveringHour(st.focusPacks ?? [], hour: $0.hour)?.name },',
    lost: 'az iPhone heti mondata nem mondaná a lefedett csúcs-órát',
  },
  // EGY KATTINTÁS a felugró lapról a menetig: a híd végpontja, az app bírói
  // útja és a gomb — ha bármelyik bekötés kiesne, a gomb ott lenne, a menet nem.
  {
    file: 'extension/popup.js',
    needle: 'const r = await startFocusInApp(packId, minutes);',
    lost: 'a felugró lap gombja nem indítana menetet',
  },
  {
    file: 'desktop/src/main/rules-bridge.ts',
    needle: 'await deps.startFocus(b.packId, b.minutes as number);',
    lost: 'a híd nem indítaná a menetet',
  },
  {
    file: 'extension/blocked.js',
    needle: 'const r = await startFocusInApp(packId, minutes);',
    lost: 'a tiltó lap gombja nem indítana menetet',
  },
  {
    file: 'desktop/src/main/main.ts',
    needle: "await client.call('focus_start', { packId, minutes });",
    lost: 'a híd menet-indítása nem érne el a bíróig',
  },
  // LE VAN-E FEDVE a csúcs-óra: a mag tudja, melyik csomag ablaka fedi; ha a
  // három statisztika bekötése kiesne, a gomb ablakot kínálna arra, ami már van.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "const covering = peak ? packCoveringHour(status?.focusPacks ?? [], peak.hour) : null;",
    lost: 'a gépi statisztika nem mondaná, hogy a csúcs-óra le van fedve',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: '?.let { Focus.packCoveringHour(state.focusPacks, it.first) }',
    lost: 'az Android statisztika nem mondaná, hogy a csúcs-óra le van fedve',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'Focus.packCoveringHour(store.state.focusPacks ?? [], hour: peak.hour)',
    lost: 'az iPhone statisztikája nem mondaná, hogy a csúcs-óra le van fedve',
  },
  // A JAVASLAT kártyája a gépi kezdőlapon és az Android sáv sora a csúcs-órában:
  // amit az értesítés mond, a lap is mondja — ha a bekötés kiesne, csak az
  // (kikapcsolható) értesítés maradna.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'renderSuggestCard(nowForBurst);',
    lost: 'a gépi kezdőlap nem mutatná a javaslat kártyáját',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'FilterHitLogic.isPeakNow(FilterHitLogic.peakHour(st.filterHitHours, now), now)',
    lost: 'az Android szűrő-értesítés sora nem mondaná a csúcs-órát',
  },
  // A CSÚCS-ÓRA a kísértés helyén: a mag tudja, most van-e; ha az öt hely
  // bekötése kiesne, a csúcs csak a statisztikán állna, a pillanatban nem.
  {
    file: 'extension/blocked.js',
    needle: 'peakNowText(peakNow(state, today, new Date().getHours()))',
    lost: 'a tiltó lap nem mondaná a csúcs-órában, hogy most van',
  },
  {
    file: 'extension/popup.js',
    needle: 'peakText(peakNow(book, dayKey(), new Date().getHours()))',
    lost: 'a felugró lap nem mondaná a hét csúcsát',
  },
  {
    file: 'desktop/src/renderer/overlay.ts',
    needle: 'peakNowText(st.browserHitsPeak ?? null, st.now)',
    lost: 'a réteg lába nem mondaná a csúcs-órában, hogy most van',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'peakNow?.let { Text(FilterHitLogic.peakNowText(it)',
    lost: 'az Android kezdőlap kártyája nem mondaná a csúcs-órát',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'Text(FilterHitLogic.peakNowText(inPeak))',
    lost: 'az iPhone kezdőlap kártyája nem mondaná a csúcs-órát',
  },
  // AZ ÓRÁK SÁVJA: a rekeszek összeadva megvannak a magban; ha a státusz nem
  // vinné, vagy a statisztika nem rajzolná, a csúcs egy szám maradna alak nélkül.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'browserHitsHours: browserHitsByHour(state.browserHits, now),',
    lost: 'a segéd nem adná a státuszba az órák sávját',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "renderHourStrip($('hitsHourStrip'), status?.browserHitsHours ?? [], peak);",
    lost: 'a gépi statisztika nem rajzolná az órák sávját',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'filterHitHours = FilterHitLogic.byHour(state.filterHitHours, now),',
    lost: 'Androidon a statisztika nem kapná meg az órák sávját',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'HourStrip(filterHitHours, peakHour = hour, peakCount = count)',
    lost: 'az Android statisztika nem rajzolná az órák sávját',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'HourStrip(hours: FilterHitLogic.byHour(store.state.filterHitHours ?? [:], now: now),',
    lost: 'az iPhone statisztikája nem rajzolná az órák sávját',
  },
  // AZ ELŐJELZÉS a csúcs-óra előtt: a mag tudja, mikor; ha a három bekötés
  // kiesne, a csúcs-óra csak a statisztikán állna, és senki nem szólna előre.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'showPeakWarning(status!.browserHitsPeak ?? null, nowForBurst);',
    lost: 'a gép nem szólna a csúcs-óra előtt',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'maybePeakWarning(st, now)',
    lost: 'Androidon a szolgáltatás nem szólna a csúcs-óra előtt',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'PeakReminder.reschedule(peak: peak, canStart:',
    lost: 'iPhone-on az app nem ütemezné az előjelzést a csúcs-óra előtt',
  },
  // EGY KOPPINTÁS a mondattól a menetig: ha a gomb kiesne, a javaslat csak
  // szöveg maradna — a csomagkártya egy görgetéssel lejjebb, és senki nem
  // hiányolná.
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'Referee.startFocus(pick.id, pick.defaultMinutes, System.currentTimeMillis())',
    lost: 'az Android javaslat-kártyája nem indítana menetet egy koppintásra',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'Referee.startFocus(packId: pick.id, minutes: pick.defaultMinutes, now: nowMs())',
    lost: 'az iPhone javaslat-kártyája nem indítana menetet egy koppintásra',
  },
  {
    file: 'desktop/src/helper/server.ts',
    needle: "lastUsedPackId: lastUsedPack(state.focusPacks ?? [], state.focusLog ?? [])?.id ?? null,",
    lost: 'a segéd nem választana csomagot a gépi javaslat gombjának — a gomb sosem látszana',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "call<StatusData>('focus_start', { packId: pick.id, minutes: pick.defaultMinutes })",
    lost: 'a gépi statisztika gombja nem indítana menetet egy kattintásra',
  },
  // MELYIK oldal akaszt meg a legtöbbször: a bővítmény küldi az élbolyt, a
  // segéd a lista tételéhez rendeli, a mondat és a statisztika mondja; a
  // telefonon a szűrő könyvel. Ha egy láncszem kiesne, a sor mindig üres lenne.
  {
    file: 'extension/hits.js',
    needle: 'if (topHosts.length) row.topHosts = topHosts;',
    lost: 'a bővítmény nem küldené az élbolyt a hídra — a gépi csúcs-oldal mindig üres',
  },
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'browserHitsTop: browserHitsTopSite(state.browserHits, now, state.sites),',
    lost: 'a segéd státusza nem mondaná a csúcs-oldalt',
  },
  {
    file: 'desktop/src/helper/digest-journal.ts',
    needle: 'browserHitsTop: browserHitsTopSite(state.browserHits, now, state.sites),',
    lost: 'a heti mondat nem mondaná a csúcs-oldalt',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'statLabel(top.label)',
    lost: 'a gépi statisztika nem mondaná a csúcs-oldalt',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'FilterHitLogic.recordSite(it.filterHitHosts, day, site)',
    lost: 'Androidon a szűrő nem könyvelné oldalanként — a csúcs-oldal mindig üres',
  },
  {
    file: 'ios/PacketTunnel/PacketTunnelProvider.swift',
    needle: 'FilterHitLogic.recordSite($0.filterHitHosts ?? [:], day: day, site: site)',
    lost: 'iPhone-on a tunnel nem könyvelné oldalanként — a csúcs-oldal mindig üres',
  },
  // MELYIK szabály dolgozik a telefonon: az ok az ítéletből (lista, kulcsszó),
  // a könyv okonként, a statisztika sora. Ha a horog nem könyvelné, a sor
  // mindig üres lenne — és a fehérlista-blokk oknak számítva a sor hazudna.
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'FilterHitLogic.recordSite(it.filterHitReasons, day, reason)',
    lost: 'Androidon a szűrő nem könyvelné okonként — a sor mindig üres',
  },
  {
    file: 'ios/PacketTunnel/PacketTunnelProvider.swift',
    needle: 'FilterHitLogic.recordSite($0.filterHitReasons ?? [:], day: day, site: reason)',
    lost: 'iPhone-on a tunnel nem könyvelné okonként — a sor mindig üres',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'FilterHitLogic.reasonLine(filterHitsReasons)',
    lost: 'az Android statisztikája nem mondaná az okokat',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'FilterHitLogic.reasonLine(reasons)',
    lost: 'az iPhone statisztikája nem mondaná az okokat',
  },
  // A HÉT AZ ELŐZŐ HÉTHEZ KÉPEST: a bővítmény két hetet küld, a segéd és a
  // telefonok az előző hetet is összegzik, a statisztika és a heti mondat mondja.
  // Ha a híd egy hetet vinne, az előző hét mindig nulla lenne — és a sor csendben eltűnne.
  {
    file: 'extension/hits.js',
    needle: 'export function hitsReport(state, today, count = REPORT_DAYS)',
    lost: 'a híd csak egy hetet vinne — az előző hét a gépen mindig nulla',
  },
  // MELYIK KULCSSZÓ DOLGOZIK: a bővítmény a fogó szóval könyvel, a hídra a nap
  // élbolya megy, a gépi kártya és a beállítás-lap mondja. Ha a háttér nem adná
  // át a szót, a könyv üres maradna — és a sor csendben elmaradna.
  {
    file: 'extension/background.js',
    needle: "recordHit(await loadHits(), today, reason, hostOf(url) ?? '', new Date(now).getHours(), keyword)",
    lost: 'a bővítmény nem könyvelné a fogó kulcsszót — a kulcsszavankénti sor mindig üres',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'FilterHitLogic.recordSite(it.filterHitKeywords, day, keyword)',
    lost: 'Androidon a szűrő nem könyvelné a fogó kulcsszót — a sor mindig üres',
  },
  {
    file: 'ios/PacketTunnel/PacketTunnelProvider.swift',
    needle: 'FilterHitLogic.recordSite($0.filterHitKeywords ?? [:], day: day, site: keyword)',
    lost: 'iPhone-on a tunnel nem könyvelné a fogó kulcsszót — a sor mindig üres',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'filterHitsIdleKeywords = FilterHitLogic.idleKeywords(state.keywords, FilterHitLogic.keywordsWeek(state.filterHitKeywords, now)),',
    lost: 'az Android statisztikája nem mondaná, melyik szó nem fogott',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'FilterHitLogic.idleKeywords(store.state.keywords ?? [], rows: kws)',
    lost: 'az iPhone statisztikája nem mondaná, melyik szó nem fogott',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'FilterHitLogic.keywordLine(filterHitsKeywords)',
    lost: 'az Android statisztikája nem mondaná, melyik kulcsszó dolgozik',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'FilterHitLogic.keywordLine(kws)',
    lost: 'az iPhone statisztikája nem mondaná, melyik kulcsszó dolgozik',
  },
  {
    file: 'extension/options.js',
    needle: 'idleKeywordsText(idleKeywords(link.keywords ?? [], kwRows))',
    lost: 'a bővítmény beállítás-lapja nem mondaná, melyik szó nem fogott',
  },
  {
    file: 'extension/options.js',
    needle: 'keywordsText(kwRows)',
    lost: 'a bővítmény beállítás-lapja nem mondaná kulcsszavanként a hetet',
  },
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'browserHitsKeywords: browserHitsByKeyword(state.browserHits, now),',
    lost: 'a segéd státusza nem mondaná kulcsszavanként a hetet',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'hitsKeywordLine(st.browserHitsKeywords ?? [])',
    lost: 'a gépi kulcsszó-kártya nem mondaná, melyik szó dolgozik',
  },
  {
    file: 'extension/options.js',
    needle: "$('hitsPrev').textContent = trend ?? '';",
    lost: 'a bővítmény beállítás-lapja nem mérné a hetet az előző héthez',
  },
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'browserHitsPrev7d: browserHitsPrev7d(state.browserHits, now),',
    lost: 'a segéd státusza nem mondaná az előző hetet',
  },
  {
    file: 'desktop/src/helper/digest-journal.ts',
    needle: 'browserHitsPrev7d: browserHitsPrev7d(state.browserHits, now),',
    lost: 'a gépi heti mondat nem mondaná az előző hetet',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'hitsTrendText(status?.browserHits7d ?? 0, status?.browserHitsPrev7d ?? 0)',
    lost: 'a gépi statisztika nem mondaná a hetet az előző héthez képest',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Digest.kt',
    needle: 'filterHitsPrev7d = FilterHitLogic.hitsPrev7d(st.filterHits, now),',
    lost: 'Androidon a heti mondat nem mondaná az előző hetet',
  },
  {
    file: 'ios/Shared/Digest.swift',
    needle: 'filterHitsPrev7d: FilterHitLogic.hitsPrev7d(st.filterHits ?? [:], now: now)',
    lost: 'iPhone-on a heti mondat nem mondaná az előző hetet',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'FilterHitLogic.trendText(filterHits7d, filterHitsPrev7d)',
    lost: 'az Android statisztikája nem mondaná a hetet az előző héthez képest',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'FilterHitLogic.trendText(',
    lost: 'az iPhone statisztikája nem mondaná a hetet az előző héthez képest',
  },
  // AZ ELŐZŐ HÉT MENETEI a mostani mellett: a segéd és a telefonok összegzik, a
  // statisztika és a heti mondat mondja. Ha a hívó nem adná, a mező null, és a
  // sor csendben elmaradna — a mag tudná, a felület nem.
  // A NULLA HÉT IS MONDAT, ha volt mihez mérni: a statisztika blokkja üres héten
  // is marad, ha az előző héten volt megakadás vagy menet — különben a két
  // szám csak a heti mondatban élne, a lapon csendben eltűnne.
  // EGY KATTINTÁS AZ ÉRTESÍTÉSRŐL a menetig: a sokadik megakadás és az
  // előjelzés értesítése indít. Ha a kattintás-kezelő esne ki, az értesítés
  // ígérne („Kattints, és indul”), és nem történne semmi.
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'startAction(cur, now, NOTIF_NUDGE_ID)',
    lost: 'az Android sokadik-megakadás értesítésén nincs gomb a menetig',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'startAction(st, now, NOTIF_PEAK_ID)',
    lost: 'az Android előjelzésén nincs gomb a menetig',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/FocusStartReceiver.kt',
    needle: 'Referee.startFocus(packId, minutes, now)',
    lost: 'az Android értesítés gombja nem indítana menetet — az ígéret üres',
  },
  {
    file: 'ios/App/PeakReminder.swift',
    needle: 'if canStart { content.categoryIdentifier = NoticeActions.category }',
    lost: 'az iPhone előjelzésén nincs gomb a menetig',
  },
  {
    file: 'ios/App/NoticeActions.swift',
    needle: 'try? Referee.startFocus(packId: pick.id, minutes: pick.defaultMinutes, now: now)',
    lost: 'az iPhone értesítés gombja nem indítana menetet — az ígéret üres',
  },
  {
    file: 'ios/App/BreakerApp.swift',
    needle: 'NoticeActions.shared.register()',
    lost: 'az iPhone értesítés gombjának nincs kezelője — a koppintás elveszne',
  },
  // ABLAK A CSÚCS-ÓRÁRA: a mondattól a heti ablakig egy kattintás — a bíró
  // dönt (felvenni ingyen). Ha a gomb nem hívná, a mondat ígérne, és nem történne semmi.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "('focus_recurrence', { packId: w.pick.id, band: peakWindowBand(w.peak.hour) })",
    lost: 'a csúcs-óra gombja nem tenne heti ablakot — az ígéret üres',
  },
  // A TELEFONOKON IS: a gomb a bírót hívja (csak felvesz), és a telefon a csomag
  // jelét is írja a léptetésben — különben a gép egy ugyanabban a körben tett
  // szerkesztése a fésülésben csendben letörölné az ablakot.
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'runCatching { Referee.addFocusWindow(p.id, band, nowMs) }',
    lost: 'az Android csúcs-óra gombja nem tenne heti ablakot — az ígéret üres',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'try Referee.addFocusWindow(packId: pick.pack.id, band: pick.band, now: Date().timeIntervalSince1970 * 1000)',
    lost: 'az iPhone csúcs-óra gombja nem tenne heti ablakot — az ígéret üres',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/SyncRevisions.kt',
    needle: 'for ((id, f) in packFps) if (prevFps[id] != f) marks[id] = rev',
    lost: 'a telefon csomag-szerkesztése jel nélkül menne — a gép ugyanabban a körben tett szerkesztése csendben letörölné',
  },
  {
    file: 'ios/Shared/SyncRevisions.swift',
    needle: 'for (id, f) in packFps where prevFps[id] != f { marks[id] = Int(newRev) }',
    lost: 'az iPhone csomag-szerkesztése jel nélkül menne — a gép ugyanabban a körben tett szerkesztése csendben letörölné',
  },
  // A BÖNGÉSZŐBŐL IS: a tiltó lap és a felugró lap gombja a hídon teszi fel az
  // ablakot; a híd a bírón át, és csak ablak nélküli csomagra — a csere
  // lazíthat, arról a bíró próbatételt kezdene, amit a híd nem indíthat el.
  {
    file: 'desktop/src/main/rules-bridge.ts',
    needle: 'await deps.addFocusWindow(b.packId, b.hour as number);',
    lost: 'a híd ablak-végpontja nem hívná a felvevőt — a lap gombja üres ígéret',
  },
  {
    file: 'desktop/src/main/main.ts',
    needle: "await client.call('focus_recurrence', { packId, band: peakWindowBand(hour) }) as { applied?: boolean };",
    lost: 'a híd ablak-felvevője nem a bírón menne át — az ablak nem kerülne fel',
  },
  {
    file: 'desktop/src/main/main.ts',
    needle: "if (pack.recurrence) throw new Error('Ennek a csomagnak már van heti ablaka — az appban szerkeszthető.');",
    lost: 'a híd ablakos csomagra is menne — a csere lazíthat, és a bíró próbatételt kezdene a hídról',
  },
  {
    file: 'extension/popup.js',
    needle: 'const r = await addFocusWindowInApp(packId, hour);',
    lost: 'a felugró lap ablak-gombja nem a hídon tenne ablakot — az ígéret üres',
  },
  {
    file: 'extension/blocked.js',
    needle: 'const r = await addFocusWindowInApp(packId, hour);',
    lost: 'a tiltó lap ablak-gombja nem a hídon tenne ablakot — az ígéret üres',
  },
  // LE VAN-E FEDVE a felugró lapon: a híd leadja a fedő csomagot, a lap kimondja.
  {
    file: 'desktop/src/main/main.ts',
    needle: "peakPack: covering?.name ?? null, focusDay, focusHourNow, focusHour, focusHourPack, sameHour };",
    lost: 'a híd nem adná le a csúcs-órát fedő csomagot — a felugró lap nem mondaná',
  },
  {
    file: 'extension/popup.js',
    needle: 'peakCoverText(link, Date.now(), CLOSED_FRESH_MS)',
    lost: 'a felugró lap nem mondaná, hogy a csúcs-órában magától indul a menet',
  },
  // A HETI MONDAT mondja, ha a csúcs-órát nem fedi ablak — csak ha lehetne rá tenni.
  {
    file: 'desktop/src/helper/digest-journal.ts',
    needle: 'peakWindowOffer: peak ? peakWindowPick(state.focusPacks ?? [], state.focusLog, null, peak.hour, now) !== null : false,',
    lost: 'a gépi heti mondat nem mondaná, hogy a csúcs-órára lehetne ablakot tenni',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Digest.kt',
    needle: 'peakWindowOffer = Focus.peakWindowPick(st.focusPacks, st.focusLog, null, FilterHitLogic.peakHour(st.filterHitHours, now)?.first, now) != null,',
    lost: 'az Android heti mondat nem mondaná, hogy a csúcs-órára lehetne ablakot tenni',
  },
  {
    file: 'ios/Shared/Digest.swift',
    needle: 'input.peakWindowOffer = Focus.peakWindowPick(',
    lost: 'az iPhone heti mondat nem mondaná, hogy a csúcs-órára lehetne ablakot tenni',
  },
  // A HETI MONDAT a csúcs-napot is mondja — a statisztika sora, mindhárom platformon.
  {
    file: 'desktop/src/helper/digest-journal.ts',
    needle: 'browserHitsWeekday: peakWeekday(browserHitsByWeekday(state.browserHits, now)),',
    lost: 'a gépi heti mondat nem mondaná a csúcs-napot',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Digest.kt',
    needle: 'filterHitsWeekday = FilterHitLogic.peakWeekday(FilterHitLogic.byWeekday(st.filterHits, now)),',
    lost: 'az Android heti mondat nem mondaná a csúcs-napot',
  },
  {
    file: 'ios/Shared/Digest.swift',
    needle: 'input.filterHitsWeekday = FilterHitLogic.peakWeekday(FilterHitLogic.byWeekday(st.filterHits ?? [:], now: now))',
    lost: 'az iPhone heti mondat nem mondaná a csúcs-napot',
  },
  // A CSÚCS-NAP ott is, ahol a kísértés van: a tiltó lap, a felugró lap, a gépi
  // kártya és a réteg lába, a két telefon kezdőlapja a csúcs-napon kimondja.
  {
    file: 'extension/blocked.js',
    needle: 'peakDayNowText(peakDayNow(state, today, new Date().getDay()))',
    lost: 'a tiltó lap a csúcs-napon nem mondaná, hogy ma van',
  },
  {
    file: 'extension/popup.js',
    needle: 'peakDayNowText(peakDayNow(book, dayKey(), new Date().getDay()))',
    lost: 'a felugró lap a csúcs-napon nem mondaná, hogy ma van',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'const dayLine = peakDayNowText(status?.browserHitsWeekday ?? null, now).trim();',
    lost: 'a gépi javaslat-kártya a csúcs-napon nem mondaná, hogy ma van',
  },
  {
    file: 'desktop/src/renderer/overlay.ts',
    needle: 'peakDayNowText(st.browserHitsWeekday ?? null, st.now)',
    lost: 'a réteg lába a csúcs-napon nem mondaná, hogy ma van',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'peakDay?.let { Text(FilterHitLogic.peakDayNowText(it), style = MaterialTheme.typography.bodySmall) }',
    lost: 'az Android kezdőlap kártyája a csúcs-napon nem mondaná, hogy ma van',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'if let onPeakDay { Text(FilterHitLogic.peakDayNowText(onPeakDay)).font(.footnote) }',
    lost: 'az iPhone kezdőlap kártyája a csúcs-napon nem mondaná, hogy ma van',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: '(if (peakDay) " · ma a csúcs-nap" else "")',
    lost: 'az Android szűrő-értesítés sora a csúcs-napon nem mondaná, hogy ma van',
  },
  // A HÉT NAPJAINAK SÁVJA a csúcs-nap mondata alatt — a négy felületen.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'browserHitsWeekdays: browserHitsByWeekday(state.browserHits, now),',
    lost: 'a segéd nem adná le a hét napjainak sávját, a gépi statisztika üresen rajzolná',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "renderWeekdayStrip($('hitsWeekdayStrip'), status?.browserHitsWeekdays ?? [], wd);",
    lost: 'a gépi statisztika nem rajzolná a hét napjainak sávját',
  },
  {
    file: 'extension/options.js',
    needle: 'dayStrip.hidden = weekday === null;',
    lost: 'a bővítmény beállítás-lapja nem rajzolná a hét napjainak sávját',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'WeekdayStrip(filterHitWeekdays, peakDay = day, peakCount = count)',
    lost: 'az Android statisztika nem rajzolná a hét napjainak sávját',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'WeekdayStrip(days: byDay, peakDay: wd.day, peakCount: wd.count)',
    lost: 'az iPhone statisztika nem rajzolná a hét napjainak sávját',
  },
  // A MENET-NAP: melyik napon ülsz le a legtöbbször — a csúcs-nap tükre, mindhárom statisztikán.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'focusWeekdays: focusByWeekday(state.focusLog, now),',
    lost: 'a segéd nem adná le a menet-napot, a gépi statisztika nem mondaná',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "renderWeekdayStrip($('focusWeekdayStrip'), statsData?.focusWeekdays ?? [], fwd, (n) => `${n} menet`);",
    lost: 'a gépi statisztika nem mondaná és nem rajzolná a menet-napot',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'WeekdayStrip(focusWeekdays, peakDay = day, peakCount = count)',
    lost: 'az Android statisztika nem mondaná és nem rajzolná a menet-napot',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'WeekdayStrip(days: focusByDay, peakDay: fwd.day, peakCount: fwd.count)',
    lost: 'az iPhone statisztika nem mondaná és nem rajzolná a menet-napot',
  },
  // A HETI MONDAT a menet-napot is mondja — a statisztika sora, mindhárom platformon.
  {
    file: 'desktop/src/helper/digest-journal.ts',
    needle: 'focusWeekday: peakWeekday(focusByWeekday(state.focusLog, now)),',
    lost: 'a gépi heti mondat nem mondaná a menet-napot',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Digest.kt',
    needle: 'focusWeekday = FilterHitLogic.peakWeekday(Focus.byWeekday(st.focusLog, now)),',
    lost: 'az Android heti mondat nem mondaná a menet-napot',
  },
  {
    file: 'ios/Shared/Digest.swift',
    needle: 'input.focusWeekday = FilterHitLogic.peakWeekday(Focus.byWeekday(st.focusLog ?? [], now: now))',
    lost: 'az iPhone heti mondat nem mondaná a menet-napot',
  },
  // A MENET-NAP ott is, ahol a döntés van: a gépi kártya és a réteg lába, a két telefon kezdőlapja a menet-napon kimondja.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'focusWeekday: peakWeekday(focusByWeekday(state.focusLog, now)),',
    lost: 'a segéd nem adná le a menet-napot a státuszban, a kártya és a réteg hallgatna',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'const focusDayLine = focusDayNowText(status?.focusWeekday ?? null, now).trim();',
    lost: 'a gépi javaslat-kártya a menet-napon nem mondaná, hogy ma szoktál leülni',
  },
  {
    file: 'desktop/src/renderer/overlay.ts',
    needle: 'focusDayNowText(st.focusWeekday ?? null, st.now)',
    lost: 'a réteg lába a menet-napon nem mondaná, hogy ma szoktál leülni',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'focusDay?.let { Text(Focus.dayNowText(it), style = MaterialTheme.typography.bodySmall) }',
    lost: 'az Android kezdőlap kártyája a menet-napon nem mondaná, hogy ma szoktál leülni',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'if let onFocusDay { Text(Focus.dayNowText(onFocusDay)).font(.footnote) }',
    lost: 'az iPhone kezdőlap kártyája a menet-napon nem mondaná, hogy ma szoktál leülni',
  },
  // A MENET-NAP a böngészőben: az app a hídon leadja, a felugró lap és a tiltó lap a gomb mellett mondja.
  {
    file: 'desktop/src/main/main.ts',
    needle: 'const focusDay = isPeakDayNow(s.focusWeekday ?? null, Date.now());',
    lost: 'az app nem adná le a hídon, hogy ma a menet-nap van — a böngésző lapjai hallgatnának',
  },
  {
    file: 'extension/popup.js',
    needle: 'const fd = focusDayText(link, Date.now(), CLOSED_FRESH_MS) + focusHourNowText(link, Date.now(), CLOSED_FRESH_MS)',
    lost: 'a felugró lap a menet-napon nem mondaná, hogy ma szoktál leülni',
  },
  {
    file: 'extension/blocked.js',
    needle: 'const fd = focusDayText(link, Date.now(), CLOSED_FRESH_MS) + focusHourNowText(link, Date.now(), CLOSED_FRESH_MS)',
    lost: 'a tiltó lap a menet-napon nem mondaná, hogy ma szoktál leülni',
  },
  // A MÉRT IDŐ NAPJA: melyik napon megy el a legtöbb idő — a gépi és az Android statisztikán.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'usageWeekdays: usageByWeekday(state.usage, now),',
    lost: 'a segéd nem adná le a mért idő napját, a gépi statisztika nem mondaná',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "renderWeekdayStrip($('usageWeekdayStrip'), statsData.usageWeekdays ?? [], uwd, (n) => `átlag ${formatDuration(Math.round(n / 4))}`);",
    lost: 'a gépi statisztika nem mondaná és nem rajzolná a mért idő napját',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'WeekdayStrip(usageWeekdays, peakDay = day, peakCount = count)',
    lost: 'az Android statisztika nem mondaná és nem rajzolná a mért idő napját',
  },
  // A HETI MONDAT a mért idő napját is mondja — a gépen és Androidon (iPhone-on nincs mérés).
  {
    file: 'desktop/src/helper/digest-journal.ts',
    needle: 'usageWeekday: peakWeekday(usageByWeekday(state.usage, now)),',
    lost: 'a gépi heti mondat nem mondaná a mért idő napját',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Digest.kt',
    needle: 'usageWeekday = FilterHitLogic.peakWeekday(UsageLogic.byWeekday(st.usage, now)),',
    lost: 'az Android heti mondat nem mondaná a mért idő napját',
  },
  // A MENET-ÓRA: mikor ülsz le a legtöbbször — a csúcs-óra tükre, mindhárom statisztikán.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'focusHours: focusByHour(state.focusLog, now),',
    lost: 'a segéd nem adná le a menet-órát, a gépi statisztika nem mondaná',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "renderHourStrip($('focusHourStrip'), statsData?.focusHours ?? [], fh, (n) => `${n} menet`);",
    lost: 'a gépi statisztika nem mondaná és nem rajzolná a menet-órát',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'HourStrip(focusHours, peakHour = hour, peakCount = count)',
    lost: 'az Android statisztika nem mondaná és nem rajzolná a menet-órát',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'HourStrip(hours: focusByHour, peakHour: fh.hour, peakCount: fh.count)',
    lost: 'az iPhone statisztika nem mondaná és nem rajzolná a menet-órát',
  },
  // A HETI MONDAT a menet-órát is mondja — a statisztika sora, mindhárom platformon.
  {
    file: 'desktop/src/helper/digest-journal.ts',
    needle: 'const fh = peakFocusHour(focusByHour(state.focusLog, now));',
    lost: 'a gépi heti mondat nem mondaná a menet-órát',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Digest.kt',
    needle: 'focusHour = Focus.peakHour(Focus.byHour(st.focusLog, now)),',
    lost: 'az Android heti mondat nem mondaná a menet-órát',
  },
  {
    file: 'ios/Shared/Digest.swift',
    needle: 'input.focusHour = Focus.peakHour(Focus.byHour(st.focusLog ?? [], now: now))',
    lost: 'az iPhone heti mondat nem mondaná a menet-órát',
  },
  // ABLAK A MENET-ÓRÁRA: a csúcs-óra gombjának párja — a három statisztikán, a bíró útján.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "$('focusHourWindowBtn').addEventListener('click', () => void addFocusHourWindow($('focusHourNote')));",
    lost: 'a gépi statisztika menet-óra gombja nem tenne ablakot — a gomb ott lenne, a kattintás semmi',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'focusHourWindowLabel = Focus.peakHour(Focus.byHour(state.focusLog, now))?.first',
    lost: 'az Android statisztika nem kínálna ablakot a menet-órára',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'Button("Heti ablak a menet-órára: \\(pick.pack.name), \\(recurrenceLabel(pick.band))") {',
    lost: 'az iPhone statisztika nem kínálna ablakot a menet-órára',
  },
  // A MENET-ÓRA ott is, ahol a döntés van: a gépi kártya és a réteg lába, a telefonok kezdőlapja, a híd és a böngésző lapjai.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'focusHour: peakFocusHour(focusByHour(state.focusLog, now)),',
    lost: 'a segéd nem adná le a menet-órát a státuszban, a kártya, a réteg és a híd hallgatna',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'const focusHourLine = focusHourNowText(status?.focusHour ?? null, now).trim();',
    lost: 'a gépi javaslat-kártya a menet-órában nem mondaná, hogy most szoktál elkezdeni',
  },
  {
    file: 'desktop/src/renderer/overlay.ts',
    needle: 'focusHourNowText(st.focusHour ?? null, st.now)',
    lost: 'a réteg lába a menet-órában nem mondaná, hogy most szoktál elkezdeni',
  },
  {
    file: 'desktop/src/main/main.ts',
    needle: 'const focusHourNow = isFocusHourNow(s.focusHour ?? null, Date.now());',
    lost: 'az app nem adná le a hídon, hogy most a menet-óra van — a böngésző lapjai hallgatnának',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'focusHourNow?.let { Text(Focus.hourNowText(it), style = MaterialTheme.typography.bodySmall) }',
    lost: 'az Android kezdőlap kártyája a menet-órában nem mondaná, hogy most szoktál elkezdeni',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'if let inFocusHour { Text(Focus.hourNowText(inFocusHour)).font(.footnote) }',
    lost: 'az iPhone kezdőlap kártyája a menet-órában nem mondaná, hogy most szoktál elkezdeni',
  },
  // ELŐJELZÉS a menet-óra előtt — a csúcs-óra előjelzésének tükre, a három platformon.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'showFocusHourWarning(status!.focusHour ?? null, status!.browserHitsPeak ?? null, nowForBurst);',
    lost: 'a gép nem szólna a menet-óra előtt — az előjelzés megvan, csak senki nem hívja',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'maybeFocusHourWarning(st, now)',
    lost: 'az Android-szolgáltatás nem szólna a menet-óra előtt',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'FocusHourReminder.reschedule(peak: focusHourKey.isEmpty ? nil : focusHour, canStart:',
    lost: 'az iPhone nem ütemezné a menet-óra előjelzését',
  },
  // A MENET-SOROZAT: a statisztika sora és a heti mondat mindhárom platformon.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'focusStreak: focusDayStreak(state.focusLog, now),',
    lost: 'a gépi statisztika nem kapná meg a menet-sorozatot',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "$('focusStreakNote').textContent = streak >= 2 ? focusStreakText(streak) : '';",
    lost: 'a gépi statisztika nem mondaná a menet-sorozatot',
  },
  {
    file: 'desktop/src/shared/digest.ts',
    needle: 'if (streakLine) parts.push(streakLine);',
    lost: 'a gépi heti mondat nem mondaná a menet-sorozatot',
  },
  {
    file: 'desktop/src/helper/digest-journal.ts',
    needle: 'focusStreak: focusDayStreak(state.focusLog, now),',
    lost: 'a segéd naplója nem számolná a menet-sorozatot',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'Focus.streakText(focusStreak).takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }',
    lost: 'az Android statisztika nem mondaná a menet-sorozatot',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Digest.kt',
    needle: 'focusStreak = Focus.dayStreak(st.focusLog, now),',
    lost: 'az Android heti mondat nem számolná a menet-sorozatot',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'if let streak = Focus.streakText(Focus.dayStreak(store.state.focusLog ?? [], now: now)) {',
    lost: 'az iPhone statisztikája nem mondaná a menet-sorozatot',
  },
  {
    file: 'ios/Shared/Digest.swift',
    needle: 'input.focusStreak = Focus.dayStreak(st.focusLog ?? [], now: now)',
    lost: 'az iPhone heti mondata nem számolná a menet-sorozatot',
  },
  // A MÉRT IDŐ NAPJA az Android szűrő-értesítésének sorában is.
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: '(if (usageDay) " · ma a legnagyobb nap" else "")',
    lost: 'az Android szűrő-értesítés sora nem mondaná a mért idő napját',
  },
  // AMIKOR A CSÚCS-ÓRA A MENET-ÓRA a felugró lapon: a híd leadja, a lap kimondja.
  {
    file: 'desktop/src/main/main.ts',
    needle: 'const sameHour = !!(fh && peak && fh.hour === peak.hour);',
    lost: 'a híd nem adná le, hogy a csúcs-óra a menet-óra',
  },
  {
    file: 'extension/popup.js',
    needle: '+ sameHourText(link, Date.now(), CLOSED_FRESH_MS);',
    lost: 'a felugró lap nem mondaná, hogy a csúcs-óra a menet-óra',
  },
  // EGY KOPPINTÁS az értesítésről az ablakig: az előjelzés második gombja a telefonokon.
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'windowAction(st, now, peak.first, NOTIF_PEAK_ID, "csúcs-órára")',
    lost: 'az Android csúcs-óra előjelzésén nem lenne ablak-gomb',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'windowAction(st, now, peak.first, NOTIF_FOCUS_HOUR_ID, "menet-órára")',
    lost: 'az Android menet-óra előjelzésén nem lenne ablak-gomb',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/FocusWindowReceiver.kt',
    needle: 'Referee.addFocusWindow(packId, Focus.peakWindowBand(hour), now)',
    lost: 'az Android ablak-gomb nem venné fel az ablakot',
  },
  {
    file: 'ios/App/NoticeActions.swift',
    needle: 'if response.actionIdentifier == Self.windowAction { Self.addWindow(userInfo: response.notification.request.content.userInfo) }',
    lost: 'az iPhone ablak-gombja nem venné fel az ablakot',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'PeakReminder.reschedule(peak: peak, canStart: Focus.lastUsedPack(store.state.focusPacks ?? [], log: store.state.focusLog ?? []) != nil, window: peakWin)',
    lost: 'az iPhone csúcs-óra előjelzése nem kapná meg az ablak jelöltjét',
  },
  // AMIKOR A CSÚCS-ÓRA A MENET-ÓRA: a statisztika és a heti mondat kimondja mindhárom platformon.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "$('sameHourNote').textContent = sameHour;",
    lost: 'a gépi statisztika nem mondaná ki, hogy a csúcs-óra a menet-óra',
  },
  {
    file: 'desktop/src/shared/digest.ts',
    needle: 'if (sameHour) parts.push(sameHour);',
    lost: 'a gépi heti mondat nem mondaná ki, hogy a csúcs-óra a menet-óra',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'Focus.sameHourText(filterHitsPeak, hour to count)?.let { Text(it, style = MaterialTheme.typography.bodySmall) }',
    lost: 'az Android statisztika nem mondaná ki, hogy a csúcs-óra a menet-óra',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Digest.kt',
    needle: 'Focus.sameHourText(input.filterHitsPeak, input.focusHour)?.let { parts.add(it) }',
    lost: 'az Android heti mondat nem mondaná ki, hogy a csúcs-óra a menet-óra',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'if let same = Focus.sameHourText(FilterHitLogic.peakHour(store.state.filterHitHours ?? [:], now: now), fh) {',
    lost: 'az iPhone statisztikája nem mondaná ki, hogy a csúcs-óra a menet-óra',
  },
  {
    file: 'ios/Shared/Digest.swift',
    needle: 'if let same = Focus.sameHourText(input.filterHitsPeak, input.focusHour) { parts.append(same) }',
    lost: 'az iPhone heti mondata nem mondaná ki, hogy a csúcs-óra a menet-óra',
  },
  // A MÉRT IDŐ NAPJA ott is, ahol a döntés van: a gépi kártya és a réteg lába, az Android kártya.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'usageWeekday: peakWeekday(usageByWeekday(state.usage, now)),',
    lost: 'a státusz nem vinné a mért idő napját a kártyának és a rétegnek',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'if (usageDayLine) lines.push(usageDayLine);',
    lost: 'a gépi kártya nem mondaná, hogy ma megy el a legtöbb idő',
  },
  {
    file: 'desktop/src/renderer/overlay.ts',
    needle: '+ usageDayNowText(st.usageWeekday ?? null, st.now)',
    lost: 'a réteg lába nem mondaná, hogy ma megy el a legtöbb idő',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'usageDay?.let { Text(UsageLogic.dayNowText(it), style = MaterialTheme.typography.bodySmall) }',
    lost: 'az Android kártya nem mondaná, hogy ma megy el a legtöbb idő',
  },
  // A MENET-ÓRA FEDÉSE a böngésző lapjain: a híd leadja, a lap kimondja.
  {
    file: 'desktop/src/main/main.ts',
    needle: 'const focusHourPack = fh && (!peak || peak.hour !== fh.hour) ? packCoveringHour(packs, fh.hour)?.name ?? null : null;',
    lost: 'a híd nem adná le a menet-órát fedő csomagot',
  },
  {
    file: 'extension/popup.js',
    needle: '+ focusHourCoverText(link, Date.now(), CLOSED_FRESH_MS);',
    lost: 'a felugró lap nem mondaná, hogy a menet-órát ablak fedi',
  },
  {
    file: 'extension/blocked.js',
    needle: '+ focusHourCoverText(link, Date.now(), CLOSED_FRESH_MS);',
    lost: 'a tiltó lap nem mondaná, hogy a menet-órát ablak fedi',
  },
  // A MENET-NAP és a MENET-ÓRA az Android szűrő-értesítésének sorában is.
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: '(if (focusDay) " · ma a menet-nap" else "")',
    lost: 'az Android szűrő-értesítés sora nem mondaná a menet-napot',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: '(if (focusHourNow) " · most a menet-óra" else "")',
    lost: 'az Android szűrő-értesítés sora nem mondaná a menet-órát',
  },
  // ABLAK A MENET-ÓRÁRA a böngésző lapjairól is: a híd leadja, a lapok gombja a hídon teszi.
  {
    file: 'desktop/src/main/main.ts',
    needle: 'const focusHour = fh && (!peak || peak.hour !== fh.hour) && !pick.recurrence && !packCoveringHour(packs, fh.hour) ? fh.hour : null;',
    lost: 'a híd nem adná le a menet-órát, amire a lap ablakot tehet',
  },
  {
    file: 'extension/popup.js',
    needle: "const fwb = focusHourWindowButton(link, Date.now(), CLOSED_FRESH_MS);",
    lost: 'a felugró lap nem kínálná a menet-óra ablakát',
  },
  {
    file: 'extension/blocked.js',
    needle: "const fwb = focusHourWindowButton(link, Date.now(), CLOSED_FRESH_MS);",
    lost: 'a tiltó lap nem kínálná a menet-óra ablakát',
  },
  // ABLAK A MENET-ÓRÁRA a javaslat kártyájáról is — a három kezdőlapon.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "$('suggestFocusHourBtn').textContent = fwin ? focusHourWindowLabel(fwin.pick, fwin.hour) : '';",
    lost: 'a gépi javaslat-kártya nem kínálná a menet-óra ablakát',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: '}) { Text("Heti ablak a menet-órára: ${p.name}, ${recurrenceLabel(band)}") }',
    lost: 'az Android kezdőlap kártyája nem kínálná a menet-óra ablakát',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'let fwin = Focus.peakWindowPick(store.state.focusPacks ?? [], log: store.state.focusLog ?? [],',
    lost: 'az iPhone kezdőlapjának kártyája nem kínálná a menet-óra ablakát',
  },
  // A MENET-ÓRA FEDÉSE: ha egy csomag ablaka fedi a menet-órát, a statisztika és a heti mondat kimondja.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "? `A menet-órában magától indul: ${fhCover.name} (${recurrenceLabel(fhCover.recurrence)}).` : '';",
    lost: 'a gépi statisztika nem mondaná, hogy a menet-órát ablak fedi',
  },
  {
    file: 'desktop/src/helper/digest-journal.ts',
    needle: 'focusHourPack: fh && fhOwn ? packCoveringHour(state.focusPacks ?? [], fh.hour)?.name ?? null : null,',
    lost: 'a gépi heti mondat nem mondaná a menet-óra fedését',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'focusHourPack?.let { Text("A menet-órában magától indul: $it.", style = MaterialTheme.typography.bodySmall) }',
    lost: 'az Android statisztika nem mondaná, hogy a menet-órát ablak fedi',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'let pack = Focus.packCoveringHour(store.state.focusPacks ?? [], hour: fh.hour), let band = pack.recurrence {',
    lost: 'az iPhone statisztikája nem mondaná, hogy a menet-órát ablak fedi',
  },
  // AZ ABLAK SZERINT INDULT menet a rétegben és az Android értesítésén is kimondva.
  {
    file: 'desktop/src/renderer/overlay.ts',
    needle: "if (isWindowRun(run, status.focusPacks)) left.append(document.createTextNode(' · a heti ablak szerint indult'));",
    lost: 'a réteg nem mondaná, hogy a menet az ablak szerint indult — aki nem maga indította, nem tudná, miért fut',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'if (Focus.isWindowRun(run, st.focusPacks)) R.string.vpn_focus_window_text else R.string.vpn_focus_text,',
    lost: 'az Android értesítés nem mondaná, hogy a menet az ablak szerint indult',
  },
  // A CSÚCS-NAP: a négy hét csúcs-napja a statisztikán — a gépen, a telefonokon és a bővítmény lapján.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'browserHitsWeekday: peakWeekday(browserHitsByWeekday(state.browserHits, now)),',
    lost: 'a segéd nem adná le a csúcs-napot — a statisztika hallgatna',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "$('hitsWeekdayNote').textContent = wd ? peakWeekdayText(wd) : '';",
    lost: 'a gépi statisztika nem mondaná a négy hét csúcs-napját',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'filterHitsWeekday = FilterHitLogic.peakWeekday(FilterHitLogic.byWeekday(state.filterHits, now)),',
    lost: 'az Android statisztika nem mondaná a négy hét csúcs-napját',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'if let wd = FilterHitLogic.peakWeekday(byDay) {',
    lost: 'az iPhone statisztika nem mondaná a négy hét csúcs-napját',
  },
  {
    file: 'extension/options.js',
    needle: 'const weekday = peakWeekday(byDay);',
    lost: 'a bővítmény beállítás-lapja nem mondaná a négy hét csúcs-napját',
  },
  // CSOMAG FELVÉTELE a telefonon: a kártya gombja a bírót hívja — csak felvétel.
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'runCatching { Referee.addFocusPack(name, sites.split(',
    lost: 'az Android csomag-felvevő gombja nem hívná a bírót — a telefonon nem lenne csomag',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'try Referee.addFocusPack(',
    lost: 'az iPhone csomag-felvevő gombja nem hívná a bírót — a telefonon nem lenne csomag',
  },
  // A JAVASLAT KÁRTYÁJÁRÓL IS — gépen és telefonon: a mondat alatt a gomb ugyanoda fut.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "$('suggestWindowBtn').addEventListener('click', () => void addPeakWindow($('suggestText')));",
    lost: 'a gépi javaslat-kártya ablak-gombja nem tenne ablakot — az ígéret üres',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'runCatching { Referee.addFocusWindow(p.id, band, System.currentTimeMillis()) }',
    lost: 'az Android javaslat-kártya ablak-gombja nem tenne ablakot — az ígéret üres',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'try Referee.addFocusWindow(packId: win.pack.id, band: win.band, now: nowMs())',
    lost: 'az iPhone javaslat-kártya ablak-gombja nem tenne ablakot — az ígéret üres',
  },
  // MENETEK ABLAKBÓL: a lezárás írja a naplósorra, hogy az ablakból indult — ha
  // nem írná, a statisztika és a heti mondat sosem mondaná, dolgozik-e az ablak.
  {
    file: 'desktop/src/helper/referee.ts',
    needle: "closeRun(run, pack?.name ?? 'Ismeretlen csomag', endedAt, stopped, isWindowRun(run, state.focusPacks ?? []))",
    lost: 'a gépi lezárás nem írná a naplósorra, hogy ablakból indult — a mondat sosem mondaná',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Referee.kt',
    needle: 'Focus.closeRun(run, pack?.name ?: "Ismeretlen csomag", endedAt, stopped, Focus.isWindowRun(run, state.focusPacks))',
    lost: 'az Android lezárás nem írná a naplósorra, hogy ablakból indult — a mondat sosem mondaná',
  },
  {
    file: 'ios/Shared/Referee.swift',
    needle: 'window: Focus.isWindowRun(run, packs: state.focusPacks ?? []))',
    lost: 'az iPhone lezárás nem írná a naplósorra, hogy ablakból indult — a mondat sosem mondaná',
  },
  {
    file: 'desktop/src/shared/digest.ts',
    needle: "const win = f.windowRuns > 0 ? `, ${f.windowRuns} ablakból` : '';",
    lost: 'a heti mondat nem mondaná az ablakból indult meneteket',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Digest.kt',
    needle: 'val win = if (f.windowRuns > 0) ", ${f.windowRuns} ablakból" else ""',
    lost: 'az Android heti mondat nem mondaná az ablakból indult meneteket',
  },
  {
    file: 'ios/Shared/Digest.swift',
    needle: 'let win = f.windowRuns > 0 ? ", \\(f.windowRuns) ablakból" : ""',
    lost: 'az iPhone heti mondat nem mondaná az ablakból indult meneteket',
  },
  // AZ ABLAK NYOMA a csomag során: a héten hányszor indult magától — a három sor.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'windowRuns7d: windowRunsByPack(state.focusLog, startOfDay(now) - 6 * 86_400_000, now),',
    lost: 'a segéd nem adná le csomagonként az ablak-meneteket — a csomag sora hallgatna',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'const winRuns = status?.windowRuns7d?.[pack.id] ?? 0;',
    lost: 'a gépi csomag sora nem mondaná, hányszor indult magától a héten',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'val winRuns = Focus.windowRunsByPack(state.focusLog, UsageLogic.startOfDay(nowMs) - 6 * 86_400_000L, nowMs)[pack.id] ?: 0',
    lost: 'az Android csomag sora nem mondaná, hányszor indult magától a héten',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'let winRuns = Focus.windowRunsByPack(store.state.focusLog ?? [], since: weekStart, now: now)[pack.id] ?? 0',
    lost: 'az iPhone csomag sora nem mondaná, hányszor indult magától a héten',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'n.onclick = () => void startSuggestedSession(true);',
    lost: 'a gépi értesítés kattintása nem indítana menetet — az ígéret üres',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "status = await call<StatusData>('focus_start', { packId: pick.id, minutes: pick.defaultMinutes });",
    lost: 'a javaslat gombja és értesítése nem indítana menetet',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "(n) => `${n} megakadás`, (status?.browserHitsPrev7d ?? 0) > 0);",
    lost: 'a gépi megakadás-blokk üres héten eltűnne, az előző hét mellett is',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'const show = !!week && (week.sessions > 0 || (prev?.sessions ?? 0) > 0);',
    lost: 'a gépi munkamenet-blokk üres héten eltűnne, az előző hét mellett is',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'if (filterHitDays.any { it.second > 0.0 } || filterHitsPrev7d > 0) {',
    lost: 'az Android megakadás-blokkja üres héten eltűnne, az előző hét mellett is',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'if (week.sessions == 0 && (prevWeek?.sessions ?: 0) == 0) return',
    lost: 'az Android munkamenet-blokkja üres héten eltűnne, az előző hét mellett is',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: '|| FilterHitLogic.hitsPrev7d(store.state.filterHits ?? [:], now: now) > 0 {',
    lost: 'az iPhone megakadás-blokkja üres héten eltűnne, az előző hét mellett is',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'if focusWeek.sessions > 0 || focusPrevWeek.sessions > 0 {',
    lost: 'az iPhone munkamenet-blokkja üres héten eltűnne, az előző hét mellett is',
  },
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'focusPrevWeek: summarizeFocusPrevWeek(state.focusLog, now),',
    lost: 'a segéd statisztikája nem adná az előző hét meneteit',
  },
  {
    file: 'desktop/src/helper/digest-journal.ts',
    needle: 'focusPrevWeek: summarizeFocusPrevWeek(state.focusLog, now),',
    lost: 'a gépi heti mondat nem mondaná az előző hét meneteit',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'Az előző héten ${prev.sessions} menet',
    lost: 'a gépi statisztika nem mondaná az előző hét meneteit',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Digest.kt',
    needle: 'focusPrevWeek = Focus.summarizeFocusPrevWeek(st.focusLog, now),',
    lost: 'Androidon a heti mondat nem mondaná az előző hét meneteit',
  },
  {
    file: 'ios/Shared/Digest.swift',
    needle: 'focusPrevWeek: Focus.summarizeFocusPrevWeek(st.focusLog ?? [], now: now)',
    lost: 'iPhone-on a heti mondat nem mondaná az előző hét meneteit',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'Az előző héten ${it.sessions} menet',
    lost: 'az Android statisztikája nem mondaná az előző hét meneteit',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'Az előző héten \\(focusPrevWeek.sessions) menet',
    lost: 'az iPhone statisztikája nem mondaná az előző hét meneteit',
  },
  // AZ ELŐZŐ HÉT FELOLDÁSAI a mostani mellett: a tükör harmadik mércéje is két
  // hetet mond — a segéd a státuszban és a heti mondatban, a telefonok a heti mondatban.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'unlocksPrev7d: state.unlockLog.filter((t) => t >= now - 14 * 24 * 3600_000 && t < now - 7 * 24 * 3600_000).length,',
    lost: 'a segéd státusza nem mondaná az előző hét feloldásait',
  },
  {
    file: 'desktop/src/helper/digest-journal.ts',
    needle: 'unlocksPrev7d: state.unlockLog.filter((t) => t >= now - 14 * 24 * 3600_000 && t < now - 7 * 24 * 3600_000).length,',
    lost: 'a gépi heti mondat nem mondaná az előző hét feloldásait',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: '(az előző héten ${st.unlocksPrev7d})',
    lost: 'a gépi nehézség-sor nem mondaná az előző hét feloldásait',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Digest.kt',
    needle: 'unlocksPrev7d = st.unlockLog.count { it >= weekAgo - 7 * 24 * 3600_000L && it < weekAgo },',
    lost: 'Androidon a heti mondat nem mondaná az előző hét feloldásait',
  },
  {
    file: 'ios/Shared/Digest.swift',
    needle: 'unlocksPrev7d: st.unlockLog.filter { $0 >= weekAgo - 7 * 24 * 3_600_000 && $0 < weekAgo }.count',
    lost: 'iPhone-on a heti mondat nem mondaná az előző hét feloldásait',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Digest.kt',
    needle: 'filterHitsTop = FilterHitLogic.topSite(st.filterHitHosts, now),',
    lost: 'Androidon a heti mondat nem mondaná a csúcs-oldalt',
  },
  {
    file: 'ios/Shared/Digest.swift',
    needle: 'filterHitsTop: FilterHitLogic.topSite(st.filterHitHosts ?? [:], now: now)',
    lost: 'iPhone-on a heti mondat nem mondaná a csúcs-oldalt',
  },
  // A KULCSSZÓ a telefonon a hosztnévben tilt: a mag tudja, de ha a szolgáltatás
  // vagy a tunnel nem adná át a listát, a kulcsszó továbbra is csak utazna.
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Focus.kt',
    needle: 'KeywordLogic.keywordInHost(keywords, h) != null',
    lost: 'Androidon az ítélet nem nézné a kulcsszót — a kulcsszó nem tiltana',
  },
  {
    file: 'ios/Shared/Focus.swift',
    needle: 'KeywordLogic.keywordInHost(keywords, h) != nil',
    lost: 'iPhone-on az ítélet nem nézné a kulcsszót — a kulcsszó nem tiltana',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'BreakerStore.state.value.keywords,',
    lost: 'Androidon a szolgáltatás nem adná át a kulcsszavakat az ítéletnek',
  },
  {
    file: 'ios/PacketTunnel/PacketTunnelProvider.swift',
    needle: 'keywords: store.state.keywords ?? []',
    lost: 'iPhone-on a tunnel nem adná át a kulcsszavakat az ítéletnek',
  },
  // MI LENNE EZZEL? A próbamező ugyanazt az ítéletet kérdezi, mint a szűrő.
  // Ha a lap egy saját, egyszerűsített szabályt írna ki, a próba hazudna.
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'Focus.explain(',
    lost: 'az Android próbamezője nem a szűrő ítéletét mondaná',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'Focus.explain(probeInput,',
    lost: 'az iPhone próbamezője nem a tunnel ítéletét mondaná',
  },
  // A KÖNYV TÖRLÉSE: a megakadások könyve a tiéd — a bővítményben az app is
  // felejt (üres jelentés), a telefonon minden könyv megy.
  {
    file: 'extension/options.js',
    needle: "try { await pushHits([]); } catch {",
    lost: 'a bővítmény könyvének törlése után az app nem felejtene',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'it.copy(filterHits = emptyMap(), filterHitHours = emptyMap(), filterHitHosts = emptyMap(), filterHitReasons = emptyMap(), filterHitKeywords = emptyMap())',
    lost: 'az Android könyv-törlése nem törölne minden könyvet',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: '$0.filterHitKeywords = nil',
    lost: 'az iPhone könyv-törlése nem törölne minden könyvet',
  },
  // FUTÓ MENET MELLETT NINCS JAVASLAT: a sokadik megakadás és az előjelzés
  // értesítése hallgat, amíg a menet tart — a lépés, amit ajánlanánk, már megvan.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'if (focusIsRunning(status?.focusRun ?? null, now)) return;\n  const step = hitNudgeStep(today);',
    lost: 'a gép futó menet alatt is javasolna menetet',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'if (focusIsRunning(status?.focusRun ?? null, now)) return;\n  const key = peakWarnKey(peak, now);',
    lost: 'a gép futó menet alatt is előjelezne',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: '!cur.quietSuggestions && BreakerStore.runningFocus(now) == null',
    lost: 'az Android futó menet alatt is javasolna menetet',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: '        if (BreakerStore.runningFocus(now) != null) return\n        val peak = FilterHitLogic.peakHour(st.filterHitHours, now) ?: return',
    lost: 'az Android futó menet alatt is előjelezne',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'let quiet = store.state.quietSuggestions == true || store.runningFocus(now) != nil',
    lost: 'az iPhone futó menet alatt is előjelezne',
  },
  // A HETI MONDAT MEGOSZTHATÓ: a gépen a vágólapra, a telefonokon a rendszer
  // megosztójával. Ha a gomb nem tenné, a mondat csak nézhető maradna.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'await navigator.clipboard.writeText(text);',
    lost: 'a gépi heti mondat nem másolható',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, digestNow)',
    lost: 'az Android heti mondata nem osztható meg',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'ShareLink(item: digestNow)',
    lost: 'az iPhone heti mondata nem osztható meg',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "const phone = host ? keywordInHost(status?.keywords ?? [], host) : null;",
    lost: 'a gépi próbamező nem mondaná a telefon ítéletét — ugyanaz a szó ott mást tesz',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "const hit = keywordHit(status?.keywords ?? [], url);",
    lost: 'a gépi próbamező nem a bővítmény kulcsszó-ítéletét mondaná',
  },
  // EGY KATTINTÁS a rétegből: a segéd választja a csomagot, a réteg gombja
  // indítja. Ha a státusz nem hozná, a gomb az első csomagra esne vissza — nem
  // hiba, de nem is az, amit ígérünk.
  {
    file: 'desktop/src/helper/server.ts',
    needle: "browserHitsKeywords: browserHitsByKeyword(state.browserHits, now),\n    lastUsedPackId: lastUsedPack(",
    lost: 'a segéd státusza nem választana csomagot a réteg gombjának',
  },
  {
    file: 'desktop/src/renderer/overlay.ts',
    needle: 'void start(pack, pack.defaultMinutes)',
    lost: 'a réteg gombja nem indítana menetet egy kattintásra',
  },
  // MELYIK szabály dolgozik: az okok a hídon átjönnek, a segéd tartja — ha a
  // státusz vagy a lap nem mondaná, a bontás csak a bővítmény lapján maradna.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'browserHitsReasons: browserHitsByReason(state.browserHits, now),',
    lost: 'a segéd státusza nem mondaná az okokat — a gépi sor mindig üres',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "hitsReasonLine(status?.browserHitsReasons ?? [])",
    lost: 'a gépi statisztika nem mondaná, melyik szabály dolgozik',
  },
  {
    file: 'extension/options.js',
    needle: 'hitsReasonText(hitsWeekByReason(state, today))',
    lost: 'a bővítmény beállítás-lapja nem mondaná, melyik szabály dolgozik',
  },
  // AZ ELŐJELZÉS a lapon is: amit az értesítés mond, a kezdőlap kártyája is —
  // a gombbal együtt. Ha kiesne, a csúcs-óra előtt csak a sáv szólna.
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'FilterHitLogic.peakWarnText(it)',
    lost: 'az Android kezdőlapja nem mondaná az előjelzést a csúcs-óra előtt',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'FilterHitLogic.peakWarnText(soon)',
    lost: 'az iPhone kezdőlapja nem mondaná az előjelzést a csúcs-óra előtt',
  },
  // HA NEM KÉRED, csendben marad: a kapcsoló a bekötéseket tartja csendben. Ha
  // egy kiesne, a kapcsoló egy semmit nem csináló kapcsoló lenne — és a
  // felhasználó azt hinné, hogy az app nem tartja be, amit ígért.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'if (quietSuggestions()) return;',
    lost: 'a gép a kapcsoló ellenére is szólna',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'if (st.quietSuggestions) return',
    lost: 'Androidon a szolgáltatás a kapcsoló ellenére is szólna a csúcs-óra előtt',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: '&& !cur.quietSuggestions',
    lost: 'Androidon a szolgáltatás a kapcsoló ellenére is szólna a sokadik megakadásnál',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'let peak = quiet ? nil : FilterHitLogic.peakHour(',
    lost: 'iPhone-on az előjelzés a kapcsoló ellenére is ütemezve maradna',
  },
  // A MEGAKADÁS-SZÁMLÁLÓ lánca: a háttér könyvel, a link átadja, a híd
  // fogadja, a segéd tartja, a mondat és a statisztika mondja. Ha bármelyik
  // láncszem kiesne, a bővítmény lapja továbbra is számolna — az app viszont
  // nullát mondana, és semmi nem jelezné.
  {
    file: 'extension/background.js',
    needle: "await recordHitNow(details.tabId, details.url, hit.reason, Date.now(), hit.keyword ?? '');",
    lost: 'a bővítmény nem könyvelné a megakadásokat — a számláló mindig nulla lenne',
  },
  {
    file: 'extension/background.js',
    needle: 'if (r?.ok) await pushHitsNow();',
    lost: 'a könyv nem menne át az appba — a heti mondat és a statisztika nem tudna róla',
  },
  {
    file: 'desktop/src/main/rules-bridge.ts',
    needle: "if (method === 'POST' && path === '/hits') {",
    lost: 'a híd nem fogadná a könyvet — a bővítmény hibát kapna rá',
  },
  {
    file: 'desktop/src/main/main.ts',
    needle: "await client.call('browser_hits', { source, days });",
    lost: 'a híd fogadná a könyvet, de a segédig nem érne el',
  },
  {
    file: 'desktop/src/helper/server.ts',
    needle: "case 'browser_hits': {",
    lost: 'a segéd nem tartaná a könyvet — a statisztika és a mondat nulla',
  },
  {
    file: 'desktop/src/helper/digest-journal.ts',
    needle: 'browserHits7d: browserHits7d(state.browserHits, now),',
    lost: 'a heti mondat nem mondaná a megakadásokat',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'megakadás a böngészőben',
    lost: 'a statisztika sora nem mondaná a megakadásokat',
  },
  // A MEGBÍZOTT a böngészőben: a híd leadja a nevét, a háttér a lap címére
  // teszi, a lap lába kimondja. Bármelyik kiesne, a tiltó lap a próbatétel
  // útját mondaná — a megbízott nélkül, pont a kísértés pillanatában.
  {
    file: 'desktop/src/main/main.ts',
    needle: 'return s.partner ? { name: s.partner.name } : null;',
    lost: 'a híd nem adná le a megbízottat — a tiltó lap a feloldás útját az ő '
      + 'jelmondata nélkül mondaná',
  },
  {
    file: 'extension/background.js',
    needle: "q.set('partner', hit.partner)",
    lost: 'a bővítmény tudna a megbízottról, de a tiltó lap címére nem tenné — '
      + 'a láb hallgatna róla',
  },
  {
    file: 'extension/blocked.js',
    needle: 'el.textContent = t ?? withPartner(fallback);',
    lost: 'a tiltó lap lába a megbízott nélkül mondaná a feloldás útját',
  },
  {
    file: 'desktop/src/renderer/overlay.ts',
    needle: '|| stopWayLine(status))',
    lost: 'a réteg lába a leállítás útját a megbízott nélkül mondaná',
  },
  // A GÉPEN a heti napló sorát a segéd időzítője írja, az app nélkül is. Ha a
  // hívás kiesne, a mag és a tesztje megmaradna — csak a sor nem íródna soha.
  {
    file: 'desktop/src/helper/index.ts',
    needle: 'journalTick(state, Date.now())',
    lost: 'a gépen a heti napló sora sosem íródna az app nélkül — a mag megvan, '
      + 'a segéd köre nem hívná',
  },
  // iPhone-on a HETI NAPLÓ sora az app körében íródik, és a statisztika az
  // élő mondatot mutatja — ha bármelyik kiesne, a mag ott lenne, a napló nem.
  {
    file: 'ios/App/ContentView.swift',
    needle: 'DigestLogic.due(store.state.digestWeekKey, now: now)',
    lost: 'iPhone-on a heti napló sora sosem íródna — a mag megvan, az app '
      + 'köre nem kérdezné',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'DigestLogic.inputFor(store.state, now: now)',
    lost: 'iPhone-on a statisztika nem mutatná, mi szólna most — a napló '
      + 'sorai címke nélkül, magyarázat nélkül állnának',
  },
  // A HÉTFŐ REGGELI VISSZATEKINTÉS a telefonon a szolgáltatás köréből szól. A
  // mag (Digest.kt) teszttel együtt megvan — ha a kör nem kérdezné meg, a
  // telefon sosem szólna, és semmi nem hasalna el tőle.
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'runCatching { maybeDigest() }',
    lost: 'a telefonon a hétfő reggeli visszatekintés sosem szólna — a mag '
      + 'megvan, csak a kör nem kérdezné meg',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'DigestLogic.due(st.digestWeekKey, now)',
    lost: 'a visszatekintés vagy minden körben szólna, vagy sosem — az '
      + 'esedékesség és az „egy hétről egyszer” a mag döntése',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'BreakerStore.coolingSites(now)',
    lost: 'a telefonon a futó hűtésről senki nem szólna — a böngésző hibalapja '
      + 'meghibásodásnak látszana, nem szünetnek',
  },
  // A SZIGORÚ PRIVÁT DNS a telefon legcsendesebb kiskapuja: a rendszer a VPN
  // mellett, TLS-en viszi a névfeloldást, a szűrő nem látja. Kényszeríteni
  // nem tudjuk, kimondani igen — a főképernyőn ÉS az értesítésben; ha
  // bármelyik hallgatna, a telefon zöldet mutatna egy megkerült szűrő mellett.
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'PrivateDns.strictHostname(context)',
    lost: 'a főképernyő zöldet mutatna, miközben a szigorú Privát DNS megkerüli '
      + 'a szűrőt',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'PrivateDns.strictHostname(this)',
    lost: 'a tartós értesítés „Védelem aktív”-ot mondana egy megkerült szűrő '
      + 'mellett — pont ott, ahova a telefonon nézni lehet',
  },
  // Ugyanez a gépen két szem: a lépegető megkérdezése és a kirakás. Bármelyik
  // kiesésével minden fordulna tovább — csak épp senki nem szólna.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'stepBurstNotices(',
    lost: 'a gépen a betelésről és a szünet leteltéről senki nem szólna — aki '
      + 'nem az appot nézi, annak a hűtés némán történne',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'showBurstNotice(n, nowForBurst)',
    lost: 'a lépegető mondanivalója a padlóra esne — kiszámolt, kirakatlan '
      + 'értesítés lenne',
  },
  // A MÉRÉS ŐSZINTESÉGE. A tiltott oldal hibalapján mért idő nem használat:
  // ha mégis könyvelődne, a statisztika hazudna, és a hibalap-percek előre
  // ürítenék a napi keretet. Androidon a tiltott DNS-kérés eleve nem kelt
  // észlelést; a gépen ez az egy kapu dönt.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'blockReasonNow(sampleSite, state.usage, s.at',
    lost: 'a hibalapon mért percek a statisztikába és a napi keretbe folynának '
      + '— a mérés hazudna, a keret magától fogyna',
  },
  // A MÉRÉS TÖRLÉSE ÉS A KERET. A keret a MAI mért időből fogy, tehát a mai
  // vödör törlése azonnal újratölti — próbatétel nélkül, korlátlanul. A mérés
  // KIKAPCSOLÁSA emiatt régóta tiltott keret mellett; a törlés viszont kapu
  // nélkül állt, és pontosan ugyanezt tudta. A kapu mindkét magban egy hívás,
  // amit semmi más nem fogna ki.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'clearUsage(state.usage, hasLimit,',
    lost: 'a „Statisztika törlése” gomb ingyen, akárhányszor újratöltené a napi '
      + 'keretet — miközben a keret emelése próbatétel',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Referee.kt',
    needle: 'UsageLogic.clearUsage(state.usage, hasLimit, now)',
    lost: 'a telefonon a Törlés gomb ingyen újratöltené a napi keretet',
  },
  // AZ ÓRA-VÉDELEM ALAPVONALA A LEMEZRŐL. Amíg memóriában élt, az app
  // kilövése + óra-előreállítás ingyen rövidítette a várakozást: az első kör
  // csak új alapvonalat vett fel. A hívás kiesése ezt némán visszahozná — a
  // kód fordulna, a tesztek a memóriás alapvonallal is átmennének.
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Referee.kt',
    needle: 'BreakerStore.loadLastTick()',
    lost: 'a telefonon az app kilövése után az óra előreállítása ingyen '
      + 'megrövidítené a várakozást és a törlés türelmi idejét',
  },
  {
    file: 'ios/Shared/Referee.swift',
    needle: 'BreakerStore.shared.loadLastTick()',
    lost: 'iPhone-on az alagút újraindulása után az óra előreállítása ingyen '
      + 'megrövidítené a várakozást',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'Referee.clearUsage(',
    lost: 'a Törlés gomb a kapu MELLETT törölne — a keret megint ingyen '
      + 'újratöltődne',
  },
  // A MAI NAP KÜLÖN LISTÁJA. A mag régóta kiszámolta (`topToday`), csak épp
  // senki nem kérdezte meg — a felhasználó kérte ki magának a funkciót.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "renderBarList($('topToday')",
    lost: 'a mai nap listája megint csak ki lenne számolva, kirajzolva nem',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/StatsScreen.kt',
    needle: 'BarList(summary.topToday',
    lost: 'a telefonon a mai nap listája nem jutna képernyőre',
  },
  // A DIAGNOSZTIKA-SZÖVEG. A leggyakoribb kérdés ennél a funkciónál az, hogy
  // miért nulla a mai nap; a válasz mindig ugyanabból a néhány adatból jön ki.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'diagnosticsText()',
    lost: 'a mérés állapotát megint képernyőképekből kellene kitalálni',
  },
  // A SZONDA HATÁRIDEJE. A `probing` jelző csak a kör BEFEJEZÉSEKOR törlődik,
  // tehát egyetlen beragadt lekérdezés a folyamat hátralévő életére megállítja
  // a mérést — és a szonda-egészség sem szólal meg, mert az hibát számol, nem
  // elmaradást. A felhasználó csak a nullát látja.
  {
    file: 'desktop/src/main/tracker.ts',
    // A tű a HÍVÁS, nem a név: az `import` sor a hívás törlése után is
    // tartalmazná a nevet, és az őr hallgatna. Ez a második eset ma, ahol a
    // puszta név elfedte a törlést — a szűkítés nem finomkodás.
    needle: 'withDeadline<Foreground | null>(',
    lost: 'egy beragadt előtér-lekérdezés némán megállítaná a mérést a folyamat '
      + 'hátralévő életére, figyelmeztetés nélkül',
  },
  // A KÉT ENGEDÉLY-ESET. Ugyanaz a nulla, két külön teendővel: aki még soha nem
  // adta meg az engedélyt, annak meg kell adnia; akitől a rendszer frissítéskor
  // visszavette, annak ÚJRA. Egy közös mondat az egyik felét rossz helyre küldi.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'trackerState!.neverWorked',
    lost: 'a frissítés utáni engedélyvesztés ugyanazt a mondatot kapná, mint az '
      + 'első indítás — pedig a teendő más',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    // A tű a MONDAT, nem a mezőnév: a `samplesDropped` a típusdeklarációkban
    // is szerepel, tehát a megjelenítés törlése után is „megvolt” — az első
    // próbám pont ezen csúszott át. A szöveg viszont csak ott van, ahol
    // tényleg képernyőre kerül.
    needle: 'nem sikerül eltárolni',
    lost: 'az elveszett mérési minták nem jutnának képernyőre: a felhasználó '
      + 'ugyanazt a nullát látná, mint engedélyhiánynál, rossz teendővel',
  },
  {
    file: 'desktop/src/helper/sync-client.ts',
    needle: 'syncFocusRound',
    lost: 'a munkamenet sosem érne át a többi eszközre',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/SyncClient.kt',
    needle: 'syncFocusRound',
    lost: 'az androidos szinkron nem hozná le a munkamenetet',
  },
  {
    file: 'ios/Shared/SyncClient.swift',
    needle: 'syncFocusRound',
    lost: 'az iPhone szinkronja nem hozná le a munkamenetet',
  },

  // A MENET LEZÁRÁSA. Ha ezt nem hívja senki, a menet a saját idejében
  // „lejár” ugyan (az `isRunning` hamisat ad rá), de a naplóba SOHA nem kerül
  // be — és a statisztikából pont azok a menetek hiányoznának, amiket a
  // felhasználó végigvitt. Az a statisztika rosszabb a semminél: azt mondaná,
  // hogy sosem sikerül.
  {
    file: 'desktop/src/helper/referee.ts',
    needle: 'closeIfEnded',
    lost: 'a gépen a magától lejárt menet nem kerülne a statisztikába',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Referee.kt',
    needle: 'Focus.closeIfEnded',
    lost: 'a telefonon a magától lejárt menet nem kerülne a statisztikába',
  },
  {
    file: 'ios/Shared/Referee.swift',
    needle: 'Focus.closeIfEnded',
    lost: 'az iPhone-on a magától lejárt menet nem kerülne a statisztikába',
  },

  // A NAPLÓ EGYESÍTÉSE. Enélkül a szinkron az „utolsó író nyer” szabályt
  // követné a naplóra is: a másik eszköz sorai csendben eltűnnének, és a
  // felhasználó azt látná, hogy fél hete nem dolgozott.
  {
    file: 'desktop/src/helper/sync-client.ts',
    needle: 'mergeLog',
    lost: 'a gépen a többi eszköz menetei kiesnének a statisztikából',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/SyncClient.kt',
    needle: 'FocusSync.mergeLog',
    lost: 'a telefonon a többi eszköz menetei kiesnének a statisztikából',
  },
  {
    file: 'ios/Shared/SyncClient.swift',
    needle: 'FocusSync.mergeLog',
    lost: 'az iPhone-on a többi eszköz menetei kiesnének a statisztikából',
  },

  // A STATISZTIKA KISZÁMOLÁSA a két telefonon. A gépen ezt a segéd végzi
  // (`summarizeFocus` fentebb); itt a felület kéri el.
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'Focus.summarizeFocus',
    lost: 'a telefonon a munkamenet-statisztika üresen állna',
  },
  {
    file: 'ios/App/StatsView.swift',
    needle: 'Focus.summarizeFocus',
    lost: 'az iPhone-on a munkamenet-statisztika üresen állna',
  },

  // A FIGYELMEZTETÉS arról, hogy a fehérlistát a gépen nem érvényesíti senki.
  // A logika megvan, de ha nem hívja senki, a felhasználó ugyanúgy nem tudja
  // meg — és pont ez a funkció lényege.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'renderFocusExtensionWarning',
    lost: 'az appban nem derülne ki, hogy a bővítmény nincs összekötve',
  },
  // AZ ÖNTESZT. A zöld korong csak akkor igaz, ha a rendszer feloldója a
  // tiltott neveket a tiltó címre oldja. Két szem: a segéd kérdezzen magától,
  // és a felület mondja ki, ha szivárog — bármelyik nélkül a hamis zöld marad.
  {
    file: 'desktop/src/helper/index.ts',
    needle: 'runSelfTest(activeHostnames(state',
    lost: 'az önteszt sosem futna le magától — a hamis zöld maradna, a segéd '
      + 'tudná, a felület nem',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'status!.selfTest?.leaking',
    lost: 'a szivárgó önteszt nem jutna a státusz-korongra — a segéd mérné, '
      + 'a felület zöldet mutatna',
  },
  // A HOSZTNEVEK SZERKESZTÉSE. A felvétel a hosts fájlba ír, a levétel
  // próbatétel — ha a parancs nem a refereen menne át, a levétel egy gomb lenne.
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'referee.startHostnameChange(',
    lost: 'a hosztnév levétele nem a refereen menne át — egy gomb lenne, '
      + 'próbatétel nélkül',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'openHostnamesDialog(site)',
    lost: 'a hosztnevek szerkesztése nem lenne elérhető — a mag ott lenne, '
      + 'kapcsoló nélkül',
  },
  // AZ ISMÉTLŐDŐ MUNKAMENET. A heti ablak három helyen indít (segéd, Android,
  // iPhone); ha bármelyikből kiesik, azon az eszközön a reggeli menet csendben
  // elmarad, és a felhasználó azt hiszi, be van állítva. A levétel kapuja a
  // referee: ha a parancs nem azon menne át, az ablak egy kikapcsoló lenne.
  {
    file: 'desktop/src/helper/referee.ts',
    needle: 'const due = dueRecurrence(state.focusPacks',
    lost: 'a gépen az ablak sosem indítana menetet — a beállítás ott lenne, hatás nélkül',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Referee.kt',
    needle: 'Focus.dueRecurrence(next.focusPacks',
    lost: 'a telefonon az ablak sosem indítana menetet — a gép nélkül a reggel szabad lenne',
  },
  {
    file: 'ios/Shared/Referee.swift',
    needle: 'if let due = Focus.dueRecurrence(',
    lost: 'az iPhone-on az ablak sosem indítana menetet — a gép nélkül a reggel szabad lenne',
  },
  {
    file: 'desktop/src/helper/server.ts',
    needle: 'referee.setFocusRecurrence(',
    lost: 'az ablak levétele nem a refereen menne át — egy gomb lenne, próbatétel nélkül',
  },
  {
    file: 'desktop/src/helper/referee.ts',
    needle: 'expandsAllowList(packs[at].allowSites, pack.allowSites)',
    lost: 'az ablakos csomag fehérlistája a Mentéssel ingyen bővülne — a Mentés lenne '
      + 'az ablak kikapcsolója',
  },
  {
    file: 'desktop/src/helper/referee.ts',
    needle: 'find((p) => p.id === packId)?.recurrence',
    lost: 'az ablakos csomag a Törlés gombbal ingyen tűnne el — törölni és újra felvenni '
      + 'kerülné meg a levétel próbatételét',
  },
  {
    file: 'desktop/src/helper/referee.ts',
    needle: 'isWindowRun(run, state.focusPacks ?? [])) {',
    lost: 'a levétel próbatétele alatt beért ablak menete kézi menetként futna tovább az '
      + 'ablak végéig, egy második próbatétel mögött',
  },
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: "'focus_recurrence'",
    lost: 'az ablak beállítása nem lenne elérhető — a mag ott lenne, kapcsoló nélkül',
  },
  // A BŐVÍTMÉNY MAPPÁJA. Ha az app nem tartaná frissen, a böngészőben egy régi
  // bővítmény futna egy új app mellett — és a felület egy mappára mutatna,
  // amit senki nem frissít.
  {
    file: 'desktop/src/main/main.ts',
    needle: "setupExtensionFolder(app.getPath('userData')",
    lost: 'a bővítmény mappája nem frissülne — a böngészőben régi bővítmény '
      + 'futna egy új app mellett, a felület meg egy nem frissülő mappára mutatna',
  },
  // A MENTETT GYORSBILLENTYŰ. Ha a fő folyamat nem a mentett kombinációt
  // regisztrálná, a felület mást mutatna, mint ami a rendszerben él — az
  // átállítás látszólag sikerülne, a réteg meg a régire (vagy semmire) nyílna.
  {
    file: 'desktop/src/main/main.ts',
    needle: "setupOverlayShortcut(app.getPath('userData'))",
    lost: 'a mentett kombináció nem regisztrálódna indításkor — a felület mást '
      + 'mutatna, mint ami a rendszerben él',
  },
  {
    file: 'desktop/src/renderer/overlay.ts',
    needle: 'extWarning',
    lost: 'a gyorsbillentyűs rétegben nem derülne ki, hogy nincs bővítmény',
  },

  // AMIÉRT AZ EGÉSZ APP VAN. A blokklista a hosts fájlba írásával lép életbe;
  // ha ezt nem hívja senki, az app tökéletesnek LÁTSZIK — a lista ott van, a
  // felület zöld, az állapot „védve” —, és közben SEMMI nincs tiltva.
  //
  // Ez a legrosszabb elképzelhető néma hiba ebben a projektben, és éppen ezért
  // állt eddig őrizetlenül: annyira alapvető, hogy eszünkbe sem jutott.
  {
    file: 'desktop/src/helper/index.ts',
    needle: 'applyBlocklist',
    lost: 'a gépen SEMMI nem lenne tiltva — a hosts fájlba nem kerülne be a lista',
  },
  {
    file: 'desktop/src/helper/index.ts',
    needle: 'watchHosts',
    lost: 'a hosts fájlból kézzel kitörölt blokk nem kerülne vissza',
  },
  {
    file: 'desktop/src/helper/index.ts',
    needle: 'applyDohPolicies',
    lost: 'a böngésző saját DNS-e megkerülné a tiltást',
  },

  // A SÚRLÓDÁS ESZKALÁCIÓJA. Enélkül minden próbatétel a legkönnyebb fokon
  // maradna, és a „nem lesz könnyebb attól, hogy sokszor csinálod” ígéret
  // csendben megszűnne — a táblázat ott lenne, csak épp senki nem kérdezné meg.
  {
    file: 'desktop/src/helper/referee.ts',
    needle: 'computeTier',
    lost: 'a gépen minden feloldás a legkönnyebb próbatételt kapná',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Referee.kt',
    needle: 'ChallengeEngine.computeTier',
    lost: 'a telefonon minden feloldás a legkönnyebb próbatételt kapná',
  },
  {
    file: 'ios/Shared/Referee.swift',
    needle: 'ChallengeEngine.computeTier',
    lost: 'az iPhone-on minden feloldás a legkönnyebb próbatételt kapná',
  },

  // A RÉSZLEGES TILTÁS a böngészőben. A bővítmény két forrásból dolgozik: a
  // saját szabályaiból és az appból lehúzottakból. Ha a kettő összefésülése
  // (`withAppRules`) kimaradna, az appban felvett szabályok SOHA nem hatnának
  // — a felületen ott állnának, a böngésző meg átengedné őket.
  {
    file: 'extension/background.js',
    needle: 'withAppRules',
    lost: 'az appban felvett részleges szabályok nem hatnának a böngészőben',
  },
  {
    file: 'extension/background.js',
    needle: 'firstMatch',
    lost: 'a bővítmény semmilyen szabályt nem alkalmazna',
  },
  {
    file: 'extension/background.js',
    needle: 'dueForRefresh',
    lost: 'a bővítmény befagyna az első listánál, és nem venné át a változásokat',
  },

  // AMI ELDÖNTI, MELYIK NÉV KERÜL A TILTÁSBA. Itt találkozik a lista az
  // idővel: a szünet, a menetrend és a NAPI KERET mind ezen a döntésen
  // keresztül hat. Ha nem kérdeznénk meg, a keret csendben nem csinálna
  // semmit — a felületen ott ketyegne a mérő, elfogyna, és nem történne
  // semmi. Ugyanígy a menetrend: a beállított sáv díszlet lenne.
  {
    file: 'desktop/src/helper/hosts.ts',
    needle: 'isBlockedNowWithLimit',
    lost: 'a gépen a szünet, a menetrend és a napi keret egyike sem hatna',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Store.kt',
    needle: 'LimitLogic.isBlockedNowWithLimit',
    lost: 'a telefon szűrője nem venné figyelembe a keretet és a menetrendet',
  },
  {
    file: 'ios/Shared/Store.swift',
    needle: 'LimitLogic.isBlockedNowWithLimit',
    lost: 'az iPhone alagútja nem venné figyelembe a keretet és a menetrendet',
  },

  // A FRISSÍTÉS. „Olyan egyszerű, mint egy áruházból” — ez az ígéret azon áll,
  // hogy az app magától MEGNÉZI, van-e újabb verzió. Ha a keresés hívása
  // kimaradna, semmi nem hibázna: az app menne tovább, a felhasználó meg
  // hónapokig a régi verziót futtatná, benne minden azóta javított hibával.
  // Épp azért csendes, mert a frissítés hiánya nem hibaüzenet — csak nem
  // történik semmi.
  {
    file: 'desktop/src/main/main.ts',
    needle: 'initUpdater',
    lost: 'az asztali app soha nem venné észre, hogy van újabb verzió',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'UpdateChecker.check',
    lost: 'a telefon soha nem venné észre, hogy van újabb verzió',
  },

  // A MUNKAMENET-SZINKRON HIBÁJA mind a három felületen látszik. A leggyakoribb
  // ok egy régi fiókkiszolgáló, ami nem ismeri a `focus` gyűjteményt: a gépen
  // elindított menet ilyenkor SOSEM ér át, és a felhasználó semmiből nem tudná
  // meg, miért — azt hinné, a funkció rossz. A hibát rögzíteni kevés; ki is
  // kell írni, különben csak az állapotban ül.
  {
    file: 'desktop/src/renderer/renderer.ts',
    needle: 'focusSyncError',
    lost: 'a gépen nem derülne ki, hogy a munkamenet szinkronja elhasalt',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/ui/AppUi.kt',
    needle: 'focusSyncError',
    lost: 'a telefonon nem derülne ki, hogy a munkamenet szinkronja elhasalt',
  },
  {
    file: 'ios/App/ContentView.swift',
    needle: 'focusSyncError',
    lost: 'az iPhone-on nem derülne ki, hogy a munkamenet szinkronja elhasalt',
  },

  // A FELADÁS ADÓSSÁGA. Aki félbehagy egy próbatételt, ugyanazt a párost kapja
  // vissza egy ideig — enélkül a „feladom” INGYENES ÚJRASORSOLÁS lenne: nem
  // tetszik a kapott páros, feladom, húzok újat, amíg könnyű nem jön.
  //
  // Ha a `forcedCombo` kimaradna a terv készítéséből, semmi nem hasalna el: a
  // terv elkészülne, csak épp frissen sorsolva. Az egész ígéret — hogy nem
  // lesz könnyebb attól, hogy sokszor csinálod — csendben megszűnne.
  {
    file: 'desktop/src/helper/referee.ts',
    needle: 'forcedCombo(state, comboSiteId, now)',
    lost: 'a gépen a feladás ingyenes újrasorsolássá válna',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Referee.kt',
    needle: 'forcedCombo(',
    lost: 'a telefonon a feladás ingyenes újrasorsolássá válna',
  },
  {
    file: 'ios/Shared/Referee.swift',
    needle: 'forcedCombo(',
    lost: 'az iPhone-on a feladás ingyenes újrasorsolássá válna',
  },

  // A ZÁRLAT. Ez a legkönnyebben elveszíthető tiltás az egész appban, mert a
  // hiánya SEMMIT nem tör el: a próbatétel elindul, a felhasználó megcsinálja,
  // az oldal kinyílik — pontosan úgy, ahogy zárlat nélkül. Csak épp az az
  // egyetlen dolog szűnt meg csendben, aminek szándékosan nincs visszaútja.
  //
  // A kapu mindhárom magban EGY függvény, és mindhárom magban a TERV KÉSZÍTÉSE
  // megy rajta át — nem tíz külön ellenőrzés, amiből egy lemaradhat.
  {
    file: 'desktop/src/helper/referee.ts',
    needle: 'assertUnlocked(state, now)',
    lost: 'a gépen a zárlat alatt is el lehetne indítani egy feloldást',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Referee.kt',
    needle: 'requireUnlocked(',
    lost: 'a telefonon a zárlat alatt is el lehetne indítani egy feloldást',
  },
  {
    file: 'ios/Shared/Referee.swift',
    needle: 'requireUnlocked(',
    lost: 'az iPhone-on a zárlat alatt is el lehetne indítani egy feloldást',
  },
  // A zárlat a SZINKRONON is átjön: enélkül csak azon az eszközön élne, ahol
  // elindították — a másik telefon meg nyitva maradna, és pont az a kibúvó.
  {
    file: 'desktop/src/helper/sync-client.ts',
    needle: 'state.lockdown = merged.lockdown',
    lost: 'a másik eszközön indított zárlat sosem érne ide',
  },
  {
    file: 'desktop/src/shared/sync/focus-merge.ts',
    needle: 'mergeLockdown(local.lockdown, incoming.lockdown)',
    lost: 'a zárlat a fésülésben elveszne, és a régebbi állapot feloldana',
  },
  // A tiltó lap zárlat alatt NEM ígérhet feloldást. Ha a vég nem jutna el a
  // lapra, a láb azt írná, hogy az appban próbatétellel feloldható — pedig
  // zárlat alatt pont az az út nincs. Nem hibás tiltás, hanem hazug lap.
  {
    file: 'extension/background.js',
    needle: 'const lockUntil = lockdownUntil(link, now);',
    lost: 'a tiltó lap zárlat alatt is próbatételt ígérne',
  },
  {
    file: 'extension/blocked.js',
    needle: "paintFoot(document.getElementById('closedFoot'), t.foot)",
    lost: 'a tiltó lap lába zárlat alatt is a feloldás útját mondaná',
  },
  {
    file: 'desktop/src/main/main.ts',
    needle: 'liveLockdown(s.lockdown, Date.now())',
    lost: 'a híd nem adná ki a zárlat végét, a bővítmény semmit nem tudna róla',
  },
  // A ZÁRLAT-ABLAK. Az ablak nem új érvényesítés, hanem egy időzítő a
  // meglévő elé: a kör az ablak végéig szóló zárlatot ír, és a kapu az ablakot
  // a kör ELŐTT is látja. Ha bármelyik kimaradna, semmi nem hasalna el — csak
  // a „hétköznap 9-től 17-ig” ablak nem zárna semmit, vagy egy jól időzített
  // feloldás átcsúszna az ablak kezdése és az első kör között.
  {
    file: 'desktop/src/helper/referee.ts',
    needle: 'windowLockdown(state.lockdown, state.lockdownWindows ?? [], now)',
    lost: 'a gépen a zárlat-ablak nem írna zárlatot, és a kapu sem látná',
  },
  // Az ablak zárlatát az óra-ugrás elnyelése nem tolja el: az ablak vége az
  // ablak vége. Enélkül a laptop alvása hosszabbítaná a hétköznapot, és a gép
  // meg a telefon két különböző zárlatot látna ugyanarról a napról.
  {
    file: 'desktop/src/helper/referee.ts',
    needle: 'isWindowLockdown(state.lockdown, state.lockdownWindows ?? [])',
    lost: 'a gépen az alvás eltolná az ablak zárlatának végét',
  },
  // Az ablakok a szinkronon a JELÜKKEL járnak: a levétel próbatétellel jár,
  // ami lépteti a jelet — enélkül a másik eszköz csomag-szerkesztése (ami a
  // blob rev-jét lépteti) feltámasztaná a levett ablakot, vagy elvinné a
  // frissen felvettet.
  {
    file: 'desktop/src/helper/sync-client.ts',
    needle: 'state.lockdownWindows = merged.lockdownWindows',
    lost: 'a másik eszközön felvett zárlat-ablak sosem érne ide',
  },
  {
    file: 'desktop/src/shared/sync/focus-merge.ts',
    needle: 'windowsMerged(local, incoming)',
    lost: 'az ablakok a fésülésben elvesznének, vagy az újabb blob döntene a jel helyett',
  },
  {
    file: 'desktop/src/helper/revisions.ts',
    needle: 'markWindows(state);',
    lost: 'az ablak-lista sosem kapna jelet, és a levétel nem érne át',
  },
  // A telefonok ugyanezt: a kör zárlatot ír az ablakból, a kapu az ablakot
  // a kör előtt is látja, és a szinkron az ablakot a jelével viszi.
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/Referee.kt',
    needle: 'LockdownLogic.windowLockdown(',
    lost: 'a telefonon a zárlat-ablak nem írna zárlatot',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/SyncClient.kt',
    needle: 'lockdownWindows = merged.lockdownWindows',
    lost: 'a telefonra sosem érne át a gépen felvett zárlat-ablak',
  },
  {
    file: 'ios/Shared/Referee.swift',
    needle: 'LockdownLogic.windowLockdown(',
    lost: 'az iPhone-on a zárlat-ablak nem írna zárlatot',
  },
  {
    file: 'ios/Shared/SyncClient.swift',
    needle: 'current.lockdownWindows = merged.lockdownWindows',
    lost: 'az iPhone-ra sosem érne át a gépen felvett zárlat-ablak',
  },

  // A HOSTS FÁJL ŐREI. A szinkronon jött hosztnevek a root-tulajdonú hosts
  // fájlba mennek; egy soremeléses „név” tetszőleges sort írna bele — bármely
  // oldal átirányítását. Két háló: a forrásnál (a szinkron beolvasója) és a
  // nyelőnél (a blokk kiírása). Egyik kiesése sem hasal el sehol.
  {
    file: 'desktop/src/helper/sync-client.ts',
    needle: 'cleanHostnames(s.hostnames)',
    lost: 'a szinkronon jött hosztnév szűrés nélkül menne a hosts fájlba',
  },
  {
    file: 'desktop/src/shared/blocklist.ts',
    needle: 'if (normalizeHostname(h) !== h) continue;',
    lost: 'a hosts-blokk kiírása bármilyen szöveget sorként írna a fájlba',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/core/SyncClient.kt',
    needle: '.filter { Blocklist.isCanonicalHostname(it) }',
    lost: 'a telefon a szinkronon jött szemét-hosztnevet tovább hordozná a gép felé',
  },
  {
    file: 'ios/Shared/SyncClient.swift',
    needle: 'SyncMerge.cleanIncoming(',
    lost: 'az iPhone a szinkronon jött szemét-hosztnevet tovább hordozná a gép felé',
  },
];

/**
 * Megjegyzések nélküli kód.
 *
 * Mind a négy nyelv (Kotlin, Swift, JS, TS) ugyanazt a két alakot használja.
 * A sztringeket szándékosan nem bántjuk: egy sztringbe írt hívásnév olyan
 * ritka, hogy nem éri meg érte egy fél elemzőt írni — a megjegyzés viszont
 * gyakori, mert minden magyarázat mellette áll.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}

const problems = [];
for (const wire of WIRES) {
  const full = path.join(ROOT, wire.file);
  if (!fs.existsSync(full)) {
    problems.push({ ...wire, why: 'a fájl nincs meg' });
    continue;
  }
  // A MEGJEGYZÉSEKET KI KELL SZEDNI. Az első változat nem tette, és pont
  // ezért nem fogta ki a szándékosan elrontott hívást: a fájl tetején lévő
  // magyarázó megjegyzés is tartalmazta a nevet, tehát az ellenőrző a saját
  // dokumentációt találta meg, nem a kódot. Egy ellenőrző, ami a
  // megjegyzésekre reagál, pont akkor hallgat, amikor szólnia kellene.
  const text = stripComments(fs.readFileSync(full, 'utf8'));
  const uses = text.split(wire.needle).length - 1;
  if (uses === 0) problems.push({ ...wire, why: 'nincs benne hívás' });
}

if (problems.length === 0) {
  console.log(`huzalozás OK (${WIRES.length} döntési pont a helyén)`);
  process.exit(0);
}

console.error('Huzalozatlan döntés — a logika megvan, de senki nem hívja:\n');
for (const p of problems) {
  console.error(`  ${p.file}: ${p.needle} (${p.why})`);
  console.error(`    elveszne: ${p.lost}\n`);
}
console.error('Ez a projekt visszatérő hibafajtája: semmi nem hasal el tőle,');
console.error('az app hibátlannak látszik, a tiltás meg nem történik meg.');
process.exit(1);
