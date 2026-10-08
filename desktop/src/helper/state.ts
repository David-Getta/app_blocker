// Persistent helper state. Lives in a root/SYSTEM protected directory so the
// GUI (and the user) cannot simply edit the blocklist file to skip challenges.

import { cleanDigestLog } from '../shared/digest';
import { cleanPartnerList, cleanPartnersGone, mergePartners, normalizePartnerLock } from '../shared/partner';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Step } from '../shared/challenges';
import type { ChannelFilter } from '../shared/channels';
import type { Schedule } from '../shared/schedule';
import { emptyUsage, type UsageState } from '../shared/usage';
import type { SharedToday } from '../shared/limits';
import {
  MAX_FOCUS_LOG, normalizePack, withCleanMarks, type FocusLogEntry, type FocusPack, type FocusRun,
} from '../shared/focus';
import { normalizeRule, type UrlRule } from '../shared/urlrules';
import { capGone, capHostnameMarks, isGone, ruleKey, type SyncSite } from '../shared/sync/merge';
import { cleanWindowMarks, normalizeWindows, parseLockdown } from '../shared/lockdown';
import { cleanChannelMarks } from '../shared/sync/channels-merge';
import { cleanKeywordMarks, cleanKeywords, type KeywordMarks } from '../shared/keywords';
import { cleanBrowserHits } from '../shared/browser-hits';
import { normalizeBurst } from '../shared/burst';
import { stateFilePath } from './paths';

export interface SiteRec {
  id: string;
  domain: string;
  hostnames: string[];
  /**
   * A hosztnevek jelei (név → az a `rev`, amelyik felvette vagy levette) —
   * a szinkron nevenkénti összefésüléséhez, lásd shared/sync/merge.ts. A
   * `revisions.ts` írja, a `commit()` elején, a lista változásából.
   */
  hostnameMarks?: Record<string, number>;
  /** a hosztnevek az utolsó rev-léptetéskor/átvételkor — ebből lesz a jel; helyi */
  revHosts?: string[];
  addedAt: number;
  pauseUntil: number | null;
  pendingDeleteAt: number | null;
  /** optional weekly schedule; absent = always blocked */
  schedule?: Schedule;
  /** optional daily active-time budget in seconds; absent = no budget */
  dailyLimitSeconds?: number;
  /**
   * Adag-szabály: ennyi HASZNÁLAT után… (másodperc). Csak a szünettel együtt
   * értelmes — lásd shared/burst.ts. A beállítás szinkronizálódik, a számláló
   * nem (eszköz-helyi, a HelperState.bursts-ben él).
   */
  burstSeconds?: number;
  /** …ennyi SZÜNET (másodperc). */
  cooldownSeconds?: number;
  /** fedőnév: ha van, a felület EZT mutatja a cím helyett (lásd shared/alias.ts) */
  alias?: string;
  /** indok: miért tiltottad — a soron és a tiltó lapon emlékeztet (lásd shared/alias.ts) */
  reason?: string;
  /**
   * Részleges szabályok: az oldal egy-egy darabja (pl. `/@valaki`).
   *
   * Ezeket a DNS-motor NEM tudja érvényesíteni — a hosztnévnél tovább nem lát.
   * A böngésző-bővítmény veszi át őket; a segéd tárolja és szinkronizálja, hogy
   * ne kelljen minden gépen újra felvenni. Lásd docs/feature-partial-block.md.
   */
  rules?: UrlRule[];
  /** a szabálylista jele: az a `rev`, amelyik a listát utoljára változtatta (lásd shared/sync/merge.ts) */
  rulesRev?: number;
  /** a szabálylista kulcsa az utolsó rev-léptetéskor/átvételkor — ebből lesz a jel; helyi */
  revRulesKey?: string;
  /**
   * A szabályok jelei: szabály-kulcs → az a `rev`, amelyik felvette vagy
   * levette (a levett szabály jele sírkő). A léptetés írja (revisions.ts), a
   * fésülés szabályonként ebből dönt (shared/sync/merge.ts `mergeRules`).
   */
  ruleMarks?: Record<string, number>;
  /** a szabály-kulcsok az utolsó rev-léptetéskor/átvételkor — ebből lesznek a jelek; helyi */
  revRules?: string[];
  /**
   * Az adag-szabály még SOSEM ment fel a fiókba (helyi jel). A v0.4.227 előtti
   * gép az adag-szabályt nem tette a drótra: ami akkor itt állt be, az csak
   * itt élt. A frissítés utáni első kör ezt friss szigorításként teszi rá a
   * fésülés eredményére (lásd sync-client.ts `reapplyUnsyncedBursts`), aztán
   * a jel lekerül.
   */
  burstUnsynced?: boolean;

  // --- szinkron (lásd helper/revisions.ts és shared/sync/merge.ts) ---
  /** hányszor változott érdemben ez a rekord; ez dönt az összefésülésnél */
  rev?: number;
  /** mikor változott utoljára (ms) */
  updatedAt?: number;
  /** melyik eszközön — a döntetlen eltörésére */
  updatedBy?: string;
  /** a szinkron-mezők lenyomata a legutóbbi léptetéskor; ebből látszik, hogy változott-e */
  revFp?: string;
  /**
   * A KIFIZETETT LAZÍTÁSOK száma mezőnként: a törlés kérése, a menetrend, a
   * napi keret és az adag-szabály lazítása. A bíró írja, a próbatétel
   * teljesítésekor (referee.ts) — máshol semmi. A fésülés mezőnként ebből
   * dönt (shared/sync/merge.ts).
   */
  deleteLoosens?: number;
  scheduleLoosens?: number;
  limitLoosens?: number;
  burstLoosens?: number;
  /**
   * A végigment törlés jele: annak a kérésnek a számlálója, amelyik végigment
   * (shared/sync/merge.ts `isGone`). A sírkövön áll (`HelperState.goneSites`);
   * élő rekordon csak akkor, ha a fésülés hozta, és itt még nem esedékes.
   */
  goneLoosens?: number;
}

export interface SessionRec {
  id: string;
  kind: 'pause' | 'delete';
  siteId: string;
  minutes?: number;
  steps: Step[];
  stepIndex: number;
  createdAt: number;
  /** when set, finishing the session applies this schedule instead of pausing
   *  (used to gate schedule LOOSENING behind the same challenges) */
  pendingSchedule?: Schedule;
  /** when set, finishing applies this daily budget instead of pausing;
   *  null means "remove the budget" (both are gated loosenings) */
  pendingLimit?: number | null;
  /** ha van, a teljesítés EZT a részleges szabályt veszi le (lazítás) */
  pendingRuleRemoval?: UrlRule;
  /** ha van, a teljesítés EZT a hosztnevet veszi le az oldalról (lazítás) */
  pendingHostnameRemoval?: string;
  /**
   * Ha van, a teljesítés az adag-szabályt cseréli erre (lazítás: nagyobb
   * adag, rövidebb szünet, vagy a szabály levétele — az a null).
   */
  pendingBurst?: { burstSeconds: number; cooldownSeconds: number } | null;
  /**
   * Ha van, a teljesítés a csatorna-szűrőt cseréli erre (lazítás: kikapcsolás,
   * új engedélyezett csatorna, gazdagép-csere). A `next: null` a törlés.
   */
  pendingChannelFilter?: { id: string; next: ChannelFilter | null };
  /**
   * Ha van, a teljesítés a futó munkamenetet rövidíti erre az időpontra.
   *
   * A -1 azt jelenti: állítsd le MOST. A kettőt meg kell különböztetni, mert a
   * „nulla” egy érvényes időpont lenne, a hiányzó mező pedig azt jelenti, hogy
   * ez a kísérlet nem a munkamenetről szól.
   */
  pendingFocusEnd?: number;
  /**
   * Ha van, a teljesítés a csomag ismétlődését cseréli erre (lazítás: szűkítés
   * vagy levétel — az a null). Nem oldalhoz tartozik, hanem egy csomaghoz.
   */
  pendingRecurrence?: { packId: string; band: import('../shared/schedule').Band | null };
  /**
   * Ha van, a teljesítés a zárlat-ablakok listáját cseréli erre (lazítás:
   * levétel vagy szűkítés). Nem oldalhoz tartozik, hanem az egész géphez.
   */
  pendingLockdownWindows?: import('../shared/lockdown').LockdownWindow[];
  /** ha van, a teljesítés a kulcsszó-listát cseréli erre (lazítás: levétel) */
  pendingKeywords?: string[];
  /**
   * Ha van, a teljesítés a MEGBÍZOTTAT veszi le (lazítás) — a terv végén az ő
   * jelmondatával, tehát a levételhez is ő kell.
   */
  pendingPartnerRemoval?: true;
  /** ha van, a teljesítés a mérés-őrt kapcsolja ki (lazítás) — lásd shared/measure-guard.ts */
  pendingRequireMeasurementOff?: true;
  /** hányszor volt rossz a jelmondat ebben a kísérletben — a plafonnál a kísérlet elszáll */
  partnerTries?: number;
}

/**
 * What an abandoned attempt leaves behind, so restarting cannot re-roll it.
 *
 * Kept PER SITE, and a single shared record would not do: with one slot,
 * starting and cancelling an attempt on any other site (or the delete flow on
 * the same one) would evict the debt and hand back a fresh draw — the re-roll
 * again, one step removed.
 */
export interface AbandonRec {
  siteId: string;
  kind: 'pause' | 'delete';
  comboKey: string;
  at: number;
}

export interface HelperState {
  version: 1;
  sites: SiteRec[];
  /**
   * A végigment, kifizetett törlések SÍRKÖVEI (legfeljebb `MAX_GONE_SITES`).
   * Nem tiltanak semmit; a szinkron viszi őket, hogy egy régi eszköz rekordja
   * ne támassza fel az oldalt, és a fiókban maradt rekord ne jöjjön vissza
   * minden körben. A bíró írja, a törlés végrehajtásakor (referee.ts `tick`).
   * Nem kötelező: régi állapotfájlban nincs.
   */
  goneSites?: SiteRec[];
  /** epoch ms of every successful unlock/delete request, for difficulty tiers */
  unlockLog: number[];
  lastCombo: string | null;
  session: SessionRec | null;
  /** attempts given up on, per site; see REROLL_COOLDOWN_MS */
  abandons?: AbandonRec[];
  /**
   * A FÉLBEMARADT kísérletek ideje (epoch ms), harminc napig — feladva,
   * lejárva, lecsúszva, elszállva, újraindítva. A visszatekintés ebből mondja,
   * hányszor indult el a lazítás, és maradt félbe; a feloldások párja
   * (`unlockLog`). Nem kötelező: régi állapotfájlban nincs.
   */
  droppedAttempts?: number[];
  /**
   * A böngésző megakadásai forrásonként (böngésző-profilonként): a bővítmény
   * könyve, a hídon át. A heti mondat és a statisztika sora mondja. Nem
   * kötelező: régi állapotfájlban nincs. Lásd shared/browser-hits.ts.
   */
  browserHits?: import('../shared/browser-hits').BrowserHits;
  /** wall clock at the previous housekeeping tick, to notice clock jumps */
  lastTickAt?: number;
  /**
   * Zárlat: eddig az időpontig SEMMILYEN lazítás nem indítható.
   *
   * Nem oldalanként, hanem az egész gépre — a zárlat nem egy oldal ügye,
   * hanem egy döntés arról, hogy most nem tárgyalunk. Hiányzik = nincs
   * zárlat. Lásd shared/lockdown.ts.
   */
  lockdown?: import('../shared/lockdown').Lockdown;
  /**
   * Zárlat-ablakok: heti sávok, amikben a zárlat MAGÁTÓL él — a kör az
   * ablak végéig szóló zárlatot ír a `lockdown` mezőbe. Felvenni ingyen,
   * levenni próbatétel. A munkamenet blobján szinkronizál, a jelével
   * együtt. Hiányzik = nincs ablak. Lásd shared/lockdown.ts.
   */
  lockdownWindows?: import('../shared/lockdown').LockdownWindow[];
  /**
   * Az ablak-lista egészének JELE: a munkamenet-blob `rev`-je, amelyik a
   * listát utoljára változtatta — csak a régi kliensek miatt utazik; a
   * fésülés a tartalmankénti jelekből dönt. A lenyomat-léptetés írja (revisions.ts).
   */
  lockdownWindowsRev?: number;
  /**
   * Az ablak-jelek: TARTALMI kulcs → a blob `rev`-je, amelyik az ilyen
   * ablakot utoljára felvette vagy levette (revisions.ts, `markWindows`). A
   * fésülés ezekből dönt (shared/lockdown.ts, `mergeWindowSets`).
   */
  lockdownWindowMarks?: import('../shared/lockdown').WindowMarks;
  /**
   * KULCSSZÓ-SZABÁLYOK: bármely oldalon, ha a cím tartalmazza. A böngésző-
   * bővítmény érvényesíti (csak ő látja a teljes címet); felvenni ingyen,
   * levenni próbatétel. A munkamenet blobján szinkronizál, a jelével.
   * Hiányzik = nincs kulcsszó. Lásd shared/keywords.ts.
   */
  keywords?: string[];
  /**
   * A kulcsszó-lista JELE: a blob `rev`-je, amelyik utoljára változtatta
   * (revisions.ts) — csak a régi kliensek miatt utazik.
   */
  keywordsRev?: number;
  /**
   * A KULCSSZAVANKÉNTI jelek: kulcsszó → a blob `rev`-je, amelyik utoljára
   * felvette vagy levette (revisions.ts, `markKeywordChanges`). A fésülés
   * ezekből dönt, kulcsszavanként (shared/keywords.ts, `mergeKeywordSets`).
   */
  keywordMarks?: KeywordMarks;
  /**
   * PÁRBAN ZÁROLÁS: a megbízott lenyomata, ha van. Amíg van, minden lazító
   * próbatétel utolsó lépése az ő jelmondata; felvenni ingyen, levenni
   * próbatétel. A munkamenet blobján utazik, a jelével. Lásd shared/partner.ts.
   */
  partner?: import('../shared/partner').PartnerLock;
  /**
   * a jele: a blob `rev`-je, amelyik utoljára változtatta. A fésülés már nem
   * ebből dönt (azonosság szerint megy), csak a régi kliensek miatt utazik.
   */
  partnerRev?: number;
  /**
   * A fő mellett élő TÁRS-megbízottak (két eszközön egymástól függetlenül
   * felvéve): a lazítás végén mindegyik jelmondata kell. Lásd shared/partner.ts.
   */
  partnerCo?: import('../shared/partner').PartnerLock[];
  /** a levett megbízottak nyoma — csak a jelmondatos levétel írja; élő megbízottat csak ez visz el */
  partnersGone?: import('../shared/partner').PartnerGone[];
  dohApplied: boolean;
  /** active-time tracking history (stays on this machine) */
  usage: UsageState;
  /**
   * Csatorna-szűrők: „ezen az oldalon csak a felsorolt csatornák nyílnak meg”.
   *
   * A blokklistától FÜGGETLEN: az oldal nincs tiltva, csak a nem engedélyezett
   * csatornái. A tiltást a böngésző-bővítmény végzi (csak ő látja az
   * útvonalat); a segéd a rekordok gazdája és a súrlódás kapuja.
   */
  channelFilters?: ChannelFilter[];
  /**
   * Adag-számlálók oldalanként (kulcs: site id) — EZEN a gépen.
   *
   * Szándékosan nem a SiteRec-en és nem a dróton: a szinkron tízperces
   * körökben jár, egy kétperces adaghoz az túl lassú — ebből nem pontatlan
   * közös számláló lesz, hanem őszintén eszközönkénti. Lásd shared/burst.ts.
   */
  bursts?: Record<string, import('../shared/burst').BurstState>;
  /**
   * Hányszor telt be MA az adag, oldalanként (kulcs: site id) — ezen a gépen.
   *
   * A felületnek szól: azt mutatja meg, hogy a szabály tényleg dolgozik. A
   * `day` a helyi naptári nap; napfordulón a számláló tiszta lappal indul.
   */
  burstTrips?: Record<string, { day: string; count: number }>;
  /** A BETELÉSEK KÖNYVE: oldal → nap → darab, hét napig — a hét összegét a felület mondja. */
  burstTripLog?: Record<string, Record<string, number>>;
  /**
   * Mikor rögzítettünk UTOLJÁRA mért időt.
   *
   * Nem a szinkronizált mérés-blobban van, hanem itt: ez helyi diagnosztika,
   * nem adat. A statisztikán a nulla önmagában néma — nem lehet megmondani
   * belőle, hogy tényleg nem használtad a gépet, vagy a mérés hasalt el. Ez a
   * mező teszi különbséggé a kettőt.
   */
  usageLastSampleAt?: number;
  /**
   * MÉRÉS NÉLKÜL NINCS KERET-IDŐ: ha az app nem jelentkezik (kiléptek belőle,
   * nem indult el), a keretes és adagos oldalak zárva — lásd
   * shared/measure-guard.ts. Csak bekapcsolva van jelen. Bekapcsolni ingyen,
   * kikapcsolni próbatétel. Helyi beállítás: a mérés is ezen a gépen fut.
   */
  requireMeasurement?: true;
  /**
   * Rejtve induljon-e a blokkolt oldalak listája.
   *
   * Beállítás, nem pillanatnyi állapot: a felület minden indításkor rejtve
   * kezdi, és a munkamenetre nyitható meg. Így az app megnyitása önmagában nem
   * szembesít azzal, mi van blokkolva.
   */
  hideSiteList?: boolean;
  /** a rejtés jele: a focus-blob rev-je, amelyik utoljára be- vagy kikapcsolta */
  hideSiteListRev?: number;
  /**
   * Az állapot már abból a korból való, amikor az adag-szabály a drótra
   * kerül. Hiánya = régi állapotfájl: a betöltés megjelöli a helyi adag-
   * szabályokat (`SiteRec.burstUnsynced`), egyszer.
   */
  burstOnWire?: boolean;
  /**
   * Melyik hétről íródott már a heti napló sora (a hétfő dátuma). A segéd
   * könyvelése — a felület értesítése külön, a saját tárában könyvel: az a
   * futó app dolga, ez a mindig futó segédé. Szinkronra nem megy.
   */
  digestWeekKey?: string | null;
  /**
   * A heti napló: a visszatekintés mondatai hetenként, a legfrissebb elöl,
   * fél évig. A segéd írja a körében, hétfő reggel — az app nélkül is —, a
   * saját címkézésével (a rejtés beállítása, a fedőnév); a felület a
   * kirakáskor a mostani címkéjét teszi rá. Lásd shared/digest.ts.
   */
  digestLog?: import('../shared/digest').DigestEntry[];

  /**
   * Fiók a szinkronhoz. Hiányzik = nincs bejelentkezve.
   *
   * A `dataKey` szándékosan ITT van, a segéd root-védett állapotfájljában: a
   * végpontok közti titkosítás a KISZOLGÁLÓ ellen véd, nem a saját géped ellen.
   * Ha a felület tárolná, minden felhasználói folyamat elolvashatná.
   */
  sync?: SyncAccount;

  /**
   * A többi eszköz mai összegzése — ebből lesz a KÖZÖS napi keret.
   *
   * Azért van elmentve, és nem csak a memóriában: ha a gép újraindul, vagy a
   * szinkron épp nem érhető el, a délelőtt a telefonon elhasznált keret ne
   * induljon újra nulláról. Elavulni nem tud, mert minden sor a saját napját
   * hozza — éjfélkor magától kiürül.
   */
  sharedToday?: SharedToday;

  /**
   * Munkamenet-csomagok: „most csak EZ mehet”.
   *
   * A blokklista feketelista, ez fehérlista. Lásd shared/focus.ts.
   */
  focusPacks?: FocusPack[];
  /** a FUTÓ munkamenet, ha van */
  focusRun?: FocusRun | null;
  /**
   * A munkamenet szinkron-számlálója.
   *
   * Ugyanaz a szerep, mint az oldalak `rev` mezőjének: ez dönti el, mikor mehet
   * át egy LAZÍTÁS (rövidítés, leállítás) a másik eszközre. Nőni csak akkor tud,
   * ha a munkamenet ténylegesen megváltozott ezen a gépen — leállítani pedig
   * csak próbatétellel lehet, tehát a nagyobb szám mögött ott a munka.
   */
  focusRev?: number;
  focusUpdatedAt?: number;
  focusUpdatedBy?: string;
  /**
   * A csomagok jelei (azonosító → az a blob-rev, amelyik felvette,
   * szerkesztette vagy törölte) — a szinkron csomagonkénti összefésüléséhez,
   * lásd shared/sync/focus-merge.ts. A `revisions.ts` írja a `commit()` elején.
   */
  focusPackMarks?: Record<string, number>;
  /** a csomagok lenyomata az utolsó léptetéskor/átvételkor — ebből lesz a jel; helyi */
  focusRevPacks?: Record<string, string>;
  /** a lenyomat, amiből kiderül, hogy változott-e (lásd revisions.ts) */
  focusRevFp?: string;
  /**
   * A zárlat-ablakok tartalmi kulcsa az utolsó léptetéskor — ebből derül
   * ki, hogy a lista változott-e, tehát kell-e új jel (revisions.ts).
   */
  focusRevWindows?: string;
  /** a megbízott kulcsa az előző léptetéskor — ebből látszik, változott-e (a jeléhez) */
  focusRevPartner?: string;
  /** a kulcsszó-lista kulcsa az előző léptetéskor — ebből látszik, változott-e (a jeléhez) */
  focusRevKeywords?: string;
  /** a kulcsszó-lista az előző léptetéskor — ebből látszik, mi került be és mi ki (a kulcsszavak jeleihez) */
  focusRevKeywordList?: string[];
  focusRevHide?: string;
  /**
   * A csatorna-szűrők szinkron-számlálója — a munkamenet mintájára. A szűrők
   * egy blobként utaznak, de GAZDAGÉPENKÉNT fésülődnek
   * (`shared/sync/channels-merge.ts`): a `rev` csak a blob kulcsa.
   */
  channelsRev?: number;
  channelsUpdatedAt?: number;
  channelsUpdatedBy?: string;
  channelsRevFp?: string;
  /**
   * GAZDAGÉPENKÉNT a jel: annak a blobnak a `rev`-je, amelyik az oldal
   * szűrőjét utoljára felvette, módosította vagy levette (revisions.ts,
   * `markChannels`). Szűrő nélkül a levétel nyoma.
   */
  channelMarks?: Record<string, number>;
  /**
   * GAZDAGÉPENKÉNT a kifizetett lazítások száma: kikapcsolás, új csatorna
   * bekapcsolt szűrőn, törlés vagy gazdagép-csere bekapcsoltan — ezekhez
   * próbatétel kellett. A fésülésben a több nyer.
   */
  channelLoosens?: Record<string, number>;
  /** A szűrők a legutóbbi léptetéskor (vagy átvételkor) — ebből látszik, mi változott és hogyan. */
  channelsRevList?: ChannelFilter[];
  /**
   * Miért nem megy a munkamenet szinkronja, ha nem megy.
   *
   * Külön mező, mert a munkamenet köre SZÁNDÉKOSAN nem állítja meg az egész
   * szinkront (a blokklista fontosabb). Enélkül viszont a hiba néma lenne: egy
   * régi fiókkiszolgáló nem ismeri a gyűjteményt, a menet sosem érne át a
   * telefonra, és a felhasználó azt hinné, a funkció rossz.
   */
  focusSyncError?: string;
  /** Ugyanez a csatorna-szűrőkre: a kör nem áll meg tőle, de nem is néma. */
  channelsSyncError?: string;
  /**
   * A LEZÁRULT munkamenetek naplója.
   *
   * Helyi marad, nem megy fel a kiszolgálóra: ez mérés, nem beállítás — és a
   * mérés eddig sem hagyta el a gépet. A statisztika ebből dolgozik.
   */
  focusLog?: FocusLogEntry[];
}

export interface SyncAccount {
  serverUrl: string;
  accountId: string;
  /** ezen a gépen ez az eszközazonosító — a döntetlen eltörésére is ez megy */
  deviceId: string;
  /** amit a kiszolgálónak küldünk; a jelszó sosem kerül ide */
  authKey: string;
  /** az adatkulcs base64-ben; ezzel titkosítjuk a feltöltött tartalmat */
  dataKey: string;
  /** eszköznév, amit a többi eszközön látni fogsz (titkosítva megy fel) */
  deviceName: string;
  /** a `sites` gyűjtemény verziója, amire a legutóbbi feltöltésünk épült */
  sitesVersion?: number;
  /** a munkamenet-gyűjtemény utolsó ismert verziója a kiszolgálón */
  focusVersion?: number;
  /** a csatorna-szűrők gyűjteményének utolsó ismert verziója a kiszolgálón */
  channelsVersion?: number;
  /** a saját `usage` blobunk verziója */
  usageVersion?: number;
  /** a saját mai összegzésünk verziója (a közös napi kerethez) */
  todayVersion?: number;
  /** az utolsó kör, ami VÉGIG lefutott */
  lastSyncAt?: number;
  /**
   * Az utolsó PRÓBÁLKOZÁS — sikeres és sikertelen egyaránt.
   *
   * Külön mező, mert e nélkül egy befagyott időbélyeg kétértelmű: nem lehet
   * megmondani, hogy a szinkron tíz órája sikertelen és tíz percenként újra
   * próbálja, vagy hogy a kör MAGA állt le és azóta hozzá se kezdett. A
   * kettő közül a második valódi hiba, az első csak offline gép — a
   * felhasználó pedig ugyanazt látta mindkettőre.
   */
  lastAttemptAt?: number;
  /** az utolsó hiba, hogy a felület meg tudja mondani, mi nem megy */
  lastError?: string;
}

export function defaultState(): HelperState {
  return {
    version: 1, sites: [], unlockLog: [], lastCombo: null, session: null,
    dohApplied: false, usage: emptyUsage(), burstOnWire: true,
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export function loadState(): HelperState {
  const file = stateFilePath();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as HelperState;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.sites)) {
      // Forward migration: state files written before usage tracking existed.
      if (!parsed.usage || !Array.isArray(parsed.usage.days)) parsed.usage = emptyUsage();
      if (!Array.isArray(parsed.unlockLog)) parsed.unlockLog = [];
      if (parsed.droppedAttempts !== undefined) {
        parsed.droppedAttempts = Array.isArray(parsed.droppedAttempts)
          ? parsed.droppedAttempts.filter((t) => typeof t === 'number' && Number.isFinite(t))
          : [];
      }
      // A napló sorai a mag szűrőjén át: ami nem sor, az nem sor.
      if (parsed.digestLog !== undefined) parsed.digestLog = cleanDigestLog(parsed.digestLog);
      // A böngésző könyve is: ami nem nap, az nem nap.
      if (parsed.browserHits !== undefined) parsed.browserHits = cleanBrowserHits(parsed.browserHits);
      // A mérés-őr: csak a szó szerinti igaz kapcsolja be — egy „true” szöveg
      // vagy egy szám nem (lásd shared/measure-guard.ts).
      if (parsed.requireMeasurement !== undefined && (parsed.requireMeasurement as unknown) !== true) {
        delete parsed.requireMeasurement;
      }
      // A session whose stepIndex does not address a real step can only wedge
      // the referee — every operation on it reads steps[stepIndex]. Dropping it
      // means the unlock attempt starts over, which is friction in the safe
      // direction; keeping it would block pause AND delete indefinitely.
      const ses = parsed.session;
      if (ses && !(Array.isArray(ses.steps) && ses.stepIndex >= 0 && ses.stepIndex < ses.steps.length)) {
        parsed.session = null;
      }
      // A közös keret adatai kívülről jönnek: ha nem a várt alakúak, inkább
      // ne legyenek. Egy hibás sor itt a blokkolási döntést befolyásolná.
      // A csomagok kívülről is jöhetnek (állapotfájl, később szinkron): amit
      // nem tudunk értelmezni, azt inkább nem tartjuk meg.
      if (parsed.focusPacks !== undefined) {
        parsed.focusPacks = (Array.isArray(parsed.focusPacks) ? parsed.focusPacks : [])
          .map((x) => normalizePack(x))
          .filter((x): x is FocusPack => x !== null);
      }
      // A napló is kívülről jön. Ha nem tömb, a statisztika `filter`-e KIVÉTELT
      // dobna — és a felhasználó egy üres statisztika-képernyőt látna, aminek
      // semmi köze nem lenne a méréshez. Ami nem értelmezhető, az kiesik; a
      // sorok külön-külön is, mert egy rossz sor ne vigye el az egész hetet.
      if (parsed.focusLog !== undefined) {
        parsed.focusLog = (Array.isArray(parsed.focusLog) ? parsed.focusLog : [])
          .filter((e): e is FocusLogEntry => !!e && typeof e === 'object'
            && typeof (e as FocusLogEntry).packId === 'string'
            && typeof (e as FocusLogEntry).packName === 'string'
            && Number.isFinite((e as FocusLogEntry).startedAt)
            && Number.isFinite((e as FocusLogEntry).endedAt)
            && Number.isFinite((e as FocusLogEntry).plannedEndsAt))
          // A sor két jele (rövidítésszám, eredeti kezdés) a szinkronban a
          // sírkő tudása: a rossz jel lekerül, nem a sor.
          .map((e) => withCleanMarks(e))
          .slice(-MAX_FOCUS_LOG);
      }
      const run = parsed.focusRun;
      // A menet csak a csomagjával együtt: ha a csomagját a betöltés
      // kidobta, a menet értelmezhetetlen (mi mehetne alatta?), a szinkron
      // meg minden körben újra feltöltené, amit a kiszolgáló sosem tart meg.
      if (run && !(typeof run.packId === 'string' && Number.isFinite(run.endsAt)
        && (parsed.focusPacks ?? []).some((p) => p.id === run.packId))) {
        parsed.focusRun = null;
      } else if (run) {
        parsed.focusRun = withCleanMarks(run);
      }
      const shared = parsed.sharedToday;
      if (shared && !(typeof shared.selfDeviceId === 'string' && Array.isArray(shared.devices))) {
        delete parsed.sharedToday;
      }
      // A ZÁRLAT ÉS AZ ABLAKOK is kívülről jönnek (állapotfájl, szinkron). Egy
      // rossz alakú ablak nem csak „nem érvényes”: a lenyomat és a kör a napok
      // listáján járna, és minden mentés kivételt dobna — a segéd megállna,
      // és a felület azt látná, hogy semmi nem menthető. Ami nem értelmezhető,
      // az kiesik; a folyamatban lévő levétel listája is ugyanígy tisztul.
      if (parsed.lockdown !== undefined) {
        const l = parseLockdown(parsed.lockdown);
        if (l) parsed.lockdown = l; else delete parsed.lockdown;
      }
      if (parsed.lockdownWindows !== undefined) {
        const w = normalizeWindows(parsed.lockdownWindows);
        if (w.length > 0) parsed.lockdownWindows = w; else delete parsed.lockdownWindows;
      }
      if (parsed.lockdownWindowsRev !== undefined
        && !(Number.isInteger(parsed.lockdownWindowsRev) && parsed.lockdownWindowsRev > 0)) {
        delete parsed.lockdownWindowsRev;
      }
      // Az ablak-jelek is a mag szűrőjén át — mint a dróton.
      if (parsed.lockdownWindowMarks !== undefined) {
        const rev = typeof parsed.focusRev === 'number' && Number.isFinite(parsed.focusRev) ? parsed.focusRev : 0;
        const m = cleanWindowMarks(parsed.lockdownWindowMarks, parsed.lockdownWindows ?? [], rev);
        if (m) parsed.lockdownWindowMarks = m; else delete parsed.lockdownWindowMarks;
      }
      // A csatorna-szűrők jelei és kifizetett lazításai is a mag szűrőjén át — mint a dróton.
      if (parsed.channelMarks !== undefined || parsed.channelLoosens !== undefined) {
        const rev = typeof parsed.channelsRev === 'number' && Number.isFinite(parsed.channelsRev) ? parsed.channelsRev : 0;
        const c = cleanChannelMarks(parsed.channelMarks, parsed.channelLoosens, parsed.channelFilters ?? [], rev);
        if (c.marks) parsed.channelMarks = c.marks; else delete parsed.channelMarks;
        if (c.loosens) parsed.channelLoosens = c.loosens; else delete parsed.channelLoosens;
      }
      // A kulcsszavak a mag szűrőjén át: ami nem kulcsszó, az nem az; üresen nincs mező.
      if (parsed.keywords !== undefined) {
        const k = cleanKeywords(parsed.keywords);
        if (k.length > 0) parsed.keywords = k; else delete parsed.keywords;
      }
      if (parsed.keywordsRev !== undefined
        && !(Number.isInteger(parsed.keywordsRev) && parsed.keywordsRev > 0)) {
        delete parsed.keywordsRev;
      }
      // A kulcsszó-jelek is a mag szűrőjén át: kanonikus kulcsszó, pozitív
      // egész, legfeljebb a blob rev-je, a plafonnal — mint a dróton.
      if (parsed.keywordMarks !== undefined) {
        const rev = typeof parsed.focusRev === 'number' && Number.isFinite(parsed.focusRev) ? parsed.focusRev : 0;
        const m = cleanKeywordMarks(parsed.keywordMarks, parsed.keywords ?? [], rev);
        if (m) parsed.keywordMarks = m; else delete parsed.keywordMarks;
      }
      if (parsed.focusRevKeywordList !== undefined) {
        parsed.focusRevKeywordList = cleanKeywords(parsed.focusRevKeywordList);
      }
      // A PÁRBAN ZÁROLÁS rekordja: csak a jó alakú marad. Egy sérült lenyomat
      // nem „nincs megbízott”, hanem egy megbízott, akinek a jelmondata sosem
      // stimmelne — csapda, nem döntés; ezért inkább leesik, kimondva.
      if (parsed.partner !== undefined) {
        const p = normalizePartnerLock(parsed.partner);
        if (p) parsed.partner = p; else delete parsed.partner;
      }
      // A társak és a nyomok ugyanígy — és a fésülés szabálya szerint
      // rendezve: a nyommal levett nem él, a fő a legkorábban felvett.
      if (parsed.partnerCo !== undefined || parsed.partnersGone !== undefined) {
        const set = mergePartners({
          ...(parsed.partner ? { partner: parsed.partner } : {}),
          partnerCo: cleanPartnerList(parsed.partnerCo),
          partnersGone: cleanPartnersGone(parsed.partnersGone),
        }, {});
        delete parsed.partner; delete parsed.partnerCo; delete parsed.partnersGone;
        if (set.partner) parsed.partner = set.partner;
        if (set.partnerCo) parsed.partnerCo = set.partnerCo;
        if (set.partnersGone) parsed.partnersGone = set.partnersGone;
      }
      if (parsed.partnerRev !== undefined
        && !(Number.isInteger(parsed.partnerRev) && parsed.partnerRev > 0)) {
        delete parsed.partnerRev;
      }
      if (parsed.hideSiteListRev !== undefined
        && !(Number.isInteger(parsed.hideSiteListRev) && parsed.hideSiteListRev > 0)) {
        delete parsed.hideSiteListRev;
      }
      if (parsed.session?.pendingLockdownWindows !== undefined) {
        parsed.session.pendingLockdownWindows = normalizeWindows(parsed.session.pendingLockdownWindows);
      }
      // A drót a v0.4.227 előtt nem vitte az adag-szabályt: ami addig itt
      // állt be, az a fiókban nincs meg. Egyszer megjelöljük, és a következő
      // kör friss szigorításként teszi fel — így egy közben történt telefonos
      // szerkesztés (nagyobb rev, adag nélkül) sem törli.
      if (parsed.burstOnWire !== true) {
        for (const site of parsed.sites) {
          if (normalizeBurst(site.burstSeconds, site.cooldownSeconds) !== null) site.burstUnsynced = true;
        }
        parsed.burstOnWire = true;
      }
      // A szabályok jelei a mag szűrőjén át — mint a dróton: kanonikus kulcs,
      // pozitív egész, legfeljebb a rekord rev-je, csak szabálylista mellett.
      for (const site of parsed.sites) {
        if (site.ruleMarks === undefined) continue;
        const marks: Record<string, number> = {};
        const raw = site.rules !== undefined && site.ruleMarks && typeof site.ruleMarks === 'object'
          ? Object.entries(site.ruleMarks) : [];
        for (const [k, v] of raw) {
          const norm = normalizeRule(k);
          if (!norm || ruleKey(norm) !== k) continue;
          if (!Number.isInteger(v) || v <= 0 || v > (site.rev ?? 0)) continue;
          marks[k] = v;
        }
        const capped = capHostnameMarks(marks, (site.rules ?? []).map(ruleKey));
        if (capped) site.ruleMarks = capped; else delete site.ruleMarks;
      }
      // A sírkövek: csak tömb, csak rekord-alakú elem (a többit a dróton járó
      // szűrő úgyis tisztítja), és csak HALOTT — ami nem az, az nem sírkő.
      if (parsed.goneSites !== undefined) {
        const gone = (Array.isArray(parsed.goneSites) ? parsed.goneSites : [])
          .filter((g) => !!g && typeof g === 'object' && typeof g.id === 'string' && g.id !== ''
            && typeof g.domain === 'string' && Array.isArray(g.hostnames)
            && typeof g.pendingDeleteAt === 'number' && Number.isFinite(g.pendingDeleteAt));
        for (const g of gone) cleanLoosens(g);
        const dead = capGone(gone.filter((g) => isGone(g as unknown as SyncSite)));
        if (dead.length > 0) parsed.goneSites = dead; else delete parsed.goneSites;
      }
      for (const site of parsed.sites) cleanLoosens(site);
      return parsed;
    }
  } catch {
    // missing or corrupt -> start fresh
  }
  return defaultState();
}

/**
 * A kifizetett lazítások számlálói a mag szűrőjén át — mint a dróton:
 * pozitív egész, legfeljebb a rekord rev-je (csak léptetés írhatja). A
 * végigment törlés jele legfeljebb a törlés számlálója: nagyobbat a fésülés
 * sosem ír.
 */
function cleanLoosens(site: SiteRec): void {
  for (const k of ['deleteLoosens', 'scheduleLoosens', 'limitLoosens', 'burstLoosens'] as const) {
    const v = site[k];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v <= 0 || v > (site.rev ?? 0)) delete site[k];
  }
  const g = site.goneLoosens;
  if (g !== undefined && !(Number.isInteger(g) && g > 0 && g <= (site.deleteLoosens ?? 0))) delete site.goneLoosens;
}

export function saveState(state: HelperState): void {
  const file = stateFilePath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = path.join(dir, `.state.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
