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
    needle: '|| stopWayLine(status);',
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
