// A munkamenet összefésülése két eszköz között.
//
// MIÉRT KÜLÖN FÁJL. A blokklista összefésülése (merge.ts) LISTÁT egyeztet,
// rekordonként. A munkamenetnél két nagyon különböző dolog utazik együtt:
//
//   - a CSOMAGOK: szerkeszthető beállítás, olyan, mint a blokklista;
//   - a FUTÓ munkamenet: EGY állapot, ami épp most tilt mindent.
//
// A kettőnek más a helyes összefésülése, és ha egy fájlban lennének, a kettő
// szabálya összekeveredne. A futó munkameneté a kockázatos: ott dől el, hogy a
// szinkron ki tudja-e kapcsolni azt, amit a felhasználó próbatétellel indított.
//
// A SZABÁLY UGYANAZ, MINT MINDENHOL:
//
//   szigorítás ingyen van, lazítás munkába kerül.
//
// A munkamenetnél a szigorítás iránya:
//
//   - INDÍTANI és HOSSZABBÍTANI szigorítás  -> mindig átmegy;
//   - RÖVIDÍTENI és LEÁLLÍTANI lazítás      -> csak a nyomával: a rövidítés a
//     menet `cuts` számlálójával, a leállítás egy rá hivatkozó naplósorral.
//
// Mindkét nyomot csak az írhatja, aki a menetet látta, és a próbatételt
// végigcsinálta. A blob `rev`-je erre NEM jó: azt egy átnevezés is lépteti,
// ingyen — és egy régi, „nem fut” állapot nagy `rev`-vel feltöltve a gépen
// próbatétel nélkül tüntette el a munkamenetet (`mergeRun`).
//
// A doksi: docs/feature-focus-sessions.md

import {
  FUTURE_LOG_TOLERANCE_MS, MAX_ALLOW_ENTRIES, MAX_FOCUS_LOG, bandMinutes, cleanCuts, cleanOrigin, logPackName,
  normalizePack, runOrigin, sameRun,
  type FocusLogEntry, type FocusPack, type FocusRun,
} from '../focus.js';
import {
  cleanWindowMarks, liveLockdown, mergeLockdown, mergeWindowSets, normalizeWindows, parseLockdown, windowKey,
  windowMarksKey, type WindowMarks,
  type Lockdown, type LockdownWindow,
} from '../lockdown.js';
import {
  cleanPartnerList, cleanPartnersGone, mergePartners, normalizePartnerLock, partnerId, partnerKey,
  type PartnerGone, type PartnerLock,
} from '../partner.js';
import {
  cleanKeywordMarks, cleanKeywords, keywordMarksKey, keywordsKey, mergeKeywordSets, type KeywordMarks,
} from '../keywords.js';
import type { Band } from '../schedule.js';

/** Legfeljebb ennyi csomag utazhat — a felületen sem fér ki több. */
export const MAX_PACKS = 30;

/**
 * A munkamenet a szinkronban.
 *
 * A `rev`/`updatedAt`/`updatedBy` hármas ugyanaz, mint a blokklistánál: a `rev`
 * a döntő, döntetlennél az idő, végül az eszközazonosító — hogy MINDEN eszköz
 * ugyanarra az eredményre jusson, különben két gép örökké oda-vissza írná
 * egymást.
 */
export interface SyncFocus {
  packs: FocusPack[];
  /** a futó munkamenet, vagy null, ha nem fut */
  run: FocusRun | null;
  /**
   * A LEZÁRULT menetek naplója — ebből lesz a statisztika.
   *
   * Szándékosan MÁS a szabálya, mint a fenti kettőnek, és ez nem
   * következetlenség. A csomagok és a futás ENGEDÉLYEK: azt mondják meg, mi
   * történhet, tehát rájuk vonatkozik a súrlódás iránya, és a `rev` őrzi őket.
   * A napló a MÚLT feljegyzése: nem enged meg semmit, nem old fel semmit, és
   * egy elveszett sora nem kibúvó, csak pontatlan statisztika.
   *
   * Ezért a napló EGYESÍTÉS, nem döntés: minden eszköz sora bekerül, és a
   * `rev`-hez semmi köze. Aki később egységesíteni akarja a hármat, ezt a
   * bekezdést olvassa el előbb: a `rev` léptetése egy naplósorért azt
   * jelentené, hogy egy statisztika-bejegyzés le tud állítani egy futó
   * menetet a másik eszközön.
   */
  log: FocusLogEntry[];
  /**
   * A csomagok JELEI: csomag-azonosító → a blob `rev`-je, amelyik a csomagot
   * utoljára felvette, szerkesztette vagy törölte (a törölt csomag jele
   * marad, a csomag nincs a listán). Csomagonként a nagyobb jel dönt; jel
   * nélkül az újabb blob — ahogy eddig. Lásd `mergePacks`.
   */
  packMarks?: Record<string, number>;
  /**
   * A csomagok KIFIZETETT ABLAK-LAZÍTÁSAI: csomag-azonosító → hányszor
   * szűkítették vagy vették le a heti ablakát próbatétellel. A bíró írja, a
   * teljesítéskor — máshol semmi. A fésülés csomagonként ebből dönt: a több
   * kifizetett lazítás nyer, egészében; egyenlőnél az ablakos változat, két
   * ablakos közül a szigorúbb, mezőnként. A törölt csomag számlálója is marad:
   * az ablakos csomag törlése előtt az ablakot kellett levenni. Lásd `mergePacks`.
   */
  packLoosens?: Record<string, number>;
  /**
   * A csomagok SAJÁT JELE: csomag-azonosító → a győztes osztály (kifizetett
   * lazítások, ablakos-e) saját legnagyobb jele — csak ott, ahol KISEBB a
   * közös jelnél (`packMarks`). A közös jel a nagyobb marad (a régi kliens
   * csak azt látja); az osztályon belül viszont ez dönt, különben egy
   * osztály-döntés vesztesének nagyobb jele a győztesre ragadna, és három
   * eszköznél a sorrendtől függne, melyik változat marad. A helyi
   * szerkesztés törli (annál a saját jel maga a közös). Lásd `mergePacks`.
   */
  packOwnMarks?: Record<string, number>;
  /**
   * A ZÁRLAT, ha van. Miért ITT utazik, és nem a blokklistával: a zárlat nem
   * egy oldal ügye, hanem az egész eszközé — ugyanaz a szint, mint a futó
   * menet. A `rev`-hez viszont SEMMI köze: a fésülése tiszta magasvízjel, a
   * későbbi vég nyer (lásd `mergeLockdown`). Ez nem lazaság, hanem a szabály:
   * a zárlat csak szigorítani tud, tehát nem kell megvédeni attól, hogy egy
   * régebbi rekord felülírja — visszafelé úgysem tud lépni.
   */
  lockdown?: Lockdown;
  /**
   * A ZÁRLAT-ABLAKOK: heti sávok, amikben a zárlat magától él. Beállítás,
   * mint a csomagok — de a levétele próbatétel, tehát a fésülése nem az
   * újabb blobé, hanem a TARTALMANKÉNTI jeleké (lásd `mergeWindowSets`).
   * Üresen nincs mező.
   */
  lockdownWindows?: LockdownWindow[];
  /**
   * Az ablak-lista egészének jele: a blob `rev`-je, amelyik a listát
   * utoljára változtatta — csak a régi klienseknek utazik, ők még ezzel
   * fésülnek.
   */
  lockdownWindowsRev?: number;
  /**
   * Az ablak-jelek: TARTALMI kulcs (`windowKey`) → a blob rev-je, amelyik
   * az ilyen ablakot utoljára felvette vagy levette. A fésülés ezekből dönt.
   */
  lockdownWindowMarks?: WindowMarks;
  /**
   * PÁRBAN ZÁROLÁS: a FŐ megbízott lenyomata (a legkorábban felvett élő) és a
   * jele (a blob `rev`-je, amelyik utoljára változtatta). A fésülés NEM a jel
   * szerint megy, hanem azonosság szerint (lásd `mergePartners`): élő
   * megbízottat csak a nyoma visz el. A jelet a régi kliensek miatt hordjuk
   * tovább — ők még a jel szerint fésülnek. Hiányzik = nincs.
   */
  partner?: PartnerLock;
  partnerRev?: number;
  /**
   * A fő mellett élő TÁRS-megbízottak: két eszközön egymástól függetlenül
   * felvett (vagy egy friss eszközön a valódi mellé tett) megbízott — a
   * lazítás végén mindegyik jelmondata kell. Üresen nincs mező.
   */
  partnerCo?: PartnerLock[];
  /**
   * A levett megbízottak nyoma: azonosság és időpont. Csak a levétel
   * próbatételéből születik, aminek a végén az ő jelmondata állt — élő
   * megbízottat csak ez visz el. Üresen nincs mező.
   */
  partnersGone?: PartnerGone[];
  /**
   * A LISTA REJTÉSE: fiók-szintű beállítás, a JELÉVEL. A bekapcsolás egy
   * koppintás (szigorítás), a kikapcsolás a készülék azonosítása (munka) —
   * és a kifizetett kikapcsolás átmegy: a jel dönt, azonos jelnél a rejtett.
   * Csak igazként utazik; a régi kliens (mező nélkül) semleges.
   */
  hideSiteList?: boolean;
  hideSiteListRev?: number;
  /**
   * KULCSSZÓ-SZABÁLYOK: a lista, és KULCSSZAVANKÉNT a jelük (`keywordMarks`:
   * kulcsszó → a blob rev-je, amelyik utoljára felvette vagy levette). A
   * fésülés kulcsszavanként megy — a nagyobb jel dönt, egyenlőnél az unió;
   * lásd `mergeKeywordSets`. A lista egészének jele (`keywordsRev`) csak a
   * régi klienseknek utazik: ők még azzal fésülnek. Üresen nincs mező.
   */
  keywords?: string[];
  keywordsRev?: number;
  keywordMarks?: KeywordMarks;
  rev: number;
  updatedAt: number;
  updatedBy: string;
}

/**
 * Ennél több csomag-jelet nem hordunk; a törölt csomagok legrégebbi jelei
 * esnek ki. A plafon SZÁNDÉKOSAN magas: egy eldobott sírkő feltámaszthatja a
 * csomagot a másik eszközön, tehát a vágás nem lehet mindennapos — 256 jel
 * több mint kétszáz valaha törölt csomagot jelent, a lista maga 30-as.
 */
export const MAX_PACK_MARKS = 256;

/**
 * A jelek plafonja — EGY szabály mindenhol (fésülés, bemenet, léptetés, a
 * három nyelvben): a jelen lévő csomagok jele mindig marad, a törölt
 * csomagokéból a legnagyobb jelűek férnek be, holtversenyben az azonosító
 * szerint. Üresen nincs mező. Ha négy helyen négyféle plafon vágna, 64
 * fölött a gép, a telefon és a kiszolgáló három különböző listát tartana,
 * és minden körben feltöltenének — nem hibás adat, hanem nem konvergáló
 * szinkron. A `capHostnameMarks` párja.
 */
export function capPackMarks(
  marks: Record<string, number>, presentIds: string[],
): Record<string, number> | undefined {
  const entries = Object.entries(marks);
  if (entries.length === 0) return undefined;
  if (entries.length <= MAX_PACK_MARKS) return marks;
  const present = new Set(presentIds);
  const out: Record<string, number> = {};
  for (const [id, v] of entries) if (present.has(id)) out[id] = v;
  const gone = entries.filter(([id]) => !present.has(id))
    .sort((x, y) => (y[1] - x[1]) || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  for (const [id, v] of gone) {
    if (Object.keys(out).length >= MAX_PACK_MARKS) break;
    out[id] = v;
  }
  return out;
}

/**
 * A csomag-jelek kiegyenesítése: csak azonosító → pozitív egész, legfeljebb a
 * blob `rev`-je (a jel annak a blobnak a rev-je, amelyik írta — nagyobb nem
 * lehet, és a fésülés erre épít), a plafonnal (a jelen lévő csomagok jele
 * marad). Üresen nincs mező.
 */
export function cleanPackMarks(
  raw: unknown, presentIds: string[] = [], maxRev = Number.MAX_SAFE_INTEGER,
): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > maxRev) continue;
    out[k] = v;
  }
  return capPackMarks(out, presentIds);
}

/**
 * A saját jelek kiegyenesítése: azonosító → nemnegatív egész, KISEBB, mint a
 * csomag (már kiegyenesített) közös jele. Ami nem kisebb, az nem hordoz hírt
 * (a saját jel alapból a közös), és közös jel nélkül saját jel sincs — így a
 * jelek plafonja ezt is vágja. Üresen nincs mező.
 */
export function cleanOwnMarks(
  raw: unknown, marks: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !marks) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const m: unknown = Object.prototype.hasOwnProperty.call(marks, k) ? marks[k] : undefined;
    if (typeof m !== 'number' || typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= m) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function emptyFocus(deviceId: string): SyncFocus {
  return { packs: [], run: null, log: [], rev: 0, updatedAt: 0, updatedBy: deviceId };
}

/**
 * Egy kívülről jött munkamenet-blob használható alakja.
 *
 * Kívülről jött adat: a szinkronon át érkező JSON ugyanolyan megbízhatatlan,
 * mint bármi más. Ami nem értelmezhető, az kiesik — de a blob EGÉSZE nem
 * hasalhat el egyetlen rossz csomagtól, mert akkor egy elrontott sor a futó
 * munkamenetet is eltüntetné.
 */
/**
 * @param now ha meg van adva, a LEJÁRT zárlat nem kerül be — a szinkron
 *   határán ez a helyes: a lejárt zárlat nem tilt semmit, a hordozása viszont
 *   minden körben hamis változást mutatna (lásd `liveLockdown`).
 */
export function normalizeSyncFocus(raw: unknown, fallbackDevice: string, now?: number): SyncFocus {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<SyncFocus>;
  const packs: FocusPack[] = [];
  const seenIds: string[] = [];
  for (const p of Array.isArray(o.packs) ? o.packs : []) {
    const n = normalizePack(p);
    if (n && !packs.some((x) => x.id === n.id) && packs.length < MAX_PACKS) packs.push(n);
    const rawId = p && typeof p === 'object' ? (p as { id?: unknown }).id : undefined;
    if (typeof rawId === 'string' && rawId) seenIds.push(rawId);
  }
  // A KIESETT csomag jele is kiesik. Ami a listán volt, de itt nem
  // értelmezhető (vagy a plafon fölött van), az nem törölt csomag: a jele
  // meg a hiánya együtt sírkőnek látszana a fésülésben, és a csomag
  // MINDENHOL törlődne — a gazdája is elveszítené. A valódi törlés jele
  // (nincs ilyen csomag a listán) megmarad.
  // A rev nemnegatív EGÉSZ: egy tört rev-ből a hatásos jel tört jelet írna,
  // amit a visszaolvasás eldob — és a kör sosem érne össze. A Kotlin és a
  // Swift ugyanígy csonkol.
  const rev = Math.max(0, Math.floor(numberOr(o.rev, 0)));
  const rawMarks = cleanPackMarks(o.packMarks, packs.map((p) => p.id), rev);
  const kept = rawMarks && Object.fromEntries(
    Object.entries(rawMarks).filter(([id]) => !seenIds.includes(id) || packs.some((p) => p.id === id)),
  );
  const packMarks = kept && Object.keys(kept).length > 0 ? kept : undefined;
  // A kifizetett ablak-lazítások ugyanígy: pozitív egész, legfeljebb a blob
  // rev-je (csak léptetés után írható), a plafonnal; a kiesett csomagé kiesik.
  const rawLoosens = cleanPackMarks(o.packLoosens, packs.map((p) => p.id), rev);
  const keptLoosens = rawLoosens && Object.fromEntries(
    Object.entries(rawLoosens).filter(([id]) => !seenIds.includes(id) || packs.some((p) => p.id === id)),
  );
  const packLoosens = keptLoosens && Object.keys(keptLoosens).length > 0 ? keptLoosens : undefined;
  // A saját jel a megmaradt közös jelekhez igazodik: kisebb nála, nemnegatív.
  const packOwnMarks = cleanOwnMarks(o.packOwnMarks, packMarks);
  return {
    packs,
    run: normalizeRun(o.run, packs),
    // A naplót NEM kötjük a csomagokhoz: egy menet naplósora akkor is igaz
    // marad, ha a csomagot azóta törölték. Épp ezért van benne a NÉV is, nem
    // csak az azonosító.
    log: normalizeLog(o.log),
    ...(packMarks ? { packMarks } : {}),
    ...(packLoosens ? { packLoosens } : {}),
    ...(packOwnMarks ? { packOwnMarks } : {}),
    // A zárlat kívülről jött adat, mint minden más: ami nem értelmes, az nincs
    // — és `now` mellett a lejárt sem.
    ...(lockdownIn(o.lockdown, now) ? { lockdown: lockdownIn(o.lockdown, now)! } : {}),
    // Az ablakok is kívülről jött adat: csak az érvényes, egyszer, a plafonig.
    // A jel pozitív egész, legfeljebb a blob `rev`-je — mint a csomag-jelek.
    ...(windowsIn(o.lockdownWindows).length > 0
      ? { lockdownWindows: windowsIn(o.lockdownWindows) } : {}),
    ...(markIn(o.lockdownWindowsRev, rev) ? { lockdownWindowsRev: markIn(o.lockdownWindowsRev, rev) } : {}),
    // Az ablak-jelek is: kanonikus tartalmi kulcs, pozitív egész, legfeljebb a rev.
    ...windowMarksIn(o.lockdownWindowMarks, windowsIn(o.lockdownWindows), rev),
    // A megbízott is kívülről jött adat: csak a jó alakú, a jele mint a többié.
    // A társak és a nyomok is: a fésülés tisztítja őket (egyszer, rendezve,
    // a plafonig, a fő nélkül) — ugyanaz a szabály, mint a fogadáskor.
    ...partnersIn(o),
    ...(markIn(o.partnerRev, rev) ? { partnerRev: markIn(o.partnerRev, rev) } : {}),
    ...(o.hideSiteList === true ? { hideSiteList: true } : {}),
    ...(markIn(o.hideSiteListRev, rev) ? { hideSiteListRev: markIn(o.hideSiteListRev, rev) } : {}),
    // A kulcsszavak is kívülről jött adat: csak az érvényes, egyszer, a plafonig.
    ...(cleanKeywords(o.keywords).length > 0 ? { keywords: cleanKeywords(o.keywords) } : {}),
    ...(markIn(o.keywordsRev, rev) ? { keywordsRev: markIn(o.keywordsRev, rev) } : {}),
    // A kulcsszó-jelek is: kanonikus kulcsszó, pozitív egész, legfeljebb a rev.
    ...keywordMarksIn(o.keywordMarks, cleanKeywords(o.keywords), rev),
    rev,
    updatedAt: numberOr(o.updatedAt, 0),
    updatedBy: typeof o.updatedBy === 'string' && o.updatedBy ? o.updatedBy : fallbackDevice,
  };
}

/**
 * A futó munkamenet megtisztítása.
 *
 * Ha a csomagja nincs meg, a futás ÉRTELMEZHETETLEN: nem tudnánk megmondani,
 * mi mehet alatta. Ilyenkor nem tippelünk — a fehérlista tartalma nem az a
 * dolog, amit kitalálni szabad —, hanem eldobjuk a futást.
 */
function normalizeRun(raw: unknown, packs: FocusPack[]): FocusRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<FocusRun>;
  if (typeof r.packId !== 'string' || !packs.some((p) => p.id === r.packId)) return null;
  const startedAt = numberOr(r.startedAt, 0);
  const endsAt = numberOr(r.endsAt, 0);
  if (endsAt <= 0) return null;
  const cuts = cleanCuts(r.cuts);
  const origin = cleanOrigin(r.origin, startedAt);
  return {
    packId: r.packId, startedAt, endsAt,
    ...(cuts !== undefined ? { cuts } : {}),
    ...(origin !== undefined ? { origin } : {}),
  };
}

/**
 * Kívülről jött naplósorok használható alakja.
 *
 * Ami nem értelmezhető, az kiesik — egyesével, nem az egész napló. Egy rossz
 * sor miatt elveszíteni a többit ugyanaz a hiba lenne, mint egy rossz csomag
 * miatt eldobni a futó menetet.
 */
function normalizeLog(raw: unknown): FocusLogEntry[] {
  const out: FocusLogEntry[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const e = normalizeLogEntry(item);
    if (e) out.push(e);
  }
  return capLog(out);
}

export function normalizeLogEntry(raw: unknown): FocusLogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Partial<FocusLogEntry>;
  if (typeof e.packId !== 'string' || !e.packId) return null;
  const endedAt = numberOr(e.endedAt, 0);
  if (endedAt <= 0) return null;
  const startedAt = numberOr(e.startedAt, 0);
  const cuts = cleanCuts(e.cuts);
  const origin = cleanOrigin(e.origin, startedAt);
  return {
    packId: e.packId,
    packName: logPackName(e.packName),
    startedAt,
    endedAt,
    plannedEndsAt: numberOr(e.plannedEndsAt, endedAt),
    stopped: e.stopped === true,
    // Az ablak jele csak ha igaz — a régi sor mezője nincs, és az nem ablak.
    ...(e.window === true ? { window: true } : {}),
    ...(cuts !== undefined ? { cuts } : {}),
    ...(origin !== undefined ? { origin } : {}),
  };
}

/**
 * Két napló egyesítése.
 *
 * A sor AZONOSSÁGA a csomag és a menet EREDETI kezdése (`runOrigin`: az
 * óra-ugrás eltolhatja a kezdést, a menet attól ugyanaz). Egyszerre egy menet
 * fut az egész fiókban, tehát ez a pár egyértelmű — és pont ezért fésülődik
 * össze helyesen az a gyakori eset, amikor UGYANAZT a menetet két eszköz is
 * lezárja: a telefon próbatétellel, a gép meg később, a szinkronból véve
 * észre.
 *
 * Ütközésnél a TÖBBET TUDÓ sor marad (`better`): aki több rövidítést, majd
 * hosszabb tervet ismert. Azonos tudásnál a KORÁBBI vég, mert az van közelebb
 * a valósághoz: a menet akkor ért véget, amikor véget ért, nem akkor, amikor
 * a másik eszköz észbe kapott. Azonos végnél a próbatételes leállítás nyer —
 * azt az egyik oldal láthatta, a másik nem.
 */
export function mergeLog(a: FocusLogEntry[], b: FocusLogEntry[]): FocusLogEntry[] {
  const byKey = new Map<string, FocusLogEntry>();
  for (const e of [...a, ...b]) {
    const key = `${e.packId}|${runOrigin(e)}`;
    const prev = byKey.get(key);
    byKey.set(key, prev ? better(prev, e) : e);
  }
  return capLog([...byKey.values()]);
}

/**
 * Két változat UGYANARRÓL a menetről — melyik marad.
 *
 * TELJES rendezés kell, nem „elég jó”: ha a végén marad döntetlen, a válasz a
 * hívás sorrendjétől függ, az pedig a két eszközön szükségszerűen más. Onnantól
 * ugyanazt a menetet másképp sorosítják, a `sameFocus` örökre „különbözőt”
 * mond, és minden körben feltöltenek — nem hibás adat, hanem NEM KONVERGÁLÓ
 * szinkron.
 *
 * ELŐBB A TUDÁS, aztán a vég. A sor a menet sírköve is (`mergeRun`), és a
 * tudása dönti el, melyik változatot zárja le — tehát a többet tudó sor marad:
 *
 *   1. a TÖBB rövidítést ismerő: aki a kifizetett rövidítés utáni változatot
 *      zárta le, az tudott a régebbiről is;
 *   2. a HOSSZABB tervet ismerő: az egyik eszköz még a hosszabbítás előtti
 *      tervet ismerte, a másik már a hosszabbítottat — és a menet a
 *      hosszabbítással tovább is futott (a régi terv sírköve nem zárja le);
 *   3. azonos tudásnál a KORÁBBI vég, aztán a próbatételes leállítás;
 *   4. a maradék csak a teljes rendezésért: a korábbi (eltolatlan) kezdés, az
 *      ablak jele, végül a csomag neve kódegységenként.
 *
 * A terv HOSSZA számít, nem a vége: az óra-ugrás elnyelése a kezdést és a
 * véget együtt tolja — attól a tudás nem lesz több.
 */
function better(x: FocusLogEntry, y: FocusLogEntry): FocusLogEntry {
  const cx = x.cuts ?? 0;
  const cy = y.cuts ?? 0;
  if (cx !== cy) return cx > cy ? x : y;
  const px = x.plannedEndsAt - x.startedAt;
  const py = y.plannedEndsAt - y.startedAt;
  if (px !== py) return px > py ? x : y;
  if (x.endedAt !== y.endedAt) return x.endedAt < y.endedAt ? x : y;
  if (x.stopped !== y.stopped) return x.stopped ? x : y;
  if (x.startedAt !== y.startedAt) return x.startedAt < y.startedAt ? x : y;
  if ((x.window === true) !== (y.window === true)) return x.window === true ? x : y;
  if (x.packName !== y.packName) return x.packName < y.packName ? x : y;
  return x;
}

/**
 * Idősorrend, és a LEGÚJABBAK maradnak.
 *
 * A statisztika a mai napot és a hetet nézi; ha valamit el kell dobni, az a
 * legrégebbi sor. Fordítva a mai menetek esnének ki, és a képernyő, amit a
 * felhasználó néz, pont az lenne üres.
 */
function capLog(rows: FocusLogEntry[]): FocusLogEntry[] {
  return rows
    // A `startedAt` a HARMADIK kulcs, és nem díszítés: ettől lesz a rendezés
    // TELJES. Enélkül két azonos időben végződő, azonos csomagú sor sorrendje a
    // bemenet sorrendjétől függne — az meg a két eszközön más, és a szinkron
    // sosem konvergálna. A NEGYEDIK az azonosság maradéka: az eltolt menet
    // sora a kezdésében egyezhet egy másikéval, az eredetiében nem.
    .sort((p, q) => (p.endedAt - q.endedAt)
      || (p.packId < q.packId ? -1 : p.packId > q.packId ? 1 : 0)
      || (p.startedAt - q.startedAt)
      || (runOrigin(p) - runOrigin(q)))
    .slice(-MAX_FOCUS_LOG);
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Két munkamenet-állapot összefésülése.
 *
 * A csomagok és a futás KÜLÖN dőlnek el, mert más a szabályuk:
 *
 *   - a csomagoknál az utolsó író nyer (ez beállítás, nem tiltás — egy régi
 *     lista visszatérése bosszantó, de nem kibúvó);
 *   - a futásnál a SZIGORÚBB nyer, és lazítani csak a nyomával lehet: a
 *     rövidítés számlálójával, a leállítás naplósorával (`mergeRun`).
 *
 * A `now` a jövőbeli naplósorokhoz kell: ami a jövőben ért véget, az nem
 * zár le menetet. Nélküle minden sor múltbeli.
 */
export function mergeFocus(local: SyncFocus, incoming: SyncFocus, now?: number): SyncFocus {
  const newer = pickNewer(local, incoming);
  const older = newer === local ? incoming : local;
  // EGYESÍTÉS, nem választás: lásd a `SyncFocus.log` magyarázatát. ELŐBB a
  // napló: a menet sorsát ez dönti el (a leállítás nyoma a naplósor).
  const log = mergeLog(local.log, incoming.log);
  const { run, carriers } = mergeRun(local, incoming, log, now);
  const { packs, packMarks, packLoosens, packOwnMarks } = mergePacks(newer, older, run?.packId, carriers);
  return {
    packs,
    run,
    log,
    ...(packMarks ? { packMarks } : {}),
    ...(packLoosens ? { packLoosens } : {}),
    ...(packOwnMarks ? { packOwnMarks } : {}),
    // MAGASVÍZJEL, nem döntés: a későbbi vég nyer, `rev`-re való tekintet
    // nélkül. Egy hálózat nélkül maradt eszköz így nem tud feloldani semmit
    // azzal, hogy a régi állapotát tolja fel.
    ...(mergeLockdown(local.lockdown, incoming.lockdown)
      ? { lockdown: mergeLockdown(local.lockdown, incoming.lockdown)! } : {}),
    // A JEL DÖNT, nem az újabb blob — TARTALMANKÉNT: egy ablak jele csak
    // akkor változik, ha ő maga változik, tehát egy elavult eszköz ingyenes
    // felvétele nem töröl, a kifizetett levételt pedig a jele viszi át.
    // Egyenlő jelnél az unió: a szigorúbb irány (`mergeWindowSets`).
    ...windowsMerged(local, incoming),
    // A megbízott AZONOSSÁG szerint: élő megbízottat csak a nyoma visz el.
    ...partnerMerged(local, incoming),
    // A rejtés: a jel dönt, azonos jelnél a rejtett — a szigorúbb irány.
    ...hideMerged(local, incoming),
    // A kulcsszavak kulcsszavanként, a jelük szerint (`mergeKeywordSets`).
    ...keywordsMerged(local, incoming),
    rev: Math.max(local.rev, incoming.rev),
    // Az idő a GYŐZTESÉ, nem a nagyobb: így az eredmény kulcsa (rev, idő,
    // eszköz) pontosan az újabb blobé, és három eszköz bármilyen sorrendben
    // ugyanoda jut a jel nélküli csomagokkal is. A nagyobb idő egy olyan
    // blobot állítana elő, ami egyik eszközön sem létezett, és a harmadik
    // eszközzel szemben másképp dőlne el, mint a részei.
    updatedAt: newer.updatedAt,
    // Az eszközazonosító a győztesé: enélkül a döntetlen-eltörés nem lenne
    // stabil, és a két eszköz felváltva írná felül egymást. A bemenet
    // tisztítása garantálja, hogy nem üres — a tükrök is pontosan ezt teszik.
    updatedBy: newer.updatedBy,
  };
}

/**
 * A csomagok CSOMAGONKÉNT fésülődnek.
 *
 * A csomag jele a blob `rev`-je, amelyik utoljára felvette, szerkesztette
 * vagy törölte. Csomagonként a NAGYOBB jel dönt — ami annál áll (ez a
 * változat, vagy nincs), az marad. Egyenlő jelnél (a jel nélküli csomag is
 * ilyen: régi kliens) az újabb blob állapota, ahogy eddig. A sorrend az
 * újabb blobé, a csak a régebbin élő csomagok a végére.
 *
 * Miért kell. A csomaglista egy blobban utazik, és a blob `rev`-jét a
 * telefon egy menet indításával is lépteti. Ha a gépen most vettél fel egy
 * ablakot, és a telefon ugyanabban a körben — a régi listával — elindított
 * egy menetet, azonos rev és frissebb idő mellett a telefon listája nyert,
 * és az ablak csendben eltűnt. A jel a CSOMAGHOZ tartozik, nem a blobhoz.
 * A telefonok jelet csak a saját csomag-szerkesztésüknél írnak (ablak a
 * csúcs-órára), egyébként hordozzák és fésülik. A Kotlin- és Swift-tükör
 * ugyanezt teszi.
 *
 * AZ ABLAKOS CSOMAG más: az ablak és a fehérlista TILT (a menet magától
 * indul), a jelet pedig egy ingyenes szerkesztés is lépteti — egy elavult
 * eszköz egy átnevezéssel egészében visszahozta volna a régi változatot, és
 * egy máshol ingyen felvett ablak vagy szűkített fehérlista próbatétel
 * nélkül eltűnt volna. Ezért előbb az OSZTÁLY dönt, egészében:
 *
 *   1. a KIFIZETETT ablak-lazítások száma (`packLoosens`, a bíró írja a
 *      próbatétel teljesítésekor): a több nyer — a változat vagy a törlése;
 *   2. egyenlő számnál az ABLAKOS változat nyer: ablakot felvenni ingyen van,
 *      levenni csak próbatétellel (az pedig az 1. pont) — egy azonos számú,
 *      ablak nélküli változat tehát vagy régebbi, vagy egy olyan eszköz
 *      szerkesztése, ami az ablakról nem tudott. Az ő átnevezése elvész:
 *      kimondott korlát.
 *
 * Az osztályon belül két ablakos változat MEZŐNKÉNT a szigorúbb
 * (`stricterPack`), két ablak nélküli a jel szerint, ahogy eddig.
 *
 * A SAJÁT JEL (`packOwnMarks`). A közös jel (`packMarks`) a nagyobb marad —
 * a régi kliens csak ezt látja, és a helyi szerkesztés ehhez képest lép. De
 * ha az osztály döntött, a vesztes nagyobb jele a győztesre ragadna, és egy
 * harmadik eszköz azonos osztályú változatával szemben a SORRENDTŐL függne,
 * melyik nyer: amelyik a vesztessel előbb találkozott, az örökölte a nagy
 * jelet. Ezért az osztályon belül a győztes osztály SAJÁT legnagyobb jele
 * dönt — a mezőben csak ott áll, ahol kisebb a közös jelnél (a helyi
 * szerkesztés törli: annál a saját jel maga a közös). A Kotlin- és
 * Swift-tükör ugyanezt teszi.
 */
function mergePacks(
  newer: SyncFocus, older: SyncFocus, runPackId?: string, carriers: SyncFocus[] = [],
): {
  packs: FocusPack[]; packMarks: Record<string, number> | undefined;
  packLoosens: Record<string, number> | undefined; packOwnMarks: Record<string, number> | undefined;
} {
  const en = newer.packMarks ?? {};
  const eo = older.packMarks ?? {};
  const ln = newer.packLoosens ?? {};
  const lo = older.packLoosens ?? {};
  const sn = newer.packOwnMarks ?? {};
  const so = older.packOwnMarks ?? {};
  // A MENET CSOMAGJA ELÖL: a 30-as plafon vágásából sem eshet ki — csomag
  // nélküli menet a vágásból sem születhet.
  const ids = [
    ...(runPackId ? [runPackId] : []),
    ...newer.packs.map((p) => p.id),
    ...older.packs.map((p) => p.id),
    ...Object.keys(en), ...Object.keys(eo), ...Object.keys(ln), ...Object.keys(lo),
  ].filter((id, i, all) => all.indexOf(id) === i);
  const chosen: { pack: FocusPack; marked: boolean }[] = [];
  const marks: Record<string, number> = {};
  const loosens: Record<string, number> = {};
  const owns: Record<string, number> = {};
  for (const id of ids) {
    const mn = en[id] ?? 0;
    const mo = eo[id] ?? 0;
    const cn = ln[id] ?? 0;
    const co = lo[id] ?? 0;
    // A saját jel alapból a közös: csak ott van külön szám, ahol kisebb.
    const tn = sn[id] ?? mn;
    const to = so[id] ?? mo;
    const pn = newer.packs.find((p) => p.id === id);
    const po = older.packs.find((p) => p.id === id);
    const wn = pn?.recurrence ? 1 : 0;
    const wo = po?.recurrence ? 1 : 0;
    let pick: FocusPack | undefined;
    let own: number;
    if (cn !== co || wn !== wo) {
      // AZ OSZTÁLY dönt, egészében — a változat a saját jelével megy tovább.
      const newerWins = cn !== co ? cn > co : wn > wo;
      pick = newerWins ? pn : po;
      own = newerWins ? tn : to;
    } else if (pn && po && wn === 1) {
      pick = stricterPack(pn, po, tn, to);
      own = Math.max(tn, to);
    } else {
      // Ablak nélkül a saját jel dönt. Egyenlő POZITÍV jelnél (vagy kifizetett
      // lazítás után) a jelenlét nyer, két változat közül a `preferPack` — ami
      // a két változatból jön, nem a hordozó blobból; jel nélkül, az alsó
      // osztályban, az újabb blob, ahogy eddig.
      own = Math.max(tn, to);
      if (tn !== to) pick = tn > to ? pn : po;
      else if (tn > 0 || cn > 0) pick = pn && po ? preferPack(pn, po) : pn ?? po;
      else pick = pn;
    }
    if (id === runPackId) pick = runPack(id, pick, carriers, pn, po);
    const m = Math.max(mn, mo);
    const c = Math.max(cn, co);
    if (pick) chosen.push({ pack: pick, marked: id === runPackId || m > 0 || c > 0 });
    if (m > 0) marks[id] = m;
    if (c > 0) loosens[id] = c;
    if (own < m) owns[id] = own;
  }
  const packs = capPacks(chosen);
  // Ugyanaz a plafon, mint a bemeneten és a léptetésnél — különben a három
  // hely három listát tartana, és sosem érnének össze. A saját jel a vágott
  // jelekhez igazodik: kiesett jel mellett nincs mihez kisebbnek lennie.
  const presentIds = packs.map((p) => p.id);
  const packMarks = capPackMarks(marks, presentIds);
  return {
    packs, packMarks, packLoosens: capPackMarks(loosens, presentIds), packOwnMarks: cleanOwnMarks(owns, packMarks),
  };
}

/**
 * Két ABLAKOS változat, azonos kifizetett-számmal: a SZIGORÚBB, mezőnként.
 * Ezen a szinten a helyi szabály is csak szigorít: az ablak ingyen csak
 * bővülhet, a fehérlista csak szűkülhet (`saveFocusPack`), a törléshez előbb
 * az ablakot kell levenni. Az ablak tehát a hosszabb (több heti perc,
 * holtversenyben a kulcs), a fehérlista a metszet, a név és a hossz a
 * nagyobb SAJÁT jelű változaté (azok nem nyitnak semmit), egyenlő jelnél a
 * kettő kódegység-sorrendje — csak a saját mezőiktől függ, így három
 * eszköznél sem számít a sorrend. Az eredmény lehet olyan változat, ami egyik
 * eszközön sem létezett — szándékosan: mindkettőnél szigorúbb. A Kotlin- és
 * Swift-tükör ugyanezt teszi.
 */
function stricterPack(pn: FocusPack, po: FocusPack, tn: number, to: number): FocusPack {
  const named = tn !== to ? (tn > to ? pn : po) : (nameKey(pn) <= nameKey(po) ? pn : po);
  return {
    ...named,
    allowSites: meetAllow(pn.allowSites, po.allowSites),
    allowApps: meetAllow(pn.allowApps, po.allowApps),
    recurrence: longerBand(pn.recurrence!, po.recurrence!),
  };
}

/** A név és a hossz sorrendje a döntetlenhez — bájtra ugyanez a három nyelvben. */
function nameKey(p: FocusPack): string {
  return `${p.name}\u0001${p.defaultMinutes}`;
}

/**
 * Két fehérlista szigorúbbja: a METSZET, rendezve (a sorrend nem jelentés, a
 * három nyelv így bájtra ugyanazt adja). Ha mindkettő engedett valamit, de
 * közös elemük nincs, a rövidebb (holtversenyben a rendezett kulcs) — üres
 * fehérlista mindent tiltana a menet alatt, amit senki nem kért. A
 * csatorna-szűrők szabálya; három eszköznél ez az ág sorrendfüggő lehet (a
 * flotta akkor is összeér: az eredmény mindig a rövidebb-vagy-egyenlő).
 */
function meetAllow(a: string[], b: string[]): string[] {
  const common = a.filter((x) => b.includes(x)).sort();
  if (common.length > 0 || a.length === 0 || b.length === 0) return common;
  const sa = [...a].sort();
  const sb = [...b].sort();
  if (sa.length !== sb.length) return sa.length < sb.length ? sa : sb;
  return sa.join('\u0001') <= sb.join('\u0001') ? sa : sb;
}

/** Két heti ablak szigorúbbja: a hosszabb (heti percben), holtversenyben a kulcs. */
function longerBand(a: Band, b: Band): Band {
  const wa = a.days.length * bandMinutes(a);
  const wb = b.days.length * bandMinutes(b);
  if (wa !== wb) return wa > wb ? a : b;
  return bandKey(a) <= bandKey(b) ? a : b;
}

function bandKey(b: Band): string {
  return `${[...b.days].sort((x, y) => x - y).join(',')}/${b.startMin}/${b.endMin}`;
}

/**
 * A csomagok plafonja (30): ha a két lista együtt több, a JELES csomag marad
 * (és a menet csomagja), a jel nélküli esik ki előbb — egy frissen felvett,
 * jeles ablak nem tűnhet el egy régi, jeltelen csomag mögött. A sorrend a
 * fésülésé marad.
 */
function capPacks(chosen: { pack: FocusPack; marked: boolean }[]): FocusPack[] {
  if (chosen.length <= MAX_PACKS) return chosen.map((c) => c.pack);
  const keep = new Set<FocusPack>();
  for (const c of chosen) if (c.marked && keep.size < MAX_PACKS) keep.add(c.pack);
  for (const c of chosen) if (!c.marked && keep.size < MAX_PACKS) keep.add(c.pack);
  return chosen.filter((c) => keep.has(c.pack)).map((c) => c.pack);
}

/**
 * A FUTÓ MENET CSOMAGJA: mindig marad, és a fehérlistája nem bővülhet.
 *
 * A menet és a csomagja együtt jár. Eddig ezt a menetes blob `rev`-je
 * védte (a csomag hatásos jele legalább ennyi volt) — csakhogy a menetről már
 * nem a `rev` dönt (`mergeRun`), a `rev`-et pedig egy átnevezés is lépteti.
 * Egy hálózaton kívüli eszköz, ami a menetről nem tudott, így két ingyenes
 * lépéssel tüntethette volna el: felhúzott jellel törli a csomagot, és a
 * csomag nélküli menetet minden fogadó eldobja. Vagy bővíti a fehérlistát, és
 * a futó menet alatt megnyílik, amit a menet zár.
 *
 * Ezért a futó menet csomagja:
 *
 *   - MINDIG megmarad — ha a jelek szerint törölni kellene, a menetet hordozó
 *     blob változata áll, a törlés jelével: a törlés így megsemmisül, nem
 *     halasztódik (aki törölni akarja, a menet után újra törli — kimondott ár).
 *     AZ ABLAKA NÉLKÜL: ablakos változattal szemben törlés csak magasabb
 *     osztályból nyerhet, tehát az ablak levétele ki volt fizetve — az nem
 *     veszhet el azért, mert közben máshol futott egy menet;
 *   - a mezői a jelek szerinti győztesé (név, hossz, ablak — a szűkítés és az
 *     ablak felvétele ingyen van, átmegy);
 *   - a fehérlistája viszont csak az, ami a menetet hordozó változat(ok)ban
 *     IS benne van: METSZET. A menet alatt a lista csak szűkülhet.
 *
 * Három eszköznél a változat a sorrendtől függhet (a jelenléte nem) — a
 * doksi kimondja. A Kotlin- és Swift-tükör ugyanezt teszi.
 */
function runPack(
  id: string, pick: FocusPack | undefined, carriers: SyncFocus[], pn?: FocusPack, po?: FocusPack,
): FocusPack | undefined {
  const held = carriers.map((f) => f.packs.find((p) => p.id === id)).filter((p): p is FocusPack => !!p);
  const base = pick ?? withoutWindow(held[0] ?? pn ?? po);
  if (!base || held.length === 0) return base;
  const keeps = (list: (p: FocusPack) => string[]) => (x: string) => held.every((h) => list(h).includes(x));
  return {
    ...base,
    allowSites: base.allowSites.filter(keeps((p) => p.allowSites)),
    allowApps: base.allowApps.filter(keeps((p) => p.allowApps)),
  };
}

/** A változat ablak nélkül (ha volt neki). */
function withoutWindow(p: FocusPack | undefined): FocusPack | undefined {
  if (!p?.recurrence) return p;
  const out: FocusPack = { ...p };
  delete out.recurrence;
  return out;
}

/**
 * Egyenlő jelű két változat közül melyik: az ablakos, aztán a szűkebb lista
 * (kevesebb engedett tétel = szigorúbb), végül a tartalom kulcsa szerint.
 * A döntés a két VÁLTOZATBÓL jön, nem a hordozó blobból — így három eszköz
 * bármilyen sorrendben ugyanazt választja. A Kotlin- és Swift-tükör ugyanezt.
 */
function preferPack(x: FocusPack, y: FocusPack): FocusPack {
  const rx = x.recurrence ? 1 : 0;
  const ry = y.recurrence ? 1 : 0;
  if (rx !== ry) return rx > ry ? x : y;
  const nx = x.allowSites.length + x.allowApps.length;
  const ny = y.allowSites.length + y.allowApps.length;
  if (nx !== ny) return nx < ny ? x : y;
  return packOrderKey(x) <= packOrderKey(y) ? x : y;
}

/** A változat kulcsa a sorrendhez — bájtra ugyanez a három nyelvben. */
function packOrderKey(p: FocusPack): string {
  const rec = p.recurrence
    ? `${[...p.recurrence.days].sort((a, b) => a - b).join(',')}/${p.recurrence.startMin}/${p.recurrence.endMin}`
    : '';
  return [
    p.name, String(p.defaultMinutes),
    [...p.allowSites].sort().join(','), [...p.allowApps].sort().join(','), rec,
  ].join('\u0001');
}

/**
 * Melyik oldal FRISSEBB. Sorrend: `rev`, majd idő, majd eszközazonosító.
 *
 * Az azonosító nem esztétika: ez teszi a döntést determinisztikussá. Enélkül
 * két eszköz ugyanabban a másodpercben írva örökké oda-vissza cserélgetné a
 * listát, és mindkettő azt látná, hogy „a másik elrontja”.
 */
function pickNewer(a: SyncFocus, b: SyncFocus): SyncFocus {
  if (a.rev !== b.rev) return a.rev > b.rev ? a : b;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  if (a.updatedBy !== b.updatedBy) return a.updatedBy > b.updatedBy ? a : b;
  // AZONOS KULCS, más tartalom. Nem elméleti: egy fésülés után minden eszköz
  // a győztes kulcsát veszi át, a tartalma viszont a saját fésülése — két
  // ilyen blob kulcsa egyezik. Ha itt az első argumentum nyerne, a két eszköz
  // egymást választaná győztesnek, és örökké egymást írná felül. A TARTALOM
  // dönt, ugyanazzal a kulccsal mindhárom nyelvben.
  return contentKey(a) <= contentKey(b) ? a : b;
}

/**
 * A blob tartalmának kulcsa a döntetlenhez — bájtra ugyanez a három nyelvben
 * (csak a csomagok, a menet és a jelek; a napló egyesül, nem dönt).
 */
function contentKey(f: SyncFocus): string {
  const packs = [...f.packs]
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map((p) => `${p.id}\u0001${packOrderKey(p)}`)
    .join('\u0002');
  // A rövidítés és az eredeti kezdés csak ha van: a nélkülük lévő menet kulcsa
  // ugyanaz, mint a frissítés előtt — egy vegyes flotta így is ugyanazt
  // választja döntetlenben.
  const run = f.run
    ? `${f.run.packId}/${f.run.startedAt}/${f.run.endsAt}`
      + (f.run.cuts ? `/c${f.run.cuts}` : '') + (f.run.origin !== undefined ? `/o${f.run.origin}` : '')
    : '-';
  const marks = Object.entries(f.packMarks ?? {})
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join(',');
  // A kifizetett ablak-lazítások csak ha vannak: a nélkülük lévő blob kulcsa
  // ugyanaz, mint a frissítés előtt.
  const loosens = Object.entries(f.packLoosens ?? {})
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join(',');
  // A saját jelek is, ugyanígy: csak ha vannak.
  const owns = Object.entries(f.packOwnMarks ?? {})
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join(',');
  return `${packs}\u0003${run}\u0003${marks}` + (loosens ? `\u0003${loosens}` : '')
    + (owns ? `\u0004${owns}` : '');
}

/**
 * A FUTÓ munkamenet összefésülése — a kockázatos fele.
 *
 * NEM a blob `rev`-je dönt. Eddig ez döntött (a nagyobb rev-é volt a döntés,
 * akár a leállítás is), csakhogy a rev-et egy csomag átnevezése, egy
 * kulcsszó felvétele is lépteti — ingyen. Egy független átnézés megmutatta:
 * egy friss telepítés húsz átnevezéssel, vagy egy menet indulásakor
 * hálózaton kívül lévő telefon két átnevezéssel bármelyik futó menetet
 * leállította, próbatétel nélkül.
 *
 * A szabály most a menet AZONOSSÁGÁN áll (csomag + eredeti kezdés,
 * `sameRun`), és azon, amit a változat TUD (rövidítések száma, hossz):
 *
 *   - egy menetet csak a rá hivatkozó NAPLÓSOR zár le (a fésült naplóban; a
 *     leállítás és a lejárat is ír ilyet) — aki sosem látta a menetet, az nem
 *     tud róla sort írni. A sor azt a változatot zárja le, amit ismert
 *     (`endedInLog`): ami nála több rövidítést ismert, vagy annyit, és nem
 *     hosszabb a tervénél. Egy hosszabbítás, amiről a lezáró nem tudott,
 *     túléli — különben egy hálózaton kívül tartott eszköz lejárata ingyen
 *     visszavonná a hosszabbítást;
 *   - a JÖVŐBEN véget ért sor nem számít (`FUTURE_LOG_TOLERANCE_MS`, mint a
 *     `spentIn`-nél): az az óra előreállításának nyoma, nem lezárás;
 *   - két változat UGYANARRÓL a menetről: a több kifizetett rövidítés
 *     (`cuts`) nyer, azonos számnál a hosszabb (a hosszabbítás ingyen van, a
 *     rövidítés nem), azonos hossznál a később végződő — az alvásból ébredt
 *     eszköz eltolt menete, ahogy eddig is;
 *   - két KÜLÖNBÖZŐ élő menet (két eszköz egymásról nem tudva indított): a
 *     szigorúbb — a később végződő, azonos lejáratnál a korábban indult, és
 *     ha az is egyezik, a kisebb csomagazonosítójú.
 *
 * `now` nélkül (régi hívó, teszt) minden naplósor múltbeli. A döntetlen-lánc
 * teljes rendezés, tehát három eszköz bármilyen sorrendben ugyanoda jut.
 */
function mergeRun(
  a: SyncFocus, b: SyncFocus, log: FocusLogEntry[], now?: number,
): { run: FocusRun | null; carriers: SyncFocus[] } {
  const ra = a.run && !endedInLog(log, a.run, now) ? a.run : null;
  const rb = b.run && !endedInLog(log, b.run, now) ? b.run : null;
  if (!ra && !rb) return { run: null, carriers: [] };
  if (!rb) return { run: ra, carriers: [a] };
  if (!ra) return { run: rb, carriers: [b] };
  const win = sameRun(ra, rb) ? newerVariant(ra, rb) : stricterRun(ra, rb);
  // A menetet HORDOZÓ blob(ok): akinél pontosan ez a változat áll — a futó
  // csomag fehérlistája ezekhez képest nem bővülhet (`runPack`).
  const carriers = [a, b].filter((f) => sameVariant(f.run!, win));
  return { run: win, carriers };
}

/** Pontosan ugyanaz-e a két változat: azonosság, vég, rövidítések. */
function sameVariant(x: FocusRun, y: FocusRun): boolean {
  return sameRun(x, y) && x.startedAt === y.startedAt && x.endsAt === y.endsAt
    && (x.cuts ?? 0) === (y.cuts ?? 0);
}

/**
 * Lezárta-e a menetnek EZT a változatát egy naplósor — a sírköve.
 *
 * Csak az a sor számít, amelyik ugyanerről a menetről szól, és nem a jövőben
 * ért véget. Az ilyen sor lezárja a változatot, ha több rövidítést ismert
 * nála, vagy ugyanannyit, és a terve legalább ilyen hosszú volt. A hossz
 * számít, nem a vég: az óra-ugrás elnyelése a kezdést és a véget együtt
 * tolja, és az eltolt menet ugyanaz a menet.
 */
function endedInLog(log: FocusLogEntry[], run: FocusRun, now?: number): boolean {
  const limit = now === undefined ? Number.POSITIVE_INFINITY : now + FUTURE_LOG_TOLERANCE_MS;
  const cuts = run.cuts ?? 0;
  const length = run.endsAt - run.startedAt;
  return log.some((e) => sameRun(e, run) && e.endedAt <= limit
    && (cuts < (e.cuts ?? 0) || length <= e.plannedEndsAt - e.startedAt));
}

/** Két változat ugyanarról a menetről: a több rövidítés, a hosszabb, végül a később végződő. */
function newerVariant(x: FocusRun, y: FocusRun): FocusRun {
  const cx = x.cuts ?? 0;
  const cy = y.cuts ?? 0;
  if (cx !== cy) return cx > cy ? x : y;
  const lx = x.endsAt - x.startedAt;
  const ly = y.endsAt - y.startedAt;
  if (lx !== ly) return lx > ly ? x : y;
  return stricterRun(x, y);
}

/** A szigorúbb menet, teljes rendezéssel — döntetlen nincs. */
function stricterRun(x: FocusRun, y: FocusRun): FocusRun {
  if (x.endsAt !== y.endsAt) return x.endsAt > y.endsAt ? x : y;
  if (x.startedAt !== y.startedAt) return x.startedAt < y.startedAt ? x : y;
  if (x.packId !== y.packId) return x.packId < y.packId ? x : y;
  const ox = runOrigin(x);
  const oy = runOrigin(y);
  if (ox !== oy) return ox < oy ? x : y;
  return (x.cuts ?? 0) >= (y.cuts ?? 0) ? x : y;
}

/** Ugyanaz-e a két állapot (nincs mit feltölteni). */
export function sameFocus(a: SyncFocus, b: SyncFocus): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function stable(f: SyncFocus): unknown {
  return {
    packs: [...f.packs]
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .map((p) => ({
        id: p.id,
        name: p.name,
        allowSites: [...p.allowSites].sort().slice(0, MAX_ALLOW_ENTRIES),
        allowApps: [...p.allowApps].sort().slice(0, MAX_ALLOW_ENTRIES),
        defaultMinutes: p.defaultMinutes,
        // Az ismétlődés is beállítás: ha kimaradna, egy gépen felvett ablak
        // sosem érne fel, mert a kör azt látná, hogy „nincs mit feltölteni”.
        recurrence: p.recurrence
          ? [[...p.recurrence.days].sort(), p.recurrence.startMin, p.recurrence.endMin] : null,
      })),
    run: f.run
      ? {
        packId: f.run.packId, startedAt: f.run.startedAt, endsAt: f.run.endsAt,
        cuts: f.run.cuts ?? 0, origin: runOrigin(f.run),
      }
      : null,
    // A NAPLÓ IS BENNE VAN — enélkül egy telefonon lezárult menet sosem érne
    // fel a kiszolgálóra: a kör azt látná, hogy „nincs mit feltölteni”.
    //
    // Ez NEM ugyanaz, mint a `rev` lenyomata (`revisions.ts`), és a kettőt nem
    // szabad összevonni: ez azt méri, van-e mit FELTÖLTENI, az meg azt, hogy
    // ki DÖNTHET. Egy naplósor az elsőre igen, a másodikra nem.
    // A rövidítésszám és az eredeti kezdés is: a sor sírkő is, és a tudása dönt.
    log: f.log.map((e) => [e.packId, e.startedAt, e.endedAt, e.plannedEndsAt, e.stopped, e.cuts ?? 0, runOrigin(e)]),
    // A jelek is: ha csak ők különböznek (egy régi kliens blobja jel nélkül),
    // akkor is fel kell menniük.
    packMarks: f.packMarks ? Object.entries(f.packMarks).sort() : null,
    // A kifizetett ablak-lazítások is: egy levétel számlálója nélkül a levétel
    // sosem érne át.
    packLoosens: f.packLoosens ? Object.entries(f.packLoosens).sort() : null,
    // A saját jelek is: nélkülük egy osztály-döntés nyoma nem érne fel, és a
    // harmadik eszköz a felfújt közös jellel döntene.
    packOwnMarks: f.packOwnMarks ? Object.entries(f.packOwnMarks).sort() : null,
    // A ZÁRLAT IS: enélkül egy itt indított zárlat sosem érne fel a
    // kiszolgálóra, mert a kör azt látná, hogy nincs mit feltölteni — és a
    // többi eszközön nem történne semmi.
    lockdown: f.lockdown ? [f.lockdown.startedAt, f.lockdown.until] : null,
    // AZ ABLAKOK IS, a jelükkel: enélkül egy itt felvett ablak sosem érne
    // fel a kiszolgálóra. Tartalom szerint, rendezve — az azonosító és a
    // sorrend nem jelentés.
    lockdownWindows: (f.lockdownWindows ?? []).map(windowKey).sort(),
    lockdownWindowsRev: f.lockdownWindowsRev ?? 0,
    // Az ablak-jelek is: egy levétel jele nélkül a levétel sosem érne át.
    lockdownWindowMarks: windowMarksKey(f.lockdownWindowMarks),
    // A MEGBÍZOTT IS, a jelével: enélkül a felvétele sosem érne fel. A társak
    // és a nyomok is — egy levétel nyoma nélkül a levétel sosem érne át.
    partner: f.partner ? partnerKey(f.partner) : null,
    partnerRev: f.partnerRev ?? 0,
    partnerCo: (f.partnerCo ?? []).map(partnerKey),
    partnersGone: (f.partnersGone ?? []).map((g) => `${g.id}@${g.at}`),
    hideSiteList: f.hideSiteList === true,
    hideSiteListRev: f.hideSiteListRev ?? 0,
    // A KULCSSZAVAK IS, a jelükkel — tartalom szerint, rendezve.
    keywords: keywordsKey(f.keywords ?? []),
    keywordsRev: f.keywordsRev ?? 0,
    // A kulcsszó-jelek is: egy levétel jele nélkül a levétel sosem érne át.
    keywordMarks: keywordMarksKey(f.keywordMarks),
    rev: f.rev,
  };
}

/** A beolvasott ablak-lista: csak az érvényes, egyszer, a plafonig. */
function windowsIn(raw: unknown): LockdownWindow[] {
  return normalizeWindows(raw);
}

/** A beolvasott jel: pozitív egész, legfeljebb a blob `rev`-je — vagy semmi. */
function markIn(raw: unknown, maxRev: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0 || raw > maxRev) return undefined;
  return raw;
}

/**
 * A kulcsszavak fésülve — KULCSSZAVANKÉNT, a jelük szerint
 * (`mergeKeywordSets`); a lista egészének jele csak a régi klienseknek
 * utazik tovább, a nagyobbik. Üresen egyik mező sincs.
 */
function keywordsMerged(
  local: SyncFocus, incoming: SyncFocus,
): { keywords?: string[]; keywordsRev?: number; keywordMarks?: KeywordMarks } {
  const { keywords, keywordMarks } = mergeKeywordSets(local, incoming);
  const mark = Math.max(local.keywordsRev ?? 0, incoming.keywordsRev ?? 0);
  return {
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(mark > 0 ? { keywordsRev: mark } : {}),
    ...(keywordMarks ? { keywordMarks } : {}),
  };
}

/** A beolvasott kulcsszó-jelek — üresen nincs mező. */
function keywordMarksIn(raw: unknown, keywords: string[], rev: number): { keywordMarks?: KeywordMarks } {
  const keywordMarks = cleanKeywordMarks(raw, keywords, rev);
  return keywordMarks ? { keywordMarks } : {};
}

/** Az ablakok és a jelük fésülve — üresen egyik mező sincs. */
function windowsMerged(
  local: SyncFocus, incoming: SyncFocus,
): { lockdownWindows?: LockdownWindow[]; lockdownWindowsRev?: number; lockdownWindowMarks?: WindowMarks } {
  // TARTALMANKÉNT, a jelük szerint (`mergeWindowSets`); a lista egészének jele
  // csak a régi klienseknek utazik tovább, a nagyobbik.
  const { lockdownWindows, lockdownWindowMarks } = mergeWindowSets(local, incoming);
  const mark = Math.max(local.lockdownWindowsRev ?? 0, incoming.lockdownWindowsRev ?? 0);
  return {
    ...(lockdownWindows.length > 0 ? { lockdownWindows } : {}),
    ...(mark > 0 ? { lockdownWindowsRev: mark } : {}),
    ...(lockdownWindowMarks ? { lockdownWindowMarks } : {}),
  };
}

/** A beolvasott ablak-jelek — üresen nincs mező. */
function windowMarksIn(raw: unknown, windows: LockdownWindow[], rev: number): { lockdownWindowMarks?: WindowMarks } {
  const lockdownWindowMarks = cleanWindowMarks(raw, windows, rev);
  return lockdownWindowMarks ? { lockdownWindowMarks } : {};
}

/**
 * A megbízottak fésülve — azonosság szerint (`mergePartners`), a jel csak a
 * régi klienseknek utazik tovább, a nagyobbik. Üresen egyik mező sincs.
 */
function partnerMerged(
  local: SyncFocus, incoming: SyncFocus,
): { partner?: PartnerLock; partnerRev?: number; partnerCo?: PartnerLock[]; partnersGone?: PartnerGone[] } {
  const mark = Math.max(local.partnerRev ?? 0, incoming.partnerRev ?? 0);
  return {
    ...mergePartners(local, incoming),
    ...(mark > 0 ? { partnerRev: mark } : {}),
  };
}

/**
 * A beolvasott megbízottak: a fő, a társak és a nyomok — ugyanaz a tisztítás,
 * mint a fésülésé (a nyommal levett nem él, a fő a legkorábban felvett, a
 * társak nélküle). Egy régi kliens blobjában csak a fő van.
 */
function partnersIn(o: { partner?: unknown; partnerCo?: unknown; partnersGone?: unknown }): {
  partner?: PartnerLock; partnerCo?: PartnerLock[]; partnersGone?: PartnerGone[];
} {
  const main = normalizePartnerLock(o.partner);
  return mergePartners({
    ...(main ? { partner: main } : {}),
    partnerCo: cleanPartnerList(o.partnerCo).filter((p) => !main || partnerId(p) !== partnerId(main)),
    partnersGone: cleanPartnersGone(o.partnersGone),
  }, {});
}

/** A rejtés és a jele fésülve — üresen egyik mező sincs. */
function hideMerged(
  local: SyncFocus, incoming: SyncFocus,
): { hideSiteList?: boolean; hideSiteListRev?: number } {
  const ml = local.hideSiteListRev ?? 0;
  const mi = incoming.hideSiteListRev ?? 0;
  const hidden = mergeHide(ml, local.hideSiteList === true, mi, incoming.hideSiteList === true);
  const mark = Math.max(ml, mi);
  return {
    ...(hidden ? { hideSiteList: true } : {}),
    ...(mark > 0 ? { hideSiteListRev: mark } : {}),
  };
}

/**
 * A REJTÉS fésülése: a nagyobb jel nyer (a kikapcsolás munkába került, tehát
 * átmegy); azonos jelnél a rejtett — ha bárhol rejtve van, mindenhol az.
 * Mindkét oldalon jel nélkül (régi kliensek) ugyanez: a rejtett nyer.
 */
export function mergeHide(localRev: number, local: boolean, incomingRev: number, incoming: boolean): boolean {
  if (incomingRev > localRev) return incoming;
  if (localRev > incomingRev) return local;
  return local || incoming;
}

/** A beolvasott zárlat, `now` mellett csak ha még él. */
function lockdownIn(raw: unknown, now: number | undefined): Lockdown | undefined {
  const parsed = parseLockdown(raw);
  if (!parsed) return undefined;
  return now === undefined ? parsed : liveLockdown(parsed, now);
}
