// A SEGÉD ŐRE: egy külön, kicsi feladat, ami csak akkor nyúl a hosts fájlhoz,
// ha a segéd nem tilt — mert az app eltűnt, vagy a helyén van, de a segéd
// percek óta nem indul el. Akkor a szigorú blokkot (shared/strict-block.ts)
// teszi a helyére, és tartja.
//
// MIÉRT KÜLÖN. A segéd indítási útja (install-script.ts: launchdPlist,
// windowsInstallScript) bizonyított és CI-ban próbált — azt ez nem érinti,
// bájtra ugyanaz marad. Az őr egy második feladat:
//   - macOS: LaunchDaemon (hu.breaker.guard), percenként fut, /bin/sh-val;
//   - Windows: ütemezett feladat (BreakerGuard), induláskor és ötpercenként,
//     a rendszer saját PowerShelljével.
// A segéd maga telepíti (root/SYSTEM-ként, induláskor — helper/guard.ts).
//
// MIKOR ÍR. Ha a segéd fut, soha. Ha az app binárisa (vagy az app.asar)
// ELTŰNT — kétszer egymás után megnézve; Windowson egy frissítés pár percre
// kicseréli a fájlokat, ott a „nincs meg” állapotnak két ütemezett futáson át
// meg kell maradnia (és ha a saját telepítőnk fut, legfeljebb fél óráig
// várunk rá). Ha az app a helyén van, de a segéd nem fut, az őr elindítja; ha
// így sem indul el (macOS: öt, Windows: tíz percen át), a szigorú blokk áll be
// — a befagyott blokk helyett. Egy visszaállított óra ezt nem halasztja: a
// jövőbeli bélyeget az őr a mostani időre írja át.
//
// MIT ÍR. A szigorú blokk tiltó sorainak és a hosts mostani blokkja tiltó
// sorainak UNIÓJÁT: egy elavult szigorú blokk (például egy régebbi segéd
// után) így sem vehet ki egy épp tiltott nevet — az őr csak szigorít. A
// felemás jelölőket és a hiányzó hosts fájlt is rendbe teszi.
//
// MIBEN BÍZIK. A szigorú blokkot a segéd írja egy csak rootnak / csak
// SYSTEM-nek és rendszergazdáknak írható mappába; az őr ezt ellenőrzi
// (tulajdonos, jogok, szimbolikus link / csatolási pont), és soronként is:
// csak 0.0.0.0 / :: tiltó sort és megjegyzést vesz át, a többit kihagyja —
// más címre irányítani így sem lehet. Méretkorlát nincs (egy korlát ingyenes
// kiskapu volna: egy nagyon hosszú lista után az őr semmit nem írna). Az őr
// egyetlen natív parancsot sem a PATH-ból keres, és Windowson a saját
// mappáján kívül semmit nem ír, csak a hosts fájlt.

import { MARKER_BEGIN, MARKER_END } from './blocklist';
import { DAEMON_LABEL, encodePowerShell, psSingleQuoted, TASK_NAME } from './install-script';
import { STRICT_BLOCK_LINE_SOURCE } from './strict-block';

export const GUARD_LABEL = 'hu.breaker.guard';
export const GUARD_TASK_NAME = 'BreakerGuard';
/** A szigorú blokk fájlneve a segéd állapotmappájában. */
export const STRICT_FILE = 'strict-hosts';
/** Mióta nincs meg az app (Windows, az őr mappájában). */
export const GUARD_GONE_FILE = 'guard-gone';
/** Mióta nem fut a segéd, pedig az app a helyén van (az őr mappájában). */
export const GUARD_DEAD_FILE = 'guard-dead';

/** Shell egyszeres idézése: a ' helyén '\''. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Egy tiltó sor teljes mintája (horgonyokkal) — a shell és a PowerShell ugyanezt kapja. */
const BLOCK_RE = `^${STRICT_BLOCK_LINE_SOURCE}$`;

// ------------------------------------------------------------------ macOS

export interface MacGuardOptions {
  /** a segéd állapotmappája: itt a szigorú blokk, a napló, a bélyeg és az őr maga */
  dir: string;
  /** a segéd LaunchDaemon-leírója: ebből olvassuk ki, hol az app */
  main: string;
  hosts: string;
  plistBuddy: string;
  launchctl: string;
  /** két megnézés között ennyi másodperc */
  settleSeconds: number;
  /** ha az app a helyén van, de a segéd ennyi másodperce nem fut, a szigorú blokk áll be */
  deadSeconds: number;
  /** a segéd akkor él, ha ennyi másodperc múlva is ugyanazzal a folyamat-azonosítóval fut */
  pidCheckSeconds: number;
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
  deadSeconds: 300,
  pidCheckSeconds: 2,
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
  const env = 'BEGIN{b=ENVIRON["B"];e=ENVIRON["E"];n=0}';
  const trimPrint = 'END{while(n>0&&l[n]=="")n--; for(i=1;i<=n;i++)print l[i]}';
  // Rendben vannak-e a jelölők: mindegyik nyitót egy záró követ, és fordítva.
  const awkWellFormed = `${env} $0==b{if(s)bad=1;s=1;next} $0==e{if(!s)bad=1;s=0} END{exit (bad||s)?1:0}`;
  const awkRegion = `${env} $0==b{p=1} p{print} $0==e{p=0}`;
  const awkOutside = `${env} $0==b{s=1} !s{l[++n]=$0} $0==e{s=0} ${trimPrint}`;
  const awkNoMarkers = `${env} $0!=b&&$0!=e{l[++n]=$0} ${trimPrint}`;
  // A shell-minták csillaga változóból jön: a forrásban a perjel-csillag a
  // tű-ellenőrző (scripts/check-enforcement.js) szemében megjegyzés-kezdet
  // volna, és a fájl további részét nem látná.
  const S = '*';
  return [
    '#!/bin/sh',
    '# A Breaker őre — generált fájl (desktop/src/shared/guard-script.ts), kézzel ne szerkeszd.',
    '# Csak akkor ír a hosts fájlba, ha a segéd nem tilt: akkor a szigorú blokkot tartja.',
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
    `DEAD="$DIR/${GUARD_DEAD_FILE}"`,
    `B=${shQuote(MARKER_BEGIN)}`,
    `E=${shQuote(MARKER_END)}`,
    'export B E',
    `BLOCK=${shQuote(BLOCK_RE)}`,
    '',
    '# Egy út a rooté-e, nem szimbolikus link, és se a csoport, se más nem írhatja.',
    'trusted() {',
    `  [ ! -L "$1" ] && [ -n "$(find "$1" -prune -user ${o.ownerUid} ! -perm -0020 ! -perm -0002 2>/dev/null)" ]`,
    '}',
    '',
    '# A mappa és a szülei: ha nem megbízhatóak, semmit nem írunk bele — naplót sem.',
    'OK=1',
    ...o.trustChain.map((p) => `trusted ${shQuote(p)} || OK=0`),
    'trusted "$DIR" || OK=0',
    '',
    '# Napló: csak a megbízható mappába, ugyanazt kétszer egymás után nem.',
    'log() {',
    '  [ "$OK" = 1 ] || return 0',
    '  [ -L "$LOG" ] && return 0',
    '  [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 262144 ] && : > "$LOG"',
    '  if [ -f "$LOG" ] && tail -n 1 "$LOG" | grep -Fq -- "$1"; then return 0; fi',
    '  printf \'%s %s\\n\' "$(date -u \'+%Y-%m-%dT%H:%M:%SZ\')" "$1" >> "$LOG" 2>/dev/null',
    '}',
    '',
    '# A segéd folyamat-azonosítója a launchd szerint (üres, ha nem fut).',
    'pid() {',
    `  "$LCTL" print system/${DAEMON_LABEL} 2>/dev/null | sed -n 's/^[[:space:]]*pid = \\([0-9][0-9]*\\)$/\\1/p' | head -n 1`,
    '}',
    '',
    '# inert: nincs mit nézni (nincs segéd, vagy egy le nem csatolt kötetről fut);',
    '# alive: a segéd fut; present: az app a helyén, a segéd nem fut; gone: az app eltűnt.',
    'state() {',
    '  [ -f "$MAIN" ] || { echo inert; return; }',
    '  BIN=$("$PB" -c \'Print :ProgramArguments:0\' "$MAIN" 2>/dev/null) || { echo inert; return; }',
    '  ENTRY=$("$PB" -c \'Print :ProgramArguments:1\' "$MAIN" 2>/dev/null) || { echo inert; return; }',
    `  case "$BIN" in /${S}) ;; ${S}) echo inert; return ;; esac`,
    `  case "$ENTRY" in /${S}/app.asar/${S}) ;; ${S}) echo inert; return ;; esac`,
    `  case "$BIN" in ${S}/AppTranslocation/${S}) echo inert; return ;; esac`,
    '  case "$BIN" in',
    `    /Volumes/${S})`,
    '      VOL=$(printf \'%s\\n\' "$BIN" | cut -d/ -f1-3)',
    '      [ -d "$VOL" ] || { echo inert; return; }',
    '      ;;',
    '  esac',
    // Él-e: két megnézés, ugyanazzal az azonosítóval — egy újra és újra
    // összeomló segédnél a launchd egy pillanatra mutathat azonosítót.
    `  P1=$(pid)`,
    '  if [ -n "$P1" ]; then',
    `    sleep ${o.pidCheckSeconds}`,
    '    [ "$(pid)" = "$P1" ] && { echo alive; return; }',
    '  fi',
    `  ASAR="\${ENTRY%%/app.asar/${S}}/app.asar"`,
    '  if [ -f "$BIN" ] && [ -x "$BIN" ] && [ -f "$ASAR" ]; then echo present; return; fi',
    '  echo gone',
    '}',
    '',
    '# Még mindig nem tilt-e a segéd (eltűnt app; vagy a helyén, de nem fut).',
    'still() {',
    '  S2=$(state)',
    '  [ "$S2" = gone ] || { [ "$S2" = present ] && [ "$WHY" = dead ]; }',
    '}',
    '',
    'S=$(state)',
    'case "$S" in',
    '  inert) exit 0 ;;',
    '  alive)',
    '    [ "$OK" = 1 ] && [ ! -L "$DEAD" ] && rm -f "$DEAD"',
    '    exit 0',
    '    ;;',
    '  present)',
    '    # Az app a helyén, a segéd mégsem fut (visszatették, és a launchd közben',
    '    # feladta; vagy elindul, de rögtön leáll): elindítjuk. Ha percek óta így',
    '    # van, a szigorú blokk áll be — a befagyott blokk helyett.',
    `    "$LCTL" kickstart system/${DAEMON_LABEL} >/dev/null 2>&1 && log "a segéd nem futott: elindítottam"`,
    '    [ "$OK" = 1 ] || exit 0',
    '    [ -L "$DEAD" ] && exit 0',
    '    NOW=$(date +%s)',
    '    SINCE=$(head -n 1 "$DEAD" 2>/dev/null)',
    "    case \"$SINCE\" in ''|*[!0-9]*) SINCE='' ;; esac",
    '    # Nincs bélyeg, vagy a jövőben van (visszaállított óra): most kezdődik.',
    '    if [ -z "$SINCE" ] || [ "$SINCE" -gt "$NOW" ]; then',
    '      printf \'%s\\n\' "$NOW" > "$DEAD"',
    '      exit 0',
    '    fi',
    `    [ $((NOW - SINCE)) -ge ${o.deadSeconds} ] || exit 0`,
    '    WHY=dead',
    '    ;;',
    '  *)',
    '    [ "$OK" = 1 ] && [ ! -L "$DEAD" ] && rm -f "$DEAD"',
    '    WHY=gone',
    '    ;;',
    'esac',
    `sleep ${o.settleSeconds}`,
    'still || exit 0',
    '',
    '# A szigorú blokk: a rooté, nem link, más nem írhatja.',
    '[ "$OK" = 1 ] || exit 0',
    '[ -L "$STRICT" ] && { log "nem írok: a szigorú blokk szimbolikus link"; exit 0; }',
    '[ -f "$STRICT" ] || exit 0',
    'trusted "$STRICT" || { log "nem írok: a szigorú blokk nem megbízható"; exit 0; }',
    '',
    'WORK=$(mktemp -d "$DIR/.guard.XXXXXX") || exit 0',
    'trap \'rm -rf "$WORK"\' EXIT',
    '# Csak a tiltó sorok és a megjegyzés jön át; minden más kimarad.',
    'grep -E -- "$BLOCK" "$STRICT" > "$WORK/s"',
    '[ -s "$WORK/s" ] || { log "nem írok: a szigorú blokkban nincs tiltó sor"; exit 0; }',
    'grep -E -- \'^#\' "$STRICT" | grep -Fxv -e "$B" -e "$E" > "$WORK/n"',
    'FOREIGN=$(grep -Evc -- "^#|$BLOCK" "$STRICT")',
    '[ "$FOREIGN" = 0 ] || log "a szigorú blokk idegen sorait kihagytam: $FOREIGN"',
    '',
    '# A hosts fájl pillanatképe — ha nincs meg, egy alap hosts-szal kezdünk.',
    'NEW=0',
    'if [ -f "$HOSTS" ]; then',
    '  cat "$HOSTS" > "$WORK/hosts" || exit 0',
    'else',
    '  NEW=1',
    '  printf \'127.0.0.1\\tlocalhost\\n255.255.255.255\\tbroadcasthost\\n::1             localhost\\n\' > "$WORK/hosts"',
    'fi',
    '# Rendben lévő jelölőknél a régi blokk(ok) tiltó sorai is maradnak (unió);',
    '# felemás jelölőknél csak a jelölő-sorokat vesszük ki, a többi sor marad.',
    `if awk '${awkWellFormed}' "$WORK/hosts"; then`,
    `  awk '${awkRegion}' "$WORK/hosts" > "$WORK/cur"`,
    '  grep -E -- "$BLOCK" "$WORK/cur" > "$WORK/h"',
    `  awk '${awkOutside}' "$WORK/hosts" > "$WORK/out"`,
    'else',
    '  : > "$WORK/cur"',
    '  : > "$WORK/h"',
    `  awk '${awkNoMarkers}' "$WORK/hosts" > "$WORK/out"`,
    '  log "a hosts jelölői felemások voltak: rendbe teszem"',
    'fi',
    '{ printf \'%s\\n\' "$B"; cat "$WORK/n"; sort -u "$WORK/s" "$WORK/h"; printf \'%s\\n\' "$E"; } > "$WORK/want"',
    '[ "$NEW" = 0 ] && cmp -s "$WORK/cur" "$WORK/want" && exit 0',
    '',
    '# Közvetlenül írás előtt még egyszer: ha közben a segéd elindult, nem írunk.',
    'still || exit 0',
    '# Az írást egy leállítás (bootout) se szakítsa félbe: egy félig írt hosts',
    '# fájlból a localhost sora is hiányozhatna.',
    "trap '' TERM INT HUP",
    '{ if [ -s "$WORK/out" ]; then cat "$WORK/out"; printf \'\\n\'; fi; cat "$WORK/want"; } > "$WORK/new" || exit 0',
    'cat "$WORK/new" > "$HOSTS" || { log "nem tudtam írni a hosts fájlt"; exit 0; }',
    '[ "$NEW" = 1 ] && chmod 644 "$HOSTS"',
    `{ ${o.flush}; } >/dev/null 2>&1`,
    'if [ "$WHY" = dead ]; then',
    '  log "a segéd nem indul: a szigorú blokk a helyén"',
    'else',
    '  log "az app nem található: a szigorú blokk a helyén"',
    'fi',
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
  /** ha az app a helyén van, de a segéd ennyi másodperce nem fut, a szigorú blokk áll be */
  deadSeconds: number;
  /** a saját telepítőnkre legfeljebb ennyit várunk (egy nyitva hagyott ablak ne tartsa örökké) */
  installCapSeconds: number;
}

export const WINDOWS_GUARD_DEFAULTS: WindowsGuardOptions = {
  settleSeconds: 20, durableSeconds: 270, deadSeconds: 600, installCapSeconds: 1800,
};

/** UTF-8 bájtok base64-ben — az őr ASCII-fájl, a magyar szöveg így megy bele. */
function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

/**
 * Az őr PowerShell-szkriptje (Windows PowerShell 5.1, csak ASCII — BOM nélkül a
 * rendszer ANSI-ként olvasná). A hosts fájlt és a szigorú blokkot bájtra
 * megőrizve (Latin-1) kezeli; a jelölőket és a naplósorokat base64-ből veszi.
 * A bélyegeket és a naplót a SAJÁT mappájába írja (a 64 bites Program Files
 * alá, sima felhasználó ott nem hozhat létre semmit) — a segéd állapotmappáját
 * csak olvassa: ha azt valaki törli, egy sima felhasználó újra létrehozhatná,
 * és egy SYSTEM-írást máshova irányíthatna.
 */
export function windowsGuardScript(o: WindowsGuardOptions = WINDOWS_GUARD_DEFAULTS): string {
  const msg = (s: string) => `(U '${b64(s)}')`;
  return [
    '# Breaker guard - generated file (desktop/src/shared/guard-script.ts). Do not edit.',
    '# Writes the hosts file ONLY when the helper is not blocking: then it keeps the strict block.',
    // Semmit ne a PATH-ból / a modulútból: SYSTEM-ként bárkié lehetne.
    '$env:PATH = "$env:SystemRoot\\System32;$env:SystemRoot"',
    '$env:PSModulePath = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules"',
    "$ErrorActionPreference = 'Stop'",
    '$L1 = [Text.Encoding]::GetEncoding(28591)',
    'function D([string]$b) { $L1.GetString([Convert]::FromBase64String($b)) }',
    'function U([string]$b) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }',
    `$B = D '${b64(MARKER_BEGIN)}'`,
    `$E = D '${b64(MARKER_END)}'`,
    `$BlockRe = ${psSingleQuoted(BLOCK_RE)}`,
    "$sys = Join-Path $env:SystemRoot 'System32'",
    "$stateDir = Join-Path $env:ProgramData 'Breaker'",
    `$strict = Join-Path $stateDir '${STRICT_FILE}'`,
    '$pf = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }',
    "$guardDir = Join-Path $pf 'Breaker Guard'",
    `$goneMark = Join-Path $guardDir '${GUARD_GONE_FILE}'`,
    `$deadMark = Join-Path $guardDir '${GUARD_DEAD_FILE}'`,
    "$logFile = Join-Path $guardDir 'guard.log'",
    "$hostsFile = Join-Path $sys 'drivers\\etc\\hosts'",
    `$settle = ${o.settleSeconds}`,
    `$durable = ${o.durableSeconds}`,
    `$deadAfter = ${o.deadSeconds}`,
    `$installCap = ${o.installCapSeconds}`,
    '',
    'function Owner-Ok([string]$p) {',
    '  $sid = (Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value',
    "  return ($sid -eq 'S-1-5-18' -or $sid -eq 'S-1-5-32-544')",
    '}',
    '',
    '# A folder exists, is not a reparse point, and is owned by SYSTEM or Administrators.',
    'function Trusted-Dir([string]$p) {',
    '  if (-not [IO.Directory]::Exists($p)) { return $false }',
    '  if ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }',
    '  return (Owner-Ok $p)',
    '}',
    '$guardOk = $false',
    'try { $guardOk = Trusted-Dir $guardDir } catch { }',
    '',
    'function Log([string]$m) {',
    '  if (-not $guardOk) { return }',
    '  try {',
    '    if ([IO.File]::Exists($logFile) -and (New-Object IO.FileInfo $logFile).Length -gt 262144) { [IO.File]::WriteAllText($logFile, "") }',
    '    if ([IO.File]::Exists($logFile)) { $last = @([IO.File]::ReadAllLines($logFile, [Text.Encoding]::UTF8)); if ($last.Count -gt 0 -and $last[-1].EndsWith($m)) { return } }',
    '    [IO.File]::AppendAllText($logFile, ([DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ") + " " + $m + "`r`n"), (New-Object Text.UTF8Encoding $false))',
    '  } catch { }',
    '}',
    '',
    '# Seconds since the stamp; a missing or future stamp (clock set back) starts now.',
    'function Stamp-Age([string]$p) {',
    '  $now = [DateTime]::UtcNow',
    '  $since = $null',
    "  try { $since = [DateTime]::Parse([IO.File]::ReadAllText($p), [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() } catch { }",
    "  if ($null -eq $since -or $since -gt $now) { [IO.File]::WriteAllText($p, $now.ToString('o')); return 0 }",
    '  return ($now - $since).TotalSeconds',
    '}',
    'function Clear-Stamp([string]$p) {',
    '  if ([IO.File]::Exists($p)) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }',
    '}',
    '',
    '# inert: nothing to look at; alive: the helper runs; present: the app is in place,',
    '# the helper does not run; gone: the app (or its drive) disappeared.',
    'function Get-State {',
    `  $t = ScheduledTasks\\Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`,
    "  if (-not $t) { return @{ s = 'inert' } }",
    "  if ([string]$t.State -eq 'Running') { return @{ s = 'alive' } }",
    '  $a = @($t.Actions)[0]',
    "  if (-not $a -or -not $a.Execute) { return @{ s = 'inert' } }",
    "  $exe = [Environment]::ExpandEnvironmentVariables($a.Execute).Trim('\"')",
    "  if (-not [IO.Path]::IsPathRooted($exe)) { return @{ s = 'inert' } }",
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
    'function Lines([byte[]]$bytes) {',
    '  $out = New-Object Collections.Generic.List[string]',
    '  foreach ($l in ($L1.GetString($bytes) -split "`n")) { $out.Add($l.TrimEnd("`r")) }',
    "  if ($out.Count -gt 0 -and $out[$out.Count - 1] -eq '') { $out.RemoveAt($out.Count - 1) }",
    '  return ,$out',
    '}',
    '',
    'function Apply-Strict([string]$why) {',
    '  if (-not [IO.File]::Exists($strict)) { return }',
    `  if (-not (Trusted-Dir $stateDir)) { Log ${msg('nem írok: az állapotmappa nem megbízható')}; return }`,
    `  if (((Get-Item -LiteralPath $strict -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not (Owner-Ok $strict)) { Log ${msg('nem írok: a szigorú blokk nem megbízható')}; return }`,
    '  $set = New-Object \'Collections.Generic.SortedSet[string]\' ([StringComparer]::Ordinal)',
    '  $notes = New-Object Collections.Generic.List[string]',
    '  $foreign = 0',
    '  foreach ($l in (Lines ([IO.File]::ReadAllBytes($strict)))) {',
    '    if ($l -ceq $B -or $l -ceq $E) { continue }',
    '    if ($l -cmatch $BlockRe) { [void]$set.Add($l) }',
    "    elseif ($l.StartsWith('#')) { $notes.Add($l) }",
    '    else { $foreign++ }',
    '  }',
    `  if ($set.Count -eq 0) { Log ${msg('nem írok: a szigorú blokkban nincs tiltó sor')}; return }`,
    `  if ($foreign -gt 0) { Log (${msg('a szigorú blokk idegen sorait kihagytam: ')} + $foreign) }`,
    '  $lines = New-Object Collections.Generic.List[string]',
    '  if ([IO.File]::Exists($hostsFile)) { $lines = Lines ([IO.File]::ReadAllBytes($hostsFile)) }',
    // Rendben lévő jelölőknél a régi blokk tiltó sorai is maradnak (unió);
    // felemásnál csak a jelölő-sorokat vesszük ki, a többi sor marad.
    '  $ok = $true',
    '  $in = $false',
    '  foreach ($l in $lines) {',
    '    if ($l -ceq $B) { if ($in) { $ok = $false }; $in = $true }',
    '    elseif ($l -ceq $E) { if (-not $in) { $ok = $false }; $in = $false }',
    '  }',
    '  if ($in) { $ok = $false }',
    '  $cur = New-Object Collections.Generic.List[string]',
    '  $out = New-Object Collections.Generic.List[string]',
    '  if ($ok) {',
    '    $in = $false',
    '    foreach ($l in $lines) {',
    '      if ($l -ceq $B) { $in = $true }',
    '      if ($in) { $cur.Add($l); if ($l -cmatch $BlockRe) { [void]$set.Add($l) } } else { $out.Add($l) }',
    '      if ($l -ceq $E) { $in = $false }',
    '    }',
    '  } else {',
    '    foreach ($l in $lines) { if ($l -cne $B -and $l -cne $E) { $out.Add($l) } }',
    `    Log ${msg('a hosts jelölői felemások voltak: rendbe teszem')}`,
    '  }',
    '  $want = New-Object Collections.Generic.List[string]',
    '  $want.Add($B)',
    '  foreach ($l in $notes) { $want.Add($l) }',
    '  foreach ($l in $set) { $want.Add($l) }',
    '  $want.Add($E)',
    '  if ([IO.File]::Exists($hostsFile) -and (($cur -join "`n") -ceq ($want -join "`n"))) { return }',
    // Közvetlenül írás előtt még egyszer: ha közben a segéd elindult, nem írunk.
    '  $now = (Get-State).s',
    "  if (-not ($now -eq 'gone' -or ($now -eq 'present' -and $why -eq 'dead'))) { return }",
    "  while ($out.Count -gt 0 -and $out[$out.Count - 1] -eq '') { $out.RemoveAt($out.Count - 1) }",
    "  if ($out.Count -gt 0) { $out.Add('') }",
    '  foreach ($l in $want) { $out.Add($l) }',
    '  [IO.File]::WriteAllBytes($hostsFile, $L1.GetBytes((($out -join "`r`n") + "`r`n")))',
    "  & (Join-Path $sys 'ipconfig.exe') /flushdns | Out-Null",
    `  if ($why -eq 'dead') { Log ${msg('a segéd nem indul: a szigorú blokk a helyén')} }`,
    `  else { Log ${msg('az app nem található: a szigorú blokk a helyén')} }`,
    '}',
    '',
    'try {',
    // A saját mappáján kívül semmit nem ír (a hosts fájlon kívül): ha az nem
    // megbízható, nem dolgozunk.
    '  if (-not $guardOk) { exit 0 }',
    '  $s1 = Get-State',
    "  if ($s1.s -eq 'inert') { exit 0 }",
    "  if ($s1.s -eq 'alive') { Clear-Stamp $goneMark; Clear-Stamp $deadMark; exit 0 }",
    "  if ($s1.s -eq 'present') {",
    '    Clear-Stamp $goneMark',
    '    $deadFor = Stamp-Age $deadMark',
    // Egy frissítés leállítja a segédet, és a Feladatütemező nem indítja újra:
    // ha a fájlok stabilak és telepítő nem fut, az őr indítja.
    "    if ($s1.state -eq 'Ready') {",
    '      $f1 = "$((Get-Item -LiteralPath $s1.exe).Length)/$((Get-Item -LiteralPath $s1.asar).Length)"',
    '      Start-Sleep -Seconds $settle',
    '      $s2 = Get-State',
    "      if ($s2.s -eq 'present' -and $s2.state -eq 'Ready' -and -not (Installing)) {",
    '        $f2 = "$((Get-Item -LiteralPath $s2.exe).Length)/$((Get-Item -LiteralPath $s2.asar).Length)"',
    '        if ($f1 -eq $f2) {',
    `          Log ${msg('a segéd nem fut, az app a helyén van: elindítom')}`,
    `          ScheduledTasks\\Start-ScheduledTask -TaskName '${TASK_NAME}'`,
    '        }',
    '      }',
    '    }',
    // Ha percek óta nem indul el, a szigorú blokk áll be — a befagyott helyett.
    '    if ($deadFor -lt $deadAfter) { exit 0 }',
    '    if ((Installing) -and $deadFor -lt $installCap) { exit 0 }',
    "    Apply-Strict 'dead'",
    '    exit 0',
    '  }',
    '  Clear-Stamp $deadMark',
    '  Start-Sleep -Seconds $settle',
    "  if ((Get-State).s -ne 'gone') { exit 0 }",
    // Tartósan eltűnt-e: egy frissítés pár percre cseréli a fájlokat.
    '  $goneFor = Stamp-Age $goneMark',
    '  if ($goneFor -lt $durable) { exit 0 }',
    '  if ((Installing) -and $goneFor -lt $installCap) { exit 0 }',
    "  Apply-Strict 'gone'",
    '} catch {',
    `  Log (${msg('hiba: ')} + $_.Exception.Message)`,
    '}',
    'exit 0',
    '',
  ].join('\r\n');
}

/**
 * A feladat parancsa: a szkriptet nem fájlként futtatja (azt egy csoport-
 * házirend „csak aláírt szkript” beállítása letiltaná, és az őr csendben sosem
 * futna), hanem beolvassa és szkriptblokként indítja — a végrehajtási házirend
 * erre nem vonatkozik. A fájl a Program Files alatt van: csak rendszergazda írja.
 */
export function windowsGuardLoader(guardPath: string): string {
  return `& ([ScriptBlock]::Create([IO.File]::ReadAllText(${psSingleQuoted(guardPath)})))`;
}

/**
 * Az őr feladatának felvétele (a segéd futtatja, SYSTEM-ként): induláskor és
 * ötpercenként, a rendszer PowerShelljével, a megadott őr-fájllal.
 */
export function windowsGuardRegisterScript(guardPath: string): string {
  const arg = `-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodePowerShell(windowsGuardLoader(guardPath))}`;
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
