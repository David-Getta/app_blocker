# A Windows-segéd csatornájának próbája (CI, windows-latest).
#
# A telepített segéd SYSTEM-ként fut (ütemezett feladat), az app viszont a
# bejelentkezett felhasználóé, NEM emelt jogokkal. Az alapértelmezett pipe-
# leíró a mindenki-csoportnak csak olvasást ad — ez a próba mutatta meg, hogy
# a nem emelt app egyetlen kérést sem tudott küldeni ("Access denied"). Azóta
# a pipe kulccsal nyílik (shared/client-key.ts): mindenki írhatja, de csak a
# kulcsot bemutató kapcsolat kap szót.
#
# A futtató rendszergazda, ezért a sima felhasználót egy friss helyi fiókkal
# és megszemélyesítéssel játsszuk el. Kilépési kód 0, ha a sima felhasználó
# kulcs NÉLKÜL elutasítást, kulccsal választ kap; különben 1.

$ErrorActionPreference = 'Stop'
# A CI naplója csövön át olvas: UTF-8 nélkül az ékezetek kérdőjelek lennének.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$desktop = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$server = Join-Path $PSScriptRoot 'win-pipe-probe-server.js'
$temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$log = Join-Path $temp 'pipe-probe-server.log'
$pipeName = 'breaker-helper'
$taskName = 'BreakerPipeProbe'

function Test-Pipe { [System.IO.Directory]::GetFiles('\\.\pipe\') -contains "\\.\pipe\$pipeName" }

if (Test-Pipe) { Write-Host "már létezik egy $pipeName pipe — a próba nem tiszta gépen fut"; exit 1 }

# A kulcs és a lenyomata — a telepítő ugyanígy: a kulcs az appé, a lenyomat a segédé.
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$key = -join ($bytes | ForEach-Object { $_.ToString('x2') })
$sha = [System.Security.Cryptography.SHA256]::Create()
$keyHash = -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($key)) | ForEach-Object { $_.ToString('x2') })

# 1. A segéd szervere SYSTEM-ként, ahogy a telepítő ütemezett feladata indítja.
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$server`" `"$log`" $keyHash" -WorkingDirectory $desktop
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
for ($i = 0; $i -lt 60 -and -not (Test-Pipe); $i++) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Pipe)) {
  Write-Host 'a SYSTEM-szerver nem nyitotta meg a pipe-ot; a naplója:'
  if (Test-Path $log) { Get-Content -Encoding UTF8 $log | Write-Host }
  exit 1
}
Write-Host "a SYSTEM-szerver fut: \\.\pipe\$pipeName"

# 2. Az ACL, ahogy a Windows látja: a rendszergazda kliens-végén át olvasva
#    (a pipe nem fájl — a fájlos ACL-olvasó 87-es hibával elhasal rajta).
try {
  $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
  $c.Connect(5000)
  $sec = $c.GetAccessControl()
  Write-Host '--- a pipe ACL-je ---'
  Write-Host ($sec.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access))
  foreach ($rule in $sec.GetAccessRules($true, $true, [System.Security.Principal.NTAccount])) {
    Write-Host ("{0,-40} {1,-6} {2}" -f $rule.IdentityReference, $rule.AccessControlType, $rule.PipeAccessRights)
  }
  $c.Dispose()
} catch {
  Write-Host "az ACL nem olvasható: $($_.Exception.Message)"
}

# Egy kapcsolat a pipe-on: opcionálisan a `hello` a kulccsal, aztán `status`.
# A válasz: "OK", "UNAUTHORIZED", vagy a hiba szövege.
function Invoke-PipeSession([string]$withKey) {
  try {
    $p = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
    $p.Connect(5000)
    $w = New-Object System.IO.StreamWriter($p)
    $w.AutoFlush = $true
    $r = New-Object System.IO.StreamReader($p)
    if ($withKey) {
      $w.Write('{"id":1,"op":"hello","key":"' + $withKey + '"}' + "`n")
      $hello = $r.ReadLine()
      if ($null -eq $hello -or -not $hello.Contains('"ok":true')) { $p.Dispose(); return "HIBA: hello → $hello" }
    }
    $w.Write('{"id":2,"op":"status"}' + "`n")
    $line = $r.ReadLine()
    $p.Dispose()
    if ($null -eq $line) { return 'HIBA: üres válasz' }
    if ($line.Contains('"code":"UNAUTHORIZED"')) { return 'UNAUTHORIZED' }
    if ($line.Contains('"ok":true')) { return 'OK' }
    return 'HIBA: ' + $line.Substring(0, [Math]::Min(100, $line.Length))
  } catch {
    return 'HIBA ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message
  }
}

# 3. A futtató maga (rendszergazda) — kulcs nélkül neki sem felel.
$admin = Invoke-PipeSession ''
Write-Host "rendszergazda, kulcs nélkül: $admin"

# 4. Egy sima helyi felhasználó, megszemélyesítve — ahogy a nem emelt app.
# A `net user` 14 karakternél hosszabb jelszónál rákérdez, és csövön át
# nincs, aki válaszoljon — a fiók létre sem jönne. A New-LocalUser nem kérdez,
# viszont csoport nélkül hoz létre: a Felhasználók (S-1-5-32-545) tagság kell
# a helyi bejelentkezéshez, pont ahogy egy valódi sima fióknak.
$user = 'breakerprobe'
$pass = 'Pr0be-' + [guid]::NewGuid().ToString('N').Substring(0, 12) + '!aA1'
$secure = ConvertTo-SecureString $pass -AsPlainText -Force
New-LocalUser -Name $user -Password $secure -AccountNeverExpires -PasswordNeverExpires | Out-Null
Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
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
$plainNoKey = 'nem futott'
$plainKey = 'nem futott'
# 2 = interaktív (ahogy az app fut), 3 = hálózati (ha az interaktív nem engedett)
foreach ($type in 2, 3) {
  if ([ProbeLogon]::LogonUser($user, '.', $pass, $type, 0, [ref]$token)) {
    Write-Host "sima felhasználó bejelentkezve (típus: $type)"
    [System.Security.Principal.WindowsIdentity]::RunImpersonated($token, [Action]{
      $script:plainNoKey = Invoke-PipeSession ''
      $script:plainKey = Invoke-PipeSession $key
    })
    $plainNoKey = $script:plainNoKey
    $plainKey = $script:plainKey
    break
  } else {
    Write-Host "LogonUser (típus: $type) nem sikerült: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
}
Write-Host "sima felhasználó, kulcs nélkül: $plainNoKey"
Write-Host "sima felhasználó, kulccsal: $plainKey"

# 5. Takarítás.
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Remove-LocalUser -Name $user -ErrorAction SilentlyContinue
if (Test-Path $log) { Write-Host '--- a szerver naplója ---'; Get-Content -Encoding UTF8 $log | Write-Host }

if ($plainNoKey -eq 'UNAUTHORIZED' -and $plainKey -eq 'OK' -and $admin -eq 'UNAUTHORIZED') {
  Write-Host 'EREDMÉNY: a sima felhasználó kulccsal eléri a segédet, kulcs nélkül senki sem'
  exit 0
}
Write-Host 'EREDMÉNY: a csatorna nem úgy viselkedik, ahogy kell (lásd fent)'
exit 1
