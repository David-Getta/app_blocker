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

import { CLIENT_KEY_ARG, isKeyHash } from './client-key';

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
 * A segéd ütemezett feladatának beállításai (PowerShell-kifejezés). A
 * telepítés ÉS a segéd induláskori önjavítása (helper/win-task.ts) ezt
 * használja, hogy egy régebben felvett feladat is ide álljon.
 *
 * A Feladatütemező alapértékei egy őrző szolgáltatásnak mind rosszak:
 *   - akkumulátoron NEM indul, és leáll, ha a gép akkumulátorra vált — egy
 *     laptopon a töltő kihúzása leállította volna a segédet;
 *   - a schtasks-szal felvett feladatot 72 óra futás után leállítja — egy
 *     alvással-ébredéssel napokig futó gépen a segéd csendben megszűnt volna;
 *   - hibás kilépés után nem indítja újra (macOS-en ezt a KeepAlive adja).
 */
export const WINDOWS_TASK_SETTINGS_PS = 'New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries '
  + '-DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 '
  + '-RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew';

/**
 * Az emelt PowerShell szkriptje: a SYSTEM-feladat felvétele és indítása. A
 * belső hiba nem nulla kilépés — a külső, nem emelt héj ezt adja tovább.
 *
 * NEM schtasks: annak a /TR kapcsolója egyetlen szövegben kéri az exe-t és a
 * kapcsolóit, az exe útját idézőjelben — a Windows PowerShell 5.1 viszont egy
 * natív parancs argumentumában a belső idézőjelet nem védi, így a
 * „C:\Program Files\…” útnál a schtasks a „Files\…” részt külön, érvénytelen
 * kapcsolónak vette, és a telepítés hibával megállt. A v0.1 óta így volt; a
 * becsomagolt segéd CI-próbája (win-install-probe.ps1) találta meg. A
 * ScheduledTasks-parancsok az exe-t és a kapcsolókat külön kapják: nincs mit
 * rosszul idézni.
 */
export function windowsInstallScript(exe: string, keyHash: string): string {
  // A lenyomat a parancssorba kerül: csak a szigorú alak mehet át (hexa),
  // így idézőjel vagy szóköz sem csúszhat bele.
  if (!isKeyHash(keyHash)) throw new Error('érvénytelen kulcs-lenyomat');
  const task = psSingleQuoted(TASK_NAME);
  return [
    "$ErrorActionPreference = 'Stop'",
    // A futó régi példány le: enélkül az indítás nem indítana újat (a feladat
    // már fut), és az új kulcs csak a következő rendszerindításkor élne. Ha
    // nem fut, vagy még nincs ilyen feladat, a hiba lényegtelen.
    `try { Stop-ScheduledTask -TaskName ${task} } catch { }`,
    'try {',
    `  $action = New-ScheduledTaskAction -Execute ${psSingleQuoted(exe)} -Argument ${psSingleQuoted(`--helper ${CLIENT_KEY_ARG}${keyHash}`)}`,
    '  $trigger = New-ScheduledTaskTrigger -AtStartup',
    "  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
    `  $settings = ${WINDOWS_TASK_SETTINGS_PS}`,
    `  Register-ScheduledTask -TaskName ${task} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
    '} catch { exit 1 }',
    `try { Start-ScheduledTask -TaskName ${task} } catch { exit 2 }`,
    'exit 0',
  ].join('\n');
}

/**
 * A segéd induláskori önjavítása (Windows, SYSTEM-ként): a saját feladatának
 * beállításai a fentiek legyenek. A v0.4.257 előtt felvett feladat (ha egy
 * szóköz nélküli útra mégis felkerült) a Feladatütemező alapértékein ült —
 * így az is ide áll, újratelepítés és jóváhagyás nélkül. Az indítást, a
 * felhasználót és a kulcsot nem érinti.
 */
export function windowsTaskSettingsRepairScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  Set-ScheduledTask -TaskName ${psSingleQuoted(TASK_NAME)} -Settings (${WINDOWS_TASK_SETTINGS_PS}) | Out-Null`,
    '} catch { exit 1 }',
    'exit 0',
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
export function windowsLauncherCommand(exe: string, keyHash: string): string {
  const encoded = encodePowerShell(windowsInstallScript(exe, keyHash));
  return '$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden '
    + `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'; exit $p.ExitCode`;
}
