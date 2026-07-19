$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. "$PSScriptRoot\_agentmemory-local-common.ps1"

$serviceExe = Join-Path $script:AmFormalRoot 'service\agentmemory.exe'
$doctor = Join-Path $script:AmAppCurrent 'scripts\doctor-agentmemory.ps1'
$hook = Join-Path $script:AmAppCurrent 'scripts\stop-agentmemory-service-hook.ps1'

function Test-AmAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-AmLocalSystem {
  return ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -eq 'S-1-5-18')
}

function Test-AmParentIsWinSW {
  try {
    $currentPid = [System.Diagnostics.Process]::GetCurrentProcess().Id
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$currentPid"
    if (-not $current) { return $false }
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($current.ParentProcessId)"
    if (-not $parent) { return $false }
    if ($parent.Name -ieq 'agentmemory.exe') { return $true }
    $grand = Get-CimInstance Win32_Process -Filter "ProcessId=$($parent.ParentProcessId)"
    return ($grand -and $grand.Name -ieq 'agentmemory.exe')
  } catch {
    return $false
  }
}

Assert-AmRequiredFile -Path $hook -Name 'service stop hook'
if ((Test-AmLocalSystem) -or (Test-AmParentIsWinSW)) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $hook
  exit $LASTEXITCODE
}

Assert-AmRequiredFile -Path $serviceExe -Name 'WinSW service executable'
Assert-AmRequiredFile -Path $doctor -Name 'service doctor'
$service = Get-AmService
if ($service -and $service.State -eq 'Stopped') {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $doctor -ExpectedState Stopped
  exit $LASTEXITCODE
}

if (Test-AmAdministrator) {
  & $serviceExe stop
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $doctor -ExpectedState Stopped
  exit $LASTEXITCODE
}

$adminScript = Join-Path $script:AmFormalRoot 'tmp\stop-agentmemory-service-elevated.ps1'
@"
`$ErrorActionPreference = 'Stop'
& '$serviceExe' stop
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File '$doctor' -ExpectedState Stopped
exit `$LASTEXITCODE
"@ | Set-Content -LiteralPath $adminScript -Encoding UTF8
Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $adminScript
)
