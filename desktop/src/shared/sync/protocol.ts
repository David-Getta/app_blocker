// A szinkron-kiszolgáló protokollja.
//
// Szándékosan buta: a kiszolgáló egy VERZIÓZOTT KULCS-ÉRTÉK TÁR, ami nem érti,
// mit tárol. Minden `payload` egy `brk1.…` blob (lásd crypto.ts), tehát a
// kiszolgáló csak annyit lát, hogy melyik fiók melyik eszköze mikor tett le egy
// adott gyűjteménybe valamit.
//
// Ez nem lustaság, hanem a lényeg: amit a kiszolgáló nem ért, azt nem is
// szivárogtathatja ki, és nem is manipulálhatja észrevétlenül (a GCM-címke
// minden változtatást elbuktat a visszafejtésnél).
//
// Ütközéskezelés: minden gyűjtemény egy `version` számot hordoz. A feltöltés
// megmondja, MELYIK verzióra épül; ha közben más írt, a kiszolgáló elutasítja,
// és visszaadja az aktuálisat. A kliens ekkor összefésül (merge.ts), és újra
// próbálkozik. Így két eszköz párhuzamos írása sosem tünteti el a másikét.

/** Amit a kiszolgáló tárolni tud. Új gyűjtemény hozzáadható, a régiek maradnak. */
export type Collection =
  /** a blokklista (SyncSite[]) */
  | 'sites'
  /** egy eszköz mért ideje, naponként */
  | 'usage';

export interface SyncRequestBase {
  accountId: string;
  /** a `crypto.authKey()` eredménye — a jelszó SOSEM megy át a dróton */
  authKey: string;
}

/** Regisztráció. A kiszolgáló csak burkolt kulcsokat kap. */
export interface SignUpRequest {
  accountId: string;
  authKey: string;
  wrappedByPassword: string;
  wrappedByRecovery: string;
}

/** Belépés: a kiszolgáló visszaadja a burkolt adatkulcsot, kibontani a kliens tudja. */
export interface SignInResponse {
  wrappedByPassword: string;
  wrappedByRecovery: string;
  devices: DeviceInfo[];
}

export interface DeviceInfo {
  deviceId: string;
  /** a felhasználó által adott név („Dávid MacBookja”) — TITKOSÍTVA tárolva */
  nameBlob: string;
  lastSeen: number;
}

export interface PullRequest extends SyncRequestBase {
  collection: Collection;
  /** `usage`-nél melyik eszközé; `sites`-nál nincs értelme */
  deviceId?: string;
}

export interface PullResponse {
  version: number;
  /** hiányzik, ha a gyűjtemény még üres */
  payload?: string;
  updatedAt?: number;
}

export interface PushRequest extends SyncRequestBase {
  collection: Collection;
  deviceId: string;
  /** melyik verzióra épül a feltöltés; 0 = „még nem volt semmi” */
  baseVersion: number;
  payload: string;
}

export type PushResponse =
  | { ok: true; version: number }
  /** közben más írt: itt az aktuális, fésülj és próbáld újra */
  | { ok: false; conflict: true; version: number; payload?: string };

/** Az összes eszköz mérése egy körben — ebből áll össze a „többi eszköz statisztikája”. */
export interface UsageAllResponse {
  devices: { deviceId: string; nameBlob: string; version: number; payload?: string }[];
}

export interface ErrorResponse {
  error: string;
  /** gépi kód, hogy a felület tudjon mit mondani: BAD_AUTH, NO_ACCOUNT, TOO_BIG… */
  code: string;
}

/**
 * Egy blob felső mérete.
 *
 * A kiszolgáló nem tudja megnézni, mit tárol, tehát nem tud „ésszerű” korlátot
 * mérlegelni sem — ezért fix. Egy blokklista pár kilobájt, harminc nap mérése
 * néhány tíz; 1 MB tehát bőven elég, és közben nem hagyja, hogy egy hibás
 * kliens (vagy valaki más) a fiókot tárhelynek használja.
 */
export const MAX_PAYLOAD_BYTES = 1_000_000;

/** A protokoll verziója. A kliens ezt küldi; nem egyező verziót a kiszolgáló elutasít. */
export const SYNC_PROTOCOL = 1;
