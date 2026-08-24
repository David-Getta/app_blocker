// Verziószám-vezetés a szinkronhoz.
//
// Az összefésülés (shared/sync/merge.ts) azon áll, hogy minden oldal-rekordnak
// van egy `rev` számlálója, ami MINDEN érdemi változásnál nő. Ez dönti el, mikor
// mehet át egy lazítás a másik eszközre: a nagyobb `rev` mögött ott a munka.
//
// Kézzel vezetni katasztrófa lenne: a segédben tucatnyi helyen módosul egy
// rekord (szünet, menetrend, keret, fedőnév, törlés indítása és visszavonása),
// és elég egyetlen kihagyott hely ahhoz, hogy egy változás SOSE menjen át a
// másik eszközre — vagy fordítva, hogy egy régi állapot felülírja az újat.
//
// Ezért egyetlen fogópontban dolgozunk: a `commit()` elején. Minden rekordhoz
// eltesszük a szinkron szempontjából érdekes mezők LENYOMATÁT; ha az változott,
// a `rev` nő. A lenyomat a mentett állapotban van, nem a memóriában, tehát egy
// újraindítás nem hajtja fel a számlálót a semmiért.

import * as crypto from 'crypto';
import type { HelperState, SiteRec } from './state';

/**
 * Amit a szinkron lát egy rekordból.
 *
 * Csak ezek számítanak: ha egy mező itt nincs benne, a változása nem is
 * indokolja, hogy a másik eszköz felülírja a sajátját. (A `usedTodaySeconds`
 * például eszközfüggő mérés, nem beállítás — és a szünet is az.)
 */
function syncFields(s: SiteRec): string {
  return JSON.stringify([
    s.domain,
    [...s.hostnames].sort(),
    // A SZÜNET kimarad: eszközfüggő és rövid életű, fel se megy a
    // kiszolgálóra (lásd sync-client.ts). Ha itt benne lenne, minden feloldás
    // fölöslegesen léptetné a számlálót és indítana egy feltöltést.
    s.pendingDeleteAt,
    s.schedule ?? null,
    s.dailyLimitSeconds ?? null,
    s.alias ?? null,
  ]);
}

function fingerprint(s: SiteRec): string {
  return crypto.createHash('sha256').update(syncFields(s)).digest('hex').slice(0, 16);
}

/**
 * A megváltozott rekordok `rev` számlálójának léptetése.
 *
 * @returns hány rekord változott (a hívónak elég tudnia, hogy volt-e mit menteni)
 */
export function bumpRevisions(state: HelperState, deviceId: string, now: number): number {
  let changed = 0;
  for (const site of state.sites) {
    const fp = fingerprint(site);
    if (site.revFp === fp) continue;
    site.rev = (site.rev ?? 0) + 1;
    site.updatedAt = now;
    site.updatedBy = deviceId;
    site.revFp = fp;
    changed++;
  }
  return changed;
}

/**
 * Egy távolról érkezett rekord átvétele.
 *
 * A lenyomatot ÚJRASZÁMOLJUK, nem a másik eszközét vesszük át: így ha a két
 * oldal ugyanarra a tartalomra jutott, a következő `commit()` nem lépteti
 * fölöslegesen a számlálót, és nem indul be egy végtelen oda-vissza írás.
 */
export function adoptRevision(site: SiteRec): SiteRec {
  return { ...site, revFp: fingerprint(site) };
}
