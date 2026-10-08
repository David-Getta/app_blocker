// Indítási füstpróba (`--smoke-test`): az app TÉNYLEG elindul-e.
//
// A tesztek a magot futtatják, a renderer-füstteszt a felületet egy sima
// böngészőben — azt viszont semmi nem nézte, hogy maga az Electron-app
// feláll-e: a fő folyamat, a preload, a felület és a kettő közti híd együtt.
// Egy Electron-frissítés, egy hiányzó fájl a csomagban vagy egy elkapatlan
// hiba a fő folyamatban mind ugyanazt adja: az app el sem indul. És mivel a
// telepített appok maguktól frissülnek, egy ilyen kiadás minden gépre
// kimenne — az el nem induló app pedig a következő javítást már nem tudja
// letölteni.
//
// A próba a rendes indulást futtatja végig (ablak, híd, mérés, gyorsbillentyű,
// bővítmény-híd), csak azt hagyja ki, aminek a gépen nyoma maradna vagy a
// hálózatra menne: a bejelentkezéskori indítást és a frissítés-keresést. Akkor
// zöld, ha a felület a saját indító kódjában kiírta az app verzióját — ehhez a
// renderer indító kódjának végig kell futnia, és a hídon át válaszolnia kell a
// fő folyamatnak.

import { app, type BrowserWindow } from 'electron';
import * as fs from 'fs';
import { isSmoke, versionRowText } from '../shared/smoke';

export { isSmoke };

/** Mennyi ideje van az appnak felállni. A CI futója lassú és ingadozó. */
const SMOKE_DEADLINE_MS = 45_000;

let finished = false;

function finish(ok: boolean, line: string): void {
  if (finished) return;
  finished = true;
  const text = `[smoke] ${ok ? 'OK' : 'HIBA'} — ${line}`;
  console.log(text);
  // Windowson a grafikus app kimenete nem mindig jut el a hívó konzoljáig; a
  // CI ezért egy fájlból is kiolvashatja az eredményt.
  const out = process.env.BREAKER_SMOKE_OUT;
  if (out) {
    try { fs.appendFileSync(out, `${text}\n`); } catch { /* a kilépési kód így is beszél */ }
  }
  app.exit(ok ? 0 : 1);
}

/**
 * Az indulás legelején. Egy elkapatlan hiba a fő folyamatban alapból egy
 * PÁRBESZÉDABLAKOT nyit — a CI-ban azt senki nem kattintja el, és a lépés a
 * saját időkorlátjáig állna. Itt kiírjuk, és pirossal kilépünk.
 */
function armSmoke(): void {
  process.on('uncaughtException', (err) => {
    finish(false, `elkapatlan hiba a fő folyamatban: ${err?.stack ?? String(err)}`);
  });
  setTimeout(() => {
    finish(false, `az app ${SMOKE_DEADLINE_MS / 1000} másodperc alatt sem állt fel`);
  }, SMOKE_DEADLINE_MS);
}

/** A fő ablakra: a betöltés előtt kell rákötni, különben lekéshetünk egy hibát. */
export function watchSmoke(win: BrowserWindow): void {
  const wc = win.webContents;
  wc.on('preload-error', (_e, preloadPath, error) => {
    finish(false, `a preload elhasalt (${preloadPath}): ${error.message}`);
  });
  wc.on('render-process-gone', (_e, details) => {
    finish(false, `a felület folyamata leállt: ${details.reason}`);
  });
  wc.on('did-fail-load', (_e, code, description) => {
    finish(false, `a felület nem töltött be: ${code} ${description}`);
  });
  wc.once('did-finish-load', () => { void probe(win); });
}

async function probe(win: BrowserWindow): Promise<void> {
  const want = versionRowText(app.getVersion());
  let got = '';
  // Húsz másodperc, kétszázad-másodpercenként: a verzió a hídon át jön, egy
  // hideg indulásnál ez lehet pár másodperc.
  for (let i = 0; i < 100 && !finished; i++) {
    if (win.isDestroyed()) return finish(false, 'a fő ablak megszűnt a próba közben');
    try {
      got = String(await win.webContents.executeJavaScript(
        "document.getElementById('appVersionRow')?.textContent ?? ''",
      ));
    } catch (err) {
      return finish(false, `a felületen nem futott le a vizsgálat: ${(err as Error).message}`);
    }
    if (got === want) {
      // Az automatikus frissítő az app egyetlen futásidejű függősége. Ha
      // kimarad a csomagból, az app elindul, csak épp soha többé nem frissül —
      // és ezt semmi nem jelezné.
      try {
        require.resolve('electron-updater');
      } catch {
        return finish(false, 'az automatikus frissítő (electron-updater) hiányzik a csomagból');
      }
      return finish(true, `${want}: a felület betöltött, a renderer indító kódja végigfutott, `
        + 'a híd válaszol, a frissítő betölthető');
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  finish(false, `a felület nem írta ki a verziót (${JSON.stringify(got)} helyett ${JSON.stringify(want)}) — `
    + 'a renderer indító kódja elakadt, vagy a híd nem válaszol');
}

// A modul betöltésekor élesedik, nem egy későbbi hívásra — ezért a main.ts
// ELSŐ importja: így a többi modul betöltési hibáját is elkapja.
if (isSmoke(process.argv)) armSmoke();
