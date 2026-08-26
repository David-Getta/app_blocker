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
    // A részleges szabályok RENDEZVE: a sorrend nem jelent semmit, viszont ha
    // beleszámítana, egy átrendeződés (például egy felvétel-törlés páros)
    // fölöslegesen léptetné a számlálót, és minden körben feltöltést indítana.
    s.rules ? [...s.rules].map((r) => `${r.host}${r.path}`).sort() : null,
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
  if (bumpFocusRevision(state, deviceId, now)) changed++;
  return changed;
}

/**
 * A munkamenet lenyomata.
 *
 * A futó menet BENNE VAN, ellentétben az oldalak szünetével — és ez a
 * különbség szándékos. A szünet eszközfüggő és fel sem megy a kiszolgálóra; a
 * munkamenet viszont a fiók egészére szól: ha a gépen elindítasz egy
 * fehérlistás menetet, a telefonon is annak kell érvényesnek lennie. Ha a futás
 * kimaradna a lenyomatból, az indítás sosem léptetné a számlálót, és a telefon
 * soha nem tudná meg, hogy fut valami.
 */
function focusFingerprint(state: HelperState): string {
  const packs = [...(state.focusPacks ?? [])]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => [p.id, p.name, [...p.allowSites].sort(), [...p.allowApps].sort(), p.defaultMinutes]);
  const run = state.focusRun
    ? [state.focusRun.packId, state.focusRun.startedAt, state.focusRun.endsAt]
    : null;
  return crypto.createHash('sha256').update(JSON.stringify([packs, run]))
    .digest('hex').slice(0, 16);
}

/** @returns változott-e a munkamenet ezen a gépen az előző kör óta */
export function bumpFocusRevision(
  state: HelperState, deviceId: string, now: number,
): boolean {
  const fp = focusFingerprint(state);
  if (state.focusRevFp === fp) return false;

  // AZ ÜRESSÉG NEM SZERKESZTÉS. Egy eszköz, ami még sosem látott munkamenetet,
  // ne lépjen 1-re pusztán attól, hogy először számolunk neki lenyomatot.
  //
  // Ha léptetne, a következő történne, és ez NEM elméleti: a telefon először
  // szinkronizál, a semmiből 1-es számlálót kap, az ideje pedig frissebb, mint
  // a gépé — így az „utolsó író nyer” szabály szerint az ÜRES listája nyerne, és
  // csendben letörölné a gépen felvett összes csomagot. Pont az a hibaosztály,
  // ami a részleges szabályoknál egyszer már majdnem megtörtént.
  //
  // Az oldalaknál ez nem fordulhat elő, mert ott rekordonként megy a számláló,
  // és egy üres listán nincs mit léptetni. Itt EGY blob utazik, tehát külön ki
  // kell mondani.
  if (state.focusRevFp === undefined && isEmptyFocus(state)) {
    state.focusRevFp = fp;
    return false;
  }

  state.focusRev = (state.focusRev ?? 0) + 1;
  state.focusUpdatedAt = now;
  state.focusUpdatedBy = deviceId;
  state.focusRevFp = fp;
  return true;
}

function isEmptyFocus(state: HelperState): boolean {
  return (state.focusPacks ?? []).length === 0 && !state.focusRun;
}

/**
 * Egy távolról átvett munkamenet lenyomatának újraszámolása.
 *
 * Ugyanaz az ok, mint az oldalaknál: ha a két oldal ugyanarra a tartalomra
 * jutott, a következő `commit()` ne léptesse fölöslegesen a számlálót, mert
 * abból végtelen oda-vissza írás lesz.
 */
export function adoptFocusRevision(state: HelperState): void {
  state.focusRevFp = focusFingerprint(state);
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
