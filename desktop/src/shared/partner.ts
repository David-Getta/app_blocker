// PÁRBAN ZÁROLÁS: a lazítás végén egy MEGBÍZOTT jelmondata is kell.
//
// MIÉRT. A próbatétel a saját impulzusod ellen véd: munkába kerül, de egyedül
// is meg lehet csinálni. Van, akinek ez kevés — neki az kell, hogy a lazítás
// ne csak drága legyen, hanem MÁS EMBER döntése is. A párban zárolás ezt
// adja: kiválasztasz egy megbízottat (társ, barát, szülő), aki egy jelmondatot
// kap; és minden lazító próbatétel UTOLSÓ lépése az, hogy ő beírja. Nem
// helyetted csinálja végig — a munka a tiéd —, csak az utolsó szót ő mondja ki.
//
// A SZABÁLY UGYANAZ, mint mindenhol: felvenni ingyen (szigorítás), levenni
// próbatétel — a megbízott jelmondatával a végén, tehát a levételhez is ő
// kell. A jelmondatot az app sorsolja, egyszer mutatja meg, és csak a
// lenyomatát (scrypt) tárolja: a gépről és a szinkronból nem olvasható ki.
//
// ŐSZINTE HATÁR, kimondva: ez nem gépzár. Aki rendszergazdaként a segéd
// állapotfájljába nyúl, az a lenyomatot is le tudja venni — ahogy a zárlatot
// is. Az impulzus ellen véd, nem a szándék ellen; és a megbízott a
// jelmondatot bármikor átadhatja — az ő döntése, pont ez a lényeg.
//
// Ez a fájl TISZTA (nincs Node-függőség): a felület is betölti. A lenyomat
// számolása a segédben van (helper/partner-crypto.ts), mert az scrypt a Node
// `crypto`-ja. A Kotlin és a Swift oldal ugyanezt tükrözi (Partner.kt,
// Partner.swift), a lenyomat pedig nyelvfüggetlen: a jelmondat egy eszközön
// születik, és bármelyik másikon ellenőrizhető.

import { CONTROL_CHARS } from './alias.js';

/** A jelmondat szavainak száma — a próbatételek szólistájából. */
export const PARTNER_PHRASE_WORDS = 4;
/** A megbízott nevének hossza felülről kötve — a felületen is ki kell férnie. */
export const MAX_PARTNER_NAME = 40;
/** Ennyi rossz jelmondat után a kísérlet érvénytelen: elölről, minden lépéssel. */
export const MAX_PARTNER_TRIES = 5;

export interface PartnerLock {
  /** a megbízott neve, ahogy a felület mondja: „Kérd meg Annát” */
  name: string;
  /** a lenyomat sója, base64 — eszközönként más, ha újra felveszik */
  salt: string;
  /** a jelmondat scrypt-lenyomata, base64 — a jelmondat maga sehol nincs */
  hash: string;
  /** mikor vették fel */
  setAt: number;
}

/**
 * A jelmondat KANONIKUS alakja — ezt hasoljuk, és ezt hasonlítjuk. Kis-nagybetű,
 * dupla szóköz, sorvégi szóköz nem számít: a megbízott nem gépíró, a jelmondat
 * meg nem jelszó, hanem négy szó. NFKC, hogy ugyanaz a leütött szöveg ugyanaz
 * a bájtsor legyen minden platformon (ékezetes szónál ez nem elmélet).
 */
export function normalizePhrase(raw: string): string {
  return raw.normalize('NFKC').replace(CONTROL_CHARS, ' ').trim().toLowerCase().split(/\s+/).join(' ');
}

/** A megbízott neve tisztán — vagy null, ha nem maradt belőle semmi. */
export function normalizePartnerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.normalize('NFKC').replace(CONTROL_CHARS, ' ').trim().split(/\s+/).join(' ');
  if (cleaned === '') return null;
  return [...cleaned].slice(0, MAX_PARTNER_NAME).join('');
}

/** A tárból vagy a szinkronból jött rekord, ha jó alakú — különben semmi. */
export function normalizePartnerLock(raw: unknown): PartnerLock | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<PartnerLock>;
  const name = normalizePartnerName(o.name);
  if (!name) return null;
  if (typeof o.salt !== 'string' || !/^[A-Za-z0-9+/=]{16,64}$/.test(o.salt)) return null;
  if (typeof o.hash !== 'string' || !/^[A-Za-z0-9+/=]{32,96}$/.test(o.hash)) return null;
  const setAt = typeof o.setAt === 'number' && Number.isFinite(o.setAt) ? o.setAt : 0;
  return { name, salt: o.salt, hash: o.hash, setAt };
}

/** A rekord tartalmi kulcsa a lenyomatokhoz és az összevetéshez. */
export function partnerKey(p: PartnerLock | null | undefined): string {
  return p ? [p.salt, p.hash, p.name, p.setAt].join('|') : '';
}

/**
 * A párban zárolás fésülése két eszköz között — a zárlat-ablakok mintája:
 * nagyobb jel nyer (a jel a blob `rev`-je, amelyik utoljára állította vagy
 * vette le). Azonos jelnél a BEÁLLÍTOTT nyer (a szigorúbb irány); ha mindkét
 * oldalon van, a korábban felvett — az a régebbi ígéret. Így a levétel
 * (próbatétel, ami lépteti a jelet) átmegy, de egy másik eszköz
 * csomag-szerkesztése nem viszi el a megbízottat.
 */
export function mergePartner(
  localRev: number, local: PartnerLock | undefined,
  incomingRev: number, incoming: PartnerLock | undefined,
): PartnerLock | undefined {
  if (incomingRev > localRev) return incoming;
  if (localRev > incomingRev) return local;
  if (local && incoming) return local.setAt <= incoming.setAt ? local : incoming;
  return local ?? incoming;
}
