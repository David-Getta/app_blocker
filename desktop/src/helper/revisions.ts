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
    // Az adag-szabály beállítása utazik; a számláló nem (eszköz-helyi).
    s.burstSeconds ?? null,
    s.cooldownSeconds ?? null,
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
    if (site.revFp === fp) {
      // Frissítés utáni első kör: a lista még nincs eltéve — innentől van.
      if (!site.revHosts) site.revHosts = [...site.hostnames];
      continue;
    }
    site.rev = (site.rev ?? 0) + 1;
    site.updatedAt = now;
    site.updatedBy = deviceId;
    site.revFp = fp;
    markHostnames(site);
    changed++;
  }
  if (bumpFocusRevision(state, deviceId, now)) changed++;
  if (bumpChannelsRevision(state, deviceId, now)) changed++;
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
/**
 * A lenyomat formátumának jele.
 *
 * Azért van benne, hogy a formátumváltás FELISMERHETŐ legyen. Enélkül egy
 * régi alakú lenyomat egyszerűen „másnak” látszana, és a frissítés utáni első
 * kör mindenkinél léptetne egyet — ami egy ÜRES eszközön azt jelentené, hogy
 * az üres lista legyőzi a gépen felvett csomagokat. Pont az a hiba, ami
 * egyszer már majdnem megtörtént.
 */
const FOCUS_FP_V2 = '2|';

function packsPart(state: HelperState): unknown[] {
  return [...(state.focusPacks ?? [])]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => [
      p.id, p.name, [...p.allowSites].sort(), [...p.allowApps].sort(), p.defaultMinutes,
      // Az ismétlődés is a csomag beállítása: a cseréje döntés, tehát léptet.
      // CSAK HA VAN: egy ablak nélküli csomag lenyomata ugyanaz marad, mint a
      // frissítés előtt — különben minden eszköz minden csomagja egyszer
      // fölöslegesen léptetne, és a régi formátum felismerése is elromlana.
      ...(p.recurrence
        ? [[[...p.recurrence.days].sort(), p.recurrence.startMin, p.recurrence.endMin]] : []),
    ]);
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * A RÉGI lenyomat — kizárólag a formátumváltás felismeréséhez.
 *
 * Ne épüljön rá semmi új. Az egyetlen dolga, hogy a lemezen talált, régi alakú
 * lenyomatról el tudjuk dönteni: az azóta VÁLTOZATLAN állapothoz tartozik-e,
 * vagy közben valódi szerkesztés is történt. Enélkül a váltás vagy elnyelne
 * egy szerkesztést, vagy fölöslegesen léptetne — és mindkettőnek ára van.
 */
function focusFingerprintV1(state: HelperState): string {
  const run = state.focusRun
    ? [state.focusRun.packId, state.focusRun.startedAt, state.focusRun.endsAt]
    : null;
  return digest([packsPart(state), run]);
}

function focusFingerprint(state: HelperState): string {
  // A futás HOSSZA számít, nem az abszolút időpontjai.
  //
  // Ez zárja be az óra-átállítás rését. Alvásból ébredve a segéd elnyeli az
  // ugrást: a kezdést és a véget UGYANANNYIVAL tolja el, hogy a menet ne
  // legyen „lejárt”. Abszolút időpontokkal ez változásnak látszott, tehát
  // léptette a számlálót — és így az alvó eszköz „még fut” állapota legyőzte
  // az ébren lévő eszköz szabályos lezárását. Az elnyelés viszont nem döntés,
  // csak helyi újraértelmezés; a HOSSZ pedig egy egyenletes eltolástól nem
  // változik, tehát nincs is mit léptetni.
  //
  // AMI EZZEL VAKFOLT LESZ, kimondva: ha ugyanazt a csomagot ugyanolyan
  // hosszan leállítod és újraindítod EGY mentési ablakon belül (~20 mp), a
  // lenyomat azonos marad, tehát a számláló nem lép. A tartalom viszont
  // ilyenkor is felmegy, és azonos számlálónál a szigorúbb — a később végződő
  // — menet nyer, tehát ez legfeljebb pár másodperc csúszás, nem kibúvó.
  const run = state.focusRun
    ? [state.focusRun.packId, state.focusRun.endsAt - state.focusRun.startedAt]
    : null;
  return FOCUS_FP_V2 + digest([packsPart(state), run]);
}

/** @returns változott-e a munkamenet ezen a gépen az előző kör óta */
export function bumpFocusRevision(
  state: HelperState, deviceId: string, now: number,
): boolean {
  const fp = focusFingerprint(state);
  if (state.focusRevFp === fp) return false;

  // FORMÁTUMVÁLTÁS. A lemezen még a régi alakú lenyomat van; ettől önmagában
  // nem történt semmi. A régi algoritmussal döntjük el, volt-e valódi
  // változás: ha a régi lenyomat egyezik a MAI állapot régi lenyomatával,
  // akkor csak a formátum változott — átvesszük az újat, léptetés nélkül.
  // Ha eltér, akkor VOLT szerkesztés, és az ugyanúgy léptet, mint bármikor.
  //
  // Így a váltásnak nincs ablaka: sem egy szerkesztést nem nyel el, sem
  // fölöslegesen nem léptet egy üres eszközön.
  if (state.focusRevFp !== undefined && !state.focusRevFp.startsWith(FOCUS_FP_V2)) {
    if (state.focusRevFp === focusFingerprintV1(state)) {
      state.focusRevFp = fp;
      return false;
    }
  }

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
 * A csatorna-szűrők lenyomata — a szinkron szempontjából érdekes mezők.
 *
 * Az engedélylista RENDEZVE, mint a részleges szabályok: a sorrend nem jelent
 * semmit, és ha beleszámítana, egy átrendeződés fölöslegesen léptetne. A
 * szűrők azonosító szerint rendezve, mert a lista sorrendje sem jelentés.
 */
function channelsFingerprint(state: HelperState): string {
  const rows = [...(state.channelFilters ?? [])]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((f) => [f.id, f.host, [...f.allow].sort(), f.enabled]);
  return digest(rows);
}

/** @returns változott-e a csatorna-szűrők állapota ezen a gépen */
export function bumpChannelsRevision(
  state: HelperState, deviceId: string, now: number,
): boolean {
  const fp = channelsFingerprint(state);
  if (state.channelsRevFp === fp) return false;
  // AZ ÜRESSÉG NEM SZERKESZTÉS — ugyanaz a védelem, mint a munkamenetnél:
  // egy eszköz, ami még sosem látott szűrőt, ne kapjon 1-es számlálót az
  // első lenyomat-számolástól, mert frissebb idejével az ÜRES listája nyerne,
  // és csendben letörölné a másik gépen felvett szűrőket.
  if (state.channelsRevFp === undefined && (state.channelFilters ?? []).length === 0) {
    state.channelsRevFp = fp;
    return false;
  }
  state.channelsRev = (state.channelsRev ?? 0) + 1;
  state.channelsUpdatedAt = now;
  state.channelsUpdatedBy = deviceId;
  state.channelsRevFp = fp;
  return true;
}

/** Egy távolról átvett csatorna-lista lenyomatának újraszámolása. */
export function adoptChannelsRevision(state: HelperState): void {
  state.channelsRevFp = channelsFingerprint(state);
}

/**
 * Egy távolról érkezett rekord átvétele.
 *
 * A lenyomatot ÚJRASZÁMOLJUK, nem a másik eszközét vesszük át: így ha a két
 * oldal ugyanarra a tartalomra jutott, a következő `commit()` nem lépteti
 * fölöslegesen a számlálót, és nem indul be egy végtelen oda-vissza írás.
 */
export function adoptRevision(site: SiteRec): SiteRec {
  return { ...site, revFp: fingerprint(site), revHosts: [...site.hostnames] };
}

/** Ennyi jelnél többet nem hordunk egy oldalon; a levett nevek jele a legrégebbitől esik ki. */
const MAX_HOSTNAME_MARKS = 64;

/**
 * A hosztnevek jelei: ami az utolsó léptetés óta bekerült vagy kikerült, az
 * ezt a rev-et kapja. A szinkron ebből tudja nevenként, melyik eszköz
 * mondta az újabbat (shared/sync/merge.ts, `withHostnames`).
 *
 * Itt és nem a referee két pontján: a lista változásának EGY fogópontja
 * van, ez — egy jövőbeli harmadik szerkesztő út se felejtheti el a jelet.
 * Az első léptetés (nincs még eltett lista) jel nélkül megy: az oldal
 * felvételekor kapott nevek nem kapnak jelet, azokra a bővebb-nyer szabály
 * áll, ahogy a régi klienseknél is.
 */
function markHostnames(site: SiteRec): void {
  const prev = site.revHosts;
  site.revHosts = [...site.hostnames];
  if (!prev || site.rev === undefined) return;
  const before = new Set(prev);
  const after = new Set(site.hostnames);
  const marks = { ...(site.hostnameMarks ?? {}) };
  for (const h of after) if (!before.has(h)) marks[h] = site.rev;
  for (const h of before) if (!after.has(h)) marks[h] = site.rev;
  // Korlát: a levett nevek jelei gyűlnek; a legrégebbiek esnek ki, a
  // meglévő nevek jele marad.
  const entries = Object.entries(marks);
  if (entries.length > MAX_HOSTNAME_MARKS) {
    const gone = entries.filter(([h]) => !after.has(h)).sort((x, y) => x[1] - y[1]);
    for (const [h] of gone) {
      if (Object.keys(marks).length <= MAX_HOSTNAME_MARKS) break;
      delete marks[h];
    }
  }
  if (Object.keys(marks).length > 0) site.hostnameMarks = marks;
  else delete site.hostnameMarks;
}
