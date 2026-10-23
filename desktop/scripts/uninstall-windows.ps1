# Breaker teljes eltávolítása Windowson. Rendszergazdai PowerShellből futtasd:
#   powershell -ExecutionPolicy Bypass -File uninstall-windows.ps1

# Ha a szkriptet a saját mappájából (Breaker Guard) futtatod, a végén azt is
# törölni kell — ne az legyen a munkakönyvtár.
Set-Location -LiteralPath $env:SystemRoot

Write-Host "Breaker helper feladat eltávolítása..."
schtasks /End /TN "BreakerHelper" 2>$null
schtasks /Delete /F /TN "BreakerHelper" 2>$null

Write-Host "Az őr eltávolítása..."
# A segéd után: egy futó segéd induláskor újra felvenné az őrt. Az őr a szigorú
# blokkot tartja, ha az app eltűnt — a hosts-takarítás csak utána jöhet.
schtasks /End /TN "BreakerGuard" 2>$null
schtasks /Delete /F /TN "BreakerGuard" 2>$null

Write-Host "A bejelentkezéskori indítás eltávolítása..."
# A „Breaker” bejegyzés a felhasználó saját indítási listájában (HKCU) van:
# rendszergazdai PowerShellből is a futtató felhasználóé.
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "Breaker" -ErrorAction SilentlyContinue
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" -Name "Breaker" -ErrorAction SilentlyContinue

Write-Host "Hosts-bejegyzések eltávolítása..."
$hosts = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$content = Get-Content $hosts -Raw
$pattern = "(?s)\r?\n*# >>> BREAKER BLOCK BEGIN.*?# <<< BREAKER BLOCK END\r?\n?"
$content = [regex]::Replace($content, $pattern, "`r`n")
Set-Content -Path $hosts -Value $content -NoNewline
ipconfig /flushdns | Out-Null

Write-Host "A böngészők DoH-házirendjének levétele..."
# Azt vesszük le, amit a Breaker ír (lásd src/helper/doh-policy.ts): a
# Chromium-család „off” értékét, a Firefox registry-értékeit és a régi segéd
# policies.json-ját. ÉRTÉK SZERINT döntünk — azt, hogy ki írta, a registry
# nem tudja: egy ugyanilyen „off” (vagy Firefox Enabled=0 + Locked=1), amit
# valaki más (egy másik program, egy GPO) tett oda, ugyanígy megy. Egy GPO a
# házirendje következő alkalmazásakor visszaírja; egy kézzel vagy egy másik
# programmal beállított érték nem jön vissza. Ami MÁS értéket tart, az marad;
# és amit a segéd a futása alatt felülírt, azt ez nem állítja vissza.
function Remove-EmptyKeys($path) {
  # Az üresen maradt kulcs is nyom: a Firefox egy üres DNSOverHTTPS-kulcsot is
  # házirendnek vesz ({}), ami egy policies.json DNSOverHTTPS-ét felülírná.
  # Csak a teljesen üres kulcs megy, alulról fölfelé, a Policies-ig.
  while ($path -and $path -ne "HKLM:\SOFTWARE\Policies") {
    $k = Get-Item -Path $path -ErrorAction SilentlyContinue
    if (-not $k -or $k.ValueCount -ne 0 -or $k.SubKeyCount -ne 0) { return }
    Remove-Item -Path $path -ErrorAction SilentlyContinue
    $path = Split-Path $path -Parent
  }
}
foreach ($key in @(
  "HKLM:\SOFTWARE\Policies\Google\Chrome",
  "HKLM:\SOFTWARE\Policies\Microsoft\Edge",
  "HKLM:\SOFTWARE\Policies\Chromium",
  "HKLM:\SOFTWARE\Policies\BraveSoftware\Brave"
)) {
  $v = (Get-ItemProperty -Path $key -Name "DnsOverHttpsMode" -ErrorAction SilentlyContinue).DnsOverHttpsMode
  if ($v -eq "off") { Remove-ItemProperty -Path $key -Name "DnsOverHttpsMode" -ErrorAction SilentlyContinue }
  Remove-EmptyKeys $key
}
$ff = "HKLM:\SOFTWARE\Policies\Mozilla\Firefox\DNSOverHTTPS"
$ffv = Get-ItemProperty -Path $ff -ErrorAction SilentlyContinue
if ($ffv -and $ffv.Enabled -eq 0 -and $ffv.Locked -eq 1) {
  Remove-ItemProperty -Path $ff -Name "Enabled", "Locked" -ErrorAction SilentlyContinue
  # A v0.4.256 óta a Fallback=1 is a miénk (nélküle egy ott maradt Fallback=0
  # a „DoH ki”-ből „csak DoH”-t csinálna).
  if ($ffv.Fallback -eq 1) { Remove-ItemProperty -Path $ff -Name "Fallback" -ErrorAction SilentlyContinue }
}
Remove-EmptyKeys $ff
foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
  if (-not $base) { continue }
  $pol = Join-Path $base "Mozilla Firefox\distribution\policies.json"
  if ((Test-Path $pol) -and (((Get-Content $pol -Raw) -replace '\s', '') -eq '{"policies":{"DNSOverHTTPS":{"Enabled":false,"Locked":true}}}')) {
    Remove-Item -Force $pol
  }
}

Write-Host "Állapotfájlok törlése..."
Remove-Item -Recurse -Force (Join-Path $env:ProgramData "Breaker") -ErrorAction SilentlyContinue
# Az őr és ennek a szkriptnek a másolata (a 64 bites Program Files alatt).
$pf = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
Remove-Item -Recurse -Force (Join-Path $pf "Breaker Guard") -ErrorAction SilentlyContinue

Write-Host "A felhasználói Start menü parancsikon és az értesítés-kattintás bejegyzése..."
# Az Electron 41 óta az app az első értesítéskor a felhasználó SAJÁT Start
# menüjébe is tesz egy Breaker parancsikont, és a HKCU alá bejegyzi az
# értesítés kattintását fogadó COM-osztályt (rögzített azonosítóval, lásd
# src/shared/app-id.ts). Az app eltávolítója csak a jóváhagyó felhasználóét
# éri el; ez minden profilt végigjár. A parancsikont csak akkor vesszük le, ha
# egy Breaker.exe-re mutat — egy ugyanilyen nevű idegen parancsikon marad.
$toastClsid = '{E34DF69A-9041-4581-B6D2-54E40EEB0A50}'
$wsh = New-Object -ComObject WScript.Shell
$profiles = @(Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue | Where-Object { -not $_.Special } | ForEach-Object { $_.LocalPath })
if ($env:USERPROFILE -and ($profiles -notcontains $env:USERPROFILE)) { $profiles += $env:USERPROFILE }
foreach ($prof in $profiles) {
  if (-not $prof) { continue }
  $lnk = Join-Path $prof 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Breaker.lnk'
  if (-not (Test-Path -LiteralPath $lnk)) { continue }
  $target = ''
  try { $target = $wsh.CreateShortcut($lnk).TargetPath } catch { }
  if ($target -and ((Split-Path -Leaf $target) -eq 'Breaker.exe')) {
    Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue
  }
}
# A futtató felhasználó HKCU-ja, és a betöltött többi profilé.
Remove-Item -Path "HKCU:\Software\Classes\CLSID\$toastClsid" -Recurse -ErrorAction SilentlyContinue
Get-ChildItem 'Registry::HKEY_USERS' -ErrorAction SilentlyContinue | ForEach-Object {
  $k = "Registry::$($_.Name)\Software\Classes\CLSID\$toastClsid"
  if (Test-Path -LiteralPath $k) { Remove-Item -LiteralPath $k -Recurse -ErrorAction SilentlyContinue }
}

Write-Host "Kész. Az alkalmazást a Gépház > Alkalmazások alatt távolíthatod el."
