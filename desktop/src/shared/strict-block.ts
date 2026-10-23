// A SZIGORÚ BLOKK: amit a segéd őre tart, ha az app eltűnt.
//
// MIÉRT. A segéd az app saját binárisán fut (macOS-en ELECTRON_RUN_AS_NODE-dal
// az app.asar-ból, Windowson Breaker.exe --helper). Ha az appot törlik, a
// segéd a következő indulástól nem fut, és a hosts-blokk BEFAGY abban az
// állapotban, ahogy a törléskor állt: ami épp szünetben volt, nyitva marad, a
// menetrend, a napi keret és a munkamenet nem zár többé. macOS-en a saját
// telepítésű Breaker.app jelszó nélkül a Kukába húzható — ez ingyenes lazítás
// lett volna.
//
// Ezért a segéd minden változáskor kiír egy SZIGORÚ blokkot: a lista minden
// oldalának minden nevét, szünettől, menetrendtől, kerettől függetlenül (és
// mindazt, ami épp tiltva van). Egy külön, kicsi őr (macOS: LaunchDaemon,
// Windows: ütemezett feladat — install-script.ts) csak akkor nyúl a hosts
// fájlhoz, ha az app binárisa eltűnt: akkor ezt a blokkot teszi a helyére, és
// tartja. Ha az app visszakerül, a segéd újra indul és a saját blokkját írja.
//
// A fájl alakja maga a kész hosts-blokk (a jelölők, egy magyarázó sor, a
// tiltó sorok). Az őr ebből csak a tiltó sorokat és a megjegyzést veszi át,
// mindegyiket a segéd saját mintájával ellenőrizve (STRICT_BLOCK_LINE_SOURCE):
// egy elrontott vagy idegen sor így sem tud egy nevet máshova irányítani —
// és nem is akasztja meg az egészet, csak kimarad. Méretkorlát nincs: a
// segéd élő blokkja ugyanekkora, és egy korlát ingyenes kiskapu volna (egy
// nagyon hosszú lista után az őr semmit nem írna).

import { buildManagedBlock, DOMAIN_RE_SOURCE, MARKER_BEGIN, MARKER_END, normalizeHostname } from './blocklist';

/** Egy tiltó sor mintája: 0.0.0.0 vagy :: és egy hosztnév — semmi más. */
export const STRICT_BLOCK_LINE_SOURCE = `(0\\.0\\.0\\.0|::) ${DOMAIN_RE_SOURCE}`;

/** Egy szigorú blokk sorának mintája (a jelölőkön kívül): megjegyzés vagy tiltó sor. */
export const STRICT_LINE_SOURCE = `#.*|${STRICT_BLOCK_LINE_SOURCE}`;

const STRICT_LINE_RE = new RegExp(`^(${STRICT_LINE_SOURCE})$`);

/**
 * A magyarázó sor — a hosts fájlban ez mondja meg annak, aki belenéz, miért
 * tilt minden, és hogyan lehet teljesen eltávolítani. Az őr akkor is ezt teszi
 * a helyére, ha az app eltűnt, és akkor is, ha a helyén van, de a segéd nem
 * indul el.
 */
export function strictNote(platform: string, uninstallPath: string): string {
  const how = platform === 'win32'
    ? `powershell -ExecutionPolicy Bypass -File "${uninstallPath}"`
    : `sudo sh "${uninstallPath}"`;
  return '# Breaker: a védelem segédje nem fut (az app hiányzik, vagy nem indul el), ezért a teljes lista tilt. '
    + 'Ha az app a helyén van és a segéd újra fut, minden a régi. '
    + `Teljes eltávolítás rendszergazdaként: ${how}`;
}

/** A szigorú blokk nevei: a lista minden oldalának minden neve, és ami most tiltva van. */
export function strictHostnames(sites: ReadonlyArray<{ hostnames: readonly string[] }>, active: readonly string[]): string[] {
  const set = new Set<string>();
  for (const s of sites) for (const h of s.hostnames) set.add(h);
  for (const h of active) set.add(h);
  // Ugyanaz a szűrő, mint a blokké (buildManagedBlock): ami nem hosztnév-alakú,
  // az nem kerülhet a root/SYSTEM által írt fájlba.
  return [...set].filter((h) => normalizeHostname(h) === h).sort();
}

/**
 * A kész szigorú blokk (a jelölőkkel, a magyarázó sorral), soremeléssel a
 * végén. Üres listánál üres szöveg: ha nincs mit tiltani, az őr se írjon a
 * hosts fájlba egy magányos megjegyzést.
 */
export function renderStrictBlock(names: readonly string[], note: string): string {
  const block = buildManagedBlock([...names], 'any');
  if (block === '') return '';
  const lines = block.split('\n');
  // A magyarázat a nyitó jelölő után — egy sor, soremelés nélkül.
  const oneLine = `# ${note.replace(/^#\s*/, '').replace(/[\r\n]+/g, ' ')}`;
  lines.splice(1, 0, oneLine);
  return `${lines.join('\n')}\n`;
}

/** A blokk alakja: jelölők a helyükön, minden más sor megjegyzés vagy tiltó sor. */
export function isValidStrictBlock(text: string): boolean {
  if (!text.endsWith('\n')) return false;
  const lines = text.slice(0, -1).split('\n');
  if (lines.length < 2 || lines[0] !== MARKER_BEGIN || lines[lines.length - 1] !== MARKER_END) return false;
  return lines.slice(1, -1).every((l) => STRICT_LINE_RE.test(l));
}
