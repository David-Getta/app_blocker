# Lakat teljes eltávolítása Windowson. Rendszergazdai PowerShellből futtasd:
#   powershell -ExecutionPolicy Bypass -File uninstall-windows.ps1

Write-Host "Lakat helper feladat eltávolítása..."
schtasks /End /TN "LakatHelper" 2>$null
schtasks /Delete /F /TN "LakatHelper" 2>$null

Write-Host "Hosts-bejegyzések eltávolítása..."
$hosts = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$content = Get-Content $hosts -Raw
$pattern = "(?s)\r?\n*# >>> LAKAT BLOCK BEGIN.*?# <<< LAKAT BLOCK END\r?\n?"
$content = [regex]::Replace($content, $pattern, "`r`n")
Set-Content -Path $hosts -Value $content -NoNewline
ipconfig /flushdns | Out-Null

Write-Host "Állapotfájlok törlése..."
Remove-Item -Recurse -Force (Join-Path $env:ProgramData "Lakat") -ErrorAction SilentlyContinue

Write-Host "Kész. Az alkalmazást a Gépház > Alkalmazások alatt távolíthatod el."
