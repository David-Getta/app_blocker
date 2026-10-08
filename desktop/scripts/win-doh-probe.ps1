# A böngészők DoH-házirendjének próbája (CI, windows-latest, rendszergazda).
#
# A segéd a VALÓDI applyDohPolicies-szel írja be a házirendet (a lefordított
# dist/helper/hosts.js), utána a VALÓDI eltávolító szkript fut. A próba azt
# nézi, hogy
#   1. a beírás után mind a négy Chromium-kulcsban ott az „off”, és a Firefox
#      két registry-értéke is;
#   2. a gép saját Firefox policies.json-ja (ha van) érintetlen marad — a
#      v0.4.252 előtti segéd az egész fájlt cserélte;
#   3. az eltávolítás után a mieink eltűntek, egy IDEGEN érték (amit nem mi
#      írtunk) viszont marad.
# Kilépési kód 0, ha minden stimmel; különben 1.

$ErrorActionPreference = 'Stop'
# A CI naplója csövön át olvas: UTF-8 nélkül az ékezetek kérdőjelek lennének.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$desktop = Split-Path -Parent $PSScriptRoot
$script:fail = 0
function Fail($msg) { Write-Host "HIBA: $msg"; $script:fail = 1 }
function Val($key, $name) { (Get-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue).$name }

$chromium = @(
  'HKLM:\SOFTWARE\Policies\Google\Chrome',
  'HKLM:\SOFTWARE\Policies\Microsoft\Edge',
  'HKLM:\SOFTWARE\Policies\Chromium',
  'HKLM:\SOFTWARE\Policies\BraveSoftware\Brave'
)
$ff = 'HKLM:\SOFTWARE\Policies\Mozilla\Firefox\DNSOverHTTPS'
$ours = '{"policies":{"DNSOverHTTPS":{"Enabled":false,"Locked":true}}}'

# Hogy a policies.json-ellenőrzés ne legyen üres egy Firefox nélküli gépen,
# a próba maga tesz le kettőt: egy IDEGEN fájlt (egy szervezet vagy egy másik
# program házirendje — a segéd nem nyúlhat hozzá, az eltávolító sem), és egy
# pontosan a régi segéd által írtat (azt az eltávolító viheti).
$foreign = "{`n  ""policies"": {`n    ""DisableAppUpdate"": true`n  }`n}"
$seedForeign = Join-Path $env:ProgramFiles 'Mozilla Firefox\distribution\policies.json'
if (-not (Test-Path $seedForeign)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $seedForeign) | Out-Null
  Set-Content -Path $seedForeign -Value $foreign -NoNewline
}
$seedOurs = $null
if (${env:ProgramFiles(x86)}) {
  $seedOurs = Join-Path ${env:ProgramFiles(x86)} 'Mozilla Firefox\distribution\policies.json'
  if (Test-Path $seedOurs) { $seedOurs = $null } else {
    New-Item -ItemType Directory -Force -Path (Split-Path $seedOurs) | Out-Null
    Set-Content -Path $seedOurs -Value "{`n  ""policies"": {`n    ""DNSOverHTTPS"": {`n      ""Enabled"": false,`n      ""Locked"": true`n    }`n  }`n}" -NoNewline
  }
}

# A gép Firefox-házirendjei, ahogy most vannak.
$polFiles = @{}
foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
  if (-not $base) { continue }
  $pol = Join-Path $base 'Mozilla Firefox\distribution\policies.json'
  if (Test-Path $pol) { $polFiles[$pol] = Get-Content $pol -Raw }
}
Write-Host "Firefox policies.json a gépen: $($polFiles.Count) db"

# 1. A valódi segéd-kód írja be.
Push-Location $desktop
node -e "require('./dist/helper/hosts').applyDohPolicies(console.log).then((ok) => process.exit(ok ? 0 : 1))"
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Fail "az applyDohPolicies nem sikerült ($code)" }
foreach ($k in $chromium) { if ((Val $k 'DnsOverHttpsMode') -ne 'off') { Fail "$k : a DnsOverHttpsMode nem off" } }
if ((Val $ff 'Enabled') -ne 0 -or (Val $ff 'Locked') -ne 1) { Fail 'a Firefox registry-házirendje hiányzik' }

# 2. A gép policies.json-ja érintetlen.
foreach ($pol in $polFiles.Keys) {
  if ((Get-Content $pol -Raw) -ne $polFiles[$pol]) { Fail "a segéd átírta: $pol" }
}

# 3. Egy idegen érték: valaki a Brave-et kézzel „secure”-ra állította.
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\BraveSoftware\Brave' -Name 'DnsOverHttpsMode' -Value 'secure'

# 4. A valódi eltávolító.
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'uninstall-windows.ps1') | Out-Host

foreach ($k in $chromium[0..2]) {
  if ($null -ne (Val $k 'DnsOverHttpsMode')) { Fail "$k : a mi „off” értékünk ott maradt" }
}
if ((Val 'HKLM:\SOFTWARE\Policies\BraveSoftware\Brave' 'DnsOverHttpsMode') -ne 'secure') { Fail 'az idegen Brave-érték eltűnt' }
if ($null -ne (Val $ff 'Enabled') -or $null -ne (Val $ff 'Locked')) { Fail 'a Firefox registry-házirendje ott maradt' }
foreach ($pol in $polFiles.Keys) {
  $before = $polFiles[$pol]
  if (($before -replace '\s', '') -eq $ours) { continue }  # a régi segédé volt: mehet
  if (-not (Test-Path $pol) -or (Get-Content $pol -Raw) -ne $before) { Fail "az eltávolító átírta: $pol" }
}

if ($seedOurs -and (Test-Path $seedOurs)) { Fail "a régi segéd saját policies.json-ja ott maradt: $seedOurs" }

if ($script:fail -eq 0) { Write-Host 'DoH-házirend próba OK (beírás, a gép policies.json-ja érintetlen, levétel, az idegen érték marad)' }
exit $script:fail
