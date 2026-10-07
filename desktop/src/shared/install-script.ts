// A segéd telepítésének EMELT része — fájl nélkül.
//
// MIÉRT. A telepítés eddig egy szkriptet és egy plistet írt a felhasználó
// temp könyvtárába, és AZT futtatta rendszergazdaként. A név véletlen volt, a
// könyvtár 0700 — de a SAJÁT felhasználóként már kódot futtató támadó a saját
// könyvtárába beleír, tehát a kiírás és az emelt futtatás közötti pillanatban
// kicserélhette a tartalmat, és root/SYSTEM jogot szerzett vele.
//
// Most nincs mit kicserélni: az emelt folyamat a teljes parancsot a
// parancssorában kapja meg, az pedig az indítás után nem írható át.
//   - macOS: `do shell script "…" with administrator privileges` — a plist
//     base64-ben a parancsban (a base64 betűkészlete egyik idézésben sem
//     különleges), a gyökér-héj maga írja ki a helyére.
//   - Windows: `powershell -EncodedCommand …` — a szkript UTF-16LE base64-ben.
//
// Tiszta és függőség nélküli: a main/install.ts csak lefuttatja, amit itt
// összerakunk — így tesztelhető, hogy a parancsból VISSZAFEJTHETŐ pontosan az,
// amit írni akartunk.

/** A segéd LaunchDaemon-címkéje (macOS) és ütemezett feladata (Windows). */
export const DAEMON_LABEL = 'hu.breaker.helper';
export const TASK_NAME = 'BreakerHelper';

/** XML-szöveg idézése a plist-be. */
function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A segéd LaunchDaemon-leírója. A telepítő felhasználó azonosítója a démon
 * kapcsolói közé kerül, hogy a root segéd a socketjét erre a fiókra szűkíthesse
 * (lásd helper/server.ts).
 */
export function launchdPlist(execPath: string, helperEntry: string, ownerUid: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(execPath)}</string>
    <string>${xmlEscape(helperEntry)}</string>
    <string>--owner-uid=${ownerUid}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Library/Logs/Breaker/helper.log</string>
  <key>StandardErrorPath</key><string>/Library/Logs/Breaker/helper.log</string>
</dict>
</plist>
`;
}

/** AppleScript-szöveg: a `\` és a `"` idézve — más nem különleges benne. */
export function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * A macOS gyökér-héj parancsa: könyvtárak, a plist kiírása base64-ből, jogok,
 * a démon újraindítása. EGY sor, `;`-vel: a `set -e` miatt az első hiba
 * megállítja, a `bootout` hibája (nem futott még) szándékosan elnyelve.
 */
export function macInstallShell(plist: string): string {
  const b64 = Buffer.from(plist, 'utf8').toString('base64');
  const target = `/Library/LaunchDaemons/${DAEMON_LABEL}.plist`;
  return [
    'set -e',
    'mkdir -p "/Library/Application Support/Breaker" /Library/Logs/Breaker',
    `printf '%s' '${b64}' | /usr/bin/base64 -D > ${target}`,
    `chown root:wheel ${target}`,
    `chmod 644 ${target}`,
    `launchctl bootout system/${DAEMON_LABEL} 2>/dev/null || true`,
    `launchctl bootstrap system ${target}`,
  ].join('; ');
}

/** Az `osascript -e` argumentuma: a teljes gyökér-parancs, idézve. */
export function macInstallAppleScript(plist: string): string {
  return `do shell script ${appleScriptString(macInstallShell(plist))} with administrator privileges`;
}

/** PowerShell egyszeres idézőjeles szöveg belseje: a `'` duplázva. */
export function psSingleQuoted(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Az emelt PowerShell szkriptje: a SYSTEM-feladat felvétele és indítása. A
 * belső hiba nem nulla kilépés — a külső, nem emelt héj ezt adja tovább.
 */
export function windowsInstallScript(exe: string): string {
  const action = `"${exe}" --helper`;
  return [
    'try {',
    `  schtasks /Create /F /TN "${TASK_NAME}" /SC ONSTART /RU SYSTEM /RL HIGHEST /TR ${psSingleQuoted(action)}`,
    '  if ($LASTEXITCODE -ne 0) { exit 1 }',
    `  schtasks /Run /TN "${TASK_NAME}"`,
    '  if ($LASTEXITCODE -ne 0) { exit 2 }',
    '  exit 0',
    '} catch { exit 3 }',
  ].join('\n');
}

/** A `-EncodedCommand` értéke: a szkript UTF-16LE-ben, base64-gyel. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * A külső, NEM emelt PowerShell parancsa: elindítja az emelt példányt a
 * kódolt szkripttel, megvárja, és a kilépési kódját adja tovább (a
 * `Start-Process -Wait` magában mindig nullával lépne ki).
 */
export function windowsLauncherCommand(exe: string): string {
  const encoded = encodePowerShell(windowsInstallScript(exe));
  return '$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden '
    + `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'; exit $p.ExitCode`;
}
