// A szinkron kliensoldala — a SEGÉDBEN fut, nem a felületen.
//
// Miért a segédben: itt van a blokklista igazsága, és itt van az adatkulcs is.
// Ha a felület intézné, akkor minden felhasználói folyamat hozzáférne a
// kulcshoz, és a „nem old fel semmit” ígéretet egy módosított kliens
// kikerülhetné.
//
// A kör mindig ugyanaz:
//
//   1. LEHÚZ a kiszolgálóról (titkosított blob) és visszafejt;
//   2. ÖSSZEFÉSÜL a helyivel (shared/sync/merge.ts) — ez sosem lazít;
//   3. FELTÖLT, ha lett változás, arra a verzióra hivatkozva, amit lehúzott.
//
// Ha közben más eszköz írt, a kiszolgáló elutasítja és visszaadja az aktuálisat:
// akkor újra az 2. lépéstől. Így két eszköz párhuzamos írása sosem tünteti el a
// másikét.

import { normalizeRule, type UrlRule } from '../shared/urlrules';
import type { Band, Schedule } from '../shared/schedule';
import { normalizeHostname } from '../shared/blocklist';
import * as crypto from 'crypto';
import {
  decrypt, encrypt, enroll, recoveryAuthKey, rewrapForNewPassword, subKey, rootKey,
  unlockWithPassword, unlockWithRecovery,
} from '../shared/sync/crypto.js';
import {
  capHostnameMarks, foldedIds, mergeSiteLists, ruleKey, settleIncoming, splitMerged, type SyncSite,
} from '../shared/sync/merge.js';
import { MAX_PAYLOAD_BYTES, SYNC_PROTOCOL } from '../shared/sync/protocol.js';
import type { HelperState, SiteRec, SyncAccount } from './state';
import {
  adoptChannelsRevision, adoptFocusRevision, adoptRevision, bumpRevisions,
} from './revisions';
import {
  emptyFocus, mergeFocus, mergeLog, normalizeSyncFocus, sameFocus, type SyncFocus,
} from '../shared/sync/focus-merge.js';
import { liveLockdown } from '../shared/lockdown';
import { isBurstLoosening, normalizeBurst } from '../shared/burst';
import {
  emptyChannels, mergeChannels, normalizeSyncChannels, sameChannels, type SyncChannels,
} from '../shared/sync/channels-merge.js';
import { makeTodayDigest, parseTodayDigest, type TodayDigest } from '../shared/limits.js';

/** Ennél tovább egy szinkron-kör nem tarthat; a segéd nem állhat meg miatta. */
export const SYNC_TIMEOUT_MS = 15_000;

/**
 * A válasz TÖRZSÉNEK saját ideje.
 *
 * Külön keret, és nem finomkodás: a blob egy megabájt is lehet, ami egy rossz
 * mobilneten simán több mint tizenöt másodperc. Ha a fejléccel OSZTOZNA az
 * időn, egy lassú kapcsolaton minden kör elhasalna — pedig korábban átment,
 * mert a törzsnek egyáltalán nem volt határideje. Az egyik hiba helyett a
 * másikba estünk volna.
 *
 * A lényeg nem a pontos szám, hanem hogy VAN határidő: egy kiszolgáló, ami
 * elkezd válaszolni és nem fejezi be, ne állíthassa meg örökre a kört.
 */
export const SYNC_BODY_TIMEOUT_MS = 60_000;

/** Hányszor próbáljuk újra, ha közben más eszköz írt. */
const MAX_CONFLICT_RETRIES = 3;

export class SyncError extends Error {
  constructor(message: string, readonly code = 'SYNC') { super(message); }
}

// ------------------------------------------------------------------ HTTP

/** A belső hívók rövid neve; a paraméteres alak a `postJson`. */
const call = (serverUrl: string, path: string, body: unknown): Promise<any> =>
  postJson(serverUrl, path, body);

/**
 * Egy JSON-kérés a fiókkiszolgálóra.
 *
 * A két időkeret PARAMÉTER, mert enélkül a „a törzs saját keretet kap”
 * tulajdonságot nem lehetne ellenőrizni: valós tizenöt másodperces határidővel
 * a teszt nem tudná megkülönböztetni a megosztott és a külön keretet, és
 * csendben mindent átengedne. Alapértelmezésben a valódi számok mennek.
 */
export async function postJson(
  serverUrl: string, path: string, body: unknown,
  headMs = SYNC_TIMEOUT_MS, bodyMs = SYNC_BODY_TIMEOUT_MS,
): Promise<any> {
  const url = new URL(path, serverUrl).toString();
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), headMs);
  // Az időkorlát a TÖRZS beolvasására is kiterjed, nem csak a fejlécre.
  //
  // Ez nem elmélet. A `clearTimeout` korábban közvetlenül a `fetch` után állt,
  // tehát egy kiszolgáló, ami fejlécet küld, majd a törzset soha nem fejezi be,
  // ÖRÖKRE megállította volna itt a kört. És a következmény nem egy elmaradt
  // szinkron: az ütemező `running` jelzője csak akkor törlődik, ha a kör
  // BEFEJEZŐDIK, tehát onnantól minden későbbi kör azonnal visszafordult
  // volna. A szinkron a folyamat hátralévő életére halott — hibaüzenet nélkül,
  // befagyott időbélyeggel. Pontosan az a csendes hiba, ami ellen az egész
  // ellenőrző-készlet szól.
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(body as object), protocol: SYNC_PROTOCOL }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new SyncError(`A kiszolgáló nem érhető el: ${(e as Error).message}`, 'OFFLINE');
    }
    // A fejléc megvan: innentől a TÖRZS kap saját keretet. A fejlécre elment
    // idő ne vegye el egy nagy blob letöltésének idejét.
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), bodyMs);
    return await readJson(res, ctrl, bodyMs);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A válasz feldolgozása — külön függvény, hogy a `call` időkorlátja körbeérje.
 *
 * Azért van kivezetve, mert a hibaágai tesztelhetők: a hívó nem tud olyan
 * kiszolgálót indítani, ami fejlécet küld, majd tizenöt másodpercig hallgat,
 * anélkül hogy a tesztkészlet is tizenöt másodperccel lassulna.
 */
export async function readJson(
  res: Response, ctrl: AbortController, bodyMs = SYNC_BODY_TIMEOUT_MS,
): Promise<any> {
  let json: any;
  try {
    json = await res.json();
  } catch {
    // A megszakítás ide is elér, és MÁS a jelentése, mint a hibás címnek: a
    // cím jó volt, a kiszolgáló válaszolt is — csak nem fejezte be.
    if (ctrl.signal.aborted) {
      throw new SyncError(
        `A kiszolgáló elkezdett válaszolni, de ${bodyMs / 1000} másodperc `
        + 'alatt nem fejezte be. Lehet, hogy túlterhelt, vagy nagyon lassú a kapcsolat.',
        'OFFLINE',
      );
    }
    throw new SyncError('A kiszolgáló nem JSON-t küldött — biztos jó a cím?', 'BAD_SERVER');
  }
  // A 409 nem hiba, hanem a protokoll része: „közben más írt”.
  if (!res.ok && res.status !== 409) {
    throw new SyncError(json?.error ?? `Hiba a kiszolgálón (${res.status}).`, json?.code ?? 'SERVER');
  }
  return json;
}

/** A megadott cím ésszerűsége. Csak http/https, hogy ne lehessen fájlt vagy mást megnyitni. */
export function normalizeServerUrl(raw: string): string {
  const text = String(raw ?? '').trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  // Kiírt sémát csak akkor fogadunk el, ha http vagy https. Enélkül egy
  // `file://` cím elé is odabiggyesztenénk a https-t, és a `new URL` még
  // értelmezné is valaminek — a hiba pedig csak jóval később derülne ki.
  if (scheme && !/^https?$/i.test(scheme[1])) {
    throw new SyncError('Csak http vagy https cím adható meg.', 'BAD_URL');
  }
  if (text === '') throw new SyncError('Ez nem tűnik érvényes kiszolgáló-címnek.', 'BAD_URL');
  const withScheme = scheme ? text : `https://${text}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new SyncError('Ez nem tűnik érvényes kiszolgáló-címnek.', 'BAD_URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SyncError('Csak http vagy https cím adható meg.', 'BAD_URL');
  }
  return u.origin;
}

// --------------------------------------------------------------- fiók

function newDeviceId(): string {
  return `dev_${crypto.randomBytes(9).toString('hex')}`;
}

export async function signUp(
  state: HelperState, serverUrl: string, accountId: string, password: string, deviceName: string,
): Promise<{ recoveryCode: string }> {
  const url = normalizeServerUrl(serverUrl);
  const e = enroll(accountId, password);
  await call(url, '/v1/signup', e.serverSide);
  state.sync = {
    serverUrl: url,
    accountId,
    deviceId: newDeviceId(),
    authKey: e.serverSide.authKey,
    dataKey: e.dataKey.toString('base64'),
    deviceName,
  };
  return { recoveryCode: e.recoveryCode };
}

export async function signIn(
  state: HelperState, serverUrl: string, accountId: string, password: string, deviceName: string,
): Promise<void> {
  const url = normalizeServerUrl(serverUrl);
  const authKey = subKey(rootKey(password, accountId), 'auth').toString('base64');
  const deviceId = state.sync?.accountId === accountId ? state.sync.deviceId : newDeviceId();
  const res = await call(url, '/v1/signin', { accountId, authKey, deviceId });
  const dataKey = unlockWithPassword(accountId, password, res.wrappedByPassword);
  state.sync = {
    serverUrl: url, accountId, deviceId, authKey,
    dataKey: dataKey.toString('base64'), deviceName,
  };
}

/**
 * Belépés helyreállító kóddal — elfelejtett jelszó esetén.
 *
 * A kódnak SAJÁT belépőkulcsa van, tehát a fiókba is beenged, nem csak a
 * kulcsburkolatot nyitja. Belépés után rögtön ÚJ JELSZÓT állítunk be: enélkül a
 * fiókba csak a kóddal lehetne visszajutni, és a következő elvesztésnél már
 * semmi nem maradna.
 */
export async function signInWithRecovery(
  state: HelperState, serverUrl: string, accountId: string,
  recoveryCode: string, newPassword: string, deviceName: string,
): Promise<void> {
  const url = normalizeServerUrl(serverUrl);
  const authKey = recoveryAuthKey(recoveryCode);
  const deviceId = state.sync?.accountId === accountId ? state.sync.deviceId : newDeviceId();
  const res = await call(url, '/v1/signin', { accountId, authKey, deviceId });
  const dataKey = unlockWithRecovery(recoveryCode, res.wrappedByRecovery);
  state.sync = {
    serverUrl: url, accountId, deviceId, authKey,
    dataKey: dataKey.toString('base64'), deviceName,
  };
  await changePassword(state, newPassword);
}

/**
 * Kijelentkezés.
 *
 * SEMMIT nem töröl a blokklistából. Ha törölne, a kijelentkezés lenne a világ
 * legegyszerűbb feloldása — pont az ellen szól az egész app.
 */
export function signOut(state: HelperState): void {
  delete state.sync;
}

export async function changePassword(
  state: HelperState, newPassword: string,
): Promise<void> {
  const acc = requireAccount(state);
  const next = rewrapForNewPassword(acc.accountId, Buffer.from(acc.dataKey, 'base64'), newPassword);
  await call(acc.serverUrl, '/v1/rekey', {
    accountId: acc.accountId, authKey: acc.authKey,
    newAuthKey: next.authKey, newWrappedByPassword: next.wrappedByPassword,
  });
  acc.authKey = next.authKey;
}

function requireAccount(state: HelperState): SyncAccount {
  if (!state.sync) throw new SyncError('Nincs bejelentkezve.', 'NO_ACCOUNT');
  return state.sync;
}

// ------------------------------------------------------------ a szinkron

/**
 * Amit a `sites` gyűjteménybe teszünk. Csak a szinkron-mezők; a mérés nem.
 *
 * A SZÜNET szándékosan kimarad: egy próbatétel egy eszközön nem oldhat fel
 * mindenhol. Nem elég az összefésülésre bízni — egy ÚJ eszköznek nincs saját,
 * szigorúbb rekordja, tehát azt venné át, ami jött, szünetestül. Ezért fel se
 * megy.
 */
function toSyncSites(sites: SiteRec[], deviceId: string): SyncSite[] {
  return sites.map((s) => ({
    id: s.id, domain: s.domain, hostnames: s.hostnames, addedAt: s.addedAt,
    ...(s.hostnameMarks ? { hostnameMarks: s.hostnameMarks } : {}),
    pauseUntil: null, pendingDeleteAt: s.pendingDeleteAt,
    schedule: s.schedule, dailyLimitSeconds: s.dailyLimitSeconds, alias: s.alias, reason: s.reason,
    // Az ADAG-SZABÁLY is utazik. A v0.4.227 előtt kimaradt: a telefon
    // szabályát a gép egy ingyenes szerkesztése (nagyobb rev, adag nélkül)
    // mindenhonnan letörölte, a gépen beállított pedig sosem ért át.
    burstSeconds: s.burstSeconds, cooldownSeconds: s.cooldownSeconds,
    rules: s.rules,
    ...(s.rulesRev ? { rulesRev: s.rulesRev } : {}),
    // A szabályok jelei: szabályonként ezekből dől el, melyik eszköz mondta az újabbat.
    ...(s.ruleMarks ? { ruleMarks: s.ruleMarks } : {}),
    // A kifizetett lazítások mezőnként — a fésülés ezekből dönt (merge.ts).
    ...(s.deleteLoosens ? { deleteLoosens: s.deleteLoosens } : {}),
    ...(s.scheduleLoosens ? { scheduleLoosens: s.scheduleLoosens } : {}),
    ...(s.limitLoosens ? { limitLoosens: s.limitLoosens } : {}),
    ...(s.burstLoosens ? { burstLoosens: s.burstLoosens } : {}),
    // A végigment törlés jele: a sírkövön, és a fésülés hozta, itt még nem esedékes rekordon.
    ...(s.goneLoosens ? { goneLoosens: s.goneLoosens } : {}),
    rev: s.rev ?? 1, updatedAt: s.updatedAt ?? s.addedAt, updatedBy: s.updatedBy ?? deviceId,
  })).map((s) => cleanSite(s as unknown as Record<string, unknown>));
}

/**
 * A FEL NEM MENT adag-szabály rátétele a fésülés eredményére — egyszeri
 * átmenet a v0.4.227-re.
 *
 * A régi gép az adag-szabályt nem tette a drótra, a rev-et viszont léptette:
 * a fiókban a rekord adag nélkül állt. Ha azóta egy telefon is írt rá
 * (nagyobb rev, adag nélkül), a fésülés azt adná, és a helyi szabály — amiért
 * senki nem fizetett levételt — eltűnne. Ezért a megjelölt helyi szabály
 * friss SZIGORÍTÁSKÉNT kerül rá a fésült rekordra: mezőnként a szigorúbb (a
 * kisebb adag, a hosszabb szünet), a rev eggyel nagyobb, hogy át is menjen.
 * Amit a fésült rekord már legalább ilyen szigorúan tud, ahhoz nem nyúlunk.
 */
export function reapplyUnsyncedBursts(
  merged: SyncSite[], local: SiteRec[], deviceId: string, now: number,
): SyncSite[] {
  const byId = new Map(local.map((s) => [s.id, s]));
  return merged.map((m) => {
    const l = byId.get(m.id);
    if (!l || l.burstUnsynced !== true) return m;
    const mine = normalizeBurst(l.burstSeconds, l.cooldownSeconds);
    const theirs = normalizeBurst(m.burstSeconds, m.cooldownSeconds);
    if (mine === null || !isBurstLoosening(mine, theirs)) return m;
    const burstSeconds = theirs === null ? mine.burstSeconds : Math.min(mine.burstSeconds, theirs.burstSeconds);
    const cooldownSeconds = theirs === null
      ? mine.cooldownSeconds : Math.max(mine.cooldownSeconds, theirs.cooldownSeconds);
    return { ...m, burstSeconds, cooldownSeconds, rev: m.rev + 1, updatedAt: now, updatedBy: deviceId };
  });
}

/** A fel nem ment adag-szabály jele le: a kör a fiókba vitte (vagy ott már megvolt). */
function clearBurstUnsynced(state: HelperState): void {
  for (const site of state.sites) delete site.burstUnsynced;
}

/**
 * Az összevonás után az azonosító szerint tárolt HELYI állapot az új
 * azonosítóra kerül (`folded`: régi → új, lásd `foldedIds`): az adag-
 * számláló, a mai betelések, a betelések könyve és a próbatétel adóssága.
 * Különben a sor új azonosítója tiszta lappal indulna — egy futó hűtés
 * ingyen leesne, egy feladott próbatétel újrasorsolható lenne. Ha az új
 * azonosítón már áll valami, a szigorúbb marad: a később lejáró hűtés, a
 * több betelés, a frissebb adósság. A szünetet a `fromSyncSites` viszi; a
 * futó próbatételt semmi: a beolvasztott sor más tartalmú lehet, mint amire
 * kérték.
 */
export function carryFolded(state: HelperState, folded: ReadonlyMap<string, string>): void {
  for (const [from, to] of folded) {
    const b = state.bursts?.[from];
    if (b) {
      const cur = state.bursts![to];
      state.bursts![to] = cur
        ? { usedSeconds: Math.max(cur.usedSeconds, b.usedSeconds), lastAt: Math.max(cur.lastAt, b.lastAt),
          cooldownUntil: Math.max(cur.cooldownUntil, b.cooldownUntil) }
        : b;
      delete state.bursts![from];
    }
    const t = state.burstTrips?.[from];
    if (t) {
      const cur = state.burstTrips![to];
      state.burstTrips![to] = !cur || t.day > cur.day ? t
        : t.day === cur.day ? { day: t.day, count: Math.max(t.count, cur.count) } : cur;
      delete state.burstTrips![from];
    }
    const log = state.burstTripLog?.[from];
    if (log) {
      const cur = { ...(state.burstTripLog![to] ?? {}) };
      for (const [day, n] of Object.entries(log)) cur[day] = Math.max(cur[day] ?? 0, n);
      state.burstTripLog![to] = cur;
      delete state.burstTripLog![from];
    }
    if (state.abandons?.some((a) => a.siteId === from)) {
      const theirs = state.abandons.filter((a) => a.siteId === from || a.siteId === to)
        .sort((x, y) => y.at - x.at)[0];
      state.abandons = [...state.abandons.filter((a) => a.siteId !== from && a.siteId !== to), { ...theirs, siteId: to }];
    }
  }
}

/**
 * Vissza a segéd rekordjaiba, a lenyomatot újraszámolva.
 *
 * A szünet a HELYI marad: se fel nem megy, se felül nem íródik. Így aki itt
 * végigcsinálta a próbát, nem veszíti el a feloldását attól, hogy közben
 * szinkronizált — akkor sem, ha a sora közben egy másik azonosítóba olvadt
 * (`folded`: régi → új, lásd `foldedIds`).
 */
function fromSyncSites(merged: SyncSite[], local: SiteRec[], folded: ReadonlyMap<string, string>): SiteRec[] {
  const byId = new Map(local.map((s) => [s.id, s]));
  const foldedFrom = new Map([...folded].map(([from, to]) => [to, from]));
  return merged.map((m) => adoptRevision({
    ...byId.get(m.id),
    id: m.id, domain: m.domain, hostnames: m.hostnames, addedAt: m.addedAt,
    // A jelek az összefésülés eredményéből jönnek — a helyi, régebbi jel nem
    // maradhat meg egy már eldőlt név mellett.
    hostnameMarks: m.hostnameMarks,
    pauseUntil: byId.get(m.id)?.pauseUntil ?? byId.get(foldedFrom.get(m.id) ?? '')?.pauseUntil ?? null,
    pendingDeleteAt: m.pendingDeleteAt,
    schedule: m.schedule, dailyLimitSeconds: m.dailyLimitSeconds, alias: m.alias, reason: m.reason,
    // Az adag-szabály a fésülés eredményéből — a SZÁMLÁLÓ nem a rekordé
    // (`state.bursts`), az eszköz-helyi marad.
    burstSeconds: m.burstSeconds, cooldownSeconds: m.cooldownSeconds,
    rules: m.rules,
    // A szabálylista jele és a szabályok jelei is a fésülés eredményéből jönnek,
    // mint a nevek jelei.
    rulesRev: m.rulesRev,
    ruleMarks: m.ruleMarks,
    // A kifizetett lazítások is: a következő fésülés ezekből dönt.
    deleteLoosens: m.deleteLoosens, scheduleLoosens: m.scheduleLoosens,
    limitLoosens: m.limitLoosens, burstLoosens: m.burstLoosens,
    goneLoosens: m.goneLoosens,
    rev: m.rev, updatedAt: m.updatedAt, updatedBy: m.updatedBy,
  } as SiteRec));
}

/**
 * A távolról érkezett rekordok kiegyenesítése.
 *
 * A HIÁNYZÓ mezőket itt kezeljük, nem az összefésülésben. A `pendingDeleteAt`
 * típusa `number | null`, és a fésülés `!== null`-t néz: ha egy kliens
 * kihagyná a kulcsot (a Swift `JSONEncoder` alapból kihagyja a nileket),
 * `undefined` érkezne, ami NEM null — vagyis minden oldal úgy nézne ki, mintha
 * törlésre várna, és a lista sosem konvergálna. Egy helyen olcsó megvédeni,
 * sok helyen reménytelen.
 *
 * A `pauseUntil` mindig null: a szünet eszközfüggő, és nem is megy fel.
 */
export function normalizeIncomingSites(parsed: unknown): SyncSite[] {
  if (!Array.isArray(parsed)) return [];
  // Nem szórjuk szét a beérkezett objektumot (`...s`), hanem ÚJRAÉPÍTJÜK, fix
  // mezősorrendben. Két okból: az ismeretlen mezők nem szivárognak be a
  // blokklistába, és a JSON-alak összevethető marad — enélkül két
  // szerkezetileg azonos lista különbözőnek látszana pusztán a kulcsok
  // sorrendje miatt, és a szinkron minden körben fölöslegesen feltöltene.
  return parsed
    .filter((s) => s && typeof s.id === 'string' && s.id
      // A DOMAIN is hosztnév-alakú kell legyen — ugyanaz a szűrő, mint a
      // helyben felvett oldalé. Ami nem az, az nem oldal: a rekord kimarad.
      && typeof s.domain === 'string' && normalizeHostname(s.domain) === s.domain)
    .map((s) => cleanSite(s));
}

/**
 * A hosztnév-jelek kiegyenesítése: csak név → pozitív egész, legfeljebb a
 * rekord rev-je (egy jó rekordban a jel sosem nagyobb nála — egy nagyobb
 * jel csak a kulccsal írt szemét lehet, és örökre tiltaná a visszavételt);
 * ami más, kimarad; a plafon ugyanaz, mint a fésülésnél. Üresen nincs mező
 * (a hiányzó és az üres itt ugyanaz: nincs jel).
 */
function cleanMarks(raw: unknown, hostnames: string[], rev: number): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > rev) continue;
    out[k] = v;
  }
  return capHostnameMarks(out, hostnames);
}

/** Egy szinkron-rekord kanonikus alakja: fix mezők, fix sorrend. */
/**
 * A szinkronon jött hosztnevek — UGYANAZON a szűrőn, mint a helyben felvettek.
 *
 * Ez nem kozmetika, hanem a root-tulajdonú hosts fájl őre. Ezek a nevek
 * változatlanul kerülnek a `0.0.0.0 név` sorokba; egy soremelést tartalmazó
 * „név” tetszőleges további sort írna a fájlba — bármely oldal átirányítását,
 * a gép minden böngészőjében. A blob titkosított, tehát ehhez a fiók jelszava
 * kell; de a jelszó a SAJÁT blokklista lazítására jogosít (ez kimondott
 * korlát), nem arra, hogy a gép névfeloldását átírja. Minden más út
 * (add_site, set_hostname) ugyanezen a szűrőn megy át — a szinkron eddig nem.
 */
function cleanHostnames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const h of raw) {
    if (typeof h !== 'string') continue;
    const clean = normalizeHostname(h);
    // Csak a már kanonikus alak megy át: amit a szűrő ÁTÍRNA (nagybetű,
    // séma, út), az nem a másik mag írása, hanem szemét — a magok kanonikus
    // alakban írnak.
    if (clean === null || clean !== h || out.includes(clean)) continue;
    out.push(clean);
  }
  return out;
}

/**
 * A dróton jött menetrend SZERKEZETE: objektum, a módja szöveg (különben
 * „always”), a sávok közül csak a jól formált marad — objektum, egész számok
 * tömbje a nap, egész a két perc. A TARTALMI szűrés (napok 0–6, percek a
 * napon belül, üresen „mindig”) a döntésé (`normalizeSchedule`), mindhárom
 * magban ugyanúgy. A két telefon típusos olvasója a rosszul formált sávot nem
 * tudja ábrázolni, így kihagyja; a gép eddig nyersen tartotta — a `bands: "x"`
 * a döntést is ledöntötte, a telefonok pedig az egész oldalt eldobták. Ami
 * nem objektum, az nincs (mint a hiányzó: mindig tiltva). Közös fixtúra:
 * fixtures/wire-cases.json.
 */
function scheduleIn(raw: unknown): SyncSite['schedule'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as { mode?: unknown; bands?: unknown };
  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
  const bands = (Array.isArray(o.bands) ? o.bands : []).filter((b): b is Band => !!b && typeof b === 'object'
    && Array.isArray((b as Band).days) && (b as Band).days.every(isInt)
    && isInt((b as Band).startMin) && isInt((b as Band).endMin))
    .map((b) => ({ days: [...b.days], startMin: b.startMin, endMin: b.endMin }));
  return { mode: (typeof o.mode === 'string' ? o.mode : 'always') as Schedule['mode'], bands };
}

/** Egy részleges szabály a dróton: hoszt és `/`-rel kezdődő út, mindkettő szöveg. */
function cleanRules(raw: unknown): SyncSite['rules'] {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((r): r is UrlRule => !!r && typeof r === 'object'
      && typeof (r as UrlRule).host === 'string' && normalizeHostname((r as UrlRule).host) === (r as UrlRule).host
      && typeof (r as UrlRule).path === 'string' && (r as UrlRule).path.startsWith('/')
      && (r as UrlRule).path.length <= 512 && !/[\s]/.test((r as UrlRule).path))
    .map((r) => ({ host: r.host, path: r.path }));
}

function cleanSite(s: Record<string, unknown>): SyncSite {
  const hostnames = cleanHostnames(s.hostnames);
  // Csak EGÉSZ rev — a jelek felső határa is ez. Eddig a határ a tört rev
  // volt (2.5 mellett egy 2-es jel átment), a rekord rev-je viszont 1 lett: a
  // jel nagyobb volt a rekordnál, amit a következő olvasás már eldobott.
  const rev = Number.isInteger(s.rev) ? (s.rev as number) : 1;
  const marks = cleanMarks(s.hostnameMarks, hostnames, rev);
  const rules = cleanRules(s.rules);
  // A szabálylista jele: pozitív egész, legfeljebb a rekord rev-je — és csak
  // lista mellett; mező nélkül nincs jel (a régi kliens rekordja semleges).
  const rulesRev = rules !== undefined && Number.isInteger(s.rulesRev)
    && (s.rulesRev as number) > 0 && (s.rulesRev as number) <= rev ? (s.rulesRev as number) : undefined;
  const ruleMarks = cleanRuleMarks(s.ruleMarks, rules, rev);
  return {
    id: s.id as string,
    domain: s.domain as string,
    hostnames,
    ...(marks ? { hostnameMarks: marks } : {}),
    addedAt: Number.isFinite(s.addedAt) ? (s.addedAt as number) : 0,
    pauseUntil: null,
    pendingDeleteAt: typeof s.pendingDeleteAt === 'number' ? s.pendingDeleteAt : null,
    schedule: scheduleIn(s.schedule),
    dailyLimitSeconds: typeof s.dailyLimitSeconds === 'number' ? s.dailyLimitSeconds : undefined,
    burstSeconds: typeof s.burstSeconds === 'number' ? s.burstSeconds : undefined,
    cooldownSeconds: typeof s.cooldownSeconds === 'number' ? s.cooldownSeconds : undefined,
    alias: typeof s.alias === 'string' ? s.alias : undefined,
    reason: typeof s.reason === 'string' ? s.reason : undefined,
    // Az `undefined` itt JELENTÉS, nem hiány: „ez a kliens nem tud a mezőről”.
    // Ezért NEM alakítjuk üres tömbbé — az azt jelentené, hogy minden szabály
    // törölve, és egy frissítetlen telefon a fiókban csendben letörölné a gépen
    // felvetteket (lásd merge.ts `mergeRules`).
    rules,
    ...(rulesRev !== undefined ? { rulesRev } : {}),
    ...(ruleMarks ? { ruleMarks } : {}),
    // A kifizetett lazítások: pozitív egész, legfeljebb a rekord rev-je (csak
    // léptetés írhatja); ami más, az nincs — a régi kliens rekordja semleges.
    ...loosensIn(s, rev),
    rev,
    updatedAt: Number.isFinite(s.updatedAt) ? (s.updatedAt as number) : 0,
    updatedBy: typeof s.updatedBy === 'string' ? s.updatedBy : '',
  };
}

/**
 * A szabályok jelei a dróton: csak KANONIKUS szabály-kulcs (ahogy a kézzel
 * beírt szabály is lenne) → pozitív egész, legfeljebb a rekord rev-je; és csak
 * szabálylista mellett — mező nélkül nincs jel. A plafon a fésülésé. Egy
 * kulccsal írt szemét így nem lehet sírkő egy sosem volt szabálynak.
 */
function cleanRuleMarks(raw: unknown, rules: SyncSite['rules'], rev: number): Record<string, number> | undefined {
  if (rules === undefined || !raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > rev) continue;
    const norm = normalizeRule(k);
    if (!norm || ruleKey(norm) !== k) continue;
    out[k] = v;
  }
  return capHostnameMarks(out, rules.map(ruleKey));
}

/**
 * A négy számláló a dróton — mindegyik csak pozitív egész, legfeljebb a rev.
 * A végigment törlés jele legfeljebb a törlés számlálója: nagyobbat a
 * fésülés sosem ír (a sírkő a saját kérésének számlálóját hordja).
 */
function loosensIn(s: Record<string, unknown>, rev: number): Partial<SyncSite> {
  const out: Partial<SyncSite> = {};
  for (const k of ['deleteLoosens', 'scheduleLoosens', 'limitLoosens', 'burstLoosens'] as const) {
    const v = s[k];
    if (Number.isInteger(v) && (v as number) > 0 && (v as number) <= rev) out[k] = v as number;
  }
  const g = s.goneLoosens;
  if (Number.isInteger(g) && (g as number) > 0 && (g as number) <= (out.deleteLoosens ?? 0)) out.goneLoosens = g as number;
  return out;
}

function decodeSites(acc: SyncAccount, payload: string | undefined): SyncSite[] {
  if (!payload) return [];
  const key = Buffer.from(acc.dataKey, 'base64');
  return normalizeIncomingSites(JSON.parse(decrypt(key, payload)));
}

/**
 * Két lista tartalmilag egyezik-e.
 *
 * KANONIKUS alakon hasonlít, nem a nyers JSON-on: a mezők sorrendje nem
 * jelenthet különbséget. Enélkül minden szinkron-kör feltöltene egy „új”
 * verziót, a verziószám a végtelenségig nőne, és a kiszolgáló minden tíz
 * percben írna egyet a semmiért.
 */
export function sameSites(a: SyncSite[], b: SyncSite[]): boolean {
  return JSON.stringify(a.map(canonical)) === JSON.stringify(b.map(canonical));
}

function canonical(s: SyncSite): unknown[] {
  return [
    s.id, s.domain, [...s.hostnames].sort(), s.addedAt,
    // A jelek is számítanak: ha csak ők különböznek (egy régi kliens
    // rekordja jel nélkül), akkor is fel kell menniük.
    s.hostnameMarks ? Object.entries(s.hostnameMarks).sort() : null,
    s.pendingDeleteAt ?? null,
    s.schedule ? [s.schedule.mode, s.schedule.bands] : null,
    s.dailyLimitSeconds ?? null,
    // Az adag-szabály is utazik: ha a kulcs nem nézné, egy csak ebben eltérő
    // fésült rekord „ugyanaz” lenne — se beírás, se feltöltés. (A telefonok
    // szerkezeti egyenlőséggel hasonlítanak, ott minden mező benne van.)
    s.burstSeconds ?? null, s.cooldownSeconds ?? null,
    s.alias ?? null,
    s.reason ?? null,
    // Rendezve: a sorrend nem jelent semmit, viszont ha számítana, minden kör
    // „változást” látna, és fölöslegesen feltöltene.
    s.rules ? s.rules.map((r) => `${r.host}${r.path}`).sort() : null,
    s.rulesRev ?? null,
    // A szabályok jelei is: egy levétel sírköve nélkül a levétel sosem érne át.
    s.ruleMarks ? Object.entries(s.ruleMarks).sort() : null,
    // A számlálók is: egy kifizetett lazítás nyoma nélkül a lazítás sosem érne át.
    s.deleteLoosens ?? null, s.scheduleLoosens ?? null, s.limitLoosens ?? null, s.burstLoosens ?? null,
    // A sírkő jele is: enélkül a fiókban maradt rekord sírkővé válása nem menne fel.
    s.goneLoosens ?? null,
    s.rev, s.updatedAt, s.updatedBy,
  ];
}

export interface SyncResult {
  /** hány oldal van a listán a kör után */
  sites: number;
  /** változott-e a helyi állapot (a hívónak ekkor menteni kell) */
  changed: boolean;
  /** hány eszköz mérését hoztuk le */
  devices: number;
}

/**
 * A mai összegzés oda-vissza: feltöltjük a miénket, lehozzuk a többiét.
 *
 * MIÉRT KÜLÖN a nagy szinkrontól. Ez néhány száz bájt, és a BLOKKOLÁSI DÖNTÉS
 * függ tőle: ha a telefonon elment a napi húsz perc, azt a gépnek is tudnia
 * kell. A teljes mérést (`usage`) viszont pazarlás lenne ilyen sűrűn mozgatni,
 * mert az csak statisztika.
 *
 * Ha ez elhasal, a helyi mérés dönt — vagyis az app pontosan úgy viselkedik,
 * mint a funkció előtt. Nem lazább: a távoli másodpercek csak hozzáadnak.
 */
export async function syncToday(state: HelperState, now: number): Promise<number> {
  const acc = requireAccount(state);
  const key = Buffer.from(acc.dataKey, 'base64');

  const payload = encrypt(key, JSON.stringify(makeTodayDigest(state.usage, acc.deviceId, now)));
  if (payload.length <= MAX_PAYLOAD_BYTES) {
    const cur = await call(acc.serverUrl, '/v1/pull', {
      accountId: acc.accountId, authKey: acc.authKey, collection: 'today', deviceId: acc.deviceId,
    });
    const r = await call(acc.serverUrl, '/v1/push', {
      accountId: acc.accountId, authKey: acc.authKey, collection: 'today',
      deviceId: acc.deviceId, baseVersion: cur.version, payload,
      nameBlob: encrypt(key, acc.deviceName),
    });
    if (r.ok) acc.todayVersion = r.version;
  }

  const all = await call(acc.serverUrl, '/v1/today-all', {
    accountId: acc.accountId, authKey: acc.authKey,
  });
  const devices: TodayDigest[] = [];
  for (const d of all.devices ?? []) {
    // A SAJÁT sorunk kimarad. Enélkül minden percünk kétszer számítana, és a
    // közös keret feleakkora lenne, mint amit a felhasználó beállított.
    if (!d || typeof d.deviceId !== 'string' || d.deviceId === acc.deviceId) continue;
    try {
      if (!d.payload) continue;
      // Az eszközazonosító a KISZOLGÁLÓTÓL jön, nem a blob belsejéből: így egy
      // eszköz nem beszélhet a másik nevében.
      const norm = parseTodayDigest(decrypt(key, d.payload), d.deviceId);
      if (norm) devices.push(norm);
    } catch { /* egy sérült sor ne vigye el a többi eszközét */ }
  }
  state.sharedToday = { selfDeviceId: acc.deviceId, devices };
  return devices.length;
}

/**
 * A munkamenet szinkronja: csomagok + a futó menet.
 *
 * Ugyanaz a menet, mint a blokklistánál — húzd le, fésüld össze, told fel —,
 * mert ugyanaz a kockázat: két eszköz párhuzamos írása egyik oldalát sem
 * tüntetheti el. A különbség az összefésülés szabályában van
 * (`shared/sync/focus-merge.ts`): ott a szigorúbb nyer, és lazítani csak a
 * nyomával lehet — a rövidítés számlálójával, a leállítás naplósorával.
 *
 * @returns változott-e a HELYI állapot (a hívónak menteni kell)
 */
async function syncFocusRound(
  state: HelperState, acc: SyncAccount, key: Buffer, now: number,
): Promise<boolean> {
  let changed = false;
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
    const pulled = await call(acc.serverUrl, '/v1/pull', {
      accountId: acc.accountId, authKey: acc.authKey, collection: 'focus',
    });
    const remote = decodeFocus(acc, pulled.payload, now);
    const mine = localFocus(state, acc.deviceId, now);
    const merged = mergeFocus(mine, remote, now);

    if (!sameFocus(merged, mine)) {
      state.focusPacks = merged.packs;
      state.focusRun = merged.run;
      // A NAPLÓ a másik eszközöktől is megjön — ettől lesz a statisztika a
      // fiók egészéről szóló szám, nem csak erről a gépről szóló. A `mergeFocus`
      // ezt EGYESÍTÉSSEL végzi, tehát a helyi sorok nem vesznek el.
      //
      // A MÁSHOL LEÁLLÍTOTT MENET sora is ezzel jön. Eddig külön írtunk egyet,
      // ha a menet a szinkronból „egyszerűen eltűnt” — de most már nem tűnhet
      // el egyszerűen: csak a rá hivatkozó naplósor zárja le (`mergeRun`), és
      // az a sor itt van a fésült naplóban. Egy saját sor kettőzne, és a mi
      // időnkkel hazudna a másik eszköz lejárata helyett.
      state.focusLog = mergeLog(merged.log, state.focusLog ?? []);
      // A jelek az összefésülés eredményéből: a helyi, régebbi jel nem
      // maradhat meg egy már eldőlt csomag mellett.
      state.focusPackMarks = merged.packMarks;
      // …és a kifizetett ablak-lazítások: a következő fésülés ezekből dönt.
      if (merged.packLoosens) state.focusPackLoosens = merged.packLoosens;
      else delete state.focusPackLoosens;
      // …és a saját jelek: az osztályon belül ezek döntenek, nem a felfújt közös.
      if (merged.packOwnMarks) state.focusPackOwnMarks = merged.packOwnMarks;
      else delete state.focusPackOwnMarks;
      // A MÁSIK ESZKÖZÖN INDÍTOTT ZÁRLAT itt lép életbe. A fésülés magasvízjel,
      // tehát ez sosem rövidít: a helyinél csak későbbi vég jöhet vissza.
      state.lockdown = merged.lockdown;
      // AZ ABLAKOK IS: a fésülés a jelük szerint döntött (a levétel csak
      // nagyobb jellel jön át), és a kör a következő fordulóban már ezek
      // szerint ír zárlatot. Üresen nincs mező — mint mindenhol.
      if (merged.lockdownWindows && merged.lockdownWindows.length > 0) {
        state.lockdownWindows = merged.lockdownWindows;
      } else {
        delete state.lockdownWindows;
      }
      if (merged.lockdownWindowsRev) state.lockdownWindowsRev = merged.lockdownWindowsRev;
      else delete state.lockdownWindowsRev;
      // …és tartalmanként a jelük: a fésülés ezekből döntött.
      if (merged.lockdownWindowMarks) state.lockdownWindowMarks = merged.lockdownWindowMarks;
      else delete state.lockdownWindowMarks;
      // A KULCSSZAVAK IS a jelük szerint — a bővítmény a következő lehúzáskor
      // már ezt a listát kapja.
      if (merged.keywords && merged.keywords.length > 0) state.keywords = merged.keywords;
      else delete state.keywords;
      if (merged.keywordsRev) state.keywordsRev = merged.keywordsRev;
      else delete state.keywordsRev;
      // …és kulcsszavanként a jelük: a fésülés ezekből döntött.
      if (merged.keywordMarks) state.keywordMarks = merged.keywordMarks;
      else delete state.keywordMarks;
      // A MEGBÍZOTT IS a jele szerint: a másik eszközön felvett innentől itt
      // is az utolsó szó; a levétel csak nagyobb jellel jön át.
      if (merged.partner) state.partner = merged.partner;
      else delete state.partner;
      if (merged.partnerRev) state.partnerRev = merged.partnerRev;
      else delete state.partnerRev;
      if (merged.partnerCo) state.partnerCo = merged.partnerCo;
      else delete state.partnerCo;
      if (merged.partnersGone) state.partnersGone = merged.partnersGone;
      else delete state.partnersGone;
      // A REJTÉS IS a jele szerint: a telefonon bekapcsolt rejtés innentől itt
      // is áll; a kikapcsolás (a készülék azonosítása után) csak nagyobb jellel.
      if (merged.hideSiteList === true) state.hideSiteList = true;
      else delete state.hideSiteList;
      if (merged.hideSiteListRev) state.hideSiteListRev = merged.hideSiteListRev;
      else delete state.hideSiteListRev;
      state.focusRev = merged.rev;
      state.focusUpdatedAt = merged.updatedAt;
      state.focusUpdatedBy = merged.updatedBy;
      // A lenyomatot ÚJRASZÁMOLJUK, nem az övét vesszük át: enélkül a következő
      // mentés fölöslegesen léptetné a számlálót, és a két eszköz örökké
      // írogatná egymást.
      adoptFocusRevision(state);
      changed = true;
    }
    if (sameFocus(merged, remote) && pulled.version > 0) {
      acc.focusVersion = pulled.version;
      return changed; // a kiszolgálón már pontosan ez van
    }

    const payload = encrypt(key, JSON.stringify(merged));
    if (payload.length > MAX_PAYLOAD_BYTES) {
      throw new SyncError('A munkamenet adatai túl nagyok a szinkronhoz — a csomagok vagy a napló. '
        + 'A menet ettől még fut, csak a többi eszközre nem ér át.', 'TOO_BIG');
    }
    const push = await call(acc.serverUrl, '/v1/push', {
      accountId: acc.accountId, authKey: acc.authKey, collection: 'focus',
      deviceId: acc.deviceId, baseVersion: pulled.version, payload,
      nameBlob: encrypt(key, acc.deviceName),
    });
    if (push.ok) {
      acc.focusVersion = push.version;
      return changed;
    }
    if (attempt === MAX_CONFLICT_RETRIES) {
      throw new SyncError('A munkamenet szinkronja nem tudott lezárulni.', 'CONFLICT');
    }
  }
  return changed;
}

/**
 * A csatorna-szűrők szinkronja: az egész lista egy blobként.
 *
 * Ugyanaz a menet, mint a munkamenetnél — húzd le, fésüld össze, told fel —,
 * a fésülés GAZDAGÉPENKÉNT megy (`shared/sync/channels-merge.ts`): a több
 * kifizetett lazítás nyer, egyenlőnél a szigorúbb. Egy elavult gép ingyenes
 * szerkesztése így semmit nem lazíthat a többin.
 *
 * A tiltás a bővítményben él, tehát a szinkron itt a REKORDOKAT viszi át:
 * a másik gépen a saját bővítménye érvényesíti őket.
 *
 * @returns változott-e a HELYI állapot (a hívónak menteni kell)
 */
async function syncChannelsRound(
  state: HelperState, acc: SyncAccount, key: Buffer,
): Promise<boolean> {
  let changed = false;
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
    const pulled = await call(acc.serverUrl, '/v1/pull', {
      accountId: acc.accountId, authKey: acc.authKey, collection: 'channels',
    });
    const remote = decodeChannels(acc, pulled.payload);
    const mine = localChannels(state, acc.deviceId);
    const merged = mergeChannels(mine, remote);

    if (!sameChannels(merged, mine)) {
      state.channelFilters = merged.filters;
      state.channelsRev = merged.rev;
      state.channelsUpdatedAt = merged.updatedAt;
      state.channelsUpdatedBy = merged.updatedBy;
      // A jelek és a kifizetett lazítások is: a következő fésülés ezekből dönt.
      if (merged.marks) state.channelMarks = merged.marks; else delete state.channelMarks;
      if (merged.loosens) state.channelLoosens = merged.loosens; else delete state.channelLoosens;
      // A lenyomatot ÚJRASZÁMOLJUK, nem az övét vesszük át — különben a
      // következő mentés fölöslegesen léptetne, és a két eszköz örökké
      // írogatná egymást.
      adoptChannelsRevision(state);
      changed = true;
    }
    if (sameChannels(merged, remote) && pulled.version > 0) {
      acc.channelsVersion = pulled.version;
      return changed; // a kiszolgálón már pontosan ez van
    }

    const payload = encrypt(key, JSON.stringify(merged));
    if (payload.length > MAX_PAYLOAD_BYTES) {
      throw new SyncError('A csatorna-szűrők adatai túl nagyok a szinkronhoz. '
        + 'A szűrés ettől még él, csak a többi gépre nem ér át.', 'TOO_BIG');
    }
    const push = await call(acc.serverUrl, '/v1/push', {
      accountId: acc.accountId, authKey: acc.authKey, collection: 'channels',
      deviceId: acc.deviceId, baseVersion: pulled.version, payload,
      nameBlob: encrypt(key, acc.deviceName),
    });
    if (push.ok) {
      acc.channelsVersion = push.version;
      return changed;
    }
    if (attempt === MAX_CONFLICT_RETRIES) {
      throw new SyncError('A csatorna-szűrők szinkronja nem tudott lezárulni.', 'CONFLICT');
    }
  }
  return changed;
}

function localChannels(state: HelperState, deviceId: string): SyncChannels {
  return {
    filters: state.channelFilters ?? [],
    rev: state.channelsRev ?? 0,
    updatedAt: state.channelsUpdatedAt ?? 0,
    updatedBy: state.channelsUpdatedBy ?? deviceId,
    ...(state.channelMarks ? { marks: state.channelMarks } : {}),
    ...(state.channelLoosens ? { loosens: state.channelLoosens } : {}),
  };
}

/** Sérült vagy régi blob: üres állapot, nem kivétel — mint a munkamenetnél. */
function decodeChannels(acc: SyncAccount, payload: string | null | undefined): SyncChannels {
  if (!payload) return emptyChannels(acc.deviceId);
  try {
    const key = Buffer.from(acc.dataKey, 'base64');
    return normalizeSyncChannels(JSON.parse(decrypt(key, payload)), acc.deviceId);
  } catch {
    return emptyChannels(acc.deviceId);
  }
}

/**
 * A helyi állapot szinkron-alakja.
 *
 * A menet csak a csomagjával együtt megy fel: egy csomag nélküli helyi menet
 * (a betöltés normalizálása kidobta a csomagját) a dróton úgyis kiesne, a
 * fésülés viszont megtartaná a szigorúbbat — és a gép minden körben újra
 * feltöltené ugyanazt, amit a kiszolgáló sosem tart meg.
 */
function localFocus(state: HelperState, deviceId: string, now: number): SyncFocus {
  const packs = state.focusPacks ?? [];
  const run = state.focusRun ?? null;
  return {
    packs,
    run: run && packs.some((p) => p.id === run.packId) ? run : null,
    log: state.focusLog ?? [],
    ...(state.focusPackMarks ? { packMarks: state.focusPackMarks } : {}),
    // A kifizetett ablak-lazítások csomagonként — a fésülés ezekből dönt.
    ...(state.focusPackLoosens ? { packLoosens: state.focusPackLoosens } : {}),
    // A saját jelek is: egy osztály-döntés nyoma (lásd `mergePacks`).
    ...(state.focusPackOwnMarks ? { packOwnMarks: state.focusPackOwnMarks } : {}),
    // A ZÁRLAT a munkamenet blobján utazik: nem oldalhoz tartozik, hanem az
    // egész eszközhöz — ugyanaz a szint, mint a futó menet. Csak az ÉLŐ megy
    // fel; a lejártat nincs értelme a többi eszközre vinni — és a lejövő
    // oldalon is csak az élő számít (`decodeFocus`), különben a kettő minden
    // körben különbözne.
    ...(liveLockdown(state.lockdown, now) ? { lockdown: liveLockdown(state.lockdown, now)! } : {}),
    // Az ablakok a jelükkel — a fésülés ebből tudja, kié az újabb szó.
    ...((state.lockdownWindows ?? []).length > 0 ? { lockdownWindows: state.lockdownWindows! } : {}),
    ...(state.lockdownWindowsRev ? { lockdownWindowsRev: state.lockdownWindowsRev } : {}),
    ...(state.lockdownWindowMarks && Object.keys(state.lockdownWindowMarks).length > 0
      ? { lockdownWindowMarks: state.lockdownWindowMarks } : {}),
    // A megbízott a jelével — a lenyomat utazik, a jelmondat sehol nincs.
    ...(state.partner ? { partner: state.partner } : {}),
    ...(state.partnerRev ? { partnerRev: state.partnerRev } : {}),
    ...(state.partnerCo && state.partnerCo.length > 0 ? { partnerCo: state.partnerCo } : {}),
    ...(state.partnersGone && state.partnersGone.length > 0 ? { partnersGone: state.partnersGone } : {}),
    // A rejtés a jelével — a fésülés ebből tudja, kié az újabb szó. Csak igazként.
    ...(state.hideSiteList === true ? { hideSiteList: true } : {}),
    ...(state.hideSiteListRev ? { hideSiteListRev: state.hideSiteListRev } : {}),
    // A kulcsszavak a jelükkel — mint az ablakok.
    ...((state.keywords ?? []).length > 0 ? { keywords: state.keywords! } : {}),
    ...(state.keywordsRev ? { keywordsRev: state.keywordsRev } : {}),
    ...(state.keywordMarks && Object.keys(state.keywordMarks).length > 0 ? { keywordMarks: state.keywordMarks } : {}),
    rev: state.focusRev ?? 0,
    updatedAt: state.focusUpdatedAt ?? 0,
    updatedBy: state.focusUpdatedBy ?? deviceId,
  };
}

/**
 * A letöltött blob kibontása.
 *
 * Egy sérült vagy régi formátumú blob ÜRES állapotot ad, nem kivételt: ha itt
 * elhasalnánk, egy elrontott bájt megállítaná az egész szinkront — a
 * blokklistáét is.
 */
function decodeFocus(acc: SyncAccount, payload: string | null | undefined, now: number): SyncFocus {
  if (!payload) return emptyFocus(acc.deviceId);
  try {
    const key = Buffer.from(acc.dataKey, 'base64');
    return normalizeSyncFocus(JSON.parse(decrypt(key, payload)), acc.deviceId, now);
  } catch {
    return emptyFocus(acc.deviceId);
  }
}

/**
 * Egy teljes szinkron-kör.
 *
 * A hívó felelőssége menteni (`commit`), ha `changed` igaz — a mentés a
 * blokkolást is újraírja, és azt itt nem akarjuk kétszer megtenni.
 */
export async function syncNow(state: HelperState, now: number): Promise<SyncResult> {
  const acc = requireAccount(state);
  const key = Buffer.from(acc.dataKey, 'base64');
  // Először léptetjük a helyi verziószámokat, különben egy azóta történt
  // változás úgy menne fel, mintha a régi rev-hez tartozna — és a másik eszköz
  // joggal dobná el.
  bumpRevisions(state, acc.deviceId, now);

  let changed = false;
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
    const pulled = await call(acc.serverUrl, '/v1/pull', {
      accountId: acc.accountId, authKey: acc.authKey, collection: 'sites',
    });
    const remote = decodeSites(acc, pulled.payload);
    // A SÍRKÖVEK is a fésülésbe mennek (shared/sync/merge.ts `isGone`): a
    // végigment törlés így nem jön vissza, se a fiókból, se egy régi
    // eszközről. Ami nincs a helyi listán, és itt már esedékes, az a
    // fésülés előtt sírkő lesz (`settleIncoming`) — utána pedig a fésült
    // lista szétoszlik: mi tilt itt, és mi sírkő (`splitMerged`).
    const localIds = new Set(state.sites.map((s) => s.id));
    const gone = state.goneSites ?? [];
    const mine = toSyncSites([...state.sites, ...gone], acc.deviceId);
    const incoming = settleIncoming(remote, localIds, now);
    const merged = reapplyUnsyncedBursts(mergeSiteLists(mine, incoming), state.sites, acc.deviceId, now);
    const split = splitMerged(merged, localIds, now);

    if (!sameSites(split.sites, toSyncSites(state.sites, acc.deviceId))
      || !sameSites(split.gone, toSyncSites(gone, acc.deviceId))) {
      // Ami itt egy másik azonosítóba olvadt, annak a helyi állapota vele megy.
      const folded = foldedIds(state.sites, merged);
      carryFolded(state, folded);
      state.sites = fromSyncSites(split.sites, state.sites, folded);
      if (split.gone.length > 0) state.goneSites = split.gone.map((g) => ({ ...g }));
      else delete state.goneSites;
      changed = true;
    }
    if (sameSites(merged, remote) && pulled.version > 0) {
      acc.sitesVersion = pulled.version;
      clearBurstUnsynced(state);
      break; // a kiszolgálón már pontosan ez van: nincs mit feltölteni
    }

    const payload = encrypt(key, JSON.stringify(merged));
    if (payload.length > MAX_PAYLOAD_BYTES) {
      throw new SyncError('A blokklista túl nagy a szinkronhoz.', 'TOO_BIG');
    }
    const push = await call(acc.serverUrl, '/v1/push', {
      accountId: acc.accountId, authKey: acc.authKey, collection: 'sites',
      deviceId: acc.deviceId, baseVersion: pulled.version, payload,
      nameBlob: encrypt(key, acc.deviceName),
    });
    if (push.ok) {
      acc.sitesVersion = push.version;
      clearBurstUnsynced(state);
      break;
    }
    // Ütközés: valaki közben írt. Vissza az elejére, most már az ő verziójával.
    if (attempt === MAX_CONFLICT_RETRIES) {
      throw new SyncError('A szinkron nem tudott lezárulni: egy másik eszköz épp ír.', 'CONFLICT');
    }
  }

  // A MUNKAMENET. A blokklista után megy, mert az a fontosabb: ha a kör itt
  // hasal el, a tiltás attól már szinkronban van. Külön `try`, ugyanezért — egy
  // munkamenet-hiba ne vigye magával az egész kört.
  try {
    if (await syncFocusRound(state, acc, key, now)) changed = true;
    delete state.focusSyncError;
  } catch (e) {
    // NEM némán. Egy RÉGI fiókkiszolgáló nem ismeri a `focus` gyűjteményt, és
    // 400-zal felel — a munkamenet ilyenkor sosem ér át a telefonra, és a
    // felhasználó ezt semmiből nem tudná meg. Azt hinné, a funkció rossz.
    //
    // A kört ettől még nem állítjuk meg: a blokklista fontosabb, és az már
    // szinkronban van. Csak megjegyezzük, hogy a felület kiírhassa.
    const err = e as SyncError;
    state.focusSyncError = err?.code === 'BAD_REQUEST' || err?.code === 'SERVER'
      ? 'A fiókkiszolgálód nem ismeri a munkamenetet — valószínűleg régebbi verzió. '
        + 'Amíg nem frissül, a munkamenet csak ezen a gépen él.'
      : (err?.message ?? 'A munkamenet szinkronja nem sikerült.');
    changed = true;
  }

  // A CSATORNA-SZŰRŐK. Ugyanazzal a védelemmel, mint a munkamenet: külön
  // `try`, mert egy régi fiókkiszolgáló nem ismeri a gyűjteményt, és az nem
  // ránthatja magával a kört — de néma sem maradhat.
  try {
    if (await syncChannelsRound(state, acc, key)) changed = true;
    delete state.channelsSyncError;
  } catch (e) {
    const err = e as SyncError;
    state.channelsSyncError = err?.code === 'BAD_REQUEST' || err?.code === 'SERVER'
      ? 'A fiókkiszolgálód nem ismeri a csatorna-szűrőket — valószínűleg régebbi '
        + 'verzió. Amíg nem frissül, a szűrők csak ezen a gépen élnek.'
      : (err?.message ?? 'A csatorna-szűrők szinkronja nem sikerült.');
    changed = true;
  }

  // A mérés eszközönként külön blob: itt nincs ütközés, csak a saját sorunkat
  // írjuk. Ha ez elhasal, a blokklista attól már szinkronban van — ezért fut
  // külön, és nem rántja magával a kört.
  let devices = 0;
  try {
    // Előbb a mai összegzés: ez apró, és ettől függ a KÖZÖS napi keret. Ha a
    // nagy mérés-blob elhasalna, a keret akkor is helyes marad.
    await syncToday(state, now);
    const usagePayload = encrypt(key, JSON.stringify(state.usage));
    if (usagePayload.length <= MAX_PAYLOAD_BYTES) {
      const cur = await call(acc.serverUrl, '/v1/pull', {
        accountId: acc.accountId, authKey: acc.authKey, collection: 'usage', deviceId: acc.deviceId,
      });
      const r = await call(acc.serverUrl, '/v1/push', {
        accountId: acc.accountId, authKey: acc.authKey, collection: 'usage',
        deviceId: acc.deviceId, baseVersion: cur.version, payload: usagePayload,
        nameBlob: encrypt(key, acc.deviceName),
      });
      if (r.ok) acc.usageVersion = r.version;
    }
    const all = await call(acc.serverUrl, '/v1/usage-all', {
      accountId: acc.accountId, authKey: acc.authKey,
    });
    devices = Array.isArray(all.devices) ? all.devices.length : 0;
  } catch (e) {
    acc.lastError = (e as Error).message;
  }

  acc.lastSyncAt = now;
  if (devices > 0) delete acc.lastError;
  return { sites: state.sites.length, changed, devices };
}

/**
 * A többi eszköz mérése, visszafejtve.
 *
 * Külön hívás, mert a felület csak akkor kéri, amikor tényleg megnézed —
 * feleslegesen nem húzunk le és nem fejtünk vissza semmit.
 */
export async function pullAllUsage(
  state: HelperState,
): Promise<{ deviceId: string; name: string; usage: unknown }[]> {
  const acc = requireAccount(state);
  const key = Buffer.from(acc.dataKey, 'base64');
  const all = await call(acc.serverUrl, '/v1/usage-all', {
    accountId: acc.accountId, authKey: acc.authKey,
  });
  const out: { deviceId: string; name: string; usage: unknown }[] = [];
  for (const d of all.devices ?? []) {
    // Rekordonként tűrünk: egy sérült blob ne vigye el a többi eszköz
    // statisztikáját is.
    try {
      out.push({
        deviceId: d.deviceId,
        name: d.nameBlob ? decrypt(key, d.nameBlob) : d.deviceId,
        usage: d.payload ? JSON.parse(decrypt(key, d.payload)) : null,
      });
    } catch { /* ezt az egyet kihagyjuk */ }
  }
  return out;
}

export async function forgetDevice(state: HelperState, deviceId: string): Promise<void> {
  const acc = requireAccount(state);
  await call(acc.serverUrl, '/v1/forget-device', {
    accountId: acc.accountId, authKey: acc.authKey, deviceId,
  });
}
