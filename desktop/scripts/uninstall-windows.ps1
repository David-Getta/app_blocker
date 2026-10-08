# Breaker teljes eltávolítása Windowson. Rendszergazdai PowerShellből futtasd:
#   powershell -ExecutionPolicy Bypass -File uninstall-windows.ps1

Write-Host "Breaker helper feladat eltávolítása..."
schtasks /End /TN "BreakerHelper" 2>$null
schtasks /Delete /F /TN "BreakerHelper" 2>$null

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
# Csak azt vesszük le, amit a Breaker írt (lásd src/helper/doh-policy.ts): a
# Chromium-család „off” értékét, a Firefox két registry-értékét és a saját
# policies.json-unkat — ha pontosan a mieink. Egy szervezet saját házirendjét
# (GPO) a következő frissítése úgyis visszaírja.
foreach ($key in @(
  "HKLM:\SOFTWARE\Policies\Google\Chrome",
  "HKLM:\SOFTWARE\Policies\Microsoft\Edge",
  "HKLM:\SOFTWARE\Policies\Chromium",
  "HKLM:\SOFTWARE\Policies\BraveSoftware\Brave"
)) {
  $v = (Get-ItemProperty -Path $key -Name "DnsOverHttpsMode" -ErrorAction SilentlyContinue).DnsOverHttpsMode
  if ($v -eq "off") { Remove-ItemProperty -Path $key -Name "DnsOverHttpsMode" -ErrorAction SilentlyContinue }
}
$ff = "HKLM:\SOFTWARE\Policies\Mozilla\Firefox\DNSOverHTTPS"
$ffv = Get-ItemProperty -Path $ff -ErrorAction SilentlyContinue
if ($ffv -and $ffv.Enabled -eq 0 -and $ffv.Locked -eq 1) {
  Remove-ItemProperty -Path $ff -Name "Enabled", "Locked" -ErrorAction SilentlyContinue
}
foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
  if (-not $base) { continue }
  $pol = Join-Path $base "Mozilla Firefox\distribution\policies.json"
  if ((Test-Path $pol) -and (((Get-Content $pol -Raw) -replace '\s', '') -eq '{"policies":{"DNSOverHTTPS":{"Enabled":false,"Locked":true}}}')) {
    Remove-Item -Force $pol
  }
}

Write-Host "Állapotfájlok törlése..."
Remove-Item -Recurse -Force (Join-Path $env:ProgramData "Breaker") -ErrorAction SilentlyContinue

Write-Host "Kész. Az alkalmazást a Gépház > Alkalmazások alatt távolíthatod el."
