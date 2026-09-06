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

import * as crypto from 'crypto';
import {
  decrypt, encrypt, enroll, recoveryAuthKey, rewrapForNewPassword, subKey, rootKey,
  unlockWithPassword, unlockWithRecovery,
} from '../shared/sync/crypto.js';
import { capHostnameMarks, mergeSiteLists, type SyncSite } from '../shared/sync/merge.js';
import { MAX_PAYLOAD_BYTES, SYNC_PROTOCOL } from '../shared/sync/protocol.js';
import type { HelperState, SiteRec, SyncAccount } from './state';
import {
  adoptChannelsRevision, adoptFocusRevision, adoptRevision, bumpRevisions,
} from './revisions';
import {
  emptyFocus, mergeFocus, mergeLog, normalizeSyncFocus, sameFocus, type SyncFocus,
} from '../shared/sync/focus-merge.js';
import {
  emptyChannels, mergeChannels, normalizeSyncChannels, sameChannels, type SyncChannels,
} from '../shared/sync/channels-merge.js';
import { closeRun, MAX_FOCUS_LOG, type FocusRun } from '../shared/focus.js';
import { makeTodayDigest, normalizeTodayDigest, type TodayDigest } from '../shared/limits.js';

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
    schedule: s.schedule, dailyLimitSeconds: s.dailyLimitSeconds, alias: s.alias,
    rules: s.rules,
    rev: s.rev ?? 1, updatedAt: s.updatedAt ?? s.addedAt, updatedBy: s.updatedBy ?? deviceId,
  })).map((s) => cleanSite(s as unknown as Record<string, unknown>));
}

/**
 * Vissza a segéd rekordjaiba, a lenyomatot újraszámolva.
 *
 * A szünet a HELYI marad: se fel nem megy, se felül nem íródik. Így aki itt
 * végigcsinálta a próbát, nem veszíti el a feloldását attól, hogy közben
 * szinkronizált.
 */
function fromSyncSites(merged: SyncSite[], local: SiteRec[]): SiteRec[] {
  const byId = new Map(local.map((s) => [s.id, s]));
  return merged.map((m) => adoptRevision({
    ...byId.get(m.id),
    id: m.id, domain: m.domain, hostnames: m.hostnames, addedAt: m.addedAt,
    // A jelek az összefésülés eredményéből jönnek — a helyi, régebbi jel nem
    // maradhat meg egy már eldőlt név mellett.
    hostnameMarks: m.hostnameMarks,
    pauseUntil: byId.get(m.id)?.pauseUntil ?? null,
    pendingDeleteAt: m.pendingDeleteAt,
    schedule: m.schedule, dailyLimitSeconds: m.dailyLimitSeconds, alias: m.alias,
    rules: m.rules,
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
    .filter((s) => s && typeof s.id === 'string' && typeof s.domain === 'string')
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
function cleanSite(s: Record<string, unknown>): SyncSite {
  const hostnames = Array.isArray(s.hostnames) ? (s.hostnames as string[]) : [];
  const rev = Number.isFinite(s.rev) ? (s.rev as number) : 1;
  const marks = cleanMarks(s.hostnameMarks, hostnames, rev);
  return {
    id: s.id as string,
    domain: s.domain as string,
    hostnames,
    ...(marks ? { hostnameMarks: marks } : {}),
    addedAt: Number.isFinite(s.addedAt) ? (s.addedAt as number) : 0,
    pauseUntil: null,
    pendingDeleteAt: typeof s.pendingDeleteAt === 'number' ? s.pendingDeleteAt : null,
    schedule: (s.schedule as SyncSite['schedule']) ?? undefined,
    dailyLimitSeconds: typeof s.dailyLimitSeconds === 'number' ? s.dailyLimitSeconds : undefined,
    burstSeconds: typeof s.burstSeconds === 'number' ? s.burstSeconds : undefined,
    cooldownSeconds: typeof s.cooldownSeconds === 'number' ? s.cooldownSeconds : undefined,
    alias: typeof s.alias === 'string' ? s.alias : undefined,
    // Az `undefined` itt JELENTÉS, nem hiány: „ez a kliens nem tud a mezőről”.
    // Ezért NEM alakítjuk üres tömbbé — az azt jelentené, hogy minden szabály
    // törölve, és egy frissítetlen telefon a fiókban csendben letörölné a gépen
    // felvetteket (lásd merge.ts `mergeRules`).
    rules: Array.isArray(s.rules) ? (s.rules as SyncSite['rules']) : undefined,
    rev: Number.isInteger(s.rev) ? (s.rev as number) : 1,
    updatedAt: Number.isFinite(s.updatedAt) ? (s.updatedAt as number) : 0,
    updatedBy: typeof s.updatedBy === 'string' ? s.updatedBy : '',
  };
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
function sameSites(a: SyncSite[], b: SyncSite[]): boolean {
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
    s.alias ?? null,
    // Rendezve: a sorrend nem jelent semmit, viszont ha számítana, minden kör
    // „változást” látna, és fölöslegesen feltöltene.
    s.rules ? s.rules.map((r) => `${r.host}${r.path}`).sort() : null,
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
      const parsed = d.payload ? JSON.parse(decrypt(key, d.payload)) : null;
      // Az eszközazonosító a KISZOLGÁLÓTÓL jön, nem a blob belsejéből: így egy
      // eszköz nem beszélhet a másik nevében.
      const norm = normalizeTodayDigest(parsed, d.deviceId);
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
 * (`shared/sync/focus-merge.ts`): ott a szigorúbb nyer, és lazítani csak
 * nagyobb `rev` tud.
 *
 * @returns változott-e a HELYI állapot (a hívónak menteni kell)
 */
async function syncFocusRound(
  state: HelperState, acc: SyncAccount, key: Buffer,
): Promise<boolean> {
  let changed = false;
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
    const pulled = await call(acc.serverUrl, '/v1/pull', {
      accountId: acc.accountId, authKey: acc.authKey, collection: 'focus',
    });
    const remote = decodeFocus(acc, pulled.payload);
    const mine = localFocus(state, acc.deviceId);
    const merged = mergeFocus(mine, remote);

    if (!sameFocus(merged, mine)) {
      // HA A MENET MÁSHOL ÉRT VÉGET, ide is bekerül a naplóba.
      //
      // A statisztikát eddig csak a helyi bíró töltötte: ő látja, ha a menet
      // lejár vagy ha itt állítod le próbatétellel. Egy TELEFONON leállított
      // menet viszont a szinkronon át érkezik — a `focusRun` egyszerűen
      // eltűnik —, és a statisztikából hiányozna. Aki a telefonján állítja le a
      // menetet, az azt látná, hogy a héten nem is használta.
      //
      // Kettőzés nincs: ha a leállítás ITT történt, a helyi `focusRun` ekkorra
      // már null, tehát ez az ág nem fut le.
      logRunEndedElsewhere(state, mine.run, merged.run, Date.now());
      state.focusPacks = merged.packs;
      state.focusRun = merged.run;
      // A NAPLÓ a másik eszközöktől is megjön — ettől lesz a statisztika a
      // fiók egészéről szóló szám, nem csak erről a gépről szóló. A `mergeFocus`
      // ezt EGYESÍTÉSSEL végzi, tehát a helyi sorok nem vesznek el.
      //
      // A `logRunEndedElsewhere` FÖLÖTTE fut, szándékosan: az a sor, amit ő ír,
      // már benne kell legyen abban, amit legközelebb feltöltünk.
      state.focusLog = mergeLog(merged.log, state.focusLog ?? []);
      // A jelek az összefésülés eredményéből: a helyi, régebbi jel nem
      // maradhat meg egy már eldőlt csomag mellett.
      state.focusPackMarks = merged.packMarks;
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
 * Naplózza, ha egy MÁSIK eszköz zárta le a nálunk futó menetet.
 *
 * Csak akkor ír, ha nálunk tényleg FUTOTT valami, és a másik oldal
 * megrövidítette vagy leállította. A hosszabbítás nem lezárás.
 */
function logRunEndedElsewhere(
  state: HelperState, mine: FocusRun | null, merged: FocusRun | null, now: number,
): void {
  if (!mine || mine.endsAt <= now) return;          // nálunk nem futott
  if (merged && merged.endsAt >= mine.endsAt) return; // hosszabbítás vagy azonos
  const pack = (state.focusPacks ?? []).find((p) => p.id === mine.packId);
  const endedAt = merged ? merged.endsAt : now;
  state.focusLog = [
    ...(state.focusLog ?? []),
    closeRun(mine, pack?.name ?? 'Ismeretlen csomag', endedAt, true),
  ].slice(-MAX_FOCUS_LOG);
}

/**
 * A csatorna-szűrők szinkronja: az egész lista egy blobként.
 *
 * Ugyanaz a menet, mint a munkamenetnél — húzd le, fésüld össze, told fel —,
 * de a fésülés szabálya a legegyszerűbb: a frissebb oldal listája nyer
 * (`shared/sync/channels-merge.ts`). Lazítani itt is csak elvégzett munkával
 * lehet: a `rev` a helyi próbatétel-kapun átment változás után nő.
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

/** A helyi állapot szinkron-alakja. */
function localFocus(state: HelperState, deviceId: string): SyncFocus {
  return {
    packs: state.focusPacks ?? [],
    run: state.focusRun ?? null,
    log: state.focusLog ?? [],
    ...(state.focusPackMarks ? { packMarks: state.focusPackMarks } : {}),
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
function decodeFocus(acc: SyncAccount, payload: string | null | undefined): SyncFocus {
  if (!payload) return emptyFocus(acc.deviceId);
  try {
    const key = Buffer.from(acc.dataKey, 'base64');
    return normalizeSyncFocus(JSON.parse(decrypt(key, payload)), acc.deviceId);
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
    const mine = toSyncSites(state.sites, acc.deviceId);
    const merged = mergeSiteLists(mine, remote);

    if (!sameSites(merged, mine)) {
      state.sites = fromSyncSites(merged, state.sites);
      changed = true;
    }
    if (sameSites(merged, remote) && pulled.version > 0) {
      acc.sitesVersion = pulled.version;
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
    if (await syncFocusRound(state, acc, key)) changed = true;
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
