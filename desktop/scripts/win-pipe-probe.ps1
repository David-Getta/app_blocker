# A Windows-segéd csatornájának próbája (CI, windows-latest).
#
# A telepített segéd SYSTEM-ként fut (ütemezett feladat), az app viszont a
# bejelentkezett felhasználóé, NEM emelt jogokkal. A kérdés: egy sima (nem
# rendszergazda) felhasználó tud-e írni a segéd named pipe-jába — vagyis
# egyáltalán beszélhet-e az app a segéddel. A futtató rendszergazda, ezért a
# sima felhasználót egy friss helyi fiókkal és megszemélyesítéssel játsszuk el.
#
# Kimenet: a pipe ACL-je, a rendszergazda és a sima felhasználó eredménye.
# Kilépési kód: 0, ha a sima felhasználó kap választ; 1, ha nem.

$ErrorActionPreference = 'Stop'
$desktop = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$server = Join-Path $PSScriptRoot 'win-pipe-probe-server.js'
$temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$log = Join-Path $temp 'pipe-probe-server.log'
$pipeName = 'breaker-helper'
$taskName = 'BreakerPipeProbe'

function Test-Pipe { [System.IO.Directory]::GetFiles('\\.\pipe\') -contains "\\.\pipe\$pipeName" }

if (Test-Pipe) { Write-Host "már létezik egy $pipeName pipe — a próba nem tiszta gépen fut"; exit 1 }

# 1. A segéd szervere SYSTEM-ként, ahogy a telepítő ütemezett feladata indítja.
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$server`" `"$log`"" -WorkingDirectory $desktop
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
for ($i = 0; $i -lt 60 -and -not (Test-Pipe); $i++) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Pipe)) {
  Write-Host 'a SYSTEM-szerver nem nyitotta meg a pipe-ot; a naplója:'
  if (Test-Path $log) { Get-Content $log | Write-Host }
  exit 1
}
Write-Host "a SYSTEM-szerver fut: \\.\pipe\$pipeName"

# 2. Az ACL, ahogy a Windows látja.
try {
  $acl = [System.IO.Directory]::GetAccessControl("\\.\pipe\$pipeName")
  Write-Host '--- a pipe ACL-je ---'
  foreach ($rule in $acl.Access) {
    Write-Host ("{0,-40} {1,-6} {2}" -f $rule.IdentityReference, $rule.AccessControlType, $rule.FileSystemRights)
  }
} catch {
  Write-Host "az ACL nem olvasható: $($_.Exception.Message)"
}

# Egy kérés–válasz a pipe-on: a `status` egy sor JSON, a válasz is egy sor.
function Invoke-PipeStatus {
  try {
    $p = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
    $p.Connect(5000)
    $w = New-Object System.IO.StreamWriter($p)
    $w.AutoFlush = $true
    $r = New-Object System.IO.StreamReader($p)
    $w.Write('{"id":1,"op":"status"}' + "`n")
    $line = $r.ReadLine()
    $p.Dispose()
    if ($null -eq $line) { return 'HIBA: üres válasz' }
    return 'OK ' + $line.Substring(0, [Math]::Min(100, $line.Length))
  } catch {
    return 'HIBA ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message
  }
}

# 3. A futtató maga (rendszergazda) — az alapvonal.
$admin = Invoke-PipeStatus
Write-Host "rendszergazda: $admin"

# 4. Egy sima helyi felhasználó, megszemélyesítve — ahogy a nem emelt app.
$user = 'breakerprobe'
$pass = 'Pr0be-' + [guid]::NewGuid().ToString('N').Substring(0, 12) + '!aA1'
net user $user $pass /add | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ProbeLogon {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool LogonUser(string user, string domain, string password, int logonType, int provider, out SafeAccessTokenHandle token);
}
'@
$token = $null
$plain = 'nincs'
# 2 = interaktív (ahogy az app fut), 3 = hálózati (ha az interaktív nem engedett)
foreach ($type in 2, 3) {
  if ([ProbeLogon]::LogonUser($user, '.', $pass, $type, 0, [ref]$token)) {
    Write-Host "sima felhasználó bejelentkezve (típus: $type)"
    $script:plainResult = 'nem futott'
    [System.Security.Principal.WindowsIdentity]::RunImpersonated($token, [Action]{
      $script:plainResult = Invoke-PipeStatus
    })
    $plain = $script:plainResult
    break
  } else {
    Write-Host "LogonUser (típus: $type) nem sikerült: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
}
Write-Host "sima felhasználó: $plain"

# 5. Takarítás.
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
net user $user /delete | Out-Null
if (Test-Path $log) { Write-Host '--- a szerver naplója ---'; Get-Content $log | Write-Host }

if ($plain.StartsWith('OK')) { Write-Host 'EREDMÉNY: a sima felhasználó eléri a segédet'; exit 0 }
Write-Host 'EREDMÉNY: a sima felhasználó NEM éri el a segédet — a nem emelt app sem'
exit 1
