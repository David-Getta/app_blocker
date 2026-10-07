// Az app a háttérben: az ablak bezárása nem állítja le, és bejelentkezéskor
// magától indul — ablak nélkül.
//
// MIÉRT. A tiltást a segéd tartja, az app nélkül is. A MÉRÉS viszont nem a
// segédben fut, hanem az appban: macOS-en a root démon nem lát bele a
// felhasználó munkamenetébe, Windowson a SYSTEM-feladat a 0. munkamenetben ül
// — egyik sem tudja, melyik ablak van előtérben (lásd main/tracker.ts). A
// napi keret és az adag a mért időből fogy, tehát eddig az ablak bezárása —
// ami az egész appot leállította — ingyen kikapcsolta mindkettőt, és vele a
// gépi értesítéseket is (azokat az ablak tartalma adja). Ugyanígy egy
// újraindítás után, amíg senki nem nyitotta meg az appot.
//
// Ezért az ablak bezáráskor ELREJTŐZIK (a tartalma fut tovább: az értesítések
// innen jönnek), és bejelentkezéskor az app rejtve indul. Kilépni továbbra is
// lehet — szándékos lépéssel, és a felület kimondja, mi áll meg vele.
//
// Ami itt van, az a tiszta, tesztelhető rész: a kapcsoló, a bezárás döntése és
// a macOS indító-ügynök leírója. Az Electron-hívások a main.ts-ben vannak.

/** Ezzel a kapcsolóval indul a bejelentkezéskor: ablak nélkül, a háttérben. */
export const BACKGROUND_FLAG = '--background';

/** A macOS felhasználói indító-ügynök címkéje (~/Library/LaunchAgents). */
export const LAUNCH_AGENT_LABEL = 'hu.breaker.agent';

/** A Windows indítási bejegyzés neve (HKCU\…\CurrentVersion\Run). */
export const WINDOWS_RUN_NAME = 'Breaker';

/** Rejtve indul-e: a bejelentkezéskori indítás ezzel a kapcsolóval jön. */
export function startsHidden(argv: readonly string[]): boolean {
  return argv.includes(BACKGROUND_FLAG);
}

/**
 * Mi történjen, amikor a felhasználó bezárja az ablakot.
 *
 * Kilépés közben (a menü, a tálca, a frissítés telepítése) az ablak tényleg
 * bezárul — különben a kilépés sosem érne véget. Minden más esetben csak
 * elrejtőzik: a mérés és az értesítések a háttérben futnak tovább.
 */
export function closeAction(quitting: boolean): 'hide' | 'close' {
  return quitting ? 'close' : 'hide';
}

/**
 * Használható-e ez az útvonal az indító-ügynökben. Ha a rendszer a letöltött,
 * aláíratlan appot egy ideiglenes, csak olvasható helyről futtatja
 * („App Translocation”), az útvonal a következő indításkor már nem létezik —
 * egy ilyenre mutató ügynök csendben semmit nem indítana. Ilyenkor nem írunk,
 * és a következő, rendes helyről indított futás pótolja.
 */
export function launchAgentUsable(execPath: string): boolean {
  return /\.app\/Contents\/MacOS\/[^/]+$/.test(execPath) && !execPath.includes('/AppTranslocation/');
}

/** XML-szöveg idézése a plist-be: egy `&` vagy `<` az útvonalban se törje el. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * A macOS indító-ügynök leírója: bejelentkezéskor egyszer elindítja az appot,
 * rejtve. Nem tartja életben (nincs KeepAlive): a szándékos kilépés kilépés
 * marad, nem ugrik vissza — a felület ezt kimondja, nem kerüli meg.
 *
 * Miért nem a rendszer „bejelentkezési elemek” hívása: macOS 13 óta az nem
 * ad át kapcsolót, és azt sem árulja el, hogy bejelentkezéskor indultunk —
 * az app az ablakával nyílna meg minden reggel. Az ügynöknek megadható a
 * kapcsoló.
 */
export function launchAgentPlist(execPath: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCH_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xmlEscape(execPath)}</string>`,
    `    <string>${BACKGROUND_FLAG}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>LimitLoadToSessionType</key>',
    '  <string>Aqua</string>',
    '  <key>ProcessType</key>',
    '  <string>Interactive</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
