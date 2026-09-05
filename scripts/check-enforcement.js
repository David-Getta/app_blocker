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
    file: 'extension/background.js',
    needle: 'closedFor(link, hostOf(url), now)',
    lost: 'a bővítmény nem kérdezné meg, zárva-e az oldal — a hűtött oldalra '
      + 'megint a nyers DNS-hibalap jönne',
  },
  {
    file: 'android/app/src/main/java/hu/breaker/app/vpn/BreakerVpnService.kt',
    needle: 'BreakerStore.coolingSites(now)',
    lost: 'a telefonon a futó hűtésről senki nem szólna — a böngésző hibalapja '
      + 'meghibásodásnak látszana, nem szünetnek',
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
    needle: 'forcedCombo(state, siteId, now)',
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
