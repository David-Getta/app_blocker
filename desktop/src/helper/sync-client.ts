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
import { mergeSiteLists, type SyncSite } from '../shared/sync/merge.js';
import { MAX_PAYLOAD_BYTES, SYNC_PROTOCOL } from '../shared/sync/protocol.js';
import type { HelperState, SiteRec, SyncAccount } from './state';
import { adoptRevision, bumpRevisions } from './revisions';

/** Ennél tovább egy szinkron-kör nem tarthat; a segéd nem állhat meg miatta. */
export const SYNC_TIMEOUT_MS = 15_000;

/** Hányszor próbáljuk újra, ha közben más eszköz írt. */
const MAX_CONFLICT_RETRIES = 3;

export class SyncError extends Error {
  constructor(message: string, readonly code = 'SYNC') { super(message); }
}

// ------------------------------------------------------------------ HTTP

async function call(serverUrl: string, path: string, body: unknown): Promise<any> {
  const url = new URL(path, serverUrl).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SYNC_TIMEOUT_MS);
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
  } finally {
    clearTimeout(timer);
  }
  let json: any;
  try {
    json = await res.json();
  } catch {
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
    pauseUntil: null, pendingDeleteAt: s.pendingDeleteAt,
    schedule: s.schedule, dailyLimitSeconds: s.dailyLimitSeconds, alias: s.alias,
    rev: s.rev ?? 1, updatedAt: s.updatedAt ?? s.addedAt, updatedBy: s.updatedBy ?? deviceId,
  }));
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
    pauseUntil: byId.get(m.id)?.pauseUntil ?? null,
    pendingDeleteAt: m.pendingDeleteAt,
    schedule: m.schedule, dailyLimitSeconds: m.dailyLimitSeconds, alias: m.alias,
    rev: m.rev, updatedAt: m.updatedAt, updatedBy: m.updatedBy,
  } as SiteRec));
}

function decodeSites(acc: SyncAccount, payload: string | undefined): SyncSite[] {
  if (!payload) return [];
  const key = Buffer.from(acc.dataKey, 'base64');
  const parsed = JSON.parse(decrypt(key, payload));
  return Array.isArray(parsed) ? parsed : [];
}

function sameSites(a: SyncSite[], b: SyncSite[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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

  // A mérés eszközönként külön blob: itt nincs ütközés, csak a saját sorunkat
  // írjuk. Ha ez elhasal, a blokklista attól már szinkronban van — ezért fut
  // külön, és nem rántja magával a kört.
  let devices = 0;
  try {
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
