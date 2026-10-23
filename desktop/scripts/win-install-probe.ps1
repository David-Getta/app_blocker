# A Windows-telepítő és -eltávolító próbája (CI, windows-latest, rendszergazda).
#
# Az Electron 41 óta az app az első értesítéskor a felhasználó SAJÁT Start
# menüjébe is tesz egy Breaker parancsikont, és a HKCU alá bejegyzi az
# értesítés kattintását fogadó COM-osztályt. A gépszintű telepítés eltávolítója
# erről magától nem tudott: a parancsikon a törölt exe-re mutatva a Start
# menüben maradt volna. Ez a próba a VALÓDI telepítőt futtatja:
#   1. csendes telepítés (gépszintű, Program Files);
#   2. a telepített app indítási füstpróbája — a próba-gombon át értesítést
#      küld, ettől teszi le az Electron a felhasználói parancsikont és a
#      HKCU-kulcsot, a RÖGZÍTETT azonosítóval (src/shared/app-id.ts) — ha
#      nem teszi le, a próba nem azt nézné, amit kell: hiba;
#   3. csendes eltávolítás: a felhasználói parancsikon, a HKCU-kulcs, a
#      gépszintű parancsikon és a Gépház-bejegyzés (HKLM) is eltűnik;
#   2b. a segéd a telepített exe-ről, SYSTEM-ként, ahogy az app telepíti:
#      felel, felvesz egy oldalt, és a rendszer feloldója a tiltó címet adja;
#      a feladat akkumulátoron is fut, nincs időkorlátja, hiba után újraindul
#      — és ha valaki az alapértékekre rontja, a segéd induláskor visszateszi;
#   2a. az állapotmappába a segéd előtt egy sima felhasználó fájlt tehet (a rés
#      előfeltétele), utána se a state.json-t nem olvassa, se nem ír bele;
#   2c. AZ ŐR (#149, shared/guard-script.ts): a segéd maga veszi fel (SYSTEM,
#      induláskor és ötpercenként), a mappáját sima felhasználó nem írja; amíg
#      az app a helyén van, a hosts fájlhoz nem nyúl, a leállított segédet
#      elindítja (egy frissítés így áll vissza);
#      ha a segéd nem indul el (letiltott feladat), tíz perc után a szigorú
#      blokk áll be, és a visszaindult segéd a sajátját írja;
#   3b. az app eltávolítása után az őr előbb csak feljegyzi az eltűnést (egy
#      frissítés közben se írjon), tartós eltűnés után a szigorú blokkot teszi
#      a hosts fájlba — a kézzel kivettet és a magában maradt jelölő mellé is —,
#      és a feloldó tilt;
#   4. a kézi eltávolító — előbb a segéd által a gépre tett MÁSOLATA, amire a
#      szigorú blokk magyarázata mutat — egy idegen célú, ugyanilyen nevű
#      parancsikont meghagy, a Breaker.exe-re mutatót leveszi — és a segéd meg
#      az őr feladatát, az őr mappáját és a hosts-blokkot is, a hosts többi
#      része a régi.
# Kilépési kód 0, ha minden stimmel; különben 1.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$desktop = Split-Path -Parent $PSScriptRoot
$script:fail = 0
function Fail($msg) { Write-Host "HIBA: $msg"; $script:fail = 1 }

# A rögzített azonosító a forrásból: ha ott változna, a próba is azt nézi.
$appId = Get-Content (Join-Path $desktop 'src\shared\app-id.ts') -Raw
if ($appId -notmatch "TOAST_ACTIVATOR_CLSID = '(\{[0-9A-F-]+\})'") { Write-Host 'HIBA: nincs TOAST_ACTIVATOR_CLSID'; exit 1 }
$clsid = $Matches[1]
$clsidKey = "HKCU:\Software\Classes\CLSID\$clsid"
$userLnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Breaker.lnk'
$commonLnk = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Breaker.lnk'
$exe = Join-Path $env:ProgramFiles 'Breaker\Breaker.exe'
function UninstallEntries {
  @(Get-ChildItem 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    Where-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DisplayName -like 'Breaker*' })
}

# A kicsomagolt app füstpróbája már letehette a sajátját: tiszta lappal indulunk.
Remove-Item -LiteralPath $userLnk -Force -ErrorAction SilentlyContinue
Remove-Item -Path $clsidKey -Recurse -ErrorAction SilentlyContinue

# 1. Telepítés.
# A telepítő neve az electron-builderé: „Breaker Setup <verzió>.exe” (a kiadás
# feltöltéskor kötőjelesíti, itt még szóközös).
$setup = Get-ChildItem (Join-Path $desktop 'release') -Filter 'Breaker*Setup*.exe' | Select-Object -First 1
if (-not $setup) { Write-Host 'HIBA: nincs telepítő a release mappában'; exit 1 }
Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait
if (-not (Test-Path -LiteralPath $exe)) { Write-Host "HIBA: nem települt: $exe"; exit 1 }
if (-not (Test-Path -LiteralPath $commonLnk)) { Fail "nincs gépszintű parancsikon: $commonLnk" }
if ((UninstallEntries).Count -eq 0) { Fail 'nincs Gépház-bejegyzés a telepítés után' }

# 2. A telepített app füstpróbája — értesítéssel. A parancsikont és a kulcsot
# az Electron egy alacsony prioritású háttérszálon írja; ha a füstpróba előbb
# kilép, egy újabb indítás pótolja (legfeljebb háromszor).
$out = Join-Path $env:RUNNER_TEMP 'install-smoke.txt'
$env:BREAKER_SMOKE_OUT = $out
for ($run = 1; $run -le 3; $run++) {
  Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $exe -ArgumentList '--smoke-test' -Wait -PassThru
  Get-Content -LiteralPath $out -ErrorAction SilentlyContinue | Out-Host
  if ($p.ExitCode -ne 0) { Fail "a telepített app füstpróbája piros (kilépési kód: $($p.ExitCode))"; break }
  for ($i = 0; $i -lt 10 -and -not ((Test-Path -LiteralPath $userLnk) -and (Test-Path $clsidKey)); $i++) { Start-Sleep -Milliseconds 500 }
  if ((Test-Path -LiteralPath $userLnk) -and (Test-Path $clsidKey)) { Write-Host "a felhasználói parancsikon és a COM-bejegyzés megvan ($run. indítás után)"; break }
}
if (-not (Test-Path -LiteralPath $userLnk)) { Fail "az app nem tette le a felhasználói parancsikont ($userLnk) — a próba nem azt nézné, amit kell" }
if (-not (Test-Path $clsidKey)) { Fail "nincs HKCU-bejegyzés a rögzített azonosítóval ($clsid) — a setToastActivatorCLSID nem hatott" }
else {
  $server = (Get-ItemProperty -Path "$clsidKey\LocalServer32" -ErrorAction SilentlyContinue).'(default)'
  if ($server -ne $exe) { Fail "a COM-bejegyzés nem a telepített exe-re mutat: $server" }
}

# 2b. A SEGÉD A TELEPÍTETT EXE-RŐL. Élesben a SYSTEM-feladat a telepített
# Breaker.exe-t indítja --helper kapcsolóval — nem a sima Node-ot, amin a többi
# próba fut. Egy Electron-frissítés után az app hibátlanul indulhat, miközben a
# segéd el sem indul: a tiltás csendben megszűnne minden gépen. Ezért itt
# PONTOSAN az app telepítő-szkriptje fut (shared/install-script.ts,
# windowsInstallScript), a kulccsal, ahogy az app adja; utána a kliens az
# app módján csatlakozik, felvesz egy oldalt, és a rendszer feloldójával nézi,
# hogy tilt-e (helper-probe-client.js).
$taskName = 'BreakerHelper'
# A feladat leállítása. A Windows PowerShell 5.1 a 'Stop' hibakezelés mellett
# a natív parancs átirányított hibakimenetének első soránál kivételt dobna (ha
# a feladat épp nem fut, a schtasks oda ír) — itt ez nem hiba.
function Stop-HelperTask {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  schtasks /End /TN $taskName 2>&1 | Out-Null
  $ErrorActionPreference = $old
}
$hostsFile = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$hostsBefore = [System.IO.File]::ReadAllText($hostsFile)
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$key = -join ($bytes | ForEach-Object { $_.ToString('x2') })
$sha = [System.Security.Cryptography.SHA256]::Create()
$keyHash = -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($key)) | ForEach-Object { $_.ToString('x2') })
# 2a. AZ ÁLLAPOTMAPPA EGY SIMA FELHASZNÁLÓ SZEMÉVEL (helper/win-acl.ts). A
# ProgramData almappái a szülő jogait öröklik: a Users mindent olvashat, és új
# fájlt is tehet beléjük — így a state.json (benne a szinkron kulcsai) mindenkinek
# olvasható volt, és egy előre odatett fájlon át az állapot átvehető. A segéd
# indulása ELŐTT egy friss sima felhasználó odatesz egy fájlt (ez a rés
# előfeltétele); az indulás UTÁN se olvasnia, se írnia nem szabad.
$stateDir = Join-Path $env:ProgramData 'Breaker'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$planted = Join-Path $stateDir 'planted.tmp'
$probeUser = 'breakerstate'
$probePass = 'Pr0be-' + [guid]::NewGuid().ToString('N').Substring(0, 12) + '!aA1'
New-LocalUser -Name $probeUser -Password (ConvertTo-SecureString $probePass -AsPlainText -Force) -AccountNeverExpires -PasswordNeverExpires | Out-Null
Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $probeUser
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class StateProbeLogon {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool LogonUser(string user, string domain, string password, int logonType, int provider, out SafeAccessTokenHandle token);
}
'@
$userToken = $null
foreach ($type in 2, 3) { if ([StateProbeLogon]::LogonUser($probeUser, '.', $probePass, $type, 0, [ref]$userToken)) { break } }
if (-not $userToken -or $userToken.IsInvalid) { Fail 'a sima felhasználó nem jelentkezett be — az állapotmappa próbája nem futhat' }
$script:plantResult = 'nem futott'
if ($userToken -and -not $userToken.IsInvalid) {
  [System.Security.Principal.WindowsIdentity]::RunImpersonated($userToken, [Action]{
    try { [System.IO.File]::WriteAllText($planted, 'x'); $script:plantResult = 'odatette' } catch { $script:plantResult = 'nem tehette oda' }
  })
}
Write-Host "a segéd előtt a sima felhasználó fájlt tesz az állapotmappába: $($script:plantResult)"

$installJs = Join-Path $desktop 'dist\shared\install-script.js'
# Az emelt rész kódolva, ahogy a telepítő adja; a próba már rendszergazda,
# ezért a nem emelt héj RunAs-ugrása (windowsLauncherCommand) kimarad.
$encoded = node -e "const s = require(process.argv[1]); process.stdout.write(s.encodePowerShell(s.windowsInstallScript(process.argv[2], process.argv[3])))" $installJs $exe $keyHash
if ($LASTEXITCODE -ne 0 -or -not $encoded) { Fail 'a telepítő parancsa nem állt össze' }
else {
  powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail "a segéd telepítő-parancsa hibával lépett ki ($LASTEXITCODE)" }
  $action = (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).Actions | Select-Object -First 1
  if (-not $action) { Fail "nincs $taskName feladat" }
  elseif ($action.Execute -ne $exe) { Fail "a feladat nem a telepített exe-t indítja: $($action.Execute)" }
  else { Write-Host "a feladat: $($action.Execute) $($action.Arguments)" }
  # Egy őrző szolgáltatás beállításai (shared/install-script.ts, WINDOWS_TASK_SETTINGS_PS):
  # a Feladatütemező alapértékein a segéd akkumulátoron nem indulna, és 72 óra után leállna.
  function TaskSettingsProblems {
    $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $t) { return @('nincs feladat') }
    $p = @()
    if ($t.Settings.DisallowStartIfOnBatteries) { $p += 'akkumulátoron nem indul' }
    if ($t.Settings.StopIfGoingOnBatteries) { $p += 'akkumulátorra váltáskor leáll' }
    if ($t.Settings.ExecutionTimeLimit -ne 'PT0S') { $p += "időkorlát: $($t.Settings.ExecutionTimeLimit)" }
    if ($t.Settings.RestartCount -lt 1) { $p += 'hiba után nem indul újra' }
    if ($t.Principal.UserId -ne 'SYSTEM' -or $t.Principal.RunLevel -ne 'Highest') { $p += "felhasználó: $($t.Principal.UserId) $($t.Principal.RunLevel)" }
    if (-not ($t.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' })) { $p += 'nem indul a géppel' }
    return $p
  }
  $problems = TaskSettingsProblems
  if ($problems.Count -gt 0) { Fail "a feladat beállításai: $($problems -join '; ')" }
  node (Join-Path $PSScriptRoot 'helper-probe-client.js') '\\.\pipe\breaker-helper' 'example.org' $key | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Fail 'a telepített segéd nem tilt (lásd fent)'
    Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue | Format-List | Out-Host
    Get-Process Breaker -ErrorAction SilentlyContinue | Format-Table Id, SessionId, StartTime -AutoSize | Out-Host
    # A SYSTEM-feladat kimenete sehova nem megy: egyszer közvetlenül, a
    # kimenetét elkapva — hogy a CI naplójából kiderüljön, MIÉRT nem fut.
    Stop-HelperTask
    $diagOut = Join-Path $env:RUNNER_TEMP 'helper-diag-out.txt'
    $diagErr = Join-Path $env:RUNNER_TEMP 'helper-diag-err.txt'
    $d = Start-Process -FilePath $exe -ArgumentList '--helper' -PassThru -RedirectStandardOutput $diagOut -RedirectStandardError $diagErr
    Start-Sleep -Seconds 10
    if (-not $d.HasExited) { Stop-Process -Id $d.Id -Force -ErrorAction SilentlyContinue }
    Write-Host "--- a segéd közvetlenül indítva (kilépett: $($d.HasExited)) ---"
    Get-Content -LiteralPath $diagOut, $diagErr -ErrorAction SilentlyContinue | Out-Host
  }
  if (-not ([System.IO.File]::ReadAllText($hostsFile) -match 'BREAKER BLOCK BEGIN')) { Fail 'a hosts-ban nincs Breaker-blokk' }
  # 2a folytatása: a segéd már fut — a mappa le van zárva.
  if ($userToken -and -not $userToken.IsInvalid) {
    $script:readState = '-'; $script:writeNew = '-'; $script:writePlanted = '-'
    [System.Security.Principal.WindowsIdentity]::RunImpersonated($userToken, [Action]{
      try { [void][System.IO.File]::ReadAllText((Join-Path $stateDir 'state.json')); $script:readState = 'olvasható' } catch { $script:readState = 'tiltva' }
      try { [System.IO.File]::WriteAllText((Join-Path $stateDir 'uj.tmp'), 'x'); $script:writeNew = 'írható' } catch { $script:writeNew = 'tiltva' }
      try { [System.IO.File]::AppendAllText($planted, 'y'); $script:writePlanted = 'írható' } catch { $script:writePlanted = 'tiltva' }
    })
    Write-Host "a segéd után a sima felhasználónak: state.json $($script:readState), új fájl $($script:writeNew), az odatett fájl $($script:writePlanted)"
    if ($script:readState -ne 'tiltva') { Fail 'a sima felhasználó olvassa a state.json-t (benne a szinkron kulcsai)' }
    if ($script:writeNew -ne 'tiltva') { Fail 'a sima felhasználó fájlt tehet az állapotmappába' }
    if ($script:writePlanted -ne 'tiltva') { Fail 'a sima felhasználó az előre odatett fájlját továbbra is írja' }
    $owner = (Get-Acl -LiteralPath $stateDir).Owner
    if ($owner -notmatch 'SYSTEM') { Fail "az állapotmappa tulajdonosa: $owner" }
    if (Test-Path -LiteralPath $planted) {
      $po = (Get-Acl -LiteralPath $planted).Owner
      if ($po -notmatch 'SYSTEM') { Fail "az odatett fájl tulajdonosa maradt: $po" }
    }
  }
  # Az önjavítás (helper/win-task.ts): egy régi, alapértékeken ülő feladatot a
  # segéd induláskor a helyes beállításokra tesz — újratelepítés nélkül.
  Stop-HelperTask
  # Az alapértékek (akkumulátor, 72 óra) — az újraindítás száma és ideje együtt
  # kell, különben a Feladatütemező hibás XML-nek veszi.
  $bad = New-ScheduledTaskSettingsSet -RestartCount 1 -RestartInterval (New-TimeSpan -Minutes 1)
  Set-ScheduledTask -TaskName $taskName -Settings $bad | Out-Null
  if ((TaskSettingsProblems).Count -eq 0) { Fail 'a feladat elrontása nem sikerült — az önjavítás próbája vak lenne' }
  Start-ScheduledTask -TaskName $taskName
  for ($i = 0; $i -lt 60 -and (TaskSettingsProblems).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 }
  $problems = TaskSettingsProblems
  if ($problems.Count -gt 0) { Fail "a segéd nem javította meg a feladata beállításait: $($problems -join '; ')" }
  else { Write-Host 'a segéd induláskor megjavította a feladata beállításait' }
}
# 2c. AZ ŐR. A telepítő szkriptje nem tud róla: a segéd veszi fel induláskor,
# SYSTEM-ként — a meglévő telepítéseken is, újabb UAC-kérdés nélkül.
$guardTask = 'BreakerGuard'
$pf64 = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$guardDir = Join-Path $pf64 'Breaker Guard'
$guardScript = Join-Path $guardDir 'guard.ps1'
$uninstallCopy = Join-Path $guardDir 'uninstall-windows.ps1'
$strictFile = Join-Path $stateDir 'strict-hosts'
# A bélyegek és a napló az őr SAJÁT mappájában: a segéd állapotmappájába az őr
# nem ír (ha az eltűnne, egy sima felhasználó újra létrehozhatná).
$goneMark = Join-Path $guardDir 'guard-gone'
$deadMark = Join-Path $guardDir 'guard-dead'
$guardLog = Join-Path $guardDir 'guard.log'
$note = 'a teljes lista tilt'
function Show-Guard {
  Write-Host '--- az őr naplója ---'
  Get-Content -LiteralPath $guardLog -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -Last 20 | Out-Host
  Get-ScheduledTaskInfo -TaskName $guardTask -ErrorAction SilentlyContinue | Format-List LastRunTime, LastTaskResult | Out-Host
}
# Egy futás az őrből, megvárva a végét (a két megnézés között 20 másodperc).
function Run-Guard {
  Start-ScheduledTask -TaskName $guardTask
  Start-Sleep -Seconds 2
  for ($i = 0; $i -lt 120 -and (Get-ScheduledTask -TaskName $guardTask).State -eq 'Running'; $i++) { Start-Sleep -Seconds 1 }
}
function HostsText { [System.IO.File]::ReadAllText($hostsFile, [System.Text.Encoding]::UTF8) }
for ($i = 0; $i -lt 60 -and -not (Get-ScheduledTask -TaskName $guardTask -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
$gt = Get-ScheduledTask -TaskName $guardTask -ErrorAction SilentlyContinue
if (-not $gt) { Fail "az őr feladata ($guardTask) 60 másodperc alatt sem jött létre — a segéd nem vette fel" }
else {
  $ga = @($gt.Actions)[0]
  Write-Host "az őr feladata: $($ga.Execute) $($ga.Arguments)"
  if ($ga.Execute -ne (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')) { Fail "az őr nem a rendszer PowerShelljével fut: $($ga.Execute)" }
  # Nem -File: egy „csak aláírt szkript” csoportházirend azt letiltaná. A
  # kódolt parancs a szkriptet beolvassa és szkriptblokként indítja.
  if ($ga.Arguments -notmatch '-EncodedCommand (\S+)') { Fail "az őr parancsa nem kódolt: $($ga.Arguments)" }
  else {
    $loader = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1]))
    Write-Host "az őr indítója: $loader"
    if (-not $loader.Contains($guardScript)) { Fail "az őr nem a saját szkriptjét futtatja: $loader" }
  }
  if ($ga.Arguments -match '-File|-ExecutionPolicy') { Fail "az őr szkriptfájlként fut: $($ga.Arguments)" }
  if ($gt.Principal.UserId -ne 'SYSTEM') { Fail "az őr felhasználója: $($gt.Principal.UserId)" }
  if (-not ($gt.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' })) { Fail 'az őr nem indul a géppel' }
  $rep = @($gt.Triggers | Where-Object { $_.Repetition.Interval -eq 'PT5M' })
  if ($rep.Count -eq 0) { Fail 'az őr nem fut ötpercenként' }
  # Az ismétlés ne álljon le egy nap után: üres időtartam = a végtelenségig.
  elseif ($rep[0].Repetition.Duration) { Fail "az őr ismétlése korlátos: $($rep[0].Repetition.Duration)" }
}
if (-not (Test-Path -LiteralPath $guardScript)) { Fail "nincs meg az őr szkriptje: $guardScript" }
if (-not (Test-Path -LiteralPath $uninstallCopy)) { Fail "nincs meg az eltávolító másolata: $uninstallCopy" }
elseif ((Get-FileHash -LiteralPath $uninstallCopy).Hash -ne (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'uninstall-windows.ps1')).Hash) {
  Fail 'az eltávolító másolata eltér a csomagolttól'
}
if (-not (Test-Path -LiteralPath $strictFile)) { Fail "nincs szigorú blokk: $strictFile" }
elseif (-not ([System.IO.File]::ReadAllText($strictFile) -match '(?m)^0\.0\.0\.0 example\.org\r?$')) { Fail 'a szigorú blokkban nincs benne: example.org' }
# Az őr SYSTEM-ként futtatja a szkriptjét: ha egy sima felhasználó írhatná,
# az rendszerjog volna. A Program Files öröklött jogai ezt kizárják — nézzük.
if ($userToken -and -not $userToken.IsInvalid) {
  $script:guardWrite = '-'; $script:guardNew = '-'
  [System.Security.Principal.WindowsIdentity]::RunImpersonated($userToken, [Action]{
    try { [System.IO.File]::AppendAllText($guardScript, '#'); $script:guardWrite = 'írható' } catch { $script:guardWrite = 'tiltva' }
    try { [System.IO.File]::WriteAllText((Join-Path $guardDir 'x.ps1'), 'x'); $script:guardNew = 'írható' } catch { $script:guardNew = 'tiltva' }
  })
  Write-Host "az őr mappája a sima felhasználónak: guard.ps1 $($script:guardWrite), új fájl $($script:guardNew)"
  if ($script:guardWrite -ne 'tiltva') { Fail 'a sima felhasználó átírhatja az őr SYSTEM-ként futó szkriptjét' }
  if ($script:guardNew -ne 'tiltva') { Fail 'a sima felhasználó fájlt tehet az őr mappájába' }
}
# Amíg az app a helyén van és a segéd fut, az őr a hosts fájlhoz nem nyúl.
$hostsLive = HostsText
Run-Guard
if ((HostsText) -ne $hostsLive) { Fail 'az őr a hosts fájlhoz nyúlt, pedig az app a helyén van' }
if (Test-Path -LiteralPath $goneMark) { Fail 'az őr eltűntnek jegyezte fel a helyén lévő appot' }
# A leállított segédet elindítja (egy frissítés leállítja, és a Feladatütemező
# magától nem indítja újra).
Stop-HelperTask
for ($i = 0; $i -lt 20 -and (Get-ScheduledTask -TaskName $taskName).State -eq 'Running'; $i++) { Start-Sleep -Milliseconds 500 }
Run-Guard
for ($i = 0; $i -lt 20 -and (Get-ScheduledTask -TaskName $taskName).State -ne 'Running'; $i++) { Start-Sleep -Milliseconds 500 }
if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') { Fail 'az őr nem indította el a leállított segédet'; Show-Guard }
else { Write-Host 'az őr elindította a leállított segédet' }
# Ha a segéd nem indul el (itt: letiltott feladat), az őr nem hagyja befagyva a
# blokkot: tíz perc után a szigorú blokk áll be. Az első észleléskor még nem.
Stop-HelperTask
Disable-ScheduledTask -TaskName $taskName | Out-Null
Run-Guard
if (-not (Test-Path -LiteralPath $deadMark)) { Fail 'az őr nem jegyezte fel, hogy a segéd nem fut'; Show-Guard }
if ((HostsText).Contains($note)) { Fail 'az őr már az első észleléskor írt — egy frissítés közben is írna' }
[System.IO.File]::WriteAllText($deadMark, ([DateTime]::UtcNow.AddMinutes(-11)).ToString('o'))
Run-Guard
if (-not (HostsText).Contains($note)) { Fail 'a nem induló segéd mellett az őr nem tette a helyére a szigorú blokkot'; Show-Guard }
else { Write-Host 'a nem induló segéd mellett tíz perc után a szigorú blokk áll be' }
# A segéd újra fut: a saját blokkját írja vissza, a bélyeg megy.
Enable-ScheduledTask -TaskName $taskName | Out-Null
Start-ScheduledTask -TaskName $taskName
for ($i = 0; $i -lt 120 -and (HostsText).Contains($note); $i++) { Start-Sleep -Milliseconds 500 }
if ((HostsText).Contains($note)) { Fail 'az újraindult segéd nem írta vissza a saját blokkját' }
Run-Guard
if (Test-Path -LiteralPath $deadMark) { Fail 'a futó segéd mellett a bélyeg maradt' }

# Az NSIS-eltávolító előtt a segéd le: futó exe-t nem törölhetne. A feladat
# és a hosts-blokk marad — azt a kézi eltávolító veszi le (4. lépés).
Stop-HelperTask
for ($i = 0; $i -lt 20 -and (Get-Process Breaker -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
Get-Process Breaker -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 3. Eltávolítás. Az NSIS-eltávolító magát egy ideiglenes helyre másolja és
# onnan fut tovább; a _?= kapcsolóval helyben fut, és megvárható.
$uninst = Join-Path $env:ProgramFiles 'Breaker\Uninstall Breaker.exe'
if (-not (Test-Path -LiteralPath $uninst)) { Write-Host "HIBA: nincs eltávolító: $uninst"; exit 1 }
Start-Process -FilePath $uninst -ArgumentList '/S', "_?=$(Join-Path $env:ProgramFiles 'Breaker')" -Wait
if (Test-Path -LiteralPath $exe) { Fail 'az eltávolítás után is ott az exe' }
if (Test-Path -LiteralPath $userLnk) { Fail "a felhasználói parancsikon ott maradt: $userLnk" }
if (Test-Path $clsidKey) { Fail "a HKCU COM-bejegyzés ott maradt: $clsidKey" }
if (Test-Path -LiteralPath $commonLnk) { Fail "a gépszintű parancsikon ott maradt: $commonLnk" }
if ((UninstallEntries).Count -ne 0) { Fail 'a Gépház-bejegyzés (HKLM) ott maradt — az eltávolító rossz kontextusban zárt' }

# 3b. AZ APP ELTŰNT. Az NSIS-eltávolító a feladatokhoz és a hosts fájlhoz nem
# nyúl (az app eltávolítása nem lehet ingyenes lazítás): az őr veszi át. Előbb
# csak feljegyzi az eltűnést — egy frissítés pár percre cseréli a fájlokat —,
# és csak tartós eltűnés után ír.
Run-Guard
if (-not (Test-Path -LiteralPath $goneMark)) { Fail 'az őr nem jegyezte fel, hogy az app eltűnt'; Show-Guard }
if ((HostsText).Contains($note)) { Fail 'az őr már az első észleléskor írt — egy frissítés közben is írna' }
# A feljegyzés hat perccel korábbra: mintha két ütemezett futása között
# végig hiányzott volna.
[System.IO.File]::WriteAllText($goneMark, ([DateTime]::UtcNow.AddMinutes(-6)).ToString('o'))
Run-Guard
$h = HostsText
if (-not $h.Contains($note)) { Fail 'az őr nem tette a helyére a szigorú blokkot'; Show-Guard }
elseif (-not ($h -match '(?m)^0\.0\.0\.0 example\.org\r?$')) { Fail 'a hosts szigorú blokkjában nincs: example.org' }
elseif (([regex]::Matches($h, 'BREAKER BLOCK BEGIN')).Count -ne 1) { Fail 'a hosts-ban nem egy blokk van' }
# A rendszer feloldója: Windowson a tiltott név fel sem oldódik (vagy a tiltó címet adja).
node -e "const { isSinkhole } = require(process.argv[1]); require('dns').promises.lookup('example.org', { all: true }).then((a) => process.exit(a.length > 0 && a.every((x) => isSinkhole(x.address)) ? 0 : 1), () => process.exit(0))" (Join-Path $desktop 'dist\shared\selftest.js')
if ($LASTEXITCODE -ne 0) { Fail 'a szigorú blokk mellett a feloldó nem tilt: example.org' }
# A kézzel kivett blokkot a következő futás visszateszi.
$stripped = [regex]::Replace($h, '(?s)\r?\n*# >>> BREAKER BLOCK BEGIN.*?# <<< BREAKER BLOCK END\r?\n?', "`r`n")
[System.IO.File]::WriteAllText($hostsFile, $stripped, (New-Object System.Text.UTF8Encoding $false))
if ((HostsText).Contains('BREAKER BLOCK')) { Fail 'a próba nem tudta kivenni a blokkot' }
Run-Guard
if (-not (HostsText).Contains($note)) { Fail 'a kézzel kivett szigorú blokkot az őr nem tette vissza'; Show-Guard }
else { Write-Host 'az app eltávolítása után az őr a szigorú blokkot tartja, a kézzel kivettet is visszateszi' }
# Ha csak a nyitó jelölő maradt (felemás jelölők), azt is rendbe teszi.
$h = HostsText
$lone = [regex]::Replace($h, '(?s)(# >>> BREAKER BLOCK BEGIN[^\r\n]*)\r?\n.*?# <<< BREAKER BLOCK END\r?\n?', '$1' + "`r`n")
[System.IO.File]::WriteAllText($hostsFile, $lone, (New-Object System.Text.UTF8Encoding $false))
if ((HostsText).Contains($note) -or (HostsText).Contains('BREAKER BLOCK END')) { Fail 'a próba nem tudta a nyitó jelölőt magára hagyni' }
Run-Guard
$h = HostsText
if (-not $h.Contains($note)) { Fail 'a magában maradt nyitó jelölő mellé az őr nem tette vissza a blokkot'; Show-Guard }
elseif (([regex]::Matches($h, 'BREAKER BLOCK BEGIN')).Count -ne 1 -or ([regex]::Matches($h, 'BREAKER BLOCK END')).Count -ne 1) { Fail 'a felemás jelölők után nem egy blokk van' }

# 4. A kézi eltávolító — előbb a segéd által a gépre tett másolat, amire a
# szigorú blokk magyarázata mutat: idegen célú parancsikon marad, a
# Breaker.exe-re mutató megy; a segéd, az őr és a mappája is.
$wsh = New-Object -ComObject WScript.Shell
$s = $wsh.CreateShortcut($userLnk); $s.TargetPath = "$env:WINDIR\notepad.exe"; $s.Save()
powershell -NoProfile -ExecutionPolicy Bypass -File $uninstallCopy | Out-Host
if (-not (Test-Path -LiteralPath $userLnk)) { Fail 'a kézi eltávolító egy idegen célú Breaker.lnk-t is levett' }
if (Get-ScheduledTask -TaskName $guardTask -ErrorAction SilentlyContinue) { Fail "a $guardTask feladat a kézi eltávolító után is megvan" }
if (Test-Path -LiteralPath $guardDir) { Fail "az őr mappája a kézi eltávolító után is megvan: $guardDir" }
if ((HostsText).Contains('BREAKER BLOCK')) { Fail 'a szigorú blokk a kézi eltávolító után is bent van' }
Remove-Item -LiteralPath $userLnk -Force
$s = $wsh.CreateShortcut($userLnk); $s.TargetPath = 'C:\Program Files\Breaker\Breaker.exe'; $s.Save()
New-Item -Path "$clsidKey\LocalServer32" -Force | Out-Null
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'uninstall-windows.ps1') | Out-Host
if (Test-Path -LiteralPath $userLnk) { Fail 'a kézi eltávolító a Breaker parancsikonját ott hagyta' }
if (Test-Path $clsidKey) { Fail 'a kézi eltávolító a HKCU COM-bejegyzést ott hagyta' }
# …és a segédet: a feladat és a hosts-blokk megy, a hosts többi része a régi.
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Fail "a $taskName feladat a kézi eltávolító után is megvan" }
$hostsAfter = [System.IO.File]::ReadAllText($hostsFile)
if ($hostsAfter -match 'BREAKER BLOCK') { Fail 'a hosts-blokk a kézi eltávolító után is bent van' }
elseif (($hostsAfter -replace "`r`n", "`n").TrimEnd() -ne ($hostsBefore -replace "`r`n", "`n").TrimEnd()) {
  Fail 'a hosts többi része megváltozott'; Write-Host $hostsAfter
}

Remove-LocalUser -Name $probeUser -ErrorAction SilentlyContinue

if ($script:fail -eq 0) { Write-Host 'Telepítés-próba OK (telepítés, értesítés: felhasználói parancsikon és COM-bejegyzés a rögzített azonosítóval; a segéd a telepített exe-ről, SYSTEM-ként: felel és tilt, a feladata egy őrző szolgáltatás beállításaival megy, és a régit maga javítja; az állapotmappáját egy sima felhasználó se nem olvassa, se nem írja; eltávolítás: semmi nem marad, a Gépház-bejegyzés sem; az őrt a segéd veszi fel, a mappáját sima felhasználó nem írja, amíg az app megvan, nem ír, a leállított segédet elindítja, a nem indulót tíz perc után szigorú blokkal pótolja; az app eltávolítása után tartós eltűnésre a szigorú blokkot tartja, a kézzel kivettet is visszateszi; a kézi eltávolító — a gépre tett másolat is — csak a mienket veszi le, a segédet, az őrt és a hosts-blokkot is)' }
exit $script:fail
