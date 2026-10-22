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
#   4. a kézi eltávolító (uninstall-windows.ps1) egy idegen célú, ugyanilyen
#      nevű parancsikont meghagy, a Breaker.exe-re mutatót leveszi — és a
#      segéd feladatát meg a hosts-blokkot is, a hosts többi része a régi.
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
  # Az önjavítás (helper/win-task.ts): egy régi, alapértékeken ülő feladatot a
  # segéd induláskor a helyes beállításokra tesz — újratelepítés nélkül.
  Stop-HelperTask
  Set-ScheduledTask -TaskName $taskName -Settings (New-ScheduledTaskSettingsSet) | Out-Null
  if ((TaskSettingsProblems).Count -eq 0) { Fail 'a feladat elrontása nem sikerült — az önjavítás próbája vak lenne' }
  Start-ScheduledTask -TaskName $taskName
  for ($i = 0; $i -lt 60 -and (TaskSettingsProblems).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 }
  $problems = TaskSettingsProblems
  if ($problems.Count -gt 0) { Fail "a segéd nem javította meg a feladata beállításait: $($problems -join '; ')" }
  else { Write-Host 'a segéd induláskor megjavította a feladata beállításait' }
}
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

# 4. A kézi eltávolító: idegen célú parancsikon marad, a Breaker.exe-re mutató megy.
$wsh = New-Object -ComObject WScript.Shell
$s = $wsh.CreateShortcut($userLnk); $s.TargetPath = "$env:WINDIR\notepad.exe"; $s.Save()
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'uninstall-windows.ps1') | Out-Host
if (-not (Test-Path -LiteralPath $userLnk)) { Fail 'a kézi eltávolító egy idegen célú Breaker.lnk-t is levett' }
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

if ($script:fail -eq 0) { Write-Host 'Telepítés-próba OK (telepítés, értesítés: felhasználói parancsikon és COM-bejegyzés a rögzített azonosítóval; a segéd a telepített exe-ről, SYSTEM-ként: felel és tilt, a feladata egy őrző szolgáltatás beállításaival megy, és a régit maga javítja; eltávolítás: semmi nem marad, a Gépház-bejegyzés sem; a kézi eltávolító csak a mienket veszi le, a segédet és a hosts-blokkot is)' }
exit $script:fail
