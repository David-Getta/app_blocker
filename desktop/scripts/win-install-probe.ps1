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
#   4. a kézi eltávolító (uninstall-windows.ps1) egy idegen célú, ugyanilyen
#      nevű parancsikont meghagy, a Breaker.exe-re mutatót leveszi.
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

if ($script:fail -eq 0) { Write-Host 'Telepítés-próba OK (telepítés, értesítés: felhasználói parancsikon és COM-bejegyzés a rögzített azonosítóval, eltávolítás: semmi nem marad, a Gépház-bejegyzés sem; a kézi eltávolító csak a mienket veszi le)' }
exit $script:fail
