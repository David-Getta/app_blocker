// A SEGÉD ŐRE: egy külön, kicsi feladat, ami csak akkor nyúl a hosts fájlhoz,
// ha az app binárisa eltűnt — akkor a szigorú blokkot (shared/strict-block.ts)
// teszi a helyére, és tartja.
//
// MIÉRT KÜLÖN. A segéd indítási útja (install-script.ts: launchdPlist,
// windowsInstallScript) bizonyított és CI-ban próbált — azt ez nem érinti,
// bájtra ugyanaz marad. Az őr egy második feladat:
//   - macOS: LaunchDaemon (hu.breaker.guard), percenként fut, /bin/sh-val;
//   - Windows: ütemezett feladat (BreakerGuard), induláskor és ötpercenként,
//     a rendszer saját PowerShelljével.
// A segéd maga telepíti (root/SYSTEM-ként, induláskor — helper/guard.ts),
// tehát a meglévő telepítéseken sem kell hozzá újabb jóváhagyás.
//
// MIKOR ÍR. Csak ha az app binárisa (vagy az app.asar) ELTŰNT, kétszer
// egymás után megnézve; macOS-en akkor sem, ha a segéd még fut (a törölt
// fájlból, újraindításig — lásd helper/code-watch.ts). Windowson egy
// frissítés pár percre kicseréli a fájlokat: ott a „nincs meg” állapotnak két
// ütemezett futáson át (öt percen át) meg kell maradnia. Ha az app a helyén
// van, az őr semmit nem csinál — kivéve Windowson, ahol a frissítés által
// leállított segédet újraindítja (a fájlok stabilak, telepítő nem fut).
//
// MIBEN BÍZIK. A szigorú blokk fájlját a segéd írja egy csak rootnak / csak
// SYSTEM-nek és rendszergazdáknak írható mappába; az őr ezt ellenőrzi
// (tulajdonos, jogok), és soronként is: csak a két jelölő, megjegyzés és
// 0.0.0.0 / :: tiltó sor lehet benne — más címre irányítani így sem lehet.
// Az őr egyetlen natív parancsot sem a PATH-ból keres.

import { MARKER_BEGIN, MARKER_END } from './blocklist';
import { DAEMON_LABEL, encodePowerShell, psSingleQuoted, TASK_NAME } from './install-script';
import { STRICT_LINE_SOURCE, STRICT_MAX_BYTES } from './strict-block';

export const GUARD_LABEL = 'hu.breaker.guard';
export const GUARD_TASK_NAME = 'BreakerGuard';
/** A szigorú blokk fájlneve a segéd állapotmappájában. */
export const STRICT_FILE = 'strict-hosts';
/** A szigorú blokk fájlneve a segéd állapotmappájában (Windows: a gone-jelző is ott). */
export const GUARD_GONE_FILE = 'guard-gone';

/** Shell egyszeres idézése: a ' helyén '\''. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ------------------------------------------------------------------ macOS

export interface MacGuardOptions {
  /** a segéd állapotmappája: itt a szigorú blokk, a napló és az őr maga */
  dir: string;
  /** a segéd LaunchDaemon-leírója: ebből olvassuk ki, hol az app */
  main: string;
  hosts: string;
  plistBuddy: string;
  launchctl: string;
  /** két megnézés között ennyi másodperc */
  settleSeconds: number;
  /** a megbízható tulajdonos (root) */
  ownerUid: number;
  /** a mappa szülei, amiknek szintén a rooté kell lenniük */
  trustChain: string[];
  /** a DNS-gyorsítótár ürítése */
  flush: string;
}

export const MAC_GUARD_DEFAULTS: MacGuardOptions = {
  dir: '/Library/Application Support/Breaker',
  main: `/Library/LaunchDaemons/${DAEMON_LABEL}.plist`,
  hosts: '/etc/hosts',
  plistBuddy: '/usr/libexec/PlistBuddy',
  launchctl: '/bin/launchctl',
  settleSeconds: 15,
  ownerUid: 0,
  trustChain: ['/', '/Library', '/Library/Application Support'],
  flush: '/usr/bin/dscacheutil -flushcache; /usr/bin/killall -HUP mDNSResponder',
};

/** Az őr útja macOS-en (a segéd állapotmappájában). */
export const MAC_GUARD_SCRIPT = `${MAC_GUARD_DEFAULTS.dir}/guard.sh`;

/**
 * Az őr shell-szkriptje (macOS). POSIX sh — a teszt Linuxon dash-sel, csonkolt
 * PlistBuddy-val és launchctl-lel futtatja, a CI-próba macOS-en élesben.
 */
export function macGuardScript(o: MacGuardOptions = MAC_GUARD_DEFAULTS): string {
  const lineRe = `^(${STRICT_LINE_SOURCE})$`;
  const awkRegion = 'BEGIN{b=ENVIRON["B"];e=ENVIRON["E"]} $0==b{p=1} p{print} $0==e{p=0}';
  const awkOutside = 'BEGIN{b=ENVIRON["B"];e=ENVIRON["E"];n=0} $0==b{s=1} !s{l[++n]=$0} $0==e{s=0} '
    + 'END{while(n>0&&l[n]=="")n--; for(i=1;i<=n;i++)print l[i]}';
  return [
    '#!/bin/sh',
    '# A Breaker őre — generált fájl (desktop/src/shared/guard-script.ts), kézzel ne szerkeszd.',
    '# Csak akkor ír a hosts fájlba, ha az app eltűnt: akkor a szigorú blokkot tartja.',
    'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
    'export PATH',
    'LC_ALL=C',
    'export LC_ALL',
    'umask 077',
    `DIR=${shQuote(o.dir)}`,
    `MAIN=${shQuote(o.main)}`,
    `HOSTS=${shQuote(o.hosts)}`,
    `PB=${shQuote(o.plistBuddy)}`,
    `LCTL=${shQuote(o.launchctl)}`,
    `STRICT="$DIR/${STRICT_FILE}"`,
    'LOG="$DIR/guard.log"',
    `B=${shQuote(MARKER_BEGIN)}`,
    `E=${shQuote(MARKER_END)}`,
    'export B E',
    `LINE=${shQuote(lineRe)}`,
    '',
    '# Napló: csak a megbízható mappába, ugyanazt kétszer egymás után nem.',
    'log() {',
    '  [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 262144 ] && : > "$LOG"',
    '  if [ -f "$LOG" ] && tail -n 1 "$LOG" | grep -Fq -- "$1"; then return; fi',
    '  printf \'%s %s\\n\' "$(date -u \'+%Y-%m-%dT%H:%M:%SZ\')" "$1" >> "$LOG" 2>/dev/null',
    '}',
    '',
    '# Egy út a rooté-e, és se a csoport, se más nem írhatja.',
    'trusted() {',
    `  [ -n "$(find "$1" -prune -user ${o.ownerUid} ! -perm -0020 ! -perm -0002 2>/dev/null)" ]`,
    '}',
    '',
    '# inert: nincs mit nézni (nincs segéd, vagy egy le nem csatolt kötetről fut);',
    '# alive: a segéd fut; present: az app a helyén van; gone: az app eltűnt.',
    'state() {',
    '  [ -f "$MAIN" ] || { echo inert; return; }',
    '  BIN=$("$PB" -c \'Print :ProgramArguments:0\' "$MAIN" 2>/dev/null) || { echo inert; return; }',
    '  ENTRY=$("$PB" -c \'Print :ProgramArguments:1\' "$MAIN" 2>/dev/null) || { echo inert; return; }',
    '  case "$BIN" in /*) ;; *) echo inert; return ;; esac',
    '  case "$ENTRY" in /*/app.asar/*) ;; *) echo inert; return ;; esac',
    '  case "$BIN" in */AppTranslocation/*) echo inert; return ;; esac',
    '  case "$BIN" in',
    '    /Volumes/*)',
    '      VOL=$(printf \'%s\\n\' "$BIN" | cut -d/ -f1-3)',
    '      [ -d "$VOL" ] || { echo inert; return; }',
    '      ;;',
    '  esac',
    `  if "$LCTL" print system/${DAEMON_LABEL} 2>/dev/null | grep -Eq '^[[:space:]]*pid = [0-9]+$'; then`,
    '    echo alive; return',
    '  fi',
    '  ASAR="${ENTRY%%/app.asar/*}/app.asar"',
    '  if [ -f "$BIN" ] && [ -x "$BIN" ] && [ -f "$ASAR" ]; then echo present; return; fi',
    '  echo gone',
    '}',
    '',
    'S=$(state)',
    '# Az app a helyén, a segéd mégsem fut (visszatették, és a launchd közben',
    '# feladta az indítását): elindítjuk — a saját blokkját ő írja, nem mi.',
    'if [ "$S" = present ]; then',
    `  "$LCTL" kickstart system/${DAEMON_LABEL} >/dev/null 2>&1 && log "a segéd nem futott: elindítottam"`,
    '  exit 0',
    'fi',
    '[ "$S" = gone ] || exit 0',
    `sleep ${o.settleSeconds}`,
    '[ "$(state)" = gone ] || exit 0',
    '',
    '# A bizalom: a mappa (és a szülei) és a szigorú blokk a rooté, más nem írhatja.',
    ...o.trustChain.map((p) => `trusted ${shQuote(p)} || { log "nem írok: ${p.replace(/"/g, '')} nem megbízható"; exit 0; }`),
    'trusted "$DIR" || { log "nem írok: az állapotmappa nem megbízható"; exit 0; }',
    '[ -f "$STRICT" ] || exit 0',
    '[ ! -L "$STRICT" ] && trusted "$STRICT" || { log "nem írok: a szigorú blokk nem megbízható"; exit 0; }',
    `[ "$(wc -c < "$STRICT")" -le ${STRICT_MAX_BYTES} ] || { log "nem írok: a szigorú blokk túl nagy"; exit 0; }`,
    '[ "$(head -n 1 "$STRICT")" = "$B" ] && [ "$(tail -n 1 "$STRICT")" = "$E" ] || { log "nem írok: a szigorú blokk jelölői hibásak"; exit 0; }',
    '[ "$(grep -Evc "$LINE" "$STRICT")" = 0 ] || { log "nem írok: idegen sor a szigorú blokkban"; exit 0; }',
    '',
    '# A hosts mostani blokkja — ha már a szigorú áll ott, nincs dolgunk.',
    'grep -Fxq -- "$B" "$HOSTS"; HB=$?',
    'grep -Fxq -- "$E" "$HOSTS"; HE=$?',
    '[ "$HB" = "$HE" ] || { log "nem írok: a hosts jelölői felemások"; exit 0; }',
    `CUR=$(awk '${awkRegion}' "$HOSTS")`,
    '[ "$CUR" = "$(cat "$STRICT")" ] && exit 0',
    '',
    '# Közvetlenül írás előtt még egyszer: ha közben visszakerült, nem írunk.',
    '[ "$(state)" = gone ] || exit 0',
    '# Az írást egy leállítás (bootout) se szakítsa félbe: egy félig írt hosts',
    '# fájlból a localhost sora is hiányozhatna.',
    "trap '' TERM INT HUP",
    'TMP=$(mktemp "$DIR/.hosts.XXXXXX") || exit 0',
    `awk '${awkOutside}' "$HOSTS" > "$TMP" || { rm -f "$TMP"; exit 0; }`,
    'printf \'\\n\' >> "$TMP"',
    'cat "$STRICT" >> "$TMP"',
    'cat "$TMP" > "$HOSTS"',
    'rm -f "$TMP"',
    `{ ${o.flush}; } >/dev/null 2>&1`,
    'log "az app nem található: a szigorú blokk a helyén"',
    'exit 0',
    '',
  ].join('\n');
}

/** Az őr LaunchDaemon-leírója: percenként fut, induláskor is. Nincs KeepAlive. */
export function macGuardPlist(scriptPath: string = MAC_GUARD_SCRIPT): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${GUARD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xmlEscape(scriptPath)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>AssociatedBundleIdentifiers</key>
  <array><string>hu.breaker.app</string></array>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------- Windows

export interface WindowsGuardOptions {
  /** két megnézés között ennyi másodperc */
  settleSeconds: number;
  /** ennyi ideig kell eltűntnek lennie, mielőtt a szigorú blokk áll be */
  durableSeconds: number;
}

export const WINDOWS_GUARD_DEFAULTS: WindowsGuardOptions = { settleSeconds: 20, durableSeconds: 270 };

/** UTF-8 bájtok base64-ben — az őr ASCII-fájl, a magyar szöveg így megy bele. */
function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

/**
 * Az őr PowerShell-szkriptje (Windows PowerShell 5.1, csak ASCII — BOM nélkül a
 * rendszer ANSI-ként olvasná). A hosts fájlt és a szigorú blokkot bájtra
 * megőrizve (Latin-1) kezeli; a jelölőket és a naplósorokat base64-ből veszi.
 */
export function windowsGuardScript(o: WindowsGuardOptions = WINDOWS_GUARD_DEFAULTS): string {
  const msg = (s: string) => `(U '${b64(s)}')`;
  return [
    '# Breaker guard - generated file (desktop/src/shared/guard-script.ts). Do not edit.',
    '# Writes the hosts file ONLY when the app is gone: then it keeps the strict block.',
    // Semmit ne a PATH-ból / a modulútból: SYSTEM-ként bárkié lehetne.
    '$env:PATH = "$env:SystemRoot\\System32;$env:SystemRoot"',
    '$env:PSModulePath = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules"',
    "$ErrorActionPreference = 'Stop'",
    '$L1 = [Text.Encoding]::GetEncoding(28591)',
    'function D([string]$b) { $L1.GetString([Convert]::FromBase64String($b)) }',
    'function U([string]$b) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }',
    `$B = D '${b64(MARKER_BEGIN)}'`,
    `$E = D '${b64(MARKER_END)}'`,
    `$LineRe = ${psSingleQuoted(`^(${STRICT_LINE_SOURCE})$`)}`,
    "$sys = Join-Path $env:SystemRoot 'System32'",
    "$stateDir = Join-Path $env:ProgramData 'Breaker'",
    `$strict = Join-Path $stateDir '${STRICT_FILE}'`,
    `$goneMark = Join-Path $stateDir '${GUARD_GONE_FILE}'`,
    "$logFile = Join-Path $stateDir 'guard.log'",
    "$hostsFile = Join-Path $sys 'drivers\\etc\\hosts'",
    `$settle = ${o.settleSeconds}`,
    `$durable = ${o.durableSeconds}`,
    '',
    'function Log([string]$m) {',
    '  try {',
    '    if ([IO.File]::Exists($logFile) -and (New-Object IO.FileInfo $logFile).Length -gt 262144) { [IO.File]::WriteAllText($logFile, "") }',
    '    if ([IO.File]::Exists($logFile)) { $last = @([IO.File]::ReadAllLines($logFile, [Text.Encoding]::UTF8)); if ($last.Count -gt 0 -and $last[-1].EndsWith($m)) { return } }',
    '    [IO.File]::AppendAllText($logFile, ([DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ") + " " + $m + "`r`n"), (New-Object Text.UTF8Encoding $false))',
    '  } catch { }',
    '}',
    '',
    '# inert: nothing to look at; present: the app is in place; gone: the app disappeared.',
    'function Get-State {',
    `  $t = ScheduledTasks\\Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`,
    "  if (-not $t) { return @{ s = 'inert' } }",
    '  $a = @($t.Actions)[0]',
    "  if (-not $a -or -not $a.Execute) { return @{ s = 'inert' } }",
    "  $exe = [Environment]::ExpandEnvironmentVariables($a.Execute).Trim('\"')",
    "  if (-not [IO.Path]::IsPathRooted($exe)) { return @{ s = 'inert' } }",
    "  if (-not [IO.Directory]::Exists([IO.Path]::GetPathRoot($exe))) { return @{ s = 'inert' } }",
    "  $asar = Join-Path (Split-Path -Parent $exe) 'resources\\app.asar'",
    "  if (-not [IO.File]::Exists($exe) -or -not [IO.File]::Exists($asar)) { return @{ s = 'gone' } }",
    "  return @{ s = 'present'; exe = $exe; asar = $asar; state = [string]$t.State }",
    '}',
    '',
    '# Our installer or uninstaller is running (an update swaps the files for a while).',
    '# Only our own names: any process called *Setup* would keep the guard off forever.',
    'function Installing {',
    "  return [bool](@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(Au_|Un_A|Un_)$|^Breaker[ -]Setup|^Uninstall Breaker' }).Count)",
    '}',
    '',
    'function Owner-Ok([string]$p) {',
    '  $sid = (Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value',
    "  return ($sid -eq 'S-1-5-18' -or $sid -eq 'S-1-5-32-544')",
    '}',
    '',
    'function Apply-Strict {',
    '  if (-not [IO.File]::Exists($strict)) { return }',
    `  if (((Get-Item -LiteralPath $strict -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not (Owner-Ok $stateDir) -or -not (Owner-Ok $strict)) { Log ${msg('nem írok: a szigorú blokk nem megbízható')}; return }`,
    '  $bytes = [IO.File]::ReadAllBytes($strict)',
    `  if ($bytes.Length -gt ${STRICT_MAX_BYTES}) { Log ${msg('nem írok: a szigorú blokk túl nagy')}; return }`,
    '  $want = @(($L1.GetString($bytes) -split "`n") | ForEach-Object { $_.TrimEnd("`r") })',
    "  if ($want.Count -gt 0 -and $want[-1] -eq '') { $want = @($want[0..($want.Count - 2)]) }",
    `  if ($want.Count -lt 2 -or $want[0] -cne $B -or $want[-1] -cne $E) { Log ${msg('nem írok: a szigorú blokk jelölői hibásak')}; return }`,
    `  foreach ($l in $want) { if ($l -cnotmatch $LineRe) { Log ${msg('nem írok: idegen sor a szigorú blokkban')}; return } }`,
    '  $lines = @(($L1.GetString([IO.File]::ReadAllBytes($hostsFile)) -split "`n") | ForEach-Object { $_.TrimEnd("`r") })',
    '  $nb = @($lines | Where-Object { $_ -ceq $B }).Count',
    '  $ne = @($lines | Where-Object { $_ -ceq $E }).Count',
    `  if ($nb -ne $ne) { Log ${msg('nem írok: a hosts jelölői felemások')}; return }`,
    '  $cur = New-Object Collections.Generic.List[string]',
    '  $out = New-Object Collections.Generic.List[string]',
    '  $in = $false',
    '  foreach ($l in $lines) {',
    '    if ($l -ceq $B) { $in = $true }',
    '    if ($in) { $cur.Add($l) } else { $out.Add($l) }',
    '    if ($l -ceq $E) { $in = $false }',
    '  }',
    '  if (($cur -join "`n") -ceq ($want -join "`n")) { return }',
    // Közvetlenül írás előtt még egyszer: ha közben visszakerült, nem írunk.
    "  if ((Get-State).s -ne 'gone') { return }",
    "  while ($out.Count -gt 0 -and $out[$out.Count - 1] -eq '') { $out.RemoveAt($out.Count - 1) }",
    "  $out.Add('')",
    '  foreach ($l in $want) { $out.Add($l) }',
    '  [IO.File]::WriteAllBytes($hostsFile, $L1.GetBytes((($out -join "`r`n") + "`r`n")))',
    "  & (Join-Path $sys 'ipconfig.exe') /flushdns | Out-Null",
    `  Log ${msg('az app nem található: a szigorú blokk a helyén')}`,
    '}',
    '',
    'try {',
    '  $s1 = Get-State',
    "  if ($s1.s -eq 'inert') { exit 0 }",
    "  if ($s1.s -eq 'present') {",
    '    if ([IO.File]::Exists($goneMark)) { Remove-Item -LiteralPath $goneMark -Force -ErrorAction SilentlyContinue }',
    // Egy frissítés leállítja a segédet, és a Feladatütemező nem indítja újra:
    // ha a fájlok stabilak és telepítő nem fut, az őr elindítja.
    "    if ($s1.state -ne 'Ready') { exit 0 }",
    '    $f1 = "$((Get-Item -LiteralPath $s1.exe).Length)/$((Get-Item -LiteralPath $s1.asar).Length)"',
    '    Start-Sleep -Seconds $settle',
    '    $s2 = Get-State',
    "    if ($s2.s -ne 'present' -or $s2.state -ne 'Ready' -or (Installing)) { exit 0 }",
    '    $f2 = "$((Get-Item -LiteralPath $s2.exe).Length)/$((Get-Item -LiteralPath $s2.asar).Length)"',
    '    if ($f1 -ne $f2) { exit 0 }',
    `    Log ${msg('a segéd nem fut, az app a helyén van: elindítom')}`,
    `    ScheduledTasks\\Start-ScheduledTask -TaskName '${TASK_NAME}'`,
    '    exit 0',
    '  }',
    '  Start-Sleep -Seconds $settle',
    "  if ((Get-State).s -ne 'gone') { exit 0 }",
    // Tartósan eltűnt-e: egy frissítés pár percre cseréli a fájlokat.
    '  $now = [DateTime]::UtcNow',
    '  $since = $null',
    "  try { $since = [DateTime]::Parse([IO.File]::ReadAllText($goneMark), [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) } catch { }",
    "  if ($null -eq $since) { [IO.File]::WriteAllText($goneMark, $now.ToString('o')); exit 0 }",
    '  if (($now - $since.ToUniversalTime()).TotalSeconds -lt $durable -or (Installing)) { exit 0 }',
    '  Apply-Strict',
    '} catch {',
    `  Log (${msg('hiba: ')} + $_.Exception.Message)`,
    '}',
    'exit 0',
    '',
  ].join('\r\n');
}

/**
 * Az őr feladatának felvétele (a segéd futtatja, SYSTEM-ként): induláskor és
 * ötpercenként, a rendszer PowerShelljével, a megadott őr-fájllal.
 */
export function windowsGuardRegisterScript(guardPath: string): string {
  const arg = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${guardPath}"`;
  return [
    '$env:PATH = "$env:SystemRoot\\System32;$env:SystemRoot"',
    '$env:PSModulePath = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules"',
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    `  $action = ScheduledTasks\\New-ScheduledTaskAction -Execute $ps -Argument ${psSingleQuoted(arg)}`,
    '  $boot = ScheduledTasks\\New-ScheduledTaskTrigger -AtStartup',
    '  $every = ScheduledTasks\\New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 5)',
    "  $principal = ScheduledTasks\\New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
    '  $settings = ScheduledTasks\\New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries '
      + '-ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew -StartWhenAvailable',
    `  ScheduledTasks\\Register-ScheduledTask -TaskName '${GUARD_TASK_NAME}' -Action $action -Trigger $boot,$every -Principal $principal -Settings $settings -Force | Out-Null`,
    '} catch { exit 1 }',
    'exit 0',
  ].join('\n');
}

/** A felvevő szkript kódolva — a segéd ezt adja a PowerShellnek. */
export function windowsGuardRegisterEncoded(guardPath: string): string {
  return encodePowerShell(windowsGuardRegisterScript(guardPath));
}
